import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  normalizeScanRange,
  RankingRangeError,
  startCollection,
  getRankingOverview,
} from '../src/features/custom-ranking/collector'
import { calculateRanking } from '../src/features/custom-ranking/calculation'
import { compileConfig } from '../src/features/custom-ranking/config'
import { DEFAULT_RANK_CONFIG } from '../src/features/custom-ranking/model'
import { getVideoDetailFormula, loadRankingVideoDetails } from '../src/features/custom-ranking/video-details'
import {
  clearGlobalRankingData,
  clearRankingCache,
  getDataset,
  getRankingMeta,
  getTaskForDataset,
  getVideoRow,
  listTasks,
  putDataset,
  putTask,
} from '../src/features/custom-ranking/store'

const BASE = 'https://mock.test'

interface VideoSpec {
  id: number
  player: number
  bv?: number
  timems?: number
  level?: string
  state?: string
  mode?: string
  rightCe?: number
  software?: string
}

function detail(spec: VideoSpec): Record<string, unknown> {
  return {
    id: spec.id,
    player: spec.player,
    software: spec.software ?? 'e',
    level: spec.level ?? 'b',
    mode: spec.mode ?? '00',
    state: spec.state ?? 'c',
    timems: spec.timems ?? 10_000,
    bv: spec.bv ?? 20,
    path: 320,
    flag: 2,
    op: 1,
    isl: 1,
    upload_time: '2026-11-01T00:00:00.000Z',
    end_time: '2026-11-01T00:00:00.000Z',
    file_size: 1000,
    left: 10,
    right: 5,
    double: 5,
    cl: 20,
    left_ce: 8,
    right_ce: spec.rightCe ?? 3,
    double_ce: 4,
    ce: 15,
    video__identifier: '',
  }
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

let detailRows: Record<string, unknown>[]
let abstractRows: Record<string, unknown>[]
let staticRows: Record<string, unknown>[]
let paths: string[]

function metaRow(spec: VideoSpec): Record<string, unknown> {
  return {
    id: spec.id,
    player: spec.player,
    upload_time: '2026-11-01T00:00:00.000Z',
    state: spec.state ?? 'c',
  }
}

function installFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    const path = url.pathname
    paths.push(path)
    const params = url.searchParams
    if (path === '/api/video/detailbulk') {
      const first = Number(params.get('first'))
      const count = Number(params.get('count'))
      return json(detailRows.filter((row) => {
        const id = Number(row.id)
        return id >= first && id < first + count
      }))
    }
    if (path === '/api/video/abstractbulk') {
      const first = Number(params.get('first'))
      const count = Number(params.get('count'))
      return json(abstractRows.filter((row) => {
        const id = Number(row.id)
        return id >= first && id < first + count
      }))
    }
    if (path === '/api/video/staticdetailbatch') {
      const ids = new Set((params.get('ids') ?? '').split(',').map(Number))
      return json(staticRows.filter((row) => ids.has(Number(row.id))))
    }
    if (path === '/api/userprofile/infobulk') {
      const ids = (params.get('ids') ?? '').split(',').map(Number)
      return json(ids.map((id) => ({
        id,
        username: `P${id}`,
        realname: '',
        firstname: '',
        lastname: '',
      })))
    }
    return json([])
  }))
}

beforeEach(async () => {
  await clearGlobalRankingData()
  const base = [
    { id: 1, player: 1, bv: 20 },
    { id: 2, player: 1, bv: 30 },
    { id: 3, player: 2, bv: 40 },
  ]
  detailRows = base.map(detail)
  abstractRows = base.map(metaRow)
  staticRows = []
  paths = []
  installFetch()
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await clearGlobalRankingData()
})

describe('ID 区间排行榜采集', () => {
  it('首次按 detailbulk 区间建库，保存范围并原子发布', async () => {
    const run = await startCollection(BASE, {
      mode: 'initial',
      startId: 1,
      endId: 3,
      gapMs: 0,
    })
    expect(run.complete).toBe(true)
    expect(run.dataset.strategyVersion).toBe(2)
    expect(run.dataset.scanMode).toBe('initial')
    expect([run.dataset.startId, run.dataset.endId]).toEqual([1, 3])
    expect(run.dataset.intervalDone).toBe(1)
    expect(run.dataset.intervalTotal).toBe(1)
    expect(run.dataset.videoCount).toBe(3)
    expect(run.dataset.detailCount).toBe(3)
    expect(run.dataset.playerCount).toBe(2)
    expect(run.task.phase).toBe('publish')
    const meta = await getRankingMeta(BASE)
    expect(meta.readyDatasetId).toBe(run.dataset.id)
    expect([meta.startId, meta.endId]).toEqual([1, 3])
    expect(paths).toContain('/api/video/detailbulk')
    expect(paths).not.toContain('/api/userprofile/infoupdated')
    expect(paths).not.toContain('/api/userprofile/videolist')
    const row = await getVideoRow(run.dataset.id, 1)
    expect(row?.detailState).toBe('complete')
    expect(row?.detail?.fields.ioe).toBeCloseTo(1)

    const ranked = await calculateRanking(run.dataset.id, DEFAULT_RANK_CONFIG)
    expect(ranked.playerCount).toBe(2)
    expect(ranked.rows.map((item) => item.playerId)).toEqual([2, 1])
  })

  it('按原榜单口径列出求和录像和并列极值，数据变化后拒绝使用旧明细', async () => {
    detailRows = [
      { ...detail({ id: 1, player: 1, timems: 1000 }), cell8: 2 },
      { ...detail({ id: 2, player: 1, timems: 1000 }), cell8: 4 },
      { ...detail({ id: 3, player: 1, timems: 1001 }), cell8: 0 },
      detail({ id: 4, player: 1, timems: 2000 }),
      { ...detail({ id: 5, player: 2, timems: 1000 }), cell8: 8 },
      { ...detail({ id: 6, player: 1, timems: 500, mode: '01' }), cell8: 8 },
    ]
    const run = await startCollection(BASE, { mode: 'initial', startId: 1, endId: 6, gapMs: 0 })
    const config = compileConfig({
      ...DEFAULT_RANK_CONFIG,
      metrics: [
        { id: 'cell8', name: 'cell8 局数', formula: 'sum(if(cell8 > 0, 1, null))', direction: 'desc', digits: 0 },
        { id: 'min', name: '最快', formula: 'min(time)', direction: 'asc', digits: 2 },
        { id: 'max', name: '最慢', formula: 'max(time)', direction: 'desc', digits: 2 },
      ],
    })
    const ranked = await calculateRanking(run.dataset.id, config.config)
    const player = ranked.players.find((item) => item.playerId === 1)!
    expect(player.values).toEqual([2, 1, 2])
    const details = (index: number) => loadRankingVideoDetails({
      datasetId: ranked.datasetId,
      version: ranked.datasetVideoVersion!,
      playerId: player.playerId,
      filter: config.filter,
      formula: getVideoDetailFormula(config.metrics[index]!.compiled)!,
      value: player.values[index]!,
    })
    expect(await details(0)).toEqual({
      validCount: 2,
      videos: [{ videoId: 1, value: 1, fields: [2] }, { videoId: 2, value: 1, fields: [4] }],
    })
    expect(await details(1)).toMatchObject({ validCount: 4, videos: [{ videoId: 1 }, { videoId: 2 }] })
    expect(await details(2)).toMatchObject({ validCount: 4, videos: [{ videoId: 4 }] })

    await putDataset({ ...run.dataset, detailCount: run.dataset.detailCount + 1 })
    await expect(details(0)).rejects.toThrow('请重新计算排行榜')
  })

  it('嵌套参数不同的指标各自聚合，明细能命中对应的极值', async () => {
    detailRows = [detail({ id: 1, player: 1, timems: 1490 })]
    const run = await startCollection(BASE, { mode: 'initial', startId: 1, endId: 1, gapMs: 0 })
    const config = compileConfig({
      ...DEFAULT_RANK_CONFIG,
      metrics: [
        { id: 'outer', name: '外层精度', formula: 'max(round(round(time), 1))', direction: 'desc', digits: 0 },
        { id: 'inner', name: '内层精度', formula: 'max(round(round(time, 1)))', direction: 'desc', digits: 0 },
      ],
    })
    const ranked = await calculateRanking(run.dataset.id, config.config)
    const player = ranked.players[0]!
    expect(player.values).toEqual([1, 2])
    for (const [index, value] of player.values.entries()) {
      const details = await loadRankingVideoDetails({
        datasetId: ranked.datasetId,
        version: ranked.datasetVideoVersion!,
        playerId: player.playerId,
        filter: config.filter,
        formula: getVideoDetailFormula(config.metrics[index]!.compiled)!,
        value: value!,
      })
      expect(details.videos).toEqual([{ videoId: 1, value, fields: [1.49] }])
    }
  })

  it('同步复用保存范围与 abstractbulk 元信息，不重新请求 detailbulk', async () => {
    const first = await startCollection(BASE, {
      mode: 'initial',
      startId: 1,
      endId: 3,
      gapMs: 0,
    })
    const detailCalls = paths.filter((path) => path === '/api/video/detailbulk').length
    abstractRows = [
      { ...metaRow({ id: 1, player: 1 }), state: 'c' },
      { ...metaRow({ id: 2, player: 1 }), state: 'c', upload_time: '2026-11-02T00:00:00.000Z' },
      { ...metaRow({ id: 3, player: 2 }), state: 'a' },
    ]
    const synced = await startCollection(BASE, { mode: 'sync', gapMs: 0 })
    expect(synced.complete).toBe(true)
    expect(synced.dataset.id).not.toBe(first.dataset.id)
    expect(synced.dataset.baseDatasetId).toBe(first.dataset.id)
    expect([synced.dataset.startId, synced.dataset.endId]).toEqual([1, 3])
    expect(synced.dataset.detailReusedCount).toBe(3)
    expect(synced.dataset.videoCount).toBe(3)
    expect(paths.filter((path) => path === '/api/video/detailbulk').length).toBe(detailCalls)
    expect(paths).toContain('/api/video/abstractbulk')
    const reused = await getVideoRow(synced.dataset.id, 2)
    expect(reused?.detailState).toBe('complete')
    expect(reused?.detail?.fields.upload_time).toBe('2026-11-02T00:00:00.000Z')
    expect(reused?.state).toBe('c')
    const state = await getVideoRow(synced.dataset.id, 3)
    expect(state?.state).toBe('a')
  })

  it('扩大范围扫描历史与新增区间，只补齐新增 ID 的解析详情', async () => {
    const first = await startCollection(BASE, {
      mode: 'initial',
      startId: 1,
      endId: 3,
      gapMs: 0,
    })
    abstractRows = [1, 2, 3, 4].map((id) => metaRow({ id, player: id <= 2 ? 1 : 2 }))
    detailRows.push(detail({ id: 4, player: 2, bv: 50 }))
    staticRows = [detail({ id: 4, player: 2, bv: 50 })]
    const expanded = await startCollection(BASE, {
      mode: 'expand',
      endId: 4,
      gapMs: 0,
    })
    expect(expanded.complete).toBe(true)
    expect([expanded.dataset.startId, expanded.dataset.endId]).toEqual([1, 4])
    expect(expanded.dataset.baseDatasetId).toBe(first.dataset.id)
    expect(expanded.dataset.detailReusedCount).toBe(3)
    expect(expanded.dataset.videoCount).toBe(4)
    expect(expanded.dataset.missingDetailCount).toBe(0)
    expect(paths).toContain('/api/video/staticdetailbatch')
    const meta = await getRankingMeta(BASE)
    expect([meta.startId, meta.endId]).toEqual([1, 4])
    expect(meta.readyDatasetId).toBe(expanded.dataset.id)
  })

  it('补齐失败时保留部分数据，旧成功指针不被覆盖', async () => {
    const first = await startCollection(BASE, {
      mode: 'initial',
      startId: 1,
      endId: 3,
      gapMs: 0,
    })
    abstractRows = [1, 2, 3].map((id) => metaRow({ id, player: 1 }))
    staticRows = []
    // 用更大的未公开 ID 制造缺失详情：新 ID 没有基础快照可复用。
    abstractRows.push(metaRow({ id: 4, player: 1 }))
    const partial = await startCollection(BASE, { mode: 'expand', endId: 4, gapMs: 0 })
    expect(partial.complete).toBe(false)
    expect(partial.dataset.status).toBe('partial')
    expect(partial.dataset.missingDetailCount).toBe(1)
    const meta = await getRankingMeta(BASE)
    expect(meta.readyDatasetId).toBe(first.dataset.id)
    expect(meta.latestDatasetId).toBe(partial.dataset.id)
    expect([meta.startId, meta.endId]).toEqual([1, 4])
    const overview = await getRankingOverview(BASE)
    expect(overview.latest?.id).toBe(partial.dataset.id)
    expect(overview.ready?.id).toBe(first.dataset.id)
  })

  it('空区间是合法成功区间，范围边界严格校验', async () => {
    detailRows = []
    abstractRows = []
    const run = await startCollection(BASE, {
      mode: 'initial',
      startId: 10,
      endId: 20,
      gapMs: 0,
    })
    expect(run.complete).toBe(true)
    expect(run.dataset.videoCount).toBe(0)
    expect(run.dataset.intervalDone).toBe(1)
    expect(run.dataset.intervalTotal).toBe(1)

    expect(() => normalizeScanRange(0, 10)).toThrow(RankingRangeError)
    expect(() => normalizeScanRange(10, 9)).toThrow(RankingRangeError)
    expect(() => normalizeScanRange(undefined, 10)).not.toThrow()
  })

  it('重新建库部分完成时保留上一份成功快照', async () => {
    const first = await startCollection(BASE, {
      mode: 'initial',
      startId: 1,
      endId: 3,
      gapMs: 0,
    })
    // 缺 player 的条目被计为异常，当前 generation 只能部分发布。
    detailRows = [
      { ...detail({ id: 1, player: 1 }), player: null },
      detail({ id: 2, player: 1 }),
      detail({ id: 3, player: 2 }),
    ]
    const partial = await startCollection(BASE, {
      mode: 'initial',
      startId: 1,
      endId: 3,
      gapMs: 0,
    })
    expect(partial.complete).toBe(false)
    expect(partial.dataset.status).toBe('partial')
    expect(partial.dataset.responseAnomalies).toBe(1)
    expect(await getDataset(first.dataset.id)).toBeTruthy()
    const overview = await getRankingOverview(BASE)
    expect(overview.ready?.id).toBe(first.dataset.id)
    const oldRanked = await calculateRanking(first.dataset.id, DEFAULT_RANK_CONFIG)
    expect(oldRanked.playerCount).toBe(2)
  })

  it('名称补全期间清缓存，晚到结果不能恢复任务或发布', async () => {
    let releaseInfo!: (response: Response) => void
    let markRequested!: () => void
    const requested = new Promise<void>((resolve) => {
      markRequested = resolve
    })
    const pendingInfo = new Promise<Response>((resolve) => {
      releaseInfo = resolve
    })
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/video/detailbulk') return json(detailRows)
      if (url.pathname === '/api/userprofile/infobulk') {
        markRequested()
        return pendingInfo
      }
      return json([])
    })

    const running = startCollection(BASE, {
      mode: 'initial',
      startId: 1,
      endId: 3,
      gapMs: 0,
    })
    await requested
    await clearRankingCache()
    releaseInfo(json([
      { id: 1, username: 'A', realname: '', firstname: '', lastname: '' },
      { id: 2, username: 'B', realname: '', firstname: '', lastname: '' },
    ]))
    await expect(running).rejects.toThrow()
    const meta = await getRankingMeta(BASE)
    expect(meta.latestDatasetId).toBeNull()
    expect(meta.readyDatasetId).toBeNull()
    expect(await listTasks()).toHaveLength(0)
    expect(await getDataset(meta.latestDatasetId ?? 'none')).toBeUndefined()
  })

  it('detailbulk 非法数组元素不会被当作合法空区间', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/video/detailbulk') return json([null, 42])
      return json([])
    })
    await expect(
      startCollection(BASE, { mode: 'initial', startId: 1, endId: 3, gapMs: 0 }),
    ).rejects.toThrow()
    const meta = await getRankingMeta(BASE)
    expect(meta.readyDatasetId).toBeNull()
    const task = await getTaskForDataset(meta.latestDatasetId!)
    expect(task?.status).toBe('paused')
    expect(task?.errors.length).toBeGreaterThan(0)
  })

  it('发布失败后从 publish 断点重试，不重复请求录像', async () => {
    const first = await startCollection(BASE, {
      mode: 'initial',
      startId: 1,
      endId: 3,
      gapMs: 0,
    })
    const task = await getTaskForDataset(first.dataset.id)
    const dataset = await getDataset(first.dataset.id)
    expect(task).toBeTruthy()
    await putTask({
      ...task!,
      status: 'paused',
      phase: 'publish',
      finishedAt: null,
    })
    await putDataset({
      ...dataset!,
      status: 'partial',
      complete: false,
    })
    const requestCount = paths.length
    const resumed = await startCollection(BASE, { mode: 'auto', gapMs: 0 })
    expect(resumed.complete).toBe(true)
    expect(resumed.dataset.id).toBe(first.dataset.id)
    expect(paths.length).toBe(requestCount)
    const meta = await getRankingMeta(BASE)
    expect(meta.readyDatasetId).toBe(first.dataset.id)
  })

  it('清空全站缓存保留保存范围，但清除成功与最新指针', async () => {
    await startCollection(BASE, { mode: 'initial', startId: 1, endId: 3, gapMs: 0 })
    await clearRankingCache()
    const meta = await getRankingMeta(BASE)
    expect([meta.startId, meta.endId]).toEqual([1, 3])
    expect(meta.readyDatasetId).toBeNull()
    expect(meta.latestDatasetId).toBeNull()
  })

  it('暂停保留原范围断点，auto 续传不会重建范围', async () => {
    const abort = new AbortController()
    let stopped = false
    const longRange = Array.from({ length: 501 }, (_, index) => ({
      id: index + 1,
      player: index % 2 === 0 ? 1 : 2,
    }))
    detailRows = longRange.map(detail)
    abstractRows = longRange.map(metaRow)
    await expect(
      startCollection(BASE, {
        mode: 'initial',
        startId: 1,
        endId: 501,
        gapMs: 0,
        signal: abort.signal,
        onProgress: ({ task }) => {
          if (!stopped && task.intervalDone === 1) {
            stopped = true
            abort.abort()
          }
        },
      }),
    ).rejects.toThrow()
    const meta = await getRankingMeta(BASE)
    const dataset = await getDataset(meta.latestDatasetId!)
    const paused = await getTaskForDataset(meta.latestDatasetId!)
    expect([meta.startId, meta.endId]).toEqual([1, 501])
    expect(dataset?.status).toBe('partial')
    expect(paused?.status).toBe('paused')
    expect(paused?.intervalCursor).toBe(501)
    expect(paused?.intervalDone).toBe(1)

    const resumed = await startCollection(BASE, { mode: 'auto', gapMs: 0 })
    expect(resumed.complete).toBe(true)
    expect([resumed.dataset.startId, resumed.dataset.endId]).toEqual([1, 501])
    expect(resumed.dataset.id).toBe(dataset?.id)
  })
})
