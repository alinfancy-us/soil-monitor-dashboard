/**
 * E2E 共用脚手架：启动浏览器、上电模拟适配器、装假外设、打开页面、走一遍连接。
 *
 * 所有场景脚本都只做两件事：编排假设备的 GATT 行为 + 断言页面表现。
 * 不改 page/ 下任何业务代码，也不进 dist 发布包（deploy.yml 只复制 index.html + page/）。
 */
import puppeteer from 'puppeteer-core';
import { FakeSoilDevice } from '../soil-fake.mjs';

export const URL = process.env.URL || 'http://127.0.0.1:8000/index.html';
export const CHROME = process.env.CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const HEADLESS = process.env.HEADLESS === '1';
export const DEVICE_NAME = 'SoilPulse-E2E';

export const log = (...a) => console.log('[e2e]', ...a);
export const step = (s) => console.log(`[e2e] ── ${s}`);

export function assert(cond, msg) {
  if (!cond) throw new Error(`断言失败：${msg}`);
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等一个条件成立，超时抛错（比 waitForFunction 的错误信息更可读） */
export async function until(fn, { timeout = 15000, interval = 200, label = '条件' } = {}) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - t0 > timeout) throw new Error(`等待「${label}」超时 ${timeout}ms`);
    await sleep(interval);
  }
}

/**
 * 启动 Chrome + 模拟蓝牙适配器 + 装好假外设。
 * @returns {{browser, page, device, bt}}
 */
export async function openApp({ seed = {}, profile = '/tmp/soilpulse-e2e-profile', verbose = false, query = '' } = {}) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: HEADLESS,
    userDataDir: profile,
    args: [
      '--window-size=1180,900',
      // 本机 shell 可能跑在受限沙箱里，Chrome 自己的 sandbox 会 init 失败（Operation not permitted）；
      // GPU 进程同理，测试不需要真实 GPU，直接软件渲染
      '--no-sandbox',
      '--disable-gpu-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
    ],
    defaultViewport: { width: 1180, height: 900 },
  });

  const ctx = await browser.createBrowserContext();   // 每次跑都是干净的 localStorage
  const page = await ctx.newPage();
  // BluetoothEmulation 是浏览器级 CDP 域（不在 page 会话上）
  const bt = await browser.target().createCDPSession();

  await bt.send('BluetoothEmulation.disable').catch(() => {});
  await bt.send('BluetoothEmulation.enable', { state: 'powered-on', leSupported: true });

  const device = new FakeSoilDevice(bt, { name: DEVICE_NAME, ...(seed.opts || {}) });
  device.verbose = verbose;
  if (seed.history !== 0) device.seedHistory(seed.history ?? 144, seed.historyOpts || {});
  if (seed.daily !== 0) device.seedDaily(seed.daily ?? 30);
  device.setReadAck({ status: 0 });
  await device.install();

  await page.goto(URL + query, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#connectBtn:not([disabled])', { timeout: 15000 });
  return { browser, page, device, bt };
}

/** 点 Connect → 选择器里选假外设 → 等首页数值上屏 */
export async function connect(page, device) {
  // ⚠ 不要用 simulateAdvertisement：它偶发不返回，且会把 CDP 蓝牙模拟线程卡住，
  //   导致之后的 connection 应答收不到（网页侧表现为 gatt.connect timed out）。
  //   simulatePreconnectedPeripheral 造的外设本来就在选择器列表里，只是名字为空。
  const promptP = page.waitForDevicePrompt({ timeout: 10000 });
  await page.click('#connectBtn');
  const prompt = await promptP;
  const picked = prompt.devices[0];
  assert(picked, '设备选择器里没有任何设备');
  await prompt.select(picked);
  await until(async () => {
    const t = await page.$eval('#tempValue', (e) => e.textContent.trim());
    return t !== '--';
  }, { timeout: 30000, label: '首页温度上屏' });
  log(`已连接（历史 ${device.records.length} 条 / 日均 ${device.daily.length} 天）`);
}

/** 页面可见快照，失败排查时用 */
export async function snapshot(page) {
  return page.evaluate(() => {
    const txt = (id) => document.getElementById(id)?.textContent?.trim() ?? null;
    const rows = [...document.querySelectorAll('#historyBody tr')].map((tr) =>
      [...tr.children].map((td) => td.textContent.trim()));
    return {
      status: txt('statusText'),
      temp: txt('tempValue'),
      hum: txt('humValue'),
      lastUpdate: txt('lastUpdate'),
      historyRows: rows.length,
      firstRow: rows[0],
      lastRow: rows[rows.length - 1],
      trendRange: txt('trendRangeText'),
      otaStatus: txt('otaStatus'),
      connectBtn: document.getElementById('connectBtn')?.textContent?.trim(),
      connectDisabled: document.getElementById('connectBtn')?.disabled,
      clearDisabled: document.getElementById('clearCacheBtn')?.disabled,
      storageKeys: Object.keys(localStorage).sort(),
    };
  });
}

/** 打开日志面板（默认折叠时也能抓到 console） */
export function pipeConsole(page) {
  page.on('console', (m) => {
    const t = m.text();
    if (/\[SoilPulse|error|Error|失败|denied/i.test(t)) console.log('  page>', t);
  });
  page.on('pageerror', (e) => console.log('  page×error>', e.message));
}

/** 统一的场景收尾：截图 + 关闭 */
export async function finish(browser, page, shotPath, okLabel) {
  if (shotPath) {
    await page.screenshot({ path: shotPath }).catch(() => {});
    log(`截图：${shotPath}`);
  }
  await browser.close();
  log(`✅ ${okLabel} 通过`);
}
