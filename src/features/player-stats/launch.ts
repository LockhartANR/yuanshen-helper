/**
 * 玩家页启动模式解析。
 *
 * 同一个 player.html 同时承载三种入口：
 * - 普通玩家页（`?id=16`，可选 `view=analysis`）
 * - 独立 CSV（`?source=csv`，不需要玩家 ID，不加载网站数据）
 * - 站内嵌入（`?id=16&embed=analysis`，固定显示大表）
 *
 * 所有参数先解析成明确的判别联合，再创建页面、发起请求；
 * 未知参数值一律报错，不在“另一种模式”里静默继续。
 */

export type PlayerPage = 'score' | 'analysis'

export type PlayerLaunch =
  | { kind: 'csv'; initialPage: PlayerPage }
  | {
      kind: 'site'
      userId: number
      initialPage: PlayerPage
      embedded: boolean
    }

export type PlayerLaunchResult =
  | { ok: true; launch: PlayerLaunch }
  | { ok: false; message: string }

export interface PlayerLaunchContext {
  /** 页面是否运行在外部 iframe 中；外部嵌入只允许 embed 模式启动。 */
  framed?: boolean
}

export const PLAYER_ID_ERROR = '链接里缺少合法的用户 ID，例如 player.html?id=16。'

function fail(message: string): PlayerLaunchResult {
  return { ok: false, message }
}

/** 只接受正的安全整数，不接受 0、负数、小数、科学计数法或空串。 */
export function parsePlayerId(raw: string | null | undefined): number | null {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (!/^\d+$/.test(text)) return null
  const value = Number(text)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

export function parsePlayerLaunch(
  search: string,
  context: PlayerLaunchContext = {},
): PlayerLaunchResult {
  const params = new URLSearchParams(search)
  const source = params.get('source')
  const embed = params.get('embed')
  const view = params.get('view')

  if (source !== null && source !== 'csv') {
    return fail(`未知的 source 参数：${source}。`)
  }
  if (embed !== null && embed !== 'analysis') {
    return fail(`未知的 embed 参数：${embed}。`)
  }
  if (view !== null && view !== 'score' && view !== 'analysis') {
    return fail(`未知的 view 参数：${view}。`)
  }
  if (source === 'csv' && embed !== null) {
    return fail('source=csv 不能和 embed=analysis 同时使用。')
  }
  if (context.framed === true && embed === null) {
    return fail('这个页面只能在站内嵌入模式（embed=analysis）中打开。')
  }

  const requestedPage: PlayerPage = view === 'analysis' ? 'analysis' : 'score'
  // 独立 CSV 不绑定网站玩家：即使 URL 里带了 ID，也不据此加载任何网站数据。
  if (source === 'csv') {
    // 独立 CSV 默认直接进赛博大表，同时允许显式 view=score 打开成绩概况。
    return {
      ok: true,
      launch: { kind: 'csv', initialPage: view === 'score' ? 'score' : 'analysis' },
    }
  }

  const userId = parsePlayerId(params.get('id'))
  if (userId === null) {
    return fail(
      embed === null ? PLAYER_ID_ERROR : `嵌入模式需要合法的玩家 ID，例如 player.html?id=16&embed=analysis。`,
    )
  }
  if (embed !== null && view === 'score') {
    return fail('嵌入模式只显示赛博大表，不能同时指定 view=score。')
  }

  return {
    ok: true,
    launch: {
      kind: 'site',
      userId,
      initialPage: embed === null ? requestedPage : 'analysis',
      embedded: embed !== null,
    },
  }
}

/**
 * 解析站点 hash 路由里的玩家页，例如 `#/player/16`、`#/player/16/`、
 * `#/player/16?from=search`。未知的尾部路径变体返回 null，交给调用方决定是否显示入口。
 */
export function parseSitePlayerRoute(hash: string): number | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  const path = raw.split('?')[0] ?? ''
  const segments = path.split('/').filter((segment) => segment !== '')
  // 站点会把 #/player/<ID> 重定向到 #/player/<ID>/top；
  // 第三个路径段是玩家页内的页签（top 等），只允许单段，避免把更深的站点路由误判成玩家页。
  if (segments[0] !== 'player' || segments.length < 2 || segments.length > 3) return null
  try {
    return parsePlayerId(decodeURIComponent(segments[1] ?? ''))
  } catch {
    return null
  }
}
