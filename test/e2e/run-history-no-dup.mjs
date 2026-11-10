/**
 * 回归：24h 趋势图 / Measurement History 与设备 0xFFEC 历史逐点一致。
 *
 * 旧实现的四个典型症状，这里逐个锁死：
 *   ① 同一分钟重复点（通知 / Refresh / 0xFFEC 三套来源按 2 秒容差合并）；
 *   ② 连接时段出现非 10 分钟间隔的密集点（实时快照被并进历史）；
 *   ③ 时间跑到未来（固件锚点顺推 / 浏览器时钟偏差）；
 *   ④ 多次连接、反复对时后时间轴漂移或旧会话数据残留。
 *
 * 断言口径：localStorage 里 `SoilPulse:trend:v1:*` 的 records 就是 render() 实际喂给
 * 图表和表格的全量数组；拿它和假外设 0xFFEC 的 Flash 历史逐点比对。
 *
 * 跑法：cd test/e2e && node run-history-no-dup.mjs
 * 前置：仓库根目录已起静态服务（默认 http://127.0.0.1:8000），本机装有 Chrome。
 */
import {
  openApp, connect, snapshot, pipeConsole, finish, assert, log, step, until, sleep,
} from './lib/harness.mjs';

const STEP_S = 600;
const EPOCH_MIN = 946684800;              // 2000-01-01，与 app_config.h 一致
const STALE_ERROR = /Time not synced|尚未完成时间校准|设备时钟校准中/i;

const cachedTrend = (page) => page.evaluate(() => {
  const keys = Object.keys(localStorage).filter((k) => /^SoilPulse:trend:v1:/.test(k));
  if (!keys.length) return [];
  try { return JSON.parse(localStorage.getItem(keys[0])).records || []; } catch (_) { return []; }
});

const historyTableTimes = (page) => page.evaluate(() =>
  [...document.querySelectorAll('#historyBody tr')].map((tr) => tr.children[1]?.textContent.trim()));

/** 页面可能处在 ℃ 或 ℉，Latest 卡片断言按当前单位换算，避免硬编码 */
const expectedTempText = (page, celsius) => page.evaluate((c) => {
  const unit = localStorage.getItem('SoilPulse:tempUnit:v1') === 'C' ? 'C' : 'F';
  return (unit === 'F' ? c * 9 / 5 + 32 : c).toFixed(1);
}, celsius);

function assertExactGrid(records, expected, label) {
  const ts = records.map((r) => Number(r.timestamp));
  const want = expected.map((r) => Number(r.timestamp));
  assert(ts.length === want.length,
    `${label}：条数应等于设备 0xFFEC 的 ${want.length}，实际 ${ts.length}`);
  assert(new Set(ts).size === ts.length,
    `${label}：出现重复时间点（${ts.length} 条里只有 ${new Set(ts).size} 个不同时刻）`);
  const gaps = ts.slice(1).filter((v, i) => v - ts[i] !== STEP_S);
  assert(gaps.length === 0,
    `${label}：出现 ${gaps.length} 个非 ${STEP_S}s 间隔的点（密集点/网格外点）`);
  const now = Math.floor(Date.now() / 1000);
  assert(ts.every((v) => v >= EPOCH_MIN && v <= now + 60),
    `${label}：时间戳越界（早于 2000 年或跑到未来）`);
  assert(ts.join(',') === want.join(','),
    `${label}：时间轴与设备 0xFFEC 不逐点一致`);
}

async function waitForFullHistory(page, device, label) {
  await until(async () => (await cachedTrend(page)).length === device.records.length,
    { timeout: 25000, label: `${label}：拉满 ${device.records.length} 条 0xFFEC 历史` });
  // 中文：后台回填可能还要再画一帧，等它彻底停稳再做逐点断言
  await sleep(600);
}

const { browser, page, device, bt } = await openApp({
  seed: { history: 144, historyOpts: { gapFromH: 0, gapToH: 0 }, daily: 0 },
});
pipeConsole(page);

try {
  // 中文：实时读数源刻意给一个"不在 600s 网格上、且比历史更新"的值。
  //      它只能出现在 Latest 卡片，绝不能出现在趋势图 / 历史表 / 缓存里。
  const liveTs = Math.floor(Date.now() / 1000) + 10;
  device.setLive([{ timestamp: liveTs, temp: 39.9, hum: 88.8, batt: 77 }]);

  step('A. 首次连接（144 条真 epoch + 独立实时读数）');
  await connect(page, device);
  await waitForFullHistory(page, device, 'A');
  assertExactGrid(await cachedTrend(page), device.records, 'A 首次连接');

  const snapA = await snapshot(page);
  log(`A. 缓存 ${device.records.length} 点 / 历史表 ${snapA.historyRows} 行 / Latest=${snapA.temp} / "${snapA.trendRange}"`);
  assert(!STALE_ERROR.test(snapA.trendRange || ''),
    `正常连接不应出现常态时间校准错误，实际「${snapA.trendRange}」`);
  assert(snapA.temp === await expectedTempText(page, 39.9),
    `Latest 卡片应显示实时值 39.9℃（当前单位），实际 ${snapA.temp}`);
  assert(snapA.historyRows === 20, `历史表应列最近 20 条，实际 ${snapA.historyRows} 行`);
  const timesA = await historyTableTimes(page);
  assert(new Set(timesA).size === timesA.length, '历史表出现重复行');
  assert(!(await cachedTrend(page)).some((r) => r.temp === 39.9),
    '实时值 39.9 被并进了 0xFFEC 历史缓存');

  step('B. 点 Refresh（0xFFE7 → 实时测量 → 0xFFEB），历史必须一动不动');
  const seqBefore = device.measureSeq;
  const beforeRefresh = (await cachedTrend(page)).map((r) => r.timestamp).join(',');
  await page.evaluate(() => document.getElementById('refreshBtn')?.click());
  await until(() => device.measureSeq !== seqBefore, { timeout: 10000, label: '设备侧新测量' });
  await until(async () => (await snapshot(page)).temp !== snapA.temp,
    { timeout: 10000, label: 'Latest 卡片刷新' });
  await sleep(600);
  const afterRefresh = await cachedTrend(page);
  const snapB = await snapshot(page);
  log(`B. Latest ${snapA.temp} → ${snapB.temp} / 缓存仍 ${afterRefresh.length} 点 / 表 ${snapB.historyRows} 行`);
  assert(afterRefresh.map((r) => r.timestamp).join(',') === beforeRefresh,
    'Refresh 后历史时间轴被改动了（实时点并进了历史）');
  assert(afterRefresh.length === device.records.length,
    `Refresh 不应增加历史条数，实际 ${afterRefresh.length}`);
  assert(!afterRefresh.some((r) => r.temp === 39.9), 'Refresh 后实时值仍不应在历史里');
  assertExactGrid(afterRefresh, device.records, 'B Refresh 后');
  const timesB = await historyTableTimes(page);
  assert(new Set(timesB).size === timesB.length, 'Refresh 后历史表出现重复行');

  step('C. 断开 → 设备重新对时（时间轴整体平移）→ 再次连接');
  await bt.send('BluetoothEmulation.simulateGATTDisconnection', { address: device.address });
  await until(async () => /disconnect/i.test((await snapshot(page)).status || ''),
    { timeout: 15000, label: '状态变为 Disconnected' });
  await device.reattach();

  // 中文：整体**回移** 1 小时模拟"设备重新对时后的新时间轴"。不能往前移：
  //      sanitizeTrendRecords 会（正确地）把未来点过滤掉，那样就不是同一份可比数据了。
  const oldLast = device.records[device.records.length - 1].timestamp;
  device.seedHistory(144, { gapFromH: 0, gapToH: 0, endAt: oldLast - 3600 });
  device.setLive([{ timestamp: oldLast - 3590, temp: 39.9, hum: 88.8, batt: 77 }]);
  const newSet = new Set(device.records.map((r) => r.timestamp));

  const syncBefore = device.writes.filter((w) => w.uuid.includes('ffe2')).length;
  await connect(page, device);
  await until(() => device.writes.filter((w) => w.uuid.includes('ffe2')).length > syncBefore,
    { timeout: 15000, label: '第二次 0xFFE2 对时' });
  await until(async () => {
    const ts = (await cachedTrend(page)).map((r) => r.timestamp);
    return ts.length === device.records.length && ts.every((v) => newSet.has(v));
  }, { timeout: 25000, label: '缓存换成新一次对时后的时间轴' });
  await sleep(600);

  const afterReconnect = await cachedTrend(page);
  assertExactGrid(afterReconnect, device.records, 'C 二次连接');
  assert(!afterReconnect.some((r) => r.temp === 39.9),
    '二次连接把实时读数合并进了历史');
  const snapC = await snapshot(page);
  log(`C. 二次连接后 ${afterReconnect.length} 点 / 范围 "${snapC.trendRange}" / 对时写入 ${syncBefore} → ${device.writes.filter((w) => w.uuid.includes('ffe2')).length}`);
  assert(!STALE_ERROR.test(snapC.trendRange || ''),
    `二次连接正常对时后不应出现时间校准错误，实际「${snapC.trendRange}」`);
  assert(syncBefore === 1 && device.writes.filter((w) => w.uuid.includes('ffe2')).length === 2,
    '每次连接应恰好写一次 0xFFE2');
  const timesC = await historyTableTimes(page);
  assert(new Set(timesC).size === timesC.length, '二次连接后历史表出现重复行');

  await finish(browser, page, '/tmp/soilpulse-e2e-history-no-dup.png', '历史无重复点 / 实时值隔离');
} catch (e) {
  await page.screenshot({ path: '/tmp/soilpulse-e2e-history-no-dup-fail.png' }).catch(() => {});
  await browser.close();
  throw e;
}
