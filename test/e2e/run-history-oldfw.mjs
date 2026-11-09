/**
 * 场景：连到"旧固件"（0xFFEC 不认末页哨兵 offset=0xFF）时必须安全回退。
 *
 * 背景：2026-10-22 前端改成"先请求末页（offset=0xFF）一次拿到 total + 最新 20 条"，
 *   新固件会把这个请求换算成真实起点回显。旧固件（以及还没升级的设备）不认识 0xFF，
 *   会走"offset ≥ total → 空块"的分支，原样回显 offset=0xFF 且 count=0。
 *   前端必须能从这一个响应里识别出来，并退回原来的"全量最新优先"路径，
 *   否则用户升级网页后连老设备会看到"一条历史都没有"。
 *
 * 断言：
 *   A. 第一块确实是末页哨兵 0xFF（新协议先探一次）
 *   B. 探到不支持后，立刻按老路径从 offset=0 开始（依次拿到 total → 末页 → 往前翻）
 *   C. 数据一条不少：历史表 20 行、24h 窗口内 30+ 点（144 条全量在手）
 *
 * 跑法：cd test/e2e && node run-history-oldfw.mjs
 * 前置：仓库根目录已起静态服务（默认 http://127.0.0.1:8000），本机装有 Chrome。
 */
import {
  openApp, connect, snapshot, pipeConsole, finish, assert, log, step, until,
} from './lib/harness.mjs';

const blkOffsets = (device) => device.writes
  .filter((w) => String(w.uuid).includes('ffec'))
  .map((w) => w.data[0]);

const geom = (page) => page.evaluate(() => {
  const l = document.getElementById('trendChart')._trendLayout;
  return l ? { visible: l.visible, spanSec: l.spanSec, dataFirst: l.dataFirst, dataLast: l.dataLast } : null;
});

{
  const { browser, page, device } = await openApp({
    // lastPageWindow:false → 模拟旧固件：0xFF 原样回显 + 空块
    seed: { history: 144, daily: 0, opts: { lastPageWindow: false } },
  });
  pipeConsole(page);

  try {
    step('连接"旧固件"假外设');
    await connect(page, device);

    // ── A/B. 先探末页 → 探到不支持 → 回退到 offset=0 起的全量路径 ──
    await until(() => blkOffsets(device).length >= 8, { timeout: 20000, label: '旧固件全量拉取完成' });
    const offsets = blkOffsets(device);
    log(`0xFFEC 窗口写顺序：${offsets.join(' → ')}`);

    assert(offsets[0] === 0xff, `新前端应先探末页哨兵 0xFF，实际首块 ${offsets[0]}`);
    assert(offsets[1] === 0, `识别到旧固件后应立即改读 offset=0（拿 total），实际 ${offsets[1]}`);
    // 老路径：0 → 末页（按整页对齐）→ 逐页往前 → 20
    const expectLastPage = Math.floor((device.records.length - 1) / 20) * 20;
    assert(offsets[2] === expectLastPage,
      `回退后第二块应是末页 offset=${expectLastPage}，实际 ${offsets[2]}`);
    // offsets[0]=探测 0xFF、offsets[1]=回退首块 0；从 offsets[2] 起才是"末页 → 往前翻"
    assert(offsets.slice(3).every((v, i) => v < offsets[i + 2]),
      `末页之后应逐页往前翻（递减），实际 ${offsets.join(',')}`);
    assert(offsets[offsets.length - 1] === 20, `最后一块应是 20（最旧的整页），实际 ${offsets[offsets.length - 1]}`);

    // ── C. 数据完整上屏 ──
    await until(async () => (await geom(page)) !== null, { timeout: 10000, label: '图表绘制' });
    const snap = await snapshot(page);
    const g = await geom(page);
    log(`历史表 ${snap.historyRows} 行 / 窗口内 ${g.visible} 点 / dataLast=${g.dataLast}`);
    assert(snap.historyRows === 20, `历史表应满 20 行，实际 ${snap.historyRows}`);
    assert(g.visible >= 30, `6h 窗口内应有 30+ 点（144 条全量在手），实际 ${g.visible}`);
    // 最早一条必须来自设备最旧那条（回退路径没丢前段）
    const dataFirstExpect = device.records[0].timestamp;
    assert(Math.abs(g.dataFirst - dataFirstExpect) <= 2,
      `最旧一条应为设备第一条（${dataFirstExpect}），实际 ${g.dataFirst}`);

    await finish(browser, page, '/tmp/soilpulse-e2e-history-oldfw.png', '旧固件历史回退');
  } catch (e) {
    await page.screenshot({ path: '/tmp/soilpulse-e2e-history-oldfw-fail.png' }).catch(() => {});
    await browser.close();
    throw e;
  }
}
