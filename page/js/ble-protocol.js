/**
 * SoilPulse BLE Protocol & Service Module
 */
const BLEProtocol = (() => {
  'use strict';

  // 集中配置统一取自 page/js/config.js，方便后续维护管理
  const { DEVICE_NAME, UUIDS, RESET_MAGIC, FACTORY_RESET_MAGIC, HUM_CALIB_CMD, REFRESH_CMD, TEMP_OFFSET, CALIB_STATUS_FLAGS, DEV_NAME_MAX_BYTES } = SoilPulseConfig;
  const RECORD_SIZE = 9;
  const MAX_RECORDS = 5;
  const PACKET_SIZE = 1 + RECORD_SIZE * MAX_RECORDS;

  const DAILY_RECORD_SIZE = 10;
  const DAILY_MAX_RECORDS = 7;
  const DAILY_PACKET_SIZE = 1 + DAILY_RECORD_SIZE * DAILY_MAX_RECORDS;

  function parsePacket(view) {
    if (view.byteLength < PACKET_SIZE) {
      throw new Error(`Invalid packet length: ${view.byteLength} (expected ${PACKET_SIZE})`);
    }
    const count = Math.min(view.getUint8(0), MAX_RECORDS);
    const records = [];
    for (let i = 0; i < count; i++) {
      const off = 1 + i * RECORD_SIZE;
      records.push({
        timestamp: view.getUint32(off, true),
        temp: view.getInt16(off + 4, true) / 100,
        hum: view.getUint16(off + 6, true) / 100,
        batt: view.getUint8(off + 8),
      });
    }
    return records;
  }

  /**
   * 解析 0xFFE3 日均值数据包：1 字节条数 + 最多 7 * 10 字节记录
   * 记录布局：date_epoch(u32) temp_x100(s16) hum_x100(u16) batt_percent(u8) reserved(u8)
   */
  function parseDailyPacket(view) {
    if (view.byteLength < DAILY_PACKET_SIZE) {
      throw new Error(`Invalid daily packet length: ${view.byteLength} (expected ${DAILY_PACKET_SIZE})`);
    }
    const count = Math.min(view.getUint8(0), DAILY_MAX_RECORDS);
    const records = [];
    for (let i = 0; i < count; i++) {
      const off = 1 + i * DAILY_RECORD_SIZE;
      records.push({
        dateEpoch: view.getUint32(off, true),
        temp: view.getInt16(off + 4, true) / 100,
        hum: view.getUint16(off + 6, true) / 100,
        battPercent: view.getUint8(off + 8),
      });
    }
    return records;
  }


  function hexDump(view) {
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
  }

  /**
   * 建立蓝牙连接并配置通道
   */
  /**
   * 建立蓝牙连接并配置通道（针对 Bluefy 优化）
   */
  /** 阶段2a 超时（毫秒）：仅限 device.gatt.connect() 单步。
   *  设备处于深睡（不在广播窗口）/ 系统蓝牙被关闭时，connect() 会无限挂起，
   *  单独设 10s 快速反馈“设备可能睡着”；超时瞬间立即断开，清理挂起中的连接。 */
  const CONNECT_TIMEOUT_MS = 10000;

  /** 阶段2b 超时（毫秒）：connect 成功后的服务/特征发现 + 时间同步 + 订阅 Notify + 并行发现。
   *  已连上后这些 ATT 往返正常 1~2s 完成；放宽到 20s 兜底射频差 / 慢平台（Bluefy/iOS），
   *  避免“已连上却仍在初始化”的可用连接被误杀超时。 */
  const INIT_TIMEOUT_MS = 10000;

  /**
   * 内部工具：给 promise 限时；超时立即断开设备 GATT（清理已建立/挂起中的孤儿连接）并抛出 tag 错误。
   * 输入 promise 的晚期 rejection 由调用方吞掉，避免 unhandled rejection。
   */
  function withTimeout(promise, ms, tag, device) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { device?.gatt?.disconnect(); } catch (_) { /* 未连接时 no-op */ }
        reject(new Error(tag));
      }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  /**
   * 阶段1：仅弹出设备选择器（不设超时——用户挑设备时长不受限）。
   * @returns {Promise<BluetoothDevice>}
   */
  async function requestSoilDevice() {
    // 按服务 UUID 过滤设备（随机 128 位，与设备名无关），UUIDS.SERVICE 须与固件
    // app_config.h 的 SOIL_SERVICE_UUID128 一致。UUID 位于扫描响应包的
    // Complete List of 128-bit Service UUIDs 段（见 app.c soil_app_build_scan_rsp）：
    // UUID 与 BTHome 各发一条独立空口包，Web Bluetooth 匹配的是广播包+扫描响应包
    // 的合并数据；主广播包的 BTHome 数据供 HA 等被动扫描器使用。
    // namePrefix 为过渡期兜底：兼容尚未刷新固件（无 128 位 UUID 广播）的旧设备；
    // 全部设备刷新固件后可移除该 filter，恢复按 UUID 精确识别
    // optionalServices 必须包含 DIS_SERVICE(0x180A)：Web Bluetooth 只允许访问
    // 此处声明过的服务，Chrome（安卓/桌面）会严格执行——漏声明时连接后读 DIS
    // 0x2A26 固件版本直接抛 SecurityError，版本徽章永远显示 unknown 并误报升级
    return navigator.bluetooth.requestDevice({
  filters: [{
  namePrefix: 'SoilPulse'
}],
  optionalServices: [UUIDS.OTA_SERVICE, UUIDS.SERVICE, UUIDS.DIS_SERVICE]
});
  }

  /**
   * 阶段2 主体：gatt.connect + 服务/特征发现 + 时间同步 + 订阅 Notify（原 connectDevice 内容）。
   * @param {BluetoothDevice} device
   */
  async function finishConnectInner(device, onNotification, onDisconnect) {
    // 幂等注册：同一 device 对象重复连接时先移除旧监听，防止 gattserverdisconnected 监听器堆积
    device.removeEventListener('gattserverdisconnected', onDisconnect);
    device.addEventListener('gattserverdisconnected', onDisconnect);

    // —— 阶段2a：仅建立 GATT 链路（单独 10s 超时）——
    // 设备处于深睡（不在广播窗口）/ 系统蓝牙被关闭时 connect() 会无限挂起，这里快速超时反馈；
    // 超时瞬间 withTimeout 内部已主动断开 GATT，connect 的晚期成功/失败都不再有意义
    const connectP = device.gatt.connect();
    connectP.catch(() => {});   // 吞掉晚期 rejection，避免 unhandled rejection
    const server = await withTimeout(connectP, CONNECT_TIMEOUT_MS, 'CONNECT_TIMEOUT', device);

    // —— 阶段2b：连接后的初始化（宽松 20s 超时）——
    // 服务/特征发现 + 写时间戳 + 订阅 Notify 正常 1~2s 完成，放宽超时兜底射频差 / 慢平台（Bluefy/iOS），
    // 避免“已连上却仍在初始化”的可用连接被误杀
    const init = initAfterConnect(server, device, onNotification);
    init.catch(() => {});       // 超时断开后晚期失败同样吞掉
    return withTimeout(init, INIT_TIMEOUT_MS, 'INIT_TIMEOUT', device);
  }

  /**
   * 阶段2b 主体：服务/特征发现 + 时间同步 + 订阅 Notify + 非关键特征并行发现。
   * 由 finishConnectInner 在 gatt.connect() 成功后调用（带 INIT_TIMEOUT_MS 超时）。
   */
  async function initAfterConnect(server, device, onNotification) {
    const service = await server.getPrimaryService(UUIDS.SERVICE);
    const dataChar = await service.getCharacteristic(UUIDS.DATA_CHAR);
    const timeChar = await service.getCharacteristic(UUIDS.TIME_CHAR);

    // 同步时间戳 + 时区（6 字节 = epoch u32 LE + 时区偏移 s16 LE）。
    // tz 取 getTimezoneOffset()：UTC 以西为正（北京时间 UTC+8 = -480），
    // 固件用它把日均值的切天分界从 UTC 0 点改为本地 0 点；
    // 旧固件只取前 4 字节（按 UTC 切天），向后兼容不中断
    const now = Math.floor(Date.now() / 1000);
    const tzMin = new Date().getTimezoneOffset();
    await timeChar.writeValue(Uint8Array.of(
      now & 0xff, (now >>> 8) & 0xff, (now >>> 16) & 0xff, (now >>> 24) & 0xff,
      tzMin & 0xff, (tzMin >> 8) & 0xff
    ));

    // 监听 Notify
    if (dataChar.properties.notify || dataChar.properties.indicate) {
      dataChar.addEventListener('characteristicvaluechanged', (e) => {
        const val = e.target.value;
        onNotification(parsePacket(val), hexDump(val));
      });
      await dataChar.startNotifications();
    }

    // 非关键特征并行发现（互不依赖，异常彼此隔离）：
    // 浏览器内部仍会队列化 ATT 请求，但消除了 JS 层逐条 await 的调度停顿；
    // 配合固件建连期快速连接参数（latency 0），整个初始化可压缩到 1~2 秒内完成
    const getChar = async (uuid) => {
      try { return await service.getCharacteristic(uuid); }
      catch (e) { console.warn(`[BLE] characteristic ${uuid} not available:`, e); return null; }
    };

    const values = await Promise.allSettled([
      getChar(UUIDS.DAILY_CHAR),
      getChar(UUIDS.RESET_CHAR),
      getChar(UUIDS.CALIB_CHAR),
      getChar(UUIDS.REFRESH_CHAR),
      getChar(UUIDS.TEMP_OFFSET_CHAR),
      getChar(UUIDS.CALIB_STATUS_CHAR),
      getChar(UUIDS.DEV_NAME_CHAR),
      // 最新一次测量记录（9 字节，布局同历史记录；旧固件无此特征时为 null）
      getChar(UUIDS.LATEST_CHAR),
      // Telink OTA 升级特征（128bit UUID，仅 BLE_OTA_SERVER_ENABLE=1 的固件才有）
      (async () => {
        const otaService = await server.getPrimaryService(UUIDS.OTA_SERVICE);
        return otaService.getCharacteristic(UUIDS.OTA_CHAR);
      })(),
      // 标准 DIS 固件版本（Firmware Revision String），连接后用于新版本检测
      (async () => {
        const dis = await server.getPrimaryService(UUIDS.DIS_SERVICE);
        const fwRevChar = await dis.getCharacteristic(UUIDS.DIS_FW_REV_CHAR);
        return new TextDecoder().decode(await fwRevChar.readValue()).split(String.fromCharCode(0))[0].trim();
      })(),
    ]).then(results => results.map(r => (r.status === 'fulfilled' ? r.value : null)));

    const [dailyChar, resetChar, calibChar, refreshChar, tempOffsetChar, calibStatusChar, devNameChar, latestChar, otaChar, fwVersion] = values;

    return { device, dataChar, dailyChar, resetChar, calibChar, refreshChar, tempOffsetChar, calibStatusChar, devNameChar, latestChar, otaChar, fwVersion };
  }

  /**
   * 阶段2 入口：分段超时——gatt.connect() 单独 10s（设备睡着/蓝牙关闭时挂起，快速反馈），
   * 连接后的服务发现/时间同步/订阅初始化 20s（射频差/慢平台不误杀可用连接）。
   * 任一段超时都会在 withTimeout 内立即断开设备 GATT，不留“UI 未连接、设备已连上”的幽灵连接；
   * 错误标签 CONNECT_TIMEOUT / INIT_TIMEOUT 由 app.js 识别并给出对应提示。
   * @param {BluetoothDevice} device
   */
  async function finishConnect(device, onNotification, onDisconnect) {
    return finishConnectInner(device, onNotification, onDisconnect);
  }

  /**
   * 兼容入口：顺序执行 选设备 -> 带超时连接。供既有调用方（如 OTA 重试）继续使用。
   */
  async function connectDevice(onNotification, onDisconnect) {
    const device = await requestSoilDevice();
    return finishConnect(device, onNotification, onDisconnect);
  }

  /**
   * 向 0xFFE5 写入 4 字节魔术字 "CLR1"，请求设备清空历史/日均值 RAM 缓存
   */
  async function sendReset(resetChar) {
    if (!resetChar) {
      throw new Error('reset characteristic unavailable');
    }
    await resetChar.writeValue(RESET_MAGIC);
  }

  /**
   * 向 0xFFE5 写入 4 字节魔术字 "RST1"，请求设备清空全部业务数据并重启（连接会断开）
   */
  async function sendFactoryReset(resetChar) {
    if (!resetChar) {
      throw new Error('reset characteristic unavailable');
    }
    await resetChar.writeValue(FACTORY_RESET_MAGIC);
  }

  /**
   * 读取 0xFFE8 温度偏移值（有符号 1 字节，单位 0.1℃）
   * @param {BluetoothRemoteGATTCharacteristic} tempOffsetChar
   * @returns {Promise<number>} 偏移值，单位 0.1℃
   */
  async function readTempOffset(tempOffsetChar) {
    if (!tempOffsetChar) {
      throw new Error('temperature offset characteristic unavailable');
    }
    const val = await tempOffsetChar.readValue();
    if (val.byteLength < 1) {
      throw new Error('invalid temperature offset length');
    }
    return new DataView(val.buffer, val.byteOffset, val.byteLength).getInt16(0, true);  // 小端 int16，0.01℃
  }

  /**
   * 写入 0xFFE8 温度偏移值（有符号 1 字节，单位 0.1℃，内部钳位到 ±10℃）
   * @param {BluetoothRemoteGATTCharacteristic} tempOffsetChar
   * @param {number} offsetX10 - 单位 0.1℃
   */
  async function sendTempOffset(tempOffsetChar, offsetX10) {
    if (!tempOffsetChar) {
      throw new Error('temperature offset characteristic unavailable');
    }
    const clamped = Math.max(TEMP_OFFSET.MIN_X10, Math.min(TEMP_OFFSET.MAX_X10, Math.round(offsetX10)));
    const v = new Uint8Array(2);
    new DataView(v.buffer).setInt16(0, clamped, true);  // 小端 int16，0.01℃
    await tempOffsetChar.writeValue(v);
  }

  /**
   * 写入 0xFFEA 设备名（网页展示名）：UTF-8 编码后必须 ≤20 字节且全为可打印 ASCII（与固件校验一致）
   * @param {BluetoothRemoteGATTCharacteristic} devNameChar
   * @param {string} name - 新名字
   * @returns {Promise<{ok: boolean, message: string}>}
   */
  async function sendDeviceName(devNameChar, name) {
    if (!devNameChar) {
      return { ok: false, message: 'device name characteristic unavailable (old firmware?)' };
    }
    const bytes = new TextEncoder().encode(name);
    if (bytes.length === 0) {
      return { ok: false, message: 'device name cannot be empty' };
    }
    if (bytes.length > DEV_NAME_MAX_BYTES) {
      return { ok: false, message: `device name too long: ${bytes.length}/${DEV_NAME_MAX_BYTES} bytes` };
    }
    for (const b of bytes) {
      if (b < 0x20 || b > 0x7E) {
        return { ok: false, message: 'only printable ASCII characters are allowed' };
      }
    }
    await devNameChar.writeValue(bytes);
    return { ok: true, message: 'saved' };
  }

  /**
   * 读取 0xFFEA 设备名（设备侧存储的网页展示名）。
   * 旧固件该特征只写不可读、或读取失败时返回 null；设备未改名时返回默认名（如 "SoilPulse"）。
   * @param {BluetoothRemoteGATTCharacteristic|null} devNameChar
   * @returns {Promise<string|null>}
   */
  async function readDeviceName(devNameChar) {
    if (!devNameChar) {
      return null;
    }
    try {
      const val = await devNameChar.readValue();
      return new TextDecoder().decode(val).split(String.fromCharCode(0))[0].trim();
    } catch (err) {
      console.warn('[BLE] device name read failed:', err);
      return null;
    }
  }

  /**
   * 读取 0xFFE9 校准状态（2 字节：b0=标志 bit0=干点已校准 bit1=湿点已校准 bit2=温度偏移非0；
   * b1=最近一次校准尝试结果 0=无 1=干点成功 2=湿点成功 3=拒:湿度未低于5% 4=拒:湿度未高于95% 5=拒:两点过近 6=丢弃）
   * @param {BluetoothRemoteGATTCharacteristic} calibStatusChar
   * @returns {Promise<{dry: boolean, wet: boolean, temp: boolean, result: number|null}>}
   *          设备上已持久化存在的校准项 + 最近一次尝试结果（旧固件 result 为 null）
   */
  async function readCalibStatus(calibStatusChar) {
    if (!calibStatusChar) {
      throw new Error('calibration status characteristic unavailable');
    }
    const val = await calibStatusChar.readValue();
    if (val.byteLength < 1) {
      throw new Error('invalid calibration status length');
    }
    const view = new DataView(val.buffer, val.byteOffset, val.byteLength);
    const flags = view.getUint8(0);
    return {
      dry: !!(flags & CALIB_STATUS_FLAGS.DRY),
      wet: !!(flags & CALIB_STATUS_FLAGS.WET),
      temp: !!(flags & CALIB_STATUS_FLAGS.TEMP),
      // b1：最近一次校准尝试结果码；旧固件只有 1 字节时为 null，调用方退回标志位推断
      result: val.byteLength >= 2 ? view.getUint8(1) : null,
    };
  }

  /**
   * 向 0xFFE6 写入 1 字节湿度校准指令，用设备当前实测电压覆盖 dry(0%)/wet(100%) 基准点
   * @param {BluetoothRemoteGATTCharacteristic} calibChar
   * @param {'dry'|'wet'} point
   */
  async function sendHumCalib(calibChar, point) {
    if (!calibChar) {
      throw new Error('calibration characteristic unavailable');
    }
    const cmd = point === 'dry' ? HUM_CALIB_CMD.DRY : HUM_CALIB_CMD.WET;
    await calibChar.writeValue(cmd);
  }

  /**
   * 向 0xFFE7 写入 1 字节固定值，请求设备在连接态下立即重新执行一次测量
   * @param {BluetoothRemoteGATTCharacteristic} refreshChar
   */
  /**
   * 读取 0xFFEB latest 特征值（10 字节：epoch u32 + 温度 s16 + 湿度 u16 + 电量 u8 + measure_seq u8，小端）。
   * v2 规格：refresh 一次性测量不写历史，Refresh 按钮的实时值从这里轮询读取；
   * measure_seq 单调递增测量序号（新固件），前端以"序号变化"识别新测量免跳秒；
   * 旧固件只有 9 字节（无序号）时 measureSeq 为 undefined，前端回退"时间戳变化"判断。
   * 旧固件无此特征（latestChar 为 null）或读取失败时返回 null，由调用方超时兜底。
   * @param {BluetoothRemoteGATTCharacteristic|null} latestChar
   * @returns {Promise<{timestamp:number,temp:number,hum:number,batt:number,measureSeq?:number}|null>}
   */
  /**
   * 解析 0xFFEB latest 原始 DataView（10 字节：epoch u32 + 温度 s16 + 湿度 u16 + 电量 u8 + measure_seq u8）为测量记录对象；
   * 旧固件仅 9 字节（无序号）时 measureSeq 为 undefined，调用方回退时间戳判断。
   * readLatest() 与 notify 回调（characteristicvaluechanged）共用此解析。
   * @param {DataView} view
   * @returns {{timestamp:number,temp:number,hum:number,batt:number,measureSeq?:number}|null}
   */
  function parseLatestValue(view) {
    if (!view || view.byteLength < 10) return null;
    return {
      timestamp: view.getUint32(0, true),
      temp: view.getInt16(4, true) / 100,
      hum: view.getUint16(6, true) / 100,
      batt: view.getUint8(8),
      measureSeq: view.getUint8(9),   // 0xFFEB latest 固定 10 字节，measure_seq 必存在（产品锁新固件）
    };
  }

  async function readLatest(latestChar) {
    if (!latestChar) return null;
    const view = await latestChar.readValue();
    return parseLatestValue(view);
  }

  async function sendRefresh(refreshChar) {
    if (!refreshChar) {
      throw new Error('refresh characteristic unavailable');
    }
    await refreshChar.writeValue(REFRESH_CMD);
  }

  ////////////////////////// Telink BLE OTA 升级（legacy 协议） //////////////////////////
  // 协议与 SDK 内参考实现 vendor/ble_master_kma_dongle/blm_ota.c 严格对齐：
  //   START : CMD_OTA_START(0xFF01) 2 字节（legacy；B85 固件不支持 START_EXT 大包，见 BLOCK_BYTES 注释）
  //   DATA  : 20 字节 = adr_index(u16 LE，固件偏移>>4) + 16 字节固件 + crc16(u16 LE，覆盖前 18 字节)
  //   END   : 6 字节 = 0x02 0xFF + adr_index_max(u16) + 其按位取反(u16)
  //   PROG  : 设备通知 {0x08 0xFF + u16 已收包数}（CMD_OTA_SCHEDULE_PDU_NUM），
  //           仅当固件调用了 blc_ota_setOtaScheduleIndication_by_pduNum 才会上报；
  //           协议栈默认不回任何逐包通知，因此不能把“收到通知”当作必然事件
  //   RESULT: 设备通知 {0x06 0xFF result rsv}（CMD_OTA_RESULT），校验成功后设备自动重启断链
  // 固件 bin 头部 0x18 偏移存放固件长度（Telink bin 格式），发送字节数以此为准
  const OTA = {
    FW_SIZE_MAX: 124 * 1024,   // SDK 默认 ota_firmware_max_size（新固件存放在 flash 0x20000 起 124K 内）
    // 数据块大小（每包固件字节数）= CMD_OTA_START_EXT 声明的 pdu_length，必须是 16 的倍数。
    // 【约定】按 Telink 官方 Extend 协议：OTA_PDU = Adr_Index(2) + Data(n×16) + CRC(2)，整包 = pdu_length + 4。
    //   pdu_length=80 曾是妥协值：闭源库（liblt_825x.a）对 >16 的 DATA 实测全报 0x09（80/78/76 全拒），
    //   Release Note 称 "B85 does not support the OTA PDU bigger than 80"（112 在库上报 result 15）。
    //   固件已改 app 层自实现 OTA server（app_ota.c，支持 pdu 16~240 任意 16 倍数），
    //   固件 MTU_SIZE_SETTING=185（与 iOS/Safari 协商值对齐）：载荷 182B(MTU-3)，
    //   故这里取 B85 在 185 下能单包发送的最大 16 倍数：pdu_length=176，整包 180 ≤ 182(MTU-3)，
    //   Chrome/Safari/iOS 均协商到 185，全平台通用。
    //   提速效果：包数 874(80B) → 393(176B)，beacio 按包限流下总时长约 -55%。
    BLOCK_BYTES: 176,
    WINDOW: 32,                // 滑动窗口：允许的最大在途未确认包数（保持 32，与固件 32 包上报粒度匹配；不可小于 32，
                               //   否则会在设备首次上报前触发 waitProgress 超时 → 误判"设备不上报"而降级定速，破坏背压）
    SCHEDULE_GRANULARITY: 32,    // 固件 blc_ota_setOtaScheduleIndication_by_pduNum(32) 的上报粒度，收尾等待按整批对齐
    PROGRESS_TIMEOUT_MS: 2000, // 等待设备进度通知的超时（需覆盖跨 4K 扇区擦除耗时）
    END_TIMEOUT_MS: 10000,     // END 后等待结果通知 / 设备重启断链的超时
    WRITE_GAP_MS: 80,          // beacio 转发约 75ms/包、令牌桶约每秒补 12~13 包：50ms(20包/s) 每 ~12 包触发一次
                               //   Rate limit exceeded 报错（200ms 退避重试后成功，不影响结果但刷 Warning）。
                               //   调到 80ms(12.5包/s) 与转发节奏持平，理论不触发限流、日志干净；
                               //   393 包(176B)@80ms ≈ 31s 传完（50ms 实测含重试约 45s，慢约 5s 换无报错）。
                               //   历史：1ms/3ms 在旧代码（无限流重试）下 ~24 包触发限流断链；10ms 实测 beacio 丢包
                               //   （固件端 seq err got=75 expect=74，跳包 abort 为固件正确行为），故不再低于 50ms。
    WRITE_RETRY_MAX: 10,       // GATT busy / 限流等瞬时错误的重试次数（含限流重试，故上调）
    WRITE_RETRY_GAP_MS: 16,    // 重试基础退避时间
    RATE_LIMIT_RETRY_GAP_MS: 200, // 限流类错误（rate limit / too many）的专用退避：限流恢复需要时间，不能用 16ms 级退避
  };
  const OTA_CMD = { START: 0xFF01, START_EXT: 0xFF03, END: 0xFF02, RESULT: 0xFF06 };
  const OTA_RESULT_NAMES = {
    0x00: 'success',
    0x01: 'packet sequence error',
    0x02: 'invalid packet',
    0x03: 'packet CRC error',
    0x04: 'flash write error',
    0x05: 'data incomplete',
    0x06: 'flow error',
    0x07: 'firmware CRC error',
    0x09: 'PDU length error (device may not support large-block OTA)',
    0x0C: 'data packet timeout',
    0x0D: 'OTA process timeout',
    0x0F: 'connection terminated',
  };

  /**
   * Telink CRC16：反射多项式 0xA001、初值 0xFFFF（与协议栈 ota.o 中 crc16 的 poly 表 {0,0xA001} 一致）
   * @param {Uint8Array} bytes
   * @param {number} length 参与计算的字节数
   * @returns {number} 16 位 CRC（上线时按小端拆字节）
   */
  function telinkCrc16(bytes, length) {
    let crc = 0xFFFF;
    for (let i = 0; i < length; i++) {
      let d = bytes[i];
      for (let b = 0; b < 8; b++) {
        crc = ((crc >> 1) ^ (((crc ^ d) & 1) ? 0xA001 : 0)) & 0xFFFF;
        d >>= 1;
      }
    }
    return crc & 0xFFFF;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 中文：Bluefy / iOS WebKit 常见 "GATT operation already in progress"，
   *       对同一特征的写入必须串行并做短退避重试，避免 OTA 中途直接失败。
   */
  async function writeWithRetry(otaChar, data, withoutResponse) {
    let lastErr = null;
    for (let i = 0; i < OTA.WRITE_RETRY_MAX; i++) {
      try {
        if (withoutResponse) {
          // 无响应写限速：每包间留出最小间隔，避免在极短时间内向 BLE 栈涌入大量写请求
          //（iOS/beacio 转发层会以 "Rate limit exceeded — too many BLE requests" 拒绝过密请求）
          await sleep(OTA.WRITE_GAP_MS);
          await otaChar.writeValueWithoutResponse(data);
        } else {
          await otaChar.writeValue(data);
        }
        return;
      } catch (e) {
        lastErr = e;
        const msg = String(e?.message || e || '').toLowerCase();
        console.warn(`[OTA][write] #${i} attempt ${i + 1}/${OTA.WRITE_RETRY_MAX} failed t=${Date.now()}: ${e?.message || e}`);
        // 中文：链路已断开是终态错误，不可重试，直接抛出让上层走断链恢复流程
        const disconnected = msg.includes('disconnect') || msg.includes('gatt server is disconnected');
        // 限流类错误（beacio/系统对过密 BLE 请求的拒绝）同样可重试，但需用更长退避等待限流恢复
        const rateLimited = msg.includes('rate limit') || msg.includes('too many') || msg.includes('quota');
        const retryable = !disconnected && (rateLimited || msg.includes('already in progress') || msg.includes('busy') || msg.includes('operation failed'));
        if (!retryable || i === OTA.WRITE_RETRY_MAX - 1) {
          throw e;
        }
        const gap = rateLimited ? OTA.RATE_LIMIT_RETRY_GAP_MS : OTA.WRITE_RETRY_GAP_MS;
        await sleep(gap * (i + 1));
      }
    }
    throw lastErr || new Error('GATT write failed');
  }

  /**
   * Telink legacy OTA 升级流程（与 SDK 参考实现 vendor/ble_master_kma_dongle/blm_ota.c 对齐）：
   *   START → 逐包 DATA(20B，含 16B 固件) → END → 等待设备 CMD_OTA_RESULT 结果通知。
   *   设备每收到一包 DATA 写 flash 后回 1 字节通知做流控；成功校验通过后自动重启断链。
   * @param {BluetoothRemoteGATTCharacteristic} otaChar
   * @param {ArrayBuffer} firmware 固件 .bin 内容
   * @param {(info:{phase:string,percent:number,sent:number,total:number}) => void} onProgress
   * @returns {Promise<{ok:boolean, result:number|null, message:string}>}
   */
  async function performOta(otaChar, firmware, onProgress) {
    if (!otaChar) throw new Error('OTA characteristic unavailable');

    const bytes = new Uint8Array(firmware);
    if (bytes.byteLength < 0x18 + 4) {
      throw new Error('Invalid firmware: missing Telink bin header');
    }
    // Telink bin 头部 0x18 偏移存放固件长度（小端 u32），发送字节数以此为准
    const fwSize = new DataView(firmware).getUint32(0x18, true);
    if (!fwSize || fwSize > OTA.FW_SIZE_MAX || fwSize > bytes.byteLength) {
      throw new Error(`Invalid firmware size: ${fwSize} (max ${OTA.FW_SIZE_MAX})`);
    }

    // 订阅设备通知：传输进度(CMD_OTA_SCHEDULE_PDU_NUM) + 升级结果(CMD_OTA_RESULT)
    let ackedPdu = 0;           // 设备上报的已成功收包数（滑动窗口的背压信号）
    let progressWaiter = null;  // { target, resolve } 当前等待进度的任务
    let resultResolve = null;   // 结果通知等待
    const onChanged = (e) => {
      const v = e.target.value;
      const raw = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      if (raw.byteLength < 4 || raw[1] !== 0xFF) return;
      if (raw[0] === 0x06) {
        if (resultResolve) { resultResolve(raw[2]); resultResolve = null; }
      } else if (raw[0] === 0x08) {
        ackedPdu = raw[2] | (raw[3] << 8);
        if (progressWaiter && ackedPdu >= progressWaiter.target) {
          const w = progressWaiter; progressWaiter = null; w.resolve(true);
        }
      }
    };

    otaChar.addEventListener('characteristicvaluechanged', onChanged);
    try {
      await otaChar.startNotifications();
    } catch (e) {
      // 中文：Bluefy 等浏览器可能拒绝通知订阅（日志报 rejected，Promise 可能 resolve 也可能 reject）。
      //      通知仅用于进度流控与结果判定，缺失时降级：无背压 → 首次 waitProgress 超时自动转
      //      freerun 定速发送；END 后靠"固件校验通过才复位断链"判定成功。不阻塞 OTA。
      console.warn(`[OTA] notifications rejected, degrade to freerun: ${e?.message || e}`);
    }

    // 等待 ackedPdu 达到 target；返回 false 表示超时（设备卡顿，或该固件根本不上报进度）
    const waitProgress = (target, timeoutMs) => {
      if (ackedPdu >= target) return Promise.resolve(true);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (progressWaiter === waiter) progressWaiter = null;
          resolve(false);
        }, timeoutMs);
        const waiter = { target, resolve: (ok) => { clearTimeout(timer); resolve(ok); } };
        progressWaiter = waiter;
      });
    };
    // 等结果通知或设备断链：waitResult 只在 END 之后调用，此时断链 = 固件校验通过已进入复位流程。
    // （固件失败走 abort 不会 switch boot/reset，因此 END 后的 gattserverdisconnected 就是成功信号；
    //   返回 'disconnected' 供上层判定成功，返回 null 表示 10s 内既无通知也未断链的真超时。）
    const waitResult = () => new Promise((resolve) => {
      resultResolve = resolve;
      const dev = otaChar.service.device;
      const onDisco = () => { if (resultResolve) { resultResolve = null; resolve('disconnected'); } };
      dev.addEventListener('gattserverdisconnected', onDisco, { once: true });
      setTimeout(() => { if (resultResolve) { resultResolve = null; resolve(null); } }, OTA.END_TIMEOUT_MS);
    });

    try {
      onProgress?.({ phase: 'start', percent: 0, sent: 0, total: fwSize });

      // 1. START：CMD_OTA_START_EXT(0xFF03)，声明 pdu_length=BLOCK_BYTES(80)。
      //    官方 Extend 协议：后续 DATA 整包 = Adr_Index(2) + Data(pdu_length) + CRC(2) = pdu_length + 4。
      //    结构 ota_startExt_t = cmd(2) + pdu_length(1) + version_compare(1) + rsvd(16)，共 20 字节。
      //    version_compare=0（不做版本对比，避免 OTA_VERSION_COMPARE_ERR）。
      const startExt = new Uint8Array(20);
      startExt[0] = 0x03; startExt[1] = 0xFF;    // CMD_OTA_START_EXT 小端
      startExt[2] = OTA.BLOCK_BYTES;             // pdu_length=80（16 的倍数，≤B85 上限 80）
      startExt[3] = 0;                           // version_compare=0；rsvd[16] 默认 0
      await writeWithRetry(otaChar, startExt, false);
      console.debug(`[OTA] START_EXT sent: pdu_length=${OTA.BLOCK_BYTES} => ${OTA.BLOCK_BYTES + 4}B/pkt`);

      // 2. DATA：每包 84 字节 = adr_index(u16 LE) + 80 字节固件 + crc16(u16 LE，覆盖前 82 字节)。
      //    尾块不足 80 字节时补 0（补 0 部分不在 fwSize 内，设备最终 CRC32 校验不会计入）。
      //    滑动窗口：仅当在途未确认包数超过 OTA.WINDOW 时才等设备进度通知；
      //    若设备根本不上报进度（旧固件未开 blc_ota_setOtaScheduleIndication_by_pduNum），
      //    首次等待超时后关闭进度等待——发送本身由带响应写逐包背压，无需额外定速（FREERUN 已移除）。
      const DATA_BYTES = OTA.BLOCK_BYTES;   // 每包固件字节数 = pdu_length = 80（官方 Extend 格式）
      const totalBlocks = Math.ceil(fwSize / DATA_BYTES);
      let flowControl = true;
      let lastPercent = -1;
      for (let i = 0; i < totalBlocks; i++) {
        if (flowControl) {
          if (i - ackedPdu >= OTA.WINDOW) {
            const ok = await waitProgress(i - OTA.WINDOW + 1, OTA.PROGRESS_TIMEOUT_MS);
            if (!ok && ackedPdu === 0) flowControl = false;
          }
        }
        // 中文：flowControl=false（固件不上报进度）时不再做任何额外等待——
        //       DATA 带响应写本身逐包等固件 ATT 响应，天然背压，无需 FREERUN 定速。

        const off = i * DATA_BYTES;
        const pkt = new Uint8Array(2 + OTA.BLOCK_BYTES + 2);   // 整包 84B = idx(2)+data(80)+crc(2)
        pkt[0] = i & 0xff;
        pkt[1] = (i >> 8) & 0xff;
        const n = Math.min(DATA_BYTES, fwSize - off);
        pkt.set(bytes.subarray(off, off + n), 2);   // 尾块不足 80 时自动补 0（补 0 不在 fwSize 内，设备最终 CRC32 校验不计入）
        const crc = telinkCrc16(pkt, 2 + DATA_BYTES);   // 覆盖 idx+data（2+80=82 字节）
        pkt[2 + DATA_BYTES] = crc & 0xff;
        pkt[3 + DATA_BYTES] = (crc >> 8) & 0xff;
        /* 中文：DATA 用带响应写（writeValue）。无响应写（writeValueWithoutResponse）"成功返回"
         *       不保证固件真正收到——beacio/WebKit 限流时可能静默丢弃，固件端表现为跳号
         *       （seq err: got=148 expect=147）导致 OTA 失败。带响应写由固件写完 flash 后才回
         *       ATT Write Response，天然形成逐包确认 + 流控：
         *         · 每包送达有保证，杜绝跳号；
         *         · 包间间隔 = 固件处理时间（20~60ms），远低于 WebBluetooth 限流阈值，
         *           不再触发 "Rate limit exceeded" 重试告警；
         *         · 固件响应延迟即背压，无需依赖设备进度通知即可稳速发送。 */
        console.debug(`[OTA][DATA] write #${i}/${totalBlocks - 1} len=${pkt.length} idx=0x${i.toString(16).padStart(4, '0')} t=${Date.now()}`);
        await writeWithRetry(otaChar, pkt, false);

        const sent = Math.min(off + DATA_BYTES, fwSize);
        const percent = Math.round(sent * 100 / fwSize);
        if (percent !== lastPercent) {
          lastPercent = percent;
          onProgress?.({ phase: 'data', percent, sent, total: fwSize });
        }
      }
      // 收尾前等一下设备把在途包写完：进度按 SCHEDULE_GRANULARITY 整批上报，末尾不足一批不会单独上报，
      // 因此只等到最后一个整批即可（否则等 totalBlocks 永远等不到，白白拖满超时）
      if (flowControl) {
        const lastBatch = Math.floor(totalBlocks / OTA.SCHEDULE_GRANULARITY) * OTA.SCHEDULE_GRANULARITY;
        await waitProgress(lastBatch || totalBlocks, OTA.END_TIMEOUT_MS);
      }
      // 3. END：CMD_OTA_END(0xFF02) + adr_index_max + 其按位取反，共 6 字节
      //    用带响应写（writeValue）：固件 END 校验通过后先返回（协议栈发 ATT Write Response +
      //    result 通知），再由 main_loop 延时 ~1.5s 复位——响应正常发出、写不挂起、送达有保证
      //    （无响应写在 Bluefy 上可能丢包导致固件收不到 END、不复位、web 端超时）。
      //    结果判定走 waitResult（result 0 通知 / END 后断链=复位成功 双通道）。
      const maxIdx = totalBlocks - 1;
      onProgress?.({ phase: 'end', percent: 100, sent: fwSize, total: fwSize });
      await writeWithRetry(otaChar, Uint8Array.of(
        0x02, 0xFF,
        maxIdx & 0xff, (maxIdx >> 8) & 0xff,
        (~maxIdx) & 0xff, ((~maxIdx) >> 8) & 0xff,
      ), false);

      // 4. 等待设备结果通知（成功后设备自动重启断链）
      const result = await waitResult();
      if (result === 'disconnected') {
        return { ok: true, result: 0x00, message: 'OTA succeeded' };
      }
      if (result === null) {
        return { ok: false, result, message: 'OTA timeout waiting for device result (connection still alive)' };
      }
      if (result === 0x00) {
        return { ok: true, result, message: 'OTA succeeded' };
      }
      const name = OTA_RESULT_NAMES[result] || 'unknown error';
      return { ok: false, result, message: `OTA failed: ${name} (0x${result.toString(16).padStart(2, '0')})` };
    } finally {
      otaChar.removeEventListener('characteristicvaluechanged', onChanged);
      try { await otaChar.stopNotifications(); } catch (_) { /* 断链后忽略 */ }
    }
  }

  return {
    UUIDS,
    DEVICE_NAME,
    parsePacket,
    parseDailyPacket,
    hexDump,
    requestSoilDevice,
    finishConnect,
    connectDevice,
    sendReset,
    sendFactoryReset,
    sendHumCalib,
    sendRefresh,
    parseLatestValue,
    readLatest,
    readTempOffset,
    sendTempOffset,
    readCalibStatus,
    readDeviceName,
    sendDeviceName,
    performOta,
  };
})();