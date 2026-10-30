import { getSettings } from '../../shared/settings'
import { isAbortError, sleep } from '../../shared/ui'
import { ApiError } from '../user-search/api'
import type { VideoDetail, VideoMeta } from './model'

/** 列表接口 1 次/秒。 */
const LIST_GAP_MS = 1_000
/** 明细接口 5 次/秒，留一点余量。 */
const BATCH_GAP_MS = 260
const DETAIL_BATCH_SIZE = 100

const BACKOFF_MS = [2_000, 4_000, 8_000]

let lastRequestAt = 0

export interface PlayerApiOptions {
  signal?: AbortSignal
  baseUrl?: string
  /** 明细分批进度：已完成的批数 / 总批数。 */
  onBatch?: (done: number, total: number) => void
}

export interface UserInfo {
  id: number
  username: string
  realname: string
}

async function resolveBase(options: PlayerApiOptions): Promise<string> {
  if (options.baseUrl) return options.baseUrl.replace(/\/+$/, '')
  const settings = await getSettings()
  return settings.apiBase.replace(/\/+$/, '')
}

async function waitGap(minGapMs: number, signal?: AbortSignal): Promise<void> {
  const wait = lastRequestAt + minGapMs - Date.now()
  if (wait <= 0) return
  try {
    await sleep(wait, signal)
  } catch {
    throw new ApiError('aborted', '已取消')
  }
}

async function requestJson<T>(
  path: string,
  minGapMs: number,
  options: PlayerApiOptions,
): Promise<T> {
  const base = await resolveBase(options)

  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt += 1) {
    if (options.signal?.aborted) throw new ApiError('aborted', '已取消')
    await waitGap(minGapMs, options.signal)

    lastRequestAt = Date.now()

    let response: Response
    try {
      response = await fetch(`${base}${path}`, {
        signal: options.signal,
        credentials: 'omit',
        cache: 'no-store',
      })
    } catch (error) {
      if (options.signal?.aborted || isAbortError(error)) {
        throw new ApiError('aborted', '已取消')
      }
      if (attempt < BACKOFF_MS.length) {
        await sleep(BACKOFF_MS[attempt]!, options.signal)
        continue
      }
      throw new ApiError('network', '网络不可用')
    }

    if (response.ok) {
      try {
        return (await response.json()) as T
      } catch {
        throw new ApiError('format', '返回格式异常（不是 JSON）', response.status)
      }
    }

    const status = response.status
    if ((status === 429 || status >= 500) && attempt < BACKOFF_MS.length) {
      await sleep(BACKOFF_MS[attempt]!, options.signal)
      continue
    }
    if (status === 404) {
      throw new ApiError('notfound', '接口不存在，站点可能已升级', status)
    }
    if (status === 429) {
      throw new ApiError('rate', '触发频率限制，请稍后再试', status)
    }
    throw new ApiError('http', `请求失败（HTTP ${status}）`, status)
  }

  throw new ApiError('network', '网络不可用')
}

function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error('chunk size must be positive')
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

function asMeta(value: unknown): VideoMeta | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  if (typeof row.id !== 'number' || !Number.isSafeInteger(row.id) || row.id <= 0) return null
  return {
    id: row.id,
    upload_time: typeof row.upload_time === 'string' ? row.upload_time : '',
    state: typeof row.state === 'string' ? row.state : '',
    ongoing_tournament: row.ongoing_tournament === true,
  }
}

function asDetail(value: unknown): VideoDetail | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  if (typeof row.id !== 'number' || typeof row.timems !== 'number') return null
  const nullableNumber = (input: unknown): number | null =>
    typeof input === 'number' && Number.isFinite(input) ? input : null
  return {
    id: row.id,
    software: typeof row.software === 'string' ? row.software : '',
    level: typeof row.level === 'string' ? row.level : '',
    mode: typeof row.mode === 'string' ? row.mode : '',
    end_time: typeof row.end_time === 'string' ? row.end_time : null,
    timems: row.timems,
    bv: nullableNumber(row.bv),
    left: nullableNumber(row.left),
    right: nullableNumber(row.right),
    double: nullableNumber(row.double),
    left_ce: nullableNumber(row.left_ce),
    right_ce: nullableNumber(row.right_ce),
    double_ce: nullableNumber(row.double_ce),
  }
}

export async function fetchVideoList(
  userId: number,
  options: PlayerApiOptions = {},
): Promise<VideoMeta[]> {
  const data = await requestJson<unknown>(
    `/api/userprofile/videolist?user_id=${userId}`,
    LIST_GAP_MS,
    options,
  )
  if (!Array.isArray(data)) throw new ApiError('format', '返回格式异常（videolist）')
  const metas: VideoMeta[] = []
  for (const item of data) {
    const meta = asMeta(item)
    if (meta) metas.push(meta)
  }
  return metas
}

async function fetchDetailBatch(
  ids: number[],
  options: PlayerApiOptions,
): Promise<VideoDetail[]> {
  const data = await requestJson<unknown>(
    `/api/video/staticdetailbatch?ids=${ids.join(',')}`,
    BATCH_GAP_MS,
    options,
  )
  if (!Array.isArray(data)) throw new ApiError('format', '返回格式异常（staticdetailbatch）')
  const details: VideoDetail[] = []
  for (const item of data) {
    const detail = asDetail(item)
    if (detail) details.push(detail)
  }
  return details
}

/**
 * 分批拉明细：每批 100 个 ID，串行 260ms。
 * 缺失的 ID 会再补一轮（公开状态可能在两次请求之间变化）。
 */
export async function fetchVideoDetails(
  ids: number[],
  options: PlayerApiOptions = {},
): Promise<{ details: VideoDetail[]; missing: number[] }> {
  const unique = [...new Set(ids)]
  const batches = chunk(unique, DETAIL_BATCH_SIZE)
  const collected = new Map<number, VideoDetail>()

  for (const [index, batch] of batches.entries()) {
    for (const detail of await fetchDetailBatch(batch, options)) {
      collected.set(detail.id, detail)
    }
    options.onBatch?.(index + 1, batches.length)
  }

  const missing = unique.filter((id) => !collected.has(id))
  if (missing.length > 0) {
    for (const batch of chunk(missing, DETAIL_BATCH_SIZE)) {
      for (const detail of await fetchDetailBatch(batch, options)) {
        collected.set(detail.id, detail)
      }
    }
  }

  return {
    details: [...collected.values()],
    missing: unique.filter((id) => !collected.has(id)),
  }
}

export async function fetchUserInfo(
  userId: number,
  options: PlayerApiOptions = {},
): Promise<UserInfo | null> {
  const data = await requestJson<unknown>(`/api/userprofile/info/${userId}`, 300, options)
  if (!data || typeof data !== 'object') return null
  const row = data as Record<string, unknown>
  if (typeof row.id !== 'number') return null
  return {
    id: row.id,
    username: typeof row.username === 'string' ? row.username : '',
    realname: typeof row.realname === 'string' ? row.realname : '',
  }
}
