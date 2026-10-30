import type { PlayerVideoRow } from '../../shared/db'
import { fetchVideoDetails, fetchVideoList } from './api'
import { putRows, readUserMeta, readUserRows, saveFetchedAt } from './store'

const CACHE_TTL_MS = 24 * 60 * 60 * 1000

export interface FetchProgress {
  done: number
  total: number
}

export interface PlayerLoadOptions {
  signal?: AbortSignal
  force?: boolean
  /** 覆盖接口地址，测试和本地调试用；默认读设置里的 apiBase。 */
  baseUrl?: string
  onProgress?: (progress: FetchProgress) => void
}

export interface LoadedPlayer {
  userId: number
  rows: PlayerVideoRow[]
  fetchedAt: number
  fromCache: boolean
  /** 明细请求没拿到的 ID（公开状态可能在两次请求之间变化）。 */
  missing: number[]
}

/**
 * 列表来自 `videolist`，明细来自 `staticdetailbatch`。
 * 只抓 `state === 'c'` 且非比赛的明细；未过审的等开关打开时再用 `ensureDetails` 补。
 */
export async function loadPlayer(
  userId: number,
  options: PlayerLoadOptions = {},
): Promise<LoadedPlayer> {
  const [cached, meta] = await Promise.all([readUserRows(userId), readUserMeta(userId)])
  const fresh = meta !== undefined && Date.now() - meta.fetchedAt < CACHE_TTL_MS
  if (!options.force && fresh && cached.length > 0) {
    return { userId, rows: cached, fetchedAt: meta.fetchedAt, fromCache: true, missing: [] }
  }

  const metas = await fetchVideoList(userId, { signal: options.signal, baseUrl: options.baseUrl })
  const cachedById = new Map(cached.map((row) => [row.id, row]))
  const rows: PlayerVideoRow[] = metas.map((meta) => {
    const previous = cachedById.get(meta.id)
    return {
      userId,
      id: meta.id,
      state: meta.state,
      uploadTime: meta.upload_time,
      ongoing: meta.ongoing_tournament === true,
      detail: previous?.detail ?? null,
    }
  })

  const present = new Set(rows.map((row) => row.id))
  const removed = cached.filter((row) => !present.has(row.id)).map((row) => row.id)

  const need = rows
    .filter((row) => row.state === 'c' && !row.ongoing && row.detail === null)
    .map((row) => row.id)

  let missing: number[] = []
  if (need.length > 0) {
    const result = await fetchVideoDetails(need, {
      signal: options.signal,
      baseUrl: options.baseUrl,
      onBatch: (done, total) => options.onProgress?.({ done, total }),
    })
    const byId = new Map(result.details.map((detail) => [detail.id, detail]))
    for (const row of rows) {
      const detail = byId.get(row.id)
      if (detail) row.detail = detail
    }
    missing = result.missing
  }

  await putRows(userId, rows, removed)
  await saveFetchedAt(userId)
  return { userId, rows, fetchedAt: Date.now(), fromCache: false, missing }
}

/** 补抓还没拿过明细的录像（用于「含未过审」开关）。 */
export async function ensureDetails(
  userId: number,
  rows: PlayerVideoRow[],
  ids: number[],
  options: PlayerLoadOptions = {},
): Promise<{ rows: PlayerVideoRow[]; missing: number[] }> {
  const wanted = new Set(ids)
  const need = rows.filter((row) => wanted.has(row.id) && row.detail === null)
  if (need.length === 0) return { rows, missing: [] }

  const result = await fetchVideoDetails(
    need.map((row) => row.id),
    {
      signal: options.signal,
      baseUrl: options.baseUrl,
      onBatch: (done, total) => options.onProgress?.({ done, total }),
    },
  )
  const byId = new Map(result.details.map((detail) => [detail.id, detail]))
  const updated = rows.map((row) => {
    const detail = byId.get(row.id)
    return detail ? { ...row, detail } : row
  })
  await putRows(userId, updated.filter((row) => byId.has(row.id)))
  return { rows: updated, missing: result.missing }
}
