/**
 * SoilPulse Frontend Shared Configuration
 * 集中管理设备名前缀 / GATT UUID / Bluefy 深链 / 缓存与轮询参数，供 ble-protocol.js 与 app.js 共用
 */
const SoilPulseConfig = (() => {
  'use strict';

  // 前端页面版本号：与 index.html 的 <script src="...?v=X"> 保持一致，每次功能变更递增。
  // 页面底部会显示该值，便于现场确认浏览器实际加载的是哪一版前端（排查缓存问题）
  const PAGE_VERSION = '1.3.5';

  // 设备广播名前缀，须与固件 app_config.h 的 BLE_DEVICE_NAME 保持一致（固件改名须保留此前缀）。
  // 它参与 requestDevice 的过滤（与 services UUID 同一 filter 内 AND 匹配），
  // 用于排除周围其他同样广播 0xFFE0 服务的设备；固件改名后须同步更新此处，否则网页搜不到设备
  const DEVICE_NAME_PREFIX = 'SoilPulse';

  // GATT UUID：使用 128 位完整小写字符串，防止 Bluefy/iOS 序列化失败
  const UUIDS = {
    SERVICE: '0000ffe0-0000-1000-8000-00805f9b34fb',
    DATA_CHAR: '0000ffe1-0000-1000-8000-00805f9b34fb',
    TIME_CHAR: '0000ffe2-0000-1000-8000-00805f9b34fb',
    DAILY_CHAR: '0000ffe3-0000-1000-8000-00805f9b34fb',
    RESET_CHAR: '0000ffe5-0000-1000-8000-00805f9b34fb',
    CALIB_CHAR: '0000ffe6-0000-1000-8000-00805f9b34fb',
    REFRESH_CHAR: '0000ffe7-0000-1000-8000-00805f9b34fb',
    TEMP_OFFSET_CHAR: '0000ffe8-0000-1000-8000-00805f9b34fb',
    // 校准状态读特征（1 字节标志位），须与固件 app_att.h 的 SOIL_CALIB_STATUS_CHAR_UUID 对齐
    CALIB_STATUS_CHAR: '0000ffe9-0000-1000-8000-00805f9b34fb',
    // 设备改名写特征（≤9 字节可打印 ASCII），须与固件 app_att.h 的 SOIL_DEV_NAME_CHAR_UUID 对齐
    DEV_NAME_CHAR: '0000ffea-0000-1000-8000-00805f9b34fb',
    // Telink OTA 升级服务（128bit，须与固件 app_att.c 的 TELINK_OTA_UUID_SERVICE / TELINK_SPP_DATA_OTA
    // 的 GATT 小端字节序反转后一致），仅 BLE_OTA_SERVER_ENABLE=1 的固件才有
    OTA_SERVICE: '00010203-0405-0607-0809-0a0b0c0d1912',
    OTA_CHAR: '00010203-0405-0607-0809-0a0b0c0d2b12',
    // 标准 Device Information Service，读 Firmware Revision String(0x2A26) 获取设备固件版本，须与固件 SOIL_FW_VERSION 编译值一致
    DIS_SERVICE: '0000180a-0000-1000-8000-00805f9b34fb',
    DIS_FW_REV_CHAR: '00002a26-0000-1000-8000-00805f9b34fb',
  };

  // 固件升级清单（version/bin/size），与固件 .bin 一起托管在 page/firmware/；连接后 fetch 与设备固件版本比较，更高则提示一键升级
  const FIRMWARE_MANIFEST_URL = 'page/firmware/firmware.json';

  // 湿度两点校准指令（1 字节），须与固件 soil_calib_point_t 严格对齐
  const HUM_CALIB_CMD = {
    DRY: Uint8Array.of(0x00),
    WET: Uint8Array.of(0x01),
  };

  // 立即重新测量指令（1 字节固定值），须与固件 SOIL_REFRESH_CMD_TRIGGER 严格对齐
  const REFRESH_CMD = Uint8Array.of(0x01);

  // Clear/Reset 指令 4 字节魔术字 "CLR1"，须与固件 soil_reset_onWrite 严格对齐
  const RESET_MAGIC = Uint8Array.of(0x43, 0x4c, 0x52, 0x31);

  // Factory reset & reboot 指令 4 字节魔术字 "RST1"，清空设备全部业务数据（RAM/校准/偏移）并重启
  const FACTORY_RESET_MAGIC = Uint8Array.of(0x52, 0x53, 0x54, 0x31);

  // 温度偏移校准参数（单位 0.1℃，±10℃ 内，须与固件 SOIL_TEMP_OFFSET_* 对齐）
  const TEMP_OFFSET = {
    MIN_X10: -100,
    MAX_X10: 100,
    STEP_X10: 5,
  };

  // 校准状态标志位（0xFFE9 读特征值），须与固件 bth_soil_sensor.h 的 SOIL_CALIB_FLAG_* 对齐；
  // 只表示"设备上存在该校准"，用于页面提示，不携带具体校准数值
  const CALIB_STATUS_FLAGS = {
    DRY: 0x01,   // 干燥点(0%)已校准
    WET: 0x02,   // 浸水点(100%)已校准
    TEMP: 0x04,  // 温度偏移非 0
  };

  // 设备名限制：BLE 广播包短名段上限 9 字节（见固件 soil_sensor_build_adv_data），
  // 仅允许可打印 ASCII（0x20~0x7E）；前端输入即做字节数与字符集双重校验
  const DEV_NAME_MAX_BYTES = 9;

  // Bluefy 深链唤起配置：iOS Safari 无 Web Bluetooth 时引导用 Bluefy 打开本 Dashboard，
  // 未安装则回退 App Store（deep link scheme 未公开文档，需真机验证）
  const DASHBOARD_URL = 'https://soilpulse.alinfancy.com';
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
  const CACHE_PREFIX = 'SoilPulse:';
  const CACHE_MAX_ITEM_BYTES = 64 * 1024;
  const CACHE_MAX_TOTAL_BYTES = 512 * 1024;

  return {
    PAGE_VERSION,
    DEV_NAME_MAX_BYTES,
    DEVICE_NAME_PREFIX,
    UUIDS,
    FIRMWARE_MANIFEST_URL,
    RESET_MAGIC,
    FACTORY_RESET_MAGIC,
    HUM_CALIB_CMD,
    REFRESH_CMD,
    TEMP_OFFSET,
    CALIB_STATUS_FLAGS,
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
