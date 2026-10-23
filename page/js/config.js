/**
 * SoilPulse Frontend Shared Configuration
 * 集中管理设备名前缀 / GATT UUID / Bluefy 深链 / 缓存与轮询参数，供 ble-protocol.js 与 app.js 共用
 */
const SoilPulseConfig = (() => {
  'use strict';

  // 前端页面版本号：与 index.html 的 <script src="...?v=X"> 保持一致，每次功能变更递增。
  // 页面底部会显示该值，便于现场确认浏览器实际加载的是哪一版前端（排查缓存问题）
  const PAGE_VERSION = '1.5.9';

  // 设备广播名前缀，须与固件 app_config.h 的 BLE_DEVICE_NAME 保持一致。
  // 注意：固件里蓝牙名恒为编译期常量（网页改名只写 0xFFEA，不进广播），所以名字只能标识
  // “属于 SoilPulse 系列”，区分不了具体是哪一台——身份判据是下面的 UUIDS.SERVICE。
  // 本值现在只作为 requestDevice 的**兜底** filter（见 ble-protocol.js buildDeviceFilters）：
  // 救尚未刷新固件、广播里没有 128 位 UUID 的老设备。固件改名后仍需同步此处，否则老设备搜不到。
  const DEVICE_NAME = 'SoilPulse';

  // GATT UUID：使用 128 位完整小写字符串，防止 Bluefy/iOS 序列化失败
  // SERVICE 为随机 128 位主服务 UUID（固件 bth_soil_sensor.h 的 SOIL_SERVICE_UUID128，
  // 广播时位于扫描响应包的 Complete List of 128-bit Service UUIDs 段）；各特征仍为 16 位展开
  const UUIDS = {
    SERVICE: '749b53b7-2662-4658-9fb4-e47241816727',
    DATA_CHAR: '0000ffe1-0000-1000-8000-00805f9b34fb',
    TIME_CHAR: '0000ffe2-0000-1000-8000-00805f9b34fb',
    DAILY_CHAR: '0000ffe3-0000-1000-8000-00805f9b34fb',
    RESET_CHAR: '0000ffe5-0000-1000-8000-00805f9b34fb',
    CALIB_CHAR: '0000ffe6-0000-1000-8000-00805f9b34fb',
    REFRESH_CHAR: '0000ffe7-0000-1000-8000-00805f9b34fb',
    TEMP_OFFSET_CHAR: '0000ffe8-0000-1000-8000-00805f9b34fb',
    // 校准状态读特征（1 字节标志位），须与固件 app_att.h 的 SOIL_CALIB_STATUS_CHAR_UUID 对齐
    CALIB_STATUS_CHAR: '0000ffe9-0000-1000-8000-00805f9b34fb',
    // 设备名（网页展示名）读写特征（≤20 字节可打印 ASCII），须与固件 app_att.h 的 SOIL_DEV_NAME_CHAR_UUID 对齐
    DEV_NAME_CHAR: '0000ffea-0000-1000-8000-00805f9b34fb',
    // 最新一次测量记录读特征（9 字节，布局同历史记录），须与固件 app_att.h 的 SOIL_LATEST_CHAR_UUID 对齐；
    // v2 规格：refresh 一次性测量不写历史，Refresh 按钮的实时值从这里轮询读取（旧固件无此特征）
    LATEST_CHAR: '0000ffeb-0000-1000-8000-00805f9b34fb',
    // 24h 历史分块读特征（0xFFEC）：先写 2 字节窗口 {offset, count}，再读出 183 字节块
    // （3B 头 total/offset/count + 20×9B 记录），须与固件 app_att.h 的 SOIL_HIS_BLK_CHAR_UUID 对齐；
    // 旧固件无此特征时为 null，前端回退 0xFFE1 的 5 条老协议
    HISTORY_BLK_CHAR: '0000ffec-0000-1000-8000-00805f9b34fb',
    // 30 天日均紧凑包（0xFFED，只读 185B = 1B 条数 + 4B base_day + 30×6B），
    // 数据源是设备 Flash 日志（跨掉电/换电池存活），须与固件 SOIL_DAILY30_CHAR_UUID 对齐；
    // 旧固件无此特征时为 null，前端回退 0xFFE3 的 7 天老协议
    DAILY30_CHAR: '0000ffed-0000-1000-8000-00805f9b34fb',
    // 30 天温度极值包（0xFFEE，只读 124B = 1B 条数 + 4B base_day + 30×4B），
    // 每条 {day_off u16, tmin_d10 s8, tmax_d10 s8}，按 day_off 与 DAILY30_CHAR 对齐；
    // 极值是"相对当日均值的 0.1℃ 偏移"（0x80=无极值，旧固件记录），须与固件 SOIL_DAILY30_EXT_CHAR_UUID 对齐；
    // 旧固件无此特征时为 null → 日均图不画极值标记，其余功能不受影响
    DAILY30_EXT_CHAR: '0000ffee-0000-1000-8000-00805f9b34fb',
    // Telink OTA 升级服务（128bit，须与固件 app_att.c 的 TELINK_OTA_UUID_SERVICE / TELINK_SPP_DATA_OTA
    // 的 GATT 小端字节序反转后一致），仅 BLE_OTA_SERVER_ENABLE=1 的固件才有
    OTA_SERVICE: '00010203-0405-0607-0809-0a0b0c0d1912',
    OTA_CHAR: '00010203-0405-0607-0809-0a0b0c0d2b12',
    // 标准 Device Information Service，读 Firmware Revision String(0x2A26) 获取设备固件版本，须与固件 SOIL_FW_VERSION 编译值一致
    DIS_SERVICE: '0000180a-0000-1000-8000-00805f9b34fb',
    DIS_FW_REV_CHAR: '00002a26-0000-1000-8000-00805f9b34fb',
  };

  // 固件升级清单（version/bin/size/isforce），与固件 .bin 一起托管在 page/firmware/；连接后 fetch 与设备固件版本比较，更高则提示一键升级（isforce:true 为 dev 渠道强制升级，跳过版本比较）
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

  // 温度偏移校准参数（设备存储恒为 0.01℃：int16 小端 ±1000，须与固件 SOIL_TEMP_OFFSET_* 对齐）。
  // 字段名沿用历史的 X10，但单位是 0.01℃（x100），不是 0.1℃——换算到 ℃ 要 /100。
  // 滑杆刻度恒为"当前显示单位的 0.1"：℃ 模式 ±100 格（0.1℃/格），
  // ℉ 模式 ±180 格（0.1℉/格，±18℉ = ±10℃）；℉ 格写入设备时四舍五入到 0.01℃ 网格
  const TEMP_OFFSET = {
    MIN_X10: -1000,   // 设备 0.01℃ 整数（±10.00℃）
    MAX_X10: 1000,    // 设备 0.01℃ 整数（±10.00℃）
    STEP_X10: 1,
    MIN_F: -180,      // °F 显示格数（0.1°F，±18.0°F），展示不变
    MAX_F: 180,
  };

  // 校准状态标志位（0xFFE9 读特征值），须与固件 bth_soil_sensor.h 的 SOIL_CALIB_FLAG_* 对齐；
  // 只表示"设备上存在该校准"，用于页面提示，不携带具体校准数值
  const CALIB_STATUS_FLAGS = {
    DRY: 0x01,   // 干燥点(0%)已校准
    WET: 0x02,   // 浸水点(100%)已校准
    TEMP: 0x04,  // 温度偏移非 0
  };

  // 设备名（网页展示名）限制：名字不再进广播（广播名恒为 DEVICE_NAME）；
  // 仅允许可打印 ASCII（0x20~0x7E）；前端输入即做字节数与字符集双重校验。
  // 固件特征值仍为 20 字节（app_att.h），产品层面收紧到 10 字符（写入 ≤10 字节完全兼容）
  const DEV_NAME_MAX_BYTES = 10;

  // Bluefy 深链唤起配置：iOS Safari 无 Web Bluetooth 时引导用 Bluefy 打开本 Dashboard，
  // 未安装则回退 App Store（deep link scheme 未公开文档，需真机验证）
  const DASHBOARD_URL = 'https://soilpulse.alinfancy.com';
  const BLUEFY_APPSTORE_URL = 'https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055';
  const BEACIO_APPSTORE_URL = 'https://apps.apple.com/app/beacio/id6761301368';

  // 2. 将 PAGE_VERSION 追加到 DASHBOARD_URL 中
  const targetUrl = new URL(DASHBOARD_URL);
  targetUrl.searchParams.set('v', PAGE_VERSION); // 生成 https://soilpulse.alinfancy.com/?v=1.0.1

  // 3. 对带版本号的完整 URL 进行 encodeURIComponent
  const BLUEFY_DEEPLINK = `bluefy://open?url=${encodeURIComponent(targetUrl.toString())}`;

  // 调试日志 / 轮询间隔（毫秒）。
  // 中文：两个开关必须解耦——轮询(startPolling)承担"读数据兜底 + 断链 UI 校正"职责，
  //       不能随日志开关一起被关掉（DEBUG=false 时若仍门控轮询，断链后 UI 会永远显示 Connected，
  //       WebKit 平台 gattserverdisconnected 事件不可靠）。
  //       DEBUG_ENABLED=false 发版：log() 仅输出 console.debug，关闭后现场零调试输出；
  //       POLL_ENABLED=true 发版：轮询兜底必须常开。
  const DEBUG_ENABLED = true;
  const POLL_ENABLED = true;
  const POLL_INTERVAL = 5000;

  // 连接态空闲提醒（与固件 SOIL_CONN_IDLE_TIMEOUT_S = 240s 配合，三个数必须保持这个大小关系）：
  //   180s 无续命 → 页内弹窗倒计时 30s 询问是否保持连接；
  //   点「Keep connected」→ 写一次 0xFFE7（Refresh，固件收到后清零 idle 计时，web 侧重新计时）；
  //   点「Let it sleep」/ 什么都不做让倒计时归零 → **web 立即主动断链**，状态显示 Asleep。
  //   设备侧 240s 超时仍然保留，只覆盖"页面被切后台/被系统杀掉"这类 web 脚本跑不起来的场景。
  // 为什么留 30s 安全垫而不是让 180+30 等于 240：设备 idle 从链路建立开始计，web 定时器要等
  //   服务发现 + 通知订阅完成才启动，天然晚 1~2s；若两边对齐，用户会看到倒计时没走完连接就断了。
  //   现在倒计时归零由 web 自己断（210s < 240s），这个垫子同时保证"用户按下的一刻链路还在"。
  // 为什么不用「页面隐藏就主动断」：Chrome 对隐藏标签页的定时器会节流，靠定时器判断不可靠；
  //   而隐藏后弹窗不会被人点 → 不会写 0xFFE7 → 设备 240s 自然断，这条路本身就不需要额外代码。
  // IDLE_WARN_MS / IDLE_GRACE_S 可用 URL 参数 ?idleWarnMs= / ?idleGraceS= 覆盖，仅供 E2E 加速；
  // 生产链接不带这两个参数，走下面的默认值。
  const numParam = (name, def, min) => {
    const v = Number(new URLSearchParams(location.search).get(name));
    return Number.isFinite(v) && v >= min ? v : def;
  };
  const IDLE_WARN_MS = numParam('idleWarnMs', 180000, 1000);
  const IDLE_GRACE_S = numParam('idleGraceS', 30, 3);

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
    DEVICE_NAME,
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
    BEACIO_APPSTORE_URL,
    BLUEFY_DEEPLINK,
    DEBUG_ENABLED,
    POLL_ENABLED,
    POLL_INTERVAL,
    IDLE_WARN_MS,
    IDLE_GRACE_S,
    DAILY_EPOCH_MIN_VALID,
    DAILY_EPOCH_MAX_VALID,
    TREND_EPOCH_MAX_VALID,
    CACHE_PREFIX,
    CACHE_MAX_ITEM_BYTES,
    CACHE_MAX_TOTAL_BYTES,
  };
})();
