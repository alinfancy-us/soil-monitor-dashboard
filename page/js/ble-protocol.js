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

  // 0xFFED 30 天紧凑包（须与固件 soil_daily_log.h 的 SOIL_DAILY30_* 严格对齐）
  //   184B = +0 count u8 | +1 base_day u16（本地天号 − 2000-01-01）| +3 tz_code u8
  //          | +4 起 30 × 6B（day_off u16 | temp s16(0.01℃) | hum u8 | batt u8）
  //   tz_code = (tz_min + 840)/15 + 1，反算 tz_min = (tz_code − 1) × 15 − 840
  // ⚠ 184B 是硬上限：ATT 读响应单包最大 MTU−1，而 MTU_SIZE_SETTING=185。
  //   再长就会退化成 Read Blob 长读，各家手机协议栈行为不一致，不能依赖。
  // 为什么包头带时区：base_day 只是"设备本地天序号"，还原绝对 epoch 必须知道时区；
  //   靠 0xFFE3 反推不行——0xFFE3 是 RAM 环，换电池后只剩 Flash 的 30 天。
  const DAILY30_HDR_SIZE = 4;
  const DAILY30_RECORD_SIZE = 6;
  const DAILY30_MAX_RECORDS = 30;
  const DAILY30_PACKET_SIZE = DAILY30_HDR_SIZE + DAILY30_RECORD_SIZE * DAILY30_MAX_RECORDS;   // 184
  const DAILY30_DAY_ORIGIN = 10957;   // 2000-01-01 的天号
  const DAILY30_TZ_STEP = 15;
  const DAILY30_TZ_BIAS = 840;

  // 0xFFEE 30 天温度极值包（须与固件 SOIL_DAILY30_EXT_* 严格对齐）
  //   124B = +0 count u8 | +1 base_day u16 | +3 tz_code u8 | +4 起 30 × 4B
  //          （day_off u16 | tmin_d10 s8 | tmax_d10 s8），tmin/tmax 为"相对当日均值的 0.1℃ 偏移"，
  //          0x80(= -128) 哨兵 = 该天无极值（旧固件记录）。124B < 184B，单次读无需分块。
  const DAILY30_EXT_RECORD_SIZE = 4;
  const DAILY30_EXT_MAX_RECORDS = 30;
  const DAILY30_EXT_PACKET_SIZE = DAILY30_HDR_SIZE + DAILY30_EXT_RECORD_SIZE * DAILY30_EXT_MAX_RECORDS;   // 124

  // 0xFFEC 分块读协议（须与固件 SOIL_HISTORY_BLK_MAX / soil_history_blk_pkt_t 严格对齐）：
  // 写 2 字节窗口 {offset u8, count u8}（offset 0 = 设备环内最旧一条）→ 读 183 字节块
  // {total u8, offset u8, count u8, 20 × 9B 记录}，未用槽全 0。
  // 183B ≤ ATT 读响应上限（MTU 185 → 最大 184B）；144 条 = 8 次读。
  const HIS_BLK_REQ_SIZE = 2;
  const HIS_BLK_HDR_SIZE = 3;
  const HIS_BLK_MAX_COUNT = 20;
  const HIS_BLK_PACKET_SIZE = HIS_BLK_HDR_SIZE + HIS_BLK_MAX_COUNT * RECORD_SIZE;
  // 拉取全量史的保险上限（144 条 / 20 = 8 次；放宽到 32 次防固件 total 异常时死循环）
  const HIS_BLK_MAX_CHUNKS = 32;

  /**
   * 解析 0xFFEC 历史块响应包（183 字节）
   * @returns {{total:number, offset:number, records:Array}}
   */
  function parseHistoryBlockPacket(view) {
    if (!view || view.byteLength < HIS_BLK_PACKET_SIZE) {
      throw new Error(`Invalid history block length: ${view?.byteLength} (expected ${HIS_BLK_PACKET_SIZE})`);
    }
    const total = view.getUint8(0);
    const offset = view.getUint8(1);
    const count = Math.min(view.getUint8(2), HIS_BLK_MAX_COUNT);
    const records = [];
    for (let i = 0; i < count; i++) {
      const off = HIS_BLK_HDR_SIZE + i * RECORD_SIZE;
      records.push({
        timestamp: view.getUint32(off, true),
        temp: view.getInt16(off + 4, true) / 100,
        hum: view.getUint16(off + 6, true) / 100,
        batt: view.getUint8(off + 8),
      });
    }
    return { total, offset, records };
  }

  /**
   * 读取 0xFFEC 的一个历史块：写 2 字节窗口 → 读 183 字节响应
   * @param {BluetoothRemoteGATTCharacteristic} blkChar
   * @param {number} offset - 逻辑序号（0 = 设备环内最旧一条）
   * @param {number} count  - 请求条数（固件侧钳位到 20）
   * @returns {Promise<{total:number, offset:number, records:Array}>}
   */
  async function readHistoryBlock(blkChar, offset, count) {
    if (!blkChar) {
      throw new Error('history block characteristic unavailable');
    }
    const req = Uint8Array.of(offset & 0xff, count & 0xff);
    await blkChar.writeValue(req);           // 带响应写：确保窗口写入送达后 再发读请求
    const val = await blkChar.readValue();
    return parseHistoryBlockPacket(val);
  }

  /**
   * 从 0xFFEC 拉取设备全部 24h 历史（old → new），按 total/空块自动收敛
   * @param {BluetoothRemoteGATTCharacteristic} blkChar
   * @param {(fetched:number, total:number) => void} [onProgress] - 每块回调（进度提示）
   * @returns {Promise<Array>} 记录数组（按时间从旧到新）
   */
  async function fetchFullHistory(blkChar, onProgress) {
    const all = [];
    let offset = 0;
    let total = Infinity;
    for (let chunk = 0; chunk < HIS_BLK_MAX_CHUNKS; chunk++) {
      const blk = await readHistoryBlock(blkChar, offset, HIS_BLK_MAX_COUNT);
      total = blk.total;
      all.push(...blk.records);
      onProgress?.(all.length, total);
      // 终止条件：设备无数据 / 块为空（offset ≥ total）/ 已取满
      if (total === 0 || blk.records.length === 0 || all.length >= total) break;
      offset += blk.records.length;
    }
    return all;
  }

  /**
   * 从 0xFFEC 拉 24h 历史，**从最新一页往回翻**，每页到手立刻回调。
   *
   * 为什么不复用 fetchFullHistory：它从 offset=0（环内最旧）开始往新翻，
   * 而用户最先要看的是最近几小时——那在最后一页。144 条 = 8 次 write+read 往返
   * （Bluefy/iOS 单次 200~250ms），正序要等满 8 次（≈1.6~2s）才第一次有数据上屏，
   * 这段时间界面停在旧图/空图上，看起来像"连上了但没数据"。
   *
   * 这里：offset=0 读一次拿 total（这一页反正也要读，不浪费，但不回调——它是最旧的
   * 20 条，先画它会停在 24 小时前）→ 直接跳到最后一页往回翻。总往返次数与正序相同
   * （144 条仍是 8 次），但"第一次有数据"的时刻从第 8 次往返提前到第 2 次（≈400ms）。
   *
   * @param {BluetoothRemoteGATTCharacteristic} blkChar
   * @param {{onChunk?: (records:Array, info:{total:number, fetched:number, done:boolean}) => void}} [opts]
   *        onChunk 每页回调一次：records 是这一页的记录（页内时间升序，不是累计）
   * @returns {Promise<Array>} 全部记录，按时间升序
   */
  async function fetchHistoryNewestFirst(blkChar, { onChunk } = {}) {
    const head = await readHistoryBlock(blkChar, 0, HIS_BLK_MAX_COUNT);
    const total = Math.min(head.total, HIS_BLK_MAX_COUNT * HIS_BLK_MAX_CHUNKS);
    const all = [...head.records];
    let fetched = head.records.length;
    // 中文：这一页是**最旧**的 20 条，不回调——第一帧就画它，图会停在 24 小时前那段，
    //      和"先看最新"正好相反。只有总数就这一页（total ≤ 20，没有尾页可翻）时才回调。
    const onlyPage = fetched >= total;
    if (onlyPage) onChunk?.(head.records, { total, fetched, done: true });
    // 最后一页的起点按整页对齐：144 → 140（末页只有 4 条），20 → 0（无末页，跳出）
    for (let start = Math.floor((total - 1) / HIS_BLK_MAX_COUNT) * HIS_BLK_MAX_COUNT;
      start > 0; start -= HIS_BLK_MAX_COUNT) {
      const blk = await readHistoryBlock(blkChar, start, HIS_BLK_MAX_COUNT);
      if (!blk.records.length) break;     // 设备侧窗口越界：放手，别在坏数据上死循环
      all.push(...blk.records);
      fetched += blk.records.length;
      onChunk?.(blk.records, { total, fetched, done: fetched >= total });
    }
    // 回调是"乱序到达"的（末页先到），下行消费方按时间合并，
    // 返回值仍统一排成升序，老调用点语义不变
    return all.sort((a, b) => a.timestamp - b.timestamp);
  }

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


  /**
   * 解析 0xFFED 30 天紧凑包（184B）
   * 输出与 0xFFE3 同构的记录数组（dateEpoch / temp / hum / battPercent）。
   *
   * 还原公式：dateEpoch = (base_day + day_off) × 86400 + tz_min × 60
   *   base_day 以 2000-01-01 为零点（u16，够用到 2179 年），tz_min 来自包头 tz_code，
   *   两者合起来才能还原成与 0xFFE3 完全一致的"本地 0 点 epoch"，被 mergeDailyRecords 去重。
   * @param {DataView} view
   * @returns {Array<{dateEpoch:number,temp:number,hum:number,battPercent:number}>}
   */
  function parseDaily30Packet(view) {
    if (!view || view.byteLength < DAILY30_PACKET_SIZE) {
      throw new Error(`Invalid daily30 packet length: ${view?.byteLength} (expected ${DAILY30_PACKET_SIZE})`);
    }
    const count = Math.min(view.getUint8(0), DAILY30_MAX_RECORDS);
    const baseDay = DAILY30_DAY_ORIGIN + view.getUint16(1, true);
    const tzCode = view.getUint8(3);
    const tzMin = tzCode ? ((tzCode - 1) * DAILY30_TZ_STEP - DAILY30_TZ_BIAS) : 0;
    const tz = tzMin * 60;
    const records = [];
    for (let i = 0; i < count; i++) {
      const off = DAILY30_HDR_SIZE + i * DAILY30_RECORD_SIZE;
      const dayOff = view.getUint16(off, true);
      records.push({
        dateEpoch: (baseDay + dayOff) * 86400 + tz,
        temp: view.getInt16(off + 2, true) / 100,
        hum: view.getUint8(off + 4),          // 已经是整数百分比
        battPercent: view.getUint8(off + 5),
      });
    }
    return records;
  }


  /**
   * 解析 0xFFEE 30 天温度极值包（124B）
   * 每条 4B：day_off u16 + tmin_d10 s8 + tmax_d10 s8，day_off/base_day/tz_code 与 0xFFED 完全同义，
   * 前端按 dateEpoch 与 parseDaily30Packet 的输出对齐。
   * 极值是"相对当日均值的 0.1℃ 偏移"：min ≤ 0、max ≥ 0；0x80 = 该天无极值数据（旧固件记录）。
   * @param {DataView} view
   * @returns {Array<{dateEpoch:number,tempMinD10:number,tempMaxD10:number}>}
   *          tempMinD10/tempMaxD10 为 null 表示无极值（不画标记）
   */
  function parseDaily30ExtPacket(view) {
    if (!view || view.byteLength < DAILY30_EXT_PACKET_SIZE) {
      throw new Error(`Invalid daily30ext packet length: ${view?.byteLength} (expected ${DAILY30_EXT_PACKET_SIZE})`);
    }
    const EXT_UNKNOWN = -128;
    const count = Math.min(view.getUint8(0), DAILY30_EXT_MAX_RECORDS);
    const baseDay = DAILY30_DAY_ORIGIN + view.getUint16(1, true);
    const tzCode = view.getUint8(3);
    const tzMin = tzCode ? ((tzCode - 1) * DAILY30_TZ_STEP - DAILY30_TZ_BIAS) : 0;
    const tz = tzMin * 60;
    const records = [];
    for (let i = 0; i < count; i++) {
      const off = DAILY30_HDR_SIZE + i * DAILY30_EXT_RECORD_SIZE;
      const dayOff = view.getUint16(off, true);
      const tmin = view.getInt8(off + 2);
      const tmax = view.getInt8(off + 3);
      records.push({
        dateEpoch: (baseDay + dayOff) * 86400 + tz,
        tempMinD10: tmin === EXT_UNKNOWN ? null : tmin,
        tempMaxD10: tmax === EXT_UNKNOWN ? null : tmax,
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
      // 24h 历史分块读特征（0xFFEC，旧固件无此特征时为 null → 回退 0xFFE1 老协议）
      getChar(UUIDS.HISTORY_BLK_CHAR),
      // 30 天日均紧凑包（0xFFED，旧固件无此特征时为 null → 只用 0xFFE3 的 7 天）
      getChar(UUIDS.DAILY30_CHAR),
      // 30 天温度极值包（0xFFEE，旧固件无此特征时为 null → 日均图无极值标记）
      getChar(UUIDS.DAILY30_EXT_CHAR),
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

    const [dailyChar, resetChar, calibChar, refreshChar, tempOffsetChar, calibStatusChar, devNameChar, latestChar, hisBlkChar, daily30Char, daily30ExtChar, otaChar, fwVersion] = values;

    return { device, dataChar, dailyChar, resetChar, calibChar, refreshChar, tempOffsetChar, calibStatusChar, devNameChar, latestChar, hisBlkChar, daily30Char, daily30ExtChar, otaChar, fwVersion };
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
   * 写入 0xFFE8 温度偏移值（小端 int16，单位 0.01℃，±1000 = ±10.00℃，与固件 SOIL_TEMP_OFFSET_* 一致）
   * @param {BluetoothRemoteGATTCharacteristic} tempOffsetChar
   * @param {number} offsetX100 - 单位 0.01℃（250 = 2.50℃）
   */
  async function sendTempOffset(tempOffsetChar, offsetX100) {
    if (!tempOffsetChar) {
      throw new Error('temperature offset characteristic unavailable');
    }
    const clamped = Math.max(TEMP_OFFSET.MIN_X10, Math.min(TEMP_OFFSET.MAX_X10, Math.round(offsetX100)));
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
    WINDOW: 8,                 // readAck 窗口确认粒度：每发满 8 包做一次确认，与固件收包推进粒度
                               //   （SOIL_OTA_SCHEDULE_EVERY=8）对齐——丢包 8 包内被发现、缺失段更短、
                               //   重传更及时。确认通道统一 readAck（不依赖 notify，见 fix20）。
    MAX_STALL_RESENDS: 3,      // readAck 显示固件进度连续无推进（重传后仍卡住）的轮数上限，超限中止
    END_TIMEOUT_MS: 10000,     // END 后等待固件终态（readAck 轮询）的总超时
    STATUS_IDLE: 0x00,         // readAck 会话状态（固件 my_OtaData[4]，GATT Read 全平台可靠）：
    STATUS_ACTIVE: 0x01,       //   DATA 传输中（目标区预擦完成，就绪）
    STATUS_SUCCESS: 0x02,      //   END 校验通过 + boot mark 已切，待复位（=成功终态）
    STATUS_ABORTED: 0x03,      //   会话失败（原因码在 my_OtaData[5]，即 SOIL_OTA_RES）
    STATUS_PREPARING: 0x04,    //   目标区预擦中（官方预擦策略：进 OTA 整区预擦 ~3s，web 轮询等待就绪再发 DATA）
    STATUS_VERIFYING: 0x05,    //   END 已受理：固件在主循环分块回读校验整包 CRC32（约 1~2s，逐块喂狗+让出射频不断链），
                               //   web 读到 0x05 继续轮询等待 SUCCESS/ABORTED 终态，勿重发 END
    // 【fix21】预擦盲等动态化（解耦前端写死 4500 猜固件擦除时序）：
    //   v1.2.37+ 固件 START 后置 PREPARING 但暂不擦（等首次 read 放闸），readAck[6..7] 上报
    //   预计擦除时长 X(ms)；web 盲等 = X + PRE_ERASE_EXTRA_MS（余量防 flash 老化/波动）。
    //   老固件（无 X，[6..7]=0）或首次 read 失败 → 回退 PRE_ERASE_BLIND_MS_FALLBACK（旧固定值）。
    PRE_ERASE_EXTRA_MS: 1500,
    PRE_ERASE_BLIND_MS_FALLBACK: 4500,
    PER_PACKET_GAP_MS: 20,      // 每包写后统一等待（全平台无区分）：固定间隔是物理层的唯一背压——
                               //   Android 的 writeValue 不等 ATT 响应、瞬间 resolve，Promise 返回≠包已上
                               //   链路（实测 2026-10-13 置 0 连发积压 → 4K 擦除窗口偶发 CRC 坏包）；
                               //   iOS 真等 ATT 响应，间隔作附加保险。20ms ≈ 一个 15ms 连接事件 + 余量。
                               //   历史 10ms 曾因 iOS 侧优化下调，但统一后取 20 覆盖两平台最稳。
    WRITE_RETRY_MAX: 10,       // GATT busy / 限流等瞬时错误的重试次数（含限流重试，故上调）
    WRITE_RETRY_GAP_MS: 16,    // 重试基础退避时间
    RATE_LIMIT_RETRY_GAP_MS: 200, // 限流类错误（rate limit / too many）的专用退避：限流恢复需要时间，不能用 16ms 级退避
    CONFIRM_DIGEST_MS: 30,     // 窗口确认前的小停 / 落后确认的重读间隔：8 包窗口固件消化快（8 包写完
                               //   ~80ms，固件随即主循环 flush），30ms 足够等固件落盘。窗口 read 落后时
                               //   不再按固定时长判断"够不够"，而是再停一轮重读一次：追上=在途滞后
                               //   （writeValue 不等响应，web 已发≠固件已收），不重传；
                               //   仍落后=真缺包才重传。
    GBN_REWIND_SETTLE_MS: 50,  // Go-Back-N 回退的【最低】排空等待：实际等待 = max(本值,
                               //   在途包数 × PER_PACKET_GAP_MS)，按底层队列压包量动态拉长，
                               //   确保旧队列彻底死寂后再灌入重传包。
                               //   真机高频丢包测试若仍见回退后报错序，可直接上调本值至 100~150ms
  };
  // 与固件 app_ota.c 的 SOIL_OTA_RES 枚举逐项对齐（0x00~0x11）。
  // 漏项会导致 readAck 拿到 ABORTED 却显示成 "code 0x0A" 这种无意义提示。
  const OTA_RESULT_NAMES = {
    0x00: 'success',
    0x01: 'packet sequence error',
    0x02: 'invalid packet',
    0x03: 'packet CRC error',
    0x04: 'flash write error',
    0x05: 'data incomplete',
    0x06: 'flow error',
    0x07: 'firmware CRC error',
    0x08: 'firmware version error',
    0x09: 'PDU length error (device may not support large-block OTA)',
    0x0A: 'firmware boot mark error',
    0x0B: 'firmware size error',
    0x0C: 'data packet timeout',
    0x0D: 'OTA process timeout',
    0x0E: 'connection terminated',
    0x0F: 'not supported',
    0x10: 'internal logic error',
    0x11: 'battery too low (below 2.2V, replace batteries before upgrading)',
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
        // iOS 断连后旧特征报 "no longer valid"（UUID 失效提示），同样为终态，一并命中
        const disconnected = msg.includes('disconnect') || msg.includes('gatt server is disconnected') || msg.includes('no longer valid');
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
   * OTA 升级流程（固件 app 层自实现 GATT OTA server，readAck 状态机统一确认）：
   *   START_EXT（读轮询确认激活）→ 逐包 DATA(整包 180B，176B 固件) → 每 32 包 readAck
   *   窗口确认（缺包重传）→ 收尾 readAck 补尾 → END → readAck 轮询固件终态
   *   （SUCCESS=成功 / ABORTED+原因码=失败 / 仍 active=重发 END / 读失败+probe=复位成功）。
   *   确认通道只有 GATT Read（request-response，全平台语义一致）——不依赖通知订阅、
   *   不依赖平台 write 语义（Android writeValue 不等 ATT 响应），START/END 均读轮询确认。
   * @param {BluetoothRemoteGATTCharacteristic} otaChar
   * @param {ArrayBuffer} firmware 固件 .bin 内容
   * @param {(info:{phase:string,percent:number,sent:number,total:number}) => void} onProgress
   * @returns {Promise<{ok:boolean, result:number|null, message:string}>}
   */
  // 【fix20】OTA 不订阅特征 notify（两平台派发均不可靠），无订阅状态标记
  async function performOta(otaChar, firmware, onProgress) {
    window.__otaStage = 'start-write';   // 【fix23】崩溃现场阶段标记：写 START
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

    // 【fix20】OTA 不订阅特征 notify：两平台实测 notify 派发均不可靠（iOS Safari 盲等期间不派发、
    // 积压至 GATT 操作才批量派发；Android 同样不稳定），统一不用 notify——固件 push 照发但无人收，
    // 确认通道全部走 readAck（GATT Read 是 request-response，所有平台语义一致）。不订阅同时消除了
    // startNotifications 的平台差异（Bluefy 挂起 / Android 差异）成为依赖点的可能。

    // 断连中止：iOS 预擦断连/链路异常后，旧特征上的 write 必失败（no longer valid），
    // 与其让残留流程（ready 超时→readAck 重试→DATA 写旧特征）浪费整个重连周期，
    // 不如监听 gattserverdisconnected 立即中止本次会话，由 app.js 干净重连后重新
    // performOta（新连接新特征）。
    let otaSessionAborted = false;
    // 是否已进入 DATA 阶段（写过一个固件包）。用于区分"START 预检被拒"和"传输中途失败"：
    // 前者 Flash 一个字节未动、链路里也没有残留写请求，不该为清队列而断链。
    let otaDataStarted = false;
    const abortOtaSession = () => { otaSessionAborted = true; };
    const otaDevice = otaChar.service.device;
    otaDevice.addEventListener('gattserverdisconnected', abortOtaSession);
    const throwIfOtaAborted = () => {
      if (otaSessionAborted) throw new Error('OTA aborted: device disconnected during session');
    };
    // 【fix20】OTA 已不依赖 notify，无需订阅特征（固件 push 照发但无人收）；
    // 断连重连后由 app.js 干净重连并重新 performOta（新连接新特征）。

    // 超时兜底探测：固件是否还响应 read。固件 watchdog 复位是断电重启（不发 BLE disconnect 包，
    // Android 链路监控可能 20s+ 才检测到断链）——readValue 连续无响应（3s 超时/异常 × 2）=
    // 固件已复位 = 升级成功；正常返回 = 固件还活着 = 真失败。
    // 【fix22】先查 gatt.connected：连接已断开时 readValue 必然失败，不能据此判"固件已复位"——
    // 意外断链（固件 abort 后断链 / 射频断开）与成功复位（watchdog 断电重启）都会断链、无法区分。
    // 连接已断 → 视为"未确认活着"（返回 true，调用方不判 success），由 END 轮询的 SUCCESS/ABORTED
    // 明确状态或超时失败路径兜底——消除"断链=成功"假阳性（此前 DATA/END 阶段意外断链会被误报成功）。
    const probeFirmwareAlive = async () => {
      if (!otaChar.service.device.gatt.connected) return true;   // 连接已断：无法确认复位成功，保守不判活
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
    // 读固件端会话状态 ACK（OTA 特征 readValue）：GATT Read 是 request-response，所有平台语义
    // 一致可靠，是唯一确认通道（不依赖通知订阅/平台 write 语义）。
    // 返回 { progress: 已收包数, status: 0=idle/1=active/2=success/3=aborted, result: 失败原因码 }；
    // 读取失败/格式不符返回 null（调用方按"不可确认"处理，由 END 固件校验兜底）。
    // 超时保护：Android 实测 GATT Read 偶发挂起（fix3 实证可挂 30s，读挂起会把整个 OTA 拖死）。
    // 3s 未返回视为不可确认 → 跳过该次确认继续盲发，由 END 固件校验兜底。
    const withTimeout = (p, ms) => Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error('read timeout')), ms)),
    ]);
    const readAck = async () => {
      try {
        const v = await withTimeout(otaChar.readValue(), 3000);
        const raw = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
        if (raw.byteLength < 6 || raw[0] !== 0x08 || raw[1] !== 0xFF) return null;
        return {
          progress: raw[2] | (raw[3] << 8),
          status: raw[4],
          result: raw[5],
          // 【fix21】v1.2.37+ 固件：status==PREPARING 时 [6..7] = 预计预擦时长 X(ms)，
          // web 按 X+余量动态盲等（解耦前端写死 4500）；老固件此字段为 0
          eraseEstMs: (raw.byteLength >= 8) ? (raw[6] | (raw[7] << 8)) : 0,
        };
      } catch (e) { return null; }
    };

    // 【fix22】固件 abort 精确报错：readAck 稳定暴露 SOIL_OTA_RES（my_OtaData[5]），但此前前端
    // 只在 END 阶段消费——会话中途被固件 abort（包间隔超时/越界闸/逐包 CRC 不符等）时 readAck
    // 稳定返回 status=ABORTED(0x03)+原因码，前端却只当"进度没推进"处理，误报 OTA stalled。
    // 所有 readAck 消费点统一检查 ABORTED → 立即 throw 真实原因码，不白发剩余包。
    const throwIfDeviceAborted = (ack) => {
      if (ack !== null && ack.status === OTA.STATUS_ABORTED) {
        const why = OTA_RESULT_NAMES[ack.result] ?? `0x${ack.result.toString(16)}`;
        const err = new Error(`OTA aborted by device: ${why} (result=${ack.result})`);
        // 结构化附加信息：result = 固件原因码；stage = 拒绝发生的阶段。
        // stage='start' 表示 DATA 一包都没发（START 预检被拒，如低电 17），
        // 此时链路里没有任何在途写请求，调用方无需断链清队列 —— 断链只会丢掉
        // 原因提示、把用户踢回"未连接"，换好电池还得重新扫描设备。
        err.otaResult = ack.result;
        err.otaStage = otaDataStarted ? 'data' : 'start';
        throw err;
      }
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
      window.__otaStage = 'erase-wait';   // 【fix23】崩溃现场阶段标记：盲等/预擦窗口
      // 预擦状态上报（UX）：START 后固件整区预擦（~3.1s）+ web 盲等窗口合计 ~3.5s+，
      // 期间 UI 若仍显示 "Sending… 0%" 会误以为卡死。此处先切到 preparing 文案，
      // 覆盖盲等 + 擦除全程；DATA 第一包开始时 data 分支自然覆盖回 "Sending firmware…"。
      onProgress?.({ phase: 'preparing', percent: 0, sent: 0, total: fwSize });
      // START 激活确认（平台无关）：Android 的 writeValue 不等 ATT 响应，START 可能静默未达
      // （固件不激活 → DATA 全部被忽略，读轮询才能发现）。等队列消化后读会话状态：
      // 明确 idle(0x00) 才重发 START（≤2 次）；active(0x01) 即继续。DATA 尚未开始，
      // 重发 START 重置会话无代价。读不可用/异常终态不折腾，由窗口确认兜底。
      // 【fix19】预擦完成确认：不再等待 ready notify（iOS Safari Web Bluetooth notify 派发不可靠
      // ——v1.2.28/29/30 实测：固件 ready 已入 FIFO 发出，但盲等期间 iOS 不派发 notify（积压），
      // 直到下一次 GATT 操作（readAck）才批量派发；10s 窗口同样无效。notify 不靠谱就不依赖它）。
      // 统一：盲等覆盖预擦（~3.5-3.9s，含 v1.2.31 每扇区让出）→ readAck 确认 ACTIVE → 发 DATA。
      // 【fix21】动态盲等（解耦前端写死 4500 猜固件擦除时序，替代 fix19 固定盲等）：
      //   v1.2.37+ 固件 START 后置 PREPARING 但暂不擦（等首次 read 放闸才开始擦）——这里先
      //   sleep(250) 落位后 read #1：
      //     · PREPARING + X>0（新固件）：首次 read 在擦除开始前完成（不撞 flash 关中断窗口，
      //       Android 读挂起锁死不再发生），按 X+余量动态盲等；
      //     · PREPARING + X==0（老固件）：START 后已立即擦 → 回退旧固定盲等；
      //     · 读失败/其他状态：保守回退旧盲等（后续确认循环兜底 idle/active）。
      //   盲等结束后擦除应已完成，read #2 直接确认 ACTIVE。
      const blindForErase = async () => {
        await sleep(250);
        const ack0 = await readAck();
        // 【fix26】START 阶段固件已拒绝（低电 17 / pdu 9 等）：readAck 稳定返回
        // ABORTED+原因码，此前会被当成"读失败"落进下面的固定盲等，白等 4.5s
        // 才在下一轮确认里抛错（实测日志：12:48:40 拒绝 → 12:48:45 才断链）。
        // 这里先判终态，立即抛出真实原因，也避免在"本就没开始擦"的情况下继续等。
        throwIfDeviceAborted(ack0);
        if (ack0 !== null && ack0.status === OTA.STATUS_PREPARING && ack0.eraseEstMs > 0) {
          const blind = ack0.eraseEstMs + OTA.PRE_ERASE_EXTRA_MS;
          console.debug(`[OTA] erase est ${ack0.eraseEstMs}ms → blind ${blind}ms`);
          await sleep(blind);
          return;
        }
        if (ack0 !== null && ack0.status === OTA.STATUS_PREPARING) {
          console.debug('[OTA] legacy fw (no erase est), fallback fixed blind');
          await sleep(OTA.PRE_ERASE_BLIND_MS_FALLBACK);
          return;
        }
        console.warn('[OTA] erase probe read failed, fallback fixed blind');
        await sleep(OTA.PRE_ERASE_BLIND_MS_FALLBACK);
      };
      await blindForErase();
      // START 激活确认：idle → 重发 START（≤2 次）；preparing(0x04) = 目标区预擦中 → 轮询等待
      // 就绪；active → 继续发 DATA。预擦完成前发 DATA 会被固件丢弃（不推进序号），必须等 ACTIVE。
      let prepDeadline = Date.now() + 8000;         // 每次 START 发出后重置：预擦 ≤3.9s，8s 宽裕
      for (let attempt = 0; attempt < 2; attempt++) {
        const ack = await readAck();
        if (ack !== null && ack.status === OTA.STATUS_ACTIVE) break;   // 明确已激活 → 发 DATA
        if (ack === null) {                                            // 读失败/超时：多为栈瞬时问题
          console.warn('[OTA] START confirm read failed, retry after 1s');
          await sleep(1000);
          continue;                                                    // 重读；连续失败 2 次后固件必已就绪，安全进入 DATA
        }
        if (ack.status === OTA.STATUS_IDLE) {                          // 明确 idle：START 未达 → 重发
          console.warn(`[OTA] START not confirmed (idle), resend #${attempt + 1}`);
          await writeWithRetry(otaChar, startExt);
          await sleep(250);
          prepDeadline = Date.now() + 8000;                            // 重发后固件重新预擦：重置就绪 deadline
          await blindForErase();                                       // 重发后同样动态盲等（read #1 拿新固件的 X）
        } else if (ack.status === OTA.STATUS_PREPARING) {              // 预擦中 → 轮询等就绪
          onProgress?.({ phase: 'preparing', percent: 0, sent: 0, total: fwSize });   // 兜底幂等：保持 preparing 文案
          console.debug('[OTA] firmware erasing target, waiting ready...');
          while (Date.now() < prepDeadline) {
            await sleep(OTA.CONFIRM_DIGEST_MS);
            const again = await readAck();
            throwIfDeviceAborted(again);                                    // 【fix22】预擦轮询读到 ABORTED → 立即抛原因码
            if (again !== null && again.status === OTA.STATUS_ACTIVE) break;      // 就绪 → 发 DATA
            if (again !== null && again.status !== OTA.STATUS_PREPARING) break;   // 异常终态 → 不折腾
            if (again === null) await sleep(1000);                                // 读失败/超时：不退出，稍候重试
          }
          break;   // 无论超时/异常都继续（预擦 ≤3.9s < 8s deadline，固件必已就绪）
        } else {
          throwIfDeviceAborted(ack);   // 【fix22】START 确认读到 ABORTED → 立即抛原因码，不白发 409 包
          break;   // 其他异常终态（success 等）不折腾，后续流程会暴露
        }
      }
      // 【fix20】全程不依赖 notify：固件侧 ready/progress push 照发但 web 不订阅、不等待，
      // 预擦完成唯一凭据 = 上述 readAck 确认 ACTIVE。两平台 notify 派发均不可靠（iOS 盲等期间
      // 不派发、积压至 GATT 操作才批量派发——v1.2.28/29/30 实测 ready 已入 FIFO 仍 3.3s 才达、
      // 4s/10s 窗口均无效；Android 同样不稳），统一不用。

      // 2. DATA：整包 = adr_index(u16 LE) + 176 字节固件 + crc16(u16 LE，覆盖前 178 字节)。
      //    尾块不足 176 字节时补 0（补 0 部分不在 fwSize 内，设备最终 CRC32 校验不会计入）。
      //    确认通道统一用 readAck（GATT Read 是 request-response，全平台语义一致可靠），
      //    不再依赖进度通知流控：每发满 WINDOW(8) 包 → 小停让固件消化在途（flash 写+偶发擦除）
      //    → readAck 读固件真实进度 → 缺包重传 [realNext, i+1)。固件端对 idx<next 重复包忽略、
      //    idx==next 落盘，天然自愈。readAck 不可用（老固件）时跳过确认，由 END 固件校验兜底。
      const DATA_BYTES = OTA.BLOCK_BYTES;   // 每包固件字节数 = pdu_length = 176
      const totalBlocks = Math.ceil(fwSize / DATA_BYTES);
      otaDataStarted = true;        // 从此处起才可能残留写请求，失败后需要断链清队列
      window.__otaStage = 'data';   // 【fix23】崩溃现场阶段标记：DATA 传输
      let lastPercent = -1;
      let stallResends = 0;
      let lastRealNext = 0;   // 上一个窗口固件确认进度，用于判断"固件是否在推进"（连续无推进才判停滞）
      let ackedPdu = 0;       // 设备真实接收进度（readAck 确认）——Go-Back-N 回退基准：
                              //   发送指针 i 与 ackedPdu 的脱节量 >= WINDOW 即触发回退检查
      // 【fix20】无平台区分：统一固定单包间隔（Android 实测 writeValue 不等 ATT 响应、瞬间 resolve，
      // 循环过快会塞爆原生蓝牙队列 → 丢包率飙升；iOS 等 ATT 响应，附加间隔只是保险）。
      // 统一 PER_PACKET_GAP_MS=20（约一个连接事件）作为所有平台的唯一背压，不再按 UA 分支。
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
        // 单包节流（全平台统一）：固定间隔是物理层的唯一背压——Android 的 writeValue 不等 ATT
        // 响应、瞬间 resolve，Promise 返回≠包已上链路；iOS 真等 ATT 响应，间隔作附加保险。
        await sleep(OTA.PER_PACKET_GAP_MS);
        throwIfOtaAborted();   // 断连中止：残留流程立即止损，不等 write 失败

        const sent = Math.min(off + DATA_BYTES, fwSize);
        const percent = Math.round(sent * 100 / fwSize);
        if (percent !== lastPercent) {
          lastPercent = percent;
          onProgress?.({ phase: 'data', percent, sent, total: fwSize });
        }
      };

      for (let i = 0; i < totalBlocks; i++) {
        await sendPkt(i, false);
        // 窗口边界确认：每发满 WINDOW(8) 包停一次，readAck 拿固件真实进度；
        // 确认真的缺包则 Go-Back-N 回退发送指针重发（见下方 [GBN] 分支）。
        // 首个窗口跳过确认：Android 链路刚建立、写队列积压（writeValue 不等 ATT 响应，web 已发≠
        // 固件已收，实测首窗口 read 常读到 0——整个窗口还在 BLE 队列里）。等第二窗口边界再确认
        // （此时距 START 已 ~2.6s、队列已清、链路稳定），首窗口真丢的包由后续窗口确认/收尾补发兜底。
        if ((i + 1) % OTA.WINDOW === 0 && i + 1 < totalBlocks && i + 1 >= OTA.WINDOW * 2) {
          // 【fix20】窗口确认统一 readAck（不依赖 notify——两平台实测 notify 派发均不可靠）。
          // 先让固件消化在途窗口（flash 页写 + 偶发擦除）减少读早重读，再 readAck 拿真实进度。
          await sleep(OTA.CONFIRM_DIGEST_MS);
          const ack = await readAck();
          throwIfDeviceAborted(ack);        // 【fix22】窗口确认读到 ABORTED → 立即抛原因码
          if (ack === null) continue;      // read 不可用（瞬时失败）→ 跳过本窗口确认，END 校验兜底
          let confirmed = ack.progress;
          if (confirmed < i + 1) {
            // 落后：可能是写队列在途滞后（固件随后会收到），重读最多 3 次等追上；仍落后才判真缺。
            for (let r = 0; r < 3 && confirmed < i + 1; r++) {
              await sleep(OTA.CONFIRM_DIGEST_MS);
              const again = await readAck();
              throwIfDeviceAborted(again);  // 【fix22】重读期间同样检查 abort
              if (again === null) break;
              confirmed = again.progress;
            }
          }
          if (confirmed < i + 1) {
            // 【Go-Back-N 回退（丢包自愈）】设备确认进度落后于发送指针 = 空口丢包，
            // 或固件主动丢弃了错序包。不再原地正向补发 [confirmed, i+1)——重发包会与仍排在
            // 底层队列里的旧包交叠、越补越乱——而是把主循环发送指针整体回退到设备
            // 期望的包序号，由主循环按正常节奏（统一 PER_PACKET_GAP_MS 节流）重发。固件对 idx<next
            // 的重复包忽略、idx==next 落盘，天然自愈。回退期间进度条会短暂回退，属预期表现。
            console.warn(`[OTA][GBN] packet gap detected! device acked=${confirmed}, web at ${i + 1}, rewinding to ${confirmed}`);
            // 【熔断计数器不变量，重构时不得破坏】stallResends 只在"连续 >=3 个窗口固件确认进度
            // 零推进"时累积；任何一次有效推进（confirmed > lastRealNext，包括互不相干的新丢包
            // 回退点）都必须清零——否则 70KB 长升级中发生 4 次独立丢包就会被误判"无限死循环"
            // 冤枉中止 OTA。当前 if/else 两分支即该不变量的实现，合并或移除清零分支即为回归。
            // 在途包数必须在 i 回退赋值之前计算（回退后 i 不再代表发送前沿）。
            const inflight = (i + 1) - confirmed;   // 可能仍压在底层队列里的在途包数
            if (confirmed <= lastRealNext) {
              stallResends++;
              if (stallResends >= OTA.MAX_STALL_RESENDS) {
                throw new Error(`OTA stalled: firmware not confirming packets (acked=${confirmed}, sent=${i + 1})`);
              }
            } else {
              stallResends = 0;   // 固件在推进（只是继续丢），重置停滞计数
            }
            lastRealNext = confirmed;
            ackedPdu = confirmed;
            i = confirmed - 1;    // 回退发送指针：for 的 i++ 后恰好从设备期望的包序号重新发送
            // 动态排空等待：底层可能还压着 [confirmed, i] 的在途包（写不等 ATT 响应、
            // ~PER_PACKET_GAP_MS/包排空）。按在途包数换算等待，确保旧队列彻底死寂后再灌入
            // 重传包——否则重发包被追加到队列尾，旧包空跑一遍浪费空口带宽（固件 ignore，安全但不经济）。
            await sleep(Math.max(OTA.GBN_REWIND_SETTLE_MS, inflight * OTA.PER_PACKET_GAP_MS));
            continue;
          }
          // 无缺包（或在途滞后已追上）：设备已确认收齐当前窗口，同步回退基准
          stallResends = 0;
          ackedPdu = Math.max(ackedPdu, confirmed);
          lastRealNext = confirmed;
        }
      }

      // 3. 收尾：readAck 确认全部收到，缺则补尾（最多 3 轮），然后 END。
      //    readAck 不可用（瞬时失败）时跳过补尾，由 END 固件校验兜底。
      await sleep(OTA.CONFIRM_DIGEST_MS);
      for (let attempt = 0; attempt < 3; attempt++) {
        const ack = await readAck();
        throwIfDeviceAborted(ack);        // 【fix22】补尾确认读到 ABORTED → 立即抛原因码
        if (ack === null) break;
        const realNext = ack.progress;
        if (realNext >= totalBlocks) break;   // 全部收到
        console.warn(`[OTA][RTX] tail: device acked=${realNext}/${totalBlocks}, resending tail`);
        for (let j = realNext; j < totalBlocks; j++) await sendPkt(j, true);
        await sleep(OTA.CONFIRM_DIGEST_MS);
      }
      // 3. END：CMD_OTA_END(0xFF02) + adr_index_max + 其按位取反，共 6 字节。
      //    仍用带响应写发出；Android 上 writeValue 不等响应可能丢 END，由下一步
      //    readAck 轮询发现（仍 active 且收满）并重发 END（≤3 次）。
      const maxIdx = totalBlocks - 1;
      window.__otaStage = 'end';   // 【fix23】崩溃现场阶段标记：END 发送
      onProgress?.({ phase: 'end', percent: 100, sent: fwSize, total: fwSize });
      const endPkt = Uint8Array.of(
        0x02, 0xFF,
        maxIdx & 0xff, (maxIdx >> 8) & 0xff,
        (~maxIdx) & 0xff, ((~maxIdx) >> 8) & 0xff,
      );
      await writeWithRetry(otaChar, endPkt);

      // 4. END 确认（平台无关，readAck 轮询）：固件 END 校验通过 → status=SUCCESS(0x02) 判成功；
      //    失败 → status=ABORTED(0x03)+原因码 判失败（精确报错）；仍 active 且收满 → END 未生效
      //    （Android 丢 END）→ 重发 END；轮询读失败（固件已复位断链）→ probe 无响应双保险判成功。
      //    完全替代"等 result 通知 / 平台断链语义"——GATT Read 是唯一确认通道。
      window.__otaStage = 'end-verify';   // 【fix23】崩溃现场阶段标记：END 轮询确认
      const endDeadline = Date.now() + OTA.END_TIMEOUT_MS;
      let endState = null;          // 'success' | { fail: resultCode } | null（未决）
      let endResends = 0;
      let sawVerifying = false;     // 【fix24/N1】END 受理后是否读到过 VERIFYING（校验中）——此后读失败=固件复位断链=成功
      while (endState === null && Date.now() < endDeadline) {
        await sleep(200);
        const ack = await readAck();
        if (ack === null) {
          // 【fix24/N1 修订】不单凭"读失败"判成功：GATT Read 瞬时异常（栈抖动/超时）在
          // VERIFYING 窗口内一次失败即误判成功，而固件随后校验失败会 abort（不断链、仍可读
          // ABORTED 原因码）→ 假阳性回归。收窄为最强凭据：见过 VERIFYING **且连接已断**
          // （固件成功路径的终点 = watchdog 复位断链；abort 路径不断链）才判成功；
          // 连接还在 → 视为瞬时读失败，继续轮询重读。未见过 VERIFYING 仍走 probe 双保险。
          if (sawVerifying && !otaChar.service.device.gatt.connected) {
            endState = 'success';
          } else if (!sawVerifying) {
            const alive = await probeFirmwareAlive();
            if (!alive) endState = 'success';
          }
          // sawVerifying && 连接还在：瞬时读失败 → 不判，循环 200ms 后重读
        } else if (ack.status === OTA.STATUS_SUCCESS) {
          endState = 'success';                        // 固件明确确认：校验通过 + boot mark 已切
        } else if (ack.status === OTA.STATUS_ABORTED) {
          endState = { fail: ack.result };             // 固件失败终态（SOIL_OTA_RES 原因码）
        } else if (ack.status === OTA.STATUS_VERIFYING) {
          // END 已受理、固件主循环分块回读校验中（~1-2s）：继续轮询等终态，不重发 END
          sawVerifying = true;
        } else if (ack.status === OTA.STATUS_ACTIVE && ack.progress >= totalBlocks) {
          // END 未生效：固件仍 active 且收满 → 重发 END（≤3 次；重复 END 固件 s_ota_active=0 忽略，无害）
          if (endResends < 3) {
            endResends++;
            console.warn(`[OTA] END not effective (status=active, progress=${ack.progress}), resend #${endResends}`);
            await writeWithRetry(otaChar, endPkt);
          }
        }
        // status=IDLE 或 active 但进度未满：异常/收尾未完成 → 继续轮询观察
      }
      if (endState === 'success') {
        return { ok: true, result: 0x00, message: 'OTA succeeded (firmware rebooted)' };
      }
      if (endState && endState.fail !== undefined) {
        const fname = OTA_RESULT_NAMES[endState.fail] || ('code ' + endState.fail);
        return { ok: false, result: endState.fail, message: `OTA failed: ${fname} (0x${endState.fail.toString(16).padStart(2, '0')})` };
      }
      // 超时未决：probe 最终判定（无响应 = 已复位 = 成功；正常响应 = 固件还在 = 真失败）
      // 【fix24/N1 修订】与轮询内同凭据：见过 VERIFYING 且连接已断 → 复位成功。
      // 否则 probe 对断链"保守不判活"返回 true → 把刚完成的成功误报成 OTA timeout（假阴性）。
      if (sawVerifying && !otaChar.service.device.gatt.connected) {
        return { ok: true, result: 0x00, message: 'OTA succeeded (firmware rebooted)' };
      }
      const alive = await probeFirmwareAlive();
      if (!alive) {
        console.warn('[OTA] END timeout but firmware not responding (rebooted), treat as success');
        return { ok: true, result: 0x00, message: 'OTA succeeded (firmware rebooted)' };
      }
      return { ok: false, result: 0, message: 'OTA timeout waiting for device result (firmware still alive)' };
    } finally {
      otaDevice.removeEventListener('gattserverdisconnected', abortOtaSession);
    }
  }

  return {
    UUIDS,
    DEVICE_NAME,
    parsePacket,
    parseDailyPacket,
    parseDaily30Packet,
    parseDaily30ExtPacket,
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
    parseHistoryBlockPacket,
    readHistoryBlock,
    fetchFullHistory,
    fetchHistoryNewestFirst,
    readTempOffset,
    sendTempOffset,
    readCalibStatus,
    readDeviceName,
    sendDeviceName,
    performOta,
  };
})();