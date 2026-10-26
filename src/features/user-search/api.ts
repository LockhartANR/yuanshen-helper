import { PAGE_SIZE } from '../../shared/constants'
import { getSettings } from '../../shared/settings'
import { isAbortError, sleep } from '../../shared/ui'

export type ApiErrorKind =
  | 'rate'
  | 'server'
  | 'network'
  | 'notfound'
  | 'format'
  | 'toomany'
  | 'http'
  | 'aborted'

export class ApiError extends Error {
  readonly kind: ApiErrorKind
  readonly status?: number

  constructor(kind: ApiErrorKind, message: string, status?: number) {
    super(message)
    this.name = 'ApiError'
    this.kind = kind
    this.status = status
  }
}

export interface ApiOptions {
  signal?: AbortSignal
  /** Used by tests / local debugging; defaults to the saved setting. */
  baseUrl?: string
  minGapMs?: number
  backoffMs?: number[]
  maxRetries?: number
}

export interface IdentifierItem {
  /** The site API calls this field "identifier"; the UI/docs call it 标识. */
  identifier: string
  user_id: number | null
}

export type IdentifierQueryMode = 'exact' | 'icontains'

const DEFAULT_MIN_GAP_MS = 600
const DEFAULT_BACKOFF_MS = [2_000, 4_000, 8_000]

let lastRequestAt = 0
let requestCount = 0

export function getRequestCount(): number {
  return requestCount
}

export function resetRequestCount(): void {
  requestCount = 0
}

export function chunkIds(ids: number[], size = PAGE_SIZE): number[][] {
  if (size <= 0) throw new Error('chunk size must be positive')
  const chunks: number[][] = []
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size))
  return chunks
}

async function resolveBase(options: ApiOptions): Promise<string> {
  if (options.baseUrl) return options.baseUrl.replace(/\/+$/, '')
  const settings = await getSettings()
  return settings.apiBase.replace(/\/+$/, '')
}

async function waitForGap(minGapMs: number, signal?: AbortSignal): Promise<void> {
  const wait = lastRequestAt + minGapMs - Date.now()
  if (wait <= 0) return
  try {
    await sleep(wait, signal)
  } catch {
    throw new ApiError('aborted', '已取消')
  }
}

function nextBackoff(backoff: number[], attempt: number): number {
  return backoff[Math.min(attempt, backoff.length - 1)] ?? 0
}

async function requestJson<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const base = await resolveBase(options)
  const url = `${base}${path}`
  const minGapMs = options.minGapMs ?? DEFAULT_MIN_GAP_MS
  const backoff = options.backoffMs ?? DEFAULT_BACKOFF_MS
  const maxRetries = options.maxRetries ?? 3

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (options.signal?.aborted) throw new ApiError('aborted', '已取消')
    await waitForGap(minGapMs, options.signal)

    lastRequestAt = Date.now()
    requestCount += 1

    let response: Response
    try {
      response = await fetch(url, {
        signal: options.signal,
        credentials: 'omit',
        cache: 'no-store',
      })
    } catch (error) {
      if (options.signal?.aborted || isAbortError(error)) {
        throw new ApiError('aborted', '已取消')
      }
      if (attempt < maxRetries) {
        try {
          await sleep(nextBackoff(backoff, attempt), options.signal)
        } catch {
          throw new ApiError('aborted', '已取消')
        }
        continue
      }
      throw new ApiError('network', '网络不可用')
    }

    if (response.ok) {
      let text: string
      try {
        text = await response.text()
      } catch (error) {
        if (options.signal?.aborted || isAbortError(error)) {
          throw new ApiError('aborted', '已取消')
        }
        throw new ApiError('network', '网络不可用')
      }

      try {
        return JSON.parse(text) as T
      } catch {
        throw new ApiError('format', '返回格式异常（不是 JSON）', response.status)
      }
    }

    const status = response.status

    if (status === 429 || status >= 500) {
      if (attempt < maxRetries) {
        try {
          await sleep(nextBackoff(backoff, attempt), options.signal)
        } catch {
          throw new ApiError('aborted', '已取消')
        }
        continue
      }
      if (status === 429) {
        throw new ApiError('rate', '触发频率限制，请稍后再试', status)
      }
      throw new ApiError('server', `服务器错误（HTTP ${status}）`, status)
    }

    if (status === 404) {
      throw new ApiError('notfound', '接口不存在，站点可能已升级', status)
    }

    if (status === 400) {
      const body = await response.text().catch(() => '')
      if (body.includes('too_many_matches')) {
        throw new ApiError('toomany', '匹配过多，请输入更完整的标识', status)
      }
      throw new ApiError('http', '请求参数有误（HTTP 400）', status)
    }

    throw new ApiError('http', `请求失败（HTTP ${status}）`, status)
  }

  throw new ApiError('network', '网络不可用')
}

export async function infoupdated(
  since: number,
  options: ApiOptions = {},
): Promise<number[]> {
  const value = Math.max(0, Math.floor(since))
  const data = await requestJson<unknown>(
    `/api/userprofile/infoupdated?since=${encodeURIComponent(String(value))}`,
    options,
  )

  if (!Array.isArray(data) || !data.every((id) => Number.isInteger(id))) {
    throw new ApiError('format', '返回格式异常（infoupdated）')
  }
  return data as number[]
}

export async function infobulk(
  ids: number[],
  options: ApiOptions = {},
): Promise<unknown[]> {
  if (ids.length === 0) return []
  if (!ids.every((id) => Number.isInteger(id) && id > 0)) {
    throw new ApiError('http', '用户 ID 列表不合法')
  }

  const data = await requestJson<unknown>(
    `/api/userprofile/infobulk?ids=${ids.join(',')}`,
    options,
  )
  if (!Array.isArray(data)) {
    throw new ApiError('format', '返回格式异常（infobulk）')
  }
  return data
}

export async function identifierQuery(
  mode: IdentifierQueryMode,
  identifier: string,
  options: ApiOptions = {},
): Promise<IdentifierItem[]> {
  const data = await requestJson<unknown>(
    `/api/identifier/query/${mode}?identifier=${encodeURIComponent(identifier)}`,
    options,
  )

  if (!data || typeof data !== 'object' || !Array.isArray((data as { items?: unknown }).items)) {
    throw new ApiError('format', '返回格式异常（identifier）')
  }

  const items = (data as { items: unknown[] }).items
  const result: IdentifierItem[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const record = item as { identifier?: unknown; user_id?: unknown }
    if (typeof record.identifier !== 'string' || !record.identifier) continue
    const userId =
      typeof record.user_id === 'number' &&
      Number.isInteger(record.user_id) &&
      record.user_id > 0
        ? record.user_id
        : null
    result.push({ identifier: record.identifier, user_id: userId })
  }
  return result
}
