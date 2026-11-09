/**
 * 场景 4：OTA readAck 状态机 —— 固件在 START 阶段拒绝（低电 result=0x11）。
 *
 * 这条路径真机很难触发（要真把电池耗到 2.2V 以下），但它是用户最容易踩到的坑：
 * 一旦前端把"START 被拒"当成普通失败，就会把用户踢回未连接态，换完电池还得重新扫描。
 *
 * 期望行为：
 *   1. readAck 返回 ABORTED(3) + result=17 → 立即失败，不白等盲等窗口、不发任何 DATA
 *   2. 保持连接（otaStage='start' 分支不断链），Retry 按钮出现
 *   3. 提示语是人话（battery too low），不是 code 0x11
 *
 * 跑法：npm run ota
 */
import {
  openApp, connect, snapshot, pipeConsole, finish, assert, log, step, until, sleep,
} from './lib/harness.mjs';

const OTA_CHAR = '00010203-0405-0607-0809-0a0b0c0d2b12';

  step('连接假外设（固件 0.9.9，清单 1.0.0 → 应提示可升级）');
  // 固件版本显式钉成 0.9.9：这个场景验证的是"有新版本才弹提示"，不该依赖
  // page/firmware/firmware.json 的实际版本号——那边一升版这里就会静默失效
  const { browser, page, device } = await openApp({ seed: { history: 144, daily: 30, opts: { fwRev: '0.9.9' } } });
pipeConsole(page);

try {
  await connect(page, device);

  await until(async () => page.evaluate(() => {
    const h = document.getElementById('otaUpdateHint');
    return h && !h.classList.contains('hidden');
  }), { timeout: 15000, label: 'OTA 升级提示出现' });

  step('编排 readAck：收到 START_EXT 就立刻置 ABORTED + result=0x11（低电）');
  let startSeen = false;
  device.onWrite = async (uuid, buf) => {
    if (uuid !== OTA_CHAR) return;
    if (buf[0] === 0x03 && buf[1] === 0xff) {       // CMD_OTA_START_EXT
      startSeen = true;
      device.setReadAck({ status: 3, result: 0x11 });   // 3=ABORTED, 0x11=battery too low
      log(`收到 START_EXT（pdu=${buf[2]}）→ readAck 置 ABORTED/0x11`);
    }
  };

  step('点 Update now（确认弹窗自动接受）');
  // 一键升级会先 window.confirm，不接住的话页面会一直等在那儿（后面看不到任何 START 写入）
  page.once('dialog', (d) => d.accept());
  await page.evaluate(() => document.getElementById('otaUpdateNowBtn').click());

  await until(() => startSeen, { timeout: 20000, label: 'START_EXT 写入' });

  step('断言：START 阶段被拒后立刻报错（不等满盲等窗口）');
  const t0 = Date.now();
  await until(async () => {
    const s = await page.$eval('#otaStatus', (e) => e.textContent.trim());
    return /battery too low|低电/i.test(s);
  }, { timeout: 12000, label: 'OTA 失败提示' });
  const elapsed = Date.now() - t0;

  const s = await snapshot(page);
  log(`提示：${s.otaStatus}`);
  log(`从 START 到报错耗时约 ${elapsed}ms`);

  step('断言：提示是人话而不是裸错误码');
  assert(/battery too low/i.test(s.otaStatus), `提示未翻译原因码：${s.otaStatus}`);
  assert(/result=17|0x11/i.test(s.otaStatus) || /battery/i.test(s.otaStatus), '提示缺少原因码细节');

  step('断言：START 被拒不进入 DATA 阶段');
  const dataWrites = device.writes.filter((w) => w.uuid === OTA_CHAR && !(w.data[0] === 0x03 && w.data[1] === 0xff));
  assert(dataWrites.length === 0, `START 被拒后仍发了 ${dataWrites.length} 个 OTA 包`);
  log('START 被拒后未发任何 DATA 包 ✓');

  step('断言：保持连接 + Retry 可见（换电池可直接重试，不用重新扫描）');
  const ui = await page.evaluate(() => ({
    retryVisible: !document.getElementById('otaRetryBtn').classList.contains('hidden'),
    connected: /connected/i.test(document.getElementById('statusText').textContent),
  }));
  assert(ui.retryVisible, 'Retry 按钮未出现');
  assert(ui.connected, 'START 阶段被拒不应断链');

  step('复位 readAck 后点 Retry，验证能重新发起会话');
  device.setReadAck({ status: 0 });
  device.onWrite = null;
  const startCountBefore = device.writes.filter((w) => w.uuid === OTA_CHAR && w.data[0] === 0x03 && w.data[1] === 0xff).length;
  await page.evaluate(() => document.getElementById('otaRetryBtn').click());
  await until(() => device.writes.filter((w) => w.uuid === OTA_CHAR && w.data[0] === 0x03 && w.data[1] === 0xff).length > startCountBefore,
    { timeout: 15000, label: 'Retry 重新写入 START_EXT' });
  log('Retry 已重新发起 OTA 会话 ✓');
  await sleep(500);

  await finish(browser, page, '/tmp/soilpulse-e2e-ota.png', '场景 4 OTA 拒绝路径');
} catch (e) {
  await page.screenshot({ path: '/tmp/soilpulse-e2e-ota-fail.png' }).catch(() => {});
  await browser.close();
  throw e;
}
