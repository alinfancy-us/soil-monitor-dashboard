/**
 * SoilPulse Dashboard Application UI Manager
 */
 (() => {
   'use strict';
 
   // 集中配置统一取自 page/js/config.js，方便后续维护管理
   const {
     PAGE_VERSION,
     DEV_NAME_MAX_BYTES,
     DEVICE_NAME,
     DEBUG_ENABLED, POLL_ENABLED, POLL_INTERVAL,
     DASHBOARD_URL, BLUEFY_APPSTORE_URL, BLUEFY_DEEPLINK,
     DAILY_EPOCH_MIN_VALID, DAILY_EPOCH_MAX_VALID, TREND_EPOCH_MAX_VALID,
     CACHE_PREFIX, CACHE_MAX_ITEM_BYTES, CACHE_MAX_TOTAL_BYTES,
     FIRMWARE_MANIFEST_URL,
     TEMP_OFFSET,
} = SoilPulseConfig;
  // 缓存 key 按设备唯一标识（device.id，Web Bluetooth 分配，浏览器内可视为等价 MAC）分区，
  // 避免连接不同土壤检测器时数据互相覆盖。lastDevice 指针用于刷新页面后自动回显上次设备的数据。
  const LAST_DEVICE_KEY = `${CACHE_PREFIX}lastDevice:v1`;
  const DEVICE_NAME_KEY = `${CACHE_PREFIX}devName:v1`;   // 最近一次连接的设备展示名（断开连接后仍展示）
  const RECORD_KEY_RE = /^SoilPulse:(trend|daily):v1:/;  // 注意：与 CACHE_PREFIX='SoilPulse:' 大小写一致，否则容量清理匹配不到任何 key

  function cacheKey(type, deviceId) {
    return `${CACHE_PREFIX}${type}:v1:${deviceId}`;
  }
 
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
     trendTabBtn: document.getElementById('trendTabBtn'),
     trendTabPanel: document.getElementById('trendTabPanel'),
     dailyTabBtn: document.getElementById('dailyTabBtn'),
     dailyTabPanel: document.getElementById('dailyTabPanel'),
    dailyMetricTempBtn: document.getElementById('dailyMetricTempBtn'),
    dailyMetricHumBtn: document.getElementById('dailyMetricHumBtn'),
    dailyMetricBattBtn: document.getElementById('dailyMetricBattBtn'),
     modal: document.getElementById('compatibilityModal'),
     modalIcon: document.getElementById('modalIcon'),
     modalTitle: document.getElementById('modalTitle'),
     modalMessage: document.getElementById('modalMessage'),
     modalActionBtn: document.getElementById('modalActionBtn'),
     dailyChart: document.getElementById('dailyChart'),
     dailyEmpty: document.getElementById('dailyEmpty'),
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
     resetChar: null,
    calibChar: null,
    refreshChar: null,
    latestChar: null,
    latestShown: null,   // "Latest measurement" 卡片当前展示的记录（时间戳水位），防止被更旧的历史数据覆盖
    tempOffsetChar: null,
    tempOffsetX10: 0,
    calibStatusChar: null,
    calibSaved: null,
    devNameChar: null,
    otaChar: null,
    otaRunning: false,
    otaLastFirmware: null,
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
   };

   // 温度单位偏好：默认华氏（°F，美国常用），可在温度卡片切换摄氏（°C），持久化到本地
   try {
     state.tempUnit = localStorage.getItem(`${CACHE_PREFIX}tempUnit:v1`) === 'C' ? 'C' : 'F';
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

   const DAILY_METRICS = {
     temp: {
       key: 'temp',
       title: 'Temperature',
       color: '#f59e0b',
       formatValue: v => `${v.toFixed(1)}${tempUnitSymbol()}`,
       axisFormatter: v => v.toFixed(1),
       range: null,
       button: 'dailyMetricTempBtn',
     },
     hum: {
       key: 'hum',
       title: 'Moisture',
       color: '#0ea5e9',
       formatValue: v => `${v.toFixed(1)}%`,
       axisFormatter: v => v.toFixed(0),
       range: [0, 100],
       button: 'dailyMetricHumBtn',
     },
     batt: {
       key: 'battPercent',
       title: 'Battery',
       color: '#10b981',
       formatValue: v => `${v.toFixed(0)}%`,
       axisFormatter: v => v.toFixed(0),
       range: [0, 100],
       button: 'dailyMetricBattBtn',
     },
   };
 
 
   const LOG_T0 = Date.now();   // 中文：日志相对时间基准（页面加载时刻），方便排查"操作后多少 ms 断链"
   function log(msg) {
     if (!DEBUG_ENABLED) return;
     const dt = ((Date.now() - LOG_T0) / 1000).toFixed(1);
     console.debug(`[SoilPulse +${dt}s] ${msg}`);
   }
 
   function setStatus(mode) {
     const map = {
       disconnected: ['bg-slate-300', 'Disconnected', false],
       connecting:   ['bg-amber-400', 'Connecting…', true],
       connected:    ['bg-emerald-500', 'Connected', true],
     };
     const [dot, text, active] = map[mode];
     els.statusDot.className = `w-3 h-3 rounded-full ${dot}`;
     els.statusText.textContent = text;
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

   // Setting 面板仅连接后可操作；未连接时锁定 Tab 并切回 Data（若正停留在 Setting）
   function updateSettingsAccess(connected) {
     els.mainTabSettingBtn.disabled = !connected;
     els.settingLockedHint.classList.toggle('hidden', connected);
     els.settingContent.classList.toggle('hidden', !connected);
     if (!connected && !els.mainTabSettingPanel.classList.contains('hidden')) {
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

   function sanitizeDailyRecords(records) {
     if (!Array.isArray(records)) return [];
     return records
       .filter((r) => Number.isFinite(r?.dateEpoch)
         && r.dateEpoch >= DAILY_EPOCH_MIN_VALID
         && r.dateEpoch <= DAILY_EPOCH_MAX_VALID)
      .sort((a, b) => a.dateEpoch - b.dateEpoch)
      .slice(-7);
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
        && r.timestamp >= 0
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
      .slice(-5);
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
  // 与温度/湿度卡保留最后读数的行为一致
  function syncBatteryPill() {
    els.battPill?.classList.toggle('batt-idle', !(state.device?.gatt.connected && state.latestShown));
  }

  // 清空 live 展示区（切换到另一台设备、或没有该设备缓存时，避免继续显示上一台设备的数据）。
  function resetDisplay() {
    state.lastRecords = null;
    state.latestShown = null;
    state.lastDailyRecords = null;
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

  function clearAllCache() {
    const keys = Object.keys(localStorage).filter((key) => key.startsWith(CACHE_PREFIX));
    keys.forEach((key) => localStorage.removeItem(key));
    resetDisplay();
    log(`Cache cleared: removed ${keys.length} key(s)`);
  }

  // Factory reset 联动：设备端数据全部擦除后，网页本地为该设备缓存的数据同步清除——
  // 校准尝试记录（CALIB_ATTEMPT_KEY，不在 CACHE_PREFIX 下，clearAllCache 管不到）、
  // 该设备的历史/日均值缓存、设备展示名徽章。lastDevice（便于重连）与温度单位偏好保留
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
    function drawYAxisTicks(ctx, lo, hi, padTop, plotH, x, align, color, formatter) {
      ctx.fillStyle = color;
      ctx.font = '10px sans-serif';
      ctx.textAlign = align;
      ctx.textBaseline = 'middle';
      const fmt = formatter || (v => v.toFixed(1));
      for (let i = 0; i <= 4; i++) {
        const val = hi - (hi - lo) * (i / 4);
        const y = padTop + (plotH / 4) * i;
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
    records = sanitizeTrendRecords(records);
    if (!records.length) return;
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
 
     els.historyBody.innerHTML = records
       .map((r, i) => `
         <tr class="border-b border-slate-50 last:border-0">
           <td class="py-2 pr-2 text-slate-400">${i + 1}</td>
           <td class="py-2 pr-2">${formatTime(r.timestamp)}</td>
           <td class="py-2 pr-2 text-amber-500 font-medium">${fmtTemp(r.temp)}</td>
           <td class="py-2 pr-2 text-sky-500 font-medium">${r.hum.toFixed(1)}%</td>
           <td class="py-2 text-emerald-600 font-medium">${r.batt}%</td>
         </tr>`)
       .reverse()
       .join('');
 
     updateTrendSummary(records);
     drawChart(records);
   }

   // Data 面板改版后图下 3 个统计块(trend/dailyLatestValue 等)已从 index.html 移除，
   // 本函数仅维护仍存在的 trendRangeText 时间范围文案；勿再引用已删除的元素
   function updateTrendSummary(records) {
     if (!records || !records.length) {
       els.trendRangeText.textContent = 'No data available';
       return;
     }

     const latest = records[records.length - 1];
     const first = records[0];
     els.trendRangeText.textContent = `Time Range: ${formatShortTime(first.timestamp)} - ${formatShortTime(latest.timestamp)}`;
   }
 
   /**
    * 趋势图（5条历史记录）：温度(左轴,℃) + 湿度(右轴,%，固定0~100)。
    * 为避免遮挡，关键数值放在图下统计区，不在曲线上堆叠标签。
    */
   function drawChart(records) {
     const canvas = els.trendChart;
     if (!canvas || !records || !records.length) return;

     const dpr = window.devicePixelRatio || 1;
     const w = Math.max(280, canvas.clientWidth || canvas.parentElement.clientWidth || 280);
     const compact = w < 420 || isMobileViewport();
     const h = compact ? 240 : 228;
     canvas.width = w * dpr;
     canvas.height = h * dpr;
     const ctx = canvas.getContext('2d');
     ctx.scale(dpr, dpr);
     ctx.clearRect(0, 0, w, h);

     const padTop = compact ? 16 : 20;
     const padBottom = compact ? 38 : 42;
     const padLeft = compact ? 34 : Math.max(38, w * 0.10);
     const padRight = compact ? 34 : Math.max(38, w * 0.10);
     const plotW = w - padLeft - padRight;
     const plotH = h - padTop - padBottom;

     const temps = records.map(r => tempVal(r.temp));
     const hums = records.map(r => r.hum);
     const tRange = niceRange(Math.min(...temps), Math.max(...temps));
     const hLo = 0;
     const hHi = 100;

     drawAxisFrame(ctx, padTop, padLeft, padRight, w, plotH);
     drawYAxisTicks(ctx, tRange.lo, tRange.hi, padTop, plotH, padLeft - 6, 'right', '#f59e0b', v => v.toFixed(1));
     drawYAxisTicks(ctx, hLo, hHi, padTop, plotH, w - padRight + 6, 'left', '#0ea5e9', v => v.toFixed(0));

     if (records.length < 2) {
       const x = padLeft + plotW / 2;
       const yT = padTop + (1 - (temps[0] - tRange.lo) / (tRange.hi - tRange.lo)) * plotH;
       const yH = padTop + (1 - (hums[0] - hLo) / (hHi - hLo)) * plotH;
       ctx.beginPath();
       ctx.arc(x, yT, compact ? 4 : 5, 0, Math.PI * 2);
       ctx.fillStyle = '#fff';
       ctx.fill();
       ctx.lineWidth = 2;
       ctx.strokeStyle = '#f59e0b';
       ctx.stroke();
       ctx.beginPath();
       ctx.arc(x, yH, compact ? 4 : 5, 0, Math.PI * 2);
       ctx.fillStyle = '#fff';
       ctx.fill();
       ctx.strokeStyle = '#0ea5e9';
       ctx.stroke();
       return;
     }

     const stepX = plotW / (records.length - 1);

     const plotSeries = (vals, color, lo, hi, fillArea) => {
       if (fillArea) {
         ctx.beginPath();
         vals.forEach((v, i) => {
           const x = padLeft + i * stepX;
           const y = padTop + (1 - (v - lo) / (hi - lo)) * plotH;
           i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
         });
         ctx.lineTo(padLeft + (vals.length - 1) * stepX, padTop + plotH);
         ctx.lineTo(padLeft, padTop + plotH);
         ctx.closePath();
         ctx.fillStyle = `${color}12`;
         ctx.fill();
       }

       ctx.beginPath();
       ctx.strokeStyle = color;
       ctx.lineWidth = compact ? 2.2 : 2.5;
       ctx.lineJoin = 'round';
       ctx.lineCap = 'round';
       vals.forEach((v, i) => {
         const x = padLeft + i * stepX;
         const y = padTop + (1 - (v - lo) / (hi - lo)) * plotH;
         i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
       });
       ctx.stroke();

       vals.forEach((v, i) => {
         const x = padLeft + i * stepX;
         const y = padTop + (1 - (v - lo) / (hi - lo)) * plotH;
         ctx.beginPath();
         ctx.arc(x, y, compact ? 3.2 : 4, 0, Math.PI * 2);
         ctx.fillStyle = '#fff';
         ctx.fill();
         ctx.lineWidth = compact ? 2 : 2.2;
         ctx.strokeStyle = color;
         ctx.stroke();
       });
     };

     plotSeries(hums, '#0ea5e9', hLo, hHi, true);
     plotSeries(temps, '#f59e0b', tRange.lo, tRange.hi, false);

     ctx.fillStyle = '#94a3b8';
     ctx.font = compact ? '8.5px sans-serif' : '9px sans-serif';
     ctx.textAlign = 'center';
     ctx.textBaseline = 'top';
     const maxLabels = Math.max(2, Math.floor(plotW / (compact ? 50 : 56)));
     const skip = records.length > maxLabels ? Math.ceil(records.length / maxLabels) : 1;
     records.forEach((r, i) => {
       if (i % skip !== 0 && i !== records.length - 1) return;
       const x = padLeft + i * stepX;
       ctx.fillText(formatShortTime(r.timestamp), x, padTop + plotH + 6);
     });
   }

    /**
     * 通用多系列折线图（日均值/功耗图复用）。
     * 支持：固定轴范围（如百分比0-100）、坐标轴框架、latestOnly智能标签。
     */
    function drawMultiSeriesChart(canvas, series, options = {}) {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(280, canvas.clientWidth || canvas.parentElement.clientWidth || 280);
      const h = options.height || 200;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, h);

      const len = series[0]?.values.length || 0;
      if (len < 1) return;

      const rightAxis = options.rightAxisIndices || [];
      const dual = rightAxis.length > 0;

      const padTop = 20;
      const padBottom = 44;
      const padLeft = Math.max(38, w * 0.10);
      const padRight = dual ? Math.max(38, w * 0.10) : Math.max(24, w * 0.06);
      const plotW = w - padLeft - padRight;
      const plotH = h - padTop - padBottom;

      const ranges = series.map(({ values }) => {
        const min = Math.min(...values), max = Math.max(...values);
        return niceRange(min, max);
      });

      const leftIdx = series.map((_, i) => i).filter(i => !rightAxis.includes(i));
      let leftLo = leftIdx.length ? Math.min(...leftIdx.map(i => ranges[i].lo)) : 0;
      let leftHi = leftIdx.length ? Math.max(...leftIdx.map(i => ranges[i].hi)) : 1;
      let rightLo = rightAxis.length ? Math.min(...rightAxis.map(i => ranges[i].lo)) : 0;
      let rightHi = rightAxis.length ? Math.max(...rightAxis.map(i => ranges[i].hi)) : 1;
      if (options.leftAxisRange) { leftLo = options.leftAxisRange[0]; leftHi = options.leftAxisRange[1]; }
      if (options.rightAxisRange) { rightLo = options.rightAxisRange[0]; rightHi = options.rightAxisRange[1]; }

      drawAxisFrame(ctx, padTop, padLeft, padRight, w, plotH);

      const leftColor = options.leftAxisColor || '#64748b';
      const leftFmt = options.leftAxisFormatter || (v => v.toFixed(1));
      drawYAxisTicks(ctx, leftLo, leftHi, padTop, plotH, padLeft - 6, 'right', leftColor, leftFmt);

      if (dual) {
        const rightColor = options.rightAxisColor || '#64748b';
        const rightFmt = options.rightAxisFormatter || (v => v.toFixed(0));
        drawYAxisTicks(ctx, rightLo, rightHi, padTop, plotH, w - padRight + 6, 'left', rightColor, rightFmt);
      }

      if (len < 2) {
        const x = padLeft + plotW / 2;
        series.forEach(({ values, color }, idx) => {
          const useRight = rightAxis.includes(idx);
          const lo = useRight ? rightLo : leftLo;
          const hi = useRight ? rightHi : leftHi;
          const y = padTop + (1 - (values[0] - lo) / (hi - lo)) * plotH;
          ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2);
          ctx.fillStyle = '#fff'; ctx.fill();
          ctx.lineWidth = 2; ctx.strokeStyle = color; ctx.stroke();
        });
        return;
      }

      const stepX = plotW / (len - 1);
      const allLabels = [];

      series.forEach(({ values, color }, idx) => {
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

        values.forEach((v, i) => {
          const x = padLeft + i * stepX;
          const y = padTop + (1 - (v - lo) / (hi - lo)) * plotH;
          ctx.beginPath();
          ctx.arc(x, y, 3.5, 0, Math.PI * 2);
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
          if (i % skip !== 0 && i !== len - 1) return;
          const x = padLeft + i * stepX;
          ctx.fillText(String(label), x, padTop + plotH + 6);
        });
      }
    }
 
   function updateDailyMetricButtons() {
     Object.entries(DAILY_METRICS).forEach(([metric, cfg]) => {
       const btn = els[cfg.button];
       if (!btn) return;
       const active = state.dailyMetric === metric;
       btn.className = `daily-metric-btn rounded-lg px-2.5 py-1.5 text-xs font-semibold transition ${active ? 'bg-white shadow-sm' : 'text-slate-500'}`;
       btn.style.color = active ? cfg.color : '';
     });
   }

   function updateTempUnitUI() {
     const active = state.tempUnit;
     (els.tempUnitToggle?.querySelectorAll('.temperature-unit-btn') || []).forEach(btn => {
       const isActive = btn.dataset.unit === active;
       btn.className = `temperature-unit-btn rounded-md transition font-semibold leading-none ${isActive ? 'bg-amber-500 text-white shadow-sm px-1.5 py-[3px] text-sm' : 'text-slate-500 px-1 py-[3px] text-[10px]'}`;
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
    records = sanitizeDailyRecords(records);
    state.lastDailyRecords = records;
     const cfg = DAILY_METRICS[state.dailyMetric] || DAILY_METRICS.temp;
     updateDailyMetricButtons();

     if (!records || !records.length) {
       els.dailyEmpty.classList.remove('hidden');
       const ctx = els.dailyChart.getContext('2d');
       if (ctx) ctx.clearRect(0, 0, els.dailyChart.width, els.dailyChart.height);
       return;
     }

     els.dailyEmpty.classList.add('hidden');

     const xLabels = records.map(r => formatMonthDay(r.dateEpoch));
     let values = records.map(r => Number(r[cfg.key]) || 0);
     if (cfg.key === 'temp') values = values.map(tempVal);

     drawMultiSeriesChart(els.dailyChart, [
       { values, color: cfg.color },
     ], {
       showValueLabels: false,
       xLabels,
       height: isMobileViewport() ? 240 : 228,
       leftAxisRange: cfg.range || undefined,
       leftAxisColor: cfg.color,
       leftAxisFormatter: cfg.axisFormatter,
     });

     saveDailyRecordsCache(records, state.activeDeviceId);
   }
 
   function switchChartTab(tab) {
     const isTrend = tab === 'trend';
     els.trendTabPanel.classList.toggle('hidden', !isTrend);
     els.dailyTabPanel.classList.toggle('hidden', isTrend);
     els.trendTabBtn.className = `chart-tab-btn flex-1 px-3 py-1.5 rounded-lg text-sm font-semibold transition ${isTrend ? 'bg-emerald-700 text-white' : 'bg-slate-100 text-slate-500'}`;
     els.dailyTabBtn.className = `chart-tab-btn flex-1 px-3 py-1.5 rounded-lg text-sm font-semibold transition ${isTrend ? 'bg-slate-100 text-slate-500' : 'bg-emerald-700 text-white'}`;
 
     if (isTrend && state.lastRecords) {
       drawChart(state.lastRecords);
     } else if (!isTrend && state.lastDailyRecords) {
       renderDaily(state.lastDailyRecords);
     } else if (!isTrend) {
       updateDailyMetricButtons();
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
     if (isSetting && els.mainTabSettingBtn.disabled) return;  // setting 仅连接后可点
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
     if (!state.dailyChar) return;
     const val = await state.dailyChar.readValue();
     const rawRecords = BLEProtocol.parseDailyPacket(val);
     const records = sanitizeDailyRecords(rawRecords);
     const dropped = rawRecords.length - records.length;
     if (dropped > 0) {
       log(`Daily read filtered ${dropped} invalid record(s)`);
     }
     log(`Daily read: ${records.length} day(s)`);
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
 
   function onDisconnected() {
      // 重入保护：gattserverdisconnected 事件 / 轮询 / forceDisconnect / visibilitychange
      // 可能并发触发，第一个进入的路径执行清理，后续直接返回（避免重复日志/重复复位）
      if (state.disconnecting) return;
      // 幂等保护：已被其它路径清理过（轮询 / visibilitychange / 用户点击）则直接返回
      if (state.characteristic === null && state.device === null) return;
      state.disconnecting = true;
      try {
        stopPolling();         // 先停定时器：防止清理期间轮询再跑一拍（断开后 GATT 报错噪音的来源）
        cancelRefreshWait();   // 若 refresh 正在等待测量结果，断连后立即恢复按钮
        state.otaRunning = false;
        setConnectBusy(false);   // 断开完成：解锁 Connect 按钮
        setOtaUiLock(false);
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
        state.tempOffsetX10 = 0;
        state.calibStatusChar = null;
        state.otaChar = null;
        state.otaRunning = false;
        state.fwUpdate = null;
        renderFirmwareCard();
        // 断开后隐藏"已校准"徽标；设备名保留展示（最近一次连接的设备名，不随断开隐藏）
        renderCalibHints(null);
        if (els.devNameStatus) els.devNameStatus.textContent = '';
        log('Device disconnected');
      } finally {
        state.disconnecting = false;
      }
    }
 
   // 剪贴板写入（iOS Safari 兼容）：优先 Clipboard API（要求 HTTPS + 在用户手势内调用），
   // 失败或不可用时回退到隐藏 textarea + document.execCommand('copy') 的同步复制方案。
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

   function showModal(isIOS, isAndroid) {
     const ua = navigator.userAgent;
     const isWeChat = /MicroMessenger/i.test(ua);
     const isChrome = /Chrome/.test(ua) && !/wv/i.test(ua) && !/WebView/i.test(ua);
 
     if (isIOS) {
       els.modalIcon.innerHTML = '<img src="./page/images/alinfancy-logo.svg" alt="logo" class="w-8 h-8 mx-auto" />';
       els.modalTitle.textContent = 'Bluetooth Unavailable in Browser';
       els.modalMessage.textContent = 'iOS Browser does not support Web Bluetooth. Tap "Open in Bluefy" to continue — the dashboard link will be copied to your clipboard so you can paste it into Bluefy after installing.';
       els.modalActionBtn.textContent = 'Open in Bluefy';
       els.modalActionBtn.href = BLUEFY_APPSTORE_URL;
       els.modalActionBtn.onclick = async (e) => {
         e.preventDefault();
         // iOS Safari 只允许在用户手势内写剪贴板，且此刻还无法判断是否已安装 Bluefy，
         // 因此必须"先复制、后跳转"：已安装 → 深链直接打开 Bluefy 加载 Dashboard；
         // 未安装 → 回退 App Store，用户装好 Bluefy 后打开它，长按地址栏粘贴剪贴板里
         // 的地址即可进入本页。加 400ms 超时兜底，避免剪贴板写入异常时卡住深链跳转。
         const copied = await Promise.race([
           copyTextToClipboard(window.location.href),
           new Promise((resolve) => setTimeout(() => resolve(false), 400)),
         ]);
         els.modalMessage.textContent = copied
           ? '✅ Dashboard link copied to clipboard. Opening Bluefy… If it is not installed, you will be taken to the App Store — after installing, open Bluefy and paste the link to continue.'
           : `After installing Bluefy from the App Store, open it and manually enter this address: ${window.location.href}`;

         const start = Date.now();
         // 先尝试 Bluefy 深链直接加载 Dashboard；2.5s 后页面仍在前台说明深链未拉起（未安装），
         // 回退 App Store。已安装时页面被切到后台：pagehide 会清除定时器；即使定时器被系统
         // 暂停后恢复触发，此时页面已隐藏（document.hidden）或 elapsed 已超 5s，均不会误跳。
         const fallback = setTimeout(() => {
           if (!document.hidden && Date.now() - start < 5000) {
             window.location.href = BLUEFY_APPSTORE_URL;
           }
         }, 2500);
         window.addEventListener('pagehide', () => clearTimeout(fallback), { once: true });
         window.location.href = BLUEFY_DEEPLINK;
       };
       els.modalActionBtn.classList.remove('hidden');
     } else if (isAndroid) {
       els.modalIcon.innerHTML = '<img src="./page/images/alinfancy-logo.svg" alt="logo" class="w-8 h-8 mx-auto" />';
       els.modalTitle.textContent = 'Browser Web Bluetooth Unavailable';
       if (isWeChat) {
         els.modalMessage.textContent = 'WeChat\'s built-in browser does not support Web Bluetooth. Tap the menu in the top-right corner and choose "Open in Browser", then use Google Chrome.';
       } else if (!isChrome) {
         els.modalMessage.textContent = 'Your browser does not support Web Bluetooth. Please open this page in Google Chrome.';
       } else {
         els.modalMessage.textContent = 'Your browser does not support Web Bluetooth. Please use Google Chrome.';
       }
       els.modalActionBtn.textContent = 'Get Chrome on Google Play';
       els.modalActionBtn.href = 'https://play.google.com/store/apps/details?id=com.android.chrome';
       els.modalActionBtn.classList.remove('hidden');
     } else {
       els.modalIcon.textContent = '💻';
       els.modalTitle.textContent = 'Web Bluetooth Unavailable';
       els.modalMessage.textContent = 'Please use Google Chrome to access this site';
       els.modalActionBtn.classList.add('hidden');
     }
 
     els.modal.classList.remove('hidden');
     els.modal.classList.add('flex');
   }
 
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

   async function handleConnect() {
     if (!navigator.bluetooth) {
       const ua = navigator.userAgent;
       showModal(/iPad|iPhone|iPod/.test(ua) && !window.MSStream, /Android/.test(ua));
       return;
     }

     const token = ++connectToken;
     clearConnectError();   // 新的连接尝试开始，清除上一次失败的红字提示
     setConnectBusy(true);   // 进入连接流程：锁定 Connect 按钮，防止连接过程中重复点击
     try {
       setStatus('connecting');
       log('Requesting Bluetooth Device...');

       // 阶段1：仅弹设备选择器（不设超时，用户挑设备时长不受限）
       const device = await BLEProtocol.requestSoilDevice();
       if (token !== connectToken) return;   // 期间用户又发起了新连接，丢弃本次

       // 阶段2：gatt.connect + 服务/特征发现，由 finishConnect 内部保证 5s 超时
       const { dataChar, dailyChar, resetChar, calibChar, refreshChar, tempOffsetChar, calibStatusChar, devNameChar, latestChar, otaChar, fwVersion } = await BLEProtocol.finishConnect(
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
       state.fwVersion = fwVersion;
       checkFirmwareUpdate();

       // 设备已连上 GATT 即置 connected：按钮立即可用；notify 订阅移后台，不再阻塞按钮 ready
       setStatus('connected');
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

       // —— 以下为数据加载，串行后台执行，不阻塞按钮 ready ——
       // 读取设备当前温度偏移，同步设置面板滑杆；旧固件无此特征则保持 0 并提示不支持
       if (tempOffsetChar) {
         try {
           state.tempOffsetX10 = await BLEProtocol.readTempOffset(tempOffsetChar);
           renderTempOffset();
           els.tempOffsetStatus.textContent = '';
         } catch (err) {
           state.tempOffsetX10 = 0;
           renderTempOffset();
           log(`Temperature offset read failed: ${err.message || err}`);
         }
       } else {
         state.tempOffsetX10 = 0;
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
       } else if (/cancel|chooser/i.test(errMsg)) {
         log('Connection chooser dismissed by user (not an error)');
       } else {
         log(`Connection failed: ${err.message || err}`);
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
   // 且 gattserverdisconnected 事件在 WebKit 上可能不补发，这里主动校正 UI
   document.addEventListener('visibilitychange', () => {
     if (document.visibilityState === 'visible' && state.device && !state.device.gatt.connected) {
       onDisconnected();
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
     clearAllCache();
     // 向已连接设备下发 Clear/Reset 指令，清空芯片 RAM 历史/日均值
     if (state.resetChar) {
       await gattOp(() => BLEProtocol.sendReset(state.resetChar), 'Device reset write (0xFFE5)');
       log('Device reset command sent (0xFFE5)');
     }
   }));

  // ===== 问题3加固：GATT 操作超时 + 断链类错误识别 + 主动断连 =====
  const GATT_OP_TIMEOUT_MS = 5000;

  // 给任意 GATT Promise 包一层 5s 超时：底层链路半死时 readValue/writeValue 可能永远
  // 悬空（挂死会卡死 gattBusy 与按钮流程）。超时只是放弃等待，底层操作无法真正取消
  function withGattTimeout(promise, label = 'GATT operation') {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${GATT_OP_TIMEOUT_MS / 1000}s`)), GATT_OP_TIMEOUT_MS);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  // ===== 全局 GATT 互斥锁 =====
  // 安卓 Chrome 蓝牙栈同一时刻只允许一个 in-flight GATT 操作：上一个未完成时发新操作
  // 直接抛 "GATT operation already in progress" / status 133（iOS/PC 系统栈会内部排队，
  // 不会出现）。所有按钮写统一经 gattOp 串行化；轮询/Refresh 轮询走 gattBusy 跳拍（非阻塞）。
  // 锁内操作都有 withGattTimeout 兜底，保证锁必然释放（≤5s）。
  async function gattOp(op, label = 'GATT operation') {
    let waited = false;
    while (state.gattBusy) {
      waited = true;
      await new Promise((r) => setTimeout(r, 25));
    }
    if (waited) log(`gattOp [${label}]: waited for GATT lock`);
    state.gattBusy = true;
    try {
      return await withGattTimeout(op(), label);
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
  // 本地 gatt.disconnect() 强制清理协议栈状态；onDisconnected 幂等，复位全部界面
  function forceDisconnect(reason) {
    log(`Connection lost${reason ? ` — ${reason}` : ''}`);
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
    setTempOffsetTicks(Number.isFinite(raw) ? Math.round(raw * 10) : tempOffsetToTicks(state.tempOffsetX10 || 0));
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
    const x10 = ticksToTempOffset(tempOffsetTicksFromInput());   // ℉ 格四舍五入对齐设备 0.1℃ 网格
    els.tempOffsetApplyBtn.disabled = true;
    els.tempOffsetStatus.textContent = 'Applying temperature offset…';
    try {
      await gattOp(() => BLEProtocol.sendTempOffset(state.tempOffsetChar, x10), 'Offset write (0xFFE8)');
      state.tempOffsetX10 = x10;
      renderTempOffset();   // 回显设备 0.1℃ 网格真实值（℉ 模式滑杆位置可能微调 ≤1 格）
      els.tempOffsetStatus.textContent = `Temperature offset set to ${fmtTempDelta(x10 / 10)}`;
      log(`Temperature offset sent (0xFFE8): ${x10 / 10}℃`);
      // 立即重测，让 Data 面板尽快反映修正后的温度
      if (state.refreshChar) {
        try { await gattOp(() => BLEProtocol.sendRefresh(state.refreshChar), 'Refresh write (0xFFE7)'); } catch (_) {}
      }
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
    setOtaRetryVisible(false);
    els.otaStatus.textContent = `Downloading v${upd.version}…`;
    try {
      const res = await fetch(upd.url, { cache: "no-store" });
      if (!res.ok) throw new Error(`firmware download failed: HTTP ${res.status}`);
      await runOtaUpdate(await res.arrayBuffer(), upd.bin);
    } catch (err) {
      els.otaStatus.textContent = formatOtaError(err);
      els.otaStatus.className = "text-xs font-medium text-rose-600";
      setOtaRetryVisible(true);
      log(`[OTA] error: ${err.message || err}`);
    } finally {
      els.otaUpdateNowBtn.disabled = state.otaRunning || !state.device?.gatt.connected || !state.fwUpdate;
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
    await runOtaUpdate(last.firmware, last.label);
  });

  // OTA 推送主流程（手动选文件 / 一键升级共用）：进度条 + 结果展示 + 按钮态恢复
  async function runOtaUpdate(firmware, label) {
    state.otaRunning = true;
    state.otaLastFirmware = { firmware, label };
    stopPolling(); // OTA 期间暂停轮询，避免 GATT 读写抢占升级链路
    setOtaUiLock(true);
    els.otaProgressWrap.classList.remove("hidden");
    els.otaUpdateNowBtn.disabled = true;
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
        if (info.phase === "data") {
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
        renderFirmwareCard();
      }
    } catch (err) {
      // 中文：真实中途断链会走到这里（并非“已在进行中”类忙碌错误），需展示安抚性提示而非原始报错文案
      els.otaStatus.textContent = formatOtaError(err);
      els.otaStatus.className = "text-xs font-medium text-rose-600";
      setOtaRetryVisible(true);
      log(`[OTA] error: ${err.message || err}`);
    } finally {
      state.otaRunning = false;
      // 成功后设备自动重启断链；失败但仍连接则恢复轮询与按钮态
      if (state.device?.gatt.connected) {
        setOtaUiLock(false);
        setStatus("connected");
        startPolling();
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
      const isForce = m.latest.isforce === true;
      if (String(state.fwVersion || "") === String(m.latest.version)
        || (!isForce && compareVersions(m.latest.version, state.fwVersion) <= 0)) {
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
    const ver = state.fwVersion || 'unknown';
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
  // 设备存储恒为 0.1℃（s8），℉ 格写入时四舍五入到 0.1℃ 网格（偏差 ≤0.05℉），
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
    const x10 = state.tempOffsetX10 || 0;
    const range = tempOffsetRange();
    // 数字框随单位切换同步量程（℃ ±10.0 / ℉ ±18.0）、步进与单位后缀
    els.tempOffsetInput.min = String(range.min / 10);
    els.tempOffsetInput.max = String(range.max / 10);
    els.tempOffsetInput.step = '0.1';
    if (els.tempOffsetUnitSpan) els.tempOffsetUnitSpan.textContent = tempDeltaSymbol();
    els.tempOffsetInput.value = (tempOffsetToTicks(x10) / 10).toFixed(1);
  }

  els.trendTabBtn.addEventListener('click', () => switchChartTab('trend'));
   els.dailyTabBtn.addEventListener('click', () => switchChartTab('daily'));
  els.dailyMetricTempBtn.addEventListener('click', () => setDailyMetric('temp'));
  els.dailyMetricHumBtn.addEventListener('click', () => setDailyMetric('hum'));
  els.dailyMetricBattBtn.addEventListener('click', () => setDailyMetric('batt'));
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
 
   if (!navigator.bluetooth) {
     const ua = navigator.userAgent;
     showModal(/iPad|iPhone|iPod/.test(ua) && !window.MSStream, /Android/.test(ua));
     els.connectBtn.disabled = true;
     els.connectBtn.classList.add('opacity-40', 'cursor-not-allowed');
   }
 })();