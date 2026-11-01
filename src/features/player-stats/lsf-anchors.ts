import { SITE_ORIGIN } from '../../shared/constants'
import type { Level } from './model'
import { STNB_COEFFICIENT } from './model'
import type { LsfAnchors } from './ratings'
import { WORKBOOK_ANCHORS } from './ratings'

const CACHE_KEY = 'lsfAnchors.v5'
const TTL = 6 * 60 * 60 * 1000
const ANCHOR_KEYS = Object.keys(WORKBOOK_ANCHORS)

interface CacheEntry {
  fetchedAt: number
  anchors: LsfAnchors
}

interface RawAnchor {
  value: number
  sample_count?: number
}

function validAnchors(value: unknown): value is LsfAnchors {
  if (!value || typeof value !== 'object') return false
  const anchors = value as Record<string, unknown>
  return ANCHOR_KEYS.every((key) => {
    const current = anchors[key]
    return typeof current === 'number' && Number.isFinite(current) && current > 0
  })
}

function readCache(): CacheEntry | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as CacheEntry
    if (!validAnchors(value.anchors) || typeof value.fetchedAt !== 'number') return null
    return value
  } catch {
    return null
  }
}

function writeCache(anchors: LsfAnchors): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), anchors }))
  } catch {
    // 缓存写不进去就每次重算。
  }
}

/** 站点返回毫秒、每秒和归一化 STNB；只接受 18 个已知键，换成秒 / 3BVS / 原始 STNB。 */
export function convertAnchors(raw: Record<string, RawAnchor>): LsfAnchors {
  const anchors: LsfAnchors = {}
  for (const key of ANCHOR_KEYS) {
    const value = raw[key]?.value
    if (!Number.isFinite(value) || value <= 0) throw new Error(`LSF 锚点缺项：${key}`)
    const level = key.slice(key.indexOf(':') + 1, key.indexOf(':') + 2) as Level
    const metric = key.slice(-1)
    if (metric === 't') anchors[key] = value / 1000
    else if (metric === 's') anchors[key] = value * (STNB_COEFFICIENT[level] ?? 1)
    else anchors[key] = value
  }
  return anchors
}

export interface LsfAnchorsResult {
  anchors: LsfAnchors
  stale: boolean
  fetchedAt: number
}

let inflight: Promise<LsfAnchorsResult> | null = null

/** 站点锚点来自 /api/common/loginauto 的 top_anchors；缓存 6 小时。 */
export async function fetchLsfAnchors(force = false): Promise<LsfAnchorsResult> {
  const cached = readCache()
  if (!force && cached && Date.now() - cached.fetchedAt < TTL) {
    return { anchors: cached.anchors, stale: false, fetchedAt: cached.fetchedAt }
  }
  if (inflight) return inflight

  const task = (async (): Promise<LsfAnchorsResult> => {
    try {
      const response = await fetch(`${SITE_ORIGIN}/api/common/loginauto`, {
        signal: AbortSignal.timeout(8000),
      })
      if (!response.ok) throw new Error(`LSF 锚点请求失败：${response.status}`)
      const data = (await response.json()) as { top_anchors?: Record<string, RawAnchor> }
      if (!data.top_anchors) throw new Error('LSF 锚点为空')
      const anchors = convertAnchors(data.top_anchors)
      writeCache(anchors)
      return { anchors, stale: false, fetchedAt: Date.now() }
    } catch (error) {
      if (cached) return { anchors: cached.anchors, stale: true, fetchedAt: cached.fetchedAt }
      throw error
    }
  })()

  inflight = task
  try {
    return await task
  } finally {
    if (inflight === task) inflight = null
  }
}
