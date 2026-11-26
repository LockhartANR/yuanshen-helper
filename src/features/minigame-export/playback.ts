import { SITE_ORIGIN } from '../../shared/constants'
import {
  isMinigame, isObject, parseHistoryRecord, parseReplayRecord, safeInteger,
  type HistoryRecord, type JsonObject, type Minigame, type ReplayRecord,
} from './model'

export const PLAYBACK_BRIDGE = 'YUANSHEN_MINIGAME_CAPTURE'
export const PLAYBACK_FRAME = 'YUANSHEN_MINIGAME_DECODE'

export type PlaybackTarget =
  | { kind: 'local'; game: Minigame; id: number }
  | { kind: 'online'; game: Minigame; playerId: number; key: string }

export type PlaybackSnapshot =
  | { target: Extract<PlaybackTarget, { kind: 'local' }>; record: HistoryRecord }
  | { target: Extract<PlaybackTarget, { kind: 'online' }>; record: ReplayRecord }

/** Accept only unambiguous native playback links; a player ID is never a local record ID. */
export function playbackTarget(href: string): PlaybackTarget | null {
  try {
    const url = new URL(href)
    if (url.origin !== SITE_ORIGIN || !url.hash.startsWith('#/minigame/')) return null
    const route = new URL(url.hash.slice(1), url.origin)
    const match = /^\/minigame\/([^/]+)\/?$/.exec(route.pathname)
    const game = match?.[1]
    if (!isMinigame(game)) return null
    const params = route.searchParams
    if (['history', 'player', 'key'].some((key) => params.getAll(key).length > 1)) return null
    const history = params.get('history')
    if (history !== null) {
      const id = Number(history)
      return /^\d+$/.test(history) && safeInteger(id, 1) && !params.has('player') && !params.has('key')
        ? { kind: 'local', game, id } : null
    }
    const player = params.get('player') ?? ''
    const playerId = Number(player)
    const key = params.get('key') ?? ''
    return /^\d+$/.test(player) && safeInteger(playerId, 1) && /^[a-z0-9.-]{1,120}$/.test(key)
      ? { kind: 'online', game, playerId, key } : null
  } catch { return null }
}

export function targetIdentity(target: PlaybackTarget | null): string {
  return target === null ? '' : target.kind === 'local'
    ? `${target.game}:local:${target.id}` : `${target.game}:online:${target.playerId}:${target.key}`
}

export function onlineRequestTarget(href: string, method: string): Extract<PlaybackTarget, { kind: 'online' }> | null {
  try {
    const url = new URL(href, SITE_ORIGIN)
    const match = /^\/api\/minigame\/([^/]+)\/replay$/.exec(url.pathname)
    if (method.toUpperCase() !== 'GET' || url.origin !== SITE_ORIGIN || !match) return null
    const target = playbackTarget(`${SITE_ORIGIN}/#/minigame/${match[1]}?${url.searchParams}`)
    return target?.kind === 'online' ? target : null
  } catch { return null }
}

/** Native v1 ranking definitions. Unknown versions fail explicitly instead of inventing a mode. */
export function onlineMode(target: Extract<PlaybackTarget, { kind: 'online' }>): JsonObject {
  const match = /^([bie])(?:-(25|50|75|87\.5))?-v1$/.exec(target.key)
  if (!match) throw new Error('尚不支持此线上录像模式或版本')
  const key = match[1]
  const value = match[2] === undefined ? undefined : Number(match[2])
  const rows = key === 'b' ? 8 : 16
  const columns = key === 'e' ? 30 : rows
  if (target.game === 'left-click' || target.game === 'multi-touch') {
    if (value !== 50 && value !== 75 && value !== 87.5) throw new Error('线上录像密度无效')
    return { key, rows, columns, density: value }
  }
  if (target.game === 'reaction') {
    if (value !== 25 && value !== 50) throw new Error('线上录像概率无效')
    return { key, length: key === 'b' ? 5 : key === 'i' ? 10 : 20,
      target: key === 'b' ? 10 : key === 'i' ? 20 : 40, probability: value,
      rankingKey: `${target.game}-${target.key}` }
  }
  if (value !== undefined) throw new Error('线上录像模式无效')
  if (target.game === 'flag-chord') {
    if (key === 'e') throw new Error('线上标双难度无效')
    return { key, rows, columns, total: key === 'b' ? 4 : 15 }
  }
  return { key, rows, columns, mines: key === 'b' ? 10 : key === 'i' ? 40 : 99 }
}

export function parsePlaybackSnapshot(value: unknown): PlaybackSnapshot {
  if (!isObject(value) || typeof value.url !== 'string') throw new Error('当前录像响应无效')
  const target = playbackTarget(value.url)
  if (!target) throw new Error('当前录像链接无效')
  if (target.kind === 'local') {
    const record = parseHistoryRecord(value.record)
    if (record.metadata.game !== target.game || record.metadata.id !== target.id) throw new Error('当前本地录像不一致')
    return { target, record }
  }
  const record = parseReplayRecord(value.record)
  if (record.metadata.game !== target.game || JSON.stringify(record.metadata.mode) !== JSON.stringify(onlineMode(target))) {
    throw new Error('当前线上录像模式不一致')
  }
  return { target, record }
}
