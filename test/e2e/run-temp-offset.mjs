/**
 * 场景 6：温度偏移（0xFFE8）写入 + 回执文案 + 单位切换。
 *
 * 目的：把「设备值单位（0.01℃）→ 显示单位」这条换算链锁死在测试里：
 *   - 写线上必须是小端 int16、单位 0.01℃（2.5℃ → 250）
 *   - 输入框回显、状态文案都必须显示 2.5，而不是 25.0（历史 bug：x100/10 当成了 ℃）
 *   - 切到 ℉ 后同样按 0.1℉ 格显示，不能放大 10 倍
 *
 * 跑法：cd test/e2e && npm run offset
 */
import {
  openApp, connect, pipeConsole, finish, assert, log, step, until,
} from './lib/harness.mjs';

const { browser, page, device } = await openApp({ seed: { history: 12, daily: 7 } });
pipeConsole(page);

/** 在输入框里键入数值并触发 change（页面据此按 0.1 网格规范化） */
async function typeOffset(value) {
  await page.$eval('#tempOffsetInput', (el, v) => {
    el.value = v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

/** 偏移卡片在 Settings 页签里，点按钮统一走 evaluate（不依赖元素在视口内可点） */
const click = (id) => page.evaluate((i) => document.getElementById(i).click(), id);

/** 当前显示单位（'℃' | '°F'） */
const unitNow = () => page.$eval('#tempOffsetUnitSpan', (el) => el.textContent.trim());

/** 把显示单位切到指定值：默认单位可能来自浏览器区域推断（℉），不能假设起始是 ℃ */
async function setUnit(label) {
  for (let i = 0; i < 3 && (await unitNow()) !== label; i++) {
    await click('tempUnitToggle');
    await until(async () => (await unitNow()) !== '', { label: '单位切换完成' });
  }
  assert((await unitNow()) === label, `无法切到 ${label}，当前 ${await unitNow()}`);
}

/** 点 Apply，等回执文案出现，返回 { status, echo, wire } */
async function apply() {
  const before = device.writes.length;
  await click('tempOffsetApplyBtn');
  await until(async () => {
    const t = await page.$eval('#tempOffsetStatus', (el) => el.textContent);
    return t.includes('set to') || t.includes('failed');
  }, { label: '偏移写入回执' });
  const status = (await page.$eval('#tempOffsetStatus', (el) => el.textContent)).trim();
  const echo = await page.$eval('#tempOffsetInput', (el) => el.value);
  const w = device.writes.slice(before).find((x) => x.uuid.endsWith('ffe8-0000-1000-8000-00805f9b34fb'));
  return { status, echo, wire: w ? w.data.readInt16LE(0) : null };
}

try {
  step('连接假外设');
  await connect(page, device);

  step('切到 Settings 页签（偏移卡片所在位置）');
  await click('mainTabSettingBtn');
  await until(async () => page.$eval('#tempOffsetInput', (el) => el.offsetParent !== null), { label: '偏移卡片可见' });

  step('℃ 模式：设 2.5 并 Apply');
  await setUnit('℃');
  await typeOffset('2.5');
  const c = await apply();
  log(`回执「${c.status}」 输入框「${c.echo}」 写线 ${c.wire}（0.01℃）`);
  assert(c.wire === 250, `0xFFE8 写线应为 250（2.50℃），实际 ${c.wire}`);
  assert(c.echo === '2.5', `输入框回显应为 2.5，实际 ${c.echo}`);
  assert(c.status === 'Temperature offset set to 2.5 ℃', `回执文案应显示 2.5 ℃，实际「${c.status}」`);

  step('℃ 模式：负值 -3.7');
  await typeOffset('-3.7');
  const neg = await apply();
  log(`回执「${neg.status}」 写线 ${neg.wire}`);
  assert(neg.wire === -370, `0xFFE8 写线应为 -370，实际 ${neg.wire}`);
  assert(neg.status === 'Temperature offset set to -3.7 ℃', `负值回执文案错误：「${neg.status}」`);

  step('切到 ℉：设 2.5 °F 并 Apply');
  await setUnit('°F');
  await typeOffset('2.5');
  const f = await apply();
  log(`回执「${f.status}」 输入框「${f.echo}」 写线 ${f.wire}`);
  // 25 格 × 50/9 ≈ 139（1.39℃）；回显 1.39℃ × 9/5 = 2.502 → 2.5 °F
  assert(f.wire === 139, `℉ 模式写线应为 139（1.39℃），实际 ${f.wire}`);
  assert(f.status === 'Temperature offset set to 2.5 °F', `℉ 回执文案应显示 2.5 °F，实际「${f.status}」`);

  step('夹取：键入 999 应被钳到量程上限');
  await typeOffset('999');
  const clamped = await page.$eval('#tempOffsetInput', (el) => el.value);
  log(`键入 999 → 输入框 ${clamped}`);
  assert(Number(clamped) <= 18 && Number(clamped) >= -18, `℉ 模式量程夹取失效：${clamped}`);

  await finish(browser, page, '/tmp/soilpulse-e2e-temp-offset.png', '场景 6 温度偏移');
} catch (e) {
  await page.screenshot({ path: '/tmp/soilpulse-e2e-temp-offset-fail.png' }).catch(() => {});
  await browser.close();
  throw e;
}
