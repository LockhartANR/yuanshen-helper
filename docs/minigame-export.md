# 小游戏录像导出

## 使用

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

interface SingleReplayFile {
  localId: number // 来源库中的本地编号，不是全站录像 ID
  game: 'left-click' | 'multi-touch' | 'flag-chord' | 'missing-cell' | 'reaction'
  mode: Record<string, JsonValue> // 完整模式
  scoreMs: number // 整数毫秒
  playedAt: number // 完成时刻，Unix 毫秒
  replay: Record<string, JsonValue> // 解压后的原始回放载荷
}
```

单局文件名为 `游戏类型-难度[-密度]-成绩s-本地编号.json`，不含导出时间。初、中、高级用 `beg`、`int`、`exp`，未知难度用 `custom`；成绩固定保留三位小数。密度在界面显示为最简分数（如 `1/2`、`3/4`），文件名中的 `/` 改为 `-`。例如：

```text
left-click-int-3-4-12.345s-590.json
flag-chord-beg-1.234s-586.json
```

多局 ZIP 中的文件名和内容与单独导出各局相同。ZIP 文件名使用浏览器本地导出时间及 UTC 偏移，例如 `openms-minigame-history-2026-11-26T14-30-45-123+0800.zip`。

密度分数仅用于显示和命名；JSON 中 `mode.density` 保留原始百分比数值（如 `50`、`75`、`87.5`），反应训练的概率仍以百分比显示。录像的字段、事件顺序和时间保持原样，不转换旧版事件编码或认证成绩。

## 数据范围与限制

- 支持左键、多指、标双、漏雷和反应训练中网站已保存的成功局。兼容数据库 v1 / v2 的 JSON 和 v3 的 7z 存储；旧版漏雷顶层的 `version`（存在时）与 `rounds` 收入 `replay`。
- 历史属于站点和浏览器配置，不按登录账号隔离。切换设备、浏览器配置或清除站点数据后，本地编号不能找回原录像。
- 全程只读访问站点历史，不创建、升级、修改或删除历史库，不上传录像或写入玩家缓存。
- 单条压缩录像上限 16 MiB，解压后的 JSON 上限 64 MiB，单次导出内容上限 256 MiB；单条解压超时为 30 秒。超限时请缩小导出范围。
- 导出失败的记录逐条报告，其他记录继续。批量部分失败时生成 `-partial.zip`，内含成功的录像及记录失败编号、原因的 `errors.txt`；即使只剩一条成功记录也保留 ZIP。全部失败不生成文件。
- 列表阶段无法识别的记录只在页面报告，不计入可勾选条数；`errors.txt` 只记录本次选择导出的失败记录。

## 开发与验证

入口为 `minigame.html` / `src/minigame/main.ts`，业务在 `src/features/minigame-export/`。`src/content/minigame-history.ts` 只接受本扩展导出页的读取消息，复用原有内容脚本，不依赖后台常驻。

WASM 解压器 [7z-wasm](https://github.com/use-strict/7z-wasm) 1.2.0（基于 [7-Zip](https://www.7-zip.org/)）和 ZIP 打包库 [zip.js](https://github.com/gildas-lormeau/zip.js) 2.25.0 均随扩展分发，在本机运行；许可见 `public/licenses/7z-wasm.txt`、`public/licenses/zip-js.txt` 及附带压缩实现 [zlib-streams-ts](https://github.com/gildas-lormeau/zlib-streams-ts) 的 `public/licenses/zlib-streams.txt`。CSP 允许内置 WASM，未增加主机权限或加载远程代码。

```bash
npm ci
npm run verify
npx playwright install chromium # 首次准备测试浏览器时运行
npm run verify:minigame
npm run verify:minigame -- America/Santiago # 午夜夏令时边界
```

浏览器回归加载真实 `dist/`，仅使用模拟站点与数据。默认时区 `Asia/Shanghai`，也支持 `America/Santiago`、`America/Los_Angeles`、`Asia/Kathmandu`，通过命令参数或 `YUANSHEN_TEST_TIMEZONE` 指定。`YUANSHEN_CHROMIUM` 可指定支持未打包扩展的 Chromium 可执行文件。

回归结果、下载文件和截图保存到 `.tmp/checks/minigame-browser-*/`；真实用户历史与站点页面仍需手动验收。
