import { getSettings } from '../../shared/settings'
import { isAbortError, sleep } from '../../shared/ui'
import { ApiError } from '../user-search/api'

export interface RankingApiOptions {
  baseUrl?: string
  signal?: AbortSignal
  /** 测试或调试可缩短；生产默认至少 1.25 秒。 */
  gapMs?: number
  timeoutMs?: number
  maxRetries?: number
}

const DEFAULT_GAP_MS = 1_250
const DEFAULT_TIMEOUT_MS = 20_000
const BACKOFF_MS = [2_000, 4_000, 8_000, 16_000]

let lastRequestAt = 0
let requestQueue: Promise<void> = Promise.resolve()

function asSafeId(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const at = Date.parse(value)
  if (!Number.isFinite(at)) return null
  return Math.max(0, at - Date.now())
}

async function resolveBase(options: RankingApiOptions): Promise<string> {
  if (options.baseUrl) return options.baseUrl.replace(/\/+$/, '')
  return (await getSettings()).apiBase.replace(/\/+$/, '')
}

async function serializeRequest<T>(
  operation: () => Promise<T>,
  gapMs: number,
  signal?: AbortSignal,
): Promise<T> {
  let release!: () => void
  const previous = requestQueue
  requestQueue = new Promise<void>((resolve) => {
    release = resolve
  })
  try {
    await previous
    const wait = lastRequestAt + gapMs - Date.now()
    if (wait > 0) await sleep(wait, signal)
    return await operation()
  } finally {
    release()
  }
}

async function requestArray<T>(
  path: string,
  options: RankingApiOptions,
  defaultGapMs = DEFAULT_GAP_MS,
): Promise<T[]> {
  const base = await resolveBase(options)
  const gapMs = Math.max(0, options.gapMs ?? defaultGapMs)
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const maxRetries = Math.max(0, options.maxRetries ?? 4)

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (options.signal?.aborted) throw new ApiError('aborted', '已取消')
    const response = await serializeRequest(async () => {
      const timeout = AbortSignal.timeout(timeoutMs)
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
      try {
        return await fetch(`${base}${path}`, {
          signal,
          credentials: 'omit',
          cache: 'no-store',
          headers: { Accept: 'application/json' },
        })
      } catch (error) {
        if (options.signal?.aborted || isAbortError(error)) {
          throw new ApiError('aborted', '已取消')
        }
        if (timeout.aborted) throw new ApiError('network', '请求超时')
        throw new ApiError('network', '网络不可用')
      } finally {
        lastRequestAt = Date.now()
      }
    }, gapMs, options.signal)

    if (response.ok) {
      let text: string
      try {
        text = await response.text()
      } catch (error) {
        if (options.signal?.aborted || isAbortError(error)) {
          throw new ApiError('aborted', '已取消')
        }
        throw new ApiError('network', '读取响应失败')
      }
      let data: unknown
      try {
        data = JSON.parse(text)
      } catch {
        throw new ApiError('format', '返回格式异常（不是 JSON）', response.status)
      }
      if (!Array.isArray(data)) {
        throw new ApiError('format', '接口返回格式异常（应为数组）', response.status)
      }
      return data as T[]
    }

    const status = response.status
    if ((status === 429 || status >= 500) && attempt < maxRetries) {
      const retryAfter = parseRetryAfter(response.headers.get('Retry-After'))
      const backoff = Math.max(retryAfter ?? 0, BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 0)
      try {
        await sleep(backoff, options.signal)
      } catch {
        throw new ApiError('aborted', '已取消')
      }
      continue
    }
    if (status === 429) throw new ApiError('rate', '触发频率限制，请稍后再试', status)
    if (status === 404) throw new ApiError('notfound', '接口不存在或数据已不可见', status)
    if (status >= 500) throw new ApiError('server', `服务器错误（HTTP ${status}）`, status)
    throw new ApiError('http', `请求失败（HTTP ${status}）`, status)
  }

  throw new ApiError('network', '网络不可用')
}

function objectRows(rows: unknown[], endpoint: string): Record<string, unknown>[] {
  let invalid = 0
  for (const item of rows) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) invalid += 1
  }
  if (invalid > 0) {
    throw new ApiError('format', `${endpoint} 返回 ${invalid} 个非法数组元素`)
  }
  return rows as Record<string, unknown>[]
}

export async function fetchPlayerInfos(
  ids: number[],
  options: RankingApiOptions = {},
): Promise<Record<string, unknown>[]> {
  if (ids.length === 0) return []
  if (ids.length > 100) throw new Error('玩家资料每批最多 100 个 ID')
  if (!ids.every((id) => asSafeId(id) !== null)) throw new Error('玩家 ID 列表不合法')
  return objectRows(await requestArray<unknown>(
    `/api/userprofile/infobulk?ids=${ids.join(',')}`,
    options,
    1_250,
  ), 'infobulk')
}

export async function fetchDetailBucket(
  first: number,
  count: number,
  options: RankingApiOptions = {},
): Promise<Record<string, unknown>[]> {
  if (asSafeId(first) === null || !Number.isSafeInteger(count) || count < 1 || count > 500) {
    throw new Error('detailbulk 区间不合法')
  }
  return objectRows(await requestArray<unknown>(
    `/api/video/detailbulk?first=${first}&count=${count}`,
    options,
    1_250,
  ), 'detailbulk')
}

export async function fetchStaticDetails(
  ids: number[],
  options: RankingApiOptions = {},
): Promise<Record<string, unknown>[]> {
  if (ids.length === 0) return []
  if (ids.length > 100) throw new Error('staticdetailbatch 每批最多 100 个 ID')
  if (!ids.every((id) => asSafeId(id) !== null)) throw new Error('录像 ID 列表不合法')
  return objectRows(await requestArray<unknown>(
    `/api/video/staticdetailbatch?ids=${ids.join(',')}`,
    options,
    250,
  ), 'staticdetailbatch')
}

export async function fetchAbstractBucket(
  first: number,
  count: number,
  options: RankingApiOptions = {},
): Promise<Record<string, unknown>[]> {
  if (asSafeId(first) === null || !Number.isSafeInteger(count) || count < 1 || count > 10_000) {
    throw new Error('abstractbulk 区间不合法')
  }
  return objectRows(await requestArray<unknown>(
    `/api/video/abstractbulk?first=${first}&count=${count}`,
    options,
    2_000,
  ), 'abstractbulk')
}
