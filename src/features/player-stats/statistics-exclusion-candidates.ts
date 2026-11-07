/**
 * 慢局候选与均值影响预览的纯逻辑。
 *
 * 输入是当前已发布的统计候选录像和排除后的管理条目；这里不读取 DOM、
 * 数据库或暂存快照，也不写排除规则。均值基准先按统计口径筛选完整集合，
 * 再单独计算每一行“只排除这一局”的结果。
 */

import { analyzeGames } from './analysis'
import { inDateRange } from './analysis-range'
import type { Level } from './model'
import { LEVELS, MIN_BV, compareVideoOrder } from './model'
import type { Video } from './model'
import type { PlayerSource } from './player-state'
import type { ExclusionEntry } from './statistics-exclusion'

export interface ExclusionCandidateScope {
  source: PlayerSource
  /** CSV 内选定的文件来源；null 表示当前数据源的全部文件。 */
  sourceId: string | null
  /** 本地自然日边界；null 表示不限。终点左闭右开。 */
  start: number | null
  endExclusive: number | null
  /** 从统计结果跳入时可能只带一个难度；直接打开时保留三难度。 */
  levels: readonly Level[]
  software: string
  nfOnly: boolean
  floors: Record<Level, number>
  /** 可见的范围说明，例如「近30天」「2026年10月 · 高级」。 */
  label: string
  /** 区分直接进入与统计结果跳转。 */
  origin: 'direct' | 'jump'
}

export interface CandidateBaseline {
  level: Level
  count: number
  total: number
  mean: number
  median: number
}

export type CandidatePreviewKind = 'decrease' | 'zero' | 'increase' | 'empty'

export interface MeanImpact {
  before: number
  after: number | null
  /** after - before，未舍入；无有效记录时为 null。 */
  delta: number | null
  preview: CandidatePreviewKind
}

export interface CandidateRow extends MeanImpact {
  entry: ExclusionEntry
  video: Video
  level: Level
  time: number
}

export interface CandidateResult {
  baselines: Record<Level, CandidateBaseline | null>
  /** 按慢局候选规则选出的全部行，未经过列表定位筛选。 */
  candidates: CandidateRow[]
  /** 当前预览范围内全部可参与统计的记录键；用于区分「不参与本预览范围」。 */
  eligibleKeys: Set<string>
}

function emptyBaseline(level: Level): CandidateBaseline {
  return { level, count: 0, total: 0, mean: 0, median: 0 }
}

function medianOf(sorted: readonly number[]): number {
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle]!
  return (sorted[middle - 1]! + sorted[middle]!) / 2
}

function baselineFor(level: Level, times: readonly number[]): CandidateBaseline {
  if (times.length === 0) return emptyBaseline(level)
  const sorted = [...times].sort((a, b) => a - b)
  const total = times.reduce((sum, time) => sum + time, 0)
  return {
    level,
    count: times.length,
    total,
    mean: total / times.length,
    median: medianOf(sorted),
  }
}

/** 把两个本地自然日区间求交集；任一端为 null 表示不限。 */
export function intersectCandidateRange(
  start: number | null,
  endExclusive: number | null,
  applied: { start: number | null; endExclusive: number | null },
): { start: number | null; endExclusive: number | null } {
  const nextStart =
    start === null
      ? applied.start
      : applied.start === null
        ? start
        : Math.max(start, applied.start)
  const nextEnd =
    endExclusive === null
      ? applied.endExclusive
      : applied.endExclusive === null
        ? endExclusive
        : Math.min(endExclusive, applied.endExclusive)
  if (nextStart !== null && nextEnd !== null && nextStart >= nextEnd) {
    return { start: nextStart, endExclusive: nextStart }
  }
  return { start: nextStart, endExclusive: nextEnd }
}

export function directCandidateScope(
  source: PlayerSource,
  floors: Record<Level, number> = MIN_BV,
): ExclusionCandidateScope {
  return {
    source,
    sourceId: null,
    start: null,
    endExclusive: null,
    levels: [...LEVELS],
    software: 'all',
    nfOnly: false,
    floors: { ...floors },
    label: '全部时段',
    origin: 'direct',
  }
}

/** 单行“只排除这一局”的普通算术均值影响；不改写基准。 */
export function meanImpact(baseline: CandidateBaseline, time: number): MeanImpact {
  if (baseline.count > 1) {
    const after = (baseline.total - time) / (baseline.count - 1)
    const delta = after - baseline.mean
    return {
      before: baseline.mean,
      after,
      delta,
      preview: delta < -1e-9 ? 'decrease' : delta > 1e-9 ? 'increase' : 'zero',
    }
  }
  return { before: baseline.mean, after: null, delta: null, preview: 'empty' }
}

/** 每个难度只取慢局前 limit 条，均值与中位数基准使用完整范围。 */
export function buildExclusionCandidates(
  entries: readonly ExclusionEntry[],
  videos: readonly Video[],
  scope: ExclusionCandidateScope,
  limit: number,
): CandidateResult {
  const byVideoId = new Map<number, ExclusionEntry>()
  for (const entry of entries) {
    if (entry.videoId !== null) byVideoId.set(entry.videoId, entry)
  }
  const selectedLevels = new Set(scope.levels)
  const games = analyzeGames(
    [...videos],
    {
      software: scope.source === 'csv' ? 'all' : scope.software,
      nfOnly: scope.nfOnly,
    },
    1,
  ).filter(
    (game) =>
      selectedLevels.has(game.level) &&
      game.bv >= (scope.floors[game.level] ?? MIN_BV[game.level]) &&
      inDateRange(game.date, {
        key: 'custom',
        start: scope.start,
        endExclusive: scope.endExclusive,
        label: scope.label,
      }),
  )

  const timesByLevel = new Map<Level, number[]>()
  const entriesByLevel = new Map<Level, Array<{ entry: ExclusionEntry; video: Video }>>()
  const eligibleKeys = new Set<string>()
  for (const game of games) {
    const entry = byVideoId.get(game.video.id)
    if (!entry || entry.excluded) continue
    if (scope.sourceId !== null && entry.sourceId !== scope.sourceId) continue
    eligibleKeys.add(entry.key)
    const times = timesByLevel.get(game.level)
    if (times) times.push(game.time)
    else timesByLevel.set(game.level, [game.time])
    const rows = entriesByLevel.get(game.level)
    if (rows) rows.push({ entry, video: game.video })
    else entriesByLevel.set(game.level, [{ entry, video: game.video }])
  }

  const baselines = {} as Record<Level, CandidateBaseline | null>
  const candidates: CandidateRow[] = []
  for (const level of LEVELS) {
    const baseline = baselineFor(level, timesByLevel.get(level) ?? [])
    baselines[level] = baseline.count === 0 ? null : baseline
    if (!selectedLevels.has(level) || baseline.count === 0) continue
    const rows = [...(entriesByLevel.get(level) ?? [])].sort(
      (a, b) => b.video.timems - a.video.timems || compareVideoOrder(a.video, b.video),
    )
    for (const item of rows.slice(0, Math.max(1, limit))) {
      const time = item.video.timems / 1000
      const impact = meanImpact(baseline, time)
      candidates.push({
        entry: item.entry,
        video: item.video,
        level,
        time,
        ...impact,
      })
    }
  }

  return { baselines, candidates, eligibleKeys }
}

/** 均值下降排序：只按未舍入差值升序，不把无预览值混进下降项。 */
export function sortCandidateRows(rows: readonly CandidateRow[]): CandidateRow[] {
  return [...rows].sort((a, b) => {
    if (a.delta === null && b.delta === null) return compareVideoOrder(a.video, b.video)
    if (a.delta === null) return 1
    if (b.delta === null) return -1
    return a.delta - b.delta || compareVideoOrder(a.video, b.video)
  })
}
