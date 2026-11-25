import { compileConfig, type CompiledConfig } from './config'
import { matchesFilter } from './filter'
import { normalizeStoredFields } from './fields'
import { createPlayerAccumulator, type PlayerAccumulator } from './expression/evaluate'
import type { CompiledFormula } from './expression/validate'
import type { GlobalRankVideoRow, RankConfig, RankFilter, RankingResult, RankPlayerValues } from './model'
import { buildRankingView, eligiblePlayers, metricIndex } from './ranking'
import { scanRankingVideos } from './store'

export function getRankingGameFields(row: GlobalRankVideoRow, filter: RankFilter) {
  return row.detail && matchesFilter(row, filter) ? normalizeStoredFields(row.detail.fields) : null
}

/**
 * 逐条喂入录像的流式聚合器。
 * 只保留每位玩家一个聚合器，不把该玩家的录像数组留在内存里。
 */
class RankingAccumulator {
  private readonly players = new Map<number, PlayerAccumulator>()
  private readonly formulas: CompiledFormula[]
  private filtered = 0
  private scanned = 0

  constructor(private readonly compiled: CompiledConfig) {
    this.formulas = compiled.metrics.map((metric) => metric.compiled)
  }

  get videoCount(): number {
    return this.scanned
  }

  add(row: GlobalRankVideoRow): void {
    this.scanned += 1
    const fields = getRankingGameFields(row, this.compiled.filter)
    if (!fields) return
    const playerId = row.playerId
    let accumulator = this.players.get(playerId)
    if (!accumulator) {
      accumulator = createPlayerAccumulator(this.formulas)
      this.players.set(playerId, accumulator)
    }
    accumulator.addGame(fields)
    this.filtered += 1
  }

  build(): BuiltRanking {
    const players: RankPlayerValues[] = []
    for (const [playerId, accumulator] of this.players) {
      players.push({
        playerId,
        games: accumulator.gameCount,
        ...accumulator.finish(),
      })
    }
    return {
      players,
      filteredGames: this.filtered,
      videoCount: this.scanned,
    }
  }
}

interface BuiltRanking {
  players: RankPlayerValues[]
  filteredGames: number
  videoCount: number
}

/** 聚合值按 metricIds 绑定；排序视图单独构建，接受结果时按配置的默认指标。 */
function createRankingResult(
  built: BuiltRanking,
  compiled: CompiledConfig,
  datasetId: string,
  startedAt = Date.now(),
): RankingResult {
  const players = eligiblePlayers(built.players, compiled.filter.minGames)
  const metricIds = compiled.metrics.map((metric) => metric.id)
  const preferred = compiled.config.defaultSortMetricId
  const sortMetricId =
    preferred && metricIndex(metricIds, preferred) >= 0 ? preferred : metricIds[0] ?? null
  const direction =
    compiled.metrics.find((metric) => metric.id === sortMetricId)?.direction ?? 'desc'
  const view = sortMetricId
    ? buildRankingView(players, metricIds, sortMetricId, direction)
    : { rows: [], rowIndexById: {} }
  const computedAt = Date.now()
  return {
    players,
    metricIds,
    rows: view.rows,
    rowIndexById: view.rowIndexById,
    sortMetricId,
    direction,
    datasetId,
    configKey: compiled.cacheKey,
    computedAt,
    elapsedMs: Math.max(0, computedAt - startedAt),
    playerCount: view.rows.length,
    videoCount: built.videoCount,
    filteredGames: built.filteredGames,
  }
}

export function computeRanking(
  rows: GlobalRankVideoRow[],
  compiled: CompiledConfig,
  datasetId: string,
  startedAt = Date.now(),
): RankingResult {
  const accumulator = new RankingAccumulator(compiled)
  for (const row of rows) accumulator.add(row)
  return createRankingResult(accumulator.build(), compiled, datasetId, startedAt)
}

/** Worker 和备用主线程使用同一事务扫描、聚合和录像版本。 */
export async function calculateStoredRanking(
  datasetId: string,
  config: RankConfig,
  signal?: AbortSignal,
  onProgress?: (scanned: number) => void,
): Promise<RankingResult> {
  if (signal?.aborted) throw new Error('计算已取消')
  const startedAt = Date.now()
  const compiled = compileConfig(config)
  const accumulator = new RankingAccumulator(compiled)
  const datasetVideoVersion = await scanRankingVideos(datasetId, (row) => {
    if (signal?.aborted) return false
    accumulator.add(row)
    if (accumulator.videoCount % 5_000 === 0) onProgress?.(accumulator.videoCount)
  })
  if (signal?.aborted) throw new Error('计算已取消')
  return { ...createRankingResult(accumulator.build(), compiled, datasetId, startedAt), datasetVideoVersion }
}
