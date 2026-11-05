import { analyzeGames, applyBvFloors, todayStats } from './analysis'
import type { DateRange } from './analysis-range'
import { inDateRange, rangeSignature } from './analysis-range'
import type { AnalysisSettings } from './analysis-settings'
import type { AnalysisDataSnapshot, AnalysisFilterState } from './analysis-state'
import { buildLsfHistory, lsfRange } from './lsf-history'
import type { LsfEvent, LsfHistory, LsfRange } from './lsf-history'
import type { DatasetSnapshot } from './model'

/** 梁山分页签的展示数据：时段区间与倒序流水一起派生，供视图与定位回查共用。 */
export interface LsfViewData {
  range: LsfRange
  events: LsfEvent[]
}

/** 按已应用时段生成梁山分区间与流水；「全部」时附加未定日期的流水。 */
export function lsfViewData(history: LsfHistory, bounds: DateRange, clock: number): LsfViewData {
  const range = lsfRange(history, {
    start: bounds.start,
    endExclusive: bounds.endExclusive,
    now: clock,
  })
  const undated = bounds.start === null ? history.events.filter((event) => event.undated) : []
  return {
    range,
    events: [...range.events].reverse().concat([...undated].reverse()),
  }
}

export interface AnalysisDataInput {
  dataset: DatasetSnapshot
  filters: AnalysisFilterState
  settings: AnalysisSettings
  bounds: DateRange
  /** 数据快照建立时的时钟；今日与梁山分历史都依赖它。 */
  dataNow: number
}

export interface AnalysisDataProvider {
  /** 按输入返回统计数据；未变化的输入复用上一次结果。 */
  get(input: AnalysisDataInput): AnalysisDataSnapshot
}

type RangeData = Pick<AnalysisDataSnapshot, 'games' | 'rangeGames'>

function datasetKey(dataset: DatasetSnapshot): string {
  return `${dataset.source}|${dataset.identity}|${dataset.contentVersion}`
}

/** CSV 的软件筛选在原有口径里固定按全部软件统计。 */
function effectiveSoftware(dataset: DatasetSnapshot, filters: AnalysisFilterState): string {
  return dataset.source === 'csv' ? 'all' : filters.software
}

/**
 * 统计派生与缓存。每个大表实例独立持有，不读取 DOM，也不修改传入设置。
 * 缓存键覆盖数据身份、筛选、日期、3BV 下限与计分参数，切页 / 展开不重建历史。
 */
export function createAnalysisDataProvider(): AnalysisDataProvider {
  let ratingCache: { key: string; games: ReturnType<typeof analyzeGames> } | null = null
  let filteredCache: {
    key: string
    games: ReturnType<typeof analyzeGames>
  } | null = null
  let rangeCache: {
    key: string
    data: RangeData
  } | null = null
  let todayCache: { key: string; rows: ReturnType<typeof todayStats> } | null = null
  let historyCache: { key: string; history: LsfHistory } | null = null

  function ratingGamesFor(dataset: DatasetSnapshot): ReturnType<typeof analyzeGames> {
    const key = datasetKey(dataset)
    if (ratingCache?.key === key) return ratingCache.games
    const games = analyzeGames(dataset.videos, {}, 1)
    ratingCache = { key, games }
    return games
  }

  function filteredGamesFor(
    dataset: DatasetSnapshot,
    filters: AnalysisFilterState,
  ): ReturnType<typeof analyzeGames> {
    const software = effectiveSoftware(dataset, filters)
    const key = `${datasetKey(dataset)}|${software}|${filters.nfOnly ? 'nf' : 'all'}`
    if (filteredCache?.key === key) return filteredCache.games
    const games = analyzeGames(dataset.videos, { software, nfOnly: filters.nfOnly }, 1)
    filteredCache = { key, games }
    return games
  }

  function rangeGamesFor(
    input: AnalysisDataInput,
    filtered: ReturnType<typeof analyzeGames>,
  ): RangeData {
    const floors = JSON.stringify(input.settings.bvFloors)
    const key = [
      datasetKey(input.dataset),
      effectiveSoftware(input.dataset, input.filters),
      input.filters.nfOnly ? 'nf' : 'all',
      rangeSignature(input.bounds),
      floors,
    ].join('|')
    if (rangeCache?.key === key) return rangeCache.data
    // 全局筛选与梁山分共用同一份时段；「全部」不设日期边界。
    const games = applyBvFloors(filtered, input.settings.bvFloors).filter((game) =>
      inDateRange(game.date, input.bounds),
    )
    // 月年局数与 rAvg 保留 2–9，但不再套用各级 3BV 下限。
    const rangeGames = filtered.filter(
      (game) => game.bv >= 2 && inDateRange(game.date, input.bounds),
    )
    const data = { games, rangeGames }
    rangeCache = { key, data }
    return data
  }

  function todayRows(
    dataset: DatasetSnapshot,
    dataNow: number,
  ): ReturnType<typeof todayStats> {
    const key = `${datasetKey(dataset)}|${dataNow}`
    if (todayCache?.key === key) return todayCache.rows
    const rows = todayStats(ratingGamesFor(dataset), dataNow)
    todayCache = { key, rows }
    return rows
  }

  function historyFor(input: AnalysisDataInput): LsfHistory {
    const key = [
      datasetKey(input.dataset),
      input.dataNow,
      JSON.stringify(input.settings.anchors),
      JSON.stringify(input.settings.softWeights),
      JSON.stringify(input.settings.levelWeights),
      JSON.stringify(input.settings.bvFloors),
    ].join('|')
    if (historyCache?.key === key) return historyCache.history
    const history = buildLsfHistory(ratingGamesFor(input.dataset), {
      anchors: input.settings.anchors,
      softWeights: input.settings.softWeights,
      levelWeights: input.settings.levelWeights,
      floors: input.settings.bvFloors,
      now: input.dataNow,
    })
    historyCache = { key, history }
    return history
  }

  function get(input: AnalysisDataInput): AnalysisDataSnapshot {
    const filtered = filteredGamesFor(input.dataset, input.filters)
    return {
      ...rangeGamesFor(input, filtered),
      ratingGames: ratingGamesFor(input.dataset),
      today: todayRows(input.dataset, input.dataNow),
      history: historyFor(input),
    }
  }

  return { get }
}
