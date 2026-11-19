import type { CompiledConfig } from './config'
import { matchesFilter } from './filter'
import { normalizeStoredFields } from './fields'
import { createPlayerAccumulator, type PlayerAccumulator } from './expression/evaluate'
import type { GlobalRankVideoRow, RankingResult, RankPlayerValues } from './model'
import { buildRankingView, eligiblePlayers, metricIndex } from './ranking'

interface PlayerState {
  accumulator: PlayerAccumulator
  games: number
}

/**
 * 逐条喂入录像的流式聚合器。
 * 只保留每位玩家一个聚合器，不把该玩家的录像数组留在内存里。
 */
export class RankingAccumulator {
  private readonly players = new Map<number, PlayerState>()
  private filtered = 0
  private scanned = 0

  constructor(readonly compiled: CompiledConfig) {}

  add(row: GlobalRankVideoRow): void {
    this.scanned += 1
    if (!row.detail || !matchesFilter(row, this.compiled.filter)) return
    const playerId = row.playerId
    let state = this.players.get(playerId)
    if (!state) {
      state = {
        accumulator: createPlayerAccumulator(this.compiled.metrics.map((metric) => metric.compiled)),
        games: 0,
      }
      this.players.set(playerId, state)
    }
    state.accumulator.addGame(normalizeStoredFields(row.detail.fields))
    state.games += 1
    this.filtered += 1
  }

  build(): BuiltRanking {
    const players: RankPlayerValues[] = []
    for (const [playerId, state] of this.players) {
      const result = state.accumulator.finish()
      players.push({
        playerId,
        games: state.games,
        values: result.values,
        samples: result.samples,
      })
    }
    return {
      players,
      filteredGames: this.filtered,
      videoCount: this.scanned,
    }
  }
}

export interface BuiltRanking {
  players: RankPlayerValues[]
  filteredGames: number
  videoCount: number
}

/** 聚合值按 metricIds 绑定；排序视图单独构建，接受结果时按配置的默认指标。 */
export function createRankingResult(
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
