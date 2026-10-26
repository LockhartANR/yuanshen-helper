import { IDENTIFIER_CACHE_TTL_MS } from '../../shared/constants'
import { getIdentifierCache, putIdentifierCache } from './db'
import {
  ApiError,
  identifierQuery,
  type IdentifierItem,
  type IdentifierQueryMode,
} from './api'
import { normalize } from './model'

const BUDGET_KEY = 'identifierBudget'
const BUDGET_WINDOW_MS = 60_000
const BUDGET_LIMIT = 5

export type IdentifierLookup =
  | { kind: 'ok'; items: IdentifierItem[]; source: 'cache' | 'remote' }
  | { kind: 'skip'; reason: 'short' | 'budget' }
  | {
      kind: 'error'
      reason: 'toomany' | 'rate' | 'network' | 'aborted'
      message: string
    }

async function readBudget(): Promise<number[]> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return []
  try {
    const stored = await chrome.storage.local.get(BUDGET_KEY)
    const value = stored[BUDGET_KEY]
    return Array.isArray(value)
      ? value.filter((item): item is number => typeof item === 'number')
      : []
  } catch {
    return []
  }
}

async function writeBudget(hits: number[]): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return
  try {
    await chrome.storage.local.set({ [BUDGET_KEY]: hits })
  } catch {
    // Storage failures should not break local search.
  }
}

async function consumeBudget(now = Date.now()): Promise<boolean> {
  const fresh = (await readBudget()).filter((timestamp) => now - timestamp < BUDGET_WINDOW_MS)
  if (fresh.length >= BUDGET_LIMIT) {
    await writeBudget(fresh)
    return false
  }
  fresh.push(now)
  await writeBudget(fresh)
  return true
}

function identifierMode(query: string): IdentifierQueryMode {
  return /^\d+$/.test(query) ? 'exact' : 'icontains'
}

function identifierCacheKey(mode: IdentifierQueryMode, query: string): string {
  return `${mode}:${normalize(query)}`
}

export async function lookupIdentifiers(
  rawQuery: string,
  options: { signal?: AbortSignal } = {},
): Promise<IdentifierLookup> {
  const query = rawQuery.trim()
  if (query.length < 3) return { kind: 'skip', reason: 'short' }

  const mode = identifierMode(query)
  const cacheKey = identifierCacheKey(mode, query)

  const cached = await getIdentifierCache(cacheKey)
  if (cached && Date.now() - cached.fetchedAt < IDENTIFIER_CACHE_TTL_MS) {
    return { kind: 'ok', items: cached.items, source: 'cache' }
  }

  if (mode === 'icontains' && !(await consumeBudget())) {
    return { kind: 'skip', reason: 'budget' }
  }

  try {
    const items = await identifierQuery(mode, query, { signal: options.signal })
    await putIdentifierCache({
      key: cacheKey,
      items,
      fetchedAt: Date.now(),
    })
    return { kind: 'ok', items, source: 'remote' }
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.kind === 'aborted') {
        return { kind: 'error', reason: 'aborted', message: error.message }
      }
      if (error.kind === 'toomany') {
        return { kind: 'error', reason: 'toomany', message: error.message }
      }
      if (error.kind === 'rate') {
        return { kind: 'error', reason: 'rate', message: error.message }
      }
      return { kind: 'error', reason: 'network', message: error.message }
    }
    return { kind: 'error', reason: 'network', message: '远程查询失败' }
  }
}
