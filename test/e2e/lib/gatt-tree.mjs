/**
 * 固件 GATT 树的运行时封装。
 *
 * 数据来源是 gatt-tree.json —— 由 tools/extract-gatt.mjs 从固件 app_att.c 属性表解析生成。
 * 假外设按它建服务/特征，全链路用例按它枚举要覆盖的读写路径：
 * 固件改了表，重跑一次提取，测试自动跟着变，不需要人工同步两处。
 */
import tree from '../gatt-tree.json' with { type: 'json' };

export const SERVICES = tree.services;

/** 16 位短 UUID（0xFFE1）→ 标准蓝牙 UUID 字符串 */
export function uuidOfShort(short) {
  const h = typeof short === 'number' ? short.toString(16) : String(short).replace(/^0x/i, '');
  return `0000${h.toLowerCase().padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;
}

/** 所有特征拍平，附带所属服务 */
export function allCharacteristics() {
  return SERVICES.flatMap((s) => s.characteristics.map((c) => ({ ...c, service: s })));
}

/** 按短 UUID 或全 UUID 找特征 */
export function charByUuid(uuid) {
  const target = uuid.length === 4 ? uuidOfShort(uuid) : uuid.toLowerCase();
  return allCharacteristics().find((c) => c.uuid === target) || null;
}

/** 只模拟这几类服务：GAP(1800)/GATT(1801) 由 Chrome 自己持有，重复注册会冲突 */
export const EMULATED_SERVICES = SERVICES.filter((s) => {
  const short = s.uuid?.slice(4, 8);
  return short !== '1800' && short !== '1801';
});

/** 固件属性集 → CDP addCharacteristic 需要的 properties 对象 */
export function propsToCdp(props) {
  const has = (p) => props.includes(p);
  return {
    broadcast: has('broadcast'),
    read: has('read'),
    writeWithoutResponse: has('writeWithoutResponse'),
    write: has('write'),
    notify: has('notify'),
    indicate: has('indicate'),
    authenticatedSignedWrites: has('authenticatedSignedWrites'),
    extendedProperties: has('extendedProperties'),
  };
}

/** 固件声明的特征值长度（字节）；未知返回 null */
export function declaredValueLen(uuid) {
  const c = charByUuid(uuid);
  return c && Number.isFinite(c.valueLen) ? c.valueLen : null;
}

/** 树里所有可读 / 可写特征的短 UUID 列表，供用例遍历 */
export const readableShorts = allCharacteristics()
  .filter((c) => c.props.includes('read'))
  .map((c) => c.uuid.slice(4, 8));
export const writableShorts = allCharacteristics()
  .filter((c) => c.props.includes('write') || c.props.includes('writeWithoutResponse'))
  .map((c) => c.uuid.slice(4, 8));
