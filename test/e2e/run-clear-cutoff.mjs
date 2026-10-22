/**
 * 清空水位 vs 设备直读数据（2026-10-22 真机踩坑回归）。
 *
 * 场景：用户点过 Clear（水位=当时时刻）→ 之后往设备烧了时间戳更早的数据
 * （mock_log.py / 换设备 / 恢复备份）。连接后设备把 144 条 24h + 30 天日均
 * 全部读回来（日志 Daily read: 30 day(s)），但旧版把"清空水位"错误地应用在
 * 设备直读数据上 → 30 天日均全部被滤 → 30 Days 视图空白，用户无从判断原因。
 *
 * 正确语义：水位只滤 localStorage 缓存恢复（restoreCachedCharts）；
 * 设备是数据权威，flash 没清数据就是真的，直读数据不得过滤。
 */
import { openApp, connect, sleep, until, assert, finish } from './lib/harness.mjs';

const { browser, page, device } = await openApp({
  seed: { history: 144, historyOpts: { gapFromH: 0, gapToH: 0 }, daily: 30 },
  profile: '/tmp/soilpulse-e2e-cutoff-' + Date.now(),
});
const logs = [];
page.on('console', (m) => logs.push(m.text()));

await connect(page, device);
await sleep(600);

// —— 模拟用户此前点过 Clear：写入水位（= 现在），并清掉本地缓存。
// 此时设备里的数据（seed 相对 now 往回推 24h / 30 天）全部早于水位。
const devId = await page.evaluate(() => {
  const k = Object.keys(localStorage).find((k) => /^SoilPulse:trend:v1:/.test(k));
  return k ? k.slice('SoilPulse:trend:v1:'.length) : null;
});
assert(devId, '连接后应建立 trend 缓存（拿到 deviceId）');
await page.evaluate((id) => {
  localStorage.setItem(`SoilPulse:clearedAt:v1:${id}`, String(Math.floor(Date.now() / 1000)));
  localStorage.removeItem(`SoilPulse:trend:v1:${id}`);
  localStorage.removeItem(`SoilPulse:daily:v1:${id}`);
}, devId);
console.log(`[e2e] ── 已写入清空水位 devId=${devId}`);

// —— 断链重连（connectBtn 在已连接态即 Disconnect）
await page.click('#connectBtn');
await until(async () => {
  const t = await page.$eval('#statusText', (e) => e.textContent.trim());
  return t === 'Disconnected';
}, { timeout: 8000, label: '断链完成' });
await connect(page, device);
await sleep(1200);

// —— 重连后拉到的设备数据必须完整展示（水位不得滤设备直读）
const snap = await page.evaluate(() => {
  const el = (id) => document.getElementById(id);
  return {
    trendRange: el('trendRangeText')?.textContent.trim(),
    rows: document.querySelectorAll('#historyBody tr').length,
    dailyEmptyHidden: el('dailyEmpty')?.classList.contains('hidden'),
  };
});
assert(snap.rows === 20, `重连后 History 表应有 20 行（设备直读不被水位滤），实际 ${snap.rows}`);
assert(/Time Range/.test(snap.trendRange), `24h 图应有时间范围文案，实际「${snap.trendRange}」`);

// 切到 30 Days：日均 30 天必须显示（旧版在这里被水位滤光 → 空白）
await page.click('#dailyRange30Btn');
await sleep(900);
const d30 = await page.evaluate(() => {
  const el = (id) => document.getElementById(id);
  const c = el('dailyChart');
  return {
    emptyHidden: el('dailyEmpty')?.classList.contains('hidden'),
    note: el('dailyNote')?.textContent.trim(),
    rangeValue: el('dailyRangeValue')?.textContent.trim(),
    canvasW: c?.clientWidth,
  };
});
assert(d30.emptyHidden === true, '30 Days 视图不得显示 No daily data yet（设备直读 30 天不被水位滤）');
assert(d30.note === '30-day daily average', `日均范围说明应为 30-day，实际「${d30.note}」`);
assert(!!d30.rangeValue, '日均摘要头应有选中日读数');
assert((d30.canvasW || 0) > 100, '日均 canvas 应有宽度（面板可见）');

// —— 缓存恢复路径仍要滤水位：写一条早于水位的时间进 trend 缓存，重载页面后不得回显
await page.evaluate((id) => {
  const key = `SoilPulse:trend:v1:${id}`;
  const old = JSON.parse(localStorage.getItem(key) || '{"records":[]}');
  old.records = [{
    timestamp: Math.floor(Date.now() / 1000) - 86400 * 3,   // 3 天前 < 水位
    temp: 22.5, hum: 55, batt: 88,
  }];
  localStorage.setItem(key, JSON.stringify(old));
}, devId);
await page.reload({ waitUntil: 'domcontentloaded' });
await sleep(1200);
const afterReload = await page.evaluate(() => {
  const el = (id) => document.getElementById(id);
  return {
    firstRow: document.querySelector('#historyBody tr')?.textContent.trim().slice(0, 60),
    trendRange: el('trendRangeText')?.textContent.trim(),
  };
});
assert(/Connect device to view history/.test(afterReload.firstRow || ''),
  `缓存里早于水位的记录不得在重载后回显（防复活），实际首行「${afterReload.firstRow}」`);
assert(!/Time Range/.test(afterReload.trendRange || ''),
  `重载后未连接不应显示时间范围，实际「${afterReload.trendRange}」`);

await finish(browser, page, '/tmp/soilpulse-e2e-cutoff.png', '清空水位 vs 设备直读');
