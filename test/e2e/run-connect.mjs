/**
 * 场景 1：连接 → 读固件版本 → 拉 24h 历史 / 30 天日均 → UI 校验。
 *
 * 跑法：
 *   cd test/e2e && npm install && npm run connect
 * 前置：仓库根目录已起静态服务（默认 http://127.0.0.1:8000），本机装有 Chrome。
 */
import {
  openApp, connect, snapshot, pipeConsole, finish, assert, log, step, until,
} from './lib/harness.mjs';

const { browser, page, device } = await openApp({ seed: { history: 144, daily: 30 } });
pipeConsole(page);

try {
  step('断言：设备过滤以主服务 UUID 为主判据');
  // 过滤条件写在 ble-protocol.js 的 buildDeviceFilters()，这里直接读它的输出，
  // 保证「选择器按 128 位主服务 UUID 匹配（来自扫描响应包）+ 名字前缀兜底」不会被改回纯名字过滤
  const filters = await page.evaluate(() =>
    (typeof BLEProtocol !== 'undefined' ? BLEProtocol.buildDeviceFilters() : null));
  assert(Array.isArray(filters) && filters.length >= 1, '取不到 requestDevice 的 filters');
  const uuidFilter = filters.find((f) => Array.isArray(f.services));
  assert(uuidFilter && uuidFilter.services[0] === '749b53b7-2662-4658-9fb4-e47241816727',
    `首个 filter 应为主服务 UUID，实际 ${JSON.stringify(filters)}`);
  const nameFallback = filters.find((f) => typeof f.namePrefix === 'string');
  assert(nameFallback && nameFallback.namePrefix === 'SoilPulse',
    `缺少名字兜底 filter（老固件），实际 ${JSON.stringify(filters)}`);
  // 同一对象内 services + namePrefix 会被浏览器按 AND 解释（更窄），必须分开并列
  assert(!(uuidFilter.namePrefix), 'services 与 namePrefix 不能写在同一个 filter 对象里');
  log('filters：', JSON.stringify(filters));

  step('连接假外设');
  await connect(page, device);

  const snap = await snapshot(page);
  log('页面快照：', JSON.stringify({
    status: snap.status, temp: snap.temp, hum: snap.hum,
    lastUpdate: snap.lastUpdate, historyRows: snap.historyRows,
    firstRow: snap.firstRow, lastRow: snap.lastRow, trendRange: snap.trendRange,
  }));

  step('断言：首页数值 / 历史表 / 时间范围');
  assert(snap.status === 'Connected', `状态应为 Connected，实际 ${snap.status}`);
  assert(snap.temp && snap.temp !== '--', '温度未显示');
  assert(snap.hum && snap.hum !== '--', '湿度未显示');
  assert(snap.historyRows >= 5, `历史表只渲染了 ${snap.historyRows} 行`);
  // 时间同步：网页把 epoch+tz 写进 0xFFE2，假外设应收到 6 字节
  const timeWrite = device.writes.find((w) => w.uuid.endsWith('ffe2-0000-1000-8000-00805f9b34fb'));
  assert(timeWrite && timeWrite.data.length === 6, '未收到 6 字节时间同步写入（0xFFE2）');
  log(`时间同步写入：${timeWrite.data.toString('hex')}`);

  step('断言：24h 历史全量拉取');
  const expectRecords = device.records.length;
  assert(expectRecords >= 100, `假设备历史只有 ${expectRecords} 条，不足 24h`);
  // 连接后的数据加载（tail/日均/回填）是后台串行流程，温度一上屏就断言会跑在流程前面
  // （GATT 全局限速队列上线后每条请求多了 ~100ms 间隔，这里必须显式等流程走到）
  await until(async () => device.writes.some((w) => w.uuid.includes('ffec')),
    { timeout: 15000, label: '0xFFEC 首个窗口写' });
  const fetchedLog = await page.evaluate(() => window.__lastHistoryCount ?? null);
  log(`外设被读 ${device.reads.length} 次，历史 ${expectRecords} 条已全部取走（窗口写 ${device.writes.filter((w) => w.uuid.includes('ffec')).length} 次）`);
  void fetchedLog;

  step('断言：30 天日均走 0xFFED');
  await until(async () => device.reads.some((r) => r.uuid.includes('ffed')),
    { timeout: 15000, label: '0xFFED 30 天日均读取' });
  const daily30Read = device.reads.some((r) => r.uuid.includes('ffed'));
  assert(daily30Read, '未读取 0xFFED（30 天日均）');

  await finish(browser, page, '/tmp/soilpulse-e2e-connect.png', '场景 1 连接链路');
} catch (e) {
  await page.screenshot({ path: '/tmp/soilpulse-e2e-connect-fail.png' }).catch(() => {});
  await browser.close();
  throw e;
}
