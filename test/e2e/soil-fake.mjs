/**
 * SoilPulse 假外设：基于 Chrome DevTools Protocol 的 BluetoothEmulation 域，
 * 把整棵 GATT 树 + 每次读响应 + 每次写入全部脚本化。
 *
 * 为什么不用 LightBlue / nRF Connect：那些是 GUI，没法进 CI；而 CDP 这套是
 * 浏览器内建的「虚拟外设」，网页侧完全感知不到区别（navigator.bluetooth 照常工作）。
 *
 * 协议格式严格对齐 page/js/ble-protocol.js：
 *   记录 9B = ts(u32LE) temp(i16LE/100) hum(u16LE/100) batt(u8)
 *   0xFFEC 历史块 183B = total(u8) offset(u8) count(u8) + 20×9B
 *   0xFFED 30天日均 184B = count(u8) baseDay(u16LE 自2000-01-01) tzCode(u8) + 30×6B
 *   0xFFE3 7天日均 71B = count(u8) + 7×{dateEpoch(u32) temp(i16/100) hum(u16/100) batt(u8) 保留(u8)}
 *   readAck 16B = 0x08 0xFF progress(u16LE) status(1) result(1) + 保留
 *
 * ⚠ 本文件只存在于 test/，不被 index.html 引用，也不会进 dist 发布包。
 */
import { EMULATED_SERVICES, propsToCdp, declaredValueLen } from './lib/gatt-tree.mjs';

/** 常用 UUID 常量（服务 UUID 与 OTA 特征由树派生，避免两处硬编码） */
export const UUIDS = {
  SERVICE: EMULATED_SERVICES.find((s) => s.name === 'Soil Sensor')?.uuid,
  OTA_SERVICE: EMULATED_SERVICES.find((s) => s.name === 'Telink OTA')?.uuid,
  DIS_SERVICE: EMULATED_SERVICES.find((s) => s.name === 'Device Information')?.uuid,
  DATA_CHAR: '0000ffe1-0000-1000-8000-00805f9b34fb',
  TIME_CHAR: '0000ffe2-0000-1000-8000-00805f9b34fb',
  DAILY_CHAR: '0000ffe3-0000-1000-8000-00805f9b34fb',
  RESET_CHAR: '0000ffe5-0000-1000-8000-00805f9b34fb',
  CALIB_CHAR: '0000ffe6-0000-1000-8000-00805f9b34fb',
  REFRESH_CHAR: '0000ffe7-0000-1000-8000-00805f9b34fb',
  TEMP_OFFSET_CHAR: '0000ffe8-0000-1000-8000-00805f9b34fb',
  CALIB_STATUS_CHAR: '0000ffe9-0000-1000-8000-00805f9b34fb',
  DEV_NAME_CHAR: '0000ffea-0000-1000-8000-00805f9b34fb',
  LATEST_CHAR: '0000ffeb-0000-1000-8000-00805f9b34fb',
  HISTORY_BLK_CHAR: '0000ffec-0000-1000-8000-00805f9b34fb',
  DAILY30_CHAR: '0000ffed-0000-1000-8000-00805f9b34fb',
  DAILY30_EXT_CHAR: '0000ffee-0000-1000-8000-00805f9b34fb',
  OTA_CHAR: EMULATED_SERVICES.find((s) => s.name === 'Telink OTA')?.characteristics[0]?.uuid,
  DIS_FW_REV_CHAR: '00002a26-0000-1000-8000-00805f9b34fb',
  DIS_MODEL_CHAR: '00002a24-0000-1000-8000-00805f9b34fb',
};

const CCCD_UUID = '00002902-0000-1000-8000-00805f9b34fb';

// ---- 协议编码 ----------------------------------------------------------------

export function encodeRecord(r) {
  const b = Buffer.alloc(9);
  b.writeUInt32LE(r.timestamp >>> 0, 0);
  b.writeInt16LE(Math.round(r.temp * 100), 4);
  b.writeUInt16LE(Math.round(r.hum * 100), 6);
  b.writeUInt8(r.batt & 0xff, 8);
  return b;
}

/** 0xFFE1 老协议包：count + 5×9B */
export function encodePacket(records) {
  const b = Buffer.alloc(46);
  const n = Math.min(records.length, 5);
  b.writeUInt8(n, 0);
  records.slice(0, n).forEach((r, i) => encodeRecord(r).copy(b, 1 + i * 9));
  return b;
}

/** 0xFFEC 历史块：total + offset + count + 20×9B */
export function encodeHistoryBlock(all, offset, count) {
  const b = Buffer.alloc(183);
  const slice = all.slice(offset, offset + Math.min(count, 20));
  b.writeUInt8(all.length, 0);
  b.writeUInt8(offset, 1);
  b.writeUInt8(slice.length, 2);
  slice.forEach((r, i) => encodeRecord(r).copy(b, 3 + i * 9));
  return b;
}

/** 0xFFED 30 天日均：count + baseDay(u16) + tzCode + 30×6B */
export function encodeDaily30(records, tzMin = -420) {
  const DAY_ORIGIN = 10957;                     // 2000-01-01
  const tzCode = Math.round((tzMin + 840) / 15) + 1;
  const b = Buffer.alloc(184);
  const days = records.map((r) => Math.floor(r.dateEpoch / 86400));
  const baseDay = days.length ? Math.min(...days) : Math.floor(Date.now() / 86400000);
  b.writeUInt8(Math.min(records.length, 30), 0);
  b.writeUInt16LE(baseDay - DAY_ORIGIN, 1);
  b.writeUInt8(tzCode, 3);
  records.slice(0, 30).forEach((r, i) => {
    const off = 4 + i * 6;
    b.writeUInt16LE(Math.floor(r.dateEpoch / 86400) - baseDay, off);
    b.writeInt16LE(Math.round(r.temp * 100), off + 2);
    b.writeUInt8(Math.round(r.hum), off + 4);
    b.writeUInt8(r.battPercent & 0xff, off + 5);
  });
  return b;
}

/**
 * 0xFFE3 7 天日均：count + 7×10B
 * ⚠ dateEpoch 必须与固件同式：本地当天 0 点 = 天索引×86400 + 时区偏移×60
 *   （soil_daily.c 明确要求两路同式，否则 0xFFE3 与 0xFFED 差一个时区、
 *   同一天会在合并后出现两条，图上日期重复）。取最近 7 天（RAM 环语义）。
 */
export function encodeDaily7(records, tzMin = -420) {
  const b = Buffer.alloc(71);
  const slice = records.slice(Math.max(0, records.length - 7));
  const tz = tzMin * 60;
  b.writeUInt8(slice.length, 0);
  slice.forEach((r, i) => {
    const off = 1 + i * 10;
    b.writeUInt32LE((Math.floor(r.dateEpoch / 86400) * 86400 + tz) >>> 0, off);
    b.writeInt16LE(Math.round(r.temp * 100), off + 4);
    b.writeUInt16LE(Math.round(r.hum * 100), off + 6);
    b.writeUInt8(r.battPercent & 0xff, off + 8);
  });
  return b;
}

/**
 * 0xFFEE 30 天温度极值：count + baseDay(u16) + tzCode + 30×4B
 * 每条 4B = day_off(u16LE) + tempMin(delta/0.1℃, s8) + tempMax(s8)，
 * 包头（baseDay/tzCode）与 0xFFED 完全同义 —— 前端正是靠这个对齐两包。
 * 值 = 相对当日均值的 0.1℃ 偏移（min ≤ 0、max ≥ 0），0x80 = 该天无极值。
 */
export function encodeDaily30Ext(records, tzMin = -420) {
  const DAY_ORIGIN = 10957;
  const EXT_UNKNOWN = 0x80;
  const tzCode = Math.round((tzMin + 840) / 15) + 1;
  const b = Buffer.alloc(124, EXT_UNKNOWN);        // 先全填 0x80：未写的槽位天然是"未知"
  const days = records.map((r) => Math.floor(r.dateEpoch / 86400));
  const baseDay = days.length ? Math.min(...days) : Math.floor(Date.now() / 86400000);
  b.writeUInt8(Math.min(records.length, 30), 0);
  b.writeUInt16LE(baseDay - DAY_ORIGIN, 1);
  b.writeUInt8(tzCode, 3);
  records.slice(0, 30).forEach((r, i) => {
    const off = 4 + i * 4;
    b.writeUInt16LE(Math.floor(r.dateEpoch / 86400) - baseDay, off);
    const d10 = (abs, fallback) => {
      if (!Number.isFinite(abs)) return fallback;
      // s8 有符号：区间 [-127, 127]，即相对均值 ±12.7℃；超界按固件同款钳位
      const v = Math.round((abs - r.temp) * 10);
      return Math.max(-127, Math.min(127, v));
    };
    b.writeInt8(d10(r.tempMin, EXT_UNKNOWN - 256), off + 2);   // Buffer.writeInt8 需要 -128
    b.writeInt8(d10(r.tempMax, EXT_UNKNOWN - 256), off + 3);
  });
  return b;
}

// ---- 假外设 ------------------------------------------------------------------

export class FakeSoilDevice {
  constructor(client, opts = {}) {
    this.client = client;
    this.address = opts.address || 'C0:FF:EE:00:00:01';
    this.name = opts.name || 'SoilPulse-E2E';
    this.records = [];            // 24h 环（时间升序）
    this.daily = [];              // 日均（dateEpoch 升序）
    this.fwRev = opts.fwRev || '1.0.0';
    this.modelNumber = opts.modelNumber || 'SP-100';
    this.devName = opts.name || 'SoilPulse-E2E';
    this.calibStatus = 0;
    this.tempOffset = 0;
    this.tzMin = opts.tzMin ?? -420;   // 设备时区（0xFFE3/0xFFED/0xFFEE 共用）；默认 PDT，预览可传 480（UTC+8）
    this.window = { offset: 0, count: 20 };     // 0xFFEC 最近一次窗口写
    this.readAck = Buffer.from([0x08, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    this.writes = [];             // 所有写入留痕（uuid/data/ts）
    this.reads = [];              // 所有读取留痕
    this.lengthMismatch = [];     // 读值长度与固件声明不一致的留痕
    this.measureSeq = 0;          // 0xFFEB 的 measure_seq（每次测量 +1）
    this.resetMagic = Buffer.from('CLR1', 'ascii');
    this.autoDeviceEffects = opts.autoDeviceEffects !== false;  // 刷新/清空是否带固件副作用
    this.onWrite = opts.onWrite || null;
    this.delayRead = opts.delayRead || {};      // { uuid: ms } 模拟读挂起
    this.idToUuid = new Map();
    this.uuidToId = new Map();
    this.descToChar = new Map();  // descriptorId → 所属特征的 uuid
  }

  // ---- 数据装配 ----

  /** 造 n 条 600s 间隔的 24h 记录（结束于 now，可留断档） */
  seedHistory(n = 144, { step = 600, gapFromH = 13, gapToH = 10, endAt = null } = {}) {
    const now = endAt || Math.floor(Date.now() / 1000);
    const out = [];
    for (let i = 0; i < n; i++) {
      const ts = now - (n - 1 - i) * step;
      if (gapFromH > gapToH && ts > now - gapFromH * 3600 && ts < now - gapToH * 3600) continue;
      const phase = ((ts % 86400) / 86400) * Math.PI * 2;
      out.push({
        timestamp: ts,
        temp: Math.round((21 + 4.2 * Math.sin(phase - 1.6)) * 100) / 100,
        hum: Math.round((55 + 12 * Math.sin(phase - 0.4)) * 100) / 100,
        batt: 92 - Math.floor(i / 48),
      });
    }
    this.records = out;
    return out;
  }

  /**
   * 造 n 天日均。tempMin/tempMax 是当日真实极值（绝对温度，℃）：
   * 默认按"均值 ± 5~9℃"生成日较差，可用 frostAt/heatAt 把某一天钉成霜冻/热害，
   * 供 0xFFEE 色带与风险标记的断言使用。
   */
  seedDaily(days = 30, { batt = 95, battDropEvery = 12, ext = true, frostAt = days - 1, heatAt = days - 2 } = {}) {
    const today = Math.floor(Date.now() / 1000 / 86400) * 86400;
    this.daily = Array.from({ length: days }, (_, i) => {
      const d = days - 1 - i;
      const phase = (i / Math.max(1, days - 1)) * Math.PI * 2;
      const temp = Math.round((21 + 3.5 * Math.sin(phase)) * 100) / 100;
      const rec = {
        dateEpoch: today - d * 86400,
        temp,
        hum: Math.round(55 + 8 * Math.cos(phase)),
        battPercent: batt - Math.floor(i / battDropEvery),
      };
      if (ext) {
        // 日较差随季节相位摆动：傍晚最低、正午最高，各 ±(5.0~9.0)℃
        rec.tempMin = Math.round((temp - (5 + 2 * (0.5 + 0.5 * Math.sin(phase)))) * 100) / 100;
        rec.tempMax = Math.round((temp + (5 + 2 * (0.5 + 0.5 * Math.cos(phase)))) * 100) / 100;
      }
      if (i === frostAt) {
        // 霜冻日：日最低 0.5℃（低于 5℃ 阈值）。均值也必须跟着降到 7.5℃——
        // 0xFFEE 存的是"相对均值的 s8 偏移"，物理上最多 -12.7℃，均值 21℃ 时
        // 根本表达不出霜冻（会被固件同款钳位到 8.3℃），所以这里连均值一起改
        rec.temp = 7.5;
        rec.tempMin = 0.5;
        rec.tempMax = 11.0;
      }
      if (i === heatAt) {
        rec.temp = 32.0;                          // 热害日：日最高 40℃（高于 35℃ 阈值）
        rec.tempMin = 25.0;
        rec.tempMax = 40.0;
      }
      return rec;
    });
    return this.daily;
  }

  /** 模拟一次新测量：往 24h 环里追加一条，measure_seq++（对应固件测量完成回调） */
  measure(delta = {}) {
    const last = this.records[this.records.length - 1];
    const ts = Math.floor(Date.now() / 1000);
    const temp = delta.temp ?? (last ? last.temp + 0.3 : 22.0);
    const hum = delta.hum ?? (last ? last.hum + 0.4 : 55.0);
    const rec = {
      timestamp: ts,
      temp: Math.round(temp * 100) / 100,
      hum: Math.round(hum * 100) / 100,
      batt: last ? last.batt : 92,
    };
    this.records.push(rec);
    if (this.records.length > 144) this.records.shift();
    this.measureSeq = (this.measureSeq + 1) & 0xff;
    return rec;
  }

  /** 模拟设备侧清空（0xFFE5 "CLR1"）：24h 环、日均环、测量序号全部归零 */
  resetDevice() {
    this.records = [];
    this.daily = [];
    this.measureSeq = 0;
    this.window = { offset: 0, count: 20 };
  }

  setReadAck({ progress = 0, status = 0, result = 0, eraseMs = 0 } = {}) {    this.readAck = Buffer.alloc(16);
    this.readAck[0] = 0x08;
    this.readAck[1] = 0xff;
    this.readAck.writeUInt16LE(progress, 2);
    this.readAck[4] = status;
    this.readAck[5] = result;
    this.readAck.writeUInt16LE(eraseMs, 6);
  }

  // ---- 读值分发 ----

  valueFor(uuid) {
    switch (uuid) {
      case UUIDS.DATA_CHAR: return encodePacket(this.records.slice(-5));
      case UUIDS.LATEST_CHAR: {                // 10B = 9B 记录 + measure_seq（固件 soil_latest_t）
        const last = this.records[this.records.length - 1];
        const rec = last ? encodeRecord(last) : Buffer.alloc(9);
        const out = Buffer.alloc(10);
        rec.copy(out, 0);
        out[9] = this.measureSeq & 0xff;
        return out;
      }
      case UUIDS.HISTORY_BLK_CHAR: return encodeHistoryBlock(this.records, this.window.offset, this.window.count);
      case UUIDS.DAILY30_CHAR: return encodeDaily30(this.daily, this.tzMin);
      case UUIDS.DAILY30_EXT_CHAR: return encodeDaily30Ext(this.daily, this.tzMin);
      case UUIDS.DAILY_CHAR: return encodeDaily7(this.daily, this.tzMin);
      case UUIDS.CALIB_STATUS_CHAR: return Buffer.from([this.calibStatus, this.calibResult ?? 0xff]);
      case UUIDS.DEV_NAME_CHAR: return Buffer.from(this.devName, 'ascii');
      case UUIDS.TEMP_OFFSET_CHAR: {           // int16 LE，单位 0.01℃
        const b = Buffer.alloc(2);
        b.writeInt16LE(Math.round(this.tempOffset), 0);
        return b;
      }
      case UUIDS.DIS_FW_REV_CHAR: return Buffer.from(`${this.fwRev}\0`, 'ascii');   // C 字符串含 '\0'
      case UUIDS.DIS_MODEL_CHAR: return Buffer.from(`${this.modelNumber}\0`, 'ascii');
      case UUIDS.OTA_CHAR: return this.readAck;
      default: return Buffer.alloc(1);
    }
  }

  // ---- 安装 ----

  /**
   * 按固件 GATT 树建服务/特征。
   * 服务、特征、权限、CCCD 全部来自 gatt-tree.json（固件 app_att.c 的属性表），
   * 这样固件改了表只需重跑 tools/extract-gatt.mjs，假外设自动跟上。
   */
  async install() {
    const s = (method, params) => this.client.send(method, params);
    this.installed = [];

    await s('BluetoothEmulation.simulatePreconnectedPeripheral', {
      address: this.address,
      name: this.name,
      manufacturerData: [],            // CDP 里是必填字段（可以为空数组）
      knownServiceUuids: EMULATED_SERVICES.map((svc) => svc.uuid),
    });

    for (const svc of EMULATED_SERVICES) {
      const { serviceId } = await s('BluetoothEmulation.addService', {
        address: this.address, serviceUuid: svc.uuid,
      });
      for (const c of svc.characteristics) {
        const props = propsToCdp(c.props);
        const { characteristicId } = await s('BluetoothEmulation.addCharacteristic', {
          serviceId, characteristicUuid: c.uuid, properties: props,
        });
        this.idToUuid.set(characteristicId, c.uuid);
        this.uuidToId.set(c.uuid, characteristicId);
        // 带 notify/indicate 的特征必须有 CCCD(0x2902)，否则网页 startNotifications()
        // 会拿到 "GATT Error: Not supported"（描述符层没人应答）
        if (c.hasCCCD) {
          const { descriptorId } = await s('BluetoothEmulation.addDescriptor', {
            characteristicId, descriptorUuid: CCCD_UUID,
          });
          this.descToChar.set(descriptorId, c.uuid);
        }
        this.installed.push({ service: svc.name, ...c });
      }
    }

    this.client.on('BluetoothEmulation.characteristicOperationReceived', (e) => {
      this._handleCharOp(e).catch((err) => console.error('[fake] 响应失败', err));
    });
    // 订阅通知本质上是一次 CCCD(0x2902) 写入 —— 描述符层没人应答的话，
    // 网页 startNotifications() 会直接抛 "GATT Error: Not supported"
    this.client.on('BluetoothEmulation.descriptorOperationReceived', (e) => {
      this._handleDescOp(e).catch((err) => console.error('[fake] 描述符应答失败', err));
    });
    // 连接/服务发现也是"操作"，必须显式应答，否则网页会一直卡在 Connecting…
    this.client.on('BluetoothEmulation.gattOperationReceived', (e) => {
      const code = e.type === 'connection' ? (this.connectionErrorCode || 0) : 0;
      console.log(`[fake] GATT ${e.type}${code ? ` → 拒绝 code=${code}` : ''}`);
      this.client
        .send('BluetoothEmulation.simulateGATTOperationResponse', { address: e.address, type: e.type, code })
        .catch((err) => console.error('[fake] GATT 应答失败', err.message));
    });
    return this;
  }

  /** 发一包广播：设备选择器（scan session）打开后调用，页面才看得见它 */
  async advertise({ rssi = -40 } = {}) {
    await this.client.send('BluetoothEmulation.simulateAdvertisement', {
      entry: {
        deviceAddress: this.address,
        rssi,
        scanRecord: {
          name: this.name,
          uuids: [UUIDS.SERVICE],
        },
      },
    });
  }

  async _handleCharOp({ characteristicId, type, data, writeType }) {
    const uuid = this.idToUuid.get(characteristicId);
    if (!uuid) { console.log(`[fake] ⚠ 未知特征 ${characteristicId} (${type})`); return; }
    if (this.verbose) console.log(`[fake] ${type} ${uuid.slice(4, 8)}${data ? ` len=${Buffer.from(data, 'base64').length}` : ''}`);
    const reply = (code, payload) => this.client.send('BluetoothEmulation.simulateCharacteristicOperationResponse', {
      characteristicId, type, code, ...(payload ? { data: payload.toString('base64') } : {}),
    });

    if (type === 'read') {
      const delay = this.delayRead[uuid] || 0;
      if (delay) await new Promise((r) => setTimeout(r, delay));
      let val = this.valueFor(uuid);
      // 固件里每个特征值都是定长属性（如 0xFFEA 恒 21B、DIS 字符串含 '\0'），
      // 读出来必须与 app_att.c 声明的长度一致——不够补 0、超了截断，并留痕给用例断言
      const want = declaredValueLen(uuid);
      if (want && val.length !== want) {
        // 补 0 是 C 定长属性的正常表现（字符串含 '\0'）；只有"超长被截断"才说明编码写错了
        if (val.length > want) this.lengthMismatch.push({ uuid, got: val.length, want });
        val = val.length < want
          ? Buffer.concat([val, Buffer.alloc(want - val.length)])
          : val.subarray(0, want);
      }
      this.reads.push({ uuid, len: val.length, ts: Date.now() });
      return reply(0, val);
    }

    if (type === 'write') {
      const buf = data ? Buffer.from(data, 'base64') : Buffer.alloc(0);
      this.writes.push({ uuid, data: buf, writeType, ts: Date.now() });
      if (uuid === UUIDS.HISTORY_BLK_CHAR && buf.length >= 2) {
        this.window = { offset: buf[0], count: buf[1] };
      }
      // 固件侧的真实副作用，默认打开（测试可用 autoDeviceEffects=false 关掉）：
      //   0xFFE7 写 0x01 → 立刻测一次：新记录 + measure_seq++（网页靠序号变化识别新测量）
      //   0xFFE5 写 CLR1 → 清空 24h 环和日均（对应 soil_sensor_reset + soil_daily_reset）
      if (this.autoDeviceEffects !== false) {
        if (uuid === UUIDS.REFRESH_CHAR && buf[0] === 0x01) this.measure();
        if (uuid === UUIDS.RESET_CHAR && buf.equals(this.resetMagic)) this.resetDevice();
        // 0xFFE8 温度偏移 / 0xFFEA 设备名：固件写回调会持久化，读回必须是最新值
        if (uuid === UUIDS.TEMP_OFFSET_CHAR && buf.length >= 2) this.tempOffset = buf.readInt16LE(0);
        if (uuid === UUIDS.DEV_NAME_CHAR && buf.length) this.devName = buf.toString('ascii').replace(/\0.*$/, '');
        // 0xFFE6 湿度校准：记下最后一次校准点（0=干 1=湿），读 0xFFE9 时反映到标志位
        if (uuid === UUIDS.CALIB_CHAR && buf.length === 1) {
          this.calibStatus |= buf[0] === 0 ? 0x01 : 0x02;
          this.calibResult = buf[0] === 0 ? 0x01 : 0x02;
        }
      }
      if (this.onWrite) await this.onWrite(uuid, buf, this);
      return reply(0);
    }

    // subscribe-to-notifications / unsubscribe-from-notifications
    return reply(0);
  }

  async _handleDescOp({ descriptorId, type, data }) {
    const uuid = this.descToChar.get(descriptorId);
    if (this.verbose) console.log(`[fake] desc ${type} → ${uuid ? uuid.slice(4, 8) : '?'}`);
    await this.client.send('BluetoothEmulation.simulateDescriptorOperationResponse', {
      descriptorId,
      type,
      code: 0,
      ...(type === 'read'
        ? { data: Buffer.from([0x01, 0x00]).toString('base64') }   // 读 CCCD 回“已开启通知”
        : {}),
    });
  }

  /** 等某特征收到写入（含指定字节前缀） */
  async waitWrite(uuid, matcher = () => true, timeoutMs = 5000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const hit = this.writes.find((w) => w.uuid === uuid && matcher(w.data));
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`等待写入超时：${uuid}`);
  }
}
