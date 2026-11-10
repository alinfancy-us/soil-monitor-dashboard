/**
 * 回归：浏览器里残留的**旧历史缓存**不会被新拉取的设备历史"合并"。
 *
 * 旧实现用 2 秒容差把缓存点 / 实时点 / 0xFFEC 点混在一起，用户清缓存前会看到
 * 同一分钟的重复点和密集点。现在 render() 只接受装配后的单一数据源，
 * saveTrendRecordsCache() 是整体覆盖写，所以任何旧缓存点都必须被整体替换掉。
 *
 * 手法（不依赖 device.id 的具体派生规则）：
 *   1. 先连一次，让页面自己写出真实的 `SoilPulse:trend:v1:<deviceId>`，拿到 key；
 *   2. 往这个 key 注入一份**过期缓存**：时间戳刻意与新设备历史相差 ±1 秒（旧版 2s
 *      容差会判定为"同一个点"而合并），并塞入两条重复点，全部带独有标记 temp=77.7；
 *   3. 断开 → reattach → 把设备 0xFFEC 换成一条整体回移 1 小时的新时间轴 → 再连；
 *   4. 断言最终缓存逐点等于设备 0xFFEC：旧点全部消失、无重复/无网格外点/不越界，
 *      且页面确实回显过缓存（证明这条路径被走到，而不是因为缓存没生效而"恰好通过"）。
 *
 * 跑法：cd test/e2e && node run-cached-history-replace.mjs
 * 前置：仓库根目录已起静态服务（默认 http://127.0.0.1:8000），本机装有 Chrome。
 */
import {
  openApp, connect, snapshot, pipeConsole, finish, assert, log, step, until, sleep,
} from './lib/harness.mjs';

const STEP_S = 600;
const EPOCH_MIN = 946684800;
const STALE_ERROR = /Time not synced|尚未完成时间校准|设备时钟校准中/i;
const STALE_TEMP = 77.7;                 // 旧缓存独有标记

const cachedTrend = (page) => page.evaluate(() => {
  const keys = Object.keys(localStorage).filter((k) => /^SoilPulse:trend:v1:/.test(k));
  if (!keys.length) return [];
  try { return JSON.parse(localStorage.getItem(keys[0])).records || []; } catch (_) { return []; }
});

const trendCacheKey = (page) => page.evaluate(() =>
  Object.keys(localStorage).find((k) => /^SoilPulse:trend:v1:/.test(k)) || '');

const historyTableTimes = (page) => page.evaluate(() =>
  [...document.querySelectorAll('#historyBody tr')].map((tr) => tr.children[1]?.textContent.trim()));

const { browser, page, device, bt } = await openApp({
  seed: { history: 144, historyOpts: { gapFromH: 0, gapToH: 0 }, daily: 0 },
});
pipeConsole(page);

// 中文：DEBUG_ENABLED=true，restoreCachedCharts() 会 console.debug 一行 "Loaded cached..."
const pageLogs = [];
page.on('console', (msg) => { pageLogs.push(msg.text()); });

try {
  step('A. 首次连接：让页面自己建立真实缓存 key');
  await connect(page, device);
  await until(async () => (await cachedTrend(page)).length === 144,
    { timeout: 25000, label: '首次连接拉满 144 条' });
  await sleep(500);
  await bt.send('BluetoothEmulation.simulateGATTDisconnection', { address: device.address });
  await until(async () => /disconnect/i.test((await snapshot(page)).status || ''),
    { timeout: 15000, label: '状态变为 Disconnected' });
  await device.reattach();

  const cacheKey = await trendCacheKey(page);
  assert(!!cacheKey, '首次连接后应存在 SoilPulse:trend:v1:* 缓存');
  const firstLastTs = (await cachedTrend(page)).at(-1).timestamp;

  step('B. 注入过期缓存：新时间轴 ±1s 的碰撞点 + 两条重复点');
  // 中文：新时间轴整体回移 1 小时（不能往前移，否则会被网页正确地当作未来点过滤掉）
  const newEnd = firstLastTs - 3600;
  const newTs = Array.from({ length: 144 }, (_, i) => newEnd - (143 - i) * STEP_S);
  const stale = newTs.slice(-20).map((ts, i) => ({
    timestamp: ts + (i % 2 ? 1 : -1),   // 2s 内碰撞：旧版容差合并会把它们留下来
    temp: STALE_TEMP,
    hum: 88.8,
    batt: 66,
  }));
  stale.push({ ...stale[0] }, { ...stale[5] });   // 同分钟重复点
  await page.evaluate((key, records) => {
    localStorage.setItem(key, JSON.stringify({ version: 1, savedAt: Date.now(), records }));
  }, cacheKey, stale);
  const injected = await cachedTrend(page);
  assert(injected.length === stale.length && injected.every((r) => r.temp === STALE_TEMP),
    `旧缓存注入失败，实际 ${injected.length} 条`);

  step('C. 换设备 0xFFEC 历史后再次连接');
  device.seedHistory(144, { gapFromH: 0, gapToH: 0, endAt: newEnd });
  const expect = device.records.map((r) => ({ ...r }));
  await connect(page, device);
  await until(async () => {
    const got = await cachedTrend(page);
    return got.length === expect.length
      && got.every((r) => r.temp !== STALE_TEMP);
  }, { timeout: 25000, label: '旧缓存被 0xFFEC 整体替换' });
  await sleep(600);   // 后台分块回填再画一帧，等它停稳

  const got = await cachedTrend(page);
  const gts = got.map((r) => Number(r.timestamp));
  const ets = expect.map((r) => Number(r.timestamp));

  step('D. 逐点断言：与设备 0xFFEC 一致，且旧缓存点一个不剩');
  assert(gts.join(',') === ets.join(','),
    `时间轴未逐点等于 0xFFEC\n  缓存 ${gts.slice(-5).join(',')}\n  设备 ${ets.slice(-5).join(',')}`);
  assert(new Set(gts).size === gts.length, '出现重复时间点');
  assert(gts.every((v, i) => i === 0 || v - gts[i - 1] === STEP_S),
    '出现非 600s 间隔的密集点（旧缓存与新点被合并了）');
  assert(gts.every((v) => v >= EPOCH_MIN && v <= Math.floor(Date.now() / 1000) + 60),
    '时间跑到未来或早于 2000 年');
  assert(!got.some((r) => r.temp === STALE_TEMP), '旧缓存的标记点残留在趋势数据里');
  const staleTs = new Set(stale.map((r) => r.timestamp));
  assert(!gts.some((v) => staleTs.has(v)), '旧缓存的 ±1s 碰撞点残留在趋势数据里');

  // 中文：证明 restoreCachedCharts() 真的回显过注入的缓存，
  //      否则"最终缓存干净"可能只是因为缓存路径根本没被走到。
  assert(pageLogs.some((l) => /Loaded cached trend records/i.test(l)),
    '重连时未回显缓存，无法证明替换路径被覆盖');

  const times = await historyTableTimes(page);
  assert(new Set(times).size === times.length, 'Measurement History 出现重复行');
  const snap = await snapshot(page);
  assert(!STALE_ERROR.test(snap.trendRange || ''),
    `正常连接不应出现时间校准错误，实际「${snap.trendRange}」`);
  log(`旧缓存回归 OK：${pageLogs.filter((l) => /Loaded cached trend records/i.test(l)).length} 次回显 → `
    + `最终 ${got.length} 点全部来自 0xFFEC，旧点 0 残留 / 历史表 ${snap.historyRows} 行`);

  await finish(browser, page, '/tmp/soilpulse-e2e-cached-replace.png', '旧缓存整体替换');
} catch (e) {
  await page.screenshot({ path: '/tmp/soilpulse-e2e-cached-replace-fail.png' }).catch(() => {});
  await browser.close();
  throw e;
}
