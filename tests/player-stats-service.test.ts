import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureDetails, loadPlayer } from '../src/features/player-stats/service'
import { readUserRows } from '../src/features/player-stats/store'

const BASE = 'https://api.test'

const metasByUser = new Map<number, unknown[]>()
const detailById = new Map<number, unknown>()
let calls: string[] = []

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function meta(id: number, state: string, uploadTime = '2025-01-01T00:00:00Z') {
  return { id, player: 1, upload_time: uploadTime, state, ongoing_tournament: false }
}

function detail(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    ongoing_tournament: false,
    software: 'a',
    level: 'b',
    mode: '00',
    end_time: '2025-01-01T00:00:00Z',
    file_size: 1024,
    timems: 1500,
    bv: 10,
    left: 10,
    right: 0,
    double: 0,
    left_ce: 10,
    right_ce: 0,
    double_ce: 0,
    ...overrides,
  }
}

beforeEach(() => {
  calls = []
  metasByUser.clear()
  detailById.clear()
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    if (url.includes('/api/userprofile/videolist')) {
      const userId = Number(new URL(url).searchParams.get('user_id'))
      return json(metasByUser.get(userId) ?? [])
    }
    if (url.includes('/api/video/staticdetailbatch')) {
      const ids = (new URL(url).searchParams.get('ids') ?? '')
        .split(',')
        .map((value) => Number(value))
      return json(ids.flatMap((id) => (detailById.has(id) ? [detailById.get(id)] : [])))
    }
    return json([])
  })
})

describe('玩家数据加载', () => {
  it('合并列表与明细，只抓已过审的，第二次直接读缓存', async () => {
    metasByUser.set(101, [meta(11, 'c'), meta(12, 'a', '2025-01-02T00:00:00Z')])
    detailById.set(11, detail(11))

    const first = await loadPlayer(101, { baseUrl: BASE })
    expect(first.fromCache).toBe(false)
    expect(first.rows).toHaveLength(2)
    expect(first.rows[0]?.detail?.id).toBe(11)
    expect(first.rows[1]?.detail).toBeNull()
    expect(calls.some((url) => url.includes('ids=11'))).toBe(true)
    expect(calls.some((url) => url.includes('ids=12'))).toBe(false)

    const callCount = calls.length
    const second = await loadPlayer(101, { baseUrl: BASE })
    expect(second.fromCache).toBe(true)
    expect(calls).toHaveLength(callCount)
  })

  it('未过审的明细等开关打开后再补抓，并写回缓存', async () => {
    metasByUser.set(102, [meta(21, 'd')])
    detailById.set(21, detail(21, { level: 'e', bv: 120, timems: 60000 }))

    const loaded = await loadPlayer(102, { baseUrl: BASE })
    expect(loaded.rows[0]?.detail).toBeNull()
    expect(calls).toHaveLength(1)

    const result = await ensureDetails(102, loaded.rows, [21], { baseUrl: BASE })
    expect(result.rows[0]?.detail?.id).toBe(21)
    expect(calls).toHaveLength(2)

    const persisted = await readUserRows(102)
    expect(persisted[0]?.detail?.bv).toBe(120)
  })
})
