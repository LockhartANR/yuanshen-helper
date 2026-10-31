# 玩家数据（PB 表与前端成绩）

给站内任意用户重算 PB 和前端成绩，入口有两处：

- popup 搜索结果行右侧的图表按钮：看**别人**；
- popup 头部「我的成绩」：看**自己**，不用先搜自己。

两者都打开扩展页 `player.html?id=<用户ID>`。自己的 ID 优先取站点登录态（打开 openms.top 时由内容脚本记录），没有就弹窗让用户填一次，也可以在设置页「玩家数据」里改。

## 数据来源

| 接口 | 用途 | 限流 |
| --- | --- | --- |
| `GET /api/userprofile/videolist?user_id=N` | 全部录像的 `id / upload_time / state / ongoing_tournament` | 1/s |
| `GET /api/video/staticdetailbatch?ids=...` | 解析字段，单批 100 个 ID | 5/s |

明细只抓 `state === 'c'` 且非比赛录像；打开「含未过审」开关时才补抓 `a/b/d/e`，已抓过的走缓存。每批之间串行 260 ms，429 按 2/4/8 秒退避。

## 口径

| 维度 | 规则 |
| --- | --- |
| 等级 | `b` / `i` / `e`，自定义难度不计 |
| 模式 | `"00"` 标准，无猜等不计 |
| 审核状态 | 默认只要 `c` 已过审；开关可纳入 `a/b/d/e`，此时结果仅自用，和站点不一致 |
| 比赛录像 | `ongoing_tournament` 一律不计 |
| NF | `right_ce === 0`；NF 录像同时计入普通榜 |
| 无效成绩 | `bv` 为空或 `timems <= 0` 不计（站点 PB 会把 0ms 当纪录，我们不跟） |

## 指标

```
seconds = timems / 1000
3BVS    = bv / seconds
STNB    = 系数[等级] × bv / seconds^1.7    # 初 36，中 162，高 435
```

- **PB**：按 `(等级, 3BV)` 取用时最短的一条，并列依次比上传时间、ID；没有 3BV 下限。
- **前端成绩**：每个 `等级 × 指标 × 普通/NF` 取前 5，指标为用时（升序）、3BVS（降序）、STNB（降序），并列先用时短；沿用站点 3BV 下限：初 10 / 中 30 / 高 100。
- **判重**：等级+模式+3BV+用时+三种点击+三种 CE+结束时间完全一致视为同一局重复，保留上传最早的一条；缺结束时间时标为「疑似重复」。默认隐藏重复。
- **配色**：PB 格子按当前指标取色——用时按等级用 Beg/Int/Exp Time 三套门槛，3BVS 用 Bvs 门槛，STNB 用 STNB 门槛；门槛和颜色一一对应，超出最高门槛落到最后一段（透明）。文字颜色按背景感知亮度自动取黑或白。原始门槛与颜色见 [color-scheme.txt](color-scheme.txt)。
- **软件图标**：PB 格子和前端成绩的每个成绩前面显示录像所用软件的小图标（a=Arbiter、e=Metasweeper、m=Clone、r=Vienna）。
- **日期**：PB 表多一个「日期」页签，切过去后格子显示该条 PB 录像的结束日期，按本地时区输出 8 位数字（如 `20250524`）；结束时间缺失时显示 `—`。

## 缓存

Details 按 `[userId, id]` 存 IndexedDB，`fetchedAt` 单独记；24 小时内再次打开不请求，刷新只补新 ID。`state` 以每次的 `videolist` 为准，所以审核状态变化不需要重抓明细。

## 对拍

```bash
npm run verify:player -- 16
OPENMS_BASE=http://127.0.0.1:8000 npm run verify:player -- 16
```

脚本会拉一遍录像、本地重算，再和 `/api/speedranking/{pb,top}/player/{id}` 逐条比。已知站点侧差异会作为提示输出、不算失败：

- 站点 PB 里有 0ms 的脏数据；
- 站点 PB 缓存偶尔没跟上新过审的录像（我们算出的更快）。
