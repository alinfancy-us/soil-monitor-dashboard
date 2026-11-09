/**
 * 场景：设备未对时（时间戳无效）时的界面表现。
 *
 * 背景：固件对"未对时写入的记录"（flags.bit0=0 且 ts=0）会用锚点双向推算补出真实 epoch；
 *       只有**整窗一条真实时间戳都没有**时才输出 ts=0，前端 sanitizeTrendRecords 会整批丢弃。
 *       这种情况下界面原来完全静默（render 提前 return，连提示都没有），
 *       用户看起来像"卡住了/没连上"。本场景锁死现在的行为：必须给出可读提示。
 *
 * 两个子场景：
 *   A. 144 条全无时间戳 → 提示 "Time not synced (N record(s) without valid timestamp)"
 *   B. 设备 0 条历史     → 提示 "No data available"（此前被 return 挡成死代码）
 *
 * 跑法：cd test/e2e && npm run unsynced
 * 前置：仓库根目录已起静态服务（默认 http://127.0.0.1:8000），本机装有 Chrome。
 */
import {
  openApp, connect, snapshot, pipeConsole, finish, assert, log, step, until,
} from './lib/harness.mjs';

async function trendRange(page) {
  return page.$eval('#trendRangeText', (e) => e.textContent.trim());
}

// ───────────────────────── 子场景 A：整窗无时间戳 ─────────────────────────
{
  const { browser, page, device } = await openApp({ seed: { history: 144, daily: 0 } });
  pipeConsole(page);

  // 中文：模拟"设备从未对过时"——flash 里每条都是 flags.bit0=0，固件导出整窗 ts=0。
  //      必须在 connect 之前改，让 0xFFE1/0xFFEB/0xFFEC 三条路径都读到无效时间戳。
  device.records = device.records.map((r) => ({ ...r, timestamp: 0 }));
  const n = device.records.length;

  try {
    step(`连接假外设（${n} 条历史，全部 ts=0）`);
    await connect(page, device);

    step('断言：24h 历史拉完后必须给出"时间未同步"提示，而不是静默');
    await until(async () => /Time not synced/i.test(await trendRange(page)), {
      timeout: 20000, label: '时间未同步提示',
    });

    const snap = await snapshot(page);
    log('页面快照：', JSON.stringify({
      status: snap.status, temp: snap.temp, hum: snap.hum,
      lastUpdate: snap.lastUpdate, trendRange: snap.trendRange,
    }));
    assert(snap.status === 'Connected', `状态应为 Connected，实际 ${snap.status}`);
    assert(snap.historyRows <= 1, `无效记录不应进历史表，实际 ${snap.historyRows} 行`);
    assert(snap.lastUpdate && /Time not synchronized/i.test(snap.lastUpdate),
      `Latest 卡片应标注时间未同步，实际 "${snap.lastUpdate}"`);

    await finish(browser, page, '/tmp/soilpulse-e2e-unsynced.png', '未对时（整窗无时间戳）');
  } catch (e) {
    await page.screenshot({ path: '/tmp/soilpulse-e2e-unsynced-fail.png' }).catch(() => {});
    await browser.close();
    throw e;
  }
}

// ───────────────────────── 子场景 B：设备没有任何历史 ─────────────────────────
{
  const { browser, page, device } = await openApp({ seed: { history: 0, daily: 0 } });
  pipeConsole(page);

  try {
    step('连接假外设（0 条历史）');
    await connect(page, device);

    step('断言：空数据落到统一空态文案 "No data available"');
    await until(async () => /No data available/i.test(await trendRange(page)), {
      timeout: 20000, label: '空态文案',
    });
    log(`trendRange = "${await trendRange(page)}"`);

    await finish(browser, page, '/tmp/soilpulse-e2e-empty.png', '空数据空态');
  } catch (e) {
    await page.screenshot({ path: '/tmp/soilpulse-e2e-empty-fail.png' }).catch(() => {});
    await browser.close();
    throw e;
  }
}
