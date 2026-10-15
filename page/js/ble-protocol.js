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

  ////////////////////////// Telink BLE OTA 升级（START_EXT 大包协议） //////////////////////////
  // 协议与 SDK 参考实现及 stack/ble/service/ota/ota.h 的 ota_startExt_t 严格对齐：
  //   START_EXT : 20 字节 = 0x03 0xFF（CMD_OTA_START_EXT=0xFF03 小端）+ pdu_length(1，16*n，16~240)
  //               + version_compare(1，0 不比对) + rsvd(16，全 0)
  //   DATA      : 4+pdu_length 字节 = adr_index(u16 LE，pdu 块序号) + pdu_length 字节固件
  //               + crc16(u16 LE，覆盖前 2+pdu_length 字节)
  //   END       : 6 字节 = 0x02 0xFF + adr_index_max(u16) + 其按位取反(u16)
  //   PROG      : 设备通知 {0x08 0xFF + u16 已收包数}（CMD_OTA_SCHEDULE_PDU_NUM），
  //               仅当固件调用了 blc_ota_setOtaScheduleIndication_by_pduNum 才会上报；
  //               协议栈默认不回任何逐包通知，因此不能把“收到通知”当作必然事件
  //   RESULT    : 设备通知 {0x06 0xFF result rsv}（CMD_OTA_RESULT），校验成功后设备自动重启断链
  // 包长选择：泰凌微 TLSR8258（B85）闭源库（liblt_825x.a）内部硬编码限制 pdu_length <= 80 (0x50)。
  //           若 > 80 会直接报错 0x0F (OTA_MCU_NOT_SUPPORTED) 并由设备主动断链！
  //           因此 B85 最大单包固件字节数为 80 字节（整包 84B，全平台 iOS/Android/PC 通用稳定）。
  //           若设备回 0x0F 或 0x09，自动降级至 legacy 16 字节重试。
  // 固件 bin 头部 0x18 偏移存放固件长度（Telink bin 格式），发送字节数以此为准
  const OTA = {
    FW_SIZE_MAX: 124 * 1024,   // SDK 默认 ota_firmware_max_size（新固件存放在 flash 0x20000 起 124K 内）
    BLOCK_BYTES_LIST: [80, 16], // B85 库最大单包 80 字节（整包 84B），老固件回退 16 字节
    WINDOW: 32,                // 滑动窗口：允许的最大在途未确认包数（= 固件侧 32 包上报粒度；过大如 256 会压爆设备 RX 缓冲导致丢包序列错误）
    SCHEDULE_GRANULARITY: 32,    // 固件 blc_ota_setOtaScheduleIndication_by_pduNum(32) 的上报粒度，收尾等待按整批对齐
    PROGRESS_TIMEOUT_MS: 2000, // 等待设备进度通知的超时（需覆盖跨 4K 扇区擦除耗时）
    END_TIMEOUT_MS: 10000,     // END 后等待结果通知 / 设备重启断链的超时
    FREERUN_BURST: 4,          // 无进度反馈时的定速发送：每发几包让出一次执行权
    FREERUN_GAP_MS: 6,         // 定速发送的间隔（约 4 包/6ms ≈ 10KB/s，贴近一个连接事件能吃下的量，避免压垮设备断链）
    WRITE_RETRY_MAX: 6,        // GATT busy 等瞬时错误的重试次数
    WRITE_RETRY_GAP_MS: 16,    // 重试基础退避时间
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
    0x08: 'version compare error',
    0x09: 'pdu length error',
    0x0A: 'firmware mark error',
    0x0B: 'firmware size error',
    0x0C: 'data packet timeout',
    0x0D: 'OTA process timeout',
    0x0E: 'connection terminated',
    0x0F: 'MCU not supported (max 80B on B85)',
    0x10: 'logic error',
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
   * 中文：iOS / iPadOS 检测（含 iPadOS 桌面模式 UA 伪装 Mac 的场景）。
   *       用于 OTA 发包策略分流：iOS Safari(beacio 扩展) 内部有 IPC/BLE 频控，
   *       无响应写入的突发流会触发 "Rate limit exceeded — too many BLE requests"；
   *       其他平台（PC Chrome / Android Chrome / Bluefy）保持满速滑动窗口不受影响。
   */
  const IS_IOS = (/iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  /**
   * 中文：Bluefy / iOS WebKit 常见 "GATT operation already in progress"，
   *       对同一特征的写入必须串行并做短退避重试，避免 OTA 中途直接失败。
   */
  async function writeWithRetry(otaChar, data, withoutResponse) {
    let lastErr = null;
    for (let i = 0; i < OTA.WRITE_RETRY_MAX; i++) {
      try {
        if (withoutResponse) {
          await otaChar.writeValueWithoutResponse(data);
        } else {
          await otaChar.writeValue(data);
        }
        return;
      } catch (e) {
        lastErr = e;
        const msg = String(e?.message || e || '').toLowerCase();
        console.log(`[OTA] writeWithRetry error:${msg}, withoutResponse:${withoutResponse}`)
        // 中文：链路已断开是终态错误，不可重试，直接抛出让上层走断链恢复流程
        const disconnected = msg.includes('disconnect') || msg.includes('gatt server is disconnected');
        // 中文：beacio(iOS Safari 扩展) 频控报 "Rate limit exceeded — too many BLE requests"，
        //       属瞬态可恢复错误：退避等待其令牌桶回填后重发，不应中断 OTA
        const rateLimited = msg.includes('rate limit') || msg.includes('too many');
        const retryable = !disconnected && (rateLimited
          || msg.includes('already in progress') || msg.includes('busy') || msg.includes('operation failed'));
        if (!retryable || i === OTA.WRITE_RETRY_MAX - 1) {
          throw e;
        }
        // 中文：频控类错误用更长退避（60ms 递增）给 beacio 令牌桶恢复时间；常规 busy 保持 16ms 档
        await sleep(rateLimited ? 60 * (i + 1) : OTA.WRITE_RETRY_GAP_MS * (i + 1));
      }
    }
    throw lastErr || new Error('GATT write failed');
  }

  /**
   * 中文：OTA 单包固件字节数（pdu_length）选择：
   *       泰凌微 TLSR8258（B85）闭源库最大支持 80 字节（整包 84B）。
   *       84B 在 iOS（MTU 185 -> 载荷 182）、Android、PC 上均完美直通，无需平台区分。
   * @returns {number}
   */
  function pickBlockBytes() {
    return 80;
  }

  /**
   * 中文：Telink OTA 升级入口（START_EXT 大包协议）：
   *   START_EXT(声明 pdu_length=80) → 逐包 DATA → END → 等待设备 CMD_OTA_RESULT 结果通知；
   *   若设备报错（0x08/0x09/0x0F）时自动按 80→16 梯子降包重试。
   * @param {BluetoothRemoteGATTCharacteristic} otaChar
   * @param {ArrayBuffer} firmware 固件 .bin 内容
   * @param {(info:{phase:string,percent:number,sent:number,total:number,message?:string}) => void} onProgress
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

    const candidates = [...new Set([pickBlockBytes(), ...OTA.BLOCK_BYTES_LIST])]
      .filter((n) => n >= 16 && n <= 240 && n % 16 === 0)
      .sort((a, b) => b - a);
    const t0 = Date.now();
    console.info(`[OTA] session start: fwSize=${(fwSize / 1024).toFixed(1)}KB, pdu plan=${candidates.join('→')}B`);
    let last = null;
    for (const blockBytes of candidates) {
      try {
        last = await otaTransfer(otaChar, bytes, fwSize, blockBytes, onProgress);
      } catch (err) {
        // 中文：GATT 异常（如 Chrome 拒发超 MTU 的 244B 包）→ 记录后降包重试；
        //       链路已断开则没有重试意义，直接抛出交由上层走断链恢复
        const msg = String(err?.message || err || '');
        console.warn(`[OTA] pdu=${blockBytes} transfer threw: ${msg}`);
        if (msg.toLowerCase().includes('disconnect')) throw err;
        last = { ok: false, result: null, message: `transfer error: ${msg}` };
      }
      // 中文：需要降包重试的结果：
      //   0x09 = OTA_PDU_LEN_ERR（包长不是 16 的倍数或与声明不符）；
      //   0x0F = OTA_MCU_NOT_SUPPORTED（芯片硬件/库不支持该包长，如 B85 传了 > 80）；
      //   0x08 = OTA_VERSION_COMPARE_ERR
      if (last.ok || (last.result !== 0x08 && last.result !== 0x09 && last.result !== 0x0f)) {
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        if (last.ok) {
          console.info(`[OTA] session end in ${secs}s: SUCCESS`);
        } else {
          console.warn(`[OTA] session end in ${secs}s: FAILED — ${last.message}`);
        }
        return last;
      }
      console.warn(`[OTA] pdu=${blockBytes} rejected by device (0x${(last.result || 0).toString(16)}: ${OTA_RESULT_NAMES[last.result] || 'err'}), retry with smaller packets`);
      onProgress?.({ phase: 'retry', percent: 0, sent: 0, total: fwSize, message: `pdu=${blockBytes} rejected, retry with smaller packets` });
    }
    return last;
  }

  /**
   * 中文：单次完整 OTA 传输（指定包长）。设备每收满一窗回一次进度通知做流控；
   *       成功校验通过后设备自动重启断链。失败返回 {ok:false,...}，由 performOta 决定是否降包重试。
   */
  async function otaTransfer(otaChar, bytes, fwSize, blockBytes, onProgress) {

    // 订阅设备通知：传输进度(CMD_OTA_SCHEDULE_PDU_NUM) + 升级结果(CMD_OTA_RESULT)
    let ackedPdu = 0;           // 设备上报的已成功收包数（滑动窗口的背压信号）
    let progressWaiter = null;  // { target, resolve } 当前等待进度的任务
    let resultResolve = null;   // 结果通知等待
    let resultValue = null;     // 设备最近上报的 result（含传输中途的失败，供循环提前中止）
    let progressSeen = false;   // 是否收到过进度通知（判定通知通道是否存活）
    const onChanged = (e) => {
      const v = e.target.value;
      const raw = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      if (raw.byteLength < 4 || raw[1] !== 0xFF) return;
      if (raw[0] === 0x06) {
        resultValue = raw[2];   // 中文：中途失败（如 0x08 包长错误）也要记录，传输循环据此提前中止
        if (resultResolve) { resultResolve(raw[2]); resultResolve = null; }
      } else if (raw[0] === 0x08) {
        ackedPdu = raw[2] | (raw[3] << 8);
        if (!progressSeen) {
          progressSeen = true;
          console.info('[OTA] first progress notify received — notify channel alive');
        }
        console.info(`[OTA] progress acked ${ackedPdu} blocks`);
        if (progressWaiter && ackedPdu >= progressWaiter.target) {
          const w = progressWaiter; progressWaiter = null; w.resolve(true);
        }
      }
    };

    otaChar.addEventListener('characteristicvaluechanged', onChanged);
    try {
      await otaChar.startNotifications();
    } catch (e) {
      otaChar.removeEventListener('characteristicvaluechanged', onChanged);
      throw new Error(`Failed to enable OTA notifications: ${e.message || e}`);
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
    const waitResult = () => new Promise((resolve) => {
      resultResolve = resolve;
      setTimeout(() => { if (resultResolve) { resultResolve = null; resolve(null); } }, OTA.END_TIMEOUT_MS);
    });

    try {
      onProgress?.({ phase: 'start', percent: 0, sent: 0, total: fwSize });

      // 1. START_EXT：CMD_OTA_START_EXT(0xFF03) = 0x03 0xFF + pdu_length + version_compare(0) + rsvd[16]，共 20 字节
      const startExt = new Uint8Array(20);
      startExt[0] = OTA_CMD.START_EXT & 0xff;
      startExt[1] = (OTA_CMD.START_EXT >> 8) & 0xff;
      startExt[2] = blockBytes;   // 中文：声明本会话 pdu_length（16*n，16~240）
      startExt[3] = 0x00;         // version_compare: 0 = 不比对版本
      await writeWithRetry(otaChar, startExt, false);
      console.info(`[OTA] START_EXT sent ok: pdu=${blockBytes}B => ${blockBytes + 4}B/pkt on wire`);

      // 2. DATA：每包 4+curBlockBytes 字节 = adr_index(u16 LE，pdu 块序号) + 固件 + crc16(u16 LE，覆盖前 2+curBlockBytes 字节)。
      //    前序包 curBlockBytes = blockBytes(80)；泰凌微 B85 库要求最后一包按 16 字节向上对齐（不足 16 字节补 0）。
      //    滑动窗口：仅当在途未确认包数超过 OTA.WINDOW 时才等设备进度通知；
      //    若设备根本不上报进度（旧固件未开 blc_ota_setOtaScheduleIndication_by_pduNum），
      //    首次等待超时后降级为定速发送：没有背压时若全速盲发，设备来不及处理会直接监督超时断链。
      const totalBlocks = Math.ceil(fwSize / blockBytes);
      console.info(`[OTA] totalBlocks=${totalBlocks}, window=${OTA.WINDOW}, free-run pace=${OTA.FREERUN_BURST}pkt/${OTA.FREERUN_GAP_MS}ms`);
      let flowControl = true;
      let lastPercent = -1;
      for (let i = 0; i < totalBlocks && resultValue === null; i++) {
        if (flowControl) {
          if (i - ackedPdu >= OTA.WINDOW) {
            const ok = await waitProgress(i - OTA.WINDOW + 1, OTA.PROGRESS_TIMEOUT_MS);
            if (!ok && ackedPdu === 0) {
              flowControl = false;
              console.warn('[OTA] no progress notify in first window (acked=0), degrade to freerun');
            }
          }
        } else if (i % OTA.FREERUN_BURST === 0) {
          await sleep(OTA.FREERUN_GAP_MS);
        }

        const off = i * blockBytes;
        // 中文：泰凌微 B85 闭源库 otaWrite 规则：前序包数据长均为 blockBytes(80)，
        //       最后一包数据长必须按 16 字节向上对齐（r4[10] = ceil(rem/16)*16），
        //       若尾包仍补到 80 字节会导致 l2capLen 不匹配报 0x09 (OTA_PDU_LEN_ERR)。
        const isLast = (i === totalBlocks - 1);
        const rem = fwSize % blockBytes;
        const curBlockBytes = (isLast && rem !== 0) ? Math.ceil(rem / 16) * 16 : blockBytes;

        const pkt = new Uint8Array(4 + curBlockBytes);
        pkt[0] = i & 0xff;
        pkt[1] = (i >> 8) & 0xff;
        const n = Math.min(curBlockBytes, fwSize - off);
        pkt.set(bytes.subarray(off, off + n), 2);
        // 尾包不足 curBlockBytes 的部分，Uint8Array 默认初始化即为 0x00
        const crc = telinkCrc16(pkt, 2 + curBlockBytes);
        pkt[pkt.length - 2] = crc & 0xff;
        pkt[pkt.length - 1] = (crc >> 8) & 0xff;
        /* 中文：同一特征写操作必须串行，避免 WebKit 报 GATT busy。
         * 平台分流：iOS Safari(beacio) 用 writeValue(带响应)逐包等待固件 ATT Write Response——
         * 任意时刻在途请求恒为 1，串行化天然规避 beacio 扩展的 IPC/BLE 突发频控
         * ("Rate limit exceeded — too many BLE requests")，节奏自动对齐空口 RTT(15~30ms)；
         * PC/Android 等其他平台保持 writeValueWithoutResponse 满速滑动窗口(窗口数不变=32)。 */
        await writeWithRetry(otaChar, pkt, !IS_IOS);


        const sent = Math.min(off + curBlockBytes, fwSize);
        const percent = Math.round(sent * 100 / fwSize);
        if (percent !== lastPercent) {
          lastPercent = percent;
          onProgress?.({ phase: 'data', percent, sent, total: fwSize });
        }
      }
      // 中文：设备在传输中途上报了失败结果（如 0x08 包长错误/0x06 流程错误）→ 立即终止本轮，
      //      交由 performOta 判断是否降包重试（设备侧 OTA 已中止，继续等进度没有意义）
      if (resultValue !== null && resultValue !== 0x00) {
        console.warn(`[OTA] device aborted mid-transfer: ${OTA_RESULT_NAMES[resultValue] || 'unknown error'} (0x${resultValue.toString(16)})`);
        return { ok: false, result: resultValue, message: `OTA aborted by device mid-transfer: ${OTA_RESULT_NAMES[resultValue] || 'unknown error'}` };
      }
      // 收尾前等一下设备把在途包写完：进度按 SCHEDULE_GRANULARITY 整批上报，末尾不足一批不会单独上报，
      // 因此只等到最后一个整批即可（否则等 totalBlocks 永远等不到，白白拖满超时）
      if (flowControl) {
        const lastBatch = Math.floor(totalBlocks / OTA.SCHEDULE_GRANULARITY) * OTA.SCHEDULE_GRANULARITY;
        await waitProgress(lastBatch || totalBlocks, OTA.END_TIMEOUT_MS);
      }
      // 3. END：CMD_OTA_END(0xFF02) + adr_index_max + 其按位取反，共 6 字节
      const maxIdx = totalBlocks - 1;
      onProgress?.({ phase: 'end', percent: 100, sent: fwSize, total: fwSize });
      await writeWithRetry(otaChar, Uint8Array.of(
        0x02, 0xFF,
        maxIdx & 0xff, (maxIdx >> 8) & 0xff,
        (~maxIdx) & 0xff, ((~maxIdx) >> 8) & 0xff,
      ), false);
      console.info(`[OTA] END sent ok (maxIdx=${maxIdx}), waiting result...`);

      // 4. 等待设备结果通知（成功后设备自动重启断链）
      const result = await waitResult();
      if (result === null) {
        console.warn(`[OTA] result wait TIMEOUT (${OTA.END_TIMEOUT_MS / 1000}s) — device may have rebooted without notify`);
        return { ok: false, result, message: 'OTA timeout waiting for device result (device may have rebooted)' };
      }
      console.info(`[OTA] result notify received: 0x${result.toString(16).padStart(2, '0')} (${result === 0x00 ? 'SUCCESS' : OTA_RESULT_NAMES[result] || 'unknown'})`);
      if (result === 0x00) {
        return { ok: true, result, message: 'OTA succeeded, device is rebooting' };
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