/**
 * 场景：慢回填竞争窗口（>350ms）与断连时的后台补画取消。
 *
 * 背景：固件在 main_loop 里做 4K 变换式回填，网页拉 0xFFEC 可能撞上擦写窗口。
 * 旧实现只在连接关键路径里 `await 350ms` 再重拉一次——连接变慢，且回填稍慢就
 * 直接升级成「重连一次即可恢复」。现在改成：
 *   - 首拉含零值立刻按已有真 epoch 点渲染，连接流程继续（不等待、不报错）；
 *   - 另起后台静默补画器，每 350ms 经同一把 gattOp 锁重拉，最多 6 次 / 2s；
 *   - 零值消失即补画全量并停止；预算用尽才给出可操作提示；
 *   - 断连 / 新连接 / Clear 用会话代号撤掉在途定时器。
 *
 * 子场景：
 *   A. backfillDelayMs=1200（远大于 350ms）→ 连接不阻塞、期间不误报失败、后台补画后完整
 *   B. 回填永远不成功时断开 → 在途补画定时器被取消，不再继续读 0xFFEC、不留悬挂文案
 *
 * 跑法：node run-backfill-slow.mjs（npm test 自动发现）
 * 前置：仓库根目录已起静态服务（默认 http://127.0.0.1:8000），本机装有 Chrome。
 */
import {
  openApp, connect, snapshot, pipeConsole, finish, assert, log, step, until, sleep,
} from './lib/harness.mjs';

const FAILED_HINT = /\d+\s*条记录尚未完成时间校准，重连一次即可恢复/;
const CALIBRATING = /设备时钟校准中/;

async function trendRange(page) {
  return page.$eval('#trendRangeText', (e) => e.textContent.trim());
}

function zeroHistory(device) {
  device.setHistory(device.records.map((r) => ({ ...r, timestamp: 0 })));
}

// ─────────────── A. >350ms 慢回填：连接不阻塞 + 后台静默补画 ───────────────
{
  const DELAY_MS = 1200;
  const { browser, page, device } = await openApp({
    seed: { history: 144, daily: 0, opts: { autoBackfill: true, backfillDelayMs: DELAY_MS } },
    profile: '/tmp/soilpulse-e2e-slow-a-' + Date.now(),
  });
  pipeConsole(page);
  try {
    zeroHistory(device);
    step(`A. 连接（回填延迟 ${DELAY_MS}ms，整窗零值）`);
    await connect(page, device);

    const early = await snapshot(page);
    assert(early.status === 'Connected', `连接后状态应为 Connected，实际 ${early.status}`);
    assert(early.connectDisabled === false, '连接完成即刻可交互（Connect 按钮不应被锁住）');
    assert(device.backfillCount === 0,
      `连接流程不应等待固件回填，连接完成时已回填 ${device.backfillCount} 次`);

    // 中文：首拉含零值时连接流程继续往下走，既不阻塞也不弹常态错误
    await until(() => device.historyReads >= 2, { timeout: 20000, label: '0xFFEC 首拉完成' });
    const during = await trendRange(page);
    log(`A. 竞争窗口内 trendRange = "${during}" / 0xFFEC 读取 ${device.historyReads} 次`);
    assert(!FAILED_HINT.test(during), `慢回填期间不应误报失败，实际「${during}」`);
    assert(!/Time not synced/i.test(during), `慢回填期间不应出现常态错误，实际「${during}」`);

    // 中文：回填完成后后台补画自动收口，无需用户重连
    await until(() => device.backfillCount >= 1, { timeout: 20000, label: '固件慢回填完成' });
    await until(async () => (await snapshot(page)).historyRows > 1,
      { timeout: 20000, label: '后台补画后历史出表' });
    await until(async () => !CALIBRATING.test(await trendRange(page)),
      { timeout: 20000, label: '校准中文案消失' });
    const text = await trendRange(page);
    const snap = await snapshot(page);
    log(`A. 补画后 trendRange = "${text}" / 历史表 ${snap.historyRows} 行 / 0xFFEC 读取 ${device.historyReads} 次`);
    assert(device.historyReads >= 4,
      `应发生至少一次后台静默重拉，实际 0xFFEC 读取 ${device.historyReads} 次`);
    assert(!FAILED_HINT.test(text), `回填成功后不应残留失败提示，实际「${text}」`);
    assert(!CALIBRATING.test(text), `补画结束后不应留悬挂文案，实际「${text}」`);
    const syncWrites = device.writes.filter((w) => w.uuid.includes('ffe2'));
    assert(syncWrites.length === 1,
      `一次连接只应写一次 0xFFE2（不需要重连重试），实际 ${syncWrites.length} 次`);
    await finish(browser, page, '/tmp/soilpulse-e2e-backfill-slow.png', '慢回填后台补画');
  } catch (e) {
    await page.screenshot({ path: '/tmp/soilpulse-e2e-backfill-slow-fail.png' }).catch(() => {});
    await browser.close();
    throw e;
  }
}

// ─────────────── B. 断连取消在途补画定时器 ───────────────
{
  const { browser, page, device, bt } = await openApp({
    seed: { history: 144, daily: 0, opts: { autoBackfill: false } },
    profile: '/tmp/soilpulse-e2e-slow-b-' + Date.now(),
  });
  pipeConsole(page);
  try {
    zeroHistory(device);
    step('B. 回填永不成功（补画器持续重拉），中途断连');
    await connect(page, device);
    await until(() => device.historyReads >= 4,
      { timeout: 20000, label: '后台补画已开始（首拉 2 次读 + 补拉 2 次读）' });
    // 中文：让当前这一拍 GATT 往返落地，再在两次定时器之间断链
    await sleep(120);
    const readsAtBreak = device.historyReads;
    await bt.send('BluetoothEmulation.simulateGATTDisconnection', { address: device.address });
    await until(async () => /disconnect/i.test((await snapshot(page)).status || ''),
      { timeout: 15000, label: '状态变为 Disconnected' });

    // 中文：会话代号已变，旧补画定时器不得再发起 0xFFEC 读
    await sleep(1600);
    const extra = device.historyReads - readsAtBreak;
    const text = await trendRange(page);
    log(`B. 断连后 1.6s 内新增 0xFFEC 读 ${extra} 次 / trendRange = "${text}"`);
    assert(extra <= 2,
      `断连后仍在后台补拉（新增 ${extra} 次 0xFFEC 读，允许 1 拍在途往返的 2 次）`);
    assert(!CALIBRATING.test(text), `断连后不应留"校准中"悬挂文案，实际「${text}」`);
    assert(!FAILED_HINT.test(text), `断连后不应仍显示重连提示，实际「${text}」`);
    await finish(browser, page, '/tmp/soilpulse-e2e-backfill-cancel.png', '断连取消后台补画');
  } catch (e) {
    await page.screenshot({ path: '/tmp/soilpulse-e2e-backfill-cancel-fail.png' }).catch(() => {});
    await browser.close();
    throw e;
  }
}
