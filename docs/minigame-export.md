# 小游戏录像导出

## 使用

### 导出正在播放的录像

刷新安装或升级扩展前已打开的站点标签页。在网站原生小游戏回放页，进度条上方会单独居中显示一行「导出录像」；漏雷训练没有进度条，按钮单独居中显示在难度控件下方。支持 `?history=528` 本地回放和 `?player=95&key=b-50-v1` 线上回放。点击后在当前页直接下载完整的单局 JSON，不打开新标签页。按钮下方显示导出进度与结果，处理期间可「取消导出」；失败后或需要再次下载时，重新点击「导出录像」。切换回放或离开页面会取消尚未完成的导出；通过浏览器后退恢复页面后，旧任务提示会清空，可重新点击导出。

线上导出使用页面实际加载的录像副本，不在点击时重新请求网站，以免同一链接因玩家刷新 PB 而指向另一局。若未取得该副本，会提示刷新页面，不会猜测或导出另一局。切换回放后按钮随当前链接更新；普通训练页及加载失败的回放页不显示按钮。没有回放链接的刚结束训练不属于此入口的支持范围，可从本地历史中导出。

### 批量导出本地历史

1. 在保存小游戏历史的 Chrome 配置中打开 openms.top。升级元神助手后，先刷新该站点标签页。
2. 从扩展 popup 的「小游戏录像」或设置页右上角同名入口打开导出页。
3. 选择来源标签页，点「读取历史」。读取和导出期间保持站点页打开。
4. 按游戏、模式和日期筛选，逐条「导出」、勾选后「导出所选」，或「导出全部筛选」。一条生成单局 JSON，多条生成 ZIP，每局一个 JSON。

**左键和标双训练的录像可以在 [Anon Player](https://player.lockhart.ren/) 播放。** 导入导出的 JSON；多局 ZIP 请先解压。

从正在观看本地回放的站点标签页通过 popup 进入，会保留来源标签页；读取后自动勾选该局，并提供「导出当前回放 #编号」。

日期按浏览器本地时区的完整自然日筛选，包含夏令时变化，结束日期包含当天。更改筛选会清空勾选；日期未填完整、无效或范围倒置时会禁用导出。读取期间新增的对局需重新「读取历史」后纳入；任务可取消，取消不下载未完成文件。

## 导出文件

每个 JSON 包含扩展整理的单局元信息和站点原始录像，使用 UTF-8 编码：

```ts
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

interface ReplayData {
  game: 'left-click' | 'multi-touch' | 'flag-chord' | 'missing-cell' | 'reaction'
  mode: Record<string, JsonValue> // 本地保留完整模式；线上按榜单 key 还原模式
  scoreMs: number // 整数毫秒
  replay: Record<string, JsonValue> // 解压后的原始回放载荷
}

type SingleReplayFile = ReplayData & (
  | { localId: number; playedAt: number } // 本地编号和完成时刻（Unix 毫秒）
  | { playerId: number; rankingKey: string } // 线上玩家编号和完整榜单 key
)
```

单局文件名为 `游戏类型-难度[-密度]-成绩s-本地编号.json`，不含导出时间。初、中、高级用 `beg`、`int`、`exp`，未知难度用 `custom`；成绩固定保留三位小数。密度在界面显示为最简分数（如 `1/2`、`3/4`），文件名中的 `/` 改为 `-`。例如：

```text
left-click-int-3-4-12.345s-590.json
flag-chord-beg-1.234s-586.json
left-click-beg-1-2-1.234s-player95.json
```

线上文件末尾使用 `player玩家编号`，不将玩家编号冒充本地录像编号。线上接口不提供完成时间，导出时不添加 `localId`、`playedAt`，也不以导出时间代替完成时间。两种来源都保留相同的 `game`、`mode`、`scoreMs`、`replay` 字段，可供支持该游戏的播放器导入。

多局 ZIP 中的文件名和内容与单独导出各局相同。ZIP 文件名使用浏览器本地导出时间及 UTC 偏移，例如 `openms-minigame-history-2026-11-26T14-30-45-123+0800.zip`。

密度分数仅用于显示和命名；JSON 中 `mode.density` 保留原始百分比数值（如 `50`、`75`、`87.5`），反应训练的概率仍以百分比显示。录像的字段、事件顺序和时间保持原样，不转换旧版事件编码或认证成绩。

## 数据范围与限制

- 支持左键、多指、标双、漏雷和反应训练中网站已保存的成功局。兼容数据库 v1 / v2 的 JSON 和 v3 的 7z 存储；旧版漏雷顶层的 `version`（存在时）与 `rounds` 收入 `replay`。
- 历史属于站点和浏览器配置，不按登录账号隔离。切换设备、浏览器配置或清除站点数据后，本地编号不能找回原录像。
- 全程只读访问站点历史，不创建、升级、修改或删除历史库，不上传录像或写入玩家缓存。
- 原生回放页入口覆盖五种训练；线上模式支持网站当前的 v1 榜单定义。未知模式或载荷版本会明确报错。
- 单条压缩录像上限 16 MiB，解压后的 JSON 上限 64 MiB，单次导出内容上限 256 MiB；单条解压超时为 30 秒。超限时请缩小导出范围。
- 导出失败的记录逐条报告，其他记录继续。批量部分失败时生成 `-partial.zip`，内含成功的录像及记录失败编号、原因的 `errors.txt`；即使只剩一条成功记录也保留 ZIP。全部失败不生成文件。
- 列表阶段无法识别的记录只在页面报告，不计入可勾选条数；`errors.txt` 只记录本次选择导出的失败记录。

## 开发与验证

本地历史入口为 `minigame.html` / `src/minigame/main.ts`，业务在 `src/features/minigame-export/`。`src/content/minigame-history.ts` 只接受本扩展历史导出页的读取消息。原生回放页由 `src/content/minigame-playback.ts` 注入按钮并在站点页触发下载，不经过后台，也不依赖后台常驻。

点击原生按钮后，按需创建隐藏的 `minigame-frame.html`（`src/minigame/frame.ts`）扩展 iframe，通过专用 `MessageChannel` 传入选定录像。该最小页面校验父页来源、消息和录像，只使用内置 Worker 解压并返回文件；不读取数据库、不向网站发起请求或调用后台。解压完成、失败、超时、取消、切换回放或离开页面时清理 iframe、端口和 Worker。此页面仅向 `https://openms.top/*` 开放，历史导出页本身不开放。

`src/content/minigame-capture.ts` 作为独立 IIFE，在站点 MAIN world 的 `document_start` 留存与当前回放链接匹配的原生 XHR / fetch 响应；不发起额外录像请求，不消耗网站原始响应。普通内容脚本负责注入按钮、本地只读读取和下载。两份内容脚本均由 `vite.content.config.ts` 构建，MAIN 副本使用 `--mode capture`，`build` 和 `watch` 已包含两者。未新增浏览器权限或主机权限。

WASM 解压器 [7z-wasm](https://github.com/use-strict/7z-wasm) 1.2.0（基于 [7-Zip](https://www.7-zip.org/)）和 ZIP 打包库 [zip.js](https://github.com/gildas-lormeau/zip.js) 2.25.0 均随扩展分发，在本机运行；许可见 `public/licenses/7z-wasm.txt`、`public/licenses/zip-js.txt` 及附带压缩实现 [zlib-streams-ts](https://github.com/gildas-lormeau/zlib-streams-ts) 的 `public/licenses/zlib-streams.txt`。CSP 允许内置 WASM，未增加主机权限或加载远程代码。

```bash
npm ci
npm run verify
npx playwright install chromium # 首次准备测试浏览器时运行
npm run verify:minigame
npm run verify:minigame -- America/Santiago # 午夜夏令时边界
```

浏览器回归加载真实 `dist/`，仅使用模拟站点与数据。默认时区 `Asia/Shanghai`，也支持 `America/Santiago`、`America/Los_Angeles`、`Asia/Kathmandu`，通过命令参数或 `YUANSHEN_TEST_TIMEZONE` 指定。`YUANSHEN_CHROMIUM` 可指定支持未打包扩展的 Chromium 可执行文件。

回归还覆盖原生按钮重绘、明暗与窄屏布局、本地和线上原页下载及重复下载、不新增标签页、首次 XHR 与 SPA fetch、PB 更新和迟到响应、缺失副本及坏归档报错、解压消息校验、取消与切换回放时的清理。结果、下载文件和截图保存到 `.tmp/checks/minigame-browser-*/`；真实用户历史与站点页面仍需手动验收。
