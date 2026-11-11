/**
 * 场景：历史里的"同值近似副本"必须被合并成一条。
 *
 * 背景（老固件的时间戳缺陷）：设备每次导出都按**当前**对时基准把 uptime 现算成 epoch，
 * 网页一连上就写 0xFFE2 对时，基准一变，同一条测量在 0xFFEC（Flash，先写入）与
 * 随后轮询的 0xFFE1（RAM，按新基准重算）里会差几十秒。缓存于是堆出成对的
 * "温湿电完全相同、时间差 <1 分钟"的点，既挤掉真正的历史，也让曲线出现台阶。
 *
 * 修复分两层：
 *   1) 固件：入环时冻结 epoch（重设基准不再改动已发生的记录）——单测 test_core 覆盖；
 *   2) 前端：mergeTrendRecords 兜底，三值完全相同且 |Δt| ≤ 60s 视为同一条，
 *      保留较早的时间戳。本场景模拟已存在的历史数据（seed duplicateShiftS=53），
 *      锁死第 2 层的行为：缓存里不得留成对副本。
 *
 * 跑法：cd test/e2e && npm run history-dedupe
 * 前置：仓库根目录已起静态服务（默认 http://127.0.0.1:8000），本机装有 Chrome。
 */
import {
  openApp, connect, snapshot, pipeConsole, finish, assert, log, step, until, sleep,
} from './lib/harness.mjs';

// 中文：0xFFEC 的 total 字段是 u8，假设备把"物理采样 + 副本"一起返回，
//      所以总数必须 ≤255；120+120=240 既覆盖满 20h，也留出余量。
const PHYSICAL_SAMPLES = 120;      // 中文：假设备造 120 条真实采样（20h）
const DUPLICATE_SHIFT_S = 53;      // 中文：现场观测到的副本偏移量级（41s / 53s）
const SAME_VALUE_WINDOW_S = 60;    // 中文：与 app.js 的 TREND_SAME_VALUE_MERGE_S 保持一致

/** 读回页面为该设备保存的 24h 趋势缓存 */
async function readTrendCache(page) {
  return page.evaluate(() => {
    const key = Object.keys(localStorage)
      .find((k) => /^SoilPulse:trend:v1:/.test(k));
    if (!key) return { key: null, records: [] };
    try {
      const raw = JSON.parse(localStorage.getItem(key) || '{}');
      return { key, records: Array.isArray(raw?.records) ? raw.records : [] };
    } catch {
      return { key, records: [] };
    }
  });
}

/** 找出"三个读数完全相同且时间差 ≤ windowS"的成对记录（去重失效时会有） */
function findSameValuePairs(records, windowS) {
  const pairs = [];
  for (let i = 0; i < records.length; i++) {
    for (let j = i + 1; j < records.length; j++) {
      const a = records[i];
      const b = records[j];
      const dt = Math.abs(b.timestamp - a.timestamp);
      if (dt > windowS) break;                       // 已排序：再往后只会更远
      if (a.temp === b.temp && a.hum === b.hum && a.batt === b.batt) {
        pairs.push({ dt, tsA: a.timestamp, tsB: b.timestamp });
      }
    }
  }
  return pairs;
}

// 中文：让最晚一条落在过去，副本 +53s 也不会跑到"未来"污染趋势图
const endAt = Math.floor(Date.now() / 1000) - 120;

{
  const { browser, page, device } = await openApp({
    seed: {
      history: PHYSICAL_SAMPLES,
      daily: 0,
      historyOpts: {
        gapFromH: 0, gapToH: 0,            // 中文：关掉默认的 3h 断档，条数可精确断言
        duplicateShiftS: DUPLICATE_SHIFT_S,
        endAt,
      },
    },
  });
  pipeConsole(page);

  assert(device.records.length === PHYSICAL_SAMPLES * 2,
    `假设备原始条数应为 ${PHYSICAL_SAMPLES * 2}（含副本），实际 ${device.records.length}`);

  try {
    step(`连接假外设（${PHYSICAL_SAMPLES} 条真实采样 + ${PHYSICAL_SAMPLES} 条 +${DUPLICATE_SHIFT_S}s 同值副本）`);
    await connect(page, device);

    step('等待历史全量落进本地缓存');
    await until(async () => (await readTrendCache(page)).records.length >= PHYSICAL_SAMPLES, {
      timeout: 30000, label: '24h 缓存装满',
    });
    // 中文：后台回填是分页进行的，等它收敛后再断言，避免读到中间态
    await sleep(1500);

    const { key, records } = await readTrendCache(page);
    log(`缓存 key=${key}, 条数=${records.length}`);

    step('断言：同值副本已被合并（总条数 = 物理采样数）');
    assert(records.length === PHYSICAL_SAMPLES,
      `去重后应为 ${PHYSICAL_SAMPLES} 条，实际 ${records.length}`);

    const pairs = findSameValuePairs(records, SAME_VALUE_WINDOW_S);
    if (pairs.length) {
      log('残留成对副本（前 3 组）：', JSON.stringify(pairs.slice(0, 3)));
    }
    assert(pairs.length === 0,
      `仍存在 ${pairs.length} 组"同值且相差 ≤${SAME_VALUE_WINDOW_S}s"的记录`);

    step('断言：时间戳严格递增（合并后不得打乱顺序）');
    for (let i = 1; i < records.length; i++) {
      assert(records[i].timestamp > records[i - 1].timestamp,
        `第 ${i} 条时间戳未递增：${records[i - 1].timestamp} → ${records[i].timestamp}`);
    }

    step('断言：末条保留的是较早的时间戳（不取副本的 +53s）');
    const last = records[records.length - 1];
    assert(last.timestamp === endAt, `末条时间戳应为 ${endAt}（物理采样时刻），实际 ${last.timestamp}`);

    const snap = await snapshot(page);
    log('页面快照：', JSON.stringify({
      status: snap.status, historyRows: snap.historyRows, trendRange: snap.trendRange,
    }));
    assert(snap.status === 'Connected', `状态应为 Connected，实际 ${snap.status}`);
    assert(snap.historyRows === 20, `历史表应显示最近 20 条，实际 ${snap.historyRows} 行`);

    await finish(browser, page, '/tmp/soilpulse-e2e-history-dedupe.png', '历史同值副本去重');
  } catch (e) {
    await page.screenshot({ path: '/tmp/soilpulse-e2e-history-dedupe-fail.png' }).catch(() => {});
    await browser.close();
    throw e;
  }
}
