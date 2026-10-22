/**
 * 场景：24h 图的"可视窗口"——x 轴可左右拖、默认只画最近 6h、首屏先出最新数据。
 *
 * 背景（两个问题一起解决）：
 *   1) 144 条 × 10min 铺满 24h，手机 ~230px 绘图区里每条只摊到 1.6px → 点挤成毛毛虫；
 *   2) 0xFFEC 分块拉取原来从 offset=0（最旧）往新翻，144 条要 8 次 write+read 往返
 *      （iOS/Bluefy ≈200~250ms/次）才第一次有数据上屏，看起来像"连上了但没数据"。
 *
 * 断言的四个点：
 *   A. 分块写顺序 = 0（拿 total）→ 末页 → 往前翻：证明"最新优先"，首屏在第 2 次往返就能出图
 *   B. 默认窗口 = 6h 且右边界贴着最新一条；可见点数 30~40（≈36 条）
 *   C. 向右拖 → 窗口整体前移（看更早的数据），Latest 胶囊出现，文案跟着变
 *   D. ctrl+滚轮缩小跨度 → 点胶囊/双击回到"最新 + 6h"
 *
 * 跑法：cd test/e2e && node run-trend-view.mjs
 * 前置：仓库根目录已起静态服务（默认 http://127.0.0.1:8000），本机装有 Chrome。
 */
import {
  openApp, connect, snapshot, pipeConsole, finish, assert, log, step, until,
} from './lib/harness.mjs';

const LAYOUT = () => document.getElementById('trendChart')._trendLayout;
const chipVisible = () => !document.getElementById('trendLatestBtn').classList.contains('hidden');
const rangeText = () => document.getElementById('trendRangeText').textContent.trim();

/** 当前窗口几何（页面里算出，避免在 Node 侧重复推导） */
const geom = (page) => page.evaluate(() => {
  const l = document.getElementById('trendChart')._trendLayout;
  return l ? {
    winStart: l.winStart, winEnd: l.winEnd, spanSec: l.spanSec,
    dataFirst: l.dataFirst, dataLast: l.dataLast,
    visible: l.visible, follow: l.follow, padLeft: l.padLeft, plotW: l.plotW,
  } : null;
});

/** 从画布中心按下并水平拖 dx 像素（正 = 手指向右 = 看更早的数据） */
async function dragCanvas(page, dx) {
  const box = await page.$eval('#trendChart', (c) => {
    const r = c.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  // 分几步移动：单步跳变在真实设备上等于"瞬移"，多步才能触发 pointermove 的增量逻辑
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(box.x + (dx * i) / 6, box.y);
    await new Promise((r) => setTimeout(r, 16));   // 让 pointermove 各自落在不同帧
  }
  await page.mouse.up();
}

{
  // 中文：gapFromH/gapToH = 0 → 不做断档，拿到整齐的 144 条（10min × 144 ≈ 23h50m）
  const { browser, page, device } = await openApp({
    seed: { history: 144, historyOpts: { gapFromH: 0, gapToH: 0 }, daily: 0 },
  });
  pipeConsole(page);

  try {
    step(`连接假外设（${device.records.length} 条历史，10 分钟间隔）`);
    await connect(page, device);

    // ── A. 分块拉取顺序：最新优先 ──
    await until(async () => (await geom(page)) !== null, { timeout: 20000, label: '图表首次绘制' });
    const blkWrites = device.writes
      .filter((w) => String(w.uuid).includes('ffec'))
      .map((w) => w.data[0]);   // 写包 = {offset u8, count u8}
    log(`0xFFEC 窗口写顺序：${blkWrites.join(' → ')}`);
    assert(blkWrites.length >= 2, `应至少有 2 次块窗口写，实际 ${blkWrites.length}`);
    assert(blkWrites[0] === 0, `第一块必须读 offset=0（拿 total），实际 ${blkWrites[0]}`);
    // 144 条 / 每页 20 → 末页起点 140；第二块必须是末页，而不是正序的 20
    assert(blkWrites[1] === 140, `第二块应是最新一页 offset=140，实际 ${blkWrites[1]}（说明还是正序拉取）`);
    assert(blkWrites.slice(2).every((v, i) => v < blkWrites[i + 1]),
      `末页之后应逐页往前翻（递减），实际 ${blkWrites.join(',')}`);

    // ── B. 默认窗口 = 最近 6h ──
    let g = await geom(page);
    const latestTs = device.records[device.records.length - 1].timestamp;
    log(`窗口 ${new Date(g.winStart * 1000).toLocaleTimeString()} → ${new Date(g.winEnd * 1000).toLocaleTimeString()}`
      + ` / span=${g.spanSec}s / 可见 ${g.visible} 点 / follow=${g.follow}`);
    assert(g.spanSec === 21600, `默认窗口应为 6h(21600s)，实际 ${g.spanSec}`);
    assert(Math.abs(g.winEnd - latestTs) <= 2, `右边界应贴住最新一条（${latestTs}），实际 ${g.winEnd}`);
    assert(g.visible >= 30 && g.visible <= 40, `6h 窗口内应有 30~40 个点（≈36），实际 ${g.visible}`);
    assert(!(await page.evaluate(chipVisible)), '默认在最新一屏时不该显示 Latest 胶囊');
    const text0 = await page.evaluate(rangeText);
    assert(/· 6h$/.test(text0), `范围文案应标出 6h 窗口，实际 "${text0}"`);

    // ── C. 向右拖 = 看更早的数据 ──
    const before = g;
    await dragCanvas(page, 120);
    await until(async () => (await geom(page)).winEnd !== before.winEnd, { timeout: 5000, label: '窗口平移' });
    g = await geom(page);
    const movedSec = before.winEnd - g.winEnd;
    log(`右拖 120px → 窗口前移 ${(movedSec / 3600).toFixed(2)}h（endTs ${before.winEnd} → ${g.winEnd}）`);
    assert(movedSec > 0, `向右拖应看更早的数据（endTs 变小），实际位移 ${movedSec}s`);
    // 120px / plotW × 6h：允许 ±25% 误差（内边距、DPR 取整）
    const expect = (120 / before.plotW) * 21600;
    assert(Math.abs(movedSec - expect) < expect * 0.25,
      `平移量应约 ${Math.round(expect)}s，实际 ${Math.round(movedSec)}s`);
    assert(g.follow === false, `拖离最新后 follow 应为 false，实际 ${g.follow}`);
    assert(await page.evaluate(chipVisible), '拖离最新后应出现 Latest 胶囊');
    const text1 = await page.evaluate(rangeText);
    log(`拖后文案："${text1}"`);
    assert(text1 !== text0 && /· 6h$/.test(text1), `文案应变成新的 6h 区间，实际 "${text1}"`);

    // ── D. 缩放 + 回位 ──
    await page.evaluate(() => {
      const c = document.getElementById('trendChart');
      const r = c.getBoundingClientRect();
      c.dispatchEvent(new WheelEvent('wheel', {
        deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true,
        clientX: r.left + r.width * 0.5, clientY: r.top + r.height * 0.5,
      }));
    });
    await until(async () => (await geom(page)).spanSec < 21600, { timeout: 5000, label: '缩放生效' });
    g = await geom(page);
    log(`ctrl+滚轮放大 → span ${g.spanSec}s（${(g.spanSec / 3600).toFixed(2)}h）`);
    assert(g.spanSec >= 1800, `跨度不应小于 30min 下限，实际 ${g.spanSec}`);

    await page.click('#trendLatestBtn');
    await until(async () => {
      const l = await geom(page);
      return l.spanSec === 21600 && Math.abs(l.winEnd - latestTs) <= 2;
    }, { timeout: 5000, label: 'Latest 回位' });
    g = await geom(page);
    log(`点 Latest → span=${g.spanSec}s / endTs=${g.winEnd} / follow=${g.follow}`);
    assert(g.follow === true, `回位后 follow 应为 true，实际 ${g.follow}`);
    assert(!(await page.evaluate(chipVisible)), '回位后胶囊应重新隐藏');

    // ── 双击回最新（拖动后再双击，验证手势不冲突） ──
    await dragCanvas(page, 90);
    await until(async () => (await geom(page)).follow === false, { timeout: 5000, label: '再次拖离最新' });
    const box = await page.$eval('#trendChart', (c) => {
      const r = c.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.click(box.x, box.y);
    await page.mouse.click(box.x, box.y);   // 300ms 内两下 = 双击
    await until(async () => (await geom(page)).follow === true, { timeout: 5000, label: '双击回最新' });
    log('双击 → 已回到最新一屏');

    // ── 手机视口留档（390×844，用来肉眼确认 6h 窗口的真实密度） ──
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await new Promise((r) => setTimeout(r, 600));   // 等 resize 防抖（200ms）后的重绘
    const gm = await geom(page);
    const snap = await snapshot(page);
    log(`手机视口：plotW=${Math.round(gm.plotW)}px / 可见 ${gm.visible} 点 / 文案 "${snap.trendRange}"`);
    assert(gm.plotW > 150, `手机绘图区宽度异常：${gm.plotW}`);
    assert(gm.visible >= 30, `手机视口下窗口内点数应仍为 30+，实际 ${gm.visible}`);

    await finish(browser, page, '/tmp/soilpulse-e2e-trend-view.png', '24h 图可视窗口');
  } catch (e) {
    await page.screenshot({ path: '/tmp/soilpulse-e2e-trend-view-fail.png' }).catch(() => {});
    await browser.close();
    throw e;
  }
}

// 中文：留一个具名导出，避免 linter 把上面两个辅助函数当成死代码（也方便将来复用）
export { geom, dragCanvas, LAYOUT };
