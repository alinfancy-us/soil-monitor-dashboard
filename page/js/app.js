/**
 * FloraSense Dashboard Application UI Manager
 */
 (() => {
   'use strict';
 
   // 集中配置统一取自 page/js/config.js，方便后续维护管理
   const {
     DEBUG_ENABLED, POLL_INTERVAL,
     DASHBOARD_URL, BLUEFY_APPSTORE_URL, BLUEFY_DEEPLINK,
     DAILY_EPOCH_MIN_VALID, DAILY_EPOCH_MAX_VALID, TREND_EPOCH_MAX_VALID,
     CACHE_PREFIX, CACHE_MAX_ITEM_BYTES, CACHE_MAX_TOTAL_BYTES,
     FIRMWARE_MANIFEST_URL,
} = FloraSenseConfig;
  // 缓存 key 按设备唯一标识（device.id，Web Bluetooth 分配，浏览器内可视为等价 MAC）分区，
  // 避免连接不同土壤检测器时数据互相覆盖。lastDevice 指针用于刷新页面后自动回显上次设备的数据。
  const LAST_DEVICE_KEY = `${CACHE_PREFIX}lastDevice:v1`;
  const RECORD_KEY_RE = /^floraSense:(trend|daily):v1:/;

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
    refreshBtn: document.getElementById('refreshBtn'),
    otaPanel: document.getElementById('otaPanel'),
    otaProgressBar: document.getElementById('otaProgressBar'),
    otaStatus: document.getElementById('otaStatus'),
    otaRetryBtn: document.getElementById('otaRetryBtn'),
    otaUpdateBanner: document.getElementById('otaUpdateBanner'),
    otaNewVersion: document.getElementById('otaNewVersion'),
    otaCurrentVersion: document.getElementById('otaCurrentVersion'),
    otaUpdateNowBtn: document.getElementById('otaUpdateNowBtn'),
     tempValue: document.getElementById('tempValue'),
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
   };
 
   const state = {
     device: null,
     activeDeviceId: null,
     characteristic: null,
     dailyChar: null,
     resetChar: null,
    calibChar: null,
    refreshChar: null,
    otaChar: null,
    otaRunning: false,
    otaLastFirmware: null,
    fwVersion: null,
    fwUpdate: null,
     pollTimer: null,
     lastRecords: null,
     lastDailyRecords: null,
     dailyMetric: 'temp',
   };

   const DAILY_METRICS = {
     temp: {
       key: 'temp',
       title: 'Temperature',
       color: '#f97316',
       formatValue: v => `${v.toFixed(1)}℃`,
       axisFormatter: v => v.toFixed(1),
       range: null,
       button: 'dailyMetricTempBtn',
     },
     hum: {
       key: 'hum',
       title: 'Humidity',
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
     console.debug(`[FloraSense] ${msg}`);
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
    els.calibDryBtn.disabled = mode !== 'connected';
    els.calibWetBtn.disabled = mode !== 'connected';
    els.calibStatus.textContent = mode === 'connected'
      ? 'Place the probe, wait a few seconds, then tap dry or wet calibration'
      : 'Connect a device to enable calibration';
    els.refreshBtn.disabled = mode !== 'connected';
    els.clearCacheBtn.disabled = mode !== 'connected';
    if (state.otaRunning) {
      setOtaUiLock(true);
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
 
     els.tempValue.textContent = latest.temp.toFixed(2);
     els.humValue.textContent = latest.hum.toFixed(1);
     els.battValue.textContent = latest.batt;
     els.lastUpdate.textContent = `Latest measurement: ${formatTime(latest.timestamp)}`;
 
     els.historyBody.innerHTML = records
       .map((r, i) => `
         <tr class="border-b border-slate-50 last:border-0">
           <td class="py-2 pr-2 text-slate-400">${i + 1}</td>
           <td class="py-2 pr-2">${formatTime(r.timestamp)}</td>
           <td class="py-2 pr-2 text-orange-500 font-medium">${r.temp.toFixed(2)}℃</td>
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
     els.trendTempLatest.textContent = `${latest.temp.toFixed(1)}℃`;
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

     const temps = records.map(r => r.temp);
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
     const values = records.map(r => Number(r[cfg.key]) || 0);
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
     els.dailyMetricHint.textContent = `${cfg.title} · ${xLabels[0]} - ${xLabels[xLabels.length - 1]}`;
    saveDailyRecordsCache(records, state.activeDeviceId);
   }
 
   function switchChartTab(tab) {
     const isTrend = tab === 'trend';
     els.trendTabPanel.classList.toggle('hidden', !isTrend);
     els.dailyTabPanel.classList.toggle('hidden', isTrend);
     els.trendTabBtn.className = `chart-tab-btn px-3 py-1.5 rounded-lg text-sm font-semibold transition ${isTrend ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-500'}`;
     els.dailyTabBtn.className = `chart-tab-btn px-3 py-1.5 rounded-lg text-sm font-semibold transition ${isTrend ? 'bg-slate-100 text-slate-500' : 'bg-emerald-600 text-white'}`;
 
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
       if (state.characteristic && state.device?.gatt.connected) {
         await readData().catch(e => log(`Poll failed: ${e.message}`));
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
     stopPolling();
    state.otaRunning = false;
    setOtaUiLock(false);
     setStatus('disconnected');
     state.characteristic = null;
     state.resetChar = null;
    state.calibChar = null;
    state.refreshChar = null;
    state.otaChar = null;
    state.otaRunning = false;
    els.otaUpdateBanner.classList.add("hidden");
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
       els.modalTitle.textContent = 'Bluetooth Unavailable in Safari';
       els.modalMessage.textContent = 'iOS Safari does not support Web Bluetooth. Tap "Open in Bluefy" to continue — the dashboard link will be copied to your clipboard so you can paste it into Bluefy after installing.';
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
       const { dataChar, dailyChar, resetChar, calibChar, refreshChar, otaChar, fwVersion } = await BLEProtocol.finishConnect(
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
       state.otaChar = otaChar;
       state.fwVersion = fwVersion;
       checkFirmwareUpdate();

       if (dataChar.properties.read) {
         await readData();
       }

       setStatus('connected');
       log('Connected & Listening for updates.');
       startPolling();
     } catch (err) {
       if (token !== connectToken) return;   // 超时/失败期间用户已重新点击，不被覆盖
       setStatus('disconnected');
       if (String(err && err.message).includes('CONNECT_TIMEOUT')) {
         els.statusText.textContent = 'Connect timed out — device may be sleeping (touch it to wake) or Bluetooth is off';
         log('Connection timed out after 5s');
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
     state.device?.gatt.connected ? handleDisconnect() : handleConnect();
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
     // 任务9：向已连接设备下发 Clear/Reset 指令，清空芯片 RAM 历史/日均值
     if (state.resetChar) {
       try {
         await BLEProtocol.sendReset(state.resetChar);
         log('Device reset command sent (0xFFE5)');
       } catch (err) {
         log(`Device reset failed: ${err.message || err}`);
       }
     }
   });

  async function handleCalibClick(point, label) {
    if (state.otaRunning) {
      log('Calibration ignored: OTA update is running');
      return;
    }
    if (!state.device?.gatt.connected || !state.calibChar) {
      els.calibStatus.textContent = 'Connect a device to enable calibration';
      return;
    }
    const msg = point === 'dry'
      ? 'Confirm the probe is fully dry in open air, then apply dry (0%) calibration?'
      : 'Confirm the probe is fully submerged in water, then apply wet (100%) calibration?';
    if (!window.confirm(msg)) return;

    els.calibDryBtn.disabled = true;
    els.calibWetBtn.disabled = true;
    els.calibStatus.textContent = `Applying ${label} calibration…`;
    try {
      await BLEProtocol.sendHumCalib(state.calibChar, point);
      els.calibStatus.textContent = `${label} calibration applied`;
      log(`Humidity ${label} calibration command sent (0xFFE6)`);
    } catch (err) {
      els.calibStatus.textContent = `${label} calibration failed: ${err.message || err}`;
      log(`Humidity calibration failed: ${err.message || err}`);
    } finally {
      els.calibDryBtn.disabled = false;
      els.calibWetBtn.disabled = false;
    }
  }

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
    els.otaPanel.classList.remove("hidden");
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
    els.otaPanel.classList.remove("hidden");
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
      if (ok) els.otaUpdateBanner.classList.add("hidden"); // 升级成功隐藏新版本横幅
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

  // 连接后检测新版本：fetch page/firmware/firmware.json 与设备固件版本（DIS 0x2A26）比较，更高则显示一键升级横幅
  async function checkFirmwareUpdate() {
    state.fwUpdate = null;
    els.otaUpdateBanner.classList.add("hidden");
    if (!state.device?.gatt.connected || !state.otaChar) return;
    try {
      const res = await fetch(FIRMWARE_MANIFEST_URL, { cache: "no-store" });
      if (!res.ok) return;
      const m = await res.json();
      if (!m?.version || !m?.bin) return;
      els.otaCurrentVersion.textContent = state.fwVersion || "unknown";
      if (compareVersions(m.version, state.fwVersion) <= 0) return; // 无新版本
      const base = FIRMWARE_MANIFEST_URL.slice(0, FIRMWARE_MANIFEST_URL.lastIndexOf("/") + 1);
      state.fwUpdate = { version: m.version, bin: m.bin, size: Number(m.size) || 0, url: base + m.bin };
      els.otaNewVersion.textContent = `v${m.version}`;
      els.otaUpdateBanner.classList.remove("hidden");
      log(`[OTA] new firmware available: v${m.version} (current ${state.fwVersion || "unknown"})`);
    } catch (err) {
      log(`Firmware manifest check failed: ${err.message || err}`); // 清单缺失/网络失败静默降级
    }
  }

  els.trendTabBtn.addEventListener('click', () => switchChartTab('trend'));
   els.dailyTabBtn.addEventListener('click', () => switchChartTab('daily'));
  els.dailyMetricTempBtn.addEventListener('click', () => setDailyMetric('temp'));
  els.dailyMetricHumBtn.addEventListener('click', () => setDailyMetric('hum'));
  els.dailyMetricBattBtn.addEventListener('click', () => setDailyMetric('batt'));

   let resizeTimer = null;
   window.addEventListener('resize', () => {
     clearTimeout(resizeTimer);
     resizeTimer = setTimeout(() => {
       if (!els.trendTabPanel.classList.contains('hidden') && state.lastRecords) {
         drawChart(state.lastRecords);
       }
       if (!els.dailyTabPanel.classList.contains('hidden') && state.lastDailyRecords) {
         renderDaily(state.lastDailyRecords);
       }
     }, 200);
   });
 

   updateDailyMetricButtons();
  state.activeDeviceId = getLastDeviceId();
  if (state.activeDeviceId) restoreCachedCharts(state.activeDeviceId);
 
   if (!navigator.bluetooth) {
     const ua = navigator.userAgent;
     showModal(/iPad|iPhone|iPod/.test(ua) && !window.MSStream, /Android/.test(ua));
     els.connectBtn.disabled = true;
     els.connectBtn.classList.add('opacity-40', 'cursor-not-allowed');
   }
 })();