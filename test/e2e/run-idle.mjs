/**
 * 场景 7：连接空闲提醒（固件 240s idle 超时的配套 UI）。
 *
 * 生产参数：180s 无续命 → 弹窗倒计时 30s → 不点就让设备 240s 自己断。
 * 这里用 URL 参数把时长压到 3s / 5s，走的仍是同一套业务代码（config.js 的 IDLE_WARN_MS / IDLE_GRACE_S）。
 *
 * 断言：
 *   1. 到点弹出提醒，倒计时数字在 1~5 之间
 *   2. 点 Keep connected 会写 0xFFE7（0x01），弹窗收起
 *   3. 写完计时确实重置——再等一个提醒周期，弹窗会第二次出现
 *   4. 第二次不点，倒计时归零后弹窗自动收起，且不主动断链（把断链留给设备超时）
 *
 * 跑法：cd test/e2e && npm run idle
 */
import {
  openApp, connect, pipeConsole, finish, assert, log, step, until,
} from './lib/harness.mjs';

const WARN_MS = 3000;
const GRACE_S = 5;
const { browser, page, device } = await openApp({
  seed: { history: 6, daily: 3 },
  query: `?idleWarnMs=${WARN_MS}&idleGraceS=${GRACE_S}`,
});
pipeConsole(page);

const click = (id) => page.evaluate((i) => document.getElementById(i).click(), id);
const promptHidden = () => page.$eval('#idlePrompt', (el) => el.classList.contains('hidden'));
const statusText = () => page.$eval('#statusText', (el) => el.textContent.trim());

try {
  step('连接假外设');
  await connect(page, device);
  assert(await promptHidden(), '刚连上就弹了空闲提醒，计时起点不对');

  step(`等 ${WARN_MS}ms 无操作 → 应弹出提醒`);
  await until(async () => !(await promptHidden()), { timeout: WARN_MS + 5000, label: '空闲提醒弹窗' });
  const firstCount = await page.$eval('#idleCountdown', (el) => Number(el.textContent));
  log(`弹窗已出现，倒计时 ${firstCount}s（配置 ${GRACE_S}s）`);
  assert(firstCount >= 1 && firstCount <= GRACE_S, `倒计时初始值应为 1~${GRACE_S}，实际 ${firstCount}`);

  step('点 Keep connected → 应写 0xFFE7 并收起弹窗');
  const before = device.writes.length;
  await click('idleKeepBtn');
  await until(promptHidden, { timeout: 5000, label: '弹窗收起' });
  const keepWrite = device.writes.slice(before).find((w) => w.uuid.endsWith('ffe7-0000-1000-8000-00805f9b34fb'));
  assert(keepWrite, '点 Keep connected 后没有收到 0xFFE7 写入');
  assert(keepWrite.data.length === 1 && keepWrite.data[0] === 0x01, `0xFFE7 内容应为 01，实际 ${keepWrite.data.toString('hex')}`);
  log(`0xFFE7 续命写入：${keepWrite.data.toString('hex')}`);

  step('证明计时被重置：再等一个周期，提醒应第二次出现');
  await until(async () => !(await promptHidden()), { timeout: WARN_MS + 6000, label: '第二次提醒' });
  const secondCount = await page.$eval('#idleCountdown', (el) => Number(el.textContent));
  log(`第二次弹窗，倒计时 ${secondCount}s`);

  step(`这次不点，${GRACE_S}s 倒计时归零后应自动收起，且不主动断链`);
  await until(promptHidden, { timeout: GRACE_S * 1000 + 6000, label: '倒计时归零收起' });
  assert((await statusText()) === 'Connected', `倒计时归零后仍应保持连接（断开交给设备 240s 超时），实际状态 ${await statusText()}`);
  log('弹窗自动收起，链路保持 —— 断开交由固件 idle 超时兜底');

  await finish(browser, page, '/tmp/soilpulse-e2e-idle.png', '场景 7 空闲提醒');
} catch (e) {
  await page.screenshot({ path: '/tmp/soilpulse-e2e-idle-fail.png' }).catch(() => {});
  await browser.close();
  throw e;
}
