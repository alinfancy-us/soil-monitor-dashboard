/**
 * 展示用预览：给真实页面喂一批"像真的"日均数据，截图温度极值（0xFFEE）改动后的效果。
 *
 * 为什么不用另做一个演示页：这里跑的是 index.html + page/js/*.js 本身，只把蓝牙层换成
 * CDP 虚拟外设，所以截图里的每一段色带、每一个阈值点都由产品代码画出来，不存在
 * "预览版和线上版长得不一样"的风险。
 *
 * 跑法：
 *   npm run preview        # 出 6 张图到 /tmp/soilpulse-preview-*.png
 *   LIVE=1 npm run preview # 打开真实 Chrome 窗口（寒潮 30 天视图），可自己点 7D/30D、℃/℉
 */
import { openApp, connect, log, sleep } from './lib/harness.mjs';

const OUT = process.env.OUT || '/tmp';
const LIVE = process.env.LIVE === '1';

const DAY = 86400;
const today = Math.floor(Date.now() / 1000 / DAY) * DAY;
const r2 = (v) => Math.round(v * 100) / 100;

/**
 * 秋季寒潮：30 天缓降 → 最后三天结霜（-0.8 / -2.6 / -3.4℃）。
 * 均值线只是一路平缓下降，只有色带下探+霜冻点能看出这几天要冻死苗；
 * 寒潮放在窗口尾部，7 天视图也能截到。
 */
function autumnFrost() {
  const out = [];
  for (let i = 0; i < 30; i++) {
    const d = 29 - i;
    let avg, min, max;
    if (i < 26) {                       // 平缓下降 17.5 → 10.2℃
      avg = 17.5 - (i / 25) * 7.3;
      min = avg - 6.5; max = avg + 5.5;
    } else if (i < 29) {                // 寒潮三天：日均掉到 6.5~5.2，最低破零
      const k = i - 26;
      avg = [6.5, 5.8, 5.2][k];
      min = [-0.8, -2.6, -3.4][k];
      max = [12.2, 11.4, 13.0][k];
    } else {                            // 寒潮尾声：白天回暖、夜里仍贴冰点
      avg = 7.6; min = 1.8; max = 13.4;
    }
    out.push({
      dateEpoch: today - d * DAY,
      temp: r2(avg), hum: Math.round(52 + 9 * Math.sin(i / 3)), battPercent: 100 - Math.floor(i / 10),
      tempMin: r2(min), tempMax: r2(max),
    });
  }
  return out;
}

/**
 * 夏季热浪：常年 28~33℃，第 26~28 天连续 38~40℃。
 * 均值线只是"高了一点"，极值才看得出那三天会烫伤浅根。
 */
function summerHeat() {
  const out = [];
  for (let i = 0; i < 30; i++) {
    const d = 29 - i;
    const heat = i >= 26 && i <= 28;
    const avg = heat ? [29.5, 30.4, 28.8][i - 26] : 25.5 + 1.6 * Math.sin(i / 2.5);
    const min = heat ? [25.0, 25.8, 24.6][i - 26] : avg - 3.6;
    const max = heat ? [38.6, 40.2, 37.4][i - 26] : avg + 4.2;
    out.push({
      dateEpoch: today - d * DAY,
      temp: r2(avg), hum: Math.round(38 + 7 * Math.cos(i / 4)), battPercent: 100 - Math.floor(i / 9),
      tempMin: r2(min), tempMax: r2(max),
    });
  }
  return out;
}

const METRIC_BTN = {
  temp: 'dailyMetricTempBtn', hum: 'dailyMetricHumBtn', batt: 'dailyMetricBattBtn',
};

async function pick(page, { unit = 'C', range = 30, metric = 'temp' } = {}) {
  await page.evaluate(({ unit, range, metric, btn }) => {
    // ⚠ ℃/℉ 切换器是"点哪儿都翻转"的 toggle（app.js 刻意为之），
    //   只有当前单位 ≠ 目标单位时才能点，否则等于又翻回去
    const active = document.querySelector('.temperature-unit-btn.bg-amber-500')?.dataset.unit;
    if (active !== unit) document.getElementById('tempUnitToggle')?.click();
    document.getElementById(btn).click();
    document.getElementById(range === 30 ? 'dailyRange30Btn' : 'dailyRange7Btn').click();
  }, { unit, range, metric, btn: METRIC_BTN[metric] });
  await sleep(350);
}

async function shot(page, name) {
  const card = await page.evaluateHandle(() =>
    document.getElementById('dailyTabPanel').closest('.dashboard-card'));
  await card.asElement().screenshot({ path: `${OUT}/${name}.png` });
  log(`截图 ${OUT}/${name}.png`);
}

/** 开一套独立浏览器 → 灌数 → 连接 → 按脚本截图 */
async function run(tag, daily, views, { keepOpen = false } = {}) {
  const { browser, page, device } = await openApp({
    seed: { history: 144, daily: 0, opts: { tzMin: 480 } },   // 设备时区 UTC+8：截图日期口径与目标市场一致
    profile: `/tmp/soilpulse-preview-${tag}`,
    verbose: false,
  });
  // VW=390（可选 VH=844）：按手机视口截图，验证移动端排版
  const vw = Number(process.env.VW || 0);
  if (vw) await page.setViewport({ width: vw, height: Number(process.env.VH || 844), deviceScaleFactor: 2 });
  device.daily = daily;
  await connect(page, device);
  for (const v of views) {
    await pick(page, v);
    // sel：先"按住横滑"到第 sel 天，验证拖动状态下的竖线与摘要头
    if (Number.isInteger(v.sel)) {
      await page.evaluate((dayIdx) => {
        const c = document.getElementById('dailyChart');
        const lay = c._chartLayout;
        const rect = c.getBoundingClientRect();
        const mk = (type, i) => new PointerEvent(type, {
          clientX: rect.left + lay.padLeft + i * lay.stepX, clientY: rect.top + 20,
          bubbles: true, pointerId: 1, pointerType: 'touch', isPrimary: true,
        });
        c.dispatchEvent(mk('pointerdown', lay.len - 1));
        c.dispatchEvent(mk('pointermove', dayIdx));
        c.dispatchEvent(mk('pointerup', dayIdx));
      }, v.sel);
      await sleep(250);
    }
    await shot(page, `soilpulse-preview-${tag}-${v.name}`);
  }
  if (keepOpen) return { browser, page };
  await browser.close();
  return null;
}

if (LIVE) {
  // 交互模式：只起寒潮场景，30 天视图，窗口留给人点
  await run('frost', autumnFrost(), [{ name: 'live', unit: 'C', range: 30 }], { keepOpen: true });
  log('窗口已打开：可自己点 7D/30D、Temperature/Moisture、℃/℉（Ctrl+C 结束）');
  await new Promise((r) => setTimeout(r, 30 * 60 * 1000));
} else {
  await run('frost', autumnFrost(), [
    { name: '30d', unit: 'C', range: 30 },
    { name: '7d', unit: 'C', range: 7 },
    { name: '7d-f', unit: 'F', range: 7 },
    { name: 'hum', unit: 'C', range: 7, metric: 'hum' },
    { name: 'hum30d', unit: 'C', range: 30, metric: 'hum' },
    { name: '30d-sel', unit: 'C', range: 30, sel: 23 },
    { name: '30d-sel', unit: 'C', range: 30, sel: 23 },
  ]);
  await run('heat', summerHeat(), [
    { name: '30d', unit: 'C', range: 30 },
    { name: '7d', unit: 'C', range: 7 },
  ]);
  log('完成');
}
