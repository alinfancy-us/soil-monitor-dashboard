# SoilPulse Web E2E（GATT 模拟）

用 Chrome DevTools Protocol 的 `BluetoothEmulation` 域在浏览器内部造一台**虚拟 SoilPulse 外设**，
再驱动真实页面（`index.html` + `page/js/*.js`）跑完整业务逻辑。

- **不碰业务代码**：网页侧代码零改动、零测试开关，`navigator.bluetooth` 照常工作
- **不进发布包**：CI 的 `dist/` 只复制 `index.html` 与 `page/`（见 `.github/workflows/deploy.yml`），
  `test/` 永远不上线
- **不需要真设备**：GATT 树、每次读的返回值、写入的回执、断链时机全由脚本编排

## 前置

```bash
# 1. 仓库根目录起静态服务（页面要 localhost / https 才有 navigator.bluetooth）
python3 -m http.server 8000

# 2. 装依赖（只在本目录，不污染根目录）
cd test/e2e && npm install
```

## 跑

```bash
npm run gatt         # 从固件源码重新解析 GATT 树，并与前端 config.js 做一致性比对
npm test             # 跑全部场景，最后汇总
npm test -- reset    # 只跑名字含 reset 的
npm run connect      # 连接 → 读固件版本 / 24h 历史 / 30 天日均
npm run reset        # Clear data：0xFFE5 → 清缓存 → 立清空水位
npm run disconnect   # 链路层强制断开 → UI 回落 + 轮询停止
npm run ota          # readAck 编排：START 阶段被拒（低电 0x11）→ Retry
npm run offset       # 温度偏移 0xFFE8：写线单位（0.01℃）+ 回执文案不放大 10 倍 + ℉ 换算
npm run idle         # 空闲提醒：180s 弹窗倒计时 → Keep connected 写 0xFFE7 续命 / 不点放行设备超时
npm run full-link    # 固件 GATT 树 ↔ 浏览器实枚举 一致性 + 完整用户旅程
```

环境变量：`URL`（默认 `http://127.0.0.1:8000/index.html`）、`CHROME_PATH`、`HEADLESS=1`、
`FW_DIR`（固件源码目录，默认同级仓库 `bth_soil_sensor/bth_soil_sensor`）。

## GATT 树从固件来，不手写

`tools/extract-gatt.mjs` 直接解析固件源码，生成 `gatt-tree.json`：

| 固件文件 | 提取内容 |
|---|---|
| `app_att.c` 的 `my_Attributes[]` | 服务边界、每个特征的声明、权限位、值缓冲、读写回调、CCCD/用户描述 |
| `app_att.h` | `SOIL_*_CHAR_UUID` 宏、`ATT_HANDLE` 枚举顺序 |
| `app_config.h` | `SOIL_SERVICE_UUID128`（128 位主服务，小端字节序，需反序还原成字符串） |
| `bth_soil_sensor.h` / `soil_daily*.h` | `soil_record_t` 等结构体 → 特征值长度（46 / 71 / 183 / 184 / 10…） |
| SDK `uuid.h` / `device_information.h` | Telink OTA、DIS 的 UUID |

假外设 `soil-fake.mjs` **按这份 JSON 建服务与特征**（服务、权限、CCCD 全部来自固件），
所以固件改表后只需 `npm run gatt`，测试自动跟上，不存在"两边各写一份 UUID"的漂移。

`--check` 还会做三件事：
1. 前端 `page/js/config.js` 里每个 UUID 必须在固件树里存在（抓"前端以为有、固件其实没有"）
2. 每个服务的"声明属性数"必须等于表内实际条目数（历史上多次改表漏改这个数字）
3. 有 notify/indicate 就必须有 CCCD，反之不留空 CCCD

## 结构

| 文件 | 作用 |
|---|---|
| `tools/extract-gatt.mjs` | 固件源码 → `gatt-tree.json`（含 `--check` 一致性校验） |
| `gatt-tree.json` | 生成的 GATT 树（勿手改） |
| `lib/gatt-tree.mjs` | 树的运行时封装：枚举特征、属性转 CDP 格式、查固件声明长度 |
| `soil-fake.mjs` | 假外设：按树建 GATT、协议编码、读写应答、设备侧副作用（刷新测一次/清空/持久化偏移与设备名） |
| `lib/harness.mjs` | 脚手架：启动 Chrome、上电模拟适配器、装外设、打开页面、走连接、快照断言 |
| `run-*.mjs` | 各场景脚本，失败会截图到 `/tmp/soilpulse-e2e-*-fail.png` |
| `run-all.mjs` | 串行编排 + 汇总，非 0 退出码给 CI 用 |

## 已知坑（踩过，别再踩）

1. **CDP 会话必须挂在 browser target 上**：`browser.target().createCDPSession()`，
   page 会话里没有 `BluetoothEmulation.*`。
2. **不要调 `simulateAdvertisement`**：偶发不返回，而且会把 CDP 蓝牙模拟线程卡住，
   之后 connection 应答收不到 → 页面卡 `gatt.connect timed out 10s`。
   `simulatePreconnectedPeripheral` 造的外设本来就在选择器列表里（名字为空）。
3. **连接/服务发现也要显式应答**：监听 `gattOperationReceived` → `simulateGATTOperationResponse`，
   否则页面永远停在 `Connecting…`。
4. **notify 特征要有 CCCD(0x2902)**，且 `descriptorOperationReceived` 要应答，
   否则 `startNotifications()` 抛 `GATT Error: Not supported`。
5. **带 `window.confirm` 的按钮**（Clear data / Update now）必须挂 `page.once('dialog', d => d.accept())`，
   否则点击后页面一直等，看不到任何后续动作。
6. macOS 上 Chrome 在受限 shell 里跑要加 `--no-sandbox --disable-gpu-sandbox`。
7. **偏移 / 校准卡在 Settings 页签里**，点这些按钮用 `page.evaluate(el.click())`，
   否则 puppeteer 报 `Node is either not clickable`。点之前先 `#mainTabSettingBtn`。
8. **默认温度单位可能是 ℉**（按浏览器区域推断），断言文案前必须先显式切到目标单位，
   不能假设起始是 ℃（`run-temp-offset.mjs` 的 `setUnit()` 就是干这个的）。

## 全链路场景覆盖什么

`run-full-link.mjs` 分两段：

**A 段（裸 GATT，不经过业务代码）** —— 让浏览器自己 `requestDevice` 枚举，与固件树逐项比对：
服务数量、每个特征是否存在、`read/write/notify/indicate/writeWithoutResponse` 属性位、
每个可读特征读回的字节数是否等于固件声明长度。当前结果：**15 个特征全部一致**。

> 注意：Web Bluetooth 只暴露 `filters` 里声明过的服务，GAP(1800)/GATT(1801) 永远拿不到，
> 所以比对范围是"可模拟的三个服务"（土壤主服务 + Telink OTA + DIS）。

**B 段（业务旅程）** —— 连接 → 24h 历史/30 天日均 → 7D/30D 切换 → 温度偏移写读 →
设备名写读 → Refresh 触发新测量 → Clear 清空，每步都同时核对设备侧与 UI 侧。

## 已知差异（测试照出来的，不是 bug）

- **设备名长度**：固件缓冲 21B（`SOIL_DEV_NAME_MAX_LEN=20` + `\0`），
  但前端 `DEV_NAME_MAX_BYTES = 10` 是产品层面主动收紧的，所以写入用例只用 ≤10 字符。
  读路径仍按 21B 定长返回（补 `\0`），前端按 `\0` 截断。

## 测得到 / 测不到

✅ 连接握手、服务发现、时间同步写入、0xFFE1/0xFFEB/0xFFEC/0xFFED 各读取路径、
温度偏移写入的线格式（0.01℃ int16）与回执文案、Clear/Reset 写 + 本地缓存清理 + 清空水位、
断链回落、OTA readAck 各状态分支与原因码提示

⚠️ 测不到：真实射频时序（ATT 拥塞、iOS notify 积压）、固件侧 Go-Back-N 重传逻辑、
真实擦写 Flash 的耗时与失败、MTU 协商差异
