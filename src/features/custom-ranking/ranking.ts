import type {
  RankDirection,
  RankPlayerValues,
  RankingResult,
  RankingResultRow,
} from './model'

function isComparable(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** 空值与非有限值始终排在有效数值之后，不随升序 / 降序反转。 */
export function compareValues(
  left: number | null,
  right: number | null,
  direction: RankDirection,
): number {
  const leftValid = isComparable(left)
  const rightValid = isComparable(right)
  if (!leftValid && !rightValid) return 0
  if (!leftValid) return 1
  if (!rightValid) return -1
  const diff = direction === 'desc' ? right - left : left - right
  return diff < 0 ? -1 : diff > 0 ? 1 : 0
}

/** 只用当前指标比较；同值与空值都按玩家 ID 升序稳定展示，ID 不参与并列名次。 */
export function comparePlayersByMetric(
  left: RankPlayerValues,
  right: RankPlayerValues,
  index: number,
  direction: RankDirection,
): number {
  const order = compareValues(
    left.values[index] ?? null,
    right.values[index] ?? null,
    direction,
  )
  return order !== 0 ? order : left.playerId - right.playerId
}

export function sortPlayersByMetric(
  players: RankPlayerValues[],
  index: number,
  direction: RankDirection,
): RankPlayerValues[] {
  return [...players].sort((left, right) => comparePlayersByMetric(left, right, index, direction))
}

export function metricIndex(metricIds: string[], metricId: string | null): number {
  return metricId ? metricIds.indexOf(metricId) : -1
}

/** 聚合阶段筛掉局数不足和全部指标无值的玩家；排序阶段不再改成员。 */
export function eligiblePlayers(players: RankPlayerValues[], minGames: number): RankPlayerValues[] {
  return players.filter(
    (player) => player.games >= minGames && player.values.some(isComparable),
  )
}

export interface RankingView {
  rows: RankingResultRow[]
  rowIndexById: Record<number, number>
}

/**
 * 按单个指标构建有序行、竞赛名次（1、1、3）和玩家 ID → 实际数组位置。
 * 名次按当前指标的原始值判定，显示精度不参与；空值名次为 null。
 */
export function buildRankingView(
  players: RankPlayerValues[],
  metricIds: string[],
  sortMetricId: string | null,
  direction: RankDirection,
): RankingView {
  const index = metricIndex(metricIds, sortMetricId)
  if (index < 0) throw new Error('当前结果没有该排序指标')
  const sorted = sortPlayersByMetric(players, index, direction)
  const rows: RankingResultRow[] = []
  const rowIndexById: Record<number, number> = {}
  let rank: number | null = null
  let previous: number | null = null
  for (let position = 0; position < sorted.length; position += 1) {
    const player = sorted[position]!
    rowIndexById[player.playerId] = position
    const value = player.values[index] ?? null
    if (isComparable(value)) {
      if (rank === null || value !== previous) rank = position + 1
      previous = value
    } else {
      rank = null
      previous = null
    }
    rows.push({
      rank,
      playerId: player.playerId,
      games: player.games,
      values: player.values,
      samples: player.samples,
      valid: player.values.map((item) => isComparable(item)),
    })
  }
  return { rows, rowIndexById }
}

/** 会话内切换排序：只重排已有聚合值，不重新计算、不改动保存配置。 */
export function sortRankingResult(
  result: RankingResult,
  sortMetricId: string,
  direction: RankDirection,
): RankingResult {
  if (metricIndex(result.metricIds, sortMetricId) < 0) return result
  const view = buildRankingView(result.players, result.metricIds, sortMetricId, direction)
  return {
    ...result,
    rows: view.rows,
    rowIndexById: view.rowIndexById,
    sortMetricId,
    direction,
  }
}

/**
 * 当前排序列被删除且没有可用列时，保留聚合值但清除名次和排序标记，
 * 避免继续按已隐藏指标排名。
 */
export function clearRankingSort(result: RankingResult): RankingResult {
  const rowIndexById: Record<number, number> = {}
  const rows: RankingResultRow[] = result.players.map((player, index) => {
    rowIndexById[player.playerId] = index
    return {
      rank: null,
      playerId: player.playerId,
      games: player.games,
      values: player.values,
      samples: player.samples,
      valid: player.values.map((value) => isComparable(value)),
    }
  })
  return { ...result, rows, rowIndexById, sortMetricId: null }
}

export function pageRows(
  rows: RankingResultRow[],
  page: number,
  pageSize: number,
): RankingResultRow[] {
  const size = Math.max(1, Math.floor(pageSize))
  const index = Math.max(0, Math.floor(page))
  return rows.slice(index * size, index * size + size)
}

/** 空榜返回 0 页，调用方据此隐藏分页栏。 */
export function pageCount(rows: RankingResultRow[], pageSize: number): number {
  return Math.ceil(rows.length / Math.max(1, Math.floor(pageSize)))
}

/** 显示精度不参与排序。 */
export function formatMetricValue(value: number | null, digits: number): string {
  if (value === null || !Number.isFinite(value)) return '—'
  return value.toFixed(Math.max(0, Math.min(6, Math.floor(digits))))
}
