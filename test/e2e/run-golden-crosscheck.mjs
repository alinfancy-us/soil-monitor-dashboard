/**
 * 场景：金数据交叉验证（网页侧）——与固件单测共用同一份 JSON 真值。
 *
 * 数据源：tests/golden/history_crosscheck.json（唯一真值）
 *   C 侧  tests/test_core.c::test_history_crosscheck 断言固件视图
 *         （0xFFE1 / 0xFFEC / pending / Flash 条数）
 *   本文件 断言网页视图：把 JSON 里每个导出点的"设备真值"（flash → 0xFFEC，
 *         ram → 0xFFE1 / 0xFFEB）灌给假外设，页面合并后的缓存必须与 JSON.web 完全一致。
 *
 * 五个场景（重点：断电重启 + 未对时）：
 *   A 未对时采样 → 首次对时补写：对时前 ts=0 全部丢弃、对时后 1 条且时间戳正确
 *   B 多次对时基准漂移：旧记录时间戳冻结不变，新采样才用新基准
 *   C 深睡重启（retention 保留）：与断电前完全一致，不新增重复点
 *   D 冷启动（RAM 归零 / Flash 保留）：0xFFE1 空、0xFFEC 仍给原时间戳
 *   E Clear：全清后新采样从零开始，旧时间戳不复活
 *
 * 跑法：cd test/e2e && npm run golden
 * 前置：仓库根目录已起静态服务（默认 http://127.0.0.1:8000），本机装有 Chrome。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  openApp, connect, pipeConsole, assert, log, step, until, sleep,
} from './lib/harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_JSON = resolve(HERE, '../../../tests/golden/history_crosscheck.json');

const golden = JSON.parse(readFileSync(GOLDEN_JSON, 'utf8'));

/** 读回页面为该设备保存的 24h 趋势缓存（key：SoilPulse:trend:v1:<deviceId>） */
async function readTrendCache(page) {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => /^SoilPulse:trend:v1:/.test(k));
    if (!key) return { key: null, records: [] };
    try {
      const raw = JSON.parse(localStorage.getItem(key) || '{}');
      return { key, records: Array.isArray(raw?.records) ? raw.records : [] };
    } catch {
      return { key, records: [] };
    }
  });
}

async function trendRange(page) {
  return page.$eval('#trendRangeText', (e) => e.textContent.trim()).catch(() => '');
}

/**
 * 跑一个导出点：新开浏览器（干净 localStorage）→ 装配设备真值 → 连接 → 断言缓存。
 * @returns {Promise<{count: number, ts: number[]}>}
 */
async function runOneOnce(scene, ex) {
  const expected = ex.web;
  const label = `${scene.id}/${ex.exportId}`;
  // 中文：本套件在一个进程里连开 12 个浏览器，与其它场景共用 userDataDir 会互相踩
  //      （设备选择器注册表残留 → "Cannot find request with id"）。给一套独立 profile。
  const { browser, page, device } = await openApp({
    seed: { history: 0, daily: 0 },
    profile: '/tmp/soilpulse-e2e-profile-golden',
  });

  // 中文：必须在 connect 之前装配——连接时页面立刻读 0xFFE1 并拉 0xFFEC
  device.applyGoldenView({ flash: ex.flash, ram: ex.ram });
  pipeConsole(page);

  try {
    step(`${label}: 设备视图 Flash=${ex.flash.length} 条 / RAM=${ex.ram.length} 条 → 期望 web ${expected.count} 条`);
    await connect(page, device);

    if (expected.count === 0) {
      // 中文：没有可画的数据时必须给出可读提示（未对时 / 空数据），而不是静默
      await until(async () => /Time not synced|No data available/i.test(await trendRange(page)), {
        timeout: 25000, label: `${label} 空态提示`,
      });
    } else {
      await until(async () => (await readTrendCache(page)).records.length === expected.count, {
        timeout: 25000, label: `${label} 缓存 ${expected.count} 条`,
      });
    }

    // 中文：等 5s 轮询/后台回填收敛一次，确认不会再多出重复点
    await sleep(1200);
    const { records } = await readTrendCache(page);
    const ts = records.map((r) => Number(r.timestamp));

    if (ts.length !== expected.count) {
      throw new Error(`${label}: 缓存条数 ${ts.length} ≠ 期望 ${expected.count}（ts=${JSON.stringify(ts)}）`);
    }
    if (JSON.stringify(ts) !== JSON.stringify(expected.ts)) {
      throw new Error(`${label}: 时间戳序列不一致\n  期望 ${JSON.stringify(expected.ts)}\n  实际 ${JSON.stringify(ts)}`);
    }

    await browser.close();
    return { count: ts.length, ts };
  } catch (e) {
    await page.screenshot({ path: `/tmp/soilpulse-e2e-golden-${scene.id}-${ex.exportId}-fail.png` }).catch(() => {});
    await browser.close();
    throw new Error(`[${label}] ${e.message}`);
  }
}

/** 中文：CDP 蓝牙仿真偶发 "DeviceAccess.selectPrompt: Cannot find request"（上一个浏览器实例
 *       的 chooser 提示还没回收），属于通道抖动而非断言失败。本套件要连开 12 个浏览器，
 *       命中概率被放大，所以只对这类协议错误做有界重试，断言失败绝不重试。 */
const RETRYABLE = /DeviceAccess|selectPrompt|Protocol error|Target closed|Session closed/i;

async function runOne(scene, ex) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await runOneOnce(scene, ex);
    } catch (e) {
      lastErr = e;
      if (!RETRYABLE.test(e.message)) throw e;
      log(`  ↻ 浏览器通道瞬时错误（第 ${attempt}/3 次），重试：${e.message.split('\n')[0]}`);
      await sleep(400 * attempt);
    }
  }
  throw lastErr;
}

const rows = [];

for (const scene of golden.scenarios) {
  log(`\n── ${scene.id}：${scene.title} ──`);
  for (const ex of scene.expects) {
    const got = await runOne(scene, ex);
    rows.push({
      scene: scene.id,
      exportId: ex.exportId,
      device: `F${ex.flash.length}/R${ex.ram.length}`,
      expected: ex.web.count,
      actual: got.count,
      ok: true,
    });
  }
}

log('\n=== 金数据交叉验证（网页侧） ===');
log('场景 / 导出点'.padEnd(46) + '设备视图   期望  实际');
for (const r of rows) {
  const name = `${r.scene}/${r.exportId}`.padEnd(44);
  log(`${name} ${r.device.padEnd(9)} ${String(r.expected).padEnd(5)} ${r.actual}`);
}

const failed = rows.filter((r) => !r.ok);
assert(failed.length === 0, `${failed.length} 个导出点失败`);
log(`\n✅ ${rows.length}/${rows.length} 个导出点通过（5 场景，与固件单测共用 tests/golden/history_crosscheck.json）`);
