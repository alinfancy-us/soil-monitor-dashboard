/**
 * SoilPulse BLE Protocol & Service Module
 */
const BLEProtocol = (() => {
  'use strict';

  // 集中配置统一取自 page/js/config.js，方便后续维护管理
  const { DEVICE_NAME_PREFIX, UUIDS, RESET_MAGIC, FACTORY_RESET_MAGIC, HUM_CALIB_CMD, REFRESH_CMD, TEMP_OFFSET } = SoilPulseConfig;
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
  /** 连接阶段超时（毫秒）：选完设备后，gatt.connect + 服务/特征发现应在 5s 内完成。
   *  蓝牙不可用 / 设备处于睡眠时这一步会挂起，超时后由 app.js 复位 UI。 */
  const CONNECT_TIMEOUT_MS = 5000;

  /**
   * 阶段1：仅弹出设备选择器（不设超时——用户挑设备时长不受限）。
   * @returns {Promise<BluetoothDevice>}
   */
  async function requestSoilDevice() {
    // 按广播服务 UUID(0xFFE0) + 名字前缀 组合过滤设备（详见下方 filters 注释）
    // 前提：固件广播包含 Complete List of 16-bit Service UUIDs 段（见 bth_soil_sensor.h 的 SOIL_ADV_SERVICE_UUID16）
    return navigator.bluetooth.requestDevice({
      filters: [
        // 同一 filter 对象内多条件为 AND：广播服务 UUID(0xFFE0) 匹配 + 名字前缀，
        // 排除周围其他同样使用 0xFFE0 的设备（HM-10/JDY 类模块的经典 UUID），避免选择器噪音。
        // 注意：固件改名时必须保留 DEVICE_NAME_PREFIX 前缀，并同步维护 config.js 的 DEVICE_NAME_PREFIX，
        // 否则该过滤条件将匹配不到设备（这是配置耦合，与系统蓝牙缓存无关）。
        { services: [UUIDS.SERVICE], namePrefix: DEVICE_NAME_PREFIX }
      ],
      optionalServices: [UUIDS.OTA_SERVICE, UUIDS.DIS_SERVICE]
    });
  }

  /**
   * 阶段2 主体：gatt.connect + 服务/特征发现 + 时间同步 + 订阅 Notify（原 connectDevice 内容）。
   * @param {BluetoothDevice} device
   */
  async function finishConnectInner(device, onNotification, onDisconnect) {
    device.addEventListener('gattserverdisconnected', onDisconnect);

    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(UUIDS.SERVICE);
    const dataChar = await service.getCharacteristic(UUIDS.DATA_CHAR);
    const timeChar = await service.getCharacteristic(UUIDS.TIME_CHAR);

    // 同步时间戳
    const now = Math.floor(Date.now() / 1000);
    await timeChar.writeValue(Uint8Array.of(
      now & 0xff, (now >>> 8) & 0xff, (now >>> 16) & 0xff, (now >>> 24) & 0xff
    ));

    // 监听 Notify
    if (dataChar.properties.notify || dataChar.properties.indicate) {
      dataChar.addEventListener('characteristicvaluechanged', (e) => {
        const val = e.target.value;
        onNotification(parsePacket(val), hexDump(val));
      });
      await dataChar.startNotifications();
    }

    // 日均值特征（0xFFE3），Read Only；生产固件必带，读取失败不影响主流程
    let dailyChar = null;
    try {
      dailyChar = await service.getCharacteristic(UUIDS.DAILY_CHAR);
    } catch (e) {
      console.warn('[BLE] daily characteristic not available:', e);
    }


    // Clear/Reset 写特征（0xFFE5），生产固件必带；获取失败不影响主流程
    let resetChar = null;
    try {
      resetChar = await service.getCharacteristic(UUIDS.RESET_CHAR);
    } catch (e) {
      console.warn('[BLE] reset characteristic not available:', e);
    }

    // 湿度两点校准写特征（0xFFE6），生产固件必带；获取失败不影响主流程（仅禁用校准按钮）
    let calibChar = null;
    try {
      calibChar = await service.getCharacteristic(UUIDS.CALIB_CHAR);
    } catch (e) {
      console.warn('[BLE] calibration characteristic not available:', e);
    }

    // 立即重新测量写特征（0xFFE7），生产固件必带；获取失败不影响主流程（仅禁用 refresh 按钮）
    let refreshChar = null;
    try {
      refreshChar = await service.getCharacteristic(UUIDS.REFRESH_CHAR);
    } catch (e) {
      console.warn('[BLE] refresh characteristic not available:', e);
    }

    // 温度偏移校准特征（0xFFE8，Read | Write，1 字节 s8 = 0.1℃）；旧固件可能没有，获取失败不影响主流程
    let tempOffsetChar = null;
    try {
      tempOffsetChar = await service.getCharacteristic(UUIDS.TEMP_OFFSET_CHAR);
    } catch (e) {
      console.warn('[BLE] temperature offset characteristic not available:', e);
    }

    // Telink OTA 升级特征（128bit UUID，仅 BLE_OTA_SERVER_ENABLE=1 的固件才有）；
    // 获取失败不影响主流程（仅禁用 firmware update 按钮）
    let otaChar = null;
    try {
      const otaService = await server.getPrimaryService(UUIDS.OTA_SERVICE);
      otaChar = await otaService.getCharacteristic(UUIDS.OTA_CHAR);
    } catch (e) {
      console.warn('[BLE] OTA characteristic not available:', e);
    }

    // 读取标准 DIS 服务的固件版本（Firmware Revision String），用于连接后新版本检测；失败不影响主流程
    let fwVersion = null;
    try {
      const dis = await server.getPrimaryService(UUIDS.DIS_SERVICE);
      const fwRevChar = await dis.getCharacteristic(UUIDS.DIS_FW_REV_CHAR);
      fwVersion = new TextDecoder().decode(await fwRevChar.readValue()).split(String.fromCharCode(0))[0].trim();
    } catch (e) {
      console.warn("[BLE] firmware revision not available:", e);
    }

    return { device, dataChar, dailyChar, resetChar, calibChar, refreshChar, tempOffsetChar, otaChar, fwVersion };
  }

  /**
   * 阶段2 的“带 5s 超时”入口：对内部逻辑整体做 Promise.race。
   * 超时抛 __CONNECT_TIMEOUT__，由 app.js 识别并复位 UI（同时防“迟到成功”成幽灵连接）。
   * @param {BluetoothDevice} device
   */
  async function finishConnect(device, onNotification, onDisconnect) {
    let timedOut = false;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { timedOut = true; reject(new Error('CONNECT_TIMEOUT')); }, CONNECT_TIMEOUT_MS);
    });

    const inner = finishConnectInner(device, onNotification, onDisconnect);
    // 超时后又“迟到成功”（例如设备在 5s 后才醒来并连上）：主动断开这次孤儿连接，
    // 防止出现“UI 显示未连接、设备却已连上”的幽灵状态。晚期失败也一并吞掉，避免未处理 rejection。
    inner.then(() => {
      if (timedOut) {
        try { device.gatt.disconnect(); } catch (_) {}
      }
    }).catch(() => {});

    try {
      return await Promise.race([inner, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 兼容入口：顺序执行 选设备 -> 带超时连接。供既有调用方（如 OTA 重试）继续使用。
   */
  async function connectDevice(onNotification, onDisconnect) {
    const device = await requestSoilDevice();
    return finishConnect(device, onNotification, onDisconnect);
  }

  /**
   * 任务9：向 0xFFE5 写入 4 字节魔术字 "CLR1"，请求设备清空历史/日均值 RAM 缓存
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
    return new DataView(val.buffer, val.byteOffset, val.byteLength).getInt8(0);
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
    const v = new Uint8Array(1);
    new DataView(v.buffer).setInt8(0, clamped);
    await tempOffsetChar.writeValue(v);
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
  async function sendRefresh(refreshChar) {
    if (!refreshChar) {
      throw new Error('refresh characteristic unavailable');
    }
    await refreshChar.writeValue(REFRESH_CMD);
  }

  ////////////////////////// Telink BLE OTA 升级（legacy 协议） //////////////////////////
  // 协议与 SDK 内参考实现 vendor/ble_master_kma_dongle/blm_ota.c 严格对齐：
  //   START : 2 字节 0x01 0xFF（CMD_OTA_START=0xFF01 小端）
  //   DATA  : 20 字节 = adr_index(u16 LE，固件偏移>>4) + 16 字节固件 + crc16(u16 LE，覆盖前 18 字节)
  //   END   : 6 字节 = 0x02 0xFF + adr_index_max(u16) + 其按位取反(u16)
  //   PROG  : 设备通知 {0x08 0xFF + u16 已收包数}（CMD_OTA_SCHEDULE_PDU_NUM），
  //           仅当固件调用了 blc_ota_setOtaScheduleIndication_by_pduNum 才会上报；
  //           协议栈默认不回任何逐包通知，因此不能把“收到通知”当作必然事件
  //   RESULT: 设备通知 {0x06 0xFF result rsv}（CMD_OTA_RESULT），校验成功后设备自动重启断链
  // 固件 bin 头部 0x18 偏移存放固件长度（Telink bin 格式），发送字节数以此为准
  const OTA = {
    FW_SIZE_MAX: 124 * 1024,   // SDK 默认 ota_firmware_max_size（新固件存放在 flash 0x20000 起 124K 内）
    BLOCK_BYTES: 16,           // legacy 协议固定 16 字节/包
    WINDOW: 32,                // 滑动窗口：允许的最大在途未确认包数（= 固件侧 32 包上报粒度；过大如 256 会压爆设备 RX 缓冲导致丢包序列错误）
    SCHEDULE_GRANULARITY: 32,    // 固件 blc_ota_setOtaScheduleIndication_by_pduNum(32) 的上报粒度，收尾等待按整批对齐
    PROGRESS_TIMEOUT_MS: 2000, // 等待设备进度通知的超时（需覆盖跨 4K 扇区擦除耗时）
    END_TIMEOUT_MS: 10000,     // END 后等待结果通知 / 设备重启断链的超时
    FREERUN_BURST: 4,          // 无进度反馈时的定速发送：每发几包让出一次执行权
    FREERUN_GAP_MS: 6,         // 定速发送的间隔（约 4 包/6ms ≈ 10KB/s，贴近一个连接事件能吃下的量，避免压垮设备断链）
    WRITE_RETRY_MAX: 6,        // GATT busy 等瞬时错误的重试次数
    WRITE_RETRY_GAP_MS: 16,    // 重试基础退避时间
  };
  const OTA_CMD = { START: 0xFF01, END: 0xFF02, RESULT: 0xFF06 };
  const OTA_RESULT_NAMES = {
    0x00: 'success',
    0x01: 'packet sequence error',
    0x02: 'invalid packet',
    0x03: 'packet CRC error',
    0x04: 'flash write error',
    0x05: 'data incomplete',
    0x06: 'flow error',
    0x07: 'firmware CRC error',
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
          await otaChar.writeValueWithoutResponse(data);
        } else {
          await otaChar.writeValue(data);
        }
        return;
      } catch (e) {
        lastErr = e;
        const msg = String(e?.message || e || '').toLowerCase();
        // 中文：链路已断开是终态错误，不可重试，直接抛出让上层走断链恢复流程
        const disconnected = msg.includes('disconnect') || msg.includes('gatt server is disconnected');
        const retryable = !disconnected && (msg.includes('already in progress') || msg.includes('busy') || msg.includes('operation failed'));
        if (!retryable || i === OTA.WRITE_RETRY_MAX - 1) {
          throw e;
        }
        await sleep(OTA.WRITE_RETRY_GAP_MS * (i + 1));
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

      // 1. START：CMD_OTA_START(0xFF01) 小端 2 字节
      await writeWithRetry(otaChar, Uint8Array.of(0x01, 0xFF), false);

      // 2. DATA：每包 20 字节 = adr_index(u16 LE) + 16 字节固件 + crc16(u16 LE，覆盖前 18 字节)。
      //    尾块不足 16 字节时补 0（补 0 部分不在 fwSize 内，设备最终 CRC32 校验不会计入）。
      //    滑动窗口：仅当在途未确认包数超过 OTA.WINDOW 时才等设备进度通知；
      //    若设备根本不上报进度（旧固件未开 blc_ota_setOtaScheduleIndication_by_pduNum），
      //    首次等待超时后降级为定速发送：没有背压时若全速盲发，设备来不及处理会直接监督超时断链。
      const totalBlocks = Math.ceil(fwSize / OTA.BLOCK_BYTES);
      let flowControl = true;
      let lastPercent = -1;
      for (let i = 0; i < totalBlocks; i++) {
        if (flowControl) {
          if (i - ackedPdu >= OTA.WINDOW) {
            const ok = await waitProgress(i - OTA.WINDOW + 1, OTA.PROGRESS_TIMEOUT_MS);
            if (!ok && ackedPdu === 0) flowControl = false;
          }
        } else if (i % OTA.FREERUN_BURST === 0) {
          await sleep(OTA.FREERUN_GAP_MS);
        }

        const off = i * OTA.BLOCK_BYTES;
        const pkt = new Uint8Array(20);
        pkt[0] = i & 0xff;
        pkt[1] = (i >> 8) & 0xff;
        const n = Math.min(OTA.BLOCK_BYTES, fwSize - off);
        pkt.set(bytes.subarray(off, off + n), 2);
        const crc = telinkCrc16(pkt, 18);
        pkt[18] = crc & 0xff;
        pkt[19] = (crc >> 8) & 0xff;
        /* 中文：同一特征写操作必须串行，避免 WebKit 报 GATT busy */
        await writeWithRetry(otaChar, pkt, true);

        const sent = Math.min(off + OTA.BLOCK_BYTES, fwSize);
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
      const maxIdx = totalBlocks - 1;
      onProgress?.({ phase: 'end', percent: 100, sent: fwSize, total: fwSize });
      await writeWithRetry(otaChar, Uint8Array.of(
        0x02, 0xFF,
        maxIdx & 0xff, (maxIdx >> 8) & 0xff,
        (~maxIdx) & 0xff, ((~maxIdx) >> 8) & 0xff,
      ), false);

      // 4. 等待设备结果通知（成功后设备自动重启断链）
      const result = await waitResult();
      if (result === null) {
        return { ok: false, result, message: 'OTA timeout waiting for device result (device may have rebooted)' };
      }
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
    DEVICE_NAME_PREFIX,
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
    readTempOffset,
    sendTempOffset,
    performOta,
  };
})();