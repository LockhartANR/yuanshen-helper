import { describe, expect, it } from 'vitest'
import { normalizeDetail } from '../src/features/custom-ranking/fields'
import { computeRanking } from '../src/features/custom-ranking/calculator'
import { compileConfig } from '../src/features/custom-ranking/config'
import { DEFAULT_RANK_CONFIG, type GlobalRankVideoRow, type RankConfig, type RankDirection, type RankPlayerValues } from '../src/features/custom-ranking/model'
import {
  buildRankingView,
  comparePlayersByMetric,
  eligiblePlayers,
  formatMetricValue,
  pageCount,
  pageRows,
  sortRankingResult,
} from '../src/features/custom-ranking/ranking'

const metrics = [
  { id: 'a', name: 'A', formula: 'max(bv)', direction: 'desc' as const, digits: 1 },
  { id: 'b', name: 'B', formula: 'max(bv)', direction: 'asc' as const, digits: 1 },
]
const metricIds = metrics.map((metric) => metric.id)

function player(id: number, values: Array<number | null>, games = 10): RankPlayerValues {
  return { playerId: id, games, values, samples: values.map(() => games) }
}

function view(
  players: RankPlayerValues[],
  sortMetricId: string | null = 'a',
  direction: RankDirection = 'desc',
  ids: string[] = metricIds,
) {
  return buildRankingView(players, ids, sortMetricId, direction)
}

describe('单指标排序', () => {
  it('只按当前指标比较，其他列不破同分；切换指标重新排名', () => {
    const players = [player(3, [9, 1]), player(1, [10, 20]), player(2, [10, 15])]
    const byA = view(players)
    expect(byA.rows.map((row) => row.playerId)).toEqual([1, 2, 3])
    expect(byA.rows.map((row) => row.rank)).toEqual([1, 1, 3])
    const byB = view(players, 'b', 'desc')
    expect(byB.rows.map((row) => row.playerId)).toEqual([1, 2, 3])
    expect(byB.rows.map((row) => row.rank)).toEqual([1, 2, 3])
    expect(view(players, 'b', 'asc').rows.map((row) => row.playerId)).toEqual([3, 2, 1])
  })

  it('同值按玩家 ID 升序稳定展示，ID 不参与并列名次', () => {
    const rows = view([player(2, [10, 5]), player(1, [10, 5]), player(9, [10, 99])]).rows
    expect(rows.map((row) => row.playerId)).toEqual([1, 2, 9])
    expect(rows.map((row) => row.rank)).toEqual([1, 1, 1])
  })

  it('空值始终排在有效值之后，名次显示为空', () => {
    const players = [player(1, [null, 1]), player(2, [null, 2]), player(3, [1, 99]), player(4, [2, 1])]
    const desc = view(players)
    expect(desc.rows.map((row) => row.playerId)).toEqual([4, 3, 1, 2])
    expect(desc.rows.map((row) => row.rank)).toEqual([1, 2, null, null])
    expect(view(players, 'a', 'asc').rows.map((row) => row.playerId)).toEqual([3, 4, 1, 2])
  })

  it('0、负数和非有限值按有效值 / 空值规则处理', () => {
    const players = [player(1, [0]), player(2, [-5]), player(3, [3]), player(4, [Number.NaN])]
    expect(view(players, 'a', 'desc', ['a']).rows.map((row) => row.playerId)).toEqual([3, 1, 2, 4])
    expect(view(players, 'a', 'asc', ['a']).rows.map((row) => row.playerId)).toEqual([2, 1, 3, 4])
  })

  it('局数不足与全部指标无值不参榜，最少局数在排序前生效', () => {
    const players = [player(1, [null, null]), player(2, [10, 20]), player(3, [20, 20], 2)]
    expect(eligiblePlayers(players, 11)).toEqual([])
    expect(eligiblePlayers(players, 1).map((item) => item.playerId)).toEqual([2, 3])
  })

  it('比较器反对称，显示精度不改变比较值', () => {
    const a = player(1, [10.004])
    const b = player(2, [10.001])
    expect(Math.sign(comparePlayersByMetric(a, b, 0, 'desc'))).toBe(-1)
    expect(Math.sign(comparePlayersByMetric(b, a, 0, 'desc'))).toBe(1)
    expect(formatMetricValue(10.004, 2)).toBe('10.00')
    expect(formatMetricValue(null, 2)).toBe('—')
    expect(view([a, b], 'a', 'desc', ['a']).rows.map((row) => row.playerId)).toEqual([1, 2])
  })

  it('分页按实际数组位置截取，空榜为 0 页', () => {
    const players = Array.from({ length: 7 }, (_, index) => player(index + 1, [index]))
    const { rows, rowIndexById } = view(players, 'a', 'desc', ['a'])
    expect(pageRows(rows, 1, 3).map((row) => row.playerId)).toEqual([4, 3, 2])
    expect(rowIndexById[1]).toBe(6)
    expect(pageCount(rows, 3)).toBe(3)
    expect(pageCount([], 3)).toBe(0)
  })
})

function row(overrides: Partial<{
  id: number
  player: number
  level: string
  state: string
  mode: string
  bv: number
  timems: number
  endTime: string
  uploadTime: string
  rightCe: number
  software: string
}> = {}): GlobalRankVideoRow {
  const values = {
    id: 1,
    player: 1,
    level: 'b',
    state: 'c',
    mode: '00',
    bv: 20,
    timems: 10_000,
    endTime: '2026-11-01T04:00:00.000Z',
    uploadTime: '2026-11-01T04:00:01.000Z',
    rightCe: 2,
    software: 'e',
    ...overrides,
  }
  const detail = normalizeDetail({
    id: values.id,
    player: values.player,
    level: values.level,
    state: values.state,
    mode: values.mode,
    software: values.software,
    bv: values.bv,
    timems: values.timems,
    left: 10,
    right: 5,
    double: 5,
    left_ce: 8,
    right_ce: values.rightCe,
    double_ce: 4,
    end_time: values.endTime,
    upload_time: values.uploadTime,
  })
  return {
    datasetId: 'ds',
    videoId: values.id,
    playerId: values.player,
    state: values.state,
    uploadTime: values.uploadTime,
    detail,
    detailState: 'complete',
    discoveredAt: 1,
    updatedAt: 1,
  }
}

function config(patch: Partial<RankConfig['filter']> = {}): RankConfig {
  return {
    ...DEFAULT_RANK_CONFIG,
    metrics: [...DEFAULT_RANK_CONFIG.metrics],
    filter: { ...DEFAULT_RANK_CONFIG.filter, ...patch },
  }
}

describe('排行榜计算与排序视图', () => {
  it('按玩家聚合，筛选先于公式计算', () => {
    const rows = [
      row({ id: 1, player: 1, endTime: '2026-11-01T04:00:00.000Z' }),
      row({ id: 2, player: 1, bv: 40, timems: 10_000, endTime: '2026-11-02T04:00:00.000Z' }),
      row({ id: 3, player: 2, endTime: '2026-10-01T04:00:00.000Z' }),
    ]
    const result = computeRanking(
      rows,
      compileConfig(config({ from: '2026-11-02', to: '2026-11-02' })),
      'ds',
    )
    expect(result.filteredGames).toBe(1)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]!.playerId).toBe(1)
    expect(result.rows[0]!.values[0]).toBe(4)
  })

  it('聚合签名不含方向、列顺序、精度和默认排序', () => {
    const source = config()
    const compiled = compileConfig(source)
    const changed = compileConfig({
      ...source,
      defaultSortMetricId: 'ioe',
      metrics: compiled.metrics
        .map((metric) => ({ ...metric, direction: 'asc' as const, digits: 0 }))
        .reverse(),
    })
    expect(changed.cacheKey).toBe(compiled.cacheKey)
  })

  it('结果按配置的默认指标排序并保留 metricId 绑定', () => {
    const source = config()
    source.metrics = [
      { id: 'x', name: 'X', formula: 'max(bv)', direction: 'desc', digits: 2 },
      { id: 'y', name: 'Y', formula: 'min(bv)', direction: 'asc', digits: 2 },
    ]
    source.defaultSortMetricId = 'y'
    const result = computeRanking([row({ id: 1, player: 1 }), row({ id: 2, player: 2, bv: 40 })], compileConfig(source), 'ds')
    expect(result.metricIds).toEqual(['x', 'y'])
    expect(result.sortMetricId).toBe('y')
    expect(result.direction).toBe('asc')
    expect(result.rows[0]!.playerId).toBe(1)
  })

  it('会话内切换排序只重排已有聚合值', () => {
    const result = computeRanking([row({ id: 1, player: 1 }), row({ id: 2, player: 2, bv: 40 })], compileConfig(config()), 'ds')
    const playersRef = result.players
    const sorted = sortRankingResult(result, 'ioe', 'asc')
    expect(sorted.players).toBe(playersRef)
    expect(sorted.sortMetricId).toBe('ioe')
    expect(sorted.direction).toBe('asc')
    expect(sorted.rowIndexById[1]).toBeDefined()
  })

  it('全部指标都无值时该玩家不进入结果', () => {
    const rows = [row({ id: 1, player: 1, bv: Number.NaN, timems: 10_000 })]
    const onlyInvalid = {
      ...config(),
      metrics: [
        { id: 'a', name: 'A', formula: 'max(bv / time)', direction: 'desc' as const, digits: 1 },
        { id: 'b', name: 'B', formula: 'avg(bv / clicks)', direction: 'desc' as const, digits: 1 },
      ],
    }
    expect(computeRanking(rows, compileConfig(onlyInvalid), 'ds').rows).toEqual([])
  })
})
