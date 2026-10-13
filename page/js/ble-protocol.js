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
    WINDOW: 32,                // readAck 窗口确认粒度：每发满 32 包做一次 GATT Read 确认（request-response，
                               //   全平台可靠），缺包重传缺失段。32 包 = 5632B ≈ 8% 进度，一次 read ~50ms 往返，
                               //   401 包共 13 次 ≈ 650ms 总开销，可接受。
    MAX_STALL_RESENDS: 3,      // readAck 显示固件进度连续无推进（重传后仍卡住）的轮数上限，超限中止
    END_TIMEOUT_MS: 10000,     // END 后等待结果通知 / 设备重启断链的超时
    PER_PACKET_GAP_MS: 20,      // 每包写后统一等待。实测结论（2026-10-13，用户设备）：置 0 不加间隔时，
                               //   Android 的 writeValue 不等 ATT 响应（再次实证）→ 连发积压，固件在
                               //   4K 扇区擦除窗口（~20-100ms）内收包偶发 CRC 错包（实测 idx=94 坏包
                               //   重传 3 轮仍坏 → OTA stalled 直接退出）。间隔是 Android 上唯一背压
                               //   （iOS/Chrome 的 writeValue 等 ATT 响应，响应本身即背压，20ms 为附加）。
                               //   20ms = 50 包/秒，403 包 ≈ 8-9s（无响应写时代 50ms ≈ 20s）。
                               //   若仍偶发坏包，上调 30~50ms；窗口确认 + 落后重传兜底不变。
    WRITE_RETRY_MAX: 10,       // GATT busy / 限流等瞬时错误的重试次数（含限流重试，故上调）
    WRITE_RETRY_GAP_MS: 16,    // 重试基础退避时间
    RATE_LIMIT_RETRY_GAP_MS: 200, // 限流类错误（rate limit / too many）的专用退避：限流恢复需要时间，不能用 16ms 级退避
    CONFIRM_DIGEST_MS: 80,     // 窗口确认前的小停 / 落后确认的重读间隔：给固件消化在途窗口
                               // （flash 页写 + 偶发 4K 扇区擦除）留时间。窗口 read 落后时不再按固定
                               // 时长判断"够不够"，而是再停一轮重读一次：追上=在途滞后（Android
                               // writeValue 不等响应，web 已发≠固件已收），不重传；仍落后=真缺包才重传。
  };
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
  /**
   * 无响应写 + 重试（DATA 整包用）：全平台 fire-and-forget（不等 ATT 响应），
   * 每包后由 PER_PACKET_GAP_MS 固定间隔提供背压（固件 flash 消化时间），丢包由 readAck
   * 窗口确认兜底重传。重试时包可能已发出（fire-and-forget 无法确知），固件对 idx<next
   * 的 dup 包忽略，无害。
   */
  async function writeNoResponseWithRetry(otaChar, data) {
    let lastErr = null;
    for (let i = 0; i < OTA.WRITE_RETRY_MAX; i++) {
      try {
        await otaChar.writeValueWithoutResponse(data);
        return;
      } catch (e) {
        lastErr = e;
        const msg = String(e?.message || e || '').toLowerCase();
        console.warn(`[OTA][write-nr] #${i} attempt ${i + 1}/${OTA.WRITE_RETRY_MAX} failed t=${Date.now()}: ${e?.message || e}`);
        // 链路已断开是终态错误，不可重试，直接抛出让上层走断链恢复流程
        const disconnected = msg.includes('disconnect') || msg.includes('gatt server is disconnected');
        // 限流类错误（Chrome/系统对无响应写有速率限制）需用更长退避等待限流恢复
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
   * 带响应写 + 重试（全部包用：START_EXT / DATA / END）：固件处理完回 ATT 响应，
   * 逐包确认送达——END 尤其不能丢（Bluefy 上无响应写可能丢 END、固件不复位、web 端超时）。
   * DATA 曾短暂改用无响应写（writeNoResponseWithRetry）提速度，因丢包率高致 OTA 中途
   * 失败频繁、目标区反复半写，结合固件 boot mark 半写污染风险致设备变砖，已回退。
   */
  async function writeWithRetry(otaChar, data) {
    let lastErr = null;
    for (let i = 0; i < OTA.WRITE_RETRY_MAX; i++) {
      try {
        // 带响应写：固件处理完回 ATT 响应，送达有保证（全部包——START_EXT/DATA/END 通用）
        await otaChar.writeValue(data);
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
   * OTA 升级流程（固件 app 层自实现 GATT OTA server，readAck 统一确认）：
   *   START_EXT → 逐包 DATA(整包 180B，176B 固件) → 每 32 包 readAck 窗口确认（缺包重传）
   *   → 收尾 readAck 补尾 → END → 等待设备结果（result 通知 / 校验通过后复位断链 双通道）。
   *   确认通道只用 GATT Read（request-response，全平台语义一致），不依赖进度通知流控。
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

    // 通知订阅仅用于 END 后收 result 通知（0xFF06）；进度通知不再用于流控——
    // 确认通道统一用 readAck（GATT Read 是 request-response，全平台语义一致可靠）。
    let resultResolve = null;   // 结果通知等待
    const onChanged = (e) => {
      const v = e.target.value;
      const raw = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      if (raw.byteLength < 4 || raw[1] !== 0xFF) return;
      if (raw[0] === 0x06) {
        if (resultResolve) { resultResolve(raw[2]); resultResolve = null; }
      }
    };

    otaChar.addEventListener('characteristicvaluechanged', onChanged);
    // 通知订阅可能挂起或拒绝（Bluefy/Android 等），加 3s 超时兜底：只影响 result 通知通道，
    // END 后靠"固件校验通过才复位断链"判定成功（双通道），不阻塞 OTA。
    try {
      await Promise.race([
        otaChar.startNotifications(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('startNotifications timeout')), 3000)),
      ]);
    } catch (e) {
      console.warn(`[OTA] notifications rejected/timeout, result via disconnect only: ${e?.message || e}`);
    }

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
    // 超时兜底探测：固件是否还响应 read。Android 链路监控超时较长（固件 watchdog 复位是断电重启，
    // 不发 BLE disconnect 包，Android 可能 20s+ 才检测到断链，超过 END_TIMEOUT_MS）——
    // readValue 连续无响应（3s 超时/异常 × 2）= 固件已复位 = 升级成功；正常返回 = 固件还活着 = 真失败。
    const probeFirmwareAlive = async () => {
      for (let i = 0; i < 2; i++) {
        try {
          await Promise.race([
            otaChar.readValue(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('probe timeout')), 3000)),
          ]);
          return true;
        } catch (e) { /* 无响应，再试一次 */ }
      }
      return false;
    };
    // 读固件端进度 ACK（OTA 特征 readValue）：GATT Read 是 request-response，所有平台语义一致可靠，
    // 是平台无关的确认通道。返回固件端已成功收包数（s_ota_progress）；读取失败/老固件返回 null。
    const readAck = async () => {
      try {
        const v = await otaChar.readValue();
        const raw = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
        if (raw.byteLength < 4 || raw[0] !== 0x08 || raw[1] !== 0xFF) return null;
        return raw[2] | (raw[3] << 8);
      } catch (e) { return null; }
    };

    try {
      onProgress?.({ phase: 'start', percent: 0, sent: 0, total: fwSize });

      // 1. START：CMD_OTA_START_EXT(0xFF03)，声明 pdu_length=BLOCK_BYTES(176)。
      //    官方 Extend 协议：后续 DATA 整包 = Adr_Index(2) + Data(pdu_length) + CRC(2) = pdu_length + 4。
      //    结构 ota_startExt_t = cmd(2) + pdu_length(1) + version_compare(1) + rsvd(16)，共 20 字节。
      //    version_compare=0（不做版本对比，避免 OTA_VERSION_COMPARE_ERR）。
      const startExt = new Uint8Array(20);
      startExt[0] = 0x03; startExt[1] = 0xFF;    // CMD_OTA_START_EXT 小端
      startExt[2] = OTA.BLOCK_BYTES;             // pdu_length=176（整包 180 ≤ MTU-3 182，可容纳 Extend DATA）
      startExt[3] = 0;                           // version_compare=0；rsvd[16] 默认 0
      await writeWithRetry(otaChar, startExt);
      console.debug(`[OTA] START_EXT sent: pdu_length=${OTA.BLOCK_BYTES} => ${OTA.BLOCK_BYTES + 4}B/pkt`);

      // 2. DATA：整包 = adr_index(u16 LE) + 176 字节固件 + crc16(u16 LE，覆盖前 178 字节)。
      //    尾块不足 176 字节时补 0（补 0 部分不在 fwSize 内，设备最终 CRC32 校验不会计入）。
      //    确认通道统一用 readAck（GATT Read 是 request-response，全平台语义一致可靠），
      //    不再依赖进度通知流控：每发满 WINDOW(32) 包 → 小停让固件消化在途（flash 写+偶发擦除）
      //    → readAck 读固件真实进度 → 缺包重传 [realNext, i+1)。固件端对 idx<next 重复包忽略、
      //    idx==next 落盘，天然自愈。readAck 不可用（老固件）时跳过确认，由 END 固件校验兜底。
      const DATA_BYTES = OTA.BLOCK_BYTES;   // 每包固件字节数 = pdu_length = 176
      const totalBlocks = Math.ceil(fwSize / DATA_BYTES);
      let lastPercent = -1;
      let stallResends = 0;
      let lastRealNext = 0;   // 上一个窗口固件确认进度，用于判断"固件是否在推进"（连续无推进才判停滞）
      const sendPkt = async (idx, isResend) => {
        const off = idx * DATA_BYTES;
        const pkt = new Uint8Array(2 + OTA.BLOCK_BYTES + 2);   // 整包 = idx(2)+data(176)+crc(2)
        pkt[0] = idx & 0xff;
        pkt[1] = (idx >> 8) & 0xff;
        const n = Math.min(DATA_BYTES, fwSize - off);
        pkt.set(bytes.subarray(off, off + n), 2);   // 尾块不足 176 时自动补 0（补 0 不在 fwSize 内，设备最终 CRC32 校验不计入）
        const crc = telinkCrc16(pkt, 2 + DATA_BYTES);   // 覆盖 idx+data
        pkt[2 + DATA_BYTES] = crc & 0xff;
        pkt[3 + DATA_BYTES] = (crc >> 8) & 0xff;
        console.debug(`[OTA][DATA] ${isResend ? 'RESEND' : 'write'} #${idx}/${totalBlocks - 1} len=${pkt.length} idx=0x${idx.toString(16).padStart(4, '0')} t=${Date.now()}`);
        // DATA 用带响应写（逐包 ATT 确认）：无响应写丢包率高导致 OTA 中途失败频繁、
        // 目标区反复半写——结合固件 boot mark 半写污染（bin +0x08 自带 0x4B）曾致设备
        // 变砖只能线刷。回退到带响应写降低失败概率（固件侧已屏蔽 mark 半写污染作根治）；
        // readAck 窗口确认与落后重传仍保留，作为停滞兜底
        await writeWithRetry(otaChar, pkt);
        // 每包后统一等待（PER_PACKET_GAP_MS=20）：Android 的 writeValue 不等 ATT 响应，
        // 固定间隔是它唯一背压——无间隔连发实测在固件扇区擦除窗口产生 CRC 坏包（stall 中止）；
        // iOS/Chrome 的 writeValue 等响应，20ms 只是附加保险
        await sleep(OTA.PER_PACKET_GAP_MS);

        const sent = Math.min(off + DATA_BYTES, fwSize);
        const percent = Math.round(sent * 100 / fwSize);
        if (percent !== lastPercent) {
          lastPercent = percent;
          onProgress?.({ phase: 'data', percent, sent, total: fwSize });
        }
      };

      for (let i = 0; i < totalBlocks; i++) {
        await sendPkt(i, false);
        // 窗口边界确认：每发满 32 包停一次，readAck 拿固件真实进度，缺包则重传。
        // 首个窗口跳过确认：Android 链路刚建立、写队列积压（writeValue 不等 ATT 响应，web 已发≠
        // 固件已收，实测首窗口 read 常读到 0——整个窗口还在 BLE 队列里）。等第二窗口边界再确认
        // （此时距 START 已 ~2.6s、队列已清、链路稳定），首窗口真丢的包由 [acked, 64) 重传兜底。
        if ((i + 1) % OTA.WINDOW === 0 && i + 1 < totalBlocks && i + 1 >= OTA.WINDOW * 2) {
          await sleep(OTA.CONFIRM_DIGEST_MS);   // 让固件消化在途窗口（flash 页写 + 偶发擦除）
          const realNext = await readAck();
          if (realNext === null) continue;      // read 不可用（老固件/瞬时失败）→ 跳过本窗口确认，END 校验兜底
          let confirmed = realNext;
          if (confirmed < i + 1) {
            // 落后：可能是写队列在途滞后（固件随后会收到），重读最多 3 次等追上；仍落后才判真缺。
            for (let r = 0; r < 3 && confirmed < i + 1; r++) {
              await sleep(OTA.CONFIRM_DIGEST_MS);
              const again = await readAck();
              if (again === null) break;
              confirmed = again;
            }
          }
          if (confirmed < i + 1) {
            console.warn(`[OTA][RTX] window: device acked=${confirmed} (sent=${i + 1}), resending [${confirmed}, ${i + 1}) ${i + 1 - confirmed} pkt(s)`);
            for (let j = confirmed; j <= i; j++) await sendPkt(j, true);
            if (confirmed <= lastRealNext) {
              stallResends++;
              if (stallResends >= OTA.MAX_STALL_RESENDS) {
                throw new Error(`OTA stalled: firmware not confirming packets (acked=${confirmed}, sent=${i + 1})`);
              }
            } else {
              stallResends = 0;   // 固件在推进（只是 Android 继续丢），重置停滞计数
            }
          } else {
            stallResends = 0;     // 在途滞后最终追上，无缺包，直接继续
          }
          lastRealNext = confirmed;
        }
      }

      // 3. 收尾：readAck 确认全部收到，缺则补尾（最多 3 轮），然后 END。
      //    readAck 不可用（老固件）时跳过补尾，由 END 固件校验兜底。
      await sleep(OTA.CONFIRM_DIGEST_MS);
      for (let attempt = 0; attempt < 3; attempt++) {
        const realNext = await readAck();
        if (realNext === null) break;
        if (realNext >= totalBlocks) break;   // 全部收到
        console.warn(`[OTA][RTX] tail: device acked=${realNext}/${totalBlocks}, resending tail`);
        for (let j = realNext; j < totalBlocks; j++) await sendPkt(j, true);
        await sleep(OTA.CONFIRM_DIGEST_MS);
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
      ));

      // 4. 等待设备结果通知（成功后设备自动重启断链）
      const result = await waitResult();
      if (result === 'disconnected') {
        return { ok: true, result: 0x00, message: 'OTA succeeded (firmware rebooted)' };
      }
      if (result === null) {
        // 超时且连接还活着：Android 链路监控慢，固件可能已复位但断链事件未触发（10s < Android
        // 检测周期）——探测固件是否还响应：无响应 = 已复位 = 成功；正常返回 = 固件还在 = 真失败。
        const alive = await probeFirmwareAlive();
        if (!alive) {
          console.warn('[OTA] result timeout but firmware not responding (rebooted), treat as success');
          return { ok: true, result: 0x00, message: 'OTA succeeded (firmware rebooted)' };
        }
        return { ok: false, result, message: 'OTA timeout waiting for device result (firmware still alive)' };
      }
      if (result === 0x00) {
        return { ok: true, result, message: 'OTA succeeded (firmware rebooted)' };
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