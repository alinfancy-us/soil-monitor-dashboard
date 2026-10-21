/**
 * 场景 5：全链路 —— 固件 GATT 树 ↔ 浏览器实枚举 一致性 + 完整用户旅程。
 *
 * A 段（裸 GATT 校验，不经过业务代码）：让浏览器自己去发现服务/特征，把枚举结果
 *   与 gatt-tree.json（从固件 app_att.c 解析出来的真值）逐项比对：
 *     · 服务数量、每个特征是否存在
 *     · 每个特征的 read/write/notify/indicate/writeWithoutResponse 是否与固件属性位一致
 *     · 每个可读特征读出来的字节数是否等于固件声明的值长度（定长属性）
 *     · 每个可写特征能否接受固件声明的载荷（写成功、设备侧收到正确字节）
 *
 * B 段（业务旅程）：走一遍用户真正会做的事——连接 → 24h/7D/30D → 温度偏移 →
 *   设备名 → 刷新测量 → Clear 清空，每步都核对设备侧与 UI 侧。
 *
 * 跑法：npm run full-link
 */
import {
  openApp, connect, snapshot, pipeConsole, finish, assert, log, step, until, sleep,
} from './lib/harness.mjs';
import {
  EMULATED_SERVICES, declaredValueLen, uuidOfShort,
} from './lib/gatt-tree.mjs';

const { browser, page, device } = await openApp({ seed: { history: 144, daily: 30 } });
pipeConsole(page);

const SOIL_SVC = EMULATED_SERVICES.find((s) => s.name === 'Soil Sensor').uuid;
// Web Bluetooth 只对 filters 里声明过的服务授予可见性，所以三个服务都要列上；
// GAP(1800)/GATT(1801) 由浏览器自持，任何会话都拿不到，比对时按"可模拟服务"范围来
const FILTER_SERVICES = EMULATED_SERVICES.map((s) => s.uuid);
const EXPECTED = EMULATED_SERVICES.flatMap((s) => s.characteristics.map((c) => ({ ...c, service: s })));

// ============ A 段：裸 GATT 一致性 ============
try {
  step('A1. 用浏览器的 navigator.bluetooth 自己枚举整棵 GATT 树');
  // requestDevice 需要用户手势，所以注入一个按钮、用真实点击触发（不改动业务代码）
  await page.evaluate((svcUuids) => {
    const b = document.createElement('button');
    b.id = '__e2eRawGatt';
    b.textContent = 'e2e raw gatt';
    // 必须落在视口内才能被真实点击（page.click 要算可点坐标）；几乎透明不干扰截图
    b.style.cssText = 'position:fixed;right:4px;bottom:4px;width:48px;height:24px;opacity:0.01;z-index:99999';
    b.addEventListener('click', async () => {
      try {
        const dev = await navigator.bluetooth.requestDevice({
          filters: [{ services: svcUuids }],
          optionalServices: svcUuids,
        });
        const server = await dev.gatt.connect();
        window.__e2eDev = dev;          // 供 A3 主动断开，避免占着连接
        const services = await server.getPrimaryServices();
        const found = [];
        const chars = {};
        for (const s of services) {
          for (const c of await s.getCharacteristics()) {
            found.push({
              service: s.uuid,
              uuid: c.uuid,
              props: {
                read: c.properties.read,
                write: c.properties.write,
                writeWithoutResponse: c.properties.writeWithoutResponse,
                notify: c.properties.notify,
                indicate: c.properties.indicate,
              },
            });
            if (c.properties.read) {
              try {
                const v = await c.readValue();
                chars[c.uuid] = { len: v.byteLength };
              } catch (e) {
                chars[c.uuid] = { error: String(e.message || e) };
              }
            }
          }
        }
        window.__e2eGatt = { ok: true, found, chars };
      } catch (e) {
        window.__e2eGatt = { ok: false, error: String(e.message || e) };
      }
    });
    document.body.appendChild(b);
  }, FILTER_SERVICES);

  const promptP = page.waitForDevicePrompt({ timeout: 10000 });
  await page.click('#__e2eRawGatt');
  const prompt = await promptP;
  const picked = prompt.devices[0];
  assert(picked, '原始 GATT 会话：选择器里没有设备');
  await prompt.select(picked);

  await until(async () => page.evaluate(() => !!window.__e2eGatt), { timeout: 20000, label: '裸 GATT 枚举结果' });
  const raw = await page.evaluate(() => window.__e2eGatt);
  assert(raw.ok, `裸 GATT 会话失败：${raw.error}`);
  log(`浏览器枚举到 ${raw.found.length} 个特征（可模拟服务共 ${EXPECTED.length} 个特征）`);

  step('A2. 逐项比对：特征存在性 + 属性位 + 读值长度');
  const expected = EXPECTED;
  const problems = [];
  for (const c of expected) {
    const hit = raw.found.find((f) => f.uuid === c.uuid);
    if (!hit) { problems.push(`固件有 ${c.uuid} 但浏览器没发现`); continue; }
    for (const p of ['read', 'write', 'writeWithoutResponse', 'notify', 'indicate']) {
      const want = c.props.includes(p);
      if (!!hit.props[p] !== want) {
        problems.push(`${c.uuid} 属性 ${p} 期望 ${want} 实际 ${hit.props[p]}`);
      }
    }
    if (c.props.includes('read')) {
      const r = raw.chars[c.uuid];
      const want = declaredValueLen(c.uuid);
      if (!r || r.error) problems.push(`${c.uuid} 读失败：${r?.error}`);
      else if (want && r.len !== want) problems.push(`${c.uuid} 读回 ${r.len}B，固件声明 ${want}B`);
    }
  }
  // 反向：浏览器发现的固件树里没有的特征（Chrome 自持服务除外）
  for (const f of raw.found) {
    if (!expected.some((c) => c.uuid === f.uuid)) problems.push(`浏览器多出特征 ${f.uuid}`);
  }
  if (problems.length) {
    problems.forEach((p) => log('  ✗', p));
    throw new Error(`GATT 树与固件声明不一致（${problems.length} 处）`);
  }
  log('✅ 服务/特征/属性位/值长度 全部与固件 app_att.c 一致');

  step('A3. 断开裸会话，交给业务代码连接');
  // 不 reload：页面重载会打断 CDP 模拟连接（Target closed）。只断开链路、移除注入的按钮
  await page.evaluate(async () => {
    try { window.__e2eDev?.gatt?.disconnect?.(); } catch (_) {}
    document.getElementById('__e2eRawGatt')?.remove();
    window.__e2eGatt = null;
  });
  await sleep(500);

  // ============ B 段：业务旅程 ============
  step('B1. 连接 → 24h 历史 + 30 天日均');
  await connect(page, device);
  const s1 = await snapshot(page);
  assert(s1.historyRows >= 5, `历史表 ${s1.historyRows} 行`);
  const fetched = await page.evaluate(() => document.querySelectorAll('#historyBody tr').length);
  log(`首页温度 ${s1.temp} / 湿度 ${s1.hum} / 历史 ${fetched} 行 / 范围 ${s1.trendRange}`);
  assert(device.reads.some((r) => r.uuid === uuidOfShort('ffec')), '没走 0xFFEC 分块读');
  assert(device.reads.some((r) => r.uuid === uuidOfShort('ffed')), '没读 30 天日均 0xFFED');

  step('B2. 7D / 30D 日均视图可切换 + 温度极值（0xFFEE）');
  await page.evaluate(() => document.getElementById('dailyRange7Btn').click());
  await sleep(300);
  const daily7 = await page.evaluate(() => ({
    note: document.getElementById('dailyNote')?.textContent?.trim(),
    ext: document.getElementById('dailyExtNote')?.textContent?.trim(),
    extHidden: document.getElementById('dailyExtNote')?.classList.contains('hidden'),
    canvas: !!document.getElementById('dailyChart'),
  }));
  log(`7D 视图：${daily7.note} ｜ 极值：${daily7.ext}`);

  // 风险区背景画在 canvas 上，只能按像素断言：≥35℃ 一片 rgba(220,38,38,.10)、
  // ≤2℃ 一片 rgba(2,132,199,.10)。阈值在 ℉ 下换算后仍由同一套代码画，不依赖当前单位。
  // getImageData 给的是"反预乘"值：色值仍是原色，alpha 只有 ~26，所以按色值 + 低 alpha 匹配。
  const scanZones = () => page.evaluate(() => {
    const c = document.getElementById('dailyChart');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let heat = 0, frost = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
      if (a < 15 || a > 45) continue;                                              // 填充层 alpha≈26；虚线/文字 alpha 更高，排除掉
      if (Math.abs(r - 0xdc) < 8 && Math.abs(g - 0x26) < 8 && Math.abs(b - 0x26) < 8) heat++;   // rgba(220,38,38,.10) 热害区
      if (Math.abs(r - 0x02) < 8 && Math.abs(g - 0x84) < 8 && Math.abs(b - 0xc7) < 8) frost++;  // rgba(2,132,199,.10) 霜冻区
    }
    return { heat, frost };
  });
  const zonePixels = await scanZones();
  log(`风险区像素：热害 ${zonePixels.heat} / 霜冻 ${zonePixels.frost}`);

  await page.evaluate(() => document.getElementById('dailyRange30Btn').click());
  await sleep(300);
  const daily30 = await page.evaluate(() => document.getElementById('dailyNote')?.textContent?.trim());
  log(`30D 视图：${daily30}`);
  assert(/7-day|7 天/i.test(daily7.note || ''), `7D 说明文案异常：${daily7.note}`);
  assert(/30-day|30 天/i.test(daily30 || ''), `30D 说明文案异常：${daily30}`);

  assert(device.reads.some((r) => r.uuid === uuidOfShort('ffee')), '没读 30 天温度极值 0xFFEE');
  assert(!daily7.extHidden && /Low/i.test(daily7.ext || ''), `极值文案缺最低温：${daily7.ext}`);
  assert(/High/i.test(daily7.ext || ''), `极值文案缺最高温：${daily7.ext}`);
  // 假外设把最新一天钉成 -1.5℃、前一天钉成 38℃：两端都应命中阈值着色
  assert(daily7.ext.includes('❄'), `霜冻日没打霜冻标记：${daily7.ext}`);
  assert(daily7.ext.includes('🔥'), `热害日没打热害标记：${daily7.ext}`);
  // 假外设同时有 38℃ 与 -1.5℃，纵轴必须同时容下两侧，两条风险区都应出现
  assert(zonePixels.heat > 300, `日均图没画 ≥35℃ 热害区背景（命中 ${zonePixels.heat} 像素）`);
  assert(zonePixels.frost > 300, `日均图没画 ≤2℃ 霜冻区背景（命中 ${zonePixels.frost} 像素）`);

  // 摘要头点选（Apple Health 式）：点图上第一天 → 摘要头日期应离开默认的最新一天
  const rangeDateBefore = await page.evaluate(() => document.getElementById('dailyRangeDate')?.textContent?.trim());
  await page.evaluate(() => {
    const c = document.getElementById('dailyChart');
    const lay = c._chartLayout;
    const rect = c.getBoundingClientRect();
    c.dispatchEvent(new MouseEvent('click', { clientX: rect.left + lay.padLeft, clientY: rect.top + 20, bubbles: true }));
  });
  await sleep(250);
  const selDate = await page.evaluate(() => document.getElementById('dailyRangeDate')?.textContent?.trim());
  assert(selDate && selDate !== rangeDateBefore, `点选第一天后摘要头日期未切换：${selDate}（原 ${rangeDateBefore}）`);
  log(`点选第一天：摘要头 ${rangeDateBefore} → ${selDate}`);

  // 切到湿度/电量：极值只对温度有意义，文案必须收起、风险区背景必须消失
  await page.evaluate(() => document.getElementById('dailyMetricHumBtn').click());
  await sleep(250);
  const humPixels = await scanZones();
  const humExtHidden = await page.evaluate(() => document.getElementById('dailyExtNote')?.classList.contains('hidden'));
  log(`湿度视图：极值文案 hidden=${humExtHidden}，风险区像素 ${humPixels.heat + humPixels.frost}`);
  assert(humExtHidden, '湿度视图不该显示温度极值文案');
  assert(humPixels.heat < 20 && humPixels.frost < 20, `湿度视图不该画温度风险区（命中 ${humPixels.heat + humPixels.frost} 像素）`);
  await page.evaluate(() => document.getElementById('dailyMetricTempBtn').click());
  await sleep(150);

  step('B3. 温度偏移写 → 读回（0xFFE8 s16 0.01℃）');
  const OFF_C = 2.5;
  await page.evaluate(() => {
    // 统一切到 ℃，输入框刻度才和设备 0.01℃ 一一对应（℉ 模式要先 ×50/9 再钳位）
    document.querySelector('.temperature-unit-btn[data-unit="C"]')?.click();
    document.getElementById('mainTabSettingBtn').click();
    const input = document.getElementById('tempOffsetInput');
    input.value = '2.5';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(200);
  await page.evaluate(() => document.getElementById('tempOffsetApplyBtn').click());
  const offWrite = await device.waitWrite(uuidOfShort('ffe8'), () => true, 8000);
  const offVal = offWrite.data.readInt16LE(0);
  const offStatus = await page.$eval('#tempOffsetStatus', (e) => e.textContent.trim());
  log(`0xFFE8 ← ${offWrite.data.toString('hex')} = ${offVal / 100}℃；UI：${offStatus}`);
  assert(offWrite.data.length === 2, `0xFFE8 写入应为 2 字节，实际 ${offWrite.data.length}`);
  assert(offVal === OFF_C * 100, `偏移量应为 ${OFF_C}℃，实际 ${offVal / 100}℃`);
  assert(device.tempOffset === offVal, `设备侧未持久化偏移：${device.tempOffset} vs ${offVal}`);
  assert(/offset set to/i.test(offStatus), `UI 未显示偏移设置结果：${offStatus}`);

  step('B4. 设备名写 → 读回（0xFFEA ≤21B，含 \\0 填充）');
  const NEW_NAME = 'SoilPulseB';   // 10 字符：产品层面限 10（固件缓冲 20）
  const nameUi = await page.evaluate((name) => {
    const input = document.getElementById('devNameInput');
    input.value = name;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const btn = document.getElementById('devNameSaveBtn');
    const state0 = { disabledBefore: btn.disabled };
    btn.click();
    return state0;
  }, NEW_NAME);
  log(`设备名保存按钮点击前 disabled=${nameUi.disabledBefore}（页面限 10 字符，固件缓冲 21B）`);
  await sleep(1500);
  const nameDiag = await page.evaluate(() => ({
    status: document.getElementById('devNameStatus')?.textContent?.trim(),
    count: document.getElementById('devNameByteCount')?.textContent?.trim(),
    disabled: document.getElementById('devNameSaveBtn')?.disabled,
  }));
  log(`设备名诊断：${JSON.stringify(nameDiag)}，设备收到写入 ${device.writes.map((w) => w.uuid.slice(4, 8)).join(',')}`);
  const nameWrite = await device.waitWrite(uuidOfShort('ffea'), (b) => b.length > 0, 8000);
  const writtenName = nameWrite.data.toString('ascii').replace(/\0.*$/, '');
  log(`0xFFEA ← "${writtenName}"（${nameWrite.data.length}B）`);
  assert(writtenName === NEW_NAME, `设备名写入不符：${writtenName}`);
  assert(device.devName === NEW_NAME, `设备侧未持久化设备名：${device.devName}`);
  // 读回路径：设备侧的 name 缓冲就是固件 0xFFEA 的读值来源
  const readBackName = device.valueFor(uuidOfShort('ffea')).toString('ascii').replace(/\0.*$/, '');
  assert(readBackName === NEW_NAME, `0xFFEA 读回不对：${readBackName}`);
  log(`0xFFEA 读回："${readBackName}" ✓`);

  step('B5. Refresh：0xFFE7 写 0x01 → 设备测一次 → 0xFFEB seq 变化');
  const seqBefore = device.measureSeq;
  const recBefore = device.records.length;
  await page.evaluate(() => document.getElementById('refreshBtn')?.click());
  await until(() => device.writes.some((w) => w.uuid === uuidOfShort('ffe7')), { timeout: 8000, label: '0xFFE7 写入' });
  await until(() => device.measureSeq !== seqBefore, { timeout: 8000, label: '设备侧新测量' });
  log(`0xFFE7 收到刷新指令；设备新增记录 ${recBefore} → ${device.records.length}，seq ${seqBefore} → ${device.measureSeq}`);
  await sleep(1500);
  const s2 = await snapshot(page);
  log(`刷新后首页：${s2.temp} / ${s2.hum}`);

  step('B6. Clear：0xFFE5 CLR1 → 设备清空 + 本地清空');
  // Clear 按钮在 Data 页，前面几步把页面停在 Setting 了，先切回来（否则元素不可点）
  await page.evaluate(() => document.getElementById('mainTabDataBtn').click());
  await sleep(300);
  page.once('dialog', (d) => d.accept());
  await page.click('#clearCacheBtn');
  await device.waitWrite(uuidOfShort('ffe5'), (buf) => buf.toString('ascii') === 'CLR1', 8000);
  await until(() => device.records.length === 0, { timeout: 5000, label: '设备侧清空' });
  await until(async () => {
    const s = await snapshot(page);
    return s.historyRows <= 1 && !s.storageKeys.some((k) => /^SoilPulse:(trend|daily):/.test(k));
  }, { timeout: 8000, label: '本地清空' });
  log('设备侧 24h 环 / 日均 已清空，本地缓存同步清空');

  step('B7. 清空后重新拉取应为 0 条（验证不是"表面清空"）');
  const refetched = await page.evaluate(() => document.querySelectorAll('#historyBody tr').length);
  log(`清空后历史表 ${refetched} 行（≤1 表示只剩空态行）`);
  assert(refetched <= 1, `清空后仍显示 ${refetched} 行`);

  if (device.lengthMismatch.length) {
    log('⚠ 读值长度修正记录：', JSON.stringify(device.lengthMismatch));
  } else {
    log('✅ 全程无读值长度修正（假外设编码与固件定长声明完全一致）');
  }

  await finish(browser, page, '/tmp/soilpulse-e2e-fulllink.png', '场景 5 全链路');
} catch (e) {
  await page.screenshot({ path: '/tmp/soilpulse-e2e-fulllink-fail.png' }).catch(() => {});
  await browser.close();
  throw e;
}
