/**
 * FloraSense Frontend Shared Configuration
 * 集中管理设备名前缀 / GATT UUID / Bluefy 深链 / 缓存与轮询参数，供 ble-protocol.js 与 app.js 共用
 */
const FloraSenseConfig = (() => {
  'use strict';

  // 设备广播名前缀，须与固件 app_config.h 的 BLE_DEVICE_NAME 保持一致
  const DEVICE_NAME_PREFIX = 'FloraSense';

  // GATT UUID：使用 128 位完整小写字符串，防止 Bluefy/iOS 序列化失败
  const UUIDS = {
    SERVICE: '0000ffe0-0000-1000-8000-00805f9b34fb',
    DATA_CHAR: '0000ffe1-0000-1000-8000-00805f9b34fb',
    TIME_CHAR: '0000ffe2-0000-1000-8000-00805f9b34fb',
    DAILY_CHAR: '0000ffe3-0000-1000-8000-00805f9b34fb',
    POWER_CHAR: '0000ffe4-0000-1000-8000-00805f9b34fb',
    RESET_CHAR: '0000ffe5-0000-1000-8000-00805f9b34fb',
  };

  // Clear/Reset 指令 4 字节魔术字 "CLR1"，须与固件 soil_reset_onWrite 严格对齐
  const RESET_MAGIC = Uint8Array.of(0x43, 0x4c, 0x52, 0x31);

  // Bluefy 深链唤起配置：iOS Safari 无 Web Bluetooth 时引导用 Bluefy 打开本 Dashboard，
  // 未安装则回退 App Store（deep link scheme 未公开文档，需真机验证）
  const DASHBOARD_URL = 'https://alinfancy-us.github.io/soil-monitor-dashboard';
  const BLUEFY_APPSTORE_URL = 'https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055';
  const BLUEFY_DEEPLINK = `bluefy://open?url=${encodeURIComponent(DASHBOARD_URL)}`;

  // 调试日志 / 轮询间隔（毫秒）
  const DEBUG_ENABLED = true;
  const POLL_INTERVAL = 5000;

  // 时间戳合理区间（过滤 1970 年脏数据），须与固件 soil_daily.c 的过滤区间一致
  const DAILY_EPOCH_MIN_VALID = 946684800;   // 2000-01-01 00:00:00 UTC
  const DAILY_EPOCH_MAX_VALID = 4102444800;  // 2100-01-01 00:00:00 UTC
  const TREND_EPOCH_MAX_VALID = 4102444800;  // 2100-01-01 00:00:00 UTC

  // 本地缓存（localStorage）参数
  const CACHE_PREFIX = 'floraSense:';
  const CACHE_MAX_ITEM_BYTES = 64 * 1024;
  const CACHE_MAX_TOTAL_BYTES = 512 * 1024;

  return {
    DEVICE_NAME_PREFIX,
    UUIDS,
    RESET_MAGIC,
    DASHBOARD_URL,
    BLUEFY_APPSTORE_URL,
    BLUEFY_DEEPLINK,
    DEBUG_ENABLED,
    POLL_INTERVAL,
    DAILY_EPOCH_MIN_VALID,
    DAILY_EPOCH_MAX_VALID,
    TREND_EPOCH_MAX_VALID,
    CACHE_PREFIX,
    CACHE_MAX_ITEM_BYTES,
    CACHE_MAX_TOTAL_BYTES,
  };
})();
