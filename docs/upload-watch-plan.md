# 录像自动上传 · 方案

> 状态：已按本方案实现（v0.2.0），实现记录见文末
> 参考：站点原生实现 `front_end/src/utils/fileIO.ts`（`PollingDirectoryNewFileEmitter`）与 `front_end/src/views/TournamentView/common/AutoUploader.vue`

## 0. 一句话

选定一个本地录像目录，按固定周期轮询，发现新文件就上传；支持「先补传已有录像」和「只上传新录像」两种启动方式。

## 1. 目标与非目标

**目标**

- 选中目录后持续监视，默认 **10 秒**一轮，间隔可改（5–300 秒）；
- 两种启动方式：补传目录里已有的录像 / 只传启动之后出现的；
- 关掉扩展面板继续跑；浏览器重启后不重放、不遗漏；
- 单条失败不影响整批，可重试；账号级错误（未登录、额度满）立即停机并说明原因。

**非目标（v1 不做）**

- 不做比赛 / 排行榜筛选（站点原生那套 `matchesFilter` 依赖比赛上下文）；
- 不做本地解析（不引入 ms-toollib WASM），完成局判定交给服务端；
- 不做分片、断点续传、多目录同时监视；
- 不代填登录、不处理验证码。

## 2. 前提与硬约束

| 约束 | 说明 | 应对 |
|---|---|---|
| 不能输入绝对路径 | 只能 `showDirectoryPicker({mode:'read'})`，且必须由用户手势触发 | 面板里一个「选择目录」按钮 |
| 权限不跨浏览器会话 | 重启后句柄还在，`queryPermission()` 通常返回 `prompt` | 面板顶部横幅 +「重新授权」按钮（必须在可见页面里点，不能放 offscreen） |
| 浏览器关闭即停 | 扩展没有常驻进程 | UI 明确写「浏览器关闭期间不工作」 |
| `chrome.alarms` 最小 30 秒 | 10 秒周期**不能**靠 alarms 实现 | 见 §5 双层调度 |
| 站点限流 5 次/秒 | 上传过密返回 429 | 串行 + 300ms 间隔 |
| 目录无变更通知 | `FileSystemObserver` 尚不可用 | 只能轮询全量列目录 |

## 3. 两种模式：一条代码路径

不写两套逻辑，区别只在启动瞬间如何处理目录里已有的文件：

```text
开始监视:
  files = 列出目录（当前全集）
  for f in files:
      if 台账里没有 f:
          mode == 'backfill' → status = 'queued'     # 模式 1：补传已有
          mode == 'new-only' → status = 'ignored'    # 模式 2：记台账但不上传
  for f in files:
      if 台账里没有 f: 台账写入（落 IDB）

之后每轮:
  台账里没有的文件 → 一律 'queued'
```

**关键**：模式 2 必须把已有文件写进台账并标 `ignored`，不能"什么都不记"。否则浏览器重启、或用户换了台机器，同一批旧文件又会被当成新文件重新传一遍。

## 4. 架构

```text
chrome.alarms（30s 看门狗）
  └─ 确保 offscreen 存活 / 被杀后重建
offscreen document（常驻，监视期间存在）
  ├─ scanner：setInterval(10s) → 列目录 → diff → 入队
  └─ uploader：常驻串行队列 → 取字节 → 交给 content script
content script（openms.top，同源）
  └─ POST /common/uploadvideo/（自动带 session_id，无 CORS）
扩展面板（side panel / options）
  ├─ 选目录、授权、模式、间隔、启停
  └─ 状态、计数、日志
```

| 层 | 职责 | 不做什么 |
|---|---|---|
| SW | alarms 看门狗、消息路由、badge | 不跑扫描循环（会被回收） |
| offscreen | 扫描、队列、退避 | 不申请目录权限（无用户手势） |
| content script | 只负责发上传请求 | 不读目录、不存状态 |

**为什么扫描不放 content script**：页面后台标签的定时器会被节流到分钟级，10 秒会失真；而且目录句柄存在页面 origin 的 IDB 里，站点自己的 JS 也能读到，等于把用户目录访问权交给网站。

**为什么上传必须借 content script**：`session_id` 是 `SameSite=Lax`，扩展 origin 对站点算跨站，`fetch` 能否带上 Cookie 不确定。content script 跑在站点 origin，同源请求天然带 Cookie，这是零风险路径。

## 5. 调度

### 5.1 双层

| 层 | 机制 | 精度 | 作用 |
|---|---|---|---|
| 主循环 | offscreen 内 `setInterval(intervalSec * 1000)` | 设定值 | 实际扫描节奏 |
| 看门狗 | `chrome.alarms`，周期 1 分钟 | ≤60s | offscreen 没起来 / 被回收时重建，并补扫一轮 |

### 5.2 降级

`intervalSec < 30` 时，如果 offscreen 起不来（无 `offscreen` 权限、被系统回收、浏览器策略限制），自动退化为 alarms 的 30 秒节奏。

面板必须同时显示两个值：

```
扫描间隔   [10] 秒（可选 5–300）
实际间隔   10 秒 / 30 秒（后台降级）
```

宁可把降级摆出来，也不要让用户以为在 10 秒轮询其实 60 秒才扫一次。

### 5.3 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `intervalSec` | 10 | 5–300，运行中可改（下一轮扫描生效） |
| 单轮最多 stat | 5000 | 只对真正需要读取的文件计数，避免台账变大后空转 |
| 上传并发 | 1 | 队列串行 |
| 每批上传 | 20 | 一批做完立刻接着下一批，队列空才停 |
| 上传间隔 | 300ms | 站点限流 5/s，留余量 |
| 单文件重试 | 5 次 | 退避 1/2/4/8/16 秒 |

扫描与上传是**两个独立循环**：扫描只负责入队，上传按自己的节奏连续消费。扫描再慢也不会把上传卡住，上传再多也不会错过下一轮扫描。

## 6. 扫描与 diff

```ts
async function scanOnce() {
  const entries = [];                       // 只收文件名，不读内容
  for await (const h of dir.values()) {
    if (h.kind !== 'file') continue;        // 子目录默认忽略
    if (!matchExt(h.name)) continue;        // .evf 等
    if (skipFail && isFailName(h.name)) continue;
    entries.push(h.name);
  }

  let processed = 0;                        // 只有需要 stat 的文件才计数
  for (const name of entries) {
    const e = ledger.get(name);
    if (e && e.status !== 'seen') continue; // 已处理过，连 stat 都不做
    if (++processed > 5000) break;          // 单轮上限，剩下的下轮继续
    const file = await dir.getFileHandle(name).then(h => h.getFile());
    // 第一次看到时文件已经静置超过 3 秒，说明早写完了，直接入队
    if (!e) {
      const stable = Date.now() - file.lastModified > 3000;
      ledger.set(name, { size: file.size, mtime: file.lastModified, status: stable ? 'queued' : 'seen' });
      continue;
    }
    // 刚写完不久的文件：下一轮再确认一次
    if (e.size === file.size && e.mtime === file.lastModified && Date.now() - file.lastModified > 3000) {
      ledger.set(name, { ...e, status: 'queued' });
    } else {
      ledger.set(name, { ...e, size: file.size, mtime: file.lastModified });
    }
  }
}
```

**稳定性判据**：文件在第一次被看到时如果已经静置超过 3 秒，直接入队；刚写完（mtime 很新）的才记成 `seen`，下一轮确认 `size + mtime` 没变再入队。理由：目录可能被同步盘、录制软件、甚至用户在资源管理器里复制写入，扫到半个文件直接上传会被服务端判 `incomplete` 或 `rust/panic`。这样常规情况最多等一个周期，可疑文件多等一轮。

**已知取舍**

- 只按文件名去重（目录迭代只给名字，哈希要每轮读全部文件）。改名另存会被当新文件重传，服务端 `collision` 兜底；
- 同名覆盖不会重传（视为同一局）；
- 子目录默认不扫（对齐站点原生实现），提供开关，开启后相对路径作为台账 key。

## 7. 上传

### 7.1 请求

```http
POST https://openms.top/common/uploadvideo/
Content-Type: multipart/form-data（不要手写，交给浏览器）
Cookie: session_id=...
file=<bytes>
```

`skipTournamentCheck` 不传（默认 false），非比赛场景用不上。

### 7.2 通道

```ts
// offscreen / SW 侧
const tab = await findOpenMsTab();          // 没有就 tabs.create({active:false, pinned:true})
const res = await chrome.tabs.sendMessage(tab.id, {
  type: 'UPLOAD_VIDEO', name, bytes,       // ArrayBuffer 走结构化克隆
});
```

```ts
// content script 侧
const fd = new FormData();
fd.append('file', new File([bytes], name));
const resp = await fetch('/common/uploadvideo/', {method: 'POST', body: fd, credentials: 'same-origin'});
```

录像文件通常只有几 KB 到几十 KB，消息传递没有压力。

### 7.3 响应映射

| 现象 | 判据 | 处理 |
|---|---|---|
| 成功 | `200` + `type:"success"` | 记 `id` / `state`，标 `done` |
| 已经传过 | `200` + `object:"file"` + `category:"collision"` | **视为成功**（`done`，备注"网站已有"） |
| 未完成局 | `200` + `file/incomplete` | 标 `skipped`（不算失败，不再重试） |
| 格式不支持 | `200` + `file/type` | 标 `failed`，不重试 |
| 级别异常 | `200` + `file/level` | 标 `failed`，不重试 |
| 审核码异常 | `200` + `file/review` | 标 `failed`，不重试 |
| 录像解析崩溃 | `200` + `rust/panic` | 标 `failed`，不重试 |
| 标识含违规词 | `200` + `identifier/*` | 停批 + 提示改标识 |
| 未实名 | `200` + `obj:"userprofile"` + `realname_required` | 停批 + 提示实名 |
| 未登录 / 被封 | `403` | 停批 + 提示重新登录站点 |
| 额度满 | `402` | 停批 + 提示联系管理员 |
| 文件过大 | `413` | 标 `failed` |
| 限流 | `429` | 读 `Retry-After`，退避重试 |
| 榜单刷新中 | `503` | 读 `Retry-After`（通常 1s），重试该文件 |
| 其他 5xx | `5xx` | 逐条退避重试，5 次后记失败；不整批停 |

三个必须记住的坑：`collision` 是 200 里的 error 不是 409；未实名那条用的是 `obj` 而不是 `object`；`identifier` 只判 `object` 不够，还要看 `category`。

### 7.4 失败分级

| 级别 | 例子 | 行为 |
|---|---|---|
| 文件级（可重试） | 网络错误、5xx、429 | 退避重试，5 次后标 `failed` |
| 文件级（终局） | `file/type`、`level`、`review`、`rust/panic`、413 | 直接 `failed`，不再重试 |
| 账号级 | 403、402、realname、banned | **停批**，暂停监视，面板显示原因 |

账号级错误不自动恢复。不要"每 10 秒重试一次 403"，那是在刷站点接口。

## 8. 数据

### 8.1 `chrome.storage.local`

```ts
interface WatchSettings {
  dirName: string;          // 展示用，句柄在 IDB
  mode: 'backfill' | 'new-only';
  intervalSec: number;      // 5..300，默认 10
  recursive: boolean;       // 默认 false
  exts: string[];           // 默认 ['.evf']
  skipFail: boolean;        // 默认 true，跳过 *_fail 录像
  state: 'idle' | 'watching' | 'paused' | 'needs-permission' | 'stopped';
  lastScanAt?: number;
  lastError?: string;
}
```

### 8.2 IndexedDB（`yuanshen-helper` 升到 v2）

新增两个 store：

```ts
// watch-handle：单条记录
{ id: 'current', handle: FileSystemDirectoryHandle, savedAt: number }

// watch-files：key = 相对路径
interface WatchFile {
  relPath: string;
  size: number;
  mtime: number;
  status: 'seen' | 'queued' | 'done' | 'skipped' | 'ignored' | 'failed';
  firstSeenAt: number;
  attempts: number;
  nextAttemptAt: number;
  reason: string;
}
```

迁移：v1 → v2 只加 store，不动 `users` / `meta` / `identifierCache`。`db.ts` 里 `upgrade` 按 `oldVersion` 分支写。

### 8.3 台账清理

- `done` / `ignored` 保留 90 天，超过按 `firstSeenAt` 删除；
- `failed` 保留最近 200 条供界面展示，其余删；
- 提供「清空台账」按钮，明确提示：清空后会把目录里已有文件当新文件处理。

## 9. 界面

放在 side panel（能常驻、有用户手势、可随时打开）：

```
┌ 监视目录   records                    [选择目录] [重新授权]
├ 启动方式   ● 补传已有录像   ○ 只上传新录像
├ 扫描间隔   [10] 秒   （实际 10 秒）
├ 选项       ☐ 包含子目录   ☑ 跳过未完成局
├ 状态       监视中 · 上次扫描 12:03:41 · 待传 3 · 已传 128 · 失败 1
├ [暂停]  [立即扫描]  [重试失败 1]  [清空台账]
└ 日志（最近 50 条：时间 / 文件名 / 结果 / state）
```

- 状态文案必须区分：`监视中 / 已暂停 / 需要重新授权 / 已停止（未登录）/ 已停止（额度满）/ 已停止（未实名）`；
- 计数只增不清零（换目录时重置）；
- 工具栏 badge 显示待传数量，停用时清空；
- 「重新授权」按钮只在 `queryPermission()` 返回 `prompt` 时出现。

## 10. 边界情况

| 场景 | 表现 | 处理 |
|---|---|---|
| 目录被删 / 改名 | `NotFoundError` | 暂停 + 提示重新选择目录 |
| 权限被撤销 | `queryPermission() !== 'granted'` | 状态转 `needs-permission`，不重试上传 |
| 文件被占用 / 读失败 | `NotReadableError` | 跳过本轮，下轮再试（最多 5 次） |
| 站点标签页被关 | `sendMessage` 报 no receiver | 自动开一个后台标签页；仍失败则暂停并提示 |
| 用户退出登录 | 403 | 停批 + 提示登录 |
| 暂停期间新增文件 | 台账里没有 | 「继续」时自动补上（不是忽略） |
| 浏览器重启 | 句柄失效 | 状态转 `needs-permission`，用户点一次即可继续 |
| 同时开两个面板 | 双循环 | IDB 事务里加 tick 锁（`lastTickOwner` + 时间戳） |

## 11. 与站点原生实现的对照

| 点 | 原生 | 本方案 | 原因 |
|---|---|---|---|
| 轮询主体 | 页面 `setInterval`，默认 3s | offscreen 10s + alarms 看门狗 | 页面关掉就停 |
| 水位线 | 内存 `Set<string>` | IDB 台账 | 刷新 / 重启不重放 |
| 取消 | `generation` 世代号 | 沿用 | 在途流程必须能干净退出 |
| 背压 | `await listener(event)` | 沿用（队列串行 + 入队上限） | 避免并发打满限流 |
| 两种模式 | `start(emitExisting)` | 启动时 `baseline()` | 语义一致 |
| 解析 | ms-toollib WASM | 不解析 | 服务端会校验，省一个 WASM 依赖 |
| 失败 | 只计数 | 分级 + 退避重试 | 网络抖动不该让人手动点 |
| 未完成局 | 本地过滤，算失败 | 靠服务端，算跳过 | 不算失败更符合直觉 |

**从原生实现直接继承的三条不变量**（写代码时不要"优化"掉）：

1. 暂停 / 继续时 `knownFiles` 不清空 → 不重放；
2. 每个 `await` 之后校验 `generation` → 取消后不再继续；
3. 扫描内逐条 `await`，不做并发 → 天然串行。

## 12. 代码落点

```text
src/background/index.ts             SW：alarms 看门狗、消息路由、badge
src/offscreen/index.html / index.ts 扫描循环 + 上传队列
src/content/upload.ts               content script：同源 POST
src/features/upload-watch/
  model.ts   类型、状态迁移
  store.ts   IDB：句柄、台账、tick 锁
  scanner.ts 列目录、diff、稳定性判定
  queue.ts   入队、串行消费、退避
  api.ts     响应归一化与错误映射
  view.ts    面板 UI
```

`manifest.json` 增量：

```jsonc
"permissions": ["storage", "alarms", "offscreen"],
"content_scripts": [{ "matches": ["https://openms.top/*"], "js": ["content/upload.js"] }]
```

host 权限已有，不用改。

## 13. 实现记录（v0.2.0）

已落地并在真机跑通（自动上传两盘录像，站点返回 `已通过`）。与设计的差异：

| 项 | 实现 |
|---|---|
| 传输 | 录像字节 base64 后经消息传给内容脚本（`chrome.runtime.sendMessage` 是 JSON 序列化，不能直接传 ArrayBuffer） |
| 调度 | 扫描与上传是**两个独立循环**：扫描按间隔跑，上传连续消费队列（每批 20 条、条间 300ms），扫描不再阻塞上传；`chrome.alarms` 60 秒看门狗负责拉起与重建，未做 30 秒降级分支 |
| **offscreen 的 API 面** | **实测 offscreen 文档里 `chrome.storage` 是 `undefined`（只有 `chrome.runtime`）**，设置 / 状态 / 日志全部改由 SW 代读写（`bridge.ts`）。第一版直接调 `chrome.storage`，表现为后台静默不干活 |
| 权限 | offscreen 里 `queryPermission()` 可能返回 `prompt`，不直接停；只有真的抛 `NotAllowedError` 才转 `needs-permission` |
| 扫描预算 | 只把真正需要 `getFile()` 的文件计入 `maxEntries`，避免台账变大后每轮在已处理文件上打转 |
| 默认值 | 间隔 10 秒，范围 5–300 秒；扩展名默认 `.evf`；不递归；跳过 `_fail` |

代码位置：

- `src/features/upload-watch/` —— 扫描、队列、响应映射、台账、页面 UI
- `src/offscreen/main.ts` —— 常驻循环
- `src/background/index.ts` —— 看门狗、标签页转发、badge
- `src/content/upload.ts` —— 同源上传
