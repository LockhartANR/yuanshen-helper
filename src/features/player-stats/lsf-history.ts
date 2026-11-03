import type { AnalysisGame } from './analysis'
import type { Level, Video } from './model'
import { LEVELS, MIN_BV, compareVideoOrder } from './model'
import { startOfLocalDay } from './analysis-range'
import type { EffectiveVideoDate } from './video-date'
import type {
  LevelRating,
  LsfAnchors,
  LsfMetric,
  LsfMode,
  RatingSnapshot,
  SoftWeights,
} from './ratings'
import {
  WORKBOOK_LEVEL_WEIGHTS,
  WORKBOOK_SOFT_WEIGHTS,
  TOP5_SIZE,
  anchorKey,
  levelRating,
  levelSoft,
  singleSoft,
  snapshotFromLevels,
  top5AverageOf,
} from './ratings'

/**
 * 梁山分（LSF）历史重建：按录像时间逐条更新 18 个 Top5 榜，记录每次分数变化及其来源。
 *
 * 只做纯计算，不碰 DOM 与存储。最终快照与 `ratingSnapshot` 使用同一套单项 / 补位 /
 * 称号映射代码，因此同一录像集、同一参数下两者必须一致。
 */

export const LSF_EPSILON = 1e-9

/** 三个指标固定顺序：用时、3BVS、STNB。 */
const LSF_METRICS: readonly LsfMetric[] = ['t', 'b', 's']

/** 指标名。只有限制 NF 的榜才加 NF 前缀，未限制 NF 的不加「普通」等前缀。 */
const LSF_METRIC_LABELS: Record<LsfMetric, string> = {
  t: '用时',
  b: '3BVS',
  s: 'STNB',
}

/** 榜单名：`用时` / `NF用时`。 */
export function lsfBoardLabel(mode: LsfMode, metric: LsfMetric): string {
  return `${mode === 'nf' ? 'NF' : ''}${LSF_METRIC_LABELS[metric]}`
}

/** LSF 显示保留两位小数；零分是有效值，不用占位符替代。 */
export function formatLsf(value: number): string {
  return value.toFixed(2)
}

/** LSF 差值显示：真实但小于 0.01 的变化不能被显示成 0。 */
export function formatLsfDelta(value: number): string {
  if (Math.abs(value) < 0.005) {
    if (value > 0) return '+<0.01'
    if (value < 0) return '−<0.01'
    return '0.00'
  }
  return `${value > 0 ? '+' : '−'}${Math.abs(value).toFixed(2)}`
}

export interface LsfHistoryOptions {
  anchors: LsfAnchors
  softWeights?: SoftWeights
  levelWeights?: Record<Level, number>
  floors?: Record<Level, number>
  /** 用于区分「未来记录」的当前时点，默认 Date.now()。 */
  now?: number
}

/** 单项榜单被改写时的明细；值都是未格式化的原始数值。 */
export interface LsfEventBoard {
  mode: LsfMode
  metric: LsfMetric
  /** 新成绩在该榜的值：用时为秒，3BVS / STNB 为原始值。 */
  value: number
  /** 新成绩在榜中的名次，1–5。 */
  rank: number
  /** 被替换出去的成绩值；补入空位时为 null。 */
  replacedValue: number | null
  replacedVideo: Video | null
  avgBefore: number
  avgAfter: number
  /** 该指标折算后的 LSF 贡献：级别权重 × 普通 / NF 占比 × 指标权重 × 单项软实力。 */
  contributionBefore: number
  contributionAfter: number
  contributionDelta: number
}

export interface LsfLevelChange {
  level: Level
  softBefore: number
  softAfter: number
  nfSoftBefore: number
  nfSoftAfter: number
  lsfBefore: number
  lsfAfter: number
  /** 该级首条计入录像：空榜补位造成的基线变化也属于这次事件。 */
  baseline: boolean
  /** 本次变化时该级还没有 NF 录像，NF 项按补位值参与计算。 */
  nfPadded: boolean
  /**
   * 初始化基线贡献：该级此前按 0 计，但各榜「变化前」是空榜补位值，
   * 补位折算出的贡献要显式加回，明细各榜加起来才等于本次总涨分。非首条为 0。
   */
  baselineContribution: number
  /** 初始化基线里 NF 补位的那部分，便于单独说明「NF补位」的金额。 */
  nfBaselineContribution: number
  boards: LsfEventBoard[]
}

export interface LsfEvent extends EffectiveVideoDate {
  /** 稳定记录标识：时间 + 网站 ID 或 CSV 导入顺序。 */
  id: string
  game: AnalysisGame
  lsfBefore: number
  lsfAfter: number
  delta: number
  /** 来源文案，例如「用时、STNB、NF用时」。 */
  sources: string[]
  /** 一条录像只影响一个级别。 */
  change: LsfLevelChange
}

export interface LsfHistory {
  /** 对应当前完整录像集的最终评级，与 `ratingSnapshot` 一致。 */
  snapshot: RatingSnapshot
  /** 重建顺序：未定日期基线在前，之后按时间升序。 */
  events: LsfEvent[]
  /** 计入重建的录像数（已套用各级 3BV 下限）。 */
  includedCount: number
  /** 因低于各级 3BV 下限而未计入的录像数。 */
  excludedCount: number
  /** 没有可用日期、按未定日期基线处理的录像数。 */
  undatedCount: number
  /** 结束时间或上传时间晚于 now 的录像数。 */
  futureCount: number
  /** 未定日期基线（零基线之后、第一条有日期记录之前）。 */
  baseline: number
}

export interface LsfPoint {
  date: number
  lsf: number
  /** 图表点对应的事件；区间起点的基线点没有事件，为 null。 */
  eventId: string | null
}

export interface LsfRangeQuery {
  /** 起点（含）；null 表示「全部」，不设起点。 */
  start: number | null
  /** 终点（不含），结束日期次日 00:00；null 表示不设终点。 */
  endExclusive: number | null
  /** 真实当前时刻：所有查询都不会晚于它。 */
  now: number
}

export interface LsfRange {
  /** 所选区间起点；null 表示「全部」。 */
  start: number | null
  /** 实际有效终点：所选终点与真实 now 取较早者。 */
  end: number
  now: number
  /** 区间起点分数（严格早于起点的累计结果）。 */
  baseline: number
  /** 截至有效终点的累计分数。 */
  latest: number
  /** 时段涨分 = latest − baseline，保留真实负值。 */
  change: number
  upCount: number
  downCount: number
  maxGain: number | null
  maxGainDate: number | null
  maxGainEventId: string | null
  /** 单日最大涨分：区间内某本地自然日的 LSF 净增量最大正值。 */
  maxDayGain: number | null
  /** 该自然日的本地 00:00。 */
  maxDayDate: number | null
  /** 该日最新一条事件，用于点击定位。 */
  maxDayEventId: string | null
  /** 区间内事件，按重建顺序（时间升序）。 */
  events: LsfEvent[]
  /** 阶梯图数据：起点基线 + 区间内每个事件。 */
  points: LsfPoint[]
}

interface BoardEntry {
  value: number
  game: AnalysisGame
}

interface Board {
  metric: LsfMetric
  /** 榜内成绩，最好在前；最多五条。 */
  entries: BoardEntry[]
}

interface LevelState {
  level: Level
  /** 已计入该级的录像数。 */
  count: number
  /** 其中 NF 录像数。 */
  nfCount: number
  boards: Record<LsfMode, Record<LsfMetric, Board>>
  soft: number
  nfSoft: number
  lsf: number
}

function eventId(game: AnalysisGame): string {
  const source =
    game.video.importOrder !== undefined
      ? `c${game.video.importOrder}`
      : `s${game.video.id}`
  return `${Math.round(game.date)}-${source}`
}

function createBoard(metric: LsfMetric): Board {
  return { metric, entries: [] }
}

function createLevelState(level: Level): LevelState {
  const board = (): Record<LsfMetric, Board> => ({
    t: createBoard('t'),
    b: createBoard('b'),
    s: createBoard('s'),
  })
  return {
    level,
    count: 0,
    nfCount: 0,
    boards: { std: board(), nf: board() },
    soft: 0,
    nfSoft: 0,
    lsf: 0,
  }
}

function boardValues(board: Board): number[] {
  return board.entries.map((entry) => entry.value)
}

/** 榜内均值，补位规则与 `top5Average` 一致。 */
function boardAverage(board: Board): number {
  return top5AverageOf(boardValues(board), board.metric)
}

function averagesOf(boards: Record<LsfMetric, Board>): {
  time: number
  bvs: number
  stnb: number
} {
  return {
    time: boardAverage(boards.t),
    bvs: boardAverage(boards.b),
    stnb: boardAverage(boards.s),
  }
}

interface InsertResult {
  rank: number
  replacedValue: number | null
  replacedVideo: Video | null
}

/** 按榜的名次规则插入；进不了前五时返回 null。 */
function insertEntry(board: Board, value: number, game: AnalysisGame): InsertResult | null {
  const ascending = board.metric === 't'
  const entries = board.entries
  let index = 0
  while (index < entries.length) {
    const current = entries[index] as BoardEntry
    const better = ascending ? value < current.value : value > current.value
    if (better) break
    index += 1
  }
  if (index >= TOP5_SIZE) return null
  const replaced = entries.length >= TOP5_SIZE ? (entries[TOP5_SIZE - 1] as BoardEntry) : null
  entries.splice(index, 0, { value, game })
  if (entries.length > TOP5_SIZE) entries.length = TOP5_SIZE
  return {
    rank: index + 1,
    replacedValue: replaced ? replaced.value : null,
    replacedVideo: replaced ? replaced.game.video : null,
  }
}

function recomputeLevel(
  state: LevelState,
  anchors: LsfAnchors,
  weights: SoftWeights,
  levelWeights: Record<Level, number>,
): void {
  // 与 ratingSnapshot 一致：该级完全没有计入录像时直接按 0，不套用补位。
  if (state.count === 0) {
    state.soft = 0
    state.nfSoft = 0
    state.lsf = 0
    return
  }
  state.soft = levelSoft(state.level, averagesOf(state.boards.std), anchors, 'std', weights)
  state.nfSoft = levelSoft(state.level, averagesOf(state.boards.nf), anchors, 'nf', weights)
  state.lsf = levelWeights[state.level] * (state.soft * 0.97 + state.nfSoft * 0.03)
}

function metricValueOf(game: AnalysisGame, metric: LsfMetric): number {
  if (metric === 't') return game.time
  if (metric === 'b') return game.bvs
  return game.stnb
}

/** 单项榜折算成该级 LSF 的贡献：级别权重 ×(普通 0.97 / NF 0.03)× 指标权重 × 单项软实力。 */
function boardContribution(
  mode: LsfMode,
  level: Level,
  metric: LsfMetric,
  average: number,
  anchors: LsfAnchors,
  weights: SoftWeights,
  levelWeights: Record<Level, number>,
): number {
  const scale = levelWeights[level] * (mode === 'nf' ? 0.03 : 0.97) * weights[level][metric]
  return singleSoft(metric, average, anchors[anchorKey(mode, level, metric)]) * scale
}

/**
 * 该级事件明细的贡献合计：各榜贡献差值 + 初始化基线贡献。
 * 首条录像时该级此前按 0 计，补位贡献不在任何一榜的差值里，必须单独加回。
 */
export function levelContributionTotal(change: LsfLevelChange): number {
  const boards = change.boards.reduce((sum, board) => sum + board.contributionDelta, 0)
  return boards + change.baselineContribution
}

/** 按当前锚点与参数重建梁山分历史。输入可以未排序，内部先按时间与录像顺序排序。 */
export function buildLsfHistory(
  games: AnalysisGame[],
  options: LsfHistoryOptions,
): LsfHistory {
  const anchors = options.anchors
  const weights = options.softWeights ?? WORKBOOK_SOFT_WEIGHTS
  const levelWeights = options.levelWeights ?? WORKBOOK_LEVEL_WEIGHTS
  const floors = options.floors ?? MIN_BV
  const now = options.now ?? Date.now()

  // 共用日期口径保证未定日期为 0、有效日期为正数；一次排序即可先处理未定日期基线。
  const sorted = [...games].sort(
    (a, b) => a.date - b.date || compareVideoOrder(a.video, b.video),
  )

  const states = new Map<Level, LevelState>()
  for (const level of LEVELS) states.set(level, createLevelState(level))

  const total = (): number =>
    LEVELS.reduce((sum, level) => sum + (states.get(level) as LevelState).lsf, 0)

  const events: LsfEvent[] = []
  let includedCount = 0
  let excludedCount = 0
  let undatedCount = 0
  let futureCount = 0
  let baseline = 0

  for (const game of sorted) {
    if (game.bv < floors[game.level]) {
      excludedCount += 1
      continue
    }
    includedCount += 1
    if (game.undated) undatedCount += 1
    else if (game.date > now) futureCount += 1

    const state = states.get(game.level) as LevelState
    const lsfBefore = total()
    const softBefore = state.soft
    const nfSoftBefore = state.nfSoft
    const levelLsfBefore = state.lsf
    const hadGames = state.count > 0

    // 该级此前没有录像时按 0 计，但各榜「变化前」是空榜补位值（用时 999.999 秒等）。
    // 这些补位折算出的贡献不在任何一榜的差值里，先量出来作为初始化基线，明细才能加总。
    let baselineContribution = 0
    let nfBaselineContribution = 0
    if (!hadGames) {
      for (const mode of ['std', 'nf'] as const) {
        for (const metric of LSF_METRICS) {
          const contribution = boardContribution(
            mode,
            game.level,
            metric,
            boardAverage(state.boards[mode][metric]),
            anchors,
            weights,
            levelWeights,
          )
          baselineContribution += contribution
          if (mode === 'nf') nfBaselineContribution += contribution
        }
      }
    }

    const boards: LsfEventBoard[] = []
    const record = (mode: LsfMode, metric: LsfMetric): void => {
      const board = state.boards[mode][metric]
      const value = metricValueOf(game, metric)
      const avgBefore = boardAverage(board)
      const insert = insertEntry(board, value, game)
      if (!insert) return
      const avgAfter = boardAverage(board)
      const contributionBefore = boardContribution(
        mode,
        game.level,
        metric,
        avgBefore,
        anchors,
        weights,
        levelWeights,
      )
      const contributionAfter = boardContribution(
        mode,
        game.level,
        metric,
        avgAfter,
        anchors,
        weights,
        levelWeights,
      )
      boards.push({
        mode,
        metric,
        value,
        rank: insert.rank,
        replacedValue: insert.replacedValue,
        replacedVideo: insert.replacedVideo,
        avgBefore,
        avgAfter,
        contributionBefore,
        contributionAfter,
        contributionDelta: contributionAfter - contributionBefore,
      })
    }

    for (const metric of LSF_METRICS) record('std', metric)
    if (game.nf) for (const metric of LSF_METRICS) record('nf', metric)

    state.count += 1
    if (game.nf) state.nfCount += 1
    recomputeLevel(state, anchors, weights, levelWeights)

    const lsfAfter = total()
    if (game.undated) baseline = lsfAfter
    const delta = lsfAfter - lsfBefore
    // 只把确实改变了综合 LSF 的录像记成一次事件；同值身份替换不算涨分。
    if (!(Math.abs(delta) > LSF_EPSILON)) continue

    // 明细保留所有成功改写榜单的贡献：锚点 / 权重 / STNB 的非线性换算会把很小的
    // 均值变化放大成有效贡献，不能再用原始均值的绝对阈值裁剪归因。
    const changed = boards.filter((board) => Math.abs(board.contributionDelta) > 0)
    const nfPadded =
      !hadGames && state.nfCount === 0 && Math.abs(state.nfSoft - nfSoftBefore) > LSF_EPSILON
    const sources = changed.map((board) => lsfBoardLabel(board.mode, board.metric))
    if (nfPadded) sources.push('NF补位')

    events.push({
      id: eventId(game),
      date: game.date,
      dateFromUpload: game.dateFromUpload,
      undated: game.undated,
      game,
      lsfBefore,
      lsfAfter,
      delta,
      sources,
      change: {
        level: game.level,
        softBefore,
        softAfter: state.soft,
        nfSoftBefore,
        nfSoftAfter: state.nfSoft,
        lsfBefore: levelLsfBefore,
        lsfAfter: state.lsf,
        baseline: !hadGames,
        nfPadded,
        baselineContribution,
        nfBaselineContribution,
        boards: changed,
      },
    })
  }

  const levels: LevelRating[] = LEVELS.map((level) => {
    const state = states.get(level) as LevelState
    return levelRating(level, state.soft, state.nfSoft, anchors, levelWeights)
  })

  return {
    snapshot: snapshotFromLevels(levels, anchors, levelWeights),
    events,
    includedCount,
    excludedCount,
    undatedCount,
    futureCount,
    baseline,
  }
}

/**
 * 取任意时段的统计。
 *
 * - 起点分数只累计严格早于所选起点的记录；恰好在起点的记录计入区间；「全部」从零基线开始。
 * - 终点是「所选终点与真实 now 取较早者」：选昨天 / 上月时不延伸到今天，也不混入未来成绩。
 * - 区间内事件用于流水、涨分次数、单局 / 单日最大涨分；未定日期基线不参与这些计数。
 */
export function lsfRange(history: LsfHistory, query: LsfRangeQuery): LsfRange {
  const { start, endExclusive, now } = query
  const end = endExclusive === null ? now : Math.min(endExclusive, now)
  const inWindow = (date: number): boolean =>
    date <= now && (endExclusive === null || date < endExclusive)

  let baseline = 0
  let latest = 0
  for (const event of history.events) {
    if (event.undated) {
      baseline = event.lsfAfter
      latest = event.lsfAfter
      continue
    }
    if (start !== null && event.date < start) baseline = event.lsfAfter
    if (inWindow(event.date)) latest = event.lsfAfter
  }

  const events = history.events.filter(
    (event) =>
      !event.undated &&
      (start === null || event.date >= start) &&
      inWindow(event.date),
  )

  let upCount = 0
  let downCount = 0
  let maxGain: number | null = null
  let maxGainDate: number | null = null
  let maxGainEventId: string | null = null
  const dayTotals = new Map<number, { net: number; lastId: string }>()
  for (const event of events) {
    if (event.delta > 0) {
      upCount += 1
      // 并列时取最近一条；容限内视为相等，沿用现有 LSF 误差口径。
      if (
        maxGain === null ||
        event.delta > maxGain + LSF_EPSILON ||
        Math.abs(event.delta - maxGain) <= LSF_EPSILON
      ) {
        maxGain = maxGain === null ? event.delta : Math.max(maxGain, event.delta)
        maxGainDate = event.date
        maxGainEventId = event.id
      }
    } else if (event.delta < 0) {
      downCount += 1
    }
    // 单日净增量：同一天的正负变动一起求和，按本地自然日分组。
    const day = startOfLocalDay(event.date)
    const entry = dayTotals.get(day)
    if (entry) {
      entry.net += event.delta
      entry.lastId = event.id
    } else {
      dayTotals.set(day, { net: event.delta, lastId: event.id })
    }
  }

  let maxDayGain: number | null = null
  let maxDayDate: number | null = null
  let maxDayEventId: string | null = null
  for (const [day, entry] of dayTotals) {
    if (!(entry.net > 0)) continue
    // 并列时取最近一天，并定位到该日最新一条流水。
    if (
      maxDayGain === null ||
      entry.net > maxDayGain + LSF_EPSILON ||
      Math.abs(entry.net - maxDayGain) <= LSF_EPSILON
    ) {
      maxDayGain = maxDayGain === null ? entry.net : Math.max(maxDayGain, entry.net)
      maxDayDate = day
      maxDayEventId = entry.lastId
    }
  }

  const points: LsfPoint[] = []
  const startDate = start ?? (events[0]?.date ?? end)
  points.push({ date: startDate, lsf: baseline, eventId: null })
  for (const event of events) {
    points.push({ date: event.date, lsf: event.lsfAfter, eventId: event.id })
  }

  return {
    start,
    end,
    now,
    baseline,
    latest,
    change: latest - baseline,
    upCount,
    downCount,
    maxGain,
    maxGainDate,
    maxGainEventId,
    maxDayGain,
    maxDayDate,
    maxDayEventId,
    events,
    points,
  }
}
