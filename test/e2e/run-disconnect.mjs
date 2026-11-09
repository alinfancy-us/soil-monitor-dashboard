/**
 * 场景 3：连接被外力掐断（模拟"连上 1~7 分钟后自动断"那条遗留问题）。
 *
 * 用 CDP 的 simulateGATTDisconnection 在链路层断开，前端应该：
 *   1. 状态回到 Disconnected，Connect 按钮重新可用、Clear 按钮禁用
 *   2. 已经上屏的数据保留（不闪成空表格）——断连不等于清数据
 *   3. 轮询停止，不再往后端要数据
 *
 * 跑法：npm run disconnect
 */
import {
  openApp, connect, snapshot, pipeConsole, finish, assert, log, step, until, sleep,
} from './lib/harness.mjs';

const { browser, page, device, bt } = await openApp({ seed: { history: 144, daily: 30 } });
pipeConsole(page);

try {
  step('连接假外设');
  await connect(page, device);
  const before = await snapshot(page);

  step('链路层强制断开（simulateGATTDisconnection）');
  await bt.send('BluetoothEmulation.simulateGATTDisconnection', { address: device.address });

  step('断言：UI 回到未连接态');
  await until(async () => {
    const s = await snapshot(page);
    return /disconnect/i.test(s.status || '');
  }, { timeout: 15000, label: '状态变为 Disconnected' });

  const after = await snapshot(page);
  log('断连后：', JSON.stringify({
    status: after.status, connectBtn: after.connectBtn,
    connectDisabled: after.connectDisabled, clearDisabled: after.clearDisabled,
    rows: after.historyRows,
  }));

  assert(after.connectDisabled === false, 'Connect 按钮应恢复可点');
  assert(after.clearDisabled === true, 'Clear 按钮应禁用（未连接不能清设备）');
  assert(after.historyRows === before.historyRows,
    `已上屏的数据不该因断连变化（${before.historyRows} → ${after.historyRows}）`);

  step('断言：轮询已停（断开后一段时间不再发起 GATT 读）');
  const readsAtBreak = device.reads.length;
  await sleep(6000);
  const newReads = device.reads.length - readsAtBreak;
  log(`断连后 6s 内新增读 ${newReads} 次`);
  assert(newReads <= 2, `断连后仍在轮询（6s 内 ${newReads} 次读）`);

  await finish(browser, page, '/tmp/soilpulse-e2e-disconnect.png', '场景 3 断连处理');
} catch (e) {
  await page.screenshot({ path: '/tmp/soilpulse-e2e-disconnect-fail.png' }).catch(() => {});
  await browser.close();
  throw e;
}
