/**
 * SoilPulse Dashboard Application UI Manager
 */
 (() => {
   'use strict';
 
   // 集中配置统一取自 page/js/config.js，方便后续维护管理
   const {
     PAGE_VERSION,
     DEV_NAME_MAX_BYTES,
     DEBUG_ENABLED, POLL_INTERVAL,
     DASHBOARD_URL, BLUEFY_APPSTORE_URL, BLUEFY_DEEPLINK,
     DAILY_EPOCH_MIN_VALID, DAILY_EPOCH_MAX_VALID, TREND_EPOCH_MAX_VALID,
     CACHE_PREFIX, CACHE_MAX_ITEM_BYTES, CACHE_MAX_TOTAL_BYTES,
     FIRMWARE_MANIFEST_URL,
     TEMP_OFFSET,
} = SoilPulseConfig;
  // 缓存 key 按设备唯一标识（device.id，Web Bluetooth 分配，浏览器内可视为等价 MAC）分区，
  // 避免连接不同土壤检测器时数据互相覆盖。lastDevice 指针用于刷新页面后自动回显上次设备的数据。
  const LAST_DEVICE_KEY = `${CACHE_PREFIX}lastDevice:v1`;
  const RECORD_KEY_RE = /^soilPulse:(trend|daily):v1:/;

  function cacheKey(type, deviceId) {
    return `${CACHE_PREFIX}${type}:v1:${deviceId}`;
  }
 
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
    refreshBtn: document.getElementById('refreshBtn'),
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
    tempOffsetSlider: document.getElementById('tempOffsetSlider'),
    tempOffsetValue: document.getElementById('tempOffsetValue'),
    tempOffsetApplyBtn: document.getElementById('tempOffsetApplyBtn'),
    tempOffsetStatus: document.getElementById('tempOffsetStatus'),
    factoryResetBtn: document.getElementById('factoryResetBtn'),
    factoryResetStatus: document.getElementById('factoryResetStatus'),
     tempValue: document.getElementById('tempValue'),
     tempUnitLabel: document.getElementById('tempUnitLabel'),
     tempUnitToggle: document.getElementById('tempUnitToggle'),
     humValue: document.getElementById('humValue'),
     battValue: document.getElementById('battValue'),
     lastUpdate: document.getElementById('lastUpdate'),
     historyBody: document.getElementById('historyBody'),
     trendChart: document.getElementById('trendChart'),
    trendTempLatest: document.getElementById('trendTempLatest'),
    trendHumLatest: document.getElementById('trendHumLatest'),
    trendBattLatest: document.getElementById('trendBattLatest'),
    trendRangeText: document.getElementById('trendRangeText'),
     trendTabBtn: document.getElementById('trendTabBtn'),
     trendTabPanel: document.getElementById('trendTabPanel'),
     dailyTabBtn: document.getElementById('dailyTabBtn'),
     dailyTabPanel: document.getElementById('dailyTabPanel'),
    dailyMetricTempBtn: document.getElementById('dailyMetricTempBtn'),
    dailyMetricHumBtn: document.getElementById('dailyMetricHumBtn'),
    dailyMetricBattBtn: document.getElementById('dailyMetricBattBtn'),
    dailyMetricHint: document.getElementById('dailyMetricHint'),
    dailyLatestValue: document.getElementById('dailyLatestValue'),
    dailyAvgValue: document.getElementById('dailyAvgValue'),
    dailyChangeValue: document.getElementById('dailyChangeValue'),
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
     downloadPdfBtn: document.getElementById('downloadPdfBtn'),
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
     lastRecords: null,
     lastDailyRecords: null,
     dailyMetric: 'temp',
     tempUnit: 'F',
   };

   // 温度单位偏好：默认华氏（°F，美国常用），可在温度卡片切换摄氏（°C），持久化到本地
   try {
     state.tempUnit = localStorage.getItem(`${CACHE_PREFIX}tempUnit:v1`) === 'C' ? 'C' : 'F';
   } catch (_) {
     state.tempUnit = 'F';
   }

   function cToF(c) { return (c * 9 / 5) + 32; }
   function tempUnitSymbol() { return state.tempUnit === 'F' ? '°F' : '°C'; }
   function tempVal(c) { return state.tempUnit === 'F' ? cToF(c) : c; }
   function fmtTemp(c, decimals = 1) { return `${tempVal(c).toFixed(decimals)}${tempUnitSymbol()}`; }

   const DAILY_METRICS = {
     temp: {
       key: 'temp',
       title: 'Temperature',
       color: '#f97316',
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
 
 
   function log(msg) {
     if (!DEBUG_ENABLED) return;
     console.debug(`[SoilPulse] ${msg}`);
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
     els.connectBtn.textContent = mode === 'connected' ? 'Disconnect' : 'Connect device';
     const connected = mode === 'connected';
    els.calibDryBtn.disabled = !connected;
    els.calibWetBtn.disabled = !connected;
    els.calibStatus.textContent = connected
      ? 'Place the probe, wait a few seconds, then tap dry or wet calibration'
      : 'Connect a device to enable calibration';
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
     els.tempOffsetSlider.disabled = !connected || !state.tempOffsetChar;
     els.tempOffsetApplyBtn.disabled = !connected || !state.tempOffsetChar;
     els.factoryResetBtn.disabled = !connected || !state.resetChar;
     if (!connected) {
       els.tempOffsetStatus.textContent = 'Connect a device to adjust temperature offset';
       els.factoryResetStatus.textContent = 'Connect a device to reset';
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
    els.tempOffsetSlider.disabled = lock || !connected || !state.tempOffsetChar;
    els.tempOffsetApplyBtn.disabled = lock || !connected || !state.tempOffsetChar;
    els.factoryResetBtn.disabled = lock || !connected || !state.resetChar;
    els.mainTabSettingBtn.disabled = lock || !connected;

    if (lock) {
      els.statusDot.className = 'w-3 h-3 rounded-full bg-violet-500';
      els.statusText.textContent = 'Updating firmware…';
      els.calibStatus.textContent = 'Firmware update in progress, calibration is temporarily disabled';
    }
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

  // 清空 live 展示区（切换到另一台设备、或没有该设备缓存时，避免继续显示上一台设备的数据）。
  function resetDisplay() {
    state.lastRecords = null;
    state.lastDailyRecords = null;
    els.tempValue.textContent = '--';
    els.humValue.textContent = '--';
    els.battValue.textContent = '--';
    els.lastUpdate.textContent = 'No measurement received yet';
    els.historyBody.innerHTML = '<tr><td colspan="5" class="py-6 text-center text-slate-300">Connect a device to view history</td></tr>';
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
 
     els.tempValue.textContent = tempVal(latest.temp).toFixed(1);
     els.humValue.textContent = latest.hum.toFixed(1);
     els.battValue.textContent = latest.batt;
     els.lastUpdate.textContent = `Latest measurement: ${formatTime(latest.timestamp)}`;
 
     els.historyBody.innerHTML = records
       .map((r, i) => `
         <tr class="border-b border-slate-50 last:border-0">
           <td class="py-2 pr-2 text-slate-400">${i + 1}</td>
           <td class="py-2 pr-2">${formatTime(r.timestamp)}</td>
           <td class="py-2 pr-2 text-orange-500 font-medium">${fmtTemp(r.temp)}</td>
           <td class="py-2 pr-2 text-sky-500 font-medium">${r.hum.toFixed(1)}%</td>
           <td class="py-2 text-emerald-600 font-medium">${r.batt}%</td>
         </tr>`)
       .reverse()
       .join('');
 
     updateTrendSummary(records);
     drawChart(records);
   }

   function updateTrendSummary(records) {
     if (!records || !records.length) {
       els.trendTempLatest.textContent = '--';
       els.trendHumLatest.textContent = '--';
       els.trendBattLatest.textContent = '--';
       els.trendRangeText.textContent = 'Waiting for device data';
       return;
     }

     const latest = records[records.length - 1];
     const first = records[0];
     els.trendTempLatest.textContent = fmtTemp(latest.temp);
     els.trendHumLatest.textContent = `${latest.hum.toFixed(1)}%`;
     els.trendBattLatest.textContent = `${latest.batt.toFixed(0)}%`;
     els.trendRangeText.textContent = `Time range: ${formatShortTime(first.timestamp)} - ${formatShortTime(latest.timestamp)}`;
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
     drawYAxisTicks(ctx, tRange.lo, tRange.hi, padTop, plotH, padLeft - 6, 'right', '#f97316', v => v.toFixed(1));
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
       ctx.strokeStyle = '#f97316';
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
     plotSeries(temps, '#f97316', tRange.lo, tRange.hi, false);

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
       btn.className = `temperature-unit-btn px-2 py-0.5 text-[11px] font-semibold rounded-md transition ${isActive ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500'}`;
     });
     try { localStorage.setItem(`${CACHE_PREFIX}tempUnit:v1`, active); } catch (_) {}
     if (els.tempUnitLabel) els.tempUnitLabel.textContent = `Temperature ${tempUnitSymbol()}`;
     if (state.lastRecords) {
       render(state.lastRecords);
     } else {
       els.tempValue.textContent = '--';
     }
     if (state.lastDailyRecords) renderDaily(state.lastDailyRecords);
   }

   function formatSignedMetricValue(cfg, value) {
     if (value === 0) return cfg.formatValue(0);
     const sign = value > 0 ? '+' : '-';
     return `${sign}${cfg.formatValue(Math.abs(value))}`;
   }

   function renderDaily(records) {
    records = sanitizeDailyRecords(records);
    state.lastDailyRecords = records;
     const cfg = DAILY_METRICS[state.dailyMetric] || DAILY_METRICS.temp;
     updateDailyMetricButtons();

     if (!records || !records.length) {
       els.dailyEmpty.classList.remove('hidden');
       els.dailyLatestValue.textContent = '--';
       els.dailyAvgValue.textContent = '--';
       els.dailyChangeValue.textContent = '--';
       els.dailyLatestValue.style.color = '';
       els.dailyAvgValue.style.color = '';
       els.dailyChangeValue.style.color = '';
       els.dailyMetricHint.textContent = 'Single metric view for clear comparison';
       const ctx = els.dailyChart.getContext('2d');
       if (ctx) ctx.clearRect(0, 0, els.dailyChart.width, els.dailyChart.height);
       return;
     }

     els.dailyEmpty.classList.add('hidden');

     const xLabels = records.map(r => formatMonthDay(r.dateEpoch));
     let values = records.map(r => Number(r[cfg.key]) || 0);
     if (cfg.key === 'temp') values = values.map(tempVal);
     const latest = values[values.length - 1];
     const first = values[0];
     const avg = values.reduce((sum, v) => sum + v, 0) / values.length;

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

     els.dailyLatestValue.textContent = cfg.formatValue(latest);
     els.dailyAvgValue.textContent = cfg.formatValue(avg);
     els.dailyChangeValue.textContent = formatSignedMetricValue(cfg, latest - first);
     els.dailyLatestValue.style.color = cfg.color;
     els.dailyAvgValue.style.color = cfg.color;
     els.dailyChangeValue.style.color = cfg.color;
     els.dailyMetricHint.textContent = `${cfg.title}${cfg.key === 'temp' ? ` (${tempUnitSymbol()})` : ''} · ${xLabels[0]} - ${xLabels[xLabels.length - 1]}`;
    saveDailyRecordsCache(records, state.activeDeviceId);
   }
 
   function switchChartTab(tab) {
     const isTrend = tab === 'trend';
     els.trendTabPanel.classList.toggle('hidden', !isTrend);
     els.dailyTabPanel.classList.toggle('hidden', isTrend);
     els.trendTabBtn.className = `chart-tab-btn flex-1 px-3 py-1.5 rounded-lg text-sm font-semibold transition ${isTrend ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-500'}`;
     els.dailyTabBtn.className = `chart-tab-btn flex-1 px-3 py-1.5 rounded-lg text-sm font-semibold transition ${isTrend ? 'bg-slate-100 text-slate-500' : 'bg-emerald-600 text-white'}`;
 
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
     if (!DEBUG_ENABLED) return;
     state.pollTimer = setInterval(async () => {
       if (!state.characteristic) return;
       // 底层连接已断但 gattserverdisconnected 事件未触发（页面后台 / 平台差异）：
       // 轮询主动校正 UI 状态，避免"断线但界面仍显示 Connected"
       if (!state.device?.gatt.connected) {
         onDisconnected();
         return;
       }
       await readData().catch(e => log(`Poll failed: ${e.message}`));
     }, POLL_INTERVAL);
   }
 
   function stopPolling() {
     if (state.pollTimer) {
       clearInterval(state.pollTimer);
       state.pollTimer = null;
     }
   }
 
   function onDisconnected() {
     // 幂等保护：已被其它路径清理过（轮询 / visibilitychange / 用户点击）则直接返回，
     // 避免重复 setStatus / 重复日志
     if (state.characteristic === null) return;
     stopPolling();
     state.otaRunning = false;
     setOtaUiLock(false);
     setStatus('disconnected');
     state.characteristic = null;
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
     // 断开后隐藏"已校准"徽标与设备名（下次连接时重新读取）
     renderCalibHints(null);
     if (els.deviceNameText) els.deviceNameText.classList.add('hidden');
     if (els.devNameStatus) els.devNameStatus.textContent = '';
     log('Device disconnected');
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
       els.modalMessage.textContent = 'Please use Chrome / Edge over HTTPS or localhost.';
       els.modalActionBtn.classList.add('hidden');
     }
 
     els.modal.classList.remove('hidden');
     els.modal.classList.add('flex');
   }
 
let connectToken = 0;   // 用于丢弃“超时/失败后又迟到成功”的连接，防止幽灵状态

   async function handleConnect() {
     if (!navigator.bluetooth) {
       const ua = navigator.userAgent;
       showModal(/iPad|iPhone|iPod/.test(ua) && !window.MSStream, /Android/.test(ua));
       return;
     }

     const token = ++connectToken;
     try {
       setStatus('connecting');
       log('Requesting Bluetooth Device...');

       // 阶段1：仅弹设备选择器（不设超时，用户挑设备时长不受限）
       const device = await BLEProtocol.requestSoilDevice();
       if (token !== connectToken) return;   // 期间用户又发起了新连接，丢弃本次

       // 阶段2：gatt.connect + 服务/特征发现，由 finishConnect 内部保证 5s 超时
       const { dataChar, dailyChar, resetChar, calibChar, refreshChar, tempOffsetChar, calibStatusChar, devNameChar, otaChar, fwVersion } = await BLEProtocol.finishConnect(
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
       state.tempOffsetChar = tempOffsetChar;
       state.calibStatusChar = calibStatusChar;
       state.devNameChar = devNameChar;
       state.otaChar = otaChar;
       state.fwVersion = fwVersion;
       checkFirmwareUpdate();

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

       setStatus('connected');
       log('Connected & Listening for updates.');
       startPolling();

       // 读取设备已保存的校准状态（0xFFE9），在干/湿校准点展示"已校准"提示（只提示存在性，不展示具体数值）
       await refreshCalibHints();

       
     } catch (err) {
       if (token !== connectToken) return;   // 超时/失败期间用户已重新点击，不被覆盖
       setStatus('disconnected');
       if (String(err && err.message).includes('CONNECT_TIMEOUT')) {
         els.statusText.textContent = 'Connect timed out — device may be sleeping (touch it to wake) or Bluetooth is off';
         log('Connection timed out after 10s');
       } else {
         log(`Connection failed: ${err.message || err}`);
       }
     }
   }
 
   function handleDisconnect() {
     if (state.device?.gatt.connected) {
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
 
   els.clearCacheBtn.addEventListener('click', async () => {
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
       try {
         await BLEProtocol.sendReset(state.resetChar);
         log('Device reset command sent (0xFFE5)');
       } catch (err) {
         log(`Device reset failed: ${err.message || err}`);
       }
     }
   });

  // 读取设备 0xFFE9 校准状态并刷新干/湿校准点的"已校准"提示。
  // 返回 'ok'（成功读到设备真实校准状态，state.calibSaved 有效）或 'unavailable'
  // （特征缺失/读取失败——常见于设备还是旧固件（无 0xFFE9）、iOS/Bluefy 缓存了旧 GATT
  //  属性表、或浏览器缓存了旧版页面脚本）。调用方必须区分这两种情况：
  //  读取通道不可用 ≠ 校准被设备拒绝。
  async function refreshCalibHints() {
    if (!state.calibStatusChar) {
      renderCalibHints(null);
      log('Calibration status characteristic unavailable: old firmware, cached GATT table or stale page cache');
      return 'unavailable';
    }
    try {
      const saved = await BLEProtocol.readCalibStatus(state.calibStatusChar);
      renderCalibHints(saved);
      log(`Calibration status read (0xFFE9): dry=${saved.dry} wet=${saved.wet} temp=${saved.temp}`);
      return 'ok';
    } catch (err) {
      renderCalibHints(null);
      log(`Calibration status read failed: ${err.message || err}`);
      return 'unavailable';
    }
  }

  // 渲染干/湿校准点的"已校准"徽标与汇总文案：只提示设备上存在哪些校准，不展示具体校准数值
  function renderCalibHints(saved) {
    state.calibSaved = saved;
    els.calibDryBadge.classList.toggle('hidden', !saved?.dry);
    els.calibWetBadge.classList.toggle('hidden', !saved?.wet);
    if (saved === null) return;
    const parts = [];
    if (saved.dry) parts.push('dry');
    if (saved.wet) parts.push('wet');
    if (saved.temp) parts.push('temperature offset');
    els.calibStatus.textContent = parts.length
      ? `Saved on device (survives reboot): ${parts.join(', ')} calibration`
      : 'No calibration saved on device yet';
  }

  // 校准前强制设备用当前探头状态立即重测，并等待新测量结果到达。
  // 原因：固件校准使用的是"最近一次测量"（s_last_measure），若用户切换探头状态（如浸水）
  // 后设备尚未采样，固件会用旧状态读数做校准，导致"两点过近"被拒绝（gap < 50mV）。
  async function waitForHumiditySample(timeoutMs = 8000) {
    const t0 = Date.now();
    const prev = state.lastRecords?.length ? state.lastRecords[state.lastRecords.length - 1] : null;
    while (Date.now() - t0 < timeoutMs) {
      await new Promise(resolve => setTimeout(resolve, 400));
      try { await readData(); } catch (_) { /* 单次读取失败不中断，继续等待 */ }
      const latest = state.lastRecords?.length ? state.lastRecords[state.lastRecords.length - 1] : null;
      if (latest && (!prev || latest.timestamp !== prev.timestamp || latest.hum !== prev.hum)) {
        return latest;
      }
    }
    return state.lastRecords?.length ? state.lastRecords[state.lastRecords.length - 1] : null;
  }

  async function handleCalibClick(point, label) {
    if (state.otaRunning) {
      log('Calibration ignored: OTA update is running');
      return;
    }
    if (!state.device?.gatt.connected || !state.calibChar) {
      els.calibStatus.textContent = 'Connect a device to enable calibration';
      return;
    }

    // 确认弹窗：提示设备将先测量当前探头状态，再用本次新鲜采样自动应用校准（取电量稳定采样的值）
    const expectDry = point === 'dry';
    const latest = state.lastRecords?.length ? state.lastRecords[state.lastRecords.length - 1] : null;
    const humNow = latest ? latest.hum : null;
    const baseMsg = point === 'dry'
      ? 'Confirm the probe is fully dry in open air, then apply dry (0%) calibration?'
      : 'Confirm the probe is fully submerged in water, then apply wet (100%) calibration?';
    const msg = humNow === null
      ? `${baseMsg}

The device will measure the current probe state first, then apply the calibration automatically.`
      : `Latest reading: ${humNow.toFixed(1)}%.

The device will measure the current probe state first, then apply ${expectDry ? 'dry' : 'wet'} calibration.
Confirm the probe is ${expectDry ? 'fully dry in open air' : 'fully submerged in water'}?`;
    if (!window.confirm(msg)) return;

    els.calibDryBtn.disabled = true;
    els.calibWetBtn.disabled = true;
    els.calibStatus.textContent = 'Calibration started — measuring current probe state…';
    try {
      // 固件 0xFFE6 写回调现在只登记校准点并触发立即测量，测量完成后自动用新鲜采样值应用
      await BLEProtocol.sendHumCalib(state.calibChar, point);
      log(`Moisture ${label} calibration command sent (0xFFE6)`);

      // 等待设备完成新测量（固件随后自动应用校准并推送 Notify），再回读 0xFFE9 确认
      await waitForHumiditySample();
      const readState = await refreshCalibHints();
      if (readState === 'ok') {
        const ok = point === 'dry' ? !!state.calibSaved?.dry : !!state.calibSaved?.wet;
        els.calibStatus.textContent = ok
          ? `${label} calibration saved on device`
          : `${label} calibration rejected (dry/wet points too close)`;
      } else {
        els.calibStatus.textContent = `${label} calibration command sent (device calibration status not readable)`;
      }
    } catch (err) {
      els.calibStatus.textContent = `${label} calibration failed: ${err.message || err}`;
      log(`Moisture calibration failed: ${err.message || err}`);
    } finally {
      els.calibDryBtn.disabled = false;
      els.calibWetBtn.disabled = false;
    }
  }

  // ---- 设备改名：字节数/字符集实时校验 + 保存 ----
  function updateDevNameByteCount() {
    const v = els.devNameInput?.value || '';
    const bytes = new TextEncoder().encode(v);
    if (els.devNameByteCount) els.devNameByteCount.textContent = `${bytes.length} / ${DEV_NAME_MAX_BYTES} bytes`;
    const okLen = bytes.length >= 1 && bytes.length <= DEV_NAME_MAX_BYTES;
    const okAscii = bytes.length > 0 && bytes.every(b => b >= 0x20 && b <= 0x7E);
    if (els.devNameSaveBtn) els.devNameSaveBtn.disabled = !okLen || !okAscii;
    if (els.devNameStatus && v && (!okLen || !okAscii)) {
      els.devNameStatus.textContent = 'Only printable ASCII, max 9 bytes';
    }
  }

  els.devNameInput.addEventListener('input', updateDevNameByteCount);
  els.devNameSaveBtn.addEventListener('click', async () => {
    if (state.otaRunning) {
      els.devNameStatus.textContent = 'Ignored: OTA update is running';
      return;
    }
    if (!state.device?.gatt.connected || !state.devNameChar) {
      els.devNameStatus.textContent = 'Connect a device to change its name';
      return;
    }
    const name = (els.devNameInput.value || '').trim();
    els.devNameSaveBtn.disabled = true;
    els.devNameStatus.textContent = 'Saving…';
    try {
      const res = await BLEProtocol.sendDeviceName(state.devNameChar, name);
      if (res.ok) {
        if (els.deviceNameText) els.deviceNameText.textContent = name;
        els.devNameStatus.textContent = 'Name saved. If it still shows the old name, please reconnect to show the new name.';
        log(`Device name saved: ${name}`);
      } else {
        els.devNameStatus.textContent = `Save failed: ${res.message}`;
      }
    } catch (err) {
      els.devNameStatus.textContent = `Save failed: ${err.message || err}`;
    } finally {
      updateDevNameByteCount();
    }
  });

  els.calibDryBtn.addEventListener('click', () => handleCalibClick('dry', 'Dry'));
  els.calibWetBtn.addEventListener('click', () => handleCalibClick('wet', 'Wet'));

  async function handleRefreshClick() {
    if (state.otaRunning) {
      log('Refresh ignored: OTA update is running');
      return;
    }
    if (!state.device?.gatt.connected || !state.refreshChar) {
      return;
    }
    els.refreshBtn.disabled = true;
    try {
      await BLEProtocol.sendRefresh(state.refreshChar);
      log('Refresh command sent (0xFFE7), measuring now');
    } catch (err) {
      log(`Refresh failed: ${err.message || err}`);
    } finally {
      els.refreshBtn.disabled = !state.device?.gatt.connected;
    }
  }

  els.refreshBtn.addEventListener('click', handleRefreshClick);

  // 温度偏移：滑杆实时预览，Apply 写入 0xFFE8 后请求一次重测
  els.tempOffsetSlider.addEventListener('input', () => {
    const x10 = Number(els.tempOffsetSlider.value);
    els.tempOffsetValue.textContent = `${(x10 / 10).toFixed(1)} ℃`;
  });

  els.tempOffsetApplyBtn.addEventListener('click', async () => {
    if (state.otaRunning) {
      log('Temperature offset ignored: OTA update is running');
      return;
    }
    if (!state.device?.gatt.connected || !state.tempOffsetChar) {
      els.tempOffsetStatus.textContent = 'Connect a device to adjust temperature offset';
      return;
    }
    const x10 = Number(els.tempOffsetSlider.value);
    els.tempOffsetApplyBtn.disabled = true;
    els.tempOffsetStatus.textContent = 'Applying temperature offset…';
    try {
      await BLEProtocol.sendTempOffset(state.tempOffsetChar, x10);
      state.tempOffsetX10 = x10;
      els.tempOffsetStatus.textContent = `Temperature offset set to ${(x10 / 10).toFixed(1)} ℃`;
      log(`Temperature offset sent (0xFFE8): ${x10 / 10}℃`);
      // 立即重测，让 Data 面板尽快反映修正后的温度
      if (state.refreshChar) {
        try { await BLEProtocol.sendRefresh(state.refreshChar); } catch (_) {}
      }
    } catch (err) {
      els.tempOffsetStatus.textContent = `Temperature offset failed: ${err.message || err}`;
      log(`Temperature offset failed: ${err.message || err}`);
    } finally {
      els.tempOffsetApplyBtn.disabled = !state.device?.gatt.connected || !state.tempOffsetChar;
    }
  });

  // 工厂重置 + 重启：写入 RST1 后设备会清空数据并重启，连接随即断开
  els.factoryResetBtn.addEventListener('click', async () => {
    if (state.otaRunning) {
      log('Factory reset ignored: OTA update is running');
      return;
    }
    if (!state.device?.gatt.connected || !state.resetChar) {
      els.factoryResetStatus.textContent = 'Connect a device to reset';
      return;
    }
    const msg = 'Factory reset the device? All stored data (history, daily averages, moisture calibration and temperature offset) will be cleared and the device will reboot. The connection will drop.';
    if (!window.confirm(msg)) return;
    els.factoryResetBtn.disabled = true;
    els.factoryResetStatus.textContent = 'Sending factory reset… the device will reboot';
    try {
      await BLEProtocol.sendFactoryReset(state.resetChar);
      log('Factory reset command sent (0xFFE5 RST1)');
      els.factoryResetStatus.textContent = 'Factory reset requested — the device is rebooting. Reconnect when it appears again.';
    } catch (err) {
      // 设备可能在写入确认前就重启断链，此处按“已下发”处理而非报错
      if (/disconnect|gatt server/i.test(String(err?.message || err))) {
        els.factoryResetStatus.textContent = 'Factory reset requested — the device is rebooting. Reconnect when it appears again.';
        log('Factory reset caused disconnect (expected)');
      } else {
        els.factoryResetStatus.textContent = `Factory reset failed: ${err.message || err}`;
        log(`Factory reset failed: ${err.message || err}`);
      }
    }
  });

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

  // 连接后检测新版本：fetch page/firmware/firmware.json 与设备固件版本（DIS 0x2A26）比较，更高则在 Setting 显示升级提示
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
      if (compareVersions(m.latest.version, state.fwVersion) <= 0) {
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

  // 渲染温度偏移滑杆与数值
  function renderTempOffset() {
    const x10 = state.tempOffsetX10 || 0;
    els.tempOffsetSlider.value = String(x10);
    els.tempOffsetValue.textContent = `${(x10 / 10).toFixed(1)} ℃`;
  }

  els.trendTabBtn.addEventListener('click', () => switchChartTab('trend'));
   els.dailyTabBtn.addEventListener('click', () => switchChartTab('daily'));
  els.dailyMetricTempBtn.addEventListener('click', () => setDailyMetric('temp'));
  els.dailyMetricHumBtn.addEventListener('click', () => setDailyMetric('hum'));
  els.dailyMetricBattBtn.addEventListener('click', () => setDailyMetric('batt'));
  (els.tempUnitToggle?.querySelectorAll('.temperature-unit-btn') || []).forEach(btn => {
    btn.addEventListener('click', () => {
      state.tempUnit = btn.dataset.unit === 'C' ? 'C' : 'F';
      updateTempUnitUI();
    });
  });
  els.mainTabDataBtn.addEventListener('click', () => switchMainTab('data'));
  els.mainTabGuideBtn.addEventListener('click', () => switchMainTab('guide'));
  els.mainTabSettingBtn.addEventListener('click', () => switchMainTab('setting'));

  // Guide 面板 PDF 下载：原生 <a download> 在 iOS Safari / Bluefy(WebKit) 上常直接打开 PDF 预览。
  // 改为 fetch -> Blob -> a.download 强制保存；失败时回退为新标签打开预览。
  if (els.downloadPdfBtn) {
    els.downloadPdfBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      const url = els.downloadPdfBtn.getAttribute('href');
      try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const blob = await resp.blob();
        const objUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objUrl;
        a.download = 'SoilPulse-introduction.pdf';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(objUrl), 2000);
        log('PDF download triggered (blob)');
      } catch (err) {
        log(`PDF download failed, opening preview instead: ${err.message}`);
        window.open(url, '_blank', 'noopener');
      }
    });
  }

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