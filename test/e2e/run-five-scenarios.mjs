/**
 * 五个断电/对时场景 ×「设备 Flash 历史 ↔ 网页展示」端到端验证。
 *
 * 这几条时间线是本次改造的需求来源，逐个锁死网页最终看到的点：
 *   1. 正常对时             会话内已有真 epoch + 新的 uptime → 只回填 uptime，epoch 原样
 *   2. 断电后重启未连接     网页不编造绝对时间，也不把旧会话的 uptime 画出来
 *   3. 首次出厂从未连接     全部 uptime → 连接后全部变成真 epoch
 *   4. 二次断电未连接       多个旧会话从未对时 → 只保留当前会话，旧记录丢弃并留痕
 *   5. 二次断电后再次连接   曾对时的 epoch 保留 + 跨断电 uptime 丢弃 + 当前会话回填
 *
 * 假外设现在按固件同款规则变换：`epoch = now_epoch − now_uptime + u`，
 * 只处理 bootSeq === 当前会话的记录，其余紧凑丢弃并记入 droppedRecords
 * （对应 scripts/parse_flash_dump.py 的 hourly_unsynced.csv 留痕，网页不读）。
 *
 * 跑法：cd test/e2e && node run-five-scenarios.mjs
 */
import {
  openApp, connect, snapshot, pipeConsole, finish, assert, log, step, until, sleep,
} from './lib/harness.mjs';

const STEP_S = 600;
const EPOCH_MIN = 946684800;
const STALE_ERROR = /Time not synced|尚未完成时间校准|设备时钟校准中/i;

const cachedTrend = (page) => page.evaluate(() => {
  const keys = Object.keys(localStorage).filter((k) => /^SoilPulse:trend:v1:/.test(k));
  if (!keys.length) return [];
  try { return JSON.parse(localStorage.getItem(keys[0])).records || []; } catch (_) { return []; }
});

/** 已对时的 16B 记录（flags.bit0=1） */
const epochRec = (ts, temp, tag) => ({ kind: 'epoch', timestamp: ts, temp, hum: 50, batt: 90, tag });
/** 未对时的 16B 记录（flags.bit0=0，ts 存本次上电 uptime，rsv 存 bootSeq） */
const uptimeRec = (u, bootSeq, temp, tag) => ({
  kind: 'uptime', uptime: u, bootSeq, timestamp: 0, temp, hum: 50, batt: 90, tag,
});

/** 逐点比对：网页 render() 的数组必须等于设备 0xFFEC 导出的真 epoch 点 */
function assertSamePoints(got, expect, label) {
  const gts = got.map((r) => Number(r.timestamp));
  const ets = expect.map((r) => Number(r.timestamp));
  assert(gts.length === ets.length,
    `${label}：网页 ${gts.length} 点，设备 0xFFEC ${ets.length} 点`);
  assert(gts.join(',') === ets.join(','),
    `${label}：时间轴不逐点一致\n  网页 ${gts.join(',')}\n  设备 ${ets.join(',')}`);
  assert(got.map((r) => r.temp).join(',') === expect.map((r) => r.temp).join(','),
    `${label}：测量值序列不一致（说明丢错了记录）`);
  assert(new Set(gts).size === gts.length, `${label}：出现重复时间点`);
  assert(gts.every((v, i) => i === 0 || v > gts[i - 1]), `${label}：时间轴非严格递增`);
  assert(gts.every((v) => v >= EPOCH_MIN && v <= Math.floor(Date.now() / 1000) + 60),
    `${label}：时间跑到未来或早于 2000 年`);
}

async function waitCached(page, count, label) {
  await until(async () => (await cachedTrend(page)).length === count,
    { timeout: 25000, label: `${label}：网页缓存 ${count} 点` });
  await sleep(400);
}

const now = Math.floor(Date.now() / 1000);

/**
 * 起一个独立场景。opts 里带 backfillAfterHistoryReads:1 → 网页第 1 次读 0xFFEC
 * 时设备已完成回填，对应"固件先回填、网页后拉"的正常路径。
 */
async function start(label, records, { bootSeq, uptimeNow, liveTs = now + 10, connectIt = true } = {}) {
  const { browser, page, device } = await openApp({
    seed: {
      history: 0, daily: 0,
      opts: connectIt ? { bootSeq, backfillUptimeNow: uptimeNow, backfillAfterHistoryReads: 1 } : { bootSeq },
    },
  });
  pipeConsole(page);
  device.setHistory(records);
  device.setLive([{ timestamp: liveTs, temp: 19.5, hum: 60, batt: 88 }]);
  return { browser, page, device, label };
}

async function closeOnFail(ctx, shot) {
  await ctx.page.screenshot({ path: shot }).catch(() => {});
  await ctx.browser.close();
}

// ───────── 场景 1：正常对时（会话内已有真 epoch + 新 uptime） ─────────
{
  const U = 3600;
  const ctx = await start('场景1 正常对时', [
    epochRec(now - 7200, 10, 's1-epoch-a'),
    epochRec(now - 6600, 11, 's1-epoch-b'),
    uptimeRec(U - 600, 1, 12, 's1-uptime-a'),
    uptimeRec(U, 1, 13, 's1-uptime-b'),
  ], { bootSeq: 1, uptimeNow: U });
  try {
    step('场景 1：正常对时（会话内已有 2 条真 epoch + 2 条 uptime）');
    await connect(ctx.page, ctx.device);
    await waitCached(ctx.page, 4, '场景1');
    const got = await cachedTrend(ctx.page);
    const expect = ctx.device.historyView();
    assertSamePoints(got, expect, '场景1');
    const sync = ctx.device.writes.find((w) => w.uuid.includes('ffe2'));
    assert(sync && sync.data.length === 6, '应写入 6B 对时');
    const syncEpoch = sync.data.readUInt32LE(0);
    assert(got[2].timestamp === syncEpoch - 600 && got[3].timestamp === syncEpoch,
      `回填应为 now_epoch − U + u，实际 ${got[2].timestamp}/${got[3].timestamp}，期望 ${syncEpoch - 600}/${syncEpoch}`);
    assert(got[0].timestamp === now - 7200 && got[1].timestamp === now - 6600,
      '原有真 epoch 必须原样保留，不被重算');
    assert(ctx.device.droppedRecords.length === 0, '同一会话不应丢弃任何记录');
    const snap = await snapshot(ctx.page);
    assert(!STALE_ERROR.test(snap.trendRange || ''), `不应出现时间校准错误，实际「${snap.trendRange}」`);
    log(`场景1 OK：4 点（2 真 epoch 原样 + 2 条按 now−U+u 回填），丢弃 0 条`);
    await finish(ctx.browser, ctx.page, '/tmp/soilpulse-e2e-s1.png', '场景1 正常对时');
  } catch (e) { await closeOnFail(ctx, '/tmp/soilpulse-e2e-s1-fail.png'); throw e; }
}

// ───────── 场景 2：断电后重启，尚未连接网页 ─────────
{
  const ctx = await start('场景2 断电重启未连接', [
    epochRec(now - 7200, 20, 's1-epoch-a'),
    epochRec(now - 6600, 21, 's1-epoch-b'),
    uptimeRec(600, 2, 22, 's2-uptime-a'),
    uptimeRec(1200, 2, 23, 's2-uptime-b'),
  ], { bootSeq: 2, uptimeNow: 1200, connectIt: false });
  try {
    step('场景 2：断电重启后没有连接网页 → 不编造绝对时间、不画旧会话');
    const view = ctx.device.historyView();
    assert(view.filter((r) => r.timestamp === 0).length === 2,
      '会话 2 的未对时记录在 0xFFEC 里应输出 ts=0');
    assert(ctx.device.backfillCount === 0 && ctx.device.droppedRecords.length === 0,
      '未连接不应发生回填或丢弃');
    assert(ctx.device.writes.length === 0, '未连接不应写 0xFFE2');
    const snap = await snapshot(ctx.page);
    assert(/no data available|connect device/i.test(`${snap.trendRange} ${snap.lastRow?.join(' ')}`),
      `未连接应保持空态，实际「${snap.trendRange}」/「${snap.lastRow}」`);
    assert((await cachedTrend(ctx.page)).length === 0, '未连接不应写入任何趋势缓存');
    log(`场景2 OK：网页空态；设备侧 2 条真 epoch + 2 条 ts=0，绝不推算时间`);
    await finish(ctx.browser, ctx.page, '/tmp/soilpulse-e2e-s2.png', '场景2 断电未连接');
  } catch (e) { await closeOnFail(ctx, '/tmp/soilpulse-e2e-s2-fail.png'); throw e; }
}

// ───────── 场景 3：首次出厂，从未连接过 ─────────
{
  const U = 3600;
  const ctx = await start('场景3 首次出厂', [
    uptimeRec(U - 1200, 1, 30, 'factory-1'),
    uptimeRec(U - 600, 1, 31, 'factory-2'),
    uptimeRec(U, 1, 32, 'factory-3'),
  ], { bootSeq: 1, uptimeNow: U });
  try {
    step('场景 3：首次出厂从未连接，Flash 里全是 uptime');
    assert(ctx.device.historyView().every((r) => r.timestamp === 0),
      '连接前 0xFFEC 应全是 ts=0');
    await connect(ctx.page, ctx.device);
    await waitCached(ctx.page, 3, '场景3');
    const got = await cachedTrend(ctx.page);
    assertSamePoints(got, ctx.device.historyView(), '场景3');
    assert(got.every((r, i) => i === 0 || r.timestamp - got[i - 1].timestamp === STEP_S),
      '出厂首连应还原出整齐的 600s 采样网格');
    assert(ctx.device.droppedRecords.length === 0, '同一会话不应丢弃');
    const snap = await snapshot(ctx.page);
    assert(!STALE_ERROR.test(snap.trendRange || ''), `不应出现常态错误文案，实际「${snap.trendRange}」`);
    log(`场景3 OK：3 条 uptime 全部回填成真 epoch，间隔 600s，无丢弃`);
    await finish(ctx.browser, ctx.page, '/tmp/soilpulse-e2e-s3.png', '场景3 首次出厂');
  } catch (e) { await closeOnFail(ctx, '/tmp/soilpulse-e2e-s3-fail.png'); throw e; }
}

// ───────── 场景 4：二次断电且中间从未连接 ─────────
{
  const U = 3600;
  const ctx = await start('场景4 二次断电未连接', [
    uptimeRec(600, 1, 40, 's1-a'), uptimeRec(1200, 1, 41, 's1-b'),
    uptimeRec(600, 2, 42, 's2-a'), uptimeRec(1200, 2, 43, 's2-b'),
    uptimeRec(U - 600, 3, 44, 's3-a'), uptimeRec(U, 3, 45, 's3-b'),
  ], { bootSeq: 3, uptimeNow: U });
  try {
    step('场景 4：会话 1/2 从未对时、会话 3 才第一次连接 → 旧记录丢弃 + 留痕');
    await connect(ctx.page, ctx.device);
    await waitCached(ctx.page, 2, '场景4');
    const got = await cachedTrend(ctx.page);
    assertSamePoints(got, ctx.device.historyView(), '场景4');
    assert(got.map((r) => r.temp).join(',') === '44,45',
      `网页只应显示当前会话 2 条，实际 ${got.map((r) => r.temp).join(',')}`);
    assert(ctx.device.droppedRecords.length === 4,
      `应丢弃 4 条跨断电旧记录，实际 ${ctx.device.droppedRecords.length}`);
    const droppedSessions = [...new Set(ctx.device.droppedRecords.map((r) => r.bootSeq))].sort();
    assert(droppedSessions.join(',') === '1,2',
      `留痕应标明来源会话 1/2，实际 ${droppedSessions.join(',')}`);
    assert(ctx.device.droppedRecords.every((r) => r.source === 'peer_sector'),
      '留痕应来自备用扇区残留');
    const snap = await snapshot(ctx.page);
    assert(!STALE_ERROR.test(snap.trendRange || ''),
      `旧会话已丢弃，网页不应再常态提示，实际「${snap.trendRange}」`);
    log(`场景4 OK：网页 2 点；hourly_unsynced.csv 口径留痕 4 条（会话 1/2）`);
    await finish(ctx.browser, ctx.page, '/tmp/soilpulse-e2e-s4.png', '场景4 二次断电未连接');
  } catch (e) { await closeOnFail(ctx, '/tmp/soilpulse-e2e-s4-fail.png'); throw e; }
}

// ───────── 场景 5：二次断电后再次连接（会话 1 曾对时） ─────────
{
  const U = 3600;
  const ctx = await start('场景5 二次断电后再次连接', [
    epochRec(now - 7200, 50, 's1-epoch-a'),
    epochRec(now - 6600, 51, 's1-epoch-b'),
    uptimeRec(1800, 1, 52, 's1-tail-unsynced'),
    uptimeRec(600, 2, 53, 's2-a'), uptimeRec(1200, 2, 54, 's2-b'),
    uptimeRec(U - 600, 3, 55, 's3-a'), uptimeRec(U, 3, 56, 's3-b'),
  ], { bootSeq: 3, uptimeNow: U });
  try {
    step('场景 5：曾对时的 epoch 保留、跨断电 uptime 丢弃、当前会话回填');
    await connect(ctx.page, ctx.device);
    await waitCached(ctx.page, 4, '场景5');
    const got = await cachedTrend(ctx.page);
    assertSamePoints(got, ctx.device.historyView(), '场景5');
    assert(got.map((r) => r.temp).join(',') === '50,51,55,56',
      `网页应为 2 条旧 epoch + 2 条新回填，实际 ${got.map((r) => r.temp).join(',')}`);
    assert(got[0].timestamp === now - 7200 && got[1].timestamp === now - 6600,
      '跨断电的已对时记录必须保留原时间戳，不回退不漂移');
    const sync = ctx.device.writes.find((w) => w.uuid.includes('ffe2'));
    const syncEpoch = sync.data.readUInt32LE(0);
    assert(got[2].timestamp === syncEpoch - 600 && got[3].timestamp === syncEpoch,
      '当前会话应按 now_epoch − U + u 精确回填');
    assert(ctx.device.droppedRecords.length === 3,
      `会话 1 尾部 + 会话 2 共 3 条应丢弃，实际 ${ctx.device.droppedRecords.length}`);
    const snap = await snapshot(ctx.page);
    assert(!STALE_ERROR.test(snap.trendRange || ''), `不应出现常态错误文案，实际「${snap.trendRange}」`);
    log(`场景5 OK：网页 4 点（2 保留 + 2 回填），丢弃 3 条；时间轴稳定无重复`);
    await finish(ctx.browser, ctx.page, '/tmp/soilpulse-e2e-s5.png', '场景5 二次断电再连接');
  } catch (e) { await closeOnFail(ctx, '/tmp/soilpulse-e2e-s5-fail.png'); throw e; }
}
