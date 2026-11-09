/**
 * 从固件源码提取 GATT 树（真值来源），输出 test/e2e/gatt-tree.json。
 *
 * 解析对象（全部只读，不修改固件仓库）：
 *   bth_soil_sensor/app_att.c      属性表 my_Attributes[]：服务边界、特征声明、权限、回调
 *   bth_soil_sensor/app_att.h      SOIL_*_CHAR_UUID 宏 + ATT_HANDLE 枚举顺序
 *   bth_soil_sensor/app_config.h   SOIL_SERVICE_UUID128（128 位主服务，小端字节序）
 *   bth_soil_sensor/bth_soil_sensor.h  各 *_t 结构体（算特征值长度）
 *   tc_ble_single_sdk/.../uuid.h   TELINK_OTA_UUID_SERVICE / TELINK_SPP_DATA_OTA
 *
 * 用法：
 *   node tools/extract-gatt.mjs            # 生成 gatt-tree.json + 打印摘要
 *   node tools/extract-gatt.mjs --check    # 额外与前端 config.js / 假外设树做一致性比对，有漂移则退出码 1
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FW = process.env.FW_DIR
  || resolve(HERE, '../../../../bth_soil_sensor/bth_soil_sensor');
const SDK = resolve(FW, '../tc_ble_single_sdk/tc_ble_single_sdk');
const OUT = resolve(HERE, '../gatt-tree.json');
const CHECK = process.argv.includes('--check');

const read = (p, opt = false) => {
  try { return readFileSync(p, 'utf8'); } catch (e) {
    if (opt) return '';
    throw new Error(`读不到 ${p}（可用 FW_DIR 指定固件源码目录）`);
  }
};
const src = {
  attC: read(resolve(FW, 'app_att.c')),
  attH: read(resolve(FW, 'app_att.h')),
  cfgH: read(resolve(FW, 'app_config.h')),
  sensorH: read(resolve(FW, 'bth_soil_sensor.h')),
  dailyH: read(resolve(FW, 'soil_daily.h')),
  dailyLogH: read(resolve(FW, 'soil_daily_log.h')),
  uuidH: read(resolve(SDK, 'stack/ble/service/uuid.h'), true),
  disH: read(resolve(SDK, 'stack/ble/service/device_information.h'), true),
};

// ---- 1. 宏表（数值 + 字节数组） ----------------------------------------------

const defineRaw = new Map();
for (const text of [src.attC, src.attH, src.cfgH, src.sensorH, src.dailyH, src.dailyLogH, src.uuidH, src.disH]) {
  // 先把反斜杠续行合并成一行，否则跨行的 128 位 UUID 数组定义会被截断
  const joined = text.replace(/\\\r?\n/g, ' ');
  const noComments = joined.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  for (const m of noComments.matchAll(/^\s*#define\s+([A-Za-z_]\w*)\s+([^\n]+)$/gm)) {
    if (!defineRaw.has(m[1])) defineRaw.set(m[1], m[2].trim());
  }
}

function resolveNum(name, depth = 0) {
  if (depth > 12) return NaN;
  if (/^\d+[uUlL]*$/.test(name)) return parseInt(name, 10);
  if (/^0[xX][0-9a-fA-F]+[uUlL]*$/.test(name)) return parseInt(name, 16);
  const raw = defineRaw.get(name);
  if (raw == null) return evalCExpr(name, depth);
  return evalCExpr(raw, depth + 1);
}

/** 求值任意 C 常量表达式（含宏名、括号、四则运算） */
function evalCExpr(expr, depth = 0) {
  if (depth > 12) return NaN;
  let t = String(expr).trim();
  // sizeof(struct_t) 先换成具体字节数，再按表达式求值
  t = t.replace(/sizeof\s*\(\s*(\w+)\s*\)/g, (_, ty) => {
    const n = sizeofType(ty);
    return Number.isNaN(n) ? 'NaN' : String(n);
  });
  if (/^0[xX][0-9a-fA-F]+[uUlL]*$/.test(t)) return parseInt(t, 16);
  if (/^\d+[uUlL]*$/.test(t)) return parseInt(t, 10);
  const sub = t
    .replace(/[uUlL]+\b/g, '')
    // (?<![\w.]) 防止把 0xFFE1 里的 xFFE1 当成标识符
    .replace(/(?<![\w.])([A-Za-z_]\w*)/g, (tok) => {
      const v = resolveNum(tok, depth + 1);
      return Number.isNaN(v) ? tok : String(v);
    });
  if (!/^[\d\s()+\-*/]+$/.test(sub)) return NaN;
  try { return Function(`"use strict";return (${sub})`)(); } catch { return NaN; }
}

/** 取 #define NAME {0x..,0x..} 的 16 字节，返回 GATT 小端字节数组 */
function resolveByteArray(name) {
  const raw = defineRaw.get(name);
  if (!raw) return null;
  const hex = [...raw.matchAll(/0x([0-9a-fA-F]{1,2})/g)].map((m) => parseInt(m[1], 16));
  const word = [...raw.matchAll(/0x([0-9a-fA-F]{4})/g)].map((m) => parseInt(m[1], 16));
  if (hex.length >= 16) return hex.slice(0, 16);
  if (word.length >= 8) {
    const out = [];
    word.slice(0, 8).forEach((w) => out.push(w & 0xff, (w >> 8) & 0xff));
    return out;
  }
  return null;
}

/** 小端 16 字节 → 128 位 UUID 字符串（数组是空中字节序，字符串要反序读） */
function uuid128FromLE(bytes) {
  const s = [...bytes].reverse().map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
/** 16 位 UUID 宏 → 标准蓝牙 UUID 字符串 */
function uuid16String(hex16) {
  return `0000${hex16.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;
}

// ---- 2. 结构体尺寸 -----------------------------------------------------------

const BASE_SIZE = { u8: 1, s8: 1, char: 1, u16: 2, s16: 2, u32: 4, s32: 4 };
const structs = new Map();   // name → [{type, name, dims}]
const varTypes = new Map();  // 变量名 → 类型名（算 sizeof(变量) 用）

for (const text of [src.sensorH, src.dailyH, src.dailyLogH, src.attC]) {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  for (const m of clean.matchAll(/typedef\s+struct[^{;]*\{([\s\S]*?)\}\s*(\w+)\s*;/g)) {
    const fields = [];
    for (const line of m[1].split(';')) {
      const f = line.trim().match(/^(?:struct\s+)?([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*(?:\[\s*([^\]]+)\s*\])?$/);
      if (f) fields.push({ type: f[1], name: f[2], dims: f[3] ? f[3].trim() : null });
    }
    if (fields.length) structs.set(m[2], fields);
  }
}

function sizeofType(type, depth = 0) {
  if (depth > 12) return NaN;
  if (BASE_SIZE[type]) return BASE_SIZE[type];
  const target = varTypes.get(type) || type;      // sizeof(变量名) 时先换成它的类型
  const fields = structs.get(target);
  if (!fields) return NaN;
  let total = 0;
  for (const f of fields) {
    const one = sizeofType(f.type, depth + 1);
    const n = f.dims ? resolveNum(f.dims) : 1;
    if (Number.isNaN(one) || Number.isNaN(n)) return NaN;
    total += one * n;
  }
  return total;
}

/** 解析 C 侧的 sizeof(...) / 宏 / 数字，返回字节数 */
function sizeofExpr(expr) {
  const e = expr.trim();
  const m = e.match(/^sizeof\s*\(\s*(\w+)\s*\)$/);
  if (m) return sizeofType(m[1]);
  const n = resolveNum(e);
  return Number.isNaN(n) ? NaN : n;
}

// ---- 3. 特征声明数组（charVal[5] / charVal[19]） -----------------------------

/** 按顶层逗号切分（忽略括号/花括号内的逗号） */
function splitTop(str) {
  const out = []; let depth = 0; let cur = '';
  for (const ch of str) {
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const PROP_FLAGS = [
  [0x01, 'broadcast'], [0x02, 'read'], [0x04, 'writeWithoutResponse'],
  [0x08, 'write'], [0x10, 'notify'], [0x20, 'indicate'],
  [0x40, 'authenticatedSignedWrites'], [0x80, 'extendedProperties'],
];

const charArrays = new Map();   // 变量名 → {props, uuid}
{
  const clean = src.attC.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  for (const m of clean.matchAll(/const\s+u8\s+(\w+)\s*\[\s*(\d+)\s*\]\s*=\s*\{([\s\S]*?)\}\s*;/g)) {
    const [, name, lenStr, body] = m;
    const len = Number(lenStr);
    if (len !== 5 && len !== 19) continue;         // 只关心特征声明
    const parts = splitTop(body.replace(/\s+/g, ' '));
    const propExpr = parts[0] || '';
    let props = 0;
    for (const tok of propExpr.match(/CHAR_PROP_\w+/g) || []) {
      const v = resolveNum(tok);
      if (!Number.isNaN(v)) props |= v;
    }
    // CHAR_PROP_* 未进宏表时按标准数值兜底（Telink 与蓝牙规范一致）
    if (!props) {
      const fallback = { READ: 0x02, WRITE_WITHOUT_RSP: 0x04, WRITE: 0x08, NOTIFY: 0x10, INDICATE: 0x20 };
      for (const tok of propExpr.match(/CHAR_PROP_(\w+)/g) || []) {
        props |= fallback[tok.replace('CHAR_PROP_', '')] || 0;
      }
    }
    // 5 字节：最后一个 U16_LO(XXX) 就是特征 UUID 宏
    const lo = [...body.matchAll(/U16_LO\s*\(\s*(\w+)\s*\)/g)].map((x) => x[1]);
    let uuid = null;
    if (len === 5) {
      const macro = lo[lo.length - 1];
      const v = resolveNum(macro);
      if (!Number.isNaN(v)) uuid = uuid16String(v);
    } else {
      // 19 字节：属性(1) + 值句柄(2) + 128 位 UUID(16)，UUID 以宏名或裸字节给出
      const tail = parts.slice(3).join(',');
      const macroTok = tail.match(/\b(TELINK_\w+)\b/);
      if (macroTok) {
        const bytes = resolveByteArray(macroTok[1]);
        if (bytes) uuid = uuid128FromLE(bytes);
      }
    }
    if (uuid) charArrays.set(name, { uuid, props, propsList: PROP_FLAGS.filter(([b]) => props & b).map(([, n]) => n) });
  }
}

// ---- 4. 缓冲变量尺寸 ---------------------------------------------------------

const bufSizes = new Map();
{
  const clean = src.attC.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const MOD = '(?:_attribute_data_retention_|static|const|volatile|extern)\\s+';
  // 数组：u8 / u16 / s16 ... NAME[dim] （含 const/static/retention 修饰）
  const arrRe = new RegExp(`(?:^|[;{}\\s])(?:${MOD})*(u8|u16|u32|s8|s16|s32)\\s+(\\w+)\\s*\\[\\s*([^\\]]*)\\s*\\]\\s*(?:=\\s*(\\{[^}]*\\}|"[^"]*"|\\w+))?\\s*;`, 'g');
  for (const m of clean.matchAll(arrRe)) {
    const [, type, name, dim, init] = m;
    const unit = BASE_SIZE[type];
    if (dim === '' && init && init.startsWith('"')) {
      bufSizes.set(name, init.length - 2 + 1);          // C 字符串常量含结尾 '\0'
    } else if (dim === '' && init && init.startsWith('{')) {
      bufSizes.set(name, splitTop(init.slice(1, -1)).filter(Boolean).length * unit);
    } else if (dim === '') {
      const raw = init ? defineRaw.get(init) : null;
      if (raw && /^"/.test(raw)) bufSizes.set(name, raw.length - 2 + 1);
    } else {
      const n = evalCExpr(dim);
      if (!Number.isNaN(n)) bufSizes.set(name, n * unit);
    }
  }
  // 标量：u16 my_appearance = ...;  以及自定义结构体变量 gap_periConnectParams_t my_periConnParameters = {...};
  const scalarRe = new RegExp(`(?:^|[;{}\\s])(?:${MOD})*([A-Za-z_]\\w*)\\s+(\\w+)\\s*=(?!=)[^;]*;`, 'g');
  for (const m of clean.matchAll(scalarRe)) {
    const [, type, name] = m;
    varTypes.set(name, type);
    if (!bufSizes.has(name)) {
      const n = sizeofType(type);
      if (!Number.isNaN(n)) bufSizes.set(name, n);
    }
  }
}

// ---- 5. 服务 UUID 变量 -------------------------------------------------------

const serviceVars = new Map([
  ['my_gapServiceUUID', { uuid: uuid16String(0x1800), name: 'Generic Access' }],
  ['my_gattServiceUUID', { uuid: uuid16String(0x1801), name: 'Generic Attribute' }],
  ['my_devServiceUUID', { uuid: uuid16String(0x180a), name: 'Device Information' }],
]);
for (const m of src.attC.matchAll(/const\s+u8\s+(\w+)\s*\[\s*16\s*\]\s*=\s*(?:\{\s*(\w+)\s*\}|(\w+))\s*;/g)) {
  const [, name, braced, bare] = m;
  const bytes = resolveByteArray(braced || bare || '');
  if (bytes) {
    serviceVars.set(name, {
      uuid: uuid128FromLE(bytes),
      name: name.includes('Ota') ? 'Telink OTA' : 'Soil Sensor',
    });
  }
}

// ---- 6. 属性表 ---------------------------------------------------------------

const tableText = src.attC.slice(
  src.attC.indexOf('my_Attributes[]'),
  src.attC.indexOf('void my_att_init'),
);
const entries = [];
{
  const body = tableText.slice(tableText.indexOf('{') + 1);
  let depth = 1; let start = -1;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '{') { if (depth === 1) start = i; depth++; }
    else if (ch === '}') {
      depth--;
      if (depth === 1 && start >= 0) {
        entries.push(body.slice(start + 1, i).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' '));
        start = -1;
      }
      if (depth === 0) break;
    }
  }
}

/** 从 `(u8 *)(&var)` / `(u8 *)(var)` 里取出最后一个标识符（跳过类型转换里的 u8） */
function lastIdent(expr, known = null) {
  const ids = [...expr.matchAll(/[A-Za-z_]\w*/g)].map((m) => m[0]);
  if (known) {
    const hit = [...ids].reverse().find((n) => known.has(n));
    if (hit) return hit;
  }
  return ids[ids.length - 1] || '';
}

const services = [];
let curSvc = null;
let curChar = null;
let handle = 0;

for (const raw of entries) {
  const f = splitTop(raw);
  if (f.length < 7) continue;          // 第 0 项是属性总数占位
  handle++;
  const declCount = Number(f[0]) || 0;
  const perms = f[1];
  const uuidExpr = f[4];
  const valExpr = f[5];
  const uuidVar = (uuidExpr.match(/&\s*(\w+)/) || [, ''])[1];

  if (uuidVar === 'my_primaryServiceUUID') {
    // 两种写法都有：(&my_gapServiceUUID) 带取址符、(...)(soilServiceUUID128) 数组名不带
    const svcVar = lastIdent(valExpr);
    const meta = serviceVars.get(svcVar);
    curSvc = {
      handle,
      name: meta?.name || svcVar,
      uuid: meta?.uuid || null,
      declaredAttrCount: declCount,
      actualAttrCount: 1,          // 服务声明自身也算一条属性
      characteristics: [],
    };
    services.push(curSvc);
    curChar = null;
    continue;
  }
  if (!curSvc) continue;
  curSvc.actualAttrCount++;

  if (uuidVar === 'my_characterUUID') {
    // valExpr 形如 (u8 *)(soilHistoryCharVal)，末位标识符才是变量名（不能取到类型转换里的 u8）
    const arrName = lastIdent(valExpr, charArrays);
    const decl = charArrays.get(arrName);
    curChar = {
      handle,
      name: arrName.trim(),
      uuid: decl?.uuid || null,
      props: decl?.propsList || [],
      valueLen: null,
      valueHandle: null,
      readCallback: false,
      writeCallback: false,
      hasCCCD: false,
      hasUserDesc: false,
    };
    curSvc.characteristics.push(curChar);
    continue;
  }
  if (!curChar) continue;

  if (uuidVar === 'clientCharacterCfgUUID') { curChar.hasCCCD = true; continue; }
  if (uuidVar === 'userdesc_UUID') { curChar.hasUserDesc = true; continue; }

  // 真正的特征值属性
  const bufName = lastIdent(valExpr, bufSizes);
  curChar.valueHandle = handle;
  curChar.valueUuid = uuidVar;
  curChar.permissions = perms;
  curChar.valueLen = bufSizes.get(bufName) ?? sizeofExpr(f[3]);
  curChar.bufferName = bufName;
  curChar.writeCallback = !/^0$/.test((f[6] || '0').trim());
  curChar.readCallback = !/^0$/.test((f[7] || '0').trim());
}

// ---- 7. 输出 -----------------------------------------------------------------

const tree = {
  generatedFrom: FW,
  note: '由 tools/extract-gatt.mjs 从固件源码解析生成，勿手改',
  services,
};

writeFileSync(OUT, `${JSON.stringify(tree, null, 2)}\n`, 'utf8');

console.log(`解析 ${resolve(FW, 'app_att.c')}`);
console.log(`属性表 ${handle} 项 → ${services.length} 个服务 / ${services.reduce((n, s) => n + s.characteristics.length, 0)} 个特征\n`);
for (const s of services) {
  const warn = s.declaredAttrCount !== s.actualAttrCount ? `  ⚠ 声明 ${s.declaredAttrCount} 实际 ${s.actualAttrCount}` : '';
  console.log(`${s.uuid}  ${s.name}  (${s.characteristics.length} chars)${warn}`);
  for (const c of s.characteristics) {
    const flags = [
      c.readCallback ? 'R*' : '', c.writeCallback ? 'W*' : '',
      c.hasCCCD ? 'CCCD' : '', c.hasUserDesc ? 'DESC' : '',
    ].filter(Boolean).join(',');
    const id = !c.uuid ? '??'
      : c.uuid.startsWith('0000') ? c.uuid.slice(4, 8)
        : c.uuid.slice(-12);
    console.log(`   ${id.padEnd(12)} ${String(c.valueLen ?? '?').padStart(3)}B  [${c.props.join('|')}]  ${flags}`);
  }
}

// ---- 8. --check：与前端 config.js / 假外设树比对 -----------------------------

if (CHECK) {
  const configJs = read(resolve(HERE, '../../../page/js/config.js'));
  const webUuids = new Map();
  for (const m of configJs.matchAll(/^\s*([A-Z_0-9]+):\s*'([0-9a-f-]{36})'/gmi)) {
    webUuids.set(m[1], m[2].toLowerCase());
  }
  const fwUuids = new Map();
  for (const s of services) {
    fwUuids.set(s.uuid, s.name);
    for (const c of s.characteristics) if (c.uuid) fwUuids.set(c.uuid, `${s.name}/${c.uuid.slice(4, 8)}`);
  }

  const problems = [];
  for (const [k, v] of webUuids) {
    if (!fwUuids.has(v)) problems.push(`前端 config.js 的 ${k}=${v} 在固件 GATT 树里不存在`);
  }
  for (const s of services) {
    // 服务属性数声明必须等于实际条目（历史上多次改表漏改这个数字）
    if (s.declaredAttrCount !== s.actualAttrCount) {
      problems.push(`${s.name} 服务声明属性数 ${s.declaredAttrCount} ≠ 表内实际 ${s.actualAttrCount}`);
    }
    for (const c of s.characteristics) {
      const pushes = c.props.includes('notify') || c.props.includes('indicate');
      if (pushes && !c.hasCCCD) {
        problems.push(`${c.uuid} 声明 notify/indicate 但没有 CCCD（前端 startNotifications 会失败）`);
      }
      if (!pushes && c.hasCCCD) {
        problems.push(`${c.uuid} 没有 notify/indicate 却留着 CCCD`);
      }
      if (c.valueLen == null || Number.isNaN(c.valueLen)) {
        problems.push(`${c.uuid} 值长度解析失败（${c.bufferName}）`);
      }
    }
  }

  console.log(`\n一致性检查：前端 ${webUuids.size} 个 UUID，固件 ${fwUuids.size} 个`);
  if (problems.length) {
    console.log('❌ 发现漂移：');
    problems.forEach((p) => console.log(`   - ${p}`));
    process.exitCode = 1;
  } else {
    console.log('✅ 前端 config.js 的每个 UUID 都能在固件 GATT 树里找到，属性数与 CCCD 一致');
  }
}
