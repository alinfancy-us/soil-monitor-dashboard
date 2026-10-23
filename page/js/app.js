/* 【fix23】全局异常捕获：闪退/异常现场持久化到 localStorage，崩溃后下次加载可查。
 * 覆盖 window error + unhandledrejection，记录 OTA 阶段（ble-protocol.js 写 window.__otaStage）。
 * 环形保留最近 6 条防膨胀。必须置于一切业务代码之前注册。 */
(function () {
  'use strict';
  if (window.__soilCrashLogInstalled) return;
  window.__soilCrashLogInstalled = true;
  var KEY = 'soilpulse_crash_log_v1';
  function nowStage() {
    try { return window.__otaStage || 'idle'; } catch (e) { return '?'; }
  }
  function ringPush(rec) {
    try {
      var arr;
      try { arr = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { arr = []; }
      if (!Array.isArray(arr)) arr = [];
      arr.push(rec);
      if (arr.length > 6) arr = arr.slice(-6);
      localStorage.setItem(KEY, JSON.stringify(arr));
    } catch (e) { /* localStorage 不可用（隐私模式等）时静默 */ }
  }
  window.addEventListener('error', function (ev) {
    var rec = { t: Date.now(), type: 'error', msg: String(ev && ev.message || ''), src: ev && ev.filename || '', line: (ev && ev.lineno) || 0, stage: nowStage() };
    ringPush(rec);
    console.error('[CrashLog]', rec);
  });
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev && ev.reason;
    var msg = '';
    try { msg = (r && (r.message || (r.stack && String(r.stack).split('\n')[0]) || r.toString())) || String(r); } catch (e) { msg = String(r); }
    var rec = { t: Date.now(), type: 'unhandledrejection', msg: String(msg).slice(0, 500), stage: nowStage() };
    ringPush(rec);
    console.error('[CrashLog]', rec);
  });
  try {
    var arr = JSON.parse(localStorage.getItem(KEY) || '[]');
    if (Array.isArray(arr) && arr.length) {
      console.warn('[CrashLog] 上次会话闪退/异常记录 ' + arr.length + ' 条：', arr);
    }
  } catch (e) { /* ignore */ }
})();

/**
 * SoilPulse Dashboard Application UI Manager
 */
 (async () => {
   'use strict';

   // 页面加载完成后才启用 Connect 按钮（HTML 初始为 disabled，避免加载过程中被误点）
   window.addEventListener('load', () => {
     els.connectBtn.disabled = false;
     els.connectBtn.classList.remove('opacity-40', 'cursor-not-allowed');
   });
 
   // 集中配置统一取自 page/js/config.js，方便后续维护管理
   const {
     PAGE_VERSION,
     DEV_NAME_MAX_BYTES,
     DEVICE_NAME,
     DEBUG_ENABLED, POLL_ENABLED, POLL_INTERVAL,
     IDLE_WARN_MS, IDLE_GRACE_S,
     DASHBOARD_URL, BLUEFY_APPSTORE_URL, BLUEFY_DEEPLINK, BEACIO_APPSTORE_URL,
     DAILY_EPOCH_MIN_VALID, DAILY_EPOCH_MAX_VALID, TREND_EPOCH_MAX_VALID,
     CACHE_PREFIX, CACHE_MAX_ITEM_BYTES, CACHE_MAX_TOTAL_BYTES,
     FIRMWARE_MANIFEST_URL,
     TEMP_OFFSET,
} = SoilPulseConfig;
  // 中文：两张图（24h 趋势 / 7D·30D 日均）共用的绘图区内边距。
  //      之前各写一份（24h 上下 16/38、日均上下 8/22），切换 tab 时 X 轴刻度线会跳
  //      十几像素、绘图区高度也不一样，用户反馈"两个图大小不统一"（2026-10-22）。
  //      统一后：上沿留最新值标签的空间、下沿留一行时间/日期标签（约 9px + 6px 间隙）。
  //      左右两侧是"够放刻度就停"：手机上 10px 字号的刻度 "28.3" 实测约 21px，
  //      26px = 数字宽 21 + 5px 间隙；24h 是双轴（左温右湿）左右同宽，
  //      日均单轴右侧只需让末位日期标签（居中对齐）探出一半，14px 足够。
  //      （2026-10-22 再调：图高回到 224/240 后横向变挤，左右各从 34/24 收到 26/14，
  //        390px 视口下 24h 双轴绘图区净宽 236→252px，日均单轴 246→264px）
  const CHART_PAD_TOP = 12;
  const CHART_PAD_BOTTOM = 26;
  const CHART_PAD_LEFT_COMPACT = 26;
  const CHART_PAD_LEFT_WIDE = 34;      // 宽屏（≥420px）：刻度字号不变但留一点呼吸位
  const CHART_PAD_RIGHT_SINGLE = 14;   // 单轴视图（日均）右侧：够放末位日期标签即可
  // 中文：趋势图最大记录数 = 24h（10 分钟采样 × 144）。设备环 SOIL_HISTORY_MAX=144，
  //      前端缓存合并后同样按此封顶——更旧的记录由 30 天日均视图（0xFFE3）承担
  const TREND_MAX_RECORDS = 144;
  // 日均值本地最多留 30 条（0xFFED 一次能读 30 天）；画图按 state.dailyRange 再截
  const DAILY_MAX_RECORDS = 30;
  // 合并去重容差（秒）。设备每次连接都会用手机时间重新对时，对时基准刷新后同一采样
  // 记录的换算时间戳可能漂移 1~2 秒；按 timestamp 精确去重会漏判，缓存里就会堆出
  // 成对的"近似重复"并挤掉真正的历史。10 分钟采样间隔下 2 秒容差不会误合并相邻样本。
  const TREND_MERGE_TOLERANCE_S = 2;
  // 中文：24h 图的可视窗口跨度（秒）。144 条铺满一屏在手机上每条只摊到 1.6px，
  //      点挤成毛毛虫、最近几小时看不出走势——所以只画窗口内这一段，默认 6h（≈36 条）。
  //      缩放范围 30min ~ 24h：小于 30min 画不出趋势、大于 24h 没有数据可看。
  const TREND_VIEW_SPAN_DEFAULT = 6 * 3600;
  const TREND_VIEW_SPAN_MIN = 30 * 60;
  const TREND_VIEW_SPAN_MAX = 24 * 3600;
  // 中文：连接时 24h 历史"首屏只拉这么多条"，其余交给后台回填（见 startHistoryBackfill）。
  //      设备采样周期 600s，默认窗口 6h ≈ 36 条；+4 条余量吸收"最新一条不是刚刚"的空档，
  //      40 条 → 末页 20 + 前一页 20 = 2 页 = 4 个 GATT 事务（旧实现固定 8 页 16 个）。
  const HISTORY_TAIL_RECORDS = Math.ceil(TREND_VIEW_SPAN_DEFAULT / 600) + 4;
  // 中文：后台回填的页间停顿（ms）——每页单独抢一次全局 GATT 锁，中间让出去，
  //      5s 轮询探活与用户点按才有机会插进来，不至于被 8 页连续读写堵住。
  const HISTORY_BACKFILL_GAP_MS = 120;
  // 缓存 key 按设备唯一标识（device.id，Web Bluetooth 分配，浏览器内可视为等价 MAC）分区，
  // 避免连接不同土壤检测器时数据互相覆盖。lastDevice 指针用于刷新页面后自动回显上次设备的数据。
  const LAST_DEVICE_KEY = `${CACHE_PREFIX}lastDevice:v1`;
  const DEVICE_NAME_KEY = `${CACHE_PREFIX}devName:v1`;   // 最近一次连接的设备展示名（断开连接后仍展示）
  // 上一轮 OTA 已写入、但尚未经设备回报版本验证的记录（见 verifyPendingFwUpdate）。
  // 与 fwVer 缓存分开存：fwVer 只放"设备亲口报出的版本"，绝不放"我们希望它变成的版本"
  const PENDING_FW_TTL_MS = 7 * 24 * 3600 * 1000;   // 7 天未验证自动作废，避免陈旧记录长期误导
  const pendingFwKey = (deviceId) => `${CACHE_PREFIX}pendingFw:v1:${deviceId}`;   // 按设备分 key，互不覆盖
  const RECORD_KEY_RE = /^SoilPulse:(trend|daily):v1:/;  // 注意：与 CACHE_PREFIX='SoilPulse:' 大小写一致，否则容量清理匹配不到任何 key

  function cacheKey(type, deviceId) {
    return `${CACHE_PREFIX}${type}:v1:${deviceId}`;
  }

  // 中文：这里曾经有一套"清空水位（clearedAt）"机制——Clear / Factory reset 时记下时刻，
  //      之后凡是早于该时刻的缓存记录一律不画。已于 2026-10-22 移除，理由：
  //      ① 水位会误伤"设备 flash 里确实还在的数据"（重烧/换设备/测试固件灌数场景下，
  //         设备直读明明拉到了 30 天，页面却因为水位把它们藏了）；
  //      ② 它把 Clear 变成"删数据 + 记时间戳 + 到处过滤"三件事，排查成本很高。
  //      现在回到最朴素的语义：Clear = 删本地缓存 + 清内存 + 让设备自己清，
  //      清空后重连拉到什么就画什么（设备是数据权威）。历史遗留的 clearedAt key
  //      在 clearAllCache 里一并删掉（见下方 isDataKey）。

// 校准尝试结果 localStorage key：state 初始化（calibAttempt 恢复）在页面加载时就会调用
// loadCalibAttempts()，此声明必须早于该调用，否则落入 TDZ 被 try/catch 静默吞掉
const CALIB_ATTEMPT_KEY = 'soilpulse_calib_attempt_v1';

   const els = {
     statusDot: document.getElementById('statusDot'),
     statusText: document.getElementById('statusText'),
     connectBtn: document.getElementById('connectBtn'),
     clearCacheBtn: document.getElementById('clearCacheBtn'),
    calibDryBtn: document.getElementById('calibDryBtn'),
    calibWetBtn: document.getElementById('calibWetBtn'),
    calibStatus: document.getElementById('calibStatus'),
    calibDryBadge: document.getElementById('calibDryBadge'),
    calibWetBadge: document.getElementById('calibWetBadge'),
    calibDryMsg: document.getElementById('calibDryMsg'),
    calibWetMsg: document.getElementById('calibWetMsg'),
    refreshBtn: document.getElementById('refreshBtn'),
    refreshIcon: document.getElementById('refreshIcon'),
    refreshLabel: document.getElementById('refreshLabel'),
    connectErrorText: document.getElementById('connectErrorText'),
    otaProgressWrap: document.getElementById('otaProgressWrap'),
    otaProgressBar: document.getElementById('otaProgressBar'),
    otaStatus: document.getElementById('otaStatus'),
    otaRetryBtn: document.getElementById('otaRetryBtn'),
    otaUpdateHint: document.getElementById('otaUpdateHint'),
    otaNewVersion: document.getElementById('otaNewVersion'),
    otaCurrentVersionBadge: document.getElementById('otaCurrentVersionBadge'),
    otaUpdateNowBtn: document.getElementById('otaUpdateNowBtn'),
    otaChangelog: document.getElementById('otaChangelog'),
    otaChangelogList: document.getElementById('otaChangelogList'),
    settingUpdateDot: document.getElementById('settingUpdateDot'),
    settingLockedHint: document.getElementById('settingLockedHint'),
    settingContent: document.getElementById('settingContent'),
    tempOffsetInput: document.getElementById('tempOffsetInput'),
    tempOffsetUnitSpan: document.getElementById('tempOffsetUnitSpan'),
    tempOffsetDecBtn: document.getElementById('tempOffsetDecBtn'),
    tempOffsetIncBtn: document.getElementById('tempOffsetIncBtn'),
    tempOffsetApplyBtn: document.getElementById('tempOffsetApplyBtn'),
    tempOffsetStatus: document.getElementById('tempOffsetStatus'),
    tempOffsetScaleMin: document.getElementById('tempOffsetScaleMin'),
    tempOffsetScaleMax: document.getElementById('tempOffsetScaleMax'),
    factoryResetBtn: document.getElementById('factoryResetBtn'),
    factoryResetStatus: document.getElementById('factoryResetStatus'),
    idlePrompt: document.getElementById('idlePrompt'),
    idleCountdown: document.getElementById('idleCountdown'),
    idleKeepBtn: document.getElementById('idleKeepBtn'),
    idleSleepBtn: document.getElementById('idleSleepBtn'),
     tempValue: document.getElementById('tempValue'),
     tempUnitLabel: document.getElementById('tempUnitLabel'),
     tempUnitToggle: document.getElementById('tempUnitToggle'),
     humValue: document.getElementById('humValue'),
     battValue: document.getElementById('battValue'),
     battPill: document.getElementById('battPill'),
     lastUpdate: document.getElementById('lastUpdate'),
     historyBody: document.getElementById('historyBody'),
     trendChart: document.getElementById('trendChart'),
    trendRangeText: document.getElementById('trendRangeText'),
     trendLatestBtn: document.getElementById('trendLatestBtn'),
     trendTabBtn: document.getElementById('trendTabBtn'),
     trendTabPanel: document.getElementById('trendTabPanel'),
     dailyTabPanel: document.getElementById('dailyTabPanel'),
    dailyMetricTempBtn: document.getElementById('dailyMetricTempBtn'),
    dailyMetricHumBtn: document.getElementById('dailyMetricHumBtn'),
    dailyMetricBattBtn: document.getElementById('dailyMetricBattBtn'),
    dailyRange7Btn: document.getElementById('dailyRange7Btn'),
    dailyRange30Btn: document.getElementById('dailyRange30Btn'),
    dailyEmpty: document.getElementById('dailyEmpty'),
    dailyNote: document.getElementById('dailyNote'),
    dailyExtNote: document.getElementById('dailyExtNote'),
    dailyRangeCard: document.getElementById('dailyRangeCard'),
    dailyRangeLabel: document.getElementById('dailyRangeLabel'),
    dailyRangeValue: document.getElementById('dailyRangeValue'),
    dailyRangeUnit: document.getElementById('dailyRangeUnit'),
    dailyRangeDate: document.getElementById('dailyRangeDate'),
     modal: document.getElementById('compatibilityModal'),
     modalIcon: document.getElementById('modalIcon'),
     modalTitle: document.getElementById('modalTitle'),
     modalMessage: document.getElementById('modalMessage'),
     modalActionBtn: document.getElementById('modalActionBtn'),
     dailyChart: document.getElementById('dailyChart'),
     mainTabDataBtn: document.getElementById('mainTabDataBtn'),
     mainTabGuideBtn: document.getElementById('mainTabGuideBtn'),
     mainTabSettingBtn: document.getElementById('mainTabSettingBtn'),
     mainTabDataPanel: document.getElementById('mainTabDataPanel'),
     mainTabSettingPanel: document.getElementById('mainTabSettingPanel'),
     mainTabGuidePanel: document.getElementById('mainTabGuidePanel'),
     pageVersion: document.getElementById('pageVersion'),
     deviceNameText: document.getElementById('deviceNameText'),
     devNameInput: document.getElementById('devNameInput'),
     devNameSaveBtn: document.getElementById('devNameSaveBtn'),
     devNameByteCount: document.getElementById('devNameByteCount'),
     devNameStatus: document.getElementById('devNameStatus'),
   };
 
   const state = {
     device: null,
     activeDeviceId: null,
     characteristic: null,
     dailyChar: null,
     daily30Char: null,
     daily30ExtChar: null,   // 0xFFEE 30 天温度极值（相对均值的 0.1℃ 偏移），按 dateEpoch join 到 0xFFED
     dailyRange: 7,   // 日均图显示天数：7 或 30（0xFFED 有数据时才能选 30）
     resetChar: null,
    calibChar: null,
    refreshChar: null,
    latestChar: null,
    latestShown: null,   // "Latest measurement" 卡片当前展示的记录（时间戳水位），防止被更旧的历史数据覆盖
    tempOffsetChar: null,
    tempOffsetX100: 0,   // 设备 0xFFE8 原值：小端 int16，单位 0.01℃（±1000 = ±10.00℃），不是 0.1℃
    calibStatusChar: null,
    calibSaved: null,
    devNameChar: null,
    otaChar: null,
    otaRunning: false,
    otaLastFirmware: null,
    otaJustSucceeded: false,   // 中文：OTA 刚成功（设备重启断链）——断链清理时保留 Setting 页展示成功提示
    idleTimer: null,           // 180s 无续命 → 弹"保持连接"提醒
    idleTickTimer: null,       // 弹窗里的 30s 倒计时
    idleLeft: 0,
    idleSleepExpected: false,  // 预期内的休眠断链（倒计时归零 / 用户点 Let it sleep）——用于区分"省电断开"与"真故障"
    fwVersion: null,
    fwUpdate: null,
     pollTimer: null,
     gattBusy: false,   // 中文：全局 GATT 互斥锁——安卓 Chrome 蓝牙栈同一时刻只允许一个 in-flight
                        // GATT 操作（不排队，重叠直接抛 "already in progress"/133），因此轮询、
                        // Refresh 轮询、各按钮写必须共用这把锁串行化；iOS/PC 本身会排队，加锁无害
     disconnecting: false,   // 中文：onDisconnected 重入保护——断链事件/轮询/forceDisconnect 可能并发触发
     calibAttempt: loadCalibAttempts(),   // 中文：各校准点最近一次尝试结果（localStorage 持久化，刷新后仍生效）
     lastRecords: null,
     lastDailyRecords: null,
     lastNotifiedRec: null,       // 最近一次 0xFFEB notify 收到的测量（固件主动推送，不占 GATT 锁）
     latestNotifySubscribed: false, // latest 特征 notify 是否已订阅成功（失败回退轮询读）
     dailyMetric: 'temp',
     tempUnit: 'F',
     // 中文：24h 图 x 轴可视窗口。endTs=右边界（null 表示跟随最新），
     //      spanSec=窗口跨度，follow=true 时每次重画都把右边界钉在最新一条上。
     trendView: { endTs: null, spanSec: TREND_VIEW_SPAN_DEFAULT, follow: true },
     // 中文：24h 历史"已拉到哪儿"的回填态（0xFFEC 分块读）。
     //      oldestOffset = 已拿到的最旧一条的逻辑序号（0 = 已到设备最旧）；
     //      oldestTs 供"还差多少"诊断用；unsupported = 旧固件不认末页哨兵。
     //      整对象替换而不是逐字段改：后台回填循环用对象身份判断"这一轮是否还有效"。
     historyBackfill: { oldestOffset: 0, oldestTs: 0, total: 0, running: false, unsupported: false },
     trendGeom: null,   // 上一帧 24h 图的几何（窗口区间/内边距），手势层与范围文案共用
   };

   // 温度单位偏好：默认华氏（°F，美国常用），可在温度卡片切换摄氏（°C），持久化到本地
   try {
     state.tempUnit = localStorage.getItem(`${CACHE_PREFIX}tempUnit:v1`) === 'C' ? 'C' : 'F';
     // 日均图显示范围偏好（7D / 30D）；真到渲染时还会再校验固件是否支持 0xFFED
     state.dailyRange = localStorage.getItem(`${CACHE_PREFIX}dailyRange:v1`) === '30' ? 30 : 7;
     // 启动时恢复最近一次连接的设备展示名（未连接也展示，见 showDeviceNameBadge）
     showDeviceNameBadge(localStorage.getItem(DEVICE_NAME_KEY) || '');
   } catch (_) {
     state.tempUnit = 'F';
   }

   function cToF(c) { return (c * 9 / 5) + 32; }
   function tempUnitSymbol() { return state.tempUnit === 'F' ? '°F' : '°C'; }
   function tempVal(c) { return state.tempUnit === 'F' ? cToF(c) : c; }
   function fmtTemp(c, decimals = 1) { return `${tempVal(c).toFixed(decimals)}${tempUnitSymbol()}`; }
   // 温差（偏移量）换算：℃→℉ 只乘 9/5、不加 32（偏移是差值不是绝对温度），保证单位切换时与设备 0.1℃ 内部单位计算一致
   function tempDeltaVal(deltaC) { return state.tempUnit === 'F' ? deltaC * 9 / 5 : deltaC; }
   function tempDeltaSymbol() { return state.tempUnit === 'F' ? '°F' : '℃'; }
   function fmtTempDelta(deltaC, decimals = 1) { return `${tempDeltaVal(deltaC).toFixed(decimals)} ${tempDeltaSymbol()}`; }

   // 温度极值风险阈值（℃ 为内部真值，绘制/文案时再经 tempVal 换到当前显示单位）：
   //   霜冻：日最低 ≤ 2℃ —— 这是"土壤温度"不是气温，≤2℃ 时根区已临近冰点，
   //         浅根/幼苗开始受害。别用 5℃：温带春秋季常态夜温就常在 3~5℃，
   //         阈值太宽会让大半年天天亮蓝点，标记失去信息量
   //   热害：日最高 ≥ 35℃ —— 常见作物光合开始受阻、土壤表层失水陡增
   const DAILY_FROST_C = 2;
   const DAILY_HEAT_C = 35;


   const DAILY_METRICS = {
     temp: {
       key: 'temp',
       title: 'Temperature',
       color: '#f59e0b',
       // 按钮"卡片切换"样式：选中=线色填充白字（-600 深一档保证对比度），未选=同色浅底。
       // 与顶部 24h/7D/30D 的中性灰分段控件拉开层次，且按钮颜色即图线颜色的映射
       onCls: 'bg-amber-600 text-white shadow-sm',
       offCls: 'bg-amber-50 text-amber-700 hover:bg-amber-100',
       formatValue: v => `${v.toFixed(1)}${tempUnitSymbol()}`,
       axisFormatter: v => v.toFixed(1),
       range: null,
       button: 'dailyMetricTempBtn',
     },
     hum: {
       key: 'hum',
       title: 'Moisture',
       color: '#0ea5e9',
       onCls: 'bg-sky-600 text-white shadow-sm',
       offCls: 'bg-sky-50 text-sky-700 hover:bg-sky-100',
       formatValue: v => `${v.toFixed(1)}%`,
       axisFormatter: v => v.toFixed(0),
       range: [0, 100],
       button: 'dailyMetricHumBtn',
     },
     batt: {
       key: 'battPercent',
       title: 'Battery',
       color: '#10b981',
       onCls: 'bg-emerald-600 text-white shadow-sm',
       offCls: 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100',
       formatValue: v => `${v.toFixed(0)}%`,
       axisFormatter: v => v.toFixed(0),
       // 中文：电量不要再固定 0~100 轴。2 节干电池满量程 1000mV 对应 100%，
       //      30 天通常只掉 1~3%，钉死在 0~100 上会画成一条水平线，看不出变化；
       //      改自动量程（niceRange 会留 20% 余量），边界夹在 0~100，最小跨度 4%
       //      以免把 1% 的量化台阶放大成断崖。
       range: null,
       bounds: [0, 100],
       minSpan: 4,
       button: 'dailyMetricBattBtn',
     },
   };
 
 
   const LOG_T0 = Date.now();   // 中文：日志相对时间基准（页面加载时刻），方便排查"操作后多少 ms 断链"
   function log(msg) {
     if (!DEBUG_ENABLED) return;
     const dt = ((Date.now() - LOG_T0) / 1000).toFixed(1);
     console.debug(`[SoilPulse +${dt}s] ${msg}`);
   }
 
   // customText 用于区分断开原因（如"设备省电休眠"与"真故障"），不传则用默认文案
   function setStatus(mode, customText) {
     const map = {
       disconnected: ['bg-slate-300', 'Disconnected', false],
       connecting:   ['bg-amber-400', 'Connecting…', true],
       connected:    ['bg-emerald-500', 'Connected', true],
     };
     const [dot, text, active] = map[mode];
     els.statusDot.className = `w-3 h-3 rounded-full ${dot}`;
     els.statusText.textContent = customText || text;
    els.deviceNameText.classList.toggle('dev-name-idle', mode === 'disconnected');
    els.calibStatus.style.color = '';
     els.connectBtn.textContent = mode === 'connected' ? 'Disconnect' : 'Connect';
     const connected = mode === 'connected';
    els.calibDryBtn.disabled = !connected;
    els.calibWetBtn.disabled = !connected;
    els.calibStatus.textContent = connected
      ? 'Place the probe, wait a few seconds, then tap dry or wet calibration'
      : 'Connect device to enable calibration';
    els.refreshBtn.disabled = !connected;
    els.clearCacheBtn.disabled = !connected;
    updateSettingsAccess(connected);
    if (state.otaRunning) {
      setOtaUiLock(true);
    }
   }

   // Setting 面板仅连接后可操作；未连接时锁定 Tab 并切回 Data（若正停留在 Setting）。
   // 例外：OTA 刚成功（设备重启断链）时保留 Setting 页与固件卡片可见，让用户看到成功提示，
   //       直到用户主动切走或下次连接才恢复默认行为
   function updateSettingsAccess(connected) {
     if (connected) state.otaJustSucceeded = false;   // 重新连接：成功提示展示期结束
     els.mainTabSettingBtn.disabled = !connected;
     els.settingLockedHint.classList.toggle('hidden', connected || state.otaJustSucceeded);
     els.settingContent.classList.toggle('hidden', !connected && !state.otaJustSucceeded);
     if (!connected && !state.otaJustSucceeded && !els.mainTabSettingPanel.classList.contains('hidden')) {
       switchMainTab('data');
     }
     els.tempOffsetInput.disabled = !connected || !state.tempOffsetChar;
     els.tempOffsetDecBtn.disabled = !connected || !state.tempOffsetChar;
     els.tempOffsetIncBtn.disabled = !connected || !state.tempOffsetChar;
     els.tempOffsetApplyBtn.disabled = !connected || !state.tempOffsetChar;
     els.factoryResetBtn.disabled = !connected || !state.resetChar;
     if (!connected) {
       els.tempOffsetStatus.textContent = 'Connect device to adjust temperature offset';
       els.factoryResetStatus.textContent = 'Connect device to reset';
     }
   }


  function setOtaUiLock(lock) {
    const connected = !!state.device?.gatt.connected;

    els.connectBtn.disabled = lock;
    els.connectBtn.classList.toggle('opacity-40', lock);
    els.connectBtn.classList.toggle('cursor-not-allowed', lock);

    els.clearCacheBtn.disabled = lock || !connected;
    els.refreshBtn.disabled = lock || !connected;
    els.calibDryBtn.disabled = lock || !connected;
    els.calibWetBtn.disabled = lock || !connected;
    els.otaUpdateNowBtn.disabled = lock || !connected || !state.fwUpdate;
    els.tempOffsetInput.disabled = lock || !connected || !state.tempOffsetChar;
    els.tempOffsetDecBtn.disabled = lock || !connected || !state.tempOffsetChar;
    els.tempOffsetIncBtn.disabled = lock || !connected || !state.tempOffsetChar;
    els.tempOffsetApplyBtn.disabled = lock || !connected || !state.tempOffsetChar;
    els.factoryResetBtn.disabled = lock || !connected || !state.resetChar;
    els.mainTabSettingBtn.disabled = lock || !connected;
    // 中文：OTA 升级进行中锁定全部主 Tab（Data/Guide 置灰 + switchMainTab 守卫双保险），
    //       防止升级链路被页面切换后的 UI 更新（图表重绘等）干扰，用户保持在 Setting 升级页
    els.mainTabDataBtn.disabled = lock;
    els.mainTabGuideBtn.disabled = lock;
    els.mainTabDataBtn.classList.toggle('opacity-40', lock);
    els.mainTabDataBtn.classList.toggle('cursor-not-allowed', lock);
    els.mainTabGuideBtn.classList.toggle('opacity-40', lock);
    els.mainTabGuideBtn.classList.toggle('cursor-not-allowed', lock);

    if (lock) {
      els.statusDot.className = 'w-3 h-3 rounded-full bg-violet-500';
      els.statusText.textContent = 'Updating firmware…';
      els.calibStatus.textContent = 'Firmware update in progress, calibration is temporarily disabled';
    }
  }

  // 连接/断开过程锁定 Connect 按钮：连接建立中或断开进行中置灰，避免过程中重复点击
  function setConnectBusy(busy) {
    els.connectBtn.disabled = busy;
    els.connectBtn.classList.toggle('opacity-40', busy);
    els.connectBtn.classList.toggle('cursor-not-allowed', busy);
  }

  // 失败后才露出重试按钮；hidden 与 flex 互斥，需成对切换
  function setOtaRetryVisible(show) {
    els.otaRetryBtn.classList.toggle('hidden', !show);
    els.otaRetryBtn.classList.toggle('inline-flex', show);
  }
 
    function formatTime(epoch) {
      if (!epoch) return 'Time not synchronized';
      const d = new Date(epoch * 1000);
      const pad = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

     function formatShortTime(epoch) {
       if (!epoch) return '--';
       const d = new Date(epoch * 1000);
       const pad = n => String(n).padStart(2, '0');
       return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
     }

     function formatMonthDay(epoch) {
       if (!epoch) return '--/--';
       const d = new Date(epoch * 1000);
       const pad = n => String(n).padStart(2, '0');
       // Daily records use midnight epoch; use UTC fields to avoid timezone date shift.
       return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
     }

     function isMobileViewport() {
       return window.matchMedia('(max-width: 640px)').matches;
     }

   function sanitizeDailyRecords(records, max = DAILY_MAX_RECORDS) {
     if (!Array.isArray(records)) return [];
     return records
       .filter((r) => Number.isFinite(r?.dateEpoch)
         && r.dateEpoch >= DAILY_EPOCH_MIN_VALID
         && r.dateEpoch <= DAILY_EPOCH_MAX_VALID)
      .sort((a, b) => a.dateEpoch - b.dateEpoch)
      .slice(-max);
   }

// 中文：按"本地 0 点 epoch"精确合并两路日均值（0xFFED 的 30 天 + 0xFFE3 的 7 天）。
 //       dateEpoch 是天索引×86400，不存在秒级漂移，直接按值去重即可；
 //       同一日期以 extra（0xFFE3，RAM 环）为准——它更新更及时。
 function mergeDailyRecords(base, extra) {
   const byDay = new Map();
   (Array.isArray(base) ? base : []).forEach((r) => {
     if (Number.isFinite(r?.dateEpoch)) byDay.set(r.dateEpoch, r);
   });
   (Array.isArray(extra) ? extra : []).forEach((r) => {
     if (Number.isFinite(r?.dateEpoch)) byDay.set(r.dateEpoch, r);
   });
   return Array.from(byDay.values()).sort((a, b) => a.dateEpoch - b.dateEpoch);
 }

// 中文：把 0xFFEE 的温度极值按 dateEpoch 挂到日均记录上（值 = 相对当日均值的 0.1℃ 偏移）。
//       挂在记录上而不是另存一张 Map：sanitizeDailyRecords 只做过滤/排序/截断、保留整条对象，
//       所以极值能跟着日均缓存一起持久化，切 7D/30D、重绘、离线看缓存时都还在。
//       旧固件记录（0xFFEE 缺失或 0x80=UNKNOWN）不挂字段，渲染侧按"无极值"处理。
 function attachDailyExt(records, extMap) {
   if (!extMap || !extMap.size || !Array.isArray(records)) return records;
   records.forEach((r) => {
     const ext = extMap.get(r?.dateEpoch);
     if (!ext || ext.tempMinD10 == null || ext.tempMaxD10 == null) return;
     r.tempMinD10 = ext.tempMinD10;
     r.tempMaxD10 = ext.tempMaxD10;
   });
   return records;
 }

 function sanitizeTrendRecords(records) {
   if (!Array.isArray(records)) return [];
   return records
     .map((r) => ({
       timestamp: Number(r?.timestamp),
       temp: Number(r?.temp),
       hum: Number(r?.hum),
       batt: Number(r?.batt),
     }))
     .filter((r) => Number.isFinite(r.timestamp)
       && r.timestamp > 0
       && r.timestamp <= TREND_EPOCH_MAX_VALID
       && Number.isFinite(r.temp)
       && r.temp > -80
       && r.temp < 120
       && Number.isFinite(r.hum)
       && r.hum >= 0
       && r.hum <= 100
       && Number.isFinite(r.batt)
       && r.batt >= 0
       && r.batt <= 100)
     .sort((a, b) => a.timestamp - b.timestamp)
     .slice(-TREND_MAX_RECORDS);
 }

 // 中文：按 timestamp 去重合并（base 在前、增量在后；同一时刻以增量为准——
 //      设备新读出的记录覆盖缓存旧值）。供 render() 把轮询/通知的 5 条增量
 //      并回 24h 大缓存用，避免每次小更新把缓存覆盖成只剩 5 条
 function mergeTrendRecords(base, extra) {
   // 先按时间排序，再做"近邻合并"：时间差 ≤ TREND_MERGE_TOLERANCE_S 视为同一条，
   // 保留后出现的那条（extra 里的设备实时值优先覆盖缓存）。不能按 timestamp 建 Map
   // 精确去重——对时基准每次连接会刷新，同一采样可能漂移 1~2 秒，精确匹配会漏判。
   const all = [];
   (Array.isArray(base) ? base : []).forEach((r) => {
     if (Number.isFinite(r?.timestamp)) all.push(r);
   });
   (Array.isArray(extra) ? extra : []).forEach((r) => {
     if (Number.isFinite(r?.timestamp)) all.push(r);
   });
   all.sort((a, b) => a.timestamp - b.timestamp);
   const out = [];
   for (const r of all) {
     const last = out[out.length - 1];
     if (last && Math.abs(r.timestamp - last.timestamp) <= TREND_MERGE_TOLERANCE_S) {
       out[out.length - 1] = r;
     } else {
       out.push(r);
     }
   }
   return out;
 }

  // 浏览器本地缓存：保存最近图表数据，确保下次打开无需连接也能直接查看。
  function byteSize(text) {
    return new TextEncoder().encode(String(text)).length;
  }

  function getCacheSavedAt(raw) {
    try {
      const parsed = JSON.parse(raw);
      return Number(parsed?.savedAt) || 0;
    } catch (_) {
      return 0;
    }
  }

  // 当所有设备缓存总量超过 512KB 时，按时间从旧到新删除，保证新数据优先保留。
  function pruneCacheIfOversized() {
    const entries = Object.keys(localStorage)
      .filter((key) => RECORD_KEY_RE.test(key))
      .map((key) => {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        return {
          key,
          raw,
          size: byteSize(raw),
          savedAt: getCacheSavedAt(raw),
        };
      })
      .filter(Boolean);

    let total = entries.reduce((sum, it) => sum + it.size, 0);
    if (total <= CACHE_MAX_TOTAL_BYTES) return;

    entries.sort((a, b) => a.savedAt - b.savedAt);
    for (const entry of entries) {
      if (total <= CACHE_MAX_TOTAL_BYTES) break;
      localStorage.removeItem(entry.key);
      total -= entry.size;
      log(`Cache pruned: removed ${entry.key}`);
    }
  }

  function readJsonCache(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      if (byteSize(raw) > CACHE_MAX_ITEM_BYTES) {
        localStorage.removeItem(key);
        log(`Cache dropped (oversized item): ${key}`);
        return null;
      }
      pruneCacheIfOversized();
      return JSON.parse(raw);
    } catch (err) {
      localStorage.removeItem(key);
      log(`Cache read failed: ${err.message}`);
      return null;
    }
  }

  function writeJsonCache(key, payload) {
    try {
      const raw = JSON.stringify(payload);
      if (byteSize(raw) > CACHE_MAX_ITEM_BYTES) {
        localStorage.removeItem(key);
        log(`Cache dropped (oversized payload): ${key}`);
        return;
      }
      localStorage.setItem(key, raw);
      pruneCacheIfOversized();
    } catch (err) {
      pruneCacheIfOversized();
      log(`Cache write failed: ${err.message}`);
    }
  }

  // 记录最近一次连接的设备（id + 展示名），刷新页面后可免连接直接回显该设备数据。
  function getLastDeviceId() {
    try {
      const raw = localStorage.getItem(LAST_DEVICE_KEY);
      if (!raw) return null;
      return JSON.parse(raw)?.id || null;
    } catch (_) {
      return null;
    }
  }

  function setLastDevice(deviceId, deviceName) {
    try {
      localStorage.setItem(LAST_DEVICE_KEY, JSON.stringify({ id: deviceId, name: deviceName || '', savedAt: Date.now() }));
    } catch (err) {
      log(`Save last device failed: ${err.message}`);
    }
  }

  // 按设备缓存最近一次确认的固件版本：版本读取成功 / OTA 升级成功时写入；
  // 读取失败（DIS 0x2A26 偶发失败）时回退用缓存值参与更新比对，
  // 避免已升到最新的设备因“版本未知”被反复提示升级
  function getCachedFwVersion(deviceId) {
    try {
      return localStorage.getItem(`${CACHE_PREFIX}fwVer:${deviceId}`) || null;
    } catch (_) {
      return null;
    }
  }

  function setCachedFwVersion(deviceId, version) {
    if (!deviceId || !version) return;
    try {
      localStorage.setItem(`${CACHE_PREFIX}fwVer:${deviceId}`, version);
    } catch (_) {}
  }

  // —— OTA 结果验证闭环 ——
  // 固件返回 SUCCESS 的语义是"回读 CRC32 通过 + boot mark 已切"，只证明写进去了，
  // 不证明新固件能跑起来：新固件若初始化失败，bootctl 会在几次非预期复位后把另一个槽
  // 恢复成 KNLT 并复位过去，设备最终跑的是旧版本。
  // 因此升级成功时不把目标版本写进 state.fwVersion / fwVer 缓存（那是"期望"不是"事实"），
  // 只记一条待验证；下次连上读到 DIS 0x2A26 的设备自报版本后再比对，一致才算真成功。
  function setPendingFwVerify(deviceId, version) {
    if (!deviceId || !version) return;
    try {
      localStorage.setItem(pendingFwKey(deviceId), JSON.stringify({ version, at: Date.now() }));
    } catch (_) {}
  }

  function getPendingFwVerify(deviceId) {
    if (!deviceId) return null;
    const key = pendingFwKey(deviceId);
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const p = JSON.parse(raw);
      if (!p || !p.version) return null;
      if (!p.at || Date.now() - p.at > PENDING_FW_TTL_MS) {
        localStorage.removeItem(key);   // 过期作废
        return null;
      }
      return p;
    } catch (_) {
      return null;
    }
  }

  function clearPendingFwVerify(deviceId) {
    if (!deviceId) return;
    try {
      localStorage.removeItem(pendingFwKey(deviceId));
    } catch (_) {}
  }

  /**
   * 重连后校验上一轮升级是否真的生效。
   * 必须在 state.fwVersion 已按 DIS 结果赋值、且 OTA 状态区已清空之后调用：
   * 回滚场景下 checkFirmwareUpdate 会用设备真实（旧）版本重新比对清单，自动重新提示升级。
   * @param {string} deviceId        当前设备 id
   * @param {string|null} reportedVersion 固件 DIS 0x2A26 自报版本（读取失败为 null）
   */
  function verifyPendingFwUpdate(deviceId, reportedVersion) {
    const pending = getPendingFwVerify(deviceId);
    if (!pending) return;

    // DIS 读失败：无从判定，保留记录等下次连接（TTL 兜底），宁可晚确认也不误报
    if (!reportedVersion) {
      log(`[OTA] update not verified yet: DIS read failed (expected v${pending.version}), retry next connect`);
      return;
    }

    clearPendingFwVerify(deviceId);
    // 归一化后比较：容忍 DIS 里的前导 v/V 与空白差异（两边的值来自同一个 CI 版本号，
    // 只需抵御格式噪声；不能用 compareVersions——它会把 dev 的 commit hash 也解析成数字）
    const norm = (v) => String(v || '').trim().replace(/^[vV]/, '');
    if (norm(reportedVersion) === norm(pending.version)) {
      log(`[OTA] update verified: device reports v${reportedVersion}`);
      return;
    }

    // 设备自报版本 ≠ 刚写入的版本 → 新固件没起来（大概率被 bootctl 回滚到另一个槽）。
    // state.fwVersion / fwVer 缓存此时已是设备真实版本，升级提示会重新出现。
    els.otaStatus.textContent =
      `Update did not take effect — device still reports v${reportedVersion} (expected v${pending.version}). Please retry.`;
    els.otaStatus.className = 'text-xs font-medium text-rose-600';
    setOtaRetryVisible(true);
    log(`[OTA] UPDATE NOT APPLIED: wrote v${pending.version} but device reports v${reportedVersion} — likely rolled back by bootctl`);
  }

  // 设备展示名徽章：设置文字并显示，同时持久化到 localStorage——断开连接、刷新页面后
  // 仍展示最近一次连接的设备名（需求：disconnect 时不隐藏设备名）
  function showDeviceNameBadge(name) {
    if (!els.deviceNameText || !name) return;
    els.deviceNameText.textContent = name;
    els.deviceNameText.classList.remove('hidden');
    els.deviceNameText.classList.toggle('dev-name-idle', !state.device?.gatt.connected);
    try {
      localStorage.setItem(DEVICE_NAME_KEY, name);
    } catch (_) {}
  }

  // 清除设备名徽章及本地持久化（仅工厂复位使用：设备端名字已被擦除，徽章不应残留旧名）
  function clearDeviceNameBadge() {
    try {
      localStorage.removeItem(DEVICE_NAME_KEY);
    } catch (_) {}
    if (els.deviceNameText) {
      els.deviceNameText.textContent = '';
      els.deviceNameText.classList.add('hidden');
    }
  }

  function loadCachedTrendRecords(deviceId) {
    if (!deviceId) return [];
    const cache = readJsonCache(cacheKey('trend', deviceId));
    return sanitizeTrendRecords(cache?.records);
  }

  function loadCachedDailyRecords(deviceId) {
    if (!deviceId) return [];
    const cache = readJsonCache(cacheKey('daily', deviceId));
    return sanitizeDailyRecords(cache?.records);
  }

  function saveTrendRecordsCache(records, deviceId) {
    if (!records?.length || !deviceId) return;
    writeJsonCache(cacheKey('trend', deviceId), {
      version: 1,
      savedAt: Date.now(),
      records,
    });
  }

  function saveDailyRecordsCache(records, deviceId) {
    if (!records?.length || !deviceId) return;
    writeJsonCache(cacheKey('daily', deviceId), {
      version: 1,
      savedAt: Date.now(),
      records,
    });
  }

  // 电量胶囊高亮状态：仅"已连接且本会话拿到过实时数据"才绿色高亮。
  // 首屏会用本地缓存回显历史（restoreCachedCharts → render），若不区分连接态，
  // 未连接的页面也会显示"电量 100%"绿色高亮误导用户；断开时保留最后一次读数仅灰显，
  // 与温度/湿度卡保留最后读数的行为一致。
  // 【低电】batt===0 且已连接 → 红色 + 明确文案。固件侧 0% 是"真实低电正常返回"
  //   （不是测量失败），所以这里可以放心把 0 当成"该换电池了"处理；
  //   未连接时不提示，避免缓存回显的旧 0% 造成误报。
  function syncBatteryPill() {
    const connected = !!(state.device?.gatt.connected && state.latestShown);
    const low = connected && Number(state.latestShown?.batt) === 0;
    els.battPill?.classList.toggle('batt-idle', !connected);
    els.battPill?.classList.toggle('batt-low', low);
    if (els.battPill) {
      const label = low ? 'Battery empty — replace batteries' : 'Battery level';
      els.battPill.setAttribute('aria-label', label);
      els.battPill.title = low ? '电量耗尽，请更换电池（低于 2.2V 触摸功能将失效）' : '';
    }
  }

  // 清空 live 展示区（切换到另一台设备、或没有该设备缓存时，避免继续显示上一台设备的数据）。
  function resetDisplay() {
    state.lastRecords = null;
    state.latestShown = null;
    state.lastDailyRecords = null;
    // 中文：24h 回填态一并复位——换设备/清空后不能沿用上一台的"已拉到第几页"，
    //      否则后台回填会拿旧的 oldestOffset 去翻新设备的环（张冠李戴）。
    //      换对象而不是改字段：后台回填循环用对象身份判活（见 startHistoryBackfill）。
    state.historyBackfill = { oldestOffset: 0, oldestTs: 0, total: 0, running: false, unsupported: false };
    // 中文：可视窗口一并复位——否则换设备/清空后仍停在上一台的"拖到 8 小时前"位置，
    //      新数据进来只会在窗口外，图上一片空白，看起来像清空没成功
    state.trendView = { endTs: null, spanSec: TREND_VIEW_SPAN_DEFAULT, follow: true };
    state.trendGeom = null;
    if (els.trendChart) els.trendChart._trendLayout = null;
    syncTrendLatestChip();
    els.tempValue.textContent = '--';
    els.humValue.textContent = '--';
    els.battValue.textContent = '--';
    syncBatteryPill();
    els.lastUpdate.textContent = 'No measurement received yet';
    els.historyBody.innerHTML = '<tr><td colspan="5" class="py-6 text-center text-slate-300">Connect device to view history</td></tr>';
    updateTrendSummary(null);
    const trendCtx = els.trendChart?.getContext('2d');
    if (trendCtx) trendCtx.clearRect(0, 0, els.trendChart.width, els.trendChart.height);
    renderDaily([]);
  }

  // 设备名不做本地缓存：页内展示直接使用浏览器连接对象自带的名字（device.name），
  // 不通过 GAP 服务读取设备名

  // 加载指定设备（device.id）自己的历史缓存并回显到图表/表格。
  // 缓存里有什么就画什么：清空动作（Clear / Factory reset）已经把缓存删干净了，
  // 不需要再按时间戳二次判断"这条是不是清空前的残留"（2026-10-22 移除清空水位）。
  function restoreCachedCharts(deviceId) {
    const trendRecords = loadCachedTrendRecords(deviceId);
    if (trendRecords.length) {
      render(trendRecords);
      log(`Loaded cached trend records: ${trendRecords.length}`);
    }

    const dailyRecords = loadCachedDailyRecords(deviceId);
    if (dailyRecords.length) {
      renderDaily(dailyRecords);
      log(`Loaded cached daily records: ${dailyRecords.length}`);
    }
  }

  // 中文：把设备读回的 24h 记录并进现有数据后整表重画。
  //      先 merge 缓存再判断空：设备读回 0 条（或全是无时间戳的记录）时也要让 render 走一遍，
  //      否则界面停在连接前的样子，既没提示也看不出这次到底拉没拉到。
  function applyHistoryRecords(devRecords) {
    const merged = mergeTrendRecords(loadCachedTrendRecords(state.activeDeviceId), devRecords || []);
    render(merged.length ? merged : (devRecords || []));
  }

  // 中文：后台回填更旧的 24h 分块（0xFFEC）。
  //      为什么要有它：首屏只拉了末页附近 ~6.7h（4 个 GATT 事务），更早的分块不能等用户
  //      拖到那儿再现场拉（拖动是连续的，一卡就是几百毫秒）。这里在连接流程返回后
  //      一页一页往前补，每页单独抢一次全局 GATT 锁、页间让出 120ms，
  //      5s 轮询探活与用户点按都能插进来。
  //      停止条件：拉到设备最旧一条（oldestOffset=0）/ 断链 / OTA / 清零（对象被换掉）。
  //      每页到手就 render：旧数据往左补，最新读数不动（render 的 merge 语义）。
  async function startHistoryBackfill() {
    const cov = state.historyBackfill;
    if (!state.hisBlkChar || cov.unsupported || cov.running || !cov.oldestOffset) return;
    cov.running = true;
    let pages = 0;
    try {
      // 中文：用对象身份判活——resetDisplay / 重新连接会把 state.historyBackfill 换成新对象，
      //      这一轮就该停手，否则会拿上一台设备的 oldestOffset 去翻新设备的环
      while (state.historyBackfill === cov && cov.oldestOffset > 0) {
        if (state.device?.gatt?.connected !== true || state.otaRunning || state.disconnecting) break;
        const page = await gattOp(
          () => BLEProtocol.fetchHistoryBefore(state.hisBlkChar, { beforeOffset: cov.oldestOffset }),
          'backfill older 24h history (0xFFEC)',
          8000
        );
        if (!page.records.length) {   // 设备侧越界：已经是最旧一条
          cov.oldestOffset = 0;
          break;
        }
        // 中文：这一页读回来时可能已经发生了 Clear/Factory reset/换设备（resetDisplay 换掉了
        //      state.historyBackfill）——此时必须丢弃，否则刚清空的界面会被这一页旧数据
        //      重新 merge 回内存和 localStorage，表现成"清空没生效"。
        if (state.historyBackfill !== cov) break;
        cov.oldestOffset = page.oldestOffset;
        const ts = page.records[0]?.timestamp;
        if (Number.isFinite(ts) && ts > 0) cov.oldestTs = cov.oldestTs ? Math.min(cov.oldestTs, ts) : ts;
        pages++;
        render(page.records);
        if (cov.oldestOffset > 0) await new Promise((r) => setTimeout(r, HISTORY_BACKFILL_GAP_MS));
      }
      log(`24h backfill finished: +${pages} page(s), oldestOffset=${cov.oldestOffset}`);
    } catch (err) {
      log(`24h backfill stopped: ${err.message || err}`);
    } finally {
      cov.running = false;
    }
  }

  // 中文：只清"设备数据"类缓存（trend / daily / fwVer / pendingFw），
  //      保留 lastDevice（上次连接的设备，决定首屏回显哪台设备的数据）、
  //      devName、tempUnit、dailyRange —— 这些是用户偏好，不属于"测量数据"。
  //      历史实现按 CACHE_PREFIX 全删，导致清一次数据就丢掉 lastDevice，
  //      下次打开页面不再回显上次设备，表现为"分设备缓存逻辑消失了"。
  function clearAllCache() {
    const isDataKey = (key) => RECORD_KEY_RE.test(key)
      || key.startsWith(`${CACHE_PREFIX}fwVer:`)
      || key.startsWith(`${CACHE_PREFIX}pendingFw:`)
      // 历史遗留的"清空水位"key（已不再写入，见文件顶部说明）：一并按数据类清掉，
      // 免得旧版本留在用户手机上的时间戳一直占着 storage
      || key.startsWith(`${CACHE_PREFIX}clearedAt:`);
    const keys = Object.keys(localStorage).filter(isDataKey);
    keys.forEach((key) => localStorage.removeItem(key));
    resetDisplay();
    state.lastNotifiedRec = null;   // 清掉 notify 去重基线，避免重连后拿旧记录做基线
    log(`Cache cleared: removed ${keys.length} key(s)`);
  }

  // Factory reset 联动：设备端数据全部擦除后，网页本地为该设备缓存的数据同步清除——
  // 校准尝试记录（CALIB_ATTEMPT_KEY，不在 CACHE_PREFIX 下，clearAllCache 管不到）、
  // 该设备的历史/日均值缓存、设备展示名徽章。lastDevice（便于重连）与温度单位偏好保留
  // 【必须同时清内存】只删 localStorage 是不够的：state.lastRecords / lastDailyRecords
  //   仍留在内存里，图表也还画在 canvas 上；下一次 render()（轮询/重连/切 tab）会拿这份
  //   残留数据 merge 并 saveTrendRecordsCache 写回本地缓存 → 设备明明已擦除，网页上
  //   "重置后历史数据还在"，重连后还会被 restoreCachedCharts 重新画出来。
  function clearLocalDeviceCache() {
    try {
      localStorage.removeItem(CALIB_ATTEMPT_KEY);
      Object.keys(localStorage)
        .filter((key) => RECORD_KEY_RE.test(key) && (!state.activeDeviceId || key.includes(state.activeDeviceId)))
        .forEach((key) => localStorage.removeItem(key));
    } catch (_) { /* 存储不可用时静默跳过 */ }
    state.calibAttempt = { dry: null, wet: null };
    renderCalibPointUi('dry', 'clear');
    renderCalibPointUi('wet', 'clear');
    clearDeviceNameBadge();
    resetDisplay();                 // 清内存（lastRecords/lastDailyRecords/latestShown）+ 重绘空图表/空表格
    state.lastNotifiedRec = null;   // 清掉 notify 去重基线
  }

    /**
     * "美化"Y轴范围：给定数据的最小/最大值，计算一个"好看"的范围，
     * 并可选 clamp 到固定上下界（如百分比 0~100）。
     * 解决"截断Y轴导致波动被放大"的误导问题。
     */
    function niceRange(min, max, opts = {}) {
      const loBound = opts.loBound !== undefined ? opts.loBound : null;
      const hiBound = opts.hiBound !== undefined ? opts.hiBound : null;
      const rawSpan = (max - min) || (Math.abs(max) > 0 ? Math.abs(max) * 0.2 : 1);
      const padding = Math.max(rawSpan * 0.2, rawSpan * 0.15);
      let lo = min - padding;
      let hi = max + padding;
      if (loBound !== null) lo = Math.max(lo, loBound);
      if (hiBound !== null) hi = Math.min(hi, hiBound);
      if (hi - lo < rawSpan * 0.1) {
        hi = Math.min(hiBound !== null ? hiBound : hi + 10, (lo + max) / 2 + 10);
        lo = Math.max(loBound !== null ? loBound : lo - 10, (lo + max) / 2 - 10);
      }
      return { lo, hi };
    }

    /**
     * 绘制坐标轴框架：水平网格线 + 左Y轴 + X轴底线。
     */
    function drawAxisFrame(ctx, padTop, padLeft, padRight, w, plotH) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#f1f5f9';
      for (let i = 0; i <= 4; i++) {
        const y = padTop + (plotH / 4) * i;
        ctx.beginPath();
        ctx.moveTo(padLeft, y);
        ctx.lineTo(w - padRight, y);
        ctx.stroke();
      }
      ctx.strokeStyle = '#cbd5e1';
      ctx.beginPath();
      ctx.moveTo(padLeft, padTop);
      ctx.lineTo(padLeft, padTop + plotH);
      ctx.lineTo(w - padRight, padTop + plotH);
      ctx.stroke();
    }

    /**
     * 绘制Y轴刻度文本。
     */
    function drawYAxisTicks(ctx, lo, hi, padTop, plotH, x, align, color, formatter, skipYs) {
      ctx.fillStyle = color;
      ctx.font = '10px sans-serif';
      ctx.textAlign = align;
      ctx.textBaseline = 'middle';
      const fmt = formatter || (v => v.toFixed(1));
      for (let i = 0; i <= 4; i++) {
        const val = hi - (hi - lo) * (i / 4);
        const y = padTop + (plotH / 4) * i;
        // 中文：落在阈值角标上的刻度直接不画（由角标顶替），避免两行字叠在一起
        if (skipYs && skipYs.some((sy) => Math.abs(sy - y) < 9)) continue;
        ctx.fillText(fmt(val), x, y);
      }
    }

    /**
     * 标签碰撞布局：同一 X 附近的多标签按 Y 排序，保证最小间距。
     */
    function layoutLabels(allLabels, labelGap) {
      const groups = {};
      allLabels.forEach(l => {
        const key = Math.round(l.x / 8);
        (groups[key] = groups[key] || []).push(l);
      });
      Object.values(groups).forEach(group => {
        group.sort((a, b) => a.dataY - b.dataY);
        if (group[0]) group[0].placedY = group[0].dataY;
        for (let i = 1; i < group.length; i++) {
          const prev = group[i - 1].placedY ?? group[i - 1].dataY;
          group[i].placedY = (group[i].dataY - prev < labelGap) ? prev + labelGap : group[i].dataY;
        }
      });
    }

    /**
     * 绘制标签（含引线）。
     */
    function drawLabels(ctx, allLabels) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      allLabels.forEach(l => {
        if (l.placedY === undefined) l.placedY = l.dataY;
        const dy = l.placedY - l.dataY;
        if (Math.abs(dy) > 6) {
          ctx.beginPath();
          ctx.strokeStyle = l.color;
          ctx.globalAlpha = 0.3;
          ctx.lineWidth = 1;
          ctx.moveTo(l.x, l.dataY);
          ctx.lineTo(l.x, l.placedY);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        ctx.fillStyle = l.color;
        ctx.fillText(l.text, l.x, l.placedY + (dy >= 0 ? 10 : -4));
      });
    }
 
   function render(records) {
    // 中文：先并入既有 24h 数据再清洗封顶——轮询(0xFFE1 5 条)/通知带来的增量
    //      直接覆盖 state.lastRecords 会把 24h 缓存缩水成 5 条。
    //      内存侧的旧数据靠 Clear/Reset 里的 resetDisplay() 清，不在这里按时间戳过滤
    //      （2026-10-22 移除清空水位：过滤会让"设备里确实还在的数据"被静默藏掉）。
    const base = state.lastRecords;
    // 中文：进 sanitize 之前先记下本次传入的原始条数——用来区分两种"渲染后为空"：
    //      ① 设备本来就没数据；② 设备给了 N 条但时间戳全部无效（未对时）。
    //      原来两者都被下面的 return 吞掉，界面上什么提示都没有。
    const incoming = Array.isArray(records) ? records.length : 0;
    records = sanitizeTrendRecords(mergeTrendRecords(base, records));
    if (!records.length) {
      // 中文：设备给了数据却一条都过不了 sanitize = 时间戳全为 0 或越界，即设备尚未对时。
      //      固件侧已用锚点双向推算兜底（锚点前后的记录都能推出真实 epoch），
      //      这里只剩"整个窗口没有任何一条真实时间戳"的极端情况，必须明确告知用户，
      //      否则界面停在连接前的样子，看起来像卡住了。
      updateTrendSummary([]);   // 中文：统一空态文案（此前这句被上面的 return 挡成死代码）
      if (incoming > 0) {
        // 中文：文案里不带条数——render 会被通知/轮询以 1~5 条的小批次反复调用，
        //      每批条数不同会让提示在 "5 record(s)" / "1 record(s)" 之间跳，
        //      容易让人以为数据在变。真实条数留给日志诊断。
        els.trendRangeText.textContent = 'Time not synced (device clock not set)';
        log(`Trend records dropped: ${incoming} record(s) carry no valid timestamp (clock not set)`);
      }
      return;
    }
     state.lastRecords = records;
    saveTrendRecordsCache(records, state.activeDeviceId);
     const latest = records[records.length - 1];
 
     // 中文：水位保护——Refresh 的一次性测量值（0xFFEB）可能比历史最后一条更新，
     //     历史渲染（轮询/重连/通知）不得用过期数据覆盖 Latest 卡片；
     //     只有历史出现 >= 水位的新记录（如新一轮周期采样）才允许刷新卡片
     if (!state.latestShown || latest.timestamp >= state.latestShown.timestamp) {
       els.tempValue.textContent = tempVal(latest.temp).toFixed(1);
       els.humValue.textContent = latest.hum.toFixed(1);
       els.battValue.textContent = latest.batt;
       els.lastUpdate.textContent = `Latest measurement: ${formatTime(latest.timestamp)}`;
       state.latestShown = latest;
       syncBatteryPill();
     }
 
     // 中文：表格只列最近 20 条（24h 全量数据看上方趋势图；144 行全渲染徒增 DOM）
     els.historyBody.innerHTML = records
       .slice(-20)
       .map((r, i) => `
         <tr class="border-b border-slate-50 last:border-0">
           <td class="py-2 pr-2 text-slate-400">${records.length - Math.min(records.length, 20) + i + 1}</td>
           <td class="py-2 pr-2">${formatTime(r.timestamp)}</td>
           <td class="py-2 pr-2 text-amber-500 font-medium">${fmtTemp(r.temp)}</td>
           <td class="py-2 pr-2 text-sky-500 font-medium">${r.hum.toFixed(1)}%</td>
           <td class="py-2 text-emerald-600 font-medium">${r.batt}%</td>
         </tr>`)
       .reverse()
       .join('');
 
    // 中文：先画图、再写范围文案——文案要显示"可视窗口"区间，而窗口几何是 drawChart
    //      算出来写进 state.trendGeom 的。反过来（先写文案）在页面刚加载/重载时会拿到
    //      null 几何，退化成"首末记录"文案，与图上真实画出的 6h 窗口对不上。
    drawChart(records);
    updateTrendSummary(records);
   }

  // Data 面板改版后图下 3 个统计块(trend/dailyLatestValue 等)已从 index.html 移除，
  // 本函数仅维护仍存在的 trendRangeText 时间范围文案；勿再引用已删除的元素
   // 中文：跨天的时间段必须带日期。只写 "21:41 - 03:41" 会被读成"结束比开始早"，
  //      实际是跨到了第二天（2026-10-22 用户反馈"看不懂、容易误解"）。
  //      同一天则只在起点标一次日期，避免重复占宽度（手机上这行只有 ~317px）。
  function formatRangeBound(ts, withDate) {
    const hm = formatShortTime(ts);
    if (!withDate || !Number.isFinite(ts) || ts <= 0) return hm;
    const d = new Date(ts * 1000);
    const pad2 = (n) => String(n).padStart(2, '0');
    return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${hm}`;
  }

  function updateTrendSummary(records) {
    if (!records || !records.length) {
      els.trendRangeText.textContent = 'No data available';
      return;
    }

    // 中文：范围文案跟着**可视窗口**走。窗口化之后若仍显示首末记录，用户会以为
    //      图上铺的是 24h，其实只画了 6h（拖到中间时差得更多）。
    //      窗口盖住全部数据时退化成原来的写法，不带跨度后缀。
    const g = state.trendGeom;
    const first = records[0].timestamp;
    const latest = records[records.length - 1].timestamp;
    const winStart = (g && Number.isFinite(g.winStart)) ? g.winStart : first;
    const winEnd = (g && Number.isFinite(g.winEnd)) ? g.winEnd : latest;
    const sameDay = Number.isFinite(winStart) && Number.isFinite(winEnd)
      && new Date(winStart * 1000).toDateString() === new Date(winEnd * 1000).toDateString();
    const startTxt = formatRangeBound(winStart, true);
    const endTxt = formatRangeBound(winEnd, !sameDay);
    if (winStart <= first + 1 && winEnd >= latest - 1) {
      els.trendRangeText.textContent = `Time Range: ${startTxt} - ${endTxt}`;
      return;
    }
    const span = winEnd - winStart;
    const label = span >= 3600 ? `${Math.round(span / 3600)}h` : `${Math.max(1, Math.round(span / 60))}m`;
    els.trendRangeText.textContent = `Time Range: ${startTxt} - ${endTxt} · ${label}`;
  }

  // 中文：只有"离开了最新那一屏"才露出 Latest 胶囊——默认不占版面（手机上一行空隙都金贵），
  //      拖走或缩放之后才出现；点它回到"最新 + 默认 6h"。
  function syncTrendLatestChip() {
    if (!els.trendLatestBtn) return;
    const v = state.trendView;
    const show = !v.follow || v.spanSec !== TREND_VIEW_SPAN_DEFAULT;
    els.trendLatestBtn.classList.toggle('hidden', !show);
  }
 
  /**
   * 24h 趋势图：温度(左轴) + 湿度(右轴,%，固定 0~100)。
   * 为避免遮挡，关键数值放在图下统计区，不在曲线上堆叠标签。
   *
   * x 轴是**可视窗口**（state.trendView）而不是全部 144 条：默认只画最近 6h，
   * 左右拖动看更早的数据，手势见下方的 pointer/wheel 绑定。
   */
   function drawChart(records) {
     const canvas = els.trendChart;
     if (!canvas || !records || !records.length) return;

    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(280, canvas.clientWidth || canvas.parentElement.clientWidth || 280);
    const compact = w < 420 || isMobileViewport();
    // 中文：画布高度取自 CSS（HTML 里两个面板同为 h-56 sm:h-60 = 224/240px），
    //      不再硬编码 240/228——旧写法与 CSS 容器高度对不上，canvas 被 CSS 拉伸缩放
    //      → 线虚、字糊；更糟的是两个图各写一份高度，改一处就"两个 tab 图不一样大"。
    //      现在 CSS 是唯一尺寸真相，改 HTML 一处即两图同步。
    const h = Math.max(200, canvas.clientHeight || (compact ? 240 : 228));
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    // 中文：内边距与日均图 drawMultiSeriesChart 取同一套（CHART_PAD_*），
    //      切换 24h / 7D / 30D 时 X 轴刻度线、绘图区上下沿都在同一高度，不会跳。
    const padTop = CHART_PAD_TOP;
    const padBottom = CHART_PAD_BOTTOM;
    const padLeft = compact ? CHART_PAD_LEFT_COMPACT : CHART_PAD_LEFT_WIDE;
    const padRight = padLeft;   // 双轴视图：右侧要给湿度刻度留同样宽度
     const plotW = w - padLeft - padRight;
     const plotH = h - padTop - padBottom;

     // ── 可视窗口（x 轴范围）──
     // 中文：144 条 × 10min 铺满 24h 时，手机 ~230px 的绘图区里每条只摊到 1.6px，
     //      点全挤成一条毛毛虫、最近几小时的走势反而看不清。改成"只画窗口内这一段"，
     //      默认 6h（≈36 条，每条 ~6px），手指左右拖平移（手势见下方 pointer/wheel 绑定）。
     const n = records.length;
     const dataFirst = records[0].timestamp;
     const dataLast = records[n - 1].timestamp;
     const dataSpan = Math.max(1, dataLast - dataFirst);
     const view = state.trendView;
     if (view.follow || !Number.isFinite(view.endTs)) view.endTs = dataLast;
     // 窗口比数据还宽时收缩到数据跨度：只有 3 条记录的新设备不该被摊到 6 小时宽
     const spanSec = Math.round(Math.min(view.spanSec, Math.max(dataSpan * 1.1, 120)));
     // 右边界钳在 [最早一条 + span, 最新一条]：拖到头就停，不会拖出纯空白区
     const minEnd = Math.min(dataFirst + spanSec, dataLast);
     // 中文：取整到秒——拖动时是 px→秒 的浮点换算，留小数会让窗口边界与记录时间戳
     //      永远差 0.1s，比较"是否回到最新"之类的 ±1s 判据变得很脆
     const endTs = Math.round(Math.min(Math.max(view.endTs, minEnd), dataLast));
     const winStart = endTs - spanSec;
     view.endTs = endTs;

     // 窗口内可见的记录（visStart..visEnd 为下标半开区间）；整段落在断档里时退回最近一条
     let visStart = 0;
     while (visStart < n && records[visStart].timestamp < winStart) visStart++;
     let visEnd = visStart;
     while (visEnd < n && records[visEnd].timestamp <= endTs) visEnd++;
     if (visEnd === visStart) {
       let best = 0, bestD = Infinity;
       for (let i = 0; i < n; i++) {
         const d = Math.min(Math.abs(records[i].timestamp - winStart), Math.abs(records[i].timestamp - endTs));
         if (d < bestD) { bestD = d; best = i; }
       }
       visStart = best;
       visEnd = best + 1;
     }
     // 绘制范围两侧各带一个窗口外的点：线段能画到边界之外，裁剪后不会在边缘突然断头
     const drawStart = Math.max(0, visStart - 1);
     const drawEnd = Math.min(n, visEnd + 1);

     const temps = records.map(r => tempVal(r.temp));
     const hums = records.map(r => r.hum);
     // 中文：纵轴量程只按**窗口内**的点算。用全量 min/max 时，窗口里只有一条平线
     //      也会被 24h 的极值压扁成一条直线——和"看不清"是同一个问题。
     const visTemps = temps.slice(visStart, visEnd);
     let tRange = niceRange(Math.min(...visTemps), Math.max(...visTemps));
     // 中文：最小可视跨度。夜间 6h 土壤温度可能只摆动 0.4℃，按 20% 留白放大后
     //      0.01℃ 的量化噪声会被画成锯齿；至少给 1.5（当前温度单位）保留真实起伏。
     if (tRange.hi - tRange.lo < 1.5) {
       const mid = (tRange.lo + tRange.hi) / 2;
       tRange = { lo: mid - 0.75, hi: mid + 0.75 };
     }
     const hLo = 0;
     const hHi = 100;

     drawAxisFrame(ctx, padTop, padLeft, padRight, w, plotH);
     drawYAxisTicks(ctx, tRange.lo, tRange.hi, padTop, plotH, padLeft - 6, 'right', '#f59e0b', v => v.toFixed(1));
     drawYAxisTicks(ctx, hLo, hHi, padTop, plotH, w - padRight + 6, 'left', '#0ea5e9', v => v.toFixed(0));

    // 中文：X 轴按真实时间定位，且映射的是**可视窗口**而不是首末记录：
    //      旧实现 xOf = (ts - t0) / (t1 - t0) 一屏铺满全部 24h，采样均匀时看着还行，
    //      但设备重启 / 清空 / 深睡造成几小时断档时，断档会被画成和正常 10 分钟间隔一样宽，
    //      点越多越假；而窗口映射下断档自然表现为空白，且能靠拖动看清局部。
    const xOf = (ts) => padLeft + ((ts - winStart) / spanSec) * plotW;

    // 断档判定：超过"中位采样间隔 ×3"且至少 30 分钟才断线，避免正常抖动把曲线切碎。
    // 中位间隔只统计绘制范围内的点——否则全量里的断档会把中位数抬高，窗口内的小断档被吞掉
    const deltas = [];
    for (let i = drawStart + 1; i < drawEnd; i++) {
      deltas.push(records[i].timestamp - records[i - 1].timestamp);
    }
    const sortedDeltas = [...deltas].sort((a, b) => a - b);
    const medDelta = sortedDeltas.length ? sortedDeltas[Math.floor(sortedDeltas.length / 2)] : 0;
    const gapLimit = Math.max(medDelta * 3, 1800);
    const segs = [[drawStart]];
    for (let i = drawStart + 1; i < drawEnd; i++) {
      if (records[i].timestamp - records[i - 1].timestamp > gapLimit) segs.push([i]);
      else segs[segs.length - 1].push(i);
    }

     const plotSeries = (vals, color, lo, hi, fillArea) => {
       // 中文：整库只有一条记录（刚 Clear / 新设备第一条采样）时，画不出"线"，
       //      旧的落点只是一个空心小圆，用户反馈"温度是一个点不是长条"。
       //      改成横贯绘图区的"保持线"：值不变时这条线就是它的全部历史，
       //      真实采样时刻仍由下方 markFocusPoint 的圆点标出。
       if (n === 1) {
         const y = padTop + (1 - (vals[0] - lo) / (hi - lo)) * plotH;
         ctx.beginPath();
         ctx.strokeStyle = color;
         ctx.lineWidth = compact ? 2.2 : 2.5;
         ctx.lineCap = 'round';
         ctx.moveTo(padLeft, y);
         ctx.lineTo(padLeft + plotW, y);
         ctx.stroke();
       }
       segs.forEach((seg) => {
         // 面积填充按段闭合：断档两侧各自成块，不跨断档拉直线
         if (fillArea && seg.length > 1) {
           ctx.beginPath();
           seg.forEach((i, k) => {
             const x = xOf(records[i].timestamp);
             const y = padTop + (1 - (vals[i] - lo) / (hi - lo)) * plotH;
             k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
           });
           ctx.lineTo(xOf(records[seg[seg.length - 1]].timestamp), padTop + plotH);
           ctx.lineTo(xOf(records[seg[0]].timestamp), padTop + plotH);
           ctx.closePath();
           ctx.fillStyle = `${color}12`;
           ctx.fill();
         }

         if (seg.length > 1) {
           ctx.beginPath();
           ctx.strokeStyle = color;
           ctx.lineWidth = compact ? 2.2 : 2.5;
           ctx.lineJoin = 'round';
           ctx.lineCap = 'round';
           seg.forEach((i, k) => {
             const x = xOf(records[i].timestamp);
             const y = padTop + (1 - (vals[i] - lo) / (hi - lo)) * plotH;
             k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
           });
           ctx.stroke();
         }

        // 中文：数据点标记按"像素间距"决定画法。点密集（间距 < ~3 倍标记直径）时
        //      逐点画圈会互相重叠成"毛毛虫"，段边界标记也会在图中间冒出圆圈，
        //      此时整条曲线只在窗口内最新那个点上画一个标记；稀疏或单点段逐点标记。
        const markerR = compact ? 3.2 : 4;
        const xFirst = xOf(records[seg[0]].timestamp);
        const xLast = xOf(records[seg[seg.length - 1]].timestamp);
        const spacing = seg.length > 1 ? (xLast - xFirst) / (seg.length - 1) : Infinity;
        const dense = spacing < markerR * 6;
        // 中文：密集时不在段内画标记，统一由下面的 markFocusPoint 补画（不受裁剪影响）
        const markIdx = dense ? [] : seg;
        markIdx.forEach((i) => {
          const x = xOf(records[i].timestamp);
          const y = padTop + (1 - (vals[i] - lo) / (hi - lo)) * plotH;
          ctx.beginPath();
          ctx.arc(x, y, markerR, 0, Math.PI * 2);
          ctx.fillStyle = '#fff';
          ctx.fill();
          ctx.lineWidth = compact ? 2 : 2.2;
          ctx.strokeStyle = color;
          ctx.stroke();
        });
       });
     };

     // 中文：曲线/面积全部裁到绘图区内。窗口化之后，两侧各有一个"窗口外的点"用来
     //      让线段延伸到边界，不裁剪的话它会画到左右刻度槽里（压在 Y 轴数字上）。
     ctx.save();
     ctx.beginPath();
     ctx.rect(padLeft, padTop, plotW, plotH);
     ctx.clip();
     plotSeries(hums, '#0ea5e9', hLo, hHi, true);
     plotSeries(temps, '#f59e0b', tRange.lo, tRange.hi, false);
     ctx.restore();

     // 中文：窗口内最新点的标记补画在裁剪区外。它经常正好贴着绘图区右边界
     //      （默认视图就是"贴着最新一条"），裁剪会把圆切掉一半，看着像断头；
     //      标记只有 3~4px，越界一点点也压不到刻度数字。
     const markFocusPoint = (i, vals, color, lo, hi) => {
       const x = xOf(records[i].timestamp);
       const y = padTop + (1 - (vals[i] - lo) / (hi - lo)) * plotH;
       ctx.beginPath();
       ctx.arc(x, y, compact ? 3.2 : 4, 0, Math.PI * 2);
       ctx.fillStyle = '#fff';
       ctx.fill();
       ctx.lineWidth = compact ? 2 : 2.2;
       ctx.strokeStyle = color;
       ctx.stroke();
     };
     markFocusPoint(visEnd - 1, hums, '#0ea5e9', hLo, hHi);
     markFocusPoint(visEnd - 1, temps, '#f59e0b', tRange.lo, tRange.hi);

     // 中文：X 轴刻度用"本地整点刻度"，且在**窗口内**生成。
     //      旧实现按 i % skip 抽标签，跳过的记录数与真实时间无关，点一多标签就和曲线对不上。
     ctx.fillStyle = '#94a3b8';
     ctx.font = compact ? '8.5px sans-serif' : '9px sans-serif';
     ctx.textBaseline = 'top';
     const labelY = padTop + plotH + 6;
     const maxTicks = Math.max(2, Math.floor(plotW / (compact ? 62 : 76)));
     const stepH = [1, 2, 3, 4, 6, 12].find((hh) => spanSec / (hh * 3600) <= maxTicks) || 12;
     const ticks = [];
     for (let tick = Math.ceil(winStart / 3600) * 3600; tick <= endTs; tick += 3600) {
       if (new Date(tick * 1000).getHours() % stepH !== 0) continue;
       ticks.push(tick);
     }
     // 窗口不足一个整点刻度：退化为首尾标注，避免整条轴只剩一个孤立标签
     if (ticks.length < 2) { ticks.length = 0; ticks.push(winStart, endTs); }
     ticks.forEach((ts) => {
       const x = xOf(ts);
       // 中文：贴边的标签往内对齐，否则"15:00"会被绘图区右边界切掉半个字
       ctx.textAlign = (x - padLeft) < 16 ? 'left' : ((padLeft + plotW - x) < 16 ? 'right' : 'center');
       ctx.fillText(formatShortTime(ts), x, labelY);
     });

     // 中文：把本帧的几何留给手势层与测试（拖动的像素→秒换算、断言窗口区间都用它）
     canvas._trendLayout = {
       winStart, winEnd: endTs, spanSec, endTs,
       padLeft, plotW, dataFirst, dataLast,
       follow: view.follow, visible: visEnd - visStart,
     };
     state.trendGeom = canvas._trendLayout;
     syncTrendLatestChip();
   }

    /**
     * 通用多系列折线图（日均值/功耗图复用）。
     * 支持：固定轴范围（如百分比0-100）、坐标轴框架、latestOnly智能标签。
     */
    function drawMultiSeriesChart(canvas, series, options = {}) {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(280, canvas.clientWidth || canvas.parentElement.clientWidth || 280);
      // 中文：高度以 CSS 容器为准（与 24h 图同一条规则），options.height 只作兜底。
      //      旧代码用调用处硬编码的 240/228，与 CSS 的 h-56/h-60 对不上，画布被
      //      拉伸 → 线虚字糊，且与 24h 图各算一套高度，两个 tab 图不一样大。
      const h = Math.max(200, canvas.clientHeight || options.height || 240);
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, h);

      const len = series[0]?.values.length || 0;
      if (len < 1) return;

      const rightAxis = options.rightAxisIndices || [];
      const dual = rightAxis.length > 0;

      // 中文：与 24h 图 drawChart 共用同一套内边距（CHART_PAD_*）——两张图的 X 轴
      //      标签基线、绘图区上下沿因此严格同高，切 24h / 7D / 30D 不再跳位。
      //      左侧只放"刻度数字 + 阈值角标"两列（10px 字号 "28.3" ≈ 21px + 5px 间隙）。
      const padTop = CHART_PAD_TOP;
      const padBottom = CHART_PAD_BOTTOM;
      const padLeft = w < 420 ? CHART_PAD_LEFT_COMPACT : CHART_PAD_LEFT_WIDE;
      const padRight = dual ? padLeft : CHART_PAD_RIGHT_SINGLE;
      const plotW = w - padLeft - padRight;
      const plotH = h - padTop - padBottom;

      // 中文：band = 每个点的"取值范围"（日均温度 min–max）。量程必须把它算进去，
      //      否则极值会被裁到画布外——均值线在 20~25℃ 时，一个 -3℃ 的霜冻极值会画到坐标轴外
      const bandIdx = options.band ? (options.band.index ?? 0) : -1;
      const ranges = series.map(({ values }, idx) => {
        let min = Math.min(...values), max = Math.max(...values);
        if (idx === bandIdx) {
          const blo = options.band.lo.filter(Number.isFinite);
          const bhi = options.band.hi.filter(Number.isFinite);
          if (blo.length) min = Math.min(min, ...blo);
          if (bhi.length) max = Math.max(max, ...bhi);
        }
        return niceRange(min, max);
      });

      const leftIdx = series.map((_, i) => i).filter(i => !rightAxis.includes(i));
      let leftLo = leftIdx.length ? Math.min(...leftIdx.map(i => ranges[i].lo)) : 0;
      let leftHi = leftIdx.length ? Math.max(...leftIdx.map(i => ranges[i].hi)) : 1;
      let rightLo = rightAxis.length ? Math.min(...rightAxis.map(i => ranges[i].lo)) : 0;
      let rightHi = rightAxis.length ? Math.max(...rightAxis.map(i => ranges[i].hi)) : 1;
      if (options.leftAxisRange) { leftLo = options.leftAxisRange[0]; leftHi = options.leftAxisRange[1]; }
      if (options.rightAxisRange) { rightLo = options.rightAxisRange[0]; rightHi = options.rightAxisRange[1]; }
      // 中文：自动量程的物理边界（电量 0~100 这类），只夹边界、不改变自适应能力
      if (options.leftAxisBounds) {
        leftLo = Math.max(options.leftAxisBounds[0], leftLo);
        leftHi = Math.min(options.leftAxisBounds[1], leftHi);
      }
      // 中文：最小可视跨度——电量这类"1% 量化"的指标，跨度过小会把 1 个 LSB 的
      //      量化台阶放大成"断崖"。至少给 4 个百分点，噪声不再被戏剧化。
      if (options.leftAxisMinSpan && leftHi - leftLo < options.leftAxisMinSpan) {
        const mid = (leftLo + leftHi) / 2;
        leftLo = mid - options.leftAxisMinSpan / 2;
        leftHi = mid + options.leftAxisMinSpan / 2;
        if (options.leftAxisBounds) {
          if (leftLo < options.leftAxisBounds[0]) { leftHi += options.leftAxisBounds[0] - leftLo; leftLo = options.leftAxisBounds[0]; }
          if (leftHi > options.leftAxisBounds[1]) { leftLo -= leftHi - options.leftAxisBounds[1]; leftHi = options.leftAxisBounds[1]; }
        }
      }
      if (leftHi - leftLo < 1e-6) leftHi = leftLo + 1;

      // 中文：温度风险区背景——整片高于热害阈值涂淡红、低于霜冻阈值涂淡蓝。
      //      比"每天一根竖须/一条 min–max 色带"更省心：不需要任何图例，曲线掉进蓝区
      //      就是要防冻、伸进红区就是要防灼。画在坐标轴框架之前，网格线保持清晰。
      if (options.band) {
        const useRight = rightAxis.includes(bandIdx >= 0 ? bandIdx : 0);
        const zLo = useRight ? rightLo : leftLo;
        const zHi = useRight ? rightHi : leftHi;
        const zy = v => padTop + (1 - (v - zLo) / (zHi - zLo)) * plotH;
        const heat = options.band.heatAbove;
        const frost = options.band.frostBelow;

        // 阈值线：虚线而非实线，避免和均值线抢注意力；只画在对应色区的边界上
        const edge = (y, color) => {
          ctx.save();
          ctx.setLineDash([4, 3]);
          ctx.lineWidth = 1;
          ctx.strokeStyle = color;
          ctx.beginPath();
          ctx.moveTo(padLeft, y);
          ctx.lineTo(padLeft + plotW, y);
          ctx.stroke();
          ctx.restore();
        };

        ctx.save();
        if (Number.isFinite(heat) && heat < zHi) {
          const yEdge = zy(Math.max(zLo, heat));
          ctx.fillStyle = 'rgba(220,38,38,0.10)';
          ctx.fillRect(padLeft, padTop, plotW, Math.max(0, yEdge - padTop));
          edge(yEdge, 'rgba(220,38,38,0.45)');
          // 阈值数值不画在图内：最新的竖条正好落在右侧、左缘也被首日条压住，
          // 改成摘要头右侧的固定图例（见 updateDailyZoneLegend）
        }
        if (Number.isFinite(frost) && frost > zLo) {
          const yEdge = zy(Math.min(zHi, frost));
          ctx.fillStyle = 'rgba(2,132,199,0.10)';
          ctx.fillRect(padLeft, yEdge, plotW, Math.max(0, padTop + plotH - yEdge));
          edge(yEdge, 'rgba(2,132,199,0.45)');
        }
        ctx.restore();
      }

      drawAxisFrame(ctx, padTop, padLeft, padRight, w, plotH);

      const leftColor = options.leftAxisColor || '#64748b';
      const leftFmt = options.leftAxisFormatter || (v => v.toFixed(1));
      // 中文：阈值角标（≥35.0 红 / ≤2.0 蓝）与刻度数字同列，先算出它们的 y，
      //      再交给刻度绘制做"让位"——阈值贴近某个刻度时，那个灰色刻度干脆不画，
      //      由彩色角标顶替。这样永远不会出现两行字叠在一起（旧做法是挪 7px，
      //      刻度一多仍然会压住）。
      const thMarks = [];
      if (options.band && !dual) {
        const pushMark = (val, color, prefix) => {
          if (!Number.isFinite(val) || val <= leftLo || val >= leftHi) return;
          thMarks.push({
            y: padTop + (1 - (val - leftLo) / (leftHi - leftLo)) * plotH,
            color,
            text: `${prefix}${val.toFixed(1)}`,
          });
        };
        pushMark(options.band.heatAbove, '#dc2626', '≥');
        pushMark(options.band.frostBelow, '#0284c7', '≤');
      }
      drawYAxisTicks(ctx, leftLo, leftHi, padTop, plotH, padLeft - 6, 'right', leftColor, leftFmt, thMarks.map(m => m.y));
      thMarks.forEach(({ y, color, text }) => {
        ctx.font = 'bold 8px sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = color;
        ctx.fillText(text, padLeft - 6, y);
      });

      if (dual) {
        const rightColor = options.rightAxisColor || '#64748b';
        const rightFmt = options.rightAxisFormatter || (v => v.toFixed(0));
        drawYAxisTicks(ctx, rightLo, rightHi, padTop, plotH, w - padRight + 6, 'left', rightColor, rightFmt);
      }

      // 中文：只有一天数据（Clear 后 / 刚上电）时，温度仍要画"当日区间竖条"。
      //      旧实现在这里直接画圆点后 return，把 min–max 圆头竖条整段跳过了，
      //      于是"温度只有一个点"，与多天视图的语义（条的高低端 = 当日最低/最高）
      //      对不上；湿度/电量是单值系列，画横贯绘图区的"保持线"+正中圆点。
      //      竖条画在绘图区正中；当日 min==max 时条没有长度，补到 MIN_BAR_PX
      //      让它仍是一条圆头短条，而不是退化成一个点。
      if (len < 2) {
        const x = padLeft + plotW / 2;
        let barDrawn = false;
        if (options.band && bandIdx >= 0) {
          const useRight = rightAxis.includes(bandIdx);
          const lo = useRight ? rightLo : leftLo;
          const hi = useRight ? rightHi : leftHi;
          const yOf = v => padTop + (1 - (v - lo) / (hi - lo)) * plotH;
          const bLo = options.band.lo?.[0];
          const bHi = options.band.hi?.[0];
          if (Number.isFinite(bLo) && Number.isFinite(bHi)) {
            let yTop = Math.min(yOf(bHi), yOf(bLo));
            let yBot = Math.max(yOf(bHi), yOf(bLo));
            const MIN_BAR_PX = 8;
            if (yBot - yTop < MIN_BAR_PX) {
              const mid = (yTop + yBot) / 2;
              yTop = mid - MIN_BAR_PX / 2;
              yBot = mid + MIN_BAR_PX / 2;
            }
            const { color: barColor } = series[bandIdx] || {};
            ctx.save();
            ctx.strokeStyle = barColor || '#f59e0b';
            ctx.lineCap = 'round';
            ctx.lineWidth = 7;     // 与多天视图的条宽上限一致（stepX 大时封顶 7）
            ctx.beginPath();
            ctx.moveTo(x, yTop);
            ctx.lineTo(x, yBot);
            ctx.stroke();
            ctx.restore();
            barDrawn = true;
          }
        }
        series.forEach(({ values, color }, idx) => {
          // 区间竖条已表达该系列时不再叠圆点；band 存在但极值无效（barDrawn=false）
          // 时不能跟着跳过——旧代码这里会让温度整段消失，一个像素都不画。
          if (idx === bandIdx && barDrawn) return;
          const useRight = rightAxis.includes(idx);
          const lo = useRight ? rightLo : leftLo;
          const hi = useRight ? rightHi : leftHi;
          const y = padTop + (1 - (values[0] - lo) / (hi - lo)) * plotH;
          // 中文：单值系列（湿度/电量）与 24h 图同一套语言——横贯绘图区的
          //      "保持线"表达"这一段里值没变过"，圆点只落在该天正中的位置上，
          //      不再是一条孤零零的点。
          ctx.beginPath();
          ctx.strokeStyle = color;
          ctx.lineWidth = 2.2;
          ctx.moveTo(padLeft, y);
          ctx.lineTo(padLeft + plotW, y);
          ctx.stroke();
          ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2);
          ctx.fillStyle = '#fff'; ctx.fill();
          ctx.lineWidth = 2; ctx.strokeStyle = color; ctx.stroke();
        });
        return;
      }

      const stepX = plotW / (len - 1);
      const allLabels = [];

      // 中文：点击/tap 选日（Apple Health 式）。把本次布局存到 canvas 上，
      //      外部点击处理器用它把 offsetX 换算成天序号，无需重复推算内边距
      canvas._chartLayout = { padLeft, plotW, stepX, len };
      const selIdx = Number.isInteger(options.selIdx) ? options.selIdx : len - 1;

      // 中文：选中日竖细线对三种指标都画——温度靠它指出"当前是哪个柱子"，
      //      湿度/电量（只有单值、没有区间柱）靠它指出"摘要头显示的是哪一天"，
      //      点选交互的视觉语言保持一致。画在最底层，不遮数据。
      //      三个维度区分于坐标轴（用户反馈"像坐标轴"，2026-10-22）：紫色 #7c3aed
      //      （轴框是灰 #cbd5e1；橙/蓝/绿已被三个指标占用，紫是唯一无主色）、
      //      虚线（轴框是实线）、上下各内缩 3px 不顶格——默认选中最后一天时
      //      线正贴绘图区右缘，同色顶格会被当成"右边框/右轴"。底端补一个
      //      小圆点端帽，一眼看出是"指针"而不是边框。
      if (Number.isInteger(options.selIdx) && options.selIdx >= 0 && options.selIdx < len) {
        const hx = padLeft + options.selIdx * stepX;
        ctx.save();
        ctx.strokeStyle = '#7c3aed';
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(hx, padTop + 3);
        ctx.lineTo(hx, padTop + plotH - 3);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(hx, padTop + plotH - 3, 2, 0, Math.PI * 2);
        ctx.fillStyle = '#7c3aed';
        ctx.fill();
        ctx.restore();
      }

      // 中文：min–max 画成 Apple Health 健康数据那种"圆头竖条"——每天一根，
      //      条的两端即当天最低/最高。圆头粗条自带"这是一段范围"的语义，
      //      不需要图例；均值即条的中点，不再叠折线（叠线会和条互相打架）。
      //      画在网格之后、无系列线遮挡，选中日加一条浅灰竖细线做指示。
      if (options.band) {
        const useRight = rightAxis.includes(bandIdx >= 0 ? bandIdx : 0);
        const lo = useRight ? rightLo : leftLo;
        const hi = useRight ? rightHi : leftHi;
        const yOf = v => padTop + (1 - (v - lo) / (hi - lo)) * plotH;
        const { lo: bLo, hi: bHi } = options.band;
        const xOf = i => padLeft + i * stepX;

        ctx.save();
        const { color: barColor } = series[bandIdx >= 0 ? bandIdx : 0] || {};
        ctx.strokeStyle = barColor || '#f59e0b';
        ctx.lineCap = 'round';
        // 条宽随像素间距伸缩：30D 手机 ~8.6px/天 → 3.6px；7D/桌面 40px+ → 封顶 7px
        ctx.lineWidth = Math.max(3, Math.min(7, stepX * 0.42));
        for (let i = 0; i < len; i++) {
          if (!Number.isFinite(bLo[i]) || !Number.isFinite(bHi[i])) continue;
          ctx.beginPath();
          ctx.moveTo(xOf(i), yOf(bHi[i]));
          ctx.lineTo(xOf(i), yOf(bLo[i]));
          ctx.stroke();
        }
        ctx.restore();
      }

      // 中文：rangeBars 模式下，band 系列改用上面的圆头竖条表达，不再画折线+点标记
      const barsFor = (options.rangeBars && options.band) ? (bandIdx >= 0 ? bandIdx : 0) : -1;

      // 中文：像素密度判定，与 24h 图 drawChart 的点标记同一套口径（间距 < 6 倍
      //      标记半径即算密）。逐点画 3.5px 圈在密集视图会连成"毛毛虫"，
      //      密集时点标记只画最末一天（最新读数）；稀疏时维持逐点原样。
      const markerR = 3.5;
      const dense = stepX < markerR * 6;

      series.forEach(({ values, color }, idx) => {
        if (idx === barsFor) return;
        const useRight = rightAxis.includes(idx);
        const lo = useRight ? rightLo : leftLo;
        const hi = useRight ? rightHi : leftHi;

        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.5;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        values.forEach((v, i) => {
          const x = padLeft + i * stepX;
          const y = padTop + (1 - (v - lo) / (hi - lo)) * plotH;
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        });
        ctx.stroke();

        // 中文：点标记按像素间距决定画法——与 24h 图 drawChart 同一阈值
        //      （间距 < 6 倍标记半径即密）。密集时逐点画圈会连成"毛毛虫"，
        //      只在最末点（最新一天）画一个；稀疏时逐点标记。
        // 中文：密集时除了最新一天，选中的那天也要留一个点——否则点选后摘要头在跳，
        //      图上却找不到对应数据点（竖细线只指明"哪一天"，点才标出"哪个值"）。
        const denseIdx = [len - 1];
        if (Number.isInteger(options.selIdx) && options.selIdx >= 0 && options.selIdx < len - 1) {
          denseIdx.unshift(options.selIdx);
        }
        const markIdx = dense ? denseIdx : values.map((_, i) => i);
        markIdx.forEach((i) => {
          const x = padLeft + i * stepX;
          const y = padTop + (1 - (values[i] - lo) / (hi - lo)) * plotH;
          ctx.beginPath();
          ctx.arc(x, y, markerR, 0, Math.PI * 2);
          ctx.fillStyle = '#fff';
          ctx.fill();
          ctx.lineWidth = 2;
          ctx.strokeStyle = color;
          ctx.stroke();
        });

        if (options.showValueLabels) {
          const fmt = options.valueFormatter || (v => v.toFixed(1));
          if (options.latestOnly) {
            const i = len - 1;
            const x = padLeft + i * stepX;
            const y = padTop + (1 - (values[i] - lo) / (hi - lo)) * plotH;
            allLabels.push({ x, dataY: y, text: fmt(values[i]), color });
          } else {
            values.forEach((v, i) => {
              const x = padLeft + i * stepX;
              const y = padTop + (1 - (v - lo) / (hi - lo)) * plotH;
              allLabels.push({ x, dataY: y, text: fmt(v), color });
            });
          }
        }
      });

      ctx.font = 'bold 10px sans-serif';
      layoutLabels(allLabels, 12);
      drawLabels(ctx, allLabels);

      if (options.xLabels && options.xLabels.length === len) {
        ctx.fillStyle = '#94a3b8';
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const maxLabels = Math.max(2, Math.floor(plotW / 44));
        const skip = len > maxLabels ? Math.ceil(len / maxLabels) : 1;
        options.xLabels.forEach((label, i) => {
          if (i !== len - 1) {
            if (i % skip !== 0) return;
            // 末位标签固定要画；skip 抽稀后若倒数第二个正好落在它旁边，让位避免重叠
            if (i === len - 2 && skip > 1) return;
          }
          const x = padLeft + i * stepX;
          // 中文：首尾标签钳回画布内——padRight 收窄后末位"10/21"再居中会探出右缘被裁
          const cx = Math.min(w - 14, Math.max(14, x));
          ctx.fillText(String(label), cx, padTop + plotH + 6);
        });
      }
    }
 
   function updateDailyMetricButtons() {
     Object.entries(DAILY_METRICS).forEach(([metric, cfg]) => {
       const btn = els[cfg.button];
       if (!btn) return;
       const active = state.dailyMetric === metric;
       // "卡片切换"样式：每个指标一张卡，选中=线色填充白字，未选=同色浅底。
       // 视觉语言与顶部中性的 24h/7D/30D 分段控件区分开；按钮颜色即图线颜色
       btn.className = `daily-metric-btn w-full text-center rounded-xl px-2 py-1.5 text-xs sm:px-2.5 sm:text-sm font-semibold transition ${active ? cfg.onCls : cfg.offCls}`;
       btn.style.color = '';   // 颜色交给类控制，勿再以 style 覆盖
     });
   }

   // 中文：24h / 7D / 30D 现在是同一排的三个等权视图按钮（与上方 Temperature / Moisture /
   //      Refresh 三列同节奏）。"日均"不再是独立 tab——选中 7D/30D 就是进日均视图，
   //      所以选中态只有一份真相：dailyTabPanel 是否可见 + state.dailyRange。
   function dailyCan30() {
     if (state.daily30Char) return true;
     return Array.isArray(state.lastDailyRecords) && state.lastDailyRecords.length > 7;
   }

   function daily30BlockReason() {
     if (state.daily30Char) return '';
     const n = Array.isArray(state.lastDailyRecords) ? state.lastDailyRecords.length : 0;
     return n > 0 ? '暂只有 7 天内的日均数据，累积更多或连接新固件后可看 30 天'
                  : '需固件支持 30 天日均（0xFFED）';
   }

   // 中文：实际生效的日均区间（30D 不可用时回落到 7D）
   function activeDailyRange() {
     return (state.dailyRange === 30 && dailyCan30()) ? 30 : 7;
   }

   function isDailyView() {
     return !els.dailyTabPanel.classList.contains('hidden');
   }

   const CHART_TAB_BASE = 'chart-tab-btn whitespace-nowrap rounded-lg px-2 py-1.5 text-sm font-semibold transition';
   const CHART_TAB_ON = 'bg-emerald-700 text-white';
   const CHART_TAB_OFF = 'bg-slate-100 text-slate-500 hover:bg-slate-200';

   function updateChartViewButtons() {
     const daily = isDailyView();
     const range = activeDailyRange();
     const can30 = dailyCan30();
     if (els.trendTabBtn) {
       els.trendTabBtn.className = `${CHART_TAB_BASE} ${daily ? CHART_TAB_OFF : CHART_TAB_ON}`;
       els.trendTabBtn.title = '最近 24 小时的逐条记录';
     }
     if (els.dailyRange7Btn) {
       els.dailyRange7Btn.className = `${CHART_TAB_BASE} ${(daily && range === 7) ? CHART_TAB_ON : CHART_TAB_OFF}`;
       els.dailyRange7Btn.title = '7 天日均';
     }
     if (els.dailyRange30Btn) {
       els.dailyRange30Btn.className = `${CHART_TAB_BASE} ${(daily && range === 30) ? CHART_TAB_ON : CHART_TAB_OFF}${can30 ? '' : ' opacity-40 cursor-not-allowed'}`;
       els.dailyRange30Btn.disabled = !can30;
       els.dailyRange30Btn.title = can30 ? '30 天日均（设备 Flash 日志）' : daily30BlockReason();
     }
   }

   function updateDailyNote(range) {
     if (!els.dailyNote) return;
     els.dailyNote.textContent = `${range}-day daily average`;
   }

   // 温度极值文案：图上色带只看得出"每天摆幅"，这行补上窗口内最低/最高那天的确切读数与日期。
   // 只在温度指标下出现（湿度极值多为浇水尖峰、电池单调下降，都没有阈值型信息）。
   function updateDailyExtNote(shown, cfg, band) {
     const el = els.dailyExtNote;
     if (!el) return;
     if (cfg.key !== 'temp' || !band) {
       el.classList.add('hidden');
       el.textContent = '';
       return;
     }
     let low = null, high = null;
     shown.forEach((r) => {
       const t = Number(r.temp);
       if (!Number.isFinite(t)) return;
       if (Number.isFinite(r.tempMinD10)) {
         const v = t + r.tempMinD10 / 10;
         if (!low || v < low.v) low = { v, r };
       }
       if (Number.isFinite(r.tempMaxD10)) {
         const v = t + r.tempMaxD10 / 10;
         if (!high || v > high.v) high = { v, r };
       }
     });
     const parts = [];
     if (low) parts.push(`${low.v <= DAILY_FROST_C ? '❄ ' : ''}Low ${fmtTemp(low.v)} · ${formatMonthDay(low.r.dateEpoch)}`);
     if (high) parts.push(`${high.v >= DAILY_HEAT_C ? '🔥 ' : ''}High ${fmtTemp(high.v)} · ${formatMonthDay(high.r.dateEpoch)}`);
    el.textContent = parts.join('    ');
    el.classList.toggle('hidden', parts.length === 0);
  }

  // 中文：Apple Health 式摘要头——大号数字给出"选中那天"的读数（温度=min–max 区间），
  //      其余指标给单值。默认选最新一天，点图中任意天由点击处理器切换。
  function updateDailyRangeHeader(shown, cfg, band, selIdx) {
    const card = els.dailyRangeCard;
    if (!card) return;
    const r = shown[selIdx];
    if (!r) { card.classList.add('hidden'); return; }
    card.classList.remove('hidden');
    if (els.dailyRangeLabel) els.dailyRangeLabel.textContent = cfg.title;
    let value = '';
    let unit = '';
    if (cfg.key === 'temp' && band && Number.isFinite(band.lo[selIdx]) && Number.isFinite(band.hi[selIdx])) {
      value = `${band.lo[selIdx].toFixed(1)} – ${band.hi[selIdx].toFixed(1)}`;
      unit = tempUnitSymbol();
    } else {
      let v = Number(r[cfg.key]) || 0;
      if (cfg.key === 'temp') v = tempVal(v);   // formatValue 期望的是已换算单位前的摄氏度
      value = cfg.formatValue(v);
    }
    if (els.dailyRangeValue) els.dailyRangeValue.textContent = value;
    if (els.dailyRangeUnit) els.dailyRangeUnit.textContent = unit;
    if (els.dailyRangeDate) els.dailyRangeDate.textContent = r.dateEpoch ? `· ${formatMonthDay(r.dateEpoch)}` : '';
  }

  function setDailyRange(range) {
     if (range !== 7 && range !== 30) return;
     if (range === 30 && !dailyCan30()) return;
     state.dailyRange = range;
     state.dailySelIdx = null;   // 换窗口后选中日重新回到最新一天
     try { localStorage.setItem(`${CACHE_PREFIX}dailyRange:v1`, String(range)); } catch (_) {}
     switchChartView('daily');
   }

   function updateTempUnitUI() {
     const active = state.tempUnit;
     (els.tempUnitToggle?.querySelectorAll('.temperature-unit-btn') || []).forEach(btn => {
       const isActive = btn.dataset.unit === active;
       btn.className = `temperature-unit-btn rounded-md transition font-semibold leading-none ${isActive ? 'bg-amber-500 text-white shadow-sm px-1 py-[3px] text-sm' : 'text-slate-500 px-0.5 py-[3px] text-[10px]'}`;
     });
     try { localStorage.setItem(`${CACHE_PREFIX}tempUnit:v1`, active); } catch (_) {}
     if (els.tempUnitLabel) els.tempUnitLabel.textContent = 'Temperature';   // 单位由 °F/°C 切换器高亮表达，label 不再重复后缀
     if (state.lastRecords) {
       render(state.lastRecords);
     } else {
       els.tempValue.textContent = '--';
     }
     if (state.lastDailyRecords) renderDaily(state.lastDailyRecords);

     // 中文：显式重刷温度卡片——render() 内部的 latestShown 水位保护可能阻止更新，
     //      切换单位后需要强制以当前单位重新展示温度，确保所有相关温度数据立即换算对应单位
     if (state.latestShown) {
       applyLatestRecord(state.latestShown);
     }

     // Setting 温度偏移的数值与刻度同步跟随单位（温差换算 ×9/5、不加 32；±10℃ = ±18℉）
     renderTempOffset();
     if (els.tempOffsetScaleMin) els.tempOffsetScaleMin.textContent = fmtTempDelta(-10);
     if (els.tempOffsetScaleMax) els.tempOffsetScaleMax.textContent = `+${fmtTempDelta(10)}`;
   }


   function renderDaily(records) {
    // 中文：state.lastDailyRecords 存的是"设备给的完整集合"（最多 30 天）——
    //      切 7D/30D 时不用重新读设备，直接在这里截取要画的那一段
    //      这里不做任何"按时间戳过滤"：日均记录要么来自设备直读、要么来自缓存，
    //      两者都是当前该展示的真实数据（清空水位机制已于 2026-10-22 移除）
    records = sanitizeDailyRecords(records);
    state.lastDailyRecords = records;
     const cfg = DAILY_METRICS[state.dailyMetric] || DAILY_METRICS.temp;
     updateDailyMetricButtons();
     updateChartViewButtons();

     // 中文：30D 只在能拿到 30 天数据时可选（新固件 0xFFED 或缓存已超 7 天）
     const range = activeDailyRange();
     updateDailyNote(range);
     const shown = records.slice(-range);

     if (!shown.length) {
       els.dailyEmpty.classList.remove('hidden');
       els.dailyNote?.classList.add('hidden');
       if (els.dailyExtNote) { els.dailyExtNote.classList.add('hidden'); els.dailyExtNote.textContent = ''; }
       if (els.dailyRangeCard) els.dailyRangeCard.classList.add('hidden');
       const ctx = els.dailyChart.getContext('2d');
       if (ctx) ctx.clearRect(0, 0, els.dailyChart.width, els.dailyChart.height);
       return;
     }

     els.dailyEmpty.classList.add('hidden');
     els.dailyNote?.classList.remove('hidden');

     const xLabels = shown.map(r => formatMonthDay(r.dateEpoch));
     let values = shown.map(r => Number(r[cfg.key]) || 0);
     if (cfg.key === 'temp') values = values.map(tempVal);

     // 中文：温度极值（0xFFEE）。设备存的是"相对当日均值的 0.1℃ 偏移"，
     //      绝对温度 = 当日均值 + delta/10；单位换算必须在算出绝对值之后再做
     //      （℉ 是仿射变换，偏移量不能单独换算后相加）。
     let band = null;
     if (cfg.key === 'temp') {
       const bLo = [], bHi = [];
       let hasExt = false;
       shown.forEach((r) => {
         const t = Number(r.temp);
         const ok = Number.isFinite(t) && Number.isFinite(r.tempMinD10) && Number.isFinite(r.tempMaxD10);
         if (!ok) { bLo.push(NaN); bHi.push(NaN); return; }
         hasExt = true;
         bLo.push(tempVal(t + r.tempMinD10 / 10));
         bHi.push(tempVal(t + r.tempMaxD10 / 10));
       });
       if (hasExt) {
         band = {
           lo: bLo,
           hi: bHi,
           frostBelow: tempVal(DAILY_FROST_C),
           heatAbove: tempVal(DAILY_HEAT_C),
         };
       }
     }
     updateDailyExtNote(shown, cfg, band);

     // 中文：选中日（Apple Health 式点选）。默认最新一天；切换范围后序号可能越界，钳回
     if (!Number.isInteger(state.dailySelIdx) || state.dailySelIdx < 0 || state.dailySelIdx >= shown.length) {
       state.dailySelIdx = shown.length - 1;
     }
     updateDailyRangeHeader(shown, cfg, band, state.dailySelIdx);

     drawMultiSeriesChart(els.dailyChart, [
       { values, color: cfg.color },
     ], {
      showValueLabels: false,
      xLabels,
      // 高度不再在这里指定：与 24h 图一样取自 CSS 容器（见 drawMultiSeriesChart）
      leftAxisRange: cfg.range || undefined,
       leftAxisBounds: cfg.bounds || undefined,
       leftAxisMinSpan: cfg.minSpan || undefined,
       leftAxisColor: cfg.color,
       leftAxisFormatter: cfg.axisFormatter,
       band,
       rangeBars: cfg.key === 'temp',
       selIdx: state.dailySelIdx,
     });

     saveDailyRecordsCache(records, state.activeDeviceId);
   }
 
   // 中文：视图切换的唯一入口——'trend'(24h 逐条) / 'daily'(7D、30D 日均)。
   //      tab 式双按钮 + 面板内的范围控件已合并成顶部一排三个等权按钮，
   //      所以选中态统一交给 updateChartViewButtons()，这里只负责面板与重绘。
   function switchChartView(view) {
     const isTrend = view === 'trend';
     els.trendTabPanel.classList.toggle('hidden', !isTrend);
     els.dailyTabPanel.classList.toggle('hidden', isTrend);
     updateChartViewButtons();

     if (isTrend) {
       if (state.lastRecords) drawChart(state.lastRecords);
       return;
     }
     if (state.lastDailyRecords) {
       renderDaily(state.lastDailyRecords);
     } else {
       updateDailyMetricButtons();
       updateDailyNote(activeDailyRange());
       els.dailyEmpty?.classList.remove('hidden');
       els.dailyNote?.classList.add('hidden');
     }
   }

   function setDailyMetric(metric) {
     if (!DAILY_METRICS[metric]) return;
     state.dailyMetric = metric;
     updateDailyMetricButtons();
     if (state.lastDailyRecords && !els.dailyTabPanel.classList.contains('hidden')) {
       renderDaily(state.lastDailyRecords);
     }
   }
 
   function setMainTabBtn(btn, active) {
     btn.className = active ? 'main-tab-btn main-tab-active' : 'main-tab-btn';
     btn.setAttribute('aria-selected', active ? 'true' : 'false');
   }

   function switchMainTab(tab) {
     const isData = tab === 'data';
     const isGuide = tab === 'guide';
     const isSetting = tab === 'setting';
     if (isSetting && els.mainTabSettingBtn.disabled && !state.otaJustSucceeded) return;  // setting 仅连接后可点（OTA 成功展示期允许程序化切回）
     // 中文：OTA 升级进行中禁止切离 Setting 页（按钮置灰之外的逻辑兜底，拦截程序化切换）
     if (state.otaRunning && !isSetting) return;
     // 中文：用户主动切离 Setting 后，OTA 成功提示使命完成，恢复断链后“切回 Data”的默认行为
     if (!isSetting) state.otaJustSucceeded = false;
     els.mainTabDataPanel.classList.toggle('hidden', !isData);
     els.mainTabGuidePanel.classList.toggle('hidden', !isGuide);
     els.mainTabSettingPanel.classList.toggle('hidden', !isSetting);
     setMainTabBtn(els.mainTabDataBtn, isData);
     setMainTabBtn(els.mainTabGuideBtn, isGuide);
     setMainTabBtn(els.mainTabSettingBtn, isSetting);

     // Data 面板内含 canvas，隐藏时宽度为 0；切到该面板时需按当前子标签重绘图表
     if (isData) {
       if (!els.trendTabPanel.classList.contains('hidden')) {
         if (state.lastRecords) drawChart(state.lastRecords);
       } else if (!els.dailyTabPanel.classList.contains('hidden')) {
         if (state.lastDailyRecords) renderDaily(state.lastDailyRecords);
       }
     }
   }

   async function readDaily() {
     let from30 = [];
     let from7 = [];

     // 7 天（0xFFE3，RAM 环）：与 30 天合并，兜住"当天刚结算、Flash 还没追加"的边界，
     // 且 RAM 值更新更及时（同一天以它为准）。
     if (state.dailyChar) {
       const val = await state.dailyChar.readValue();
       from7 = BLEProtocol.parseDailyPacket(val);
     }

    // 30 天（0xFFED，设备 Flash 日志）：一次读 184B 拿最多 30 天，跨掉电/换电池存活。
    // 包头自带设备时区，不需要再从 0xFFE3 反推（换电池后 0xFFE3 是空的）。
    if (state.daily30Char) {
      try {
        const val = await state.daily30Char.readValue();
        from30 = BLEProtocol.parseDaily30Packet(val);
      } catch (err) {
        log(`Daily30 read failed: ${err.message}`);
      }
    }

    // 30 天温度极值（0xFFEE，新固件专有）：124B 单次读完，无需分块。
    // 旧固件没有该特征 → daily30ExtChar 为 null，静默降级为"只画均值"。
    let extMap = null;
    if (state.daily30ExtChar) {
      try {
        const val = await state.daily30ExtChar.readValue();
        const extRecs = BLEProtocol.parseDaily30ExtPacket(val);
        extMap = new Map(extRecs.map(e => [e.dateEpoch, e]));
      } catch (err) {
        log(`Daily30Ext read failed: ${err.message}`);
      }
    }

    if (!from30.length && !from7.length && !state.daily30Char && !state.dailyChar) return;

    const merged = mergeDailyRecords(from30, from7);
    // 中文：极值必须在 merge 之后按 dateEpoch 挂——同日以 0xFFE3(RAM 环) 为准，
    //      它会整条覆盖 0xFFED 的同一天记录；先挂再 merge 会让最近 7 天的极值被冲掉
    attachDailyExt(merged, extMap);

    const records = sanitizeDailyRecords(merged);
    const dropped = merged.length - records.length;
    if (dropped > 0) {
      log(`Daily read filtered ${dropped} invalid record(s)`);
    }
    log(`Daily read: ${records.length} day(s) (30d=${from30.length}, 7d=${from7.length}, ext=${extMap ? extMap.size : 0})`);
    renderDaily(records);
   }
 
 
   async function readData() {
     if (!state.characteristic) return;
     const val = await state.characteristic.readValue();
     const hex = BLEProtocol.hexDump(val);
     try {
       const records = BLEProtocol.parsePacket(val);
       log(`Read ${val.byteLength} bytes (Hex: ${hex})`);
       render(records);
     } catch (err) {
       log(`Read Parse Error: ${err.message}`);
     }
 
     await readDaily().catch(err => log(`Daily read failed: ${err.message}`));
   }
 
   function startPolling() {
     stopPolling();
     // 中文：轮询开关独立于日志开关（POLL_ENABLED）——轮询承担"读数据兜底 + 断链 UI 校正"
     //       职责，发版必须常开；DEBUG_ENABLED 只控制 log() 的 console 输出
     if (!POLL_ENABLED) return;
     let probing = false;   // 中文：上一轮探活未结束时跳过本拍（探活最坏 3 次 × (5s 超时 + 700ms)）
     state.pollTimer = setInterval(async () => {
        if (!state.characteristic) return;
        // OTA 升级进行中：暂停轮询读数，避免与升级流量抢占连接事件拖慢传输
        if (state.otaRunning) return;
        // 重入保护：上一轮探活未结束，或其他 GATT 操作（按钮写/Refresh 轮询）进行中时跳过本拍，
        // 防止安卓操作重叠报错（全局 GATT 互斥）
        if (probing || state.gattBusy) return;
        // 存活探测直接复用 probeLinkAlive（同一把锁、同一套重试/裁决逻辑，不再重复实现）：
        //   返回 latest 记录 → 链路活且顺便刷新实时卡片
        //   返回 true       → 旧固件无 0xFFEB，仅确认存活
        //   返回 false      → 探活 3 连败，链路确死，复位 UI
        probing = true;
        try {
          const result = await probeLinkAlive();
          if (!result) {
            onDisconnected();
          } else if (result !== true) {
            applyLatestRecord(result);
          }
        } finally {
          probing = false;
        }
      }, POLL_INTERVAL);
   }
 
   function stopPolling() {
     if (state.pollTimer) {
       clearInterval(state.pollTimer);
       state.pollTimer = null;
     }
   }

  // —— 连接空闲提醒（与固件 SOIL_CONN_IDLE_TIMEOUT_S=240 配合）——
  // 设备端：240s 内没有任何读写就主动断链回睡眠（省电，防止连上后忘断开）。
  // web 端：180s 无续命就弹窗倒计时 30s 问"还要不要连着"：
  //        · 点 Keep connected → 写 0xFFE7 续命，重新计时
  //        · 点 Let it sleep / 什么都不做让倒计时归零 → **立即断开**
  //        「问了就得有结果」——弹窗既然带了倒计时，归零就该落地下线，而不是把决定权
  //        再甩给设备的 240s 超时（那样用户等两分多钟还连着，跟没做这个功能一样）。
  //        设备侧 240s 仍然保留，覆盖"页面被切后台/被系统杀掉"这类 web 无法执行的情况。
  // 只有**能清零设备 idle 的写操作**（Refresh/Apply/校准/Clear/改名）成功后才重新计时；
  // 轮询的读不算（设备端也不认读），否则 5s 一次的轮询会让提醒永远不出现。
  function clearIdleWatch() {
    if (state.idleTimer) { clearTimeout(state.idleTimer); state.idleTimer = null; }
    if (state.idleTickTimer) { clearInterval(state.idleTickTimer); state.idleTickTimer = null; }
    hideIdlePrompt();
  }

  function hideIdlePrompt() {
    if (els.idlePrompt) els.idlePrompt.classList.add('hidden');
    if (els.idlePrompt) els.idlePrompt.classList.remove('flex');
  }

  /** 重新开始 180s 计时。必须在"设备侧 idle 被清零"之后调用，否则提醒会早于设备超时。 */
  function armIdleWatch() {
    clearIdleWatch();
    state.idleSleepExpected = false;
    if (!state.device?.gatt.connected || state.otaRunning) return;
    // 页面在后台时不装定时器：隐藏期间不会有人点"保持连接"，装上也只会在恢复时补一次误报；
    // 隐藏期间设备 240s 自然断，回到前台由 visibilitychange 重新装
    if (document.visibilityState !== 'visible') return;
    state.idleTimer = setTimeout(showIdlePrompt, IDLE_WARN_MS);
  }

  function showIdlePrompt() {
    state.idleTimer = null;
    // 到点时若已断开 / 正在 OTA / 页面被隐藏，都不打扰
    if (!state.device?.gatt.connected || state.otaRunning) return;
    if (document.visibilityState !== 'visible') return;
    if (!els.idlePrompt) return;
    state.idleLeft = IDLE_GRACE_S;
    els.idleCountdown.textContent = String(state.idleLeft);
    els.idlePrompt.classList.remove('hidden');
    els.idlePrompt.classList.add('flex');
    // 焦点落在主按钮（Let it sleep = 倒计时归零的默认结果）：
    // 键盘 Enter/空格得到的动作与"不理会"一致，读屏用户也先听到默认选项
    try { els.idleSleepBtn?.focus({ preventScroll: true }); } catch (_) { /* 老浏览器忽略 */ }
    state.idleTickTimer = setInterval(() => {
      state.idleLeft -= 1;
      if (state.idleLeft > 0) {
        els.idleCountdown.textContent = String(state.idleLeft);
        return;
      }
      // 倒计时归零 = 用户没做选择：按"默认休眠"处理，立即断开（等同点 Let it sleep）
      log('Idle countdown expired — no response, disconnecting now');
      idleSleepNow();
    }, 1000);
    log('Idle 3 min — asking whether to keep the link alive');
  }

  /** 点「Keep connected」：写一次 0xFFE7（固件收到即清零 idle 计时），然后重新计时 */
  async function idleKeepAlive() {
    if (!state.device?.gatt.connected || !state.refreshChar) { clearIdleWatch(); return; }
    els.idleKeepBtn.disabled = true;
    try {
      await gattOp(() => BLEProtocol.sendRefresh(state.refreshChar), 'Idle keep-alive refresh (0xFFE7)');
      armIdleWatch();
      log('Link kept alive (0xFFE7), idle timer restarted');
    } catch (err) {
      clearIdleWatch();
      log(`Keep-alive failed: ${err.message || err}`);
    } finally {
      els.idleKeepBtn.disabled = false;
    }
  }

  /** 点「Let it sleep」/ 倒计时归零：立即断开，比等设备 240s 超时更省电，也让用户所见即所得 */
  function idleSleepNow() {
    clearIdleWatch();
    state.idleSleepExpected = true;   // 归入"预期内休眠断链"：不当故障处理，状态词仍是 Disconnected
    log('Idle sleep — disconnecting now');
    forceDisconnect('idle sleep');
  }

  els.idleKeepBtn?.addEventListener('click', idleKeepAlive);
  els.idleSleepBtn?.addEventListener('click', idleSleepNow);

   function onDisconnected() {
      // 重入保护：gattserverdisconnected 事件 / 轮询 / forceDisconnect / visibilitychange
      // 可能并发触发，第一个进入的路径执行清理，后续直接返回（避免重复日志/重复复位）
      if (state.disconnecting) return;
      // 幂等保护：已被其它路径清理过（轮询 / visibilitychange / 用户点击）则直接返回
      if (state.characteristic === null && state.device === null) return;
      state.disconnecting = true;
      try {
        clearIdleWatch();      // 先收起空闲提醒弹窗/定时器，避免断开后还挂着一个"要不要保持连接"
        stopPolling();         // 先停定时器：防止清理期间轮询再跑一拍（断开后 GATT 报错噪音的来源）
        cancelRefreshWait();   // 若 refresh 正在等待测量结果，断连后立即恢复按钮
        state.otaRunning = false;
        setConnectBusy(false);   // 断开完成：解锁 Connect 按钮
        setOtaUiLock(false);
        // 中文：休眠断链状态词仍显示 Disconnected——web 主动断开后并不知道设备
        //      是否真睡了（它按自己的节奏进睡眠），"Asleep" 是替设备下的结论，
        //      描述不准确；是否预期内断开只在日志里区分（下方 log）。
        setStatus('disconnected');
        syncBatteryPill();
        state.characteristic = null;   // 中文：显式置空，与 device 双 null 闭合幂等条件
        state.dailyChar = null;
        // 中文：断开时移除 0xFFEB notify 监听，避免重连复用特征对象时叠加监听导致 notify 重复处理
        if (state.latestChar && state.latestNotifySubscribed) {
          state.latestChar.removeEventListener('characteristicvaluechanged', onLatestNotified);
          state.latestNotifySubscribed = false;
        }
        state.lastNotifiedRec = null;   // 清理历史 notify 基线，重连后重新建立
        state.latestChar = null;
        state.devNameChar = null;
        state.device = null;   // 释放旧 device 引用：断链后 connectBtn/visibilitychange 判断自然失效
        state.resetChar = null;
        state.calibChar = null;
        state.refreshChar = null;
        state.tempOffsetChar = null;
        state.tempOffsetX100 = 0;
        state.calibStatusChar = null;
        state.otaChar = null;
        state.otaRunning = false;
        state.fwUpdate = null;
        renderFirmwareCard();
        // 断开后隐藏"已校准"徽标；设备名保留展示（最近一次连接的设备名，不随断开隐藏）
        renderCalibHints(null);
        if (els.devNameStatus) els.devNameStatus.textContent = '';
        log(state.idleSleepExpected
          ? 'Device disconnected — idle sleep'
          : 'Device disconnected');
      } finally {
        state.disconnecting = false;
      }
    }
 
   // 剪贴板写入（iOS Safari 兼容）：优先 Clipboard API（要求 HTTPS + 在用户手势内调用），
   // 失败或不可用时回退到隐藏 textarea + document.execCommand('copy') 的同步复制方案。
   // standalone（添加到主屏幕的 App 模式）在 iOS 上不支持 Web Bluetooth（beacio 扩展也不注入）。
   // 此函数用于各平台引导弹窗（guideIosStandalone / guideBluefy / guideDesktopChrome）里分流提示用户回 Safari/Chrome 连接；与 PWA 安装引导无关。
   const isStandalone = () =>
     window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
   async function copyTextToClipboard(text) {
     if (navigator.clipboard && navigator.clipboard.writeText) {
       try {
         await navigator.clipboard.writeText(text);
         return true;
       } catch (_) {
         // 忽略异常，走 legacy 兜底方案
       }
     }
     return copyTextLegacy(text);
   }

   function copyTextLegacy(text) {
     const textarea = document.createElement('textarea');
     textarea.value = text;
     textarea.setAttribute('readonly', '');
     // 移出可视区域，避免页面滚动和 iOS 键盘弹出
     textarea.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
     document.body.appendChild(textarea);
     const selection = document.getSelection();
     const savedRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
     textarea.focus();
     textarea.setSelectionRange(0, text.length);
     let ok = false;
     try {
       ok = document.execCommand('copy');
     } catch (_) {
       ok = false;
     }
     document.body.removeChild(textarea);
     // 恢复用户原来的文本选区
     if (selection && savedRange) {
       selection.removeAllRanges();
       selection.addRange(savedRange);
     }
     return ok;
   }

    // 从 UA 解析 iOS 主版本号。注意 iOS 26+ 的 UA 里 "iPhone OS xx like Mac OS X"
   // 仍报旧基线号（如 18_7），真实系统版本在 "Version/26.x"（Safari 版本号≈iOS 主版本），
   // 因此优先取 Version/；取不到再退回 "OS xx like Mac OS X"。非 iOS 返回 null。
   function parseIOSVersion(ua) {
     const v = /Version\/([\d_.]+)/.exec(ua);
     if (v) return parseFloat(v[1].replace(/_/g, '.'));
     const m = /OS ([\d_]+) like Mac OS X/.exec(ua);
     return m ? parseFloat(m[1].replace(/_/g, '.')) : null;
   }

  // ===== 自研 beacio 探测（2026-10-12 重构：移除一次性闩锁缓存，改为按需无状态探测）=====
  // 核心事实：beacio 是 Safari Web Extension，navigator.bluetooth 由其 content script 注入。
  // iOS 锁屏时 Safari 挂起页面进程，唤醒后从内存快照恢复页面（不重载、JS 闭包状态保留），
  // 但扩展桥的注入需要重建——历史上"检测只跑一次、结果长期可信"的闩锁缓存（beacioL /
  // beacioX / beacioFinalized / beacioDetectStarted）在唤醒后变成陈旧毒药：点 Connect 时
  // 要么误判"未装 beacio"弹引导，要么调到未就绪的 polyfill 静默失败（蓝牙授权/设备选择器
  // 弹窗偶现不出现）。现改为点击 Connect 时实时探测：快路径三种官方就绪信号任一命中即真；
  // 否则 ping/pong + ready 事件等待至多 timeoutMs（覆盖唤醒后扩展桥恢复竞态）。
  // 无状态：每次调用都是全新探测，settle 时自清理监听与定时器，可安全重复调用。
  const BEACIO_ONBOARDING_START = 'https://link.beacio.com/onboarding-start';
  function probeBeacioReady(timeoutMs = 500) {
    try {
      if (document.documentElement.dataset.beacioExtension === 'true') return Promise.resolve(true);
    } catch (e) {}
    if (navigator.beacio !== undefined || navigator.bluetooth) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const nonce = 'beacio-ping-' + Date.now() + '-' + Math.random().toString(16).slice(2);
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        window.removeEventListener('beacio:extension:ready', onReady);
        window.removeEventListener('beacio:extension:pong', onPong);
        clearTimeout(pingTimer);
        clearTimeout(timer);
        resolve(ok);
      };
      const onReady = () => finish(true);
      const onPong = (e) => {
        const d = e.detail;
        if (d && d.nonce === nonce) finish(true);
      };
      window.addEventListener('beacio:extension:ready', onReady);
      window.addEventListener('beacio:extension:pong', onPong);
      // ping/pong 握手：nonce 匹配，最多 5 次 ×100ms（对齐官方握手协议）
      let n = 0;
      let pingTimer = 0;
      const sendPing = () => {
        if (settled) return;
        n += 1;
        try { window.dispatchEvent(new CustomEvent('beacio:extension:ping', { detail: { nonce } })); } catch (e) {}
        if (n < 5) pingTimer = setTimeout(sendPing, 100);
      };
      pingTimer = setTimeout(sendPing, 0);
      const timer = setTimeout(() => finish(false), timeoutMs);
    });
  }

  // 等待 beacio 重新注入（方案A）：后台切回时扩展注入可能被系统挂起，navigator.bluetooth 瞬时不可用。
  // 重新触发自研握手并等待恢复：① navigator.bluetooth 出现；② beacio:extension:ready 事件；
  // ③ ping/pong 握手成功（beacioL）。超时未恢复返回 false，由 ensureIosEnv 走正常引导。
  // 【崩溃修复】2026-10-12 无状态探测重构删除了 startBeacioDetect/beacioL，但本函数仍引用
  // → 点 Connect 抛 "Can't find variable: startBeacioDetect"（unhandledrejection）。
  // probeBeacioReady 已覆盖全部等待语义（dataset 注入标记 / navigator.beacio / navigator.bluetooth
  // 快信号 + beacio:extension:ready 事件 + ping/pong 握手），直接委托即可
  function waitBeacioActive(timeoutMs) {
    return probeBeacioReady(timeoutMs);
  }

  function beacioGotoOnboarding() {
    // 双按钮知情分流（替代探测法）：iOS Safari 不允许脚本关闭探测标签（popup.close 被忽略），
    // 探测会在未装时残留 setup.html 标签；改为让用户自述已装/未装，主站页面永不导航走：
    //   · 已安装 → 顶层跳 onboarding-start：已装 → iOS 拦截拉起 beacio app 强引导开启（Safari 标签保留，页面不丢）
    //   · 未安装 → 直接 App Store 商品页（零 setup，页面不丢）
    const oldWrap = document.getElementById('beacioDualBtns');
    if (oldWrap) oldWrap.remove();
    const wrapper = document.createElement('div');
    wrapper.id = 'beacioDualBtns';
    wrapper.style.cssText = 'margin-top:12px;display:flex;flex-direction:column;gap:8px;';
    wrapper.innerHTML =
      '<button id="beacioInstalledBtn" type="button" style="display:block;width:100%;padding:10px 12px;font-size:14px;font-weight:600;border:none;border-radius:8px;background:#16a34a;color:#fff;cursor:pointer;">Yes, installed — guide me to enable it</button>' +
      '<button id="beacioNotInstalledBtn" type="button" style="display:block;width:100%;padding:10px 12px;font-size:14px;font-weight:600;border:none;border-radius:8px;background:#2563eb;color:#fff;cursor:pointer;">No, not installed — go to App Store</button>';
    els.modalActionBtn.classList.add('hidden');
    els.modalActionBtn.parentNode.insertBefore(wrapper, els.modalActionBtn);
    els.modal.classList.remove('hidden');
    els.modal.classList.add('flex');
    document.getElementById('beacioInstalledBtn').addEventListener('click', () => {
      let u;
      try {
        u = new URL(BEACIO_ONBOARDING_START);
        u.searchParams.set('origin', window.location.origin);
        u.searchParams.set('source', 'request-device');
        u.searchParams.set('url', window.location.href);
        u.searchParams.set('return', 'https://link.beacio.com/return?url=' + encodeURIComponent(window.location.href));
      } catch (e) {
        beacioShowInstallGuide();
        return;
      }
      window.location.href = u.toString();
    });
    document.getElementById('beacioNotInstalledBtn').addEventListener('click', () => {
      window.location.href = BEACIO_APPSTORE_URL;
    });
  }

  // 安装引导弹窗：仅兜底场景使用（onboarding-start URL 构造失败等异常）。
  // 复用 showGuideModal：标题/文案/按钮换成安装指引 + App Store 链接（用户主动点击才跳转）
  function beacioShowInstallGuide() {
    showGuideModal({
      iconHtml: GUIDE_LOGO_ICON,
      title: 'Bluetooth needs beacio',
      message: 'The beacio Safari extension does not appear to be installed on this iPhone or iPad. To connect, install the free beacio extension (iOS/iPadOS 26.2+), then enable it: tap the "aA" icon in the address bar → Manage Extensions → turn on beacio → choose "Allow on Every Website", then refresh this page and tap Connect.',
      action: { text: 'Install beacio (free)', href: BEACIO_APPSTORE_URL },
    });
  }

  // iOS 上所有浏览器壳都是 WKWebView、UA 都以 Safari 结尾，用排除法识别原生 Safari。
  // beacio 是 Safari 扩展、仅在原生 Safari 生效；Bluefy 等自带真实 Web Bluetooth 的浏览器
  // 应直接走连接、不进入 beacio/Bluefy 引导，故一并排除（Bluefy UA 含 "Bluefy"）。
  function isNativeSafari() {
    const ua = navigator.userAgent;
    return /Safari/i.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|Aviator|Mercury|DuckDuckGo|Bluefy|wv|WebView/i.test(ua);
  }

   // showModal 已移除：平台引导统一由 ensureBluetoothEnv / showGuideModal / guide* 系列处理（见原 canUseBluetooth 位置）
 
let connectToken = 0;   // 用于丢弃“超时/失败后又迟到成功”的连接，防止幽灵状态

// 连接失败/超时的红字提示：显示在状态卡下方独立行（不覆盖状态行文字）；
// 新的连接尝试开始（clearConnectError）或连接成功后清除
function showConnectError(msg) {
  if (!els.connectErrorText) return;
  els.connectErrorText.textContent = msg;
  els.connectErrorText.classList.remove('hidden');
}

function clearConnectError() {
  if (!els.connectErrorText) return;
  els.connectErrorText.textContent = '';
  els.connectErrorText.classList.add('hidden');
}

   // ===== 平台判定与浏览器引导（平台优先重构：全链路只判一次平台，加载/点击共用同一闸门） =====

   // 平台判定：ios / android / desktop。iOS 用排除法（所有 iOS 浏览器壳 UA 都含 Safari，
   // MSStream 排除旧 Edge）；iPadOS 桌面级 UA（Macintosh，Chrome/Safari 默认"桌面模式"）
   // 通过触屏信号识别后归入 ios，与 iPhone 走同一套 Safari/beacio/Bluefy 升级引导——
   // Mac 真机没有触摸屏（maxTouchPoints=0），iPad 触屏 maxTouchPoints≥5，
   // maxTouchPoints>1 即可无歧义区分。若归入 desktop，iPad Chrome 会弹桌面"Copy Link"
   // 引导，无法利用 x-safari-https 深链与 beacio/Bluefy 路径，OTA 引导链路断裂。
   function detectPlatform() {
     const ua = navigator.userAgent;
     if (/iPad|iPhone|iPod/.test(ua) && !window.MSStream) return 'ios';
     if (/Android/.test(ua)) return 'android';
     if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return 'ios';   // iPadOS 桌面级 UA
     return 'desktop';
   }


   // UA-CH 品牌精确识别：真实 Chrome 上报 "Google Chrome"、Edge 上报 "Microsoft Edge"，
   // 其余 Chromium 系浏览器（Brave/Opera/Vivaldi/Arc/微信 XWeb/三星 等）只报自己或 Chromium。
   // 返回 true/false = 品牌判定结果；null = UA-CH 不可用（旧内核），无法判定品牌。
   function isTrustedChromiumBrand() {
     const uad = navigator.userAgentData;
     if (uad && Array.isArray(uad.brands)) {
       return uad.brands.some((b) => /^(Google Chrome|Microsoft Edge)$/i.test((b && b.brand) || ''));
     }
     return null;
   }

   // 浏览器白名单：Android 与桌面均只信任 Google Chrome / Microsoft Edge。
   // iOS 的 Safari/Bluefy 判定在 ensureBluetoothEnv 内单独做（本函数只处理 android/desktop）。
   // 已知第三方浏览器 UA 标记：安卓国产/厂商浏览器全部为 Chromium 内核、UA 同样携带
   // "Chrome/xxx"，仅凭 /(Chrome|Edg)/ 会误放行 UC / QQ / 夸克 / 小米 / Vivo / OPPO / 华为
   // 等"假支持"浏览器，须整表排除（新增浏览器时在此追加标记即可）。
   const THIRD_PARTY_BROWSER_UA_RE = /(MicroMessenger|SamsungBrowser|OPR|Opera|UCBrowser|UCWEB|MQQBrowser|QQBrowser|Quark|baidubrowser|baiduboxapp|MiuiBrowser|VivoBrowser|HeyTapBrowser|HuaweiBrowser|HiBrowser|DuckDuckGo)/i;

   // Android：Chromium 标记 + 排除第三方 + UA-CH 品牌判定，三级过滤
   function isAllowedAndroidBrowser() {
     const ua = navigator.userAgent;
     if (THIRD_PARTY_BROWSER_UA_RE.test(ua)) {
       log('[gate] android: third-party browser UA → blocked (fake Web Bluetooth)');
       return false;   // 微信/三星/UC/QQ/小米…假支持
     }
     const isChromium = /(Chrome|Edg)/i.test(ua) && !/wv/i.test(ua) && !/WebView/i.test(ua);
     if (!isChromium) {
       log('[gate] android: non-Chromium UA → blocked');
       return false;                                         // Firefox 等非 Chromium
     }
     const brand = isTrustedChromiumBrand();
     log(`[gate] android: UA-CH brand check=${brand}`);      // null（无 UA-CH）= 旧内核回退放行
     return brand !== false;
   }

   // 桌面：真实 API（排除 Safari/Firefox）+ 品牌收紧到 Chrome/Edge
   //（Brave/Opera/Vivaldi/Arc 等有真实 API 但非白名单品牌 → 引导换 Chrome）；
   // 无 UA-CH 的旧内核 Chromium 回退能力判定放行，避免误杀
   function isAllowedDesktopBrowser() {
     if (!navigator.bluetooth) {
       log('[gate] desktop: no navigator.bluetooth (Safari/Firefox or non-secure context) → blocked');
       return false;
     }
     const brand = isTrustedChromiumBrand();
     log(`[gate] desktop: UA-CH brand check=${brand}`);      // null（无 UA-CH）= 回退放行
     return brand !== false;
   }

   function isBrowserAllowed(platform) {
     return platform === 'android' ? isAllowedAndroidBrowser() : isAllowedDesktopBrowser();
   }

   // 兼容性引导弹窗统一渲染：一次调用设置图标/标题/文案/按钮并显示 modal
   const GUIDE_LOGO_ICON = '<img src="./page/images/alinfancy-logo.svg" alt="logo" class="w-8 h-8 mx-auto" />';
   function showGuideModal({ iconHtml, title, message, action, hideAction = false }) {
     if (iconHtml !== undefined) els.modalIcon.innerHTML = iconHtml;
     els.modalTitle.textContent = title;
     els.modalMessage.textContent = message;
     els.modalActionBtn.onclick = null;
     if (hideAction || !action) {
       els.modalActionBtn.classList.add('hidden');
     } else {
       els.modalActionBtn.textContent = action.text;
       els.modalActionBtn.href = action.href || '#';
       els.modalActionBtn.onclick = action.onClick || null;
       els.modalActionBtn.classList.remove('hidden');
     }
     els.modal.classList.remove('hidden');
     els.modal.classList.add('flex');
   }

   // 复制 Dashboard 链接（iOS Safari 只允许用户手势内写剪贴板，加 400ms 超时兜底）。
   // standalone / Bluefy / 桌面三处引导共用。
   function copyDashboardLink() {
     return Promise.race([
       copyTextToClipboard(window.location.href),
       new Promise((resolve) => setTimeout(() => resolve(false), 400)),
     ]);
   }

   // iOS：非原生 Safari（Chrome iOS 等壳）→ x-safari-https 带当前页 URL 跳 Safari（iOS 17+，
   // 免复制粘贴）。x-safari-https 为 iOS 唤起 Safari 的私有 scheme，需真机回归。
   function guideIosNonSafari() {
     showGuideModal({
       iconHtml: GUIDE_LOGO_ICON,
       title: 'Open in Safari to Connect',
       message: 'Your iPhone or iPad does not support Web Bluetooth in this browser. Tap "Open in Safari" to switch to the Safari browser and connect.',
       action: {
         text: 'Open in Safari',
         onClick: (e) => {
           e.preventDefault();
           window.location.href = 'x-safari-https://' + window.location.href.replace(/^https?:\/\//i, '');
         },
       },
     });
   }

   // iOS：standalone（添加到主屏幕的 App 模式）不支持 Web Bluetooth，复制链接引导回 Safari。
   // iOS 平台限制：standalone 无法程序化打开完整 Safari 标签页，复制链接是最可靠方案。
   function guideIosStandalone() {
     showGuideModal({
       iconHtml: GUIDE_LOGO_ICON,
       title: 'Open in Safari to Connect',
       message: `This App mode on iPhone or iPad can't use Web Bluetooth. Tap "Copy Link", then open it in the Safari browser and tap Connect there. Tip: if you want to keep this page on your Home Screen, uncheck "Open as Web App" when adding it, so it opens in Safari with Bluetooth available.`,
       action: {
         text: 'Copy Link',
         onClick: async (e) => {
           e.preventDefault();
           const copied = await copyDashboardLink();
           els.modalMessage.textContent = copied
             ? '✅ Link copied. Now open the Safari browser, paste this address in the address bar and tap Connect.'
             : `Please open Safari and manually enter this address: ${window.location.href}`;
           els.modalActionBtn.classList.add('hidden');
         },
       },
     });
   }

   // iOS ≥26.2 Safari：beacio 引导（双按钮知情分流，用户自述已装/未装）。
   // 页面层无法区分"已装未开"与"未装"；且能进入本引导时 beacio 必然未注入（active 时
   // navigator.bluetooth 已存在、不会走到这里），无需再做握手等待（原 waitFinal 死逻辑已删）。
   function guideBeacio() {
     showGuideModal({
       iconHtml: GUIDE_LOGO_ICON,
       title: 'Bluetooth needs beacio',
       message: 'To connect on iPhone or iPad, the free beacio Safari extension (iOS/iPadOS 26.2+) must be installed and enabled. Have you installed beacio before? Choose the first option only if you really installed it before — after enabling or installing, return here, refresh the page, and tap Connect again.',
       hideAction: true,
     });
     beacioGotoOnboarding();
   }

   // iOS <26.2 Safari：Bluefy 引导。先复制链接，再尝试 bluefy:// 深链直接加载 Dashboard；
   // 2.5s 后页面仍在前台说明未安装（已安装时 pagehide 清除定时器），回退 App Store。
   function guideBluefy() {
     showGuideModal({
       iconHtml: GUIDE_LOGO_ICON,
       title: 'Bluetooth Unavailable in Browser',
       message: 'iOS Browser does not support Web Bluetooth. Tap "Open in Bluefy" to continue — the dashboard link will be copied to your clipboard so you can paste it into Bluefy after installing.',
       action: {
         text: 'Open in Bluefy',
         onClick: async (e) => {
           e.preventDefault();
           const copied = await copyDashboardLink();
           els.modalMessage.textContent = copied
             ? '✅ Dashboard link copied to clipboard. Opening Bluefy… If it is not installed, you will be taken to the App Store — after installing, open Bluefy and paste the link to continue.'
             : `After installing Bluefy from the App Store, open it and manually enter this address: ${window.location.href}`;
           const start = Date.now();
           const fallback = setTimeout(() => {
             if (!document.hidden && Date.now() - start < 5000) {
               window.location.href = BLUEFY_APPSTORE_URL;
             }
           }, 2500);
           window.addEventListener('pagehide', () => clearTimeout(fallback), { once: true });
           window.location.href = BLUEFY_DEEPLINK;
         },
       },
     });
   }

   // Android：非 Chrome/Edge → intent:// scheme 拉起 Chrome 并携带当前页 URL（免复制粘贴）；
   // 未安装 Chrome 时由 S.browser_fallback_url 自动落到 Play 商店页面（无需显式探测安装）。
   function guideAndroidChrome() {
     const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.android.chrome';
     let intentUrl = null;
     try {
       const u = new URL(window.location.href);
       // 去掉 fragment，避免与 #Intent 声明冲突
       const clean = (u.origin + u.pathname + u.search).replace(/^https?:\/\//i, '');
       intentUrl = 'intent://' + clean + '#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=' + encodeURIComponent(PLAY_STORE_URL) + ';end';
     } catch (_) { /* URL 构造失败时退回纯 Play 商店按钮 */ }
     showGuideModal({
       iconHtml: GUIDE_LOGO_ICON,
       title: 'Open in Chrome to Connect',
       message: intentUrl
         ? 'This browser does not support Web Bluetooth reliably. Turn on Bluetooth, then tap "Open in Chrome" — this page will open in Chrome automatically. If Chrome is not installed, you will be taken to its Play Store page.'
         : 'Turn on Bluetooth, then open this page in Google Chrome to connect your sensor.',
       action: intentUrl
         ? { text: 'Open in Chrome', onClick: (e) => { e.preventDefault(); window.location.href = intentUrl; } }
         : { text: 'Get Chrome on Google Play', href: PLAY_STORE_URL },
     });
   }

   // 桌面：浏览器沙箱无法探测已装浏览器、也无法带 URL 拉起其他浏览器，
   // 剪贴板是体验上限：主动写入链接 + 引导用户手动用 Chrome 打开。
   function guideDesktopChrome() {
     showGuideModal({
       iconHtml: '💻',
       title: 'Web Bluetooth Unavailable',
       message: 'Please use Google Chrome to access this site. Tap "Copy Link", then paste it in Chrome and connect there.',
       action: {
         text: 'Copy Link',
         onClick: async (e) => {
           e.preventDefault();
           const copied = await copyDashboardLink();
           els.modalMessage.textContent = copied
             ? '✅ Link copied. Now open Google Chrome, paste this address in the address bar and tap Connect.'
             : `Please open Google Chrome and manually enter this address: ${window.location.href}`;
           els.modalActionBtn.classList.add('hidden');
         },
       },
     });
   }

   // Bluefy（iOS App Store 的 Web BLE 浏览器）：自带真实 Web Bluetooth 实现，UA 含
   // "Bluefy" 标识、isNativeSafari 会排除它；只要 API 存在即直连，不引导去 Safari。
   function isBluefy() {
     return /Bluefy/i.test(navigator.userAgent);
   }

   // ===== 环境闸门（页面加载与点击 Connect 共用） =====
   // 返回 true = 环境可直连（进入连接执行层）；false = 已弹出对应平台引导（不应继续连接）。
   // iOS 判定顺序（Safari 优先 + Bluefy 特判）：② Bluefy 自带真实 API → ③ 原生 Safari?
   // → ④ navigator.bluetooth（beacio active 注入为真直接放行）→ ⑤ standalone / beacio /
   // Bluefy 三条路。
   // iOS 点击 Connect 时的全量判定（②～⑤ 级联；④⑤ 依赖 beacio 注入 / standalone 等
   // 运行时状态，统一延迟到点击时执行，不在页面加载时判定）
   // async：④' 的 beacio 注入等待（probeBeacioReady）需要 await；调用方须 await 本函数
   async function ensureIosEnv() {
     if (isBluefy() && navigator.bluetooth) { log('[gate] ios: Bluefy + API → direct'); return true; }   // ② Bluefy 直连
     if (!isNativeSafari()) { log('[gate] ios: non-native-Safari shell → x-safari guide'); guideIosNonSafari(); return false; }   // ③ Safari 优先（iPhone/iPad 同逻辑：iPadOS 17+ 的 x-safari 深链同样可用）
     if (navigator.bluetooth) { log('[gate] ios: Safari + API (beacio active) → direct'); return true; }   // ④ beacio active 注入 → 直连
     // ④' 唤醒恢复竞态兜底：锁屏唤醒后 Safari 从内存快照恢复页面，beacio 扩展桥可能尚未
     // 重新注入 navigator.bluetooth——立即判负会把已装用户误导向 beacio 引导。此处等待至多
     // 500ms 再判；WebKit transient activation 窗口约 5s，等待不消耗点击手势，
     // 探测通过后同一次点击链路里的 requestDevice 仍然有效
     if (await probeBeacioReady(500)) { log('[gate] ios: beacio ready after wait → direct'); return true; }
     if (isStandalone()) { log('[gate] ios: standalone PWA → copy link guide'); guideIosStandalone(); return false; }
     // ④' 后台切回时 beacio 注入可能被系统挂起，navigator.bluetooth 瞬时不可用：
     //     重新触发自研握手并等待 beacio 恢复注入；恢复则直连，超时才走引导，避免误弹安装框。
     if (await waitBeacioActive(1500)) {
       log('[gate] ios: beacio recovered (reinject) → direct');
       return true;
     }
     log('[gate] ios: no beacio API after wait → guide');
     const iosVer = parseIOSVersion(navigator.userAgent);
     if (iosVer !== null && iosVer >= 26.2) { log(`[gate] ios: v${iosVer} ≥ 26.2 → beacio guide`); guideBeacio(); return false; }
     log(`[gate] ios: v${iosVer} < 26.2 → Bluefy guide`);
     guideBluefy();
     return false;
   }

   // iOS 页面加载时的轻量判定（beacio 注入时机不定，④⑤ 延迟到点击 Connect）：
   // 仅识别浏览器——Bluefy（有真实 API）与原生 Safari 放行（页面保持正常，不弹窗不禁用）；
   // 壳浏览器（Chrome iOS 等）返回 false，由调用方立即引导跳 Safari 并禁用 Connect
   function checkIosBrowserAtLoad() {
     if (isBluefy() && navigator.bluetooth) { log('[gate] load ios: Bluefy + API → pass'); return true; }
     if (isNativeSafari()) { log('[gate] load ios: native Safari → pass（④⑤ 判定延迟到点击 Connect）'); return true; }
     log('[gate] load ios: non-Safari shell → x-safari guide + disable Connect');
     return false;
   }

   // async：iOS 分支（ensureIosEnv）含 beacio 注入等待，调用方必须 await（点击路径）；
   // 页面加载体检只走 android/desktop 分支（无实际 await 点），也统一包 async IIFE 处理
   async function ensureBluetoothEnv() {
     const platform = detectPlatform();
     log(`[gate] check: platform=${platform} bluetooth=${!!navigator.bluetooth} secure=${window.isSecureContext}`);
     if (platform === 'ios') return ensureIosEnv();
     if (platform === 'android') {
       const allowed = isBrowserAllowed('android');
       log(`[gate] android: browserAllowed=${allowed}${allowed ? ' → direct' : ' → intent Chrome guide'}`);
       if (allowed) return true;
       guideAndroidChrome();
       return false;
     }
     const allowed = isBrowserAllowed('desktop');
     log(`[gate] desktop: browserAllowed=${allowed}${allowed ? ' → direct' : ' → copy link guide'}`);
     if (allowed) return true;   // 桌面：仅 Chrome/Edge（UA-CH 品牌判定，旧内核回退能力判定）
     guideDesktopChrome();
     return false;
   }


   async function handleConnect() {
     // 环境闸门（与页面加载共用）：不满足时已弹出对应平台引导，直接返回不进入连接流程
     // iOS 分支含 beacio 注入等待（最多 500ms），必须 await
     if (!(await ensureBluetoothEnv())) return;
     // 通过闸门即代表环境可直连（beacio active 注入 / Android Chrome/Edge / 桌面 Chromium
     // 等真实 API），无需再按浏览器/UA 额外拦截；未通过时 ensureBluetoothEnv 已弹对应引导。
     const token = ++connectToken;
     clearConnectError();   // 新的连接尝试开始，清除上一次失败的红字提示
     setConnectBusy(true);   // 进入连接流程：锁定 Connect 按钮，防止连接过程中重复点击
     let devicePicked = false;   // 是否已通过 requestDevice 拿到设备：区分"浏览器拉不起蓝牙"与"连接/信号失败"
     try {
       setStatus('connecting');
       log('Requesting Bluetooth Device...');

       // 阶段1：仅弹设备选择器（不设超时，用户挑设备时长不受限）
       const device = await BLEProtocol.requestSoilDevice();
       devicePicked = true;   // 已拿到设备：此后失败属连接/信号问题，不再归因"浏览器拉不起蓝牙"
       if (token !== connectToken) return;   // 期间用户又发起了新连接，丢弃本次

       // 阶段2：gatt.connect + 服务/特征发现，由 finishConnect 内部保证 5s 超时
       const { dataChar, dailyChar, resetChar, calibChar, refreshChar, tempOffsetChar, calibStatusChar, devNameChar, latestChar, hisBlkChar, daily30Char, daily30ExtChar, otaChar, fwVersion } = await BLEProtocol.finishConnect(
         device,
         (records, hex) => {
           log(`Notification: ${hex}`);
           render(records);
         },
         onDisconnected
       );

       if (token !== connectToken) {           // 迟到成功：丢弃并断开，防 UI 未连接、设备已连接
         device.gatt?.disconnect?.();
         return;
       }

       // device.id 是 Web Bluetooth 分配的设备唯一标识（浏览器不暴露真实 MAC），
       // 切换到不同土壤检测器时按它区分缓存，避免数据互相覆盖/串号。
       if (device.id !== state.activeDeviceId) {
         resetDisplay();
       }
       state.activeDeviceId = device.id;
       setLastDevice(device.id, device.name);
       restoreCachedCharts(device.id);

       state.device = device;
       state.characteristic = dataChar;
       state.dailyChar = dailyChar;
       state.hisBlkChar = hisBlkChar;
       state.daily30Char = daily30Char;
       state.daily30ExtChar = daily30ExtChar;
       state.resetChar = resetChar;
       state.calibChar = calibChar;
       state.refreshChar = refreshChar;
       state.latestChar = latestChar;
       // 订阅 0xFFEB latest 通知（新固件）：测量完成固件主动推送，前端免轮询、不占 GATT 锁；
       // 订阅失败（旧固件无 notify / 系统异常）标记 false，waitForLatestMeasurement 回退原轮询读（gattBusy 逻辑不变）
       state.tempOffsetChar = tempOffsetChar;
       state.calibStatusChar = calibStatusChar;
       state.devNameChar = devNameChar;
       state.otaChar = otaChar;
       // DIS 读取失败（返回空串/null）时回退按设备缓存的版本；读取成功则刷新缓存
       state.fwVersion = fwVersion || getCachedFwVersion(device.id);
       if (fwVersion) {
         setCachedFwVersion(device.id, fwVersion);
       } else {
         log('Firmware version read failed (DIS 0x2A26), fallback to cached: ' + (state.fwVersion || 'none'));
       }
       checkFirmwareUpdate();

       // 设备已连上 GATT 即置 connected：按钮立即可用；notify 订阅移后台，不再阻塞按钮 ready
       setStatus('connected');
       // 清除上一轮 OTA 结果残留（设备重启断链后重连，成功/失败文案都不应继续展示；
       // otaJustSucceeded 复位，避免旧 3s 自动切页定时器在新会话误触发）
       state.otaJustSucceeded = false;
       els.otaStatus.textContent = '';
       els.otaStatus.className = 'text-xs font-medium text-slate-600';
       els.otaProgressWrap.classList.add("hidden");
       setOtaRetryVisible(false);
       // 上一轮升级写入后尚未验证的版本，在此刻比对：只有设备自报出新版本号才算成功。
       // 放在 OTA 状态区清空之后，确保告警文案不会被上面的默认清空覆盖
       verifyPendingFwUpdate(device.id, fwVersion);
       clearConnectError();
       setConnectBusy(false);   // 连接成功：解锁 Connect 按钮（此时才允许点击 Disconnect）
       log('Connected & Listening for updates.');

       // 后台订阅 0xFFEB latest（新固件）：测量完成固件主动推送，前端免轮询、不占 GATT 锁；
       // 订阅失败（旧固件无 notify / 系统异常）标记 false，waitForLatestMeasurement 回退原轮询读（gattBusy 逻辑不变）
       state.latestNotifySubscribed = false;
       state.lastNotifiedRec = null;
       if (latestChar) {
         try {
           await gattOp(() => latestChar.startNotifications(), 'subscribe latest notify (0xFFEB)');
           latestChar.addEventListener('characteristicvaluechanged', onLatestNotified);
           state.latestNotifySubscribed = true;
           log('Latest notify subscribed (0xFFEB)');
         } catch (err) {
           state.latestNotifySubscribed = false;
           log('Latest notify subscribe failed (Refresh 将走读兜底): ' + err.message);
         }
       }
       startPolling();
       armIdleWatch();   // 连接就绪：开始 180s 空闲提醒（固件 240s 超时兜底）

       // —— 以下为数据加载，串行后台执行，不阻塞按钮 ready ——
       // 读取设备当前温度偏移，同步设置面板滑杆；旧固件无此特征则保持 0 并提示不支持
       if (tempOffsetChar) {
         try {
           state.tempOffsetX100 = await BLEProtocol.readTempOffset(tempOffsetChar);
           renderTempOffset();
           els.tempOffsetStatus.textContent = '';
         } catch (err) {
           state.tempOffsetX100 = 0;
           renderTempOffset();
           log(`Temperature offset read failed: ${err.message || err}`);
         }
       } else {
         state.tempOffsetX100 = 0;
         renderTempOffset();
         els.tempOffsetStatus.textContent = 'Not supported by this firmware';
       }

       if (dataChar.properties.read) {
         await readData();
       }

       // 中文：合并 0xFFEB latest——设备端 s_last_measure 含 Refresh 一次性测量值，
       //     若它比历史最后一条更新（如上次连接点过 Refresh），恢复卡片显示；
       //     旧固件无此特征时 readLatest 返回 null，静默跳过
      try {
        const devLatest = await BLEProtocol.readLatest(state.latestChar);
        const histLatest = state.lastRecords?.length ? state.lastRecords[state.lastRecords.length - 1] : null;
        if (devLatest && (!histLatest || devLatest.timestamp > histLatest.timestamp)) {
          applyLatestRecord(devLatest);
          log(`Restored newer latest measurement from 0xFFEB (${formatTime(devLatest.timestamp)})`);
        }
      } catch (_) { /* latest 读取失败不影响连接流程 */ }

      // 中文：24h 历史分块拉取（0xFFEC）——拆成"首屏 + 后台回填"两步，不再把连接流程
      //      卡在全量 144 条上：
      //        ① 首屏：末页 + 前一页（4 个 GATT 事务）拿到最新 ~6.7h，其中末页到手就上屏；
      //        ② 回填：更旧的分块由 startHistoryBackfill 在后台逐页补，
      //           用户往左拖时数据通常已经在，不必现场等一次往返。
      //      旧固件不认末页哨兵（会把 offset=0xFF 原样回显）→ 回退原来的全量最新优先路径。
      //      旧固件无此特征（hisBlkChar 为 null）时跳过，维持 0xFFE1 5 条老协议表现
      if (state.hisBlkChar) {
        try {
          /* 中文：块读整体占用全局 GATT 锁——否则 5s 轮询的探活读会插进来，
           *      安卓上表现为 "GATT operation already in progress" 或块数据错位 */
          // 中文：最新优先 + 每页到手即画（fetchHistoryTail）：首屏第一帧来自第 1 个事务，
          //      这里把每一页直接喂 render()——它会把该页并进内存/缓存再整表重画，
          //      所以后到的旧页表现为"往左边补历史"，不会把已显示的最新读数顶掉。
          let lastPaint = 0;
          const paintChunk = (chunk, info) => {
            if (!chunk.length) return;
            // 中文：重画按 ~100ms 节流（末页不受限，保证首屏立刻出图）。
            //      单页回调在 iOS 上可能挤在一起，连着重画只是白占主线程。
            const now = (window.performance?.now?.() ?? Date.now());
            if (!info.done && now - lastPaint < 100) return;
            lastPaint = now;
            log(`24h history: ${Math.min(info.fetched || 0, info.total || 0)}/${info.total || 0} records`);
            render(chunk);
          };

          const t0 = Date.now();
          const tail = await gattOp(
            () => BLEProtocol.fetchHistoryTail(state.hisBlkChar, {
              needCount: HISTORY_TAIL_RECORDS,
              onChunk: paintChunk,
            }),
            'fetch 24h history tail (0xFFEC)',
            10000   // 2 页 × (write+read)；慢平台单次往返可达 250ms，留足余量
          );

          if (tail) {
            log(`24h history tail: ${tail.records.length}/${tail.total} record(s) in ${Date.now() - t0}ms (oldestOffset=${tail.oldestOffset})`);
            applyHistoryRecords(tail.records);
            state.historyBackfill = {
              oldestOffset: tail.oldestOffset,
              oldestTs: tail.records.length ? tail.records[0].timestamp : 0,
              total: tail.total,
              running: false,
              unsupported: false,
            };
            // 中文：不 await——连接流程到此结束，剩余分块在后台补，界面立刻可操作
            void startHistoryBackfill();
          } else {
            log('0xFFEC last-page window unsupported (old firmware) — falling back to full fetch');
            const devRecords = await gattOp(
              () => BLEProtocol.fetchHistoryNewestFirst(state.hisBlkChar, { onChunk: paintChunk }),
              'fetch 24h history (0xFFEC)',
              15000   // 8 块 × (write+read)，Bluefy/iOS 单次往返可达 250ms，5s 不够
            );
            log(`24h history fetched: ${devRecords.length} record(s)`);
            applyHistoryRecords(devRecords);
            state.historyBackfill = {
              oldestOffset: 0,
              oldestTs: 0,
              total: devRecords.length,
              running: false,
              unsupported: true,   // 旧固件：不支持按需补页，也不存在"还没拉到"的区间
            };
          }
        } catch (err) {
          log(`24h history fetch failed (fallback to 5-record protocol): ${err.message || err}`);
        }
      }

       // 读取设备已保存的校准状态（0xFFE9），在干/湿校准点展示"已校准"提示（只提示存在性，不展示具体数值）
       await refreshCalibHints();

       // 读取设备侧存储的网页展示名（0xFFEA）：仅在连接与初始化全部完成后读取，不使用选择器里的蓝牙名
       await refreshDeviceNameFromDevice();

       
     } catch (err) {
       if (token !== connectToken) return;   // 超时/失败期间用户已重新点击，不被覆盖
       setConnectBusy(false);   // 连接失败：解锁 Connect 按钮，允许重新尝试
       setStatus('disconnected');
       syncBatteryPill();
       const errMsg = String(err && err.message);
       if (errMsg.includes('CONNECT_TIMEOUT')) {
         // 阶段2a：gatt.connect() 超时——多为设备深睡不在广播窗口 / 系统蓝牙被关闭；
         // 失败文案显示在状态卡下方红字独立行（不再覆盖状态行"Disconnected"文字）
         showConnectError('Connection timed out. Device may be sleeping — tap the touch pad to wake.');
         log('gatt.connect timed out after 10s');
       } else if (errMsg.includes('INIT_TIMEOUT')) {
         // 阶段2b：已连上但服务发现/时间同步/订阅初始化超时——多为射频信号差或慢平台
         showConnectError('Connected, but setup timed out — weak signal? Move closer and reconnect');
         log('Post-connect setup timed out after 20s');
       } else if (errMsg.includes('NOT_SOILPULSE') || errMsg.includes('INCOMPATIBLE_SERVICE')) {
         // 连接后身份校验失败：主服务 UUID 不对，或该服务下缺 0xFFE1/0xFFE2 这类底座特征。
         // 多见于兜底的名字过滤放过了一台同名设备（或固件服务表与网页不匹配），
         // 与"信号差/初始化失败"是两回事，必须让用户重新挑设备而不是反复重试。
         // err.detail 由 ble-protocol 填入失败阶段与底层错误（平台差异诊断用），直接透出到红字
         const detail = err && err.detail ? ` [${err.detail}]` : '';
         showConnectError('This is not a SoilPulse sensor, or its firmware is incompatible (service/characteristic mismatch). Tap Connect and pick your sensor again.' + detail);
         log(`Service mismatch after connect — not a SoilPulse device or incompatible firmware (${errMsg}${detail})`);
       } else if (/cancel|chooser/i.test(errMsg) || /NotFoundError|AbortError/i.test(err && err.name)) {
         log('Connection chooser dismissed by user (not an error)');
       } else if (!devicePicked) {
         // requestDevice 阶段失败（还没选到设备）：统一提示蓝牙权限，不再分平台弹窗/换文案。
         // 不依赖 err.name 枚举（小米等会抛 NotAllowedError 等未枚举名，会被旧 else 静默成
         // “闪一下没反应”），统一走可见红字引导。
         // iOS Safari（beacio）附加唤醒提示：锁屏唤醒后快速首点可能吞掉瞬时用户手势
         // （页面尚在恢复渲染，WebKit 未注册 activation），requestDevice 被静默拒绝；
         // 再点一次 Connect 手势重新注册即可正常弹出授权/设备选择器
         const wakeHint = (detectPlatform() === 'ios' && isNativeSafari())
           ? ' If you just unlocked your iPhone/iPad, tap Connect once more.'
           : '';
         showConnectError('Bluetooth failed to start. Make sure Bluetooth is on and allow Bluetooth permission for this browser, then retry.' + wakeHint);
         log(`Bluetooth could not start (requestDevice): ${(err && err.name) || '?'}: ${(err && err.message) || err}`);
       } else {
         // 已选到设备，后续连接/初始化失败 → 设备/信号问题，不引导 Chrome
         showConnectError(`Connection failed (${(err && err.name) || 'error'}). Check signal and retry.`);
         log(`Connection failed after device pick: ${(err && err.name) || '?'}: ${(err && err.message) || err}`);
       }
     }
   }
 
   function handleDisconnect() {
     if (state.device?.gatt.connected) {
       setConnectBusy(true);   // 断开进行中：锁定按钮，防止重复点击
       state.device.gatt.disconnect();
     } else {
       onDisconnected();
     }
   }
 
   els.connectBtn.addEventListener('click', () => {
     if (state.device?.gatt.connected) {
       handleDisconnect();
     } else {
       // UI 可能残留"已连接"但底层已断（事件未触发）：先同步为断开，再发起新连接
       if (state.device) onDisconnected();
       handleConnect();
     }
   });

   // 从后台回到前台（App 切换、标签页恢复）时校验连接：手机系统可能在后台终止 BLE 连接，
   // 且 gattserverdisconnected 事件在 WebKit 上可能不补发，这里主动校正 UI。
   // 切到后台则收起空闲提醒：隐藏期间不会有人点"保持连接" → 不写 0xFFE7 → 设备 240s 自然断，
   // 这正是"切后台就该省电"想要的结果，不需要额外主动断链（后台定时器还可能被节流，主动断也不可靠）。
   document.addEventListener('visibilitychange', () => {
     if (document.visibilityState !== 'visible') {
       clearIdleWatch();
       return;
     }
     if (state.device && !state.device.gatt.connected) {
       onDisconnected();
     } else if (state.device?.gatt.connected) {
       armIdleWatch();   // 回前台重新计时（后台那段时间不计入 180s）
     }
   });

   // BFCache（前进/后退）恢复页面时同样校验一次
   window.addEventListener('pageshow', () => {
     if (state.device && !state.device.gatt.connected) {
       onDisconnected();
     }
   });
 
   els.clearCacheBtn.addEventListener('click', gattButton('Device reset command', async () => {
    if (state.otaRunning) {
      log('Action ignored: OTA update is running');
      return;
    }
     // 中文：Clear data 仅在已连接状态下可用（setStatus 联动 disabled），此处再兜底防御一次
     if (!state.device?.gatt.connected) return;
     const msg = 'Clear cached data on this browser AND reset the connected device history? This cannot be undone.';
     if (!window.confirm(msg)) return;
     // 中文：先让设备清（设备是权威数据源），成功后再清本地。
     //      旧顺序"先清本地再写设备"在写入超时/失败时会造成"本机空了、设备还在"，
     //      重连后 0xFFEC 又把旧记录拉回来，用户看到的仍是"清了没用"。
     let deviceCleared = false;
     if (state.resetChar) {
       try {
         await gattOp(() => BLEProtocol.sendReset(state.resetChar), 'Device reset write (0xFFE5)');
         deviceCleared = true;
         log('Device reset command sent (0xFFE5)');
       } catch (err) {
         log(`Device reset failed (0xFFE5): ${err.message || err}`);
       }
     }
     clearAllCache();
     // 失败必须可见：否则本地清空成功、设备纹丝不动，用户以为清干净了
     if (state.resetChar && !deviceCleared) {
       els.historyBody.innerHTML = '<tr><td colspan="5" class="py-6 text-center text-rose-500">Local cache cleared, but the device did not acknowledge the reset. Reconnect and clear again — device data is still stored.</td></tr>';
     }
   }));

  // ===== 问题3加固：GATT 操作超时 + 断链类错误识别 + 主动断连 =====
  const GATT_OP_TIMEOUT_MS = 5000;

  // 给任意 GATT Promise 包一层 5s 超时：底层链路半死时 readValue/writeValue 可能永远
  // 悬空（挂死会卡死 gattBusy 与按钮流程）。超时只是放弃等待，底层操作无法真正取消
  function withGattTimeout(promise, label = 'GATT operation', timeoutMs = GATT_OP_TIMEOUT_MS) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs / 1000}s`)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  // ===== 全局 GATT 互斥锁 =====
  // 安卓 Chrome 蓝牙栈同一时刻只允许一个 in-flight GATT 操作：上一个未完成时发新操作
  // 直接抛 "GATT operation already in progress" / status 133（iOS/PC 系统栈会内部排队，
  // 不会出现）。所有按钮写统一经 gattOp 串行化；轮询/Refresh 轮询走 gattBusy 跳拍（非阻塞）。
  // 锁内操作都有 withGattTimeout 兜底，保证锁必然释放（≤5s）。
  async function gattOp(op, label = 'GATT operation', timeoutMs = GATT_OP_TIMEOUT_MS) {
    let waited = false;
    while (state.gattBusy) {
      waited = true;
      await new Promise((r) => setTimeout(r, 25));
    }
    if (waited) log(`gattOp [${label}]: waited for GATT lock`);
    state.gattBusy = true;
    try {
      return await withGattTimeout(op(), label, timeoutMs);
    } finally {
      state.gattBusy = false;
    }
  }

  // 链路存活探活状态机：三个信号没有一个单独可信——gatt.connected=true 可能是死链滞留、
  // gattserverdisconnected 事件可能不触发、GATT 操作失败多为瞬时拥塞（安卓 status 133）。
  // 唯一可信的"活着"证据 = GATT 往返成功。规则：
  //   1. gatt.connected===false → 立即判死（false 是可信信号）
  //   2. 读 0xFFEB 失败 → 间隔 700ms 重试，最多 3 次（等待 in-flight 出清/穿透 flash 停顿窗口）
  //   3. 任一次往返成功 → 判活，返回 latest 记录（旧固件无值返回 true）；3 次全败 → 判死返回 false
  // 旧固件无 0xFFEB（latestChar 为 null）时 readLatest 直接返回 null 不抛错 → 判活，
  // 存活检测退化为 gatt.connected 检查。
  async function probeLinkAlive() {
    if (!state.device?.gatt.connected) {
      log('probeLinkAlive: gatt.connected=false → dead');
      return false;
    }
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const rec = await gattOp(() => BLEProtocol.readLatest(state.latestChar), `Link probe #${attempt} (0xFFEB)`);
        log(`probeLinkAlive: alive (attempt ${attempt}/3)`);
        return rec || true;   // 中文：有值返回记录（供轮询刷新实时卡片），旧固件无值返回 true
      } catch (err) {
        log(`probeLinkAlive: attempt ${attempt}/3 failed — ${err.message || err}`);
        if (!state.device?.gatt.connected) {
          log('probeLinkAlive: gatt.connected dropped during probe → dead');
          return false;
        }
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, 700));
    }
    log('probeLinkAlive: all 3 attempts failed → dead');
    return false;
  }

  // 主动断连 + 复位 UI：浏览器栈半死（gatt.connected 迟迟不变 false、事件不派发）时，
  // 本地 gatt.disconnect() 强制清理协议栈状态；onDisconnected 幂等，复位全部界面。
  // 日志措辞保持中性（"Disconnect"而非"Connection lost"）——这里也会被"用户主动休眠"复用。
  function forceDisconnect(reason) {
    log(`Disconnect${reason ? ` — ${reason}` : ''}`);
    try { state.device?.gatt?.disconnect(); } catch (_) { /* 链路已断时可能抛错，忽略 */ }
    onDisconnected();
  }

  // Settings 各按钮统一错误兜底：try/catch 收敛到这一个封装，按钮代码只写成功路径。
  // 出错时先探活（读一次 0xFFEB）再裁决：链路已断 → forceDisconnect 复位 UI（onDisconnected
  // 顺带复位校准按钮状态）；链路仍在 → 只记日志并回调 onError 供按钮更新各自的状态行。
  // 不再凭错误消息文本猜断链（timed out / gatt / networkerror 等关键词）——一次操作超时
  // 或操作重叠不等于链路已断，误判会造成"连点 Refresh 就掉线"的体验
  function gattButton(context, action, onError) {
    return async (...args) => {
      try {
        await action(...args);
      } catch (err) {
        if (await probeLinkAlive()) {
          log(`${context} failed (link alive): ${err.message || err}`);
          if (onError) onError(err);
        } else {
          forceDisconnect(`${context}: ${err.message || err}`);
        }
      }
    };
  }


  // 读取设备 0xFFE9 校准状态并刷新干/湿校准点的"已校准"提示。
  // 返回 'ok'（成功读到设备真实校准状态，state.calibSaved 有效）或 'unavailable'
  // （特征缺失/读取失败——常见于设备还是旧固件（无 0xFFE9）、iOS/Bluefy 缓存了旧 GATT
  //  属性表、或浏览器缓存了旧版页面脚本）。调用方必须区分这两种情况：
  //  读取通道不可用 ≠ 校准被设备拒绝。
  let lastCalibReadErr = null;   // 中文：最近一次 0xFFE9 读取失败的错误（供调用方判断是否断链类）
  async function refreshCalibHints() {
    if (!state.calibStatusChar) {
      renderCalibHints(null);
      log('Calibration status characteristic unavailable: old firmware, cached GATT table or stale page cache');
      return 'unavailable';
    }
    try {
      const saved = await gattOp(() => BLEProtocol.readCalibStatus(state.calibStatusChar), 'Calibration status read (0xFFE9)');
      renderCalibHints(saved);
      log(`Calibration status read (0xFFE9): dry=${saved.dry} wet=${saved.wet} temp=${saved.temp} result=${saved.result}`);
      return 'ok';
    } catch (err) {
      lastCalibReadErr = err;
      renderCalibHints(null);
      log(`Calibration status read failed: ${err.message || err}`);
      return 'unavailable';
    }
  }

  // 渲染干/湿校准点的"已校准"徽标与汇总文案：只提示设备上存在哪些校准，不展示具体校准数值
  function renderCalibHints(saved) {
    state.calibSaved = saved;
    els.calibStatus.style.color = '';
    els.calibDryBadge.classList.toggle('hidden', !saved?.dry);
    els.calibWetBadge.classList.toggle('hidden', !saved?.wet);
    // 问题2：本地持久化的最新一次校准尝试结果优先于设备标志位展示——
    // 徽标与按钮框内文案都按最后一次尝试渲染：重新连接/刷新后仍显示最后一次信息；
    // 未有本地记录的点则清空文案、以设备真实标志为准
    ['dry', 'wet'].forEach((p) => {
      const attempt = state.calibAttempt?.[p];
      if (attempt?.status === 'fail' || attempt?.status === 'ok') {
        renderCalibPointUi(p, attempt.status, attempt.text);
      } else {
        renderCalibPointUi(p, 'clear');
      }
    });
    els.calibStatus.textContent = saved?.dry || saved?.wet
      ? `Saved on device (persists across reboots)`
      : 'No calibration saved on device yet';
  }

  // 校准前强制设备用当前探头状态立即重测，并等待新测量结果到达。
  // 原因：固件校准使用的是"最近一次测量"（s_last_measure），若用户切换探头状态（如浸水）
  // 后设备尚未采样，固件会用旧状态读数做校准，导致"两点过近"被拒绝（gap < 50mV）。
  async function waitForHumiditySample(timeoutMs = 8000) {
    // 中文：固件校准在触发的一次新测量完成后才应用/拒绝并写入 0xFFE9 结果码，
    //       必须等新测量落地再回读。校准测量只更新 0xFFEB latest（app.c 就地重测），
    //       故这里每 500ms 轮询一次 9 字节 latest，时间戳出现变化即新测量已到
    //       （替代旧的全量 readData 轮询：GATT 事务减半，避免与 0xFFE9 回读争用链路）
    const t0 = Date.now();
    const prev = state.lastRecords?.length ? state.lastRecords[state.lastRecords.length - 1] : null;
    while (Date.now() - t0 < timeoutMs) {
      await new Promise(resolve => setTimeout(resolve, 500));
      if (!state.device?.gatt.connected) return null;
      try {
        const latest = await gattOp(() => BLEProtocol.readLatest(state.latestChar), 'Latest read (0xFFEB)');
        if (latest && (!prev || latest.timestamp !== prev.timestamp)) return latest;
      } catch (_) { /* 单次读取失败不中断，继续等待到超时预算为止 */ }
    }
    return null;
  }

  // ===== 问题2：校准尝试结果持久化（localStorage）+ 按钮下方消息行渲染 =====
  // 每个校准点最近一次尝试结果存 localStorage（soilpulse_calib_attempt_v1），
  // 页面刷新/重连后仍然显示，直到该点下一次校准尝试将其覆盖
  function loadCalibAttempts() {
    try {
      const saved = JSON.parse(localStorage.getItem(CALIB_ATTEMPT_KEY));
      return saved && typeof saved === 'object' ? saved : {};
    } catch (_) {
      return {};   // localStorage 不可用（隐私模式等）时退化为内存态
    }
  }

  function saveCalibAttempt(point, entry) {
    try {
      const all = loadCalibAttempts();
      if (entry) all[point] = entry;
      else delete all[point];
      localStorage.setItem(CALIB_ATTEMPT_KEY, JSON.stringify(all));
    } catch (_) { /* 存储不可用时静默跳过 */ }
  }

  // 渲染单点状态：view: 'busy' 测量中 | 'fail' 失败（按钮下方红字） | 'ok' 成功（✓ 徽标） | 'clear' 复位
  function renderCalibPointUi(point, view, text) {
    const badge = point === 'dry' ? els.calibDryBadge : els.calibWetBadge;
    const msg = point === 'dry' ? els.calibDryMsg : els.calibWetMsg;
    if (!badge || !msg) return;
    if (view === 'busy') {
      badge.classList.add('hidden');
      msg.classList.remove('calib-msg-err');
      msg.textContent = text || 'Measuring…';
      msg.hidden = false;
    } else if (view === 'fail') {
      badge.classList.add('hidden');   // 最新失败覆盖上一次成功标记
      msg.textContent = text || '✗ Failed';
      msg.classList.add('calib-msg-err');
      msg.hidden = false;
    } else if (view === 'ok') {
      msg.textContent = '';
      msg.hidden = true;
      badge.classList.remove('hidden');
    } else {
      msg.textContent = '';
      msg.hidden = true;
    }
  }

  // 更新某校准点尝试结果：'ok'/'fail' 持久化；'busy' 仅更新 UI；'clear' 清除该点记录
  function setCalibAttempt(point, status, shortText) {
    if (!state.calibAttempt) state.calibAttempt = loadCalibAttempts();
    if (status === 'ok' || status === 'fail') {
      state.calibAttempt[point] = { status, text: shortText || '', ts: Date.now() };
      saveCalibAttempt(point, state.calibAttempt[point]);
    } else if (status === 'clear') {
      state.calibAttempt[point] = null;
      saveCalibAttempt(point, null);
    }
    renderCalibPointUi(point, status === 'busy' ? 'busy' : (state.calibAttempt[point]?.status || 'clear'), shortText);
  }


  // 校准动作主体：只写成功路径，任何错误原样抛出交由 gattButton 统一处理
  async function runCalibration(point, label) {
    if (state.otaRunning) {
      log('Calibration ignored: OTA update is running');
      return;
    }
    if (!state.device?.gatt.connected || !state.calibChar) {
      els.calibStatus.textContent = 'Connect device to enable calibration';
      return;
    }

    // 确认弹窗：提示设备将先测量当前探头状态，再用本次新鲜采样自动应用校准（取电量稳定采样的值）
    const baseMsg = point === 'dry'
      ? 'Confirm the probe is fully dry in open air, then apply dry (0%) calibration?'
      : 'Confirm the probe is in water up to the OPTIMAL DEPTH line, then apply wet (100%) calibration?';
    const msg = `${baseMsg}

The device will measure the current probe state first, then apply the calibration automatically.`;
    if (!window.confirm(msg)) return;

    els.calibDryBtn.disabled = true;
    els.calibWetBtn.disabled = true;
    els.calibStatus.textContent = 'Calibration started — measuring current probe state…';
    els.calibStatus.style.color = '';   // 中文：测量中恢复默认灰色（红色仅在结果码为错误时展示）
    // 问题2：本次点击的点立即进入测量中状态——隐藏该点可能残留的 ✓，覆盖上一次结果
    setCalibAttempt(point, 'busy', 'Measuring…');
    try {
      // 固件 0xFFE6 写回调只登记校准点并触发立即测量，测量完成后自动应用（或按状态/间距拒绝、丢弃）。
      // 每次尝试的确定结果由固件记录在 0xFFE9 第 2 字节：1=干点成功 2=湿点成功
      // 3=拒:湿度未低于20% 4=拒:湿度未高于80% 5=拒:两点过近 6=方向反向 7=测量失败或断链丢弃
      await gattOp(() => BLEProtocol.sendHumCalib(state.calibChar, point), 'Calibration write (0xFFE6)');
      armIdleWatch();   // 校准请求会触发固件立即测量并清零 idle
      log(`Moisture ${label} calibration command sent (0xFFE6)`);

      // 等待设备完成新测量（校准由固件在测量后自动应用或拒绝），再回读 0xFFE9 用结果码判定
      await waitForHumiditySample();
      const readState = await refreshCalibHints();
      if (readState !== 'ok') {
        // 回读失败：捕获到错误则原样抛出，交由 gattButton 探活后统一裁决断连/提示；
        // 无错误对象（旧固件无 0xFFE9 等本地配置原因）仅提示状态不可读
        if (lastCalibReadErr) throw lastCalibReadErr;
        els.calibStatus.textContent = `${label} calibration command sent (device calibration status not readable)`;
        setCalibAttempt(point, 'fail', '✗ Result unknown');
        return;
      }
      const result = state.calibSaved?.result;
      // 结果码 1/2=成功；3/4/5/6/7=各类失败（红色展示）；0/无结果码=旧固件回退标志推断
      const resultText = {
        1: `${label} calibration saved on device`,
        2: `${label} calibration saved on device`,
        3: 'Dry calibration rejected: moisture not below 20% — ambient/environment is not dry enough',
        4: 'Wet calibration rejected: moisture not above 80% — ambient/environment is not wet enough',
        5: 'Calibration rejected: difference between dry and wet anchors is too small',
        6: 'Calibration rejected: measurement failed or connection interrupted',
        7: 'Calibration rejected: reversed anchors — wet voltage must stay below dry voltage',
      };
      // 按钮内只放短文案防溢出，完整原因展示在按钮组下方的 calibStatus
      const shortText = {
        1: '✓ Calibrated', 2: '✓ Calibrated',
        3: '✗ Rejected: not dry enough', 4: '✗ Rejected: not wet enough',
        5: '✗ Rejected: anchors too close', 6: '✗ Rejected: measurement failed',
        7: '✗ Rejected: reversed anchors',
      };
      const known = result !== undefined && result !== null && resultText[result] !== undefined;
      els.calibStatus.style.color = known && result >= 3 ? '#dc2626' : '';
      if (known) {
        els.calibStatus.textContent = resultText[result];
        setCalibAttempt(point, result >= 3 ? 'fail' : 'ok', shortText[result]);
      } else {
        // 旧固件（0xFFE9 只有 1 字节标志位，无结果码）：退回标志推断
        const ok = point === 'dry' ? !!state.calibSaved?.dry : !!state.calibSaved?.wet;
        els.calibStatus.textContent = ok
          ? `${label} calibration saved on device`
          : `${label} calibration rejected (dry/wet points too close)`;
        setCalibAttempt(point, ok ? 'ok' : 'fail', ok ? undefined : '✗ Rejected (anchors too close)');
      }
    } finally {
      // 断链路径上 onDisconnected 会把按钮重新禁用，这里仅在仍连接时恢复
      const stillConnected = !!state.device?.gatt.connected;
      els.calibDryBtn.disabled = !stillConnected;
      els.calibWetBtn.disabled = !stillConnected;
    }
  }

  // 各校准点错误回调：红色完整原因 + 按钮内短文案（断链类由 gattButton 断连复位 UI）
  function onCalibError(point, label) {
    return (err) => {
      els.calibStatus.style.color = '#dc2626';
      els.calibStatus.textContent = `${label} calibration failed: ${err.message || err}`;
      setCalibAttempt(point, 'fail', '✗ Failed');
    };
  }

  els.calibDryBtn.addEventListener('click', gattButton('Dry calibration', () => runCalibration('dry', 'Dry'), onCalibError('dry', 'Dry')));
  els.calibWetBtn.addEventListener('click', gattButton('Wet calibration', () => runCalibration('wet', 'Wet'), onCalibError('wet', 'Wet')));

  // ---- 设备改名：字节数/字符集实时校验 + 保存 ----
  function updateDevNameByteCount() {
    const v = els.devNameInput?.value || '';
    const bytes = new TextEncoder().encode(v);
    if (els.devNameByteCount) els.devNameByteCount.textContent = `${bytes.length} / ${DEV_NAME_MAX_BYTES} characters`;
    const okLen = bytes.length >= 1 && bytes.length <= DEV_NAME_MAX_BYTES;
    const okAscii = bytes.length > 0 && bytes.every(b => b >= 0x20 && b <= 0x7E);
    if (els.devNameSaveBtn) els.devNameSaveBtn.disabled = !okLen || !okAscii;
    if (els.devNameStatus && v && (!okLen || !okAscii)) {
      els.devNameStatus.textContent = 'Only printable ASCII, max 10 characters';
    }
  }

  // ---- 设备名：连接与初始化全部完成后，经 GATT 0xFFEA 读取设备侧存储的网页展示名 ----
  // 展示一致性策略（无论连接/断开/刷新页面都展示同一个名字，不因缓存状态不一致）：
  //   1) GATT 读到名字 → 展示并持久化（showDeviceNameBadge 写入 localStorage）；
  //   2) 读失败/为空 → 优先沿用 localStorage 里最近一次的名字（不因瞬时读取失败把真实
  //      名字覆盖成通用默认名）；本地也没有才回退 config.js 的 DEVICE_NAME；
  //   3) 工厂复位显式清除持久化（clearDeviceNameBadge），复位后回默认名。
  // 注意：不使用选择器里的蓝牙名（device.name）；改名不影响蓝牙名，因此也无需重扫/重连
  async function refreshDeviceNameFromDevice() {
    let name = null;
    let fromGatt = true;
    if (state.devNameChar) {
      try {
        name = await BLEProtocol.readDeviceName(state.devNameChar);
      } catch (err) {
        log(`Device name read failed: ${err.message || err}`);
      }
    }
    if (name === null || name === '') {
      let cached = '';
      try { cached = localStorage.getItem(DEVICE_NAME_KEY) || ''; } catch (_) {}
      if (cached) {
        // 只展示不回写：缓存名保留，避免被默认名覆盖
        if (els.deviceNameText) {
          els.deviceNameText.textContent = cached;
          els.deviceNameText.classList.remove('hidden');
          els.deviceNameText.classList.toggle('dev-name-idle', !state.device?.gatt.connected);
        }
        if (els.devNameInput) {
          els.devNameInput.value = cached;
          updateDevNameByteCount();
        }
        log(`Device name unavailable via GATT, keep cached name: ${cached}`);
        return;
      }
      fromGatt = false;
      name = DEVICE_NAME;   // config.js 中与固件 app_config.h BLE_DEVICE_NAME 保持一致
      log('Device name unavailable via GATT, fallback to config DEVICE_NAME');
    }
    showDeviceNameBadge(name);
    if (els.devNameInput) {
      els.devNameInput.value = name;
      updateDevNameByteCount();
    }
    log(`Device display name (${fromGatt ? 'GATT' : 'config default'}): ${name}`);
  }

  els.devNameInput.addEventListener('input', updateDevNameByteCount);
  els.devNameSaveBtn.addEventListener('click', gattButton('Device name save', async () => {
    if (state.otaRunning) {
      els.devNameStatus.textContent = 'Ignored: OTA update is running';
      return;
    }
    if (!state.device?.gatt.connected || !state.devNameChar) {
      els.devNameStatus.textContent = 'Connect device to change its name';
      return;
    }
    const name = (els.devNameInput.value || '').trim();
    els.devNameSaveBtn.disabled = true;
    els.devNameStatus.textContent = 'Saving…';
    try {
      const res = await gattOp(() => BLEProtocol.sendDeviceName(state.devNameChar, name), 'Device name write (0xFFEA)');
      if (res.ok) {
        showDeviceNameBadge(name);
        els.devNameStatus.textContent = 'Name saved — shown in this dashboard only (Bluetooth name unchanged).';
        log(`Device name saved: ${name}`);
      } else {
        els.devNameStatus.textContent = `Save failed: ${res.message}`;
      }
    } finally {
      updateDevNameByteCount();
    }
  }, (err) => {
    els.devNameStatus.textContent = `Save failed: ${err.message || err}`;
  }));


  // ===== Refresh 防连点 =====
  // 设备端一轮测量（电池/NTC/湿度三通道 ADC 采样 + 滤波稳定等待）通常需要几百毫秒到 1~2 秒，
  // 而 0xFFE7 的 GATT 写入本身几十毫秒即完成：若写完立刻恢复按钮，用户在这段窗口里
  // 看不到任何反馈，极易连续点击。
  // v2 规格：refresh 一次性测量不写历史、不推 0xFFE1 通知，实时值写入 0xFFEB latest 特征。
  // 策略：点击后锁定按钮并显示 Measuring…，每 500ms 轮询读 0xFFEB，直到出现比点击时
  // 展示水位更新的时间戳（新测量已到，刷新 Latest 卡片）或超时兜底解锁。
  // 解锁只认三条路径：0xFFEB 时间戳变化 / 6s 超时 / 断连——不因收到任意 0xFFE1 通知解锁
  // （周期上报与本次强制测量无关，提前解锁会让连点在设备测量中再次写入 0xFFE7）。
  // 连点危害：设备端 s_force_measure_pending 是二值标志，同窗口内的连点会合并成一次测量。
  const REFRESH_RESULT_TIMEOUT_MS = 6000;
  const REFRESH_ICON_IDLE = '🔄';
  const REFRESH_ICON_BUSY = '⏳';
  const REFRESH_LABEL_IDLE = 'Refresh';
  const REFRESH_LABEL_BUSY = 'Measuring…';
  let refreshBusy = false;          // 一次 refresh 从点击到"通知到达或超时"期间为 true
  let refreshUnlockTimer = null;    // 超时兜底解锁定时器

  function setRefreshUiBusy(busy) {
    // 按钮内部为 图标 + 文字 两个 span 的固定结构（HTML），只替换内容不重建节点
    if (els.refreshIcon) els.refreshIcon.textContent = busy ? REFRESH_ICON_BUSY : REFRESH_ICON_IDLE;
    if (els.refreshLabel) {
      els.refreshLabel.textContent = busy ? REFRESH_LABEL_BUSY : REFRESH_LABEL_IDLE;
    } else {
      // 兜底：span 不存在时退回整体 textContent
      els.refreshBtn.textContent = busy ? `${REFRESH_ICON_BUSY} ${REFRESH_LABEL_BUSY}` : `${REFRESH_ICON_IDLE} ${REFRESH_LABEL_IDLE}`;
    }
    els.refreshBtn.disabled = busy || !state.device?.gatt.connected;
  }

  // 断连 / 写失败等异常路径：清等待状态并恢复按钮
  function cancelRefreshWait() {
    if (refreshUnlockTimer) {
      clearTimeout(refreshUnlockTimer);
      refreshUnlockTimer = null;
    }
    refreshBusy = false;
    setRefreshUiBusy(false);
  }

  // Refresh 专用：只刷新 "Latest measurement" 卡片，不写历史记录/图表/本地缓存
  function applyLatestRecord(rec) {
    els.tempValue.textContent = tempVal(rec.temp).toFixed(1);
    els.humValue.textContent = rec.hum.toFixed(1);
    els.battValue.textContent = rec.batt;
    els.lastUpdate.textContent = `Latest measurement: ${formatTime(rec.timestamp)}`;
    state.latestShown = rec;   // 抬高水位：更旧的历史数据不允许覆盖本次实时值
    syncBatteryPill();
  }

  const REFRESH_POLL_INTERVAL_MS = 1000;

  // 0xFFEB latest 通知回调：解析固件主动推送的最新测量，更新内存水位（不占 GATT 锁）
  function onLatestNotified(event) {
    const rec = BLEProtocol.parseLatestValue(event.target.value);
    if (rec) state.lastNotifiedRec = rec;
  }

  // 单一 notify 路径 + 主动读兜底（产品锁新固件，去掉 polling 回退与 timestamp 兼容）
  // notify 正常：事件回调命中 seq 即返回（快路径）；notify 丢包/未推：
  // 等待窗口内每 1s 主动读 0xFFEB 兜底（seq 判据命中即返回），保证 ≤测量耗时+1s 出结果。
  async function waitForLatestMeasurement(prev) {
    return new Promise((resolve) => {
      let settled = false;
      let timeoutTimer = null;
      let readTimer = null;

      // 判据：只认 measure_seq（新固件 10 字节必有序号），去掉 timestamp 回退
      const hits = (rec) => rec && (!prev ||
        rec.measureSeq !== prev.measureSeq ||
        rec.temp !== prev.temp ||
        rec.hum !== prev.hum);

      const finish = (rec) => {
        if (settled) return;                  // 幂等
        settled = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (readTimer) clearTimeout(readTimer);
        if (state.latestChar) state.latestChar.removeEventListener('characteristicvaluechanged', onNotified);
        resolve(rec);
      };

      // 主入口：notify 到达，seq 命中即返回
      const onNotified = (event) => {
        const rec = BLEProtocol.parseLatestValue(event.target.value);
        if (hits(rec)) finish(rec);
      };

      // 读兜底：notify 未到/丢包时，每拍主动读 0xFFEB（尊重 gattBusy，跳拍避让主轮询）
      const readFallback = async () => {
        if (settled || !state.device?.gatt.connected) return;
        if (state.gattBusy) {                 // 主轮询在读：本拍跳避，下一拍再看
          readTimer = setTimeout(readFallback, REFRESH_POLL_INTERVAL_MS);
          return;
        }
        state.gattBusy = true;
        try {
          const rec = await withGattTimeout(BLEProtocol.readLatest(state.latestChar), 'Refresh fallback read (0xFFEB)');
          if (hits(rec)) { finish(rec); return; }
        } catch (_) { /* 单次读失败：继续，直到超时兜底 */ }
        finally {
          state.gattBusy = false;
          if (!settled) readTimer = setTimeout(readFallback, REFRESH_POLL_INTERVAL_MS);
        }
      };

      timeoutTimer = setTimeout(() => finish(null), REFRESH_RESULT_TIMEOUT_MS);  // 6s 兜底
      if (state.latestChar) {
        state.latestChar.addEventListener('characteristicvaluechanged', onNotified);
        readFallback();                       // 启动读兜底
      } else {
        finish(null);                         // 无 0xFFEB：新固件不应发生，直接超时
      }
    });
  }

  els.refreshBtn.addEventListener('click', gattButton('Refresh', async () => {
    if (state.otaRunning) {
      log('Refresh ignored: OTA update is running');
      return;
    }
    if (!state.device?.gatt.connected || !state.refreshChar) {
      return;
    }
    // 防连点：上一次测量仍在进行（未收到新数据也未超时）则忽略；设备端
    // s_force_measure_pending 是二值标志，同窗口内的连点会合并成一次测量
    if (refreshBusy) {
      log('Refresh ignored: measurement already in progress');
      return;
    }
    refreshBusy = true;
    setRefreshUiBusy(true);
    try {
      // 根治时序竞态：先挂 notify 监听（waitForLatestMeasurement 的 notify 路径同步 addEventListener），
      // 再发写命令——固件 push 无论多早都在监听挂载之后，不会漏收导致干等 6s 超时。
      // 水位基线取"当前展示值"：0xFFEB 恢复的上次一次性测量值可能比历史最后一条更新，
      // 且主轮询/通知也可能在等待期间刷新 latestShown——以点击时刻快照为基线最稳
      const prev = state.lastNotifiedRec ?? state.latestShown
        ?? (state.lastRecords?.length ? state.lastRecords[state.lastRecords.length - 1] : null);
      const waitPromise = waitForLatestMeasurement(prev);
      await gattOp(() => BLEProtocol.sendRefresh(state.refreshChar), 'Refresh write (0xFFE7)');
      armIdleWatch();   // 这次写已经在固件侧清零 idle，提醒重新计时（避免"刚点过为什么还问"）
      log('Refresh command sent (0xFFE7), measuring now');
      const rec = await waitPromise;
      if (rec) {
        applyLatestRecord(rec);
        log('Refresh: latest measurement updated (0xFFEB)');
      } else {
        log('Refresh: no updated measurement within 6s, button unlocked');
      }
    } finally {
      cancelRefreshWait();   // 成功/失败统一恢复按钮态（成功时为幂等空操作）
    }
  }));

  // 温度偏移：数字输入框是“待应用值”的唯一来源（滑杆已移除——手机上拖动精度不足，
  // ±0.1 按钮 + 直接键入是最可靠的精调方式）。℃ 量程 ±10.0，℉ 量程 ±18.0，Apply 时才换算到设备 0.1℃ 网格。
  // ±0.1 微调按钮：每按一次 ±1 格（当前单位 0.1），到量程端点自动停；
  // 连续快点不会触发 iOS 双击缩放（全局 button 样式已设 touch-action: manipulation）
  els.tempOffsetDecBtn.addEventListener('click', () => {
    if (!els.tempOffsetInput.disabled) setTempOffsetTicks(tempOffsetTicksFromInput() - 1);
  });
  els.tempOffsetIncBtn.addEventListener('click', () => {
    if (!els.tempOffsetInput.disabled) setTempOffsetTicks(tempOffsetTicksFromInput() + 1);
  });

  // 手动输入：输入过程不拦截（避免打断打字）；失焦/回车（change）时按 0.1 网格取整并夹取量程；
  // 清空/非法输入时还原为设备当前值。兼容小数逗号（"0,2"）
  els.tempOffsetInput.addEventListener('change', () => {
    const raw = parseFloat(String(els.tempOffsetInput.value).replace(',', '.'));
    setTempOffsetTicks(Number.isFinite(raw) ? Math.round(raw * 10) : tempOffsetToTicks(state.tempOffsetX100 || 0));
  });

  els.tempOffsetApplyBtn.addEventListener('click', gattButton('Temperature offset', async () => {
    if (state.otaRunning) {
      log('Temperature offset ignored: OTA update is running');
      return;
    }
    if (!state.device?.gatt.connected || !state.tempOffsetChar) {
      els.tempOffsetStatus.textContent = 'Connect device to adjust temperature offset';
      return;
    }
    // ticksToTempOffset 返回设备原值（0.01℃ = x100）；回执文案与日志都按 ℃/℉ 显示，必须 /100，
    // /10 会把 2.5℃ 显示成 25.0℃（历史 bug）
    const x100 = ticksToTempOffset(tempOffsetTicksFromInput());   // ℉ 格四舍五入对齐设备 0.01℃ 网格
    const offsetC = x100 / 100;
    els.tempOffsetApplyBtn.disabled = true;
    els.tempOffsetStatus.textContent = 'Applying temperature offset…';
    try {
      await gattOp(() => BLEProtocol.sendTempOffset(state.tempOffsetChar, x100), 'Offset write (0xFFE8)');
      state.tempOffsetX100 = x100;
      renderTempOffset();   // 回显设备 0.01℃ 网格真实值（℉ 模式滑杆位置可能微调 ≤1 格）
      els.tempOffsetStatus.textContent = `Temperature offset set to ${fmtTempDelta(offsetC)}`;
      log(`Temperature offset sent (0xFFE8): ${offsetC.toFixed(2)}℃ (raw ${x100})`);
      // 立即重测，让 Data 面板尽快反映修正后的温度
      if (state.refreshChar) {
        try { await gattOp(() => BLEProtocol.sendRefresh(state.refreshChar), 'Refresh write (0xFFE7)'); } catch (_) {}
      }
      armIdleWatch();   // 偏移写 + 重测都在固件侧清零了 idle，提醒重新计时
    } finally {
      els.tempOffsetApplyBtn.disabled = !state.device?.gatt.connected || !state.tempOffsetChar;
    }
  }, (err) => {
    els.tempOffsetStatus.textContent = `Temperature offset failed: ${err.message || err}`;
  }));

  // 工厂重置 + 重启：写入 RST1 后设备会清空数据并重启，连接随即断开
  els.factoryResetBtn.addEventListener('click', gattButton('Factory reset', async () => {
    if (state.otaRunning) {
      log('Factory reset ignored: OTA update is running');
      return;
    }
    if (!state.device?.gatt.connected || !state.resetChar) {
      els.factoryResetStatus.textContent = 'Connect device to reset';
      return;
    }
    const msg = 'Factory reset the device? All stored data (history, daily averages, moisture calibration, temperature offset and device name) will be cleared and the device will reboot. This page\'s cached data for the device will also be cleared. The connection will drop.';
    if (!window.confirm(msg)) return;
    els.factoryResetBtn.disabled = true;
    els.factoryResetStatus.textContent = 'Sending factory reset… the device will reboot';
    // 设备端将全擦，网页本地为该设备缓存的数据同步清除（校准记录/历史/日均值/设备名；
    // lastDevice 与温度单位偏好保留）。放在写入前执行，确保任何失败路径下都已完成清理
    clearLocalDeviceCache();
    // 写入后设备可能在 ACK 前就重启断链：断链/超时类错误由 gattButton 主动断连复位 UI，
    // 其余错误回调也按已下发、设备重启中提示——对用户表现一致，无需区分
    await gattOp(() => BLEProtocol.sendFactoryReset(state.resetChar), 'Factory reset write (0xFFE5)');
    log('Factory reset command sent (0xFFE5 RST1)');
    els.factoryResetStatus.textContent = 'Factory reset requested — the device is rebooting. Reconnect when it appears again.';
  }, (err) => {
    els.factoryResetStatus.textContent = 'Factory reset requested — the device is rebooting. Reconnect when it appears again.';
    log(`Factory reset note: ${err.message || err}`);
  }));

  // 中文：统一格式化 OTA 报错文案——断链（监督超时/设备复位）给安抚性提示，
  //       双 bank 设计保证老固件仍在运行，重连即可重试；其余错误原样展示。
  //       下载阶段（外层 click 回调）与传输阶段（runOtaUpdate 内部）共用此函数，避免文案不一致。
  function formatOtaError(err) {
    const raw = err?.message || String(err);
    const isDisconnect = /disconnect|gatt server/i.test(raw);
    return isDisconnect
      ? "Connection lost during update — the device is still running the previous firmware. Please reconnect and retry."
      : `OTA error: ${raw}`;
  }

  // START 阶段被固件拒绝（低电 17 / pdu 9 / 固件尺寸越界等）：预擦都还没开始，
  // Flash 一个字节都没动。文案要明确这一点，否则用户会以为"升级失败=可能变砖"。
  function formatOtaRejection(err) {
    const why = {
      17: "battery too low — replace the batteries first (below 2.2V the touch sensor stops working)",
      9:  "the device rejected the 176-byte block size",
      11: "the firmware size is out of range",
    }[err?.otaResult] || (err?.message || "the device refused the upgrade");
    return `Upgrade refused before any flash erase: ${why}. Nothing was written — fix this and tap Retry.`;
  }

  // 新版本横幅一键升级：从 page/firmware/ 下载清单指向的固件并推送
  els.otaUpdateNowBtn.addEventListener("click", async () => {
    const upd = state.fwUpdate;
    if (!upd || state.otaRunning || !state.device?.gatt.connected) return;
    const msg = `Upgrade firmware to v${upd.version} (${(upd.size / 1024).toFixed(1)} KB)? The device will reboot after a successful update.`;
    if (!window.confirm(msg)) return;
    els.otaProgressWrap.classList.remove("hidden");
    els.otaProgressBar.style.width = "0%";
    els.otaStatus.className = "text-xs font-medium text-slate-600";
    els.otaUpdateNowBtn.disabled = true;
    els.otaUpdateNowBtn.textContent = 'Updating firmware…';   // 中文：点击即切进行中文案，覆盖下载+传输全程
    setOtaRetryVisible(false);
    els.otaStatus.textContent = `Downloading v${upd.version}…`;
    try {
      const res = await fetch(upd.url, { cache: "no-store" });
      if (!res.ok) throw new Error(`firmware download failed: HTTP ${res.status}`);
      await runOtaUpdate(await res.arrayBuffer(), `firmware v${upd.version}`, upd.version);
    } catch (err) {
      els.otaStatus.textContent = formatOtaError(err);
      els.otaStatus.className = "text-xs font-medium text-rose-600";
      setOtaRetryVisible(true);
      log(`[OTA] error: ${err.message || err}`);
    } finally {
      els.otaUpdateNowBtn.disabled = state.otaRunning || !state.device?.gatt.connected || !state.fwUpdate;
      els.otaUpdateNowBtn.textContent = 'Update now';          // 中文：会话结束恢复原文案（含下载阶段失败兜底）
    }
  });

  // 重试：复用已下载的固件重走一遍推送，避免重复下载
  els.otaRetryBtn.addEventListener("click", async () => {
    if (state.otaRunning) return;
    const last = state.otaLastFirmware;
    if (!last) return;
    if (!state.device?.gatt.connected) {
      els.otaStatus.textContent = "Reconnect the device first, then tap Retry.";
      els.otaStatus.className = "text-xs font-medium text-rose-600";
      return;
    }
    await runOtaUpdate(last.firmware, last.label, last.version);
  });

  // OTA 推送主流程（手动选文件 / 一键升级共用）：进度条 + 结果展示 + 按钮态恢复
  async function runOtaUpdate(firmware, label, version) {
    state.otaRunning = true;
    state.otaLastFirmware = { firmware, label, version };
    stopPolling(); // OTA 期间暂停轮询，避免 GATT 读写抢占升级链路
    clearIdleWatch();   // OTA 期间固件强制 latency=0 且自己清零 idle，不要弹"保持连接"打扰升级
    setOtaUiLock(true);
    els.otaProgressWrap.classList.remove("hidden");
    els.otaUpdateNowBtn.disabled = true;
    els.otaUpdateNowBtn.textContent = 'Updating firmware…';   // 中文：重试/直调路径统一进行中文案（幂等）
    els.otaProgressBar.style.width = "0%";
    els.otaStatus.className = "text-xs font-medium text-slate-600";
    setOtaRetryVisible(false);
    els.otaStatus.textContent = `Sending ${label}…`;

    const runOnce = async (isRetry) => {
      if (isRetry) {
        els.otaStatus.textContent = 'Channel busy, restarting OTA session…';
      }
      return BLEProtocol.performOta(state.otaChar, firmware, (info) => {
        els.otaProgressBar.style.width = `${info.percent}%`;
        if (info.phase === "preparing") {
          // 固件整区预擦 ~3.1s（+web 盲等窗口）：显示 preparing 文案，避免 "Sending… 0%"
          // 静止近 4s 误以为卡死；DATA 第一包开始时 data 分支自然切回 "Sending firmware…"
          els.otaStatus.textContent = "Preparing device (erasing flash)…";
        } else if (info.phase === "data") {
          els.otaStatus.textContent = `Sending firmware… ${info.percent}% (${(info.sent / 1024).toFixed(1)} / ${(info.total / 1024).toFixed(1)} KB)`;
        } else if (info.phase === "end") {
          els.otaStatus.textContent = "Firmware sent, verifying…";
        }
      });
    };

    try {
      let result;
      try {
        result = await runOnce(false);
      } catch (firstErr) {
        const msg = String(firstErr?.message || firstErr || '').toLowerCase();
        const retryableBusy = msg.includes('already in progress') || msg.includes('busy');
        if (!retryableBusy || !state.device?.gatt.connected) {
          throw firstErr;
        }
        await new Promise((resolve) => setTimeout(resolve, 220));
        result = await runOnce(true);
      }

      const { ok, message } = result;
      els.otaStatus.textContent = message;
      els.otaStatus.className = `text-xs font-medium ${ok ? "text-emerald-600" : "text-rose-600"}`;
      setOtaRetryVisible(!ok);
      log(`[OTA] ${message}`);
      if (ok) {
        state.fwUpdate = null;
        state.otaJustSucceeded = true;   // 中文：成功提示展示期——设备重启断链后保留 Setting 页展示本条成功文案
        // 【闭环补强】不再把“上传 bin 的版本”写进 state.fwVersion / fwVer 缓存。
        // 固件 SUCCESS 只代表回读 CRC32 通过 + boot mark 已切，不证明新固件能跑起来：
        // bootctl 在几次非预期复位后会把另一个槽恢复成 KNLT 并复位过去，设备实际跑旧版本。
        // 旧写法会把缓存写成目标版本，之后 compareVersions 恒判定“已是最新”，
        // 于是回滚的设备永远不再收到升级提示 —— 静默失效。改为记一条待验证，
        // 由重连时读 DIS 0x2A26 的设备自报版本来确认（verifyPendingFwUpdate）
        if (version) {
          setPendingFwVerify(state.activeDeviceId, version);
          els.otaStatus.textContent = `Firmware v${version} written, device rebooting — reconnect to confirm`;
        }
        renderFirmwareCard();
        // 统一成功交互（所有成功路径一致）：成功文案在 Setting 页展示数秒后，自动切到
        // Data 选项卡看数据。用户若在这几秒内主动操作（重连/切页），otaJustSucceeded
        // 会被清除，定时器不再切换，避免误切。
        setTimeout(() => {
          if (state.otaJustSucceeded) switchMainTab('data');
        }, 3000);
      }
    } catch (err) {
      // 中文：真实中途断链会走到这里（并非“已在进行中”类忙碌错误），需展示安抚性提示而非原始报错文案
      // 中文：固件在 START 阶段就拒绝（otaStage='start'，如低电 17）时，Flash 未擦未写、
      //       也没有任何在途 DATA 写请求——保持连接，让用户换电池后直接点 Retry；
      //       只有真正进过 DATA 阶段才需要下面那套"断链清队列"的补救。
      const startRejected = err?.otaStage === 'start';
      els.otaStatus.textContent = startRejected ? formatOtaRejection(err) : formatOtaError(err);
      els.otaStatus.className = "text-xs font-medium text-rose-600";
      setOtaRetryVisible(true);
      log(`[OTA] error: ${err.message || err}`);
      if (!startRejected) {
        // 中文：失败后主动断开设备——Android WebBluetooth 的 writeValue 不等固件 ATT 响应连发
        //       （实测 3~4ms/包），上一轮 OTA 的写请求队列会残留；不重连直接重试时，残留包
        //       继续投递到已重置的固件端（expect=0 收到 141+）导致 jump 错位直到超时。
        //       断开强制下次重试走全新连接，pending 写队列随连接取消清空。
        try { state.device?.gatt?.disconnect?.(); } catch (_) { /* 断开失败不影响错误展示 */ }
      }
    } finally {
      state.otaRunning = false;
      els.otaUpdateNowBtn.textContent = 'Update now';          // 中文：会话结束（成功/失败/重试）统一恢复原文案
      // 成功后设备自动重启断链；失败但仍连接则恢复轮询与按钮态
      if (state.device?.gatt.connected) {
        setOtaUiLock(false);
        setStatus("connected");
        startPolling();
        armIdleWatch();   // OTA 结束且仍连着：恢复空闲提醒（OTA 期间不打扰）
      } else if (state.otaJustSucceeded) {
        // 中文：断链确认成功路径——onDisconnected 监听先于本 continuation 执行，
        //       可能已把页面强制切回 Data；这里恢复到 Setting 页并重套“保留成功提示”的可见性
        switchMainTab('setting');
        updateSettingsAccess(false);
      }
    }
  }

  // 固件版本比较（语义化 x.y.z 逐段数值比较；容忍 V 前缀/缺段，如 "V1.0" 与 "1.0.0" 视为相等）
  function parseVersion(v) {
    const m = String(v || "").match(/[0-9]+(\.[0-9]+)*/);
    return m ? m[0].split(".").map(Number) : [0];
  }

  function compareVersions(a, b) {
    const va = parseVersion(a), vb = parseVersion(b);
    const n = Math.max(va.length, vb.length);
    for (let i = 0; i < n; i++) {
      const d = (va[i] || 0) - (vb[i] || 0);
      if (d) return d;
    }
    return 0;
  }

  // 连接后检测新版本：fetch page/firmware/firmware.json 与设备固件版本（DIS 0x2A26）比较，更高则提示升级；清单带 isforce:true 时跳过比较强制提醒
  async function checkFirmwareUpdate() {
    state.fwUpdate = null;
    renderFirmwareCard();
    if (!state.device?.gatt.connected || !state.otaChar) return;
    try {
      const res = await fetch(FIRMWARE_MANIFEST_URL, { cache: "no-store" });
      if (!res.ok) return;
      const raw = await res.json();
      const m = normalizeManifest(raw);
      if (!m) return;
      // isforce：dev 渠道发布的强制升级清单，跳过版本号比较直接提醒升级（用于测试固件下发，
      // 以及填入正式版 URL 后把测试固件覆盖回正式版）；设备已在该版本上时（字符串相等，
      // 测试固件版本为 commit hash）仍不提醒，避免重复打扰
      // 版本未知（DIS 读取失败且本地无缓存）时绝不能当作“旧版本”提示升级——
      // 否则刚升到最新的设备会被反复提示升级；跳过检查并保持卡片中性展示
      if (!state.fwVersion) {
        log('[OTA] firmware version unknown, update check skipped');
        renderFirmwareCard();
        return;
      }
      const isForce = m.latest.isforce === true;
      // 中文：isforce=true 用于反复下发测试固件——即使设备已在该版本（字符串相等）也提示；
      //      仅非强制清单在“设备版本不低于清单”时才静默跳过

      if (String(state.fwVersion || "") === String(m.latest.version)
        || (!isForce && compareVersions(m.latest.version, state.fwVersion) <= 0)){
        renderFirmwareCard();
        return;
      }
      const base = FIRMWARE_MANIFEST_URL.slice(0, FIRMWARE_MANIFEST_URL.lastIndexOf("/") + 1);
      const latest = m.latest;
      state.fwUpdate = {
        version: latest.version,
        bin: latest.bin,
        size: Number(latest.size) || 0,
        url: base + latest.bin,
        notes: latest.notes || '',
        history: m.history,
      };
      els.otaNewVersion.textContent = `v${latest.version}`;
      renderFirmwareCard();
      log(`[OTA] new firmware available: v${latest.version} (current ${state.fwVersion || "unknown"})`);
    } catch (err) {
      log(`Firmware manifest check failed: ${err.message || err}`); // 清单缺失/网络失败静默降级
    }
  }

  // 兼容 firmware.json 单对象与数组两种格式；数组按版本倒序后取最高版本，并保留完整升级列表
  function normalizeManifest(raw) {
    if (Array.isArray(raw)) {
      const sorted = raw.filter(r => r && r.version && r.bin).sort((a, b) => compareVersions(b.version, a.version));
      return sorted.length ? { latest: sorted[0], history: sorted } : null;
    }
    if (raw && raw.version && raw.bin) {
      return { latest: raw, history: Array.isArray(raw.history) && raw.history.length ? raw.history : [raw] };
    }
    return null;
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // 渲染 Setting 面板里的 Firmware 卡片状态（当前版本 / 更新提示 / 红点 / What's new 列表）
  function renderFirmwareCard() {
    const upd = state.fwUpdate;
    const ver = state.fwVersion || '--';
    els.otaCurrentVersionBadge.textContent = `v${ver}`;
    const hasUpdate = !!upd;
    els.otaUpdateHint.classList.toggle('hidden', !hasUpdate);
    els.otaUpdateNowBtn.classList.toggle('hidden', !hasUpdate);
    els.settingUpdateDot.classList.toggle('hidden', !hasUpdate);
    els.otaUpdateNowBtn.disabled = state.otaRunning || !state.device?.gatt.connected || !hasUpdate;

    const notesLines = upd?.notes ? String(upd.notes).split(/\r?\n/).map(s => s.trim()).filter(Boolean) : [];
    const history = Array.isArray(upd?.history) ? upd.history : [];
    const hasChangelog = notesLines.length > 0 || history.length > 1;
    els.otaChangelog.classList.toggle('hidden', !hasChangelog);
    if (!hasChangelog) {
      els.otaChangelogList.innerHTML = '';
      return;
    }
    const items = [];
    if (notesLines.length) {
      items.push(...notesLines);
    } else {
      history.forEach(h => items.push(`v${h.version}${h.notes ? ' — ' + String(h.notes).split(/\r?\n/)[0].trim() : ''}`));
    }
    els.otaChangelogList.innerHTML = items.map(t => `<li>${escapeHtml(t)}</li>`).join('');
  }

  // —— 温度偏移取值：待应用值恒为“当前显示单位的 0.1”格数——
  // ℃ 模式：1 格 = 0.1℃（±100 格）；℉ 模式：1 格 = 0.1℉（±180 格，±18℉ = ±10℃）。
  // 设备存储恒为 0.01℃（int16 小端，±1000），℉ 格写入时四舍五入到 0.01℃ 网格（偏差 ≤0.05℉），
  // 因此 Apply 后按设备真实值回显时显示可能微调 ≤0.1℉。
  function tempOffsetRange() {
    return state.tempUnit === 'F'
      ? { min: TEMP_OFFSET.MIN_F, max: TEMP_OFFSET.MAX_F, step: 1 }
      : { min: TEMP_OFFSET.MIN_X10 / 10, max: TEMP_OFFSET.MAX_X10 / 10, step: TEMP_OFFSET.STEP_X10 };
  }
  // 数字框当前值 -> 格数（当前单位 0.1 的整数格，非法输入按 0 处理）
  function tempOffsetTicksFromInput() {
    const raw = parseFloat(String(els.tempOffsetInput.value).replace(',', '.'));
    return Number.isFinite(raw) ? Math.round(raw * 10) : 0;
  }
  // 设备值(0.01℃=x100) -> 格数（显示单位 0.1）：°F = x100*9/50，°C = x100/10；展示效果与旧 0.1℃ 版一致
  function tempOffsetToTicks(x100) {
    return state.tempUnit === 'F' ? Math.round(x100 * 9 / 50) : Math.round(x100 / 10);
  }
  // 格数 -> 设备值(0.01℃=x100)：°F = ticks*50/9，°C = ticks*10；0.01℃ 精度下 °F 任意 0.1 值均可精确落位
  function ticksToTempOffset(ticks) {
    return state.tempUnit === 'F' ? Math.round(ticks * 50 / 9) : ticks * 10;
  }

  // 统一写入口：±0.1 微调 / 手动输入规范化 / 单位切换回显 共用——按“当前单位 0.1”
  // 整数格夹取到量程后写数字框
  function setTempOffsetTicks(ticks) {
    const range = tempOffsetRange();
    const clamped = Math.max(range.min, Math.min(range.max, Math.round(ticks)));
    els.tempOffsetInput.value = (clamped / 10).toFixed(1);
    return clamped;
  }

  function renderTempOffset() {
    const x100 = state.tempOffsetX100 || 0;
    const range = tempOffsetRange();
    // 数字框随单位切换同步量程（℃ ±10.0 / ℉ ±18.0）、步进与单位后缀
    els.tempOffsetInput.min = String(range.min / 10);
    els.tempOffsetInput.max = String(range.max / 10);
    els.tempOffsetInput.step = '0.1';
    if (els.tempOffsetUnitSpan) els.tempOffsetUnitSpan.textContent = tempDeltaSymbol();
    els.tempOffsetInput.value = (tempOffsetToTicks(x100) / 10).toFixed(1);
  }

  els.trendTabBtn.addEventListener('click', () => switchChartView('trend'));
  els.dailyMetricTempBtn.addEventListener('click', () => setDailyMetric('temp'));
  els.dailyMetricHumBtn.addEventListener('click', () => setDailyMetric('hum'));
  els.dailyMetricBattBtn.addEventListener('click', () => setDailyMetric('batt'));
  els.dailyRange7Btn?.addEventListener('click', () => setDailyRange(7));
  els.dailyRange30Btn?.addEventListener('click', () => setDailyRange(30));
  // 中文：点 / 拖动日均图任意一天 → 摘要头切换那天（Apple Health 式滑选）。
  //      布局参数由 drawMultiSeriesChart 存在 canvas._chartLayout 上。
  //      用 pointer 事件而不是 click：一根手指按住横着滑，竖线跟着走（左滑右滑都行），
  //      canvas 上设了 touch-action:pan-y，所以竖着滑仍然是滚动页面、不会误触。
  let dailyDragging = false;
  let dailyScrubRaf = 0;

  const dailyIndexAt = (clientX) => {
    const lay = els.dailyChart?._chartLayout;
    if (!lay || lay.len < 1 || lay.stepX <= 0) return null;
    const rect = els.dailyChart.getBoundingClientRect();
    if (!rect.width) return null;
    const x = (clientX - rect.left) * (els.dailyChart.clientWidth / rect.width);
    const idx = Math.round((x - lay.padLeft) / lay.stepX);
    return Math.max(0, Math.min(lay.len - 1, idx));
  };

  // 中文：拖动时一帧最多重绘一次（pointermove 在手机上可达 120Hz，重绘是全量 canvas 绘制）
  const scheduleDailyRender = () => {
    if (dailyScrubRaf) return;
    dailyScrubRaf = requestAnimationFrame(() => {
      dailyScrubRaf = 0;
      if (state.lastDailyRecords) renderDaily(state.lastDailyRecords);
    });
  };

  const scrubDaily = (e) => {
    const sel = dailyIndexAt(e.clientX);
    if (sel == null || state.dailySelIdx === sel) return;
    state.dailySelIdx = sel;
    scheduleDailyRender();
  };

  els.dailyChart?.addEventListener('pointerdown', (e) => {
    if (!els.dailyChart._chartLayout) return;
    dailyDragging = true;
    try { els.dailyChart.setPointerCapture(e.pointerId); } catch (_) {}
    scrubDaily(e);
  });
  els.dailyChart?.addEventListener('pointermove', (e) => {
    if (dailyDragging) scrubDaily(e);
  });
  const endDailyDrag = (e) => {
    if (!dailyDragging) return;
    dailyDragging = false;
    try { els.dailyChart.releasePointerCapture?.(e.pointerId); } catch (_) {}
  };
  els.dailyChart?.addEventListener('pointerup', endDailyDrag);
  els.dailyChart?.addEventListener('pointercancel', endDailyDrag);
  els.dailyChart?.addEventListener('pointerleave', endDailyDrag);

  // ────────── 24h 图 x 轴平移 / 缩放 ──────────
  // 中文：canvas 上设了 touch-action:pan-y（见 index.html），所以竖着滑仍然是滚页面，
  //      横着滑才平移图。重绘按帧合并：pointermove 在手机上可达 120Hz，而 drawChart
  //      是整块 canvas 重绘，逐事件重画会白占主线程。
  let trendRaf = 0;
  const scheduleTrendRedraw = () => {
    if (trendRaf) return;
    trendRaf = requestAnimationFrame(() => {
      trendRaf = 0;
      if (!state.lastRecords || els.trendTabPanel.classList.contains('hidden')) return;
      drawChart(state.lastRecords);
      updateTrendSummary(state.lastRecords);
    });
  };

  const trendLayout = () => els.trendChart?._trendLayout || null;

  const trendRelX = (clientX) => {
    const rect = els.trendChart.getBoundingClientRect();
    return rect.width ? (clientX - rect.left) * (els.trendChart.clientWidth / rect.width) : 0;
  };

  // 中文：设置窗口右边界/跨度。follow 不传时按"右边界是否贴到最新一条"自动判定——
  //      贴到就算回到跟随态，此后新记录进来自动跟着走（不必再点 Latest）。
  function setTrendWindow({ endTs, spanSec } = {}) {
    const v = state.trendView;
    if (Number.isFinite(spanSec)) {
      v.spanSec = Math.round(Math.min(TREND_VIEW_SPAN_MAX, Math.max(TREND_VIEW_SPAN_MIN, spanSec)));
    }
    if (Number.isFinite(endTs)) v.endTs = Math.round(endTs);
    const lay = trendLayout();
    if (lay) v.follow = Math.abs(v.endTs - lay.dataLast) <= 2;
    scheduleTrendRedraw();
  }

  // 中文：回到"最新 + 默认 6h"。双击/双触、点 Latest 胶囊都走这里。
  function resetTrendView() {
    const lay = trendLayout();
    const v = state.trendView;
    v.spanSec = TREND_VIEW_SPAN_DEFAULT;
    v.follow = true;
    v.endTs = lay ? lay.dataLast : null;
    scheduleTrendRedraw();
  }

  const trendPointers = new Map();   // pointerId → 最近一次坐标（双指缩放要两个点）
  let trendDrag = null;              // { pointerId, x0, end0 }
  let trendPinch = null;             // { dist0, span0, frac, anchorTs }
  let trendLastTap = { t: 0, x: 0, y: 0 };

  els.trendChart?.addEventListener('pointerdown', (e) => {
    const lay = trendLayout();
    if (!lay) return;
    trendPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { els.trendChart.setPointerCapture(e.pointerId); } catch (_) {}
    if (trendPointers.size >= 2) {
      // 双指 → 缩放：只认前两个点，第三根手指忽略
      const [a, b] = [...trendPointers.values()];
      const rect = els.trendChart.getBoundingClientRect();
      const midX = (a.x + b.x) / 2 - rect.left;
      const frac = Math.min(1, Math.max(0, (midX - lay.padLeft) / lay.plotW));
      trendPinch = {
        dist0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        span0: lay.spanSec,
        frac,
        // 锚点 = 双指中点此刻对应的时刻：缩放时它不动，画面才不会往一边跑
        anchorTs: lay.winStart + frac * lay.spanSec,
      };
      trendDrag = null;
      return;
    }
    trendDrag = { pointerId: e.pointerId, x0: e.clientX, end0: lay.endTs, moved: 0 };
  });

  els.trendChart?.addEventListener('pointermove', (e) => {
    const lay = trendLayout();
    if (!lay) return;
    if (trendPointers.has(e.pointerId)) trendPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (trendPinch && trendPointers.size >= 2) {
      const [a, b] = [...trendPointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const span = Math.round(Math.min(TREND_VIEW_SPAN_MAX,
        Math.max(TREND_VIEW_SPAN_MIN, trendPinch.span0 * (trendPinch.dist0 / dist))));
      state.trendView.spanSec = span;
      state.trendView.endTs = Math.round(trendPinch.anchorTs + (1 - trendPinch.frac) * span);
      state.trendView.follow = false;
      scheduleTrendRedraw();
      return;
    }

    if (!trendDrag || trendDrag.pointerId !== e.pointerId) return;
    const dx = e.clientX - trendDrag.x0;
    trendDrag.moved = Math.max(trendDrag.moved, Math.abs(dx));
    // 手指往左拖 = 往更早的数据看（dx<0 → endTs 变小）
    setTrendWindow({ endTs: trendDrag.end0 - dx * (lay.spanSec / lay.plotW) });
  });

  const endTrendPointer = (e) => {
    const drag = trendDrag && trendDrag.pointerId === e.pointerId ? trendDrag : null;
    trendPointers.delete(e.pointerId);
    if (trendPointers.size < 2) trendPinch = null;
    if (drag) trendDrag = null;
    try { els.trendChart.releasePointerCapture?.(e.pointerId); } catch (_) {}

    // 双击/双触回到最新：300ms 内第二次抬手、且两次都没怎么移动（拖动结束不算）
    if (drag && drag.moved > 12) return;
    const now = Date.now();
    const near = Math.hypot(e.clientX - trendLastTap.x, e.clientY - trendLastTap.y) < 24;
    if (now - trendLastTap.t < 300 && near) {
      trendLastTap = { t: 0, x: 0, y: 0 };
      resetTrendView();
      return;
    }
    trendLastTap = { t: now, x: e.clientX, y: e.clientY };
  };
  els.trendChart?.addEventListener('pointerup', endTrendPointer);
  els.trendChart?.addEventListener('pointercancel', endTrendPointer);

  // 中文：桌面端 ctrl/⌘ + 滚轮缩放（触控板捏合同样落在这里）；不按时放手，
  //      让页面正常滚动——图表占了大半屏，抢滚轮会把页面卡死在一张图上。
  els.trendChart?.addEventListener('wheel', (e) => {
    const lay = trendLayout();
    if (!lay || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const frac = Math.min(1, Math.max(0, (trendRelX(e.clientX) - lay.padLeft) / lay.plotW));
    const anchorTs = lay.winStart + frac * lay.spanSec;
    const span = Math.round(Math.min(TREND_VIEW_SPAN_MAX,
      Math.max(TREND_VIEW_SPAN_MIN, lay.spanSec * (e.deltaY > 0 ? 1.15 : 1 / 1.15))));
    state.trendView.spanSec = span;
    state.trendView.endTs = Math.round(anchorTs + (1 - frac) * span);
    state.trendView.follow = false;
    scheduleTrendRedraw();
  }, { passive: false });

  els.trendLatestBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    resetTrendView();
  });

  // 单位切换：点击切换器任意位置（含按钮、灰底间隙、以及当前激活的单位）都翻转单位（°F ↔ °C）。
  // 用户期望“按到上面就切换”——即使当前在 °C，按到 °C 上也切回 °F，故统一 toggle，不做“切到该按钮单位”的区分。
  els.tempUnitToggle?.addEventListener('click', () => {
    state.tempUnit = state.tempUnit === 'C' ? 'F' : 'C';
    updateTempUnitUI();
  });
  els.mainTabDataBtn.addEventListener('click', () => switchMainTab('data'));
  els.mainTabGuideBtn.addEventListener('click', () => switchMainTab('guide'));
  els.mainTabSettingBtn.addEventListener('click', () => switchMainTab('setting'));

   let resizeTimer = null;
   window.addEventListener('resize', () => {
     clearTimeout(resizeTimer);
     resizeTimer = setTimeout(() => {
       const dataVisible = !els.mainTabDataPanel.classList.contains('hidden');
       if (dataVisible && !els.trendTabPanel.classList.contains('hidden') && state.lastRecords) {
         drawChart(state.lastRecords);
       }
       if (dataVisible && !els.dailyTabPanel.classList.contains('hidden') && state.lastDailyRecords) {
         renderDaily(state.lastDailyRecords);
       }
     }, 200);
   });
 

   updateDailyMetricButtons();
   updateChartViewButtons();
  updateTempUnitUI();
  // 启动时恢复本地保存的校准尝试结果（问题2：刷新页面后错误/成功标记仍显示）
  ['dry', 'wet'].forEach((p) => {
    const a = state.calibAttempt?.[p];
    if (a) renderCalibPointUi(p, a.status, a.text);
  });

  if (els.pageVersion) {
    els.pageVersion.textContent = `SoilPulse dashboard v${PAGE_VERSION}`;
  }
  state.activeDeviceId = getLastDeviceId();
  if (state.activeDeviceId) restoreCachedCharts(state.activeDeviceId);
 
   // 核心环境日志（现场排查第一条）：页面版本 / 安全上下文 / Web Bluetooth / 平台 / UA-CH 品牌 / UA
   try {
     const uad = navigator.userAgentData;
     const brands = (uad && Array.isArray(uad.brands)) ? uad.brands.map((b) => b.brand).join('|') : 'n/a';
     log(`[env] v${PAGE_VERSION} secure=${window.isSecureContext} bluetooth=${!!navigator.bluetooth} platform=${detectPlatform()} brands=${brands} ua=${navigator.userAgent}`);
   } catch (_) { /* 环境日志失败不影响功能 */ }

   // 页面加载自动体检（立即执行，无延迟）：
   //   - Android / 桌面：全量判定，假支持浏览器（小米/UC/微信/三星）与无 API 浏览器
   //     （Safari/Firefox）加载即弹对应引导并禁用 Connect；
   //   - iOS：仅识别浏览器——Bluefy / 原生 Safari 放行（页面保持正常，后续 beacio active /
   //     standalone / beacio / Bluefy 判定延迟到点击 Connect 时触发）；壳浏览器（Chrome iOS
   //     等）立即引导跳 Safari 并禁用 Connect。800ms 等待已移除（各分支均无注入等待需求）。
   const loadGatePlatform = detectPlatform();
   if (loadGatePlatform === 'ios') {
     const ok = checkIosBrowserAtLoad();
     log(`[gate] load check (ios): ${ok ? 'pass' : 'fail → x-safari guide + disable Connect'}`);
     if (!ok) {
       guideIosNonSafari();
       els.connectBtn.disabled = true;
       els.connectBtn.classList.add('opacity-40', 'cursor-not-allowed');
     }
   } else {
     // ensureBluetoothEnv 现为 async（iOS 点击路径含 beacio 注入等待）：加载体检只走
     // android/desktop 分支（无实际 await 点），用 IIFE await 拿到真实布尔值再禁用 Connect
     (async () => {
       const ok = await ensureBluetoothEnv();
       log(`[gate] load check (${loadGatePlatform}): ${ok ? 'pass' : 'fail → disable Connect until environment fixed'}`);
       if (!ok) {
         els.connectBtn.disabled = true;
         els.connectBtn.classList.add('opacity-40', 'cursor-not-allowed');
       }
     })();
   }
 })();