import { SITE_ORIGIN } from '../../shared/constants'

export const HISTORY_MESSAGE = 'YUANSHEN_MINIGAME_HISTORY'
export const HISTORY_DATABASE = 'saolei-minigame'
export const HISTORY_STORE = 'results'
export const HISTORY_PAGE_SIZE = 100
export const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024
export const MAX_REPLAY_BYTES = 64 * 1024 * 1024

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject
export interface JsonObject { [key: string]: JsonValue }

export const GAME_LABELS = {
  'left-click': '左键训练',
  'multi-touch': '多指训练',
  'flag-chord': '标双训练',
  'missing-cell': '漏雷训练',
  reaction: '反应训练',
}
export type Minigame = keyof typeof GAME_LABELS

export interface HistoryMetadata {
  id: number
  game: Minigame
  mode: JsonObject
  scoreMs: number
  playedAt: number
}

export interface HistoryIssue { id: number | null; error: string }

export interface HistoryPage {
  databaseVersion: number | null
  upperId: number
  nextAfterId: number | null
  entries: HistoryMetadata[]
  issues: HistoryIssue[]
}

export type ReplayPayload =
  | { encoding: '7z'; data: string }
  | { encoding: 'json'; data: JsonObject }

export interface HistoryRecord {
  metadata: HistoryMetadata
  payload: ReplayPayload
}

export type HistoryRequest =
  | { type: typeof HISTORY_MESSAGE; action: 'list'; afterId: number; upperId?: number; databaseVersion?: number }
  | { type: typeof HISTORY_MESSAGE; action: 'read'; databaseVersion: number; expected: HistoryMetadata }

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 32) return false
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every((item: unknown) => isJsonValue(item, depth + 1))
  if (!isObject(value) || Object.getPrototypeOf(value) !== Object.prototype) return false
  return Object.values(value).every((item) => isJsonValue(item, depth + 1))
}

export function jsonObject(value: unknown, maxBytes = MAX_REPLAY_BYTES): JsonObject {
  if (!isObject(value) || !isJsonValue(value)) throw new Error('数据不是有效的 JSON 对象')
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maxBytes) {
    throw new Error('数据过大，无法安全导出')
  }
  return value
}

export function safeInteger(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
}

export function isMinigame(value: unknown): value is Minigame {
  return typeof value === 'string' && Object.hasOwn(GAME_LABELS, value)
}

export function parseMetadata(value: unknown): HistoryMetadata {
  if (!isObject(value) || !safeInteger(value.id, 1) || !isMinigame(value.game)
    || !safeInteger(value.scoreMs, 1) || !safeInteger(value.playedAt)
    || value.playedAt > 8_640_000_000_000_000) {
    throw new Error('历史记录的编号、游戏、成绩或日期无效')
  }
  const mode = jsonObject(value.mode, 16 * 1024)
  if (typeof mode.key !== 'string' || !mode.key.length || mode.key.length > 120) {
    throw new Error('历史记录缺少有效的模式')
  }
  return { id: value.id, game: value.game, mode, scoreMs: value.scoreMs, playedAt: value.playedAt }
}

export function sameMetadata(left: HistoryMetadata, right: HistoryMetadata): boolean {
  return left.id === right.id && left.game === right.game && left.playedAt === right.playedAt
    && left.scoreMs === right.scoreMs && JSON.stringify(left.mode) === JSON.stringify(right.mode)
}

export function parseHistoryRequest(value: unknown): HistoryRequest {
  if (!isObject(value) || value.type !== HISTORY_MESSAGE) throw new Error('未知的历史读取消息')
  if (value.action === 'list' && safeInteger(value.afterId)
    && (value.upperId === undefined || safeInteger(value.upperId))
    && (value.databaseVersion === undefined || safeInteger(value.databaseVersion, 1))) {
    return { type: HISTORY_MESSAGE, action: 'list', afterId: value.afterId,
      ...(value.upperId === undefined ? {} : { upperId: value.upperId }),
      ...(value.databaseVersion === undefined ? {} : { databaseVersion: value.databaseVersion }) }
  }
  if (value.action === 'read' && safeInteger(value.databaseVersion, 1)) {
    return { type: HISTORY_MESSAGE, action: 'read', databaseVersion: value.databaseVersion,
      expected: parseMetadata(value.expected) }
  }
  throw new Error('历史读取参数无效')
}

export function parseHistoryPage(value: unknown): HistoryPage {
  if (!isObject(value) || (value.databaseVersion !== null && !safeInteger(value.databaseVersion, 1))
    || !safeInteger(value.upperId) || (value.nextAfterId !== null && !safeInteger(value.nextAfterId, 1))
    || !Array.isArray(value.entries) || value.entries.length > HISTORY_PAGE_SIZE
    || !Array.isArray(value.issues) || value.issues.length > HISTORY_PAGE_SIZE) {
    throw new Error('站点返回的历史列表格式无效')
  }
  return { databaseVersion: value.databaseVersion, upperId: value.upperId, nextAfterId: value.nextAfterId,
    entries: value.entries.map((entry: unknown) => parseMetadata(entry)),
    issues: value.issues.map((issue: unknown) => {
      if (!isObject(issue) || (issue.id !== null && !safeInteger(issue.id, 1)) || typeof issue.error !== 'string') {
        throw new Error('历史读取错误信息无效')
      }
      return { id: issue.id, error: issue.error }
    }) }
}

export function parseHistoryRecord(value: unknown): HistoryRecord {
  if (!isObject(value) || !isObject(value.payload)) throw new Error('站点返回的录像格式无效')
  const metadata = parseMetadata(value.metadata)
  const payload = value.payload
  if (payload.encoding === '7z' && typeof payload.data === 'string' && payload.data.length > 0
    && payload.data.length <= Math.ceil(MAX_ARCHIVE_BYTES / 3) * 4
    && payload.data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(payload.data)) {
    return { metadata, payload: { encoding: '7z', data: payload.data } }
  }
  if (payload.encoding === 'json') {
    return { metadata, payload: { encoding: 'json', data: jsonObject(payload.data) } }
  }
  throw new Error('录像编码无效或录像过大')
}

/** Site densities are percentage values; convert their decimal representation without rounding. */
export function densityFraction(value: JsonValue | undefined): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) return undefined
  const [coefficient, exponent = '0'] = String(value).split('e')
  const [whole, decimal = ''] = coefficient.split('.')
  let numerator = BigInt(whole + decimal)
  let denominator = 100n
  const scale = decimal.length - Number(exponent)
  if (scale >= 0) denominator *= 10n ** BigInt(scale)
  else numerator *= 10n ** BigInt(-scale)
  let a = numerator
  let b = denominator
  while (b !== 0n) [a, b] = [b, a % b]
  return `${numerator / a}/${denominator / a}`
}

export function modeLabel(mode: JsonObject): string {
  const level = mode.key === 'b' ? '初级' : mode.key === 'i' ? '中级' : mode.key === 'e' ? '高级' : String(mode.key)
  const parts = [level]
  if (safeInteger(mode.rows, 1) && safeInteger(mode.columns, 1)) parts.push(`${mode.rows}×${mode.columns}`)
  const density = densityFraction(mode.density)
  if (density) parts.push(`密度 ${density}`)
  if (typeof mode.probability === 'number') parts.push(`概率 ${mode.probability}%`)
  return parts.join(' · ')
}

/** The full mode is the identity; configurations with the same level key stay separate. */
export function modeIdentity(entry: HistoryMetadata): string {
  return `${entry.game}:${JSON.stringify(Object.entries(entry.mode).sort(([a], [b]) => a.localeCompare(b)))}`
}

export function localHistoryTarget(url: string): { game: Minigame; id: number } | null {
  try {
    const parsed = new URL(url)
    if (parsed.origin !== SITE_ORIGIN) return null
    const route = new URL(parsed.hash.slice(1), parsed.origin)
    const game = route.pathname.replace(/^\/minigame\//, '').replace(/\/$/, '')
    const raw = route.searchParams.get('history')
    if (!isMinigame(game) || !/^\d+$/.test(raw ?? '') || route.searchParams.has('player')
      || route.searchParams.has('key') || route.searchParams.getAll('history').length !== 1) return null
    const id = Number(raw)
    return safeInteger(id, 1) ? { game, id } : null
  } catch { return null }
}
