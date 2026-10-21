/**
 * 场景 2：Clear data —— 先让设备清（0xFFE5 = "CLR1"），成功后才清本地缓存，并立清空水位。
 *
 * 覆盖的回归点（这些都是之前真机上出过问题的）：
 *   1. 设备没应答时不能只清本地（否则重连又被 0xFFEC 拉回来）
 *   2. 清空后画布/内存态必须一起重置（不能留下"设备有 1 条 + 本地 1 条"）
 *   3. 清空水位（clearedAt）要在 0xFFE5 写入成功后立，挡住清空瞬间在途的记录回写
 *   4. 只删数据类 key，不能顺手把 lastDevice / 温度单位等偏好删掉
 *
 * 跑法：npm run reset
 */
import {
  openApp, connect, snapshot, pipeConsole, finish, assert, log, step, until, sleep,
} from './lib/harness.mjs';

const RESET_MAGIC = Buffer.from([0x43, 0x4c, 0x52, 0x31]);   // "CLR1"

const { browser, page, device } = await openApp({ seed: { history: 144, daily: 30 } });
pipeConsole(page);

try {
  step('连接并等缓存落盘');
  await connect(page, device);
  await sleep(1200);   // 历史/日均缓存是异步写的

  const before = await snapshot(page);
  const dataKeysBefore = before.storageKeys.filter((k) => /^SoilPulse:(trend|daily):/.test(k));
  log('清空前：', JSON.stringify({
    rows: before.historyRows, dataKeys: dataKeysBefore, allKeys: before.storageKeys,
  }));
  assert(before.historyRows > 5, '清空前历史表应有数据');
  assert(dataKeysBefore.length > 0, '清空前应有 trend/daily 缓存');

  step('点 Clear data（确认弹窗自动接受）');
  page.once('dialog', (d) => d.accept());
  await page.click('#clearCacheBtn');

  step('断言：设备收到 0xFFE5 = CLR1');
  const resetWrite = await device.waitWrite(
    '0000ffe5-0000-1000-8000-00805f9b34fb',
    (buf) => buf.length === 4 && buf.equals(RESET_MAGIC),
    8000,
  );
  log(`0xFFE5 ← ${resetWrite.data.toString('hex')}（CLR1）`);

  step('断言：本地缓存与画布一起清空');
  await until(async () => {
    const s = await snapshot(page);
    return s.historyRows <= 1 && !s.storageKeys.some((k) => /^SoilPulse:(trend|daily):/.test(k));
  }, { timeout: 8000, label: '缓存与历史表清空' });

  const after = await snapshot(page);
  const dataKeysAfter = after.storageKeys.filter((k) => /^SoilPulse:(trend|daily):/.test(k));
  const cutoffKey = after.storageKeys.find((k) => /^SoilPulse:clearedAt:/.test(k));
  log('清空后：', JSON.stringify({
    rows: after.historyRows, dataKeys: dataKeysAfter, cutoff: cutoffKey, allKeys: after.storageKeys,
  }));

  assert(dataKeysAfter.length === 0, `仍有数据缓存未删：${dataKeysAfter.join(',')}`);
  assert(cutoffKey, '未立清空水位 clearedAt（清空瞬间在途记录会被合并回缓存）');

  step('断言：偏好类 key 不被误删');
  const keep = after.storageKeys.filter((k) => /lastDevice|devName|tempUnit|dailyRange/.test(k));
  // 允许某些偏好本来就没写过，但绝不能被"清空"动作删掉本来存在的
  const keptBefore = before.storageKeys.filter((k) => /lastDevice|devName|tempUnit|dailyRange/.test(k));
  const lost = keptBefore.filter((k) => !after.storageKeys.includes(k));
  assert(lost.length === 0, `偏好被误删：${lost.join(',')}`);
  log(`保留的偏好 key：${keep.join(', ') || '(无)'}`);

  await finish(browser, page, '/tmp/soilpulse-e2e-reset.png', '场景 2 Clear/Reset');
} catch (e) {
  await page.screenshot({ path: '/tmp/soilpulse-e2e-reset-fail.png' }).catch(() => {});
  await browser.close();
  throw e;
}
