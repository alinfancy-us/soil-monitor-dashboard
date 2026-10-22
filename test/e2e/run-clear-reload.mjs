/**
 * Clear 语义回归（2026-10-22 移除"清空水位"后重写）。
 *
 * 清空水位（clearedAt）已废弃：Clear = 删本地缓存 + 清内存 + 让设备自己清，
 * 之后设备读回什么就画什么，不再按时间戳二次过滤。它带来的问题是——
 * 设备 flash 里确实还在的数据（重烧 / 换设备 / 灌 mock 日志）会被静默藏掉，
 * 真机上表现为「日志 Daily read: 30 day(s)，30 Days 视图却空白」。
 *
 * 本场景锁住两条：
 *   A. Clear 后本地确实干净（trend/daily 缓存全删、表格回到空态、不残留水位 key）
 *   B. 重连后设备直读的数据完整上屏（不再有水位把它们挡掉）；
 *      缓存里的旧记录重载后正常回显（不再被过滤）
 *
 * 假外设 autoDeviceEffects=false：收到 CLR1 不自己清数据，模拟"设备没清干净/重新灌过
 * 数据"这一真机场景——这正是水位机制误伤的那一种。
 */
import { openApp, connect, sleep, until, assert, finish } from './lib/harness.mjs';

const { browser, page, device } = await openApp({
  seed: {
    history: 144,
    historyOpts: { gapFromH: 0, gapToH: 0 },
    daily: 30,
    opts: { autoDeviceEffects: false },
  },
  profile: '/tmp/soilpulse-e2e-clear-' + Date.now(),
});

try {
  await connect(page, device);
  await sleep(1200);

  const devId = await page.evaluate(() => {
    const k = Object.keys(localStorage).find((k) => /^SoilPulse:trend:v1:/.test(k));
    return k ? k.slice('SoilPulse:trend:v1:'.length) : null;
  });
  assert(devId, '连接后应建立 trend 缓存（拿到 deviceId）');

  // —— A. 点 Clear：设备 0xFFE5 收到 CLR1，本地缓存与界面一起清空
  page.once('dialog', (d) => d.accept());
  await page.click('#clearCacheBtn');
  await until(async () => {
    const s = await page.evaluate(() => ({
      keys: Object.keys(localStorage),
      rows: document.querySelectorAll('#historyBody tr').length,
    }));
    return !s.keys.some((k) => /^SoilPulse:(trend|daily):/.test(k)) && s.rows <= 1;
  }, { timeout: 8000, label: 'Clear 后缓存与历史表清空' });

  const afterClear = await page.evaluate(() => ({
    keys: Object.keys(localStorage),
    firstRow: document.querySelector('#historyBody tr')?.textContent.trim().slice(0, 60),
  }));
  assert(!afterClear.keys.some((k) => /clearedAt/.test(k)),
    `不应残留清空水位 key：${afterClear.keys.filter((k) => /clearedAt/.test(k)).join(',')}`);
  assert(/Connect device to view history/.test(afterClear.firstRow || ''),
    `清空后表格应回到空态，实际首行「${afterClear.firstRow}」`);
  console.log('[e2e] ── Clear 后：缓存已清、无水位 key');

  // —— B. 断链重连：设备里的数据仍在（模拟设备未清干净），必须完整上屏
  await page.click('#connectBtn');
  await until(async () => {
    const t = await page.$eval('#statusText', (e) => e.textContent.trim());
    return t === 'Disconnected';
  }, { timeout: 8000, label: '断链完成' });
  await connect(page, device);
  await sleep(1500);

  const snap = await page.evaluate(() => {
    const el = (id) => document.getElementById(id);
    return {
      trendRange: el('trendRangeText')?.textContent.trim(),
      rows: document.querySelectorAll('#historyBody tr').length,
    };
  });
  assert(snap.rows === 20, `重连后 History 表应有 20 行（设备直读全量），实际 ${snap.rows}`);
  assert(/Time Range/.test(snap.trendRange), `24h 图应有时间范围文案，实际「${snap.trendRange}」`);

  await page.click('#dailyRange30Btn');
  await sleep(900);
  const d30 = await page.evaluate(() => {
    const el = (id) => document.getElementById(id);
    return {
      emptyHidden: el('dailyEmpty')?.classList.contains('hidden'),
      note: el('dailyNote')?.textContent.trim(),
      rangeValue: el('dailyRangeValue')?.textContent.trim(),
    };
  });
  assert(d30.emptyHidden === true, '30 Days 视图不得空白（设备直读 30 天不再被水位滤）');
  assert(d30.note === '30-day daily average', `日均范围说明应为 30-day，实际「${d30.note}」`);
  assert(!!d30.rangeValue, '日均摘要头应有选中日读数');
  console.log('[e2e] ── 重连后：24h 20 行 + 30 天日均完整上屏');

  // —— B2. 缓存里的旧记录：重载后正常回显（不再因"早于水位"被藏）
  await page.evaluate((id) => {
    localStorage.setItem(`SoilPulse:trend:v1:${id}`, JSON.stringify({
      version: 1,
      savedAt: Date.now(),
      records: [{
        timestamp: Math.floor(Date.now() / 1000) - 86400 * 3,   // 3 天前
        temp: 22.5, hum: 55, batt: 88,
      }],
    }));
  }, devId);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(1500);
  const afterReload = await page.evaluate(() => {
    const el = (id) => document.getElementById(id);
    return {
      firstRow: document.querySelector('#historyBody tr')?.textContent.trim().slice(0, 60),
      trendRange: el('trendRangeText')?.textContent.trim(),
    };
  });
  assert(!/Connect device to view history/.test(afterReload.firstRow || ''),
    `缓存里的旧记录应正常回显（不再被水位过滤），实际首行「${afterReload.firstRow}」`);
  assert(/Time Range/.test(afterReload.trendRange || ''),
    `重载后应回显缓存并画出时间范围，实际「${afterReload.trendRange}」`);

  await finish(browser, page, '/tmp/soilpulse-e2e-clear.png', 'Clear 语义：删缓存 + 设备权威');
} catch (e) {
  await page.screenshot({ path: '/tmp/soilpulse-e2e-clear-fail.png' }).catch(() => {});
  await browser.close();
  throw e;
}
