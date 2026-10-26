import 'fake-indexeddb/auto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearAllData, getAllUsers, getSyncMeta } from '../src/features/user-search/db'
import { lookupIdentifiers } from '../src/features/user-search/identifier'
import { searchRecords } from '../src/features/user-search/search'
import { runSync } from '../src/features/user-search/sync'

interface FixtureUser {
  id: number
  username: string
  realname: string
  firstname: string
  lastname: string
}

let currentUsers: FixtureUser[] = []
let updatedIds: number[] = []

const store = new Map<string, unknown>()

const chromeMock = {
  storage: {
    local: {
      get: async (key: string) => (store.has(key) ? { [key]: store.get(key) } : {}),
      set: async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) store.set(key, value)
      },
      remove: async (key: string) => {
        store.delete(key)
      },
    },
  },
  runtime: {
    getManifest: () => ({ version: '0.1.0' }),
  },
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = new URL(String(input))

  if (url.pathname.endsWith('/infoupdated')) {
    const since = Number(url.searchParams.get('since') ?? 0)
    const ids = since === 0 ? currentUsers.map((user) => user.id) : updatedIds
    return jsonResponse(ids)
  }

  if (url.pathname.endsWith('/infobulk')) {
    const ids = (url.searchParams.get('ids') ?? '')
      .split(',')
      .filter(Boolean)
      .map(Number)
    return jsonResponse(currentUsers.filter((user) => ids.includes(user.id)))
  }

  if (url.pathname.startsWith('/api/identifier/query/')) {
    return jsonResponse({
      items: [{ identifier: 'zhangsan-01', user_id: 1 }],
    })
  }

  return new Response('', { status: 404 })
})

beforeAll(() => {
  vi.stubGlobal('chrome', chromeMock)
  vi.stubGlobal('fetch', fetchMock)
})

beforeEach(async () => {
  await clearAllData()
  store.clear()
  fetchMock.mockClear()
  currentUsers = [
    {
      id: 1,
      username: 'zhangsan',
      realname: '张三',
      firstname: 'San',
      lastname: 'Zhang',
    },
    {
      id: 2,
      username: 'lisi',
      realname: '李四',
      firstname: 'Si',
      lastname: 'Li',
    },
  ]
  updatedIds = []
})

afterAll(() => {
  vi.unstubAllGlobals()
})

describe('runSync', () => {
  it('runs a full sync and stores searchable users', async () => {
    const result = await runSync('full')

    expect(result.mode).toBe('full')
    expect(result.userCount).toBe(2)
    expect(result.requests).toBe(2)

    const users = await getAllUsers()
    expect(users.map((user) => user.username).sort()).toEqual(['lisi', 'zhangsan'])
    expect(searchRecords(users, 'zhangsan')[0]?.record.id).toBe(1)

    const meta = await getSyncMeta()
    expect(meta.phase).toBe('idle')
    expect(meta.userCount).toBe(2)
    expect(meta.watermark).toBeGreaterThan(0)
  })

  it('does a one-request incremental sync when nothing changed', async () => {
    await runSync('full')
    fetchMock.mockClear()

    const result = await runSync('incremental')

    expect(result.updated).toBe(0)
    expect(result.requests).toBe(1)
    expect(result.userCount).toBe(2)
  })

  it('updates changed users incrementally', async () => {
    await runSync('full')
    currentUsers[1] = { ...currentUsers[1], username: 'lisi-updated' }
    updatedIds = [2]
    fetchMock.mockClear()

    const result = await runSync('incremental')
    expect(result.updated).toBe(1)
    expect(result.requests).toBe(2)

    const users = await getAllUsers()
    expect(users.find((user) => user.id === 2)?.username).toBe('lisi-updated')
  })

  it('prunes users that disappeared from a full sync', async () => {
    await runSync('full')
    currentUsers = currentUsers.filter((user) => user.id === 1)

    const result = await runSync('full')

    expect(result.userCount).toBe(1)
    const users = await getAllUsers()
    expect(users.map((user) => user.id)).toEqual([1])
  })
})

describe('lookupIdentifiers', () => {
  it('skips queries shorter than three characters', async () => {
    const result = await lookupIdentifiers('ab')
    expect(result).toEqual({ kind: 'skip', reason: 'short' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('caches remote identifier results', async () => {
    const first = await lookupIdentifiers('zhangsan')
    expect(first.kind).toBe('ok')
    if (first.kind === 'ok') {
      expect(first.source).toBe('remote')
      expect(first.items[0]).toEqual({ identifier: 'zhangsan-01', user_id: 1 })
    }

    const calls = fetchMock.mock.calls.length
    const second = await lookupIdentifiers('zhangsan')
    expect(second.kind).toBe('ok')
    if (second.kind === 'ok') {
      expect(second.source).toBe('cache')
    }
    expect(fetchMock.mock.calls.length).toBe(calls)
  })
})
