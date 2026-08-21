/**
 * FloraSense BLE Protocol & Service Module
 */
const BLEProtocol = (() => {
  'use strict';

  // 集中配置统一取自 page/js/config.js，方便后续维护管理
  const { DEVICE_NAME_PREFIX, UUIDS, RESET_MAGIC, HUM_CALIB_CMD, REFRESH_CMD } = FloraSenseConfig;
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

  /**
   * 解析 0xFFE4 调试功耗快照：13 字节
   * mcu_active_us(u32) adv_window_us(u32) sleep_s(u16) battery_mv(u16) sample_period_s(u8)
   */
  function parsePowerSnapshot(view) {
    if (view.byteLength < 13) {
      throw new Error(`Invalid power snapshot length: ${view.byteLength} (expected 13)`);
    }
    return {
      mcuActiveUs: view.getUint32(0, true),
      advWindowUs: view.getUint32(4, true),
      sleepS: view.getUint16(8, true),
      batteryMv: view.getUint16(10, true),
      samplePeriodS: view.getUint8(12),
    };
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
  /**
   * 建立蓝牙连接（限制仅过滤 alinfancy 开头的设备）
   */
  async function connectDevice(onNotification, onDisconnect) {
    // 限制名称前缀为 alinfancy，并传入 128 位格式的 Service UUID
    const device = await navigator.bluetooth.requestDevice({
      filters: [
        { namePrefix: DEVICE_NAME_PREFIX }
      ],
      optionalServices: [UUIDS.SERVICE]
    });

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

    // 调试功耗特征（0xFFE4），仅 SOIL_POWER_LOG_EN=1 的调试固件才有，读取失败静默忽略
    let powerChar = null;
    try {
      powerChar = await service.getCharacteristic(UUIDS.POWER_CHAR);
    } catch (e) {
      // 生产固件裁掉该特征是正常情况，不打印告警
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

    return { device, dataChar, dailyChar, powerChar, resetChar, calibChar, refreshChar };
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

  return {
    UUIDS,
    DEVICE_NAME_PREFIX,
    parsePacket,
    parseDailyPacket,
    parsePowerSnapshot,
    hexDump,
    connectDevice,
    sendReset,
    sendHumCalib,
    sendRefresh,
  };
})();