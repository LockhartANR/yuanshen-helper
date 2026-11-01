import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureDetails, loadPlayer } from '../src/features/player-stats/service'
import { putRows, readUserRows, saveFetchedAt } from '../src/features/player-stats/store'
import { clearAllData } from '../src/features/user-search/db'

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
    path: 640,
    op: 2,
    isl: 3,
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

  it('旧缓存缺 path / op / isl 时重拉明细', async () => {
    metasByUser.set(103, [meta(31, 'c')])
    detailById.set(31, detail(31))

    const legacy = detail(31)
    delete (legacy as Record<string, unknown>).path
    delete (legacy as Record<string, unknown>).op
    delete (legacy as Record<string, unknown>).isl

    await putRows(103, [
      {
        userId: 103,
        id: 31,
        state: 'c',
        uploadTime: '2025-01-01T00:00:00Z',
        ongoing: false,
        detail: legacy as never,
      },
    ])
    await saveFetchedAt(103, Date.now(), 2)

    const loaded = await loadPlayer(103, { baseUrl: BASE })
    expect(loaded.fromCache).toBe(false)
    expect(loaded.rows[0]?.detail?.path).toBe(640)
    expect(calls.some((url) => url.includes('ids=31'))).toBe(true)
  })

  it('新明细缺 path / op / isl 时按部分可用缓存，不反复重拉', async () => {
    metasByUser.set(104, [meta(41, 'c')])
    detailById.set(41, detail(41, { path: null }))

    const loaded = await loadPlayer(104, { baseUrl: BASE })
    expect(loaded.rows[0]?.detail?.path).toBeNull()
    expect(loaded.rows[0]?.detailPartial).toBe(true)
    expect(loaded.missing).not.toContain(41)

    const persisted = await readUserRows(104)
    expect(persisted[0]?.detailPartial).toBe(true)

    const callCount = calls.length
    const second = await loadPlayer(104, { baseUrl: BASE })
    expect(second.fromCache).toBe(true)
    expect(calls).toHaveLength(callCount)

    detailById.set(41, detail(41))
    const forced = await loadPlayer(104, { force: true, baseUrl: BASE })
    expect(forced.rows[0]?.detail?.path).toBe(640)
    expect(forced.rows[0]?.detailPartial).toBe(false)
    expect(calls.length).toBeGreaterThan(callCount)
  })

  it('v3 新鲜缓存里明细缺字段时也会重拉', async () => {
    metasByUser.set(105, [meta(51, 'c')])
    detailById.set(51, detail(51))
    const invalid = detail(51, { op: null })
    await putRows(105, [
      {
        userId: 105,
        id: 51,
        state: 'c',
        uploadTime: '2025-01-01T00:00:00Z',
        ongoing: false,
        detail: invalid as never,
      },
    ])
    await saveFetchedAt(105, Date.now(), 3)

    const loaded = await loadPlayer(105, { baseUrl: BASE })
    expect(loaded.fromCache).toBe(false)
    expect(loaded.rows[0]?.detail?.op).toBe(2)
    expect(calls.some((url) => url.includes('ids=51'))).toBe(true)
  })

  it('清空本地数据时同时清掉玩家缓存', async () => {
    metasByUser.set(106, [meta(61, 'c')])
    detailById.set(61, detail(61))
    await loadPlayer(106, { baseUrl: BASE })
    expect((await readUserRows(106)).length).toBe(1)

    await clearAllData()
    expect(await readUserRows(106)).toHaveLength(0)
  })

  it('非 c 录像的 partial 明细刷新后仍保留', async () => {
    metasByUser.set(107, [meta(71, 'd')])
    detailById.set(71, detail(71, { path: null }))

    const loaded = await loadPlayer(107, { baseUrl: BASE })
    const ensured = await ensureDetails(107, loaded.rows, [71], { baseUrl: BASE })
    expect(ensured.rows[0]?.detailPartial).toBe(true)

    const refreshed = await loadPlayer(107, { force: true, baseUrl: BASE })
    expect(refreshed.rows[0]?.detail?.id).toBe(71)
    expect(refreshed.rows[0]?.detailPartial).toBe(true)
  })

  it('刷新缺明细时回退旧 partial，不丢整条录像', async () => {
    metasByUser.set(109, [meta(91, 'c')])
    detailById.set(91, detail(91, { path: null }))
    await loadPlayer(109, { baseUrl: BASE })

    detailById.delete(91)
    const refreshed = await loadPlayer(109, { force: true, baseUrl: BASE })
    expect(refreshed.rows[0]?.detail?.id).toBe(91)
    expect(refreshed.rows[0]?.detailPartial).toBe(true)
  })

  it('空列表在普通刷新时保留缓存，强制刷新时以站点为准', async () => {
    metasByUser.set(108, [meta(81, 'c')])
    detailById.set(81, detail(81))
    await loadPlayer(108, { baseUrl: BASE })
    await saveFetchedAt(108, 0, 3)

    metasByUser.set(108, [])
    const cached = await loadPlayer(108, { baseUrl: BASE })
    expect(cached.rows).toHaveLength(1)
    expect(cached.fromCache).toBe(true)

    const cleared = await loadPlayer(108, { force: true, baseUrl: BASE })
    expect(cleared.rows).toHaveLength(0)
  })
})
