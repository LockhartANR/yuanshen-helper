import type { AnalysisGame } from './analysis'
import type { Level } from './model'
import { LEVELS, MIN_BV } from './model'

export type LsfMode = 'std' | 'nf'
export type LsfMetric = 't' | 'b' | 's'

/** 18 个软实力榜（普通 / NF × 三难度 × 三项）的锚点。 */
export type LsfAnchors = Record<string, number>

/** 每个软实力榜取前五条。 */
export const TOP5_SIZE = 5
/** 用时不足五条时的补位值（秒），与站点 / 工作簿一致。 */
const TIME_PAD = 999.999
/** 单级软实力的固定 100 尺度换算到综合 4000 尺度的倍数。 */
const LSF_LEVEL_SCALE = 40

export interface TopAverages {
  time: number
  bvs: number
  stnb: number
}

export interface LevelRating {
  level: Level
  /** 该级软实力，单级 100 尺度。 */
  soft: number
  /** 该级 NF 软实力，单级 100 尺度。 */
  nfSoft: number
  /** 该级对综合 LSF 的贡献：级别权重 × (0.97 × soft + 0.03 × nfSoft)。 */
  lsf: number
  /** 单级定阶称号（不含进度）。 */
  title: string
  /** 单级定阶的阶内进度，最高称号允许外推。 */
  progress: number
  nfTitle: string
  nfProgress: number
}

export interface RatingSnapshot {
  soft: number
  nfSoft: number
  lsf: number
  /** 综合定阶称号，进度单独保存。 */
  title: string
  /** 综合定阶的阶内进度，最高称号允许外推。 */
  progress: number
  /** 综合 NF定阶称号。 */
  nfTitle: string
  /** 综合 NF定阶的阶内进度，最高称号允许外推。 */
  nfProgress: number
  levels: LevelRating[]
}

export interface SoftWeights {
  b: { t: number; b: number; s: number }
  i: { t: number; b: number; s: number }
  e: { t: number; b: number; s: number }
}

export const WORKBOOK_SOFT_WEIGHTS: SoftWeights = {
  b: { t: 32, b: 48, s: 20 },
  i: { t: 36, b: 36, s: 28 },
  e: { t: 32, b: 32, s: 36 },
}

export const WORKBOOK_LEVEL_WEIGHTS: Record<Level, number> = { b: 6, i: 14, e: 20 }

/** 大表 Set!AH27:AL35 的标准值，作为默认锚点；STNB 使用原始值。 */
export const WORKBOOK_ANCHORS: LsfAnchors = {
  'std:bt': 1.355,
  'std:bb': 9.245,
  'std:bs': 230,
  'std:it': 8.371,
  'std:ib': 6.128,
  'std:is': 177.9,
  'std:et': 34.08,
  'std:eb': 4.86,
  'std:es': 157.9,
  'nf:bt': 1.463,
  'nf:bb': 7.486,
  'nf:bs': 193.5,
  'nf:it': 9.331,
  'nf:ib': 5.222,
  'nf:is': 147.3,
  'nf:et': 38.64,
  'nf:eb': 4.201,
  'nf:es': 125.7,
}
const TITLE_NAMES = [
  '工兵',
  '小雷神',
  '大雷神',
  '小雷圣',
  '大雷圣',
  '小雷帝',
  '大雷帝',
  '外星人',
] as const
const TITLE_BOUNDARIES = [100, 60, 55, 50, 45, 40, 35, 30, 25]

export function anchorKey(mode: LsfMode, level: Level, metric: LsfMetric): string {
  return `${mode}:${level}${metric}`
}

/** 用已按优劣排好的前五值计算均值；补位规则与求和顺序与 `top5Average` 完全一致。 */
export function top5AverageOf(top: number[], metric: LsfMetric): number {
  const pad = metric === 't' ? TIME_PAD : 0
  let sum = 0
  for (const value of top) sum += value
  return (sum + (TOP5_SIZE - top.length) * pad) / TOP5_SIZE
}

/** 单个榜单的 top5 均值；不足五条按站点规则补位。 */
export function top5Average(values: number[], metric: LsfMetric): number {
  const ascending = metric === 't'
  const top = [...values]
    .sort((a, b) => (ascending ? a - b : b - a))
    .slice(0, TOP5_SIZE)
  return top5AverageOf(top, metric)
}

function averageTop(
  games: AnalysisGame[],
  pick: (game: AnalysisGame) => number,
  ascending: boolean,
): number {
  return top5Average(games.map(pick), ascending ? 't' : 'b')
}

function topAverages(games: AnalysisGame[]): TopAverages {
  return {
    time: averageTop(games, (game) => game.time, true),
    bvs: averageTop(games, (game) => game.bvs, false),
    stnb: averageTop(games, (game) => game.stnb, false),
  }
}

/** 单项软实力：用时 A/V，3BVS V/A，STNB (V/A)^(1/1.7)。 */
export function singleSoft(metric: LsfMetric, value: number, anchor: number | undefined): number {
  if (!anchor || anchor <= 0) return 0
  if (metric === 't') return value > 0 ? anchor / value : 0
  if (metric === 'b') return value / anchor
  return (value / anchor) ** (1 / 1.7)
}

/** 单级软实力：三项单项 × 指标权重求和，单级 100 尺度。 */
export function levelSoft(
  level: Level,
  averages: TopAverages,
  anchors: LsfAnchors,
  mode: LsfMode,
  weights: SoftWeights,
): number {
  const weight = weights[level]
  return (
    singleSoft('t', averages.time, anchors[anchorKey(mode, level, 't')]) * weight.t +
    singleSoft('b', averages.bvs, anchors[anchorKey(mode, level, 'b')]) * weight.b +
    singleSoft('s', averages.stnb, anchors[anchorKey(mode, level, 's')]) * weight.s
  )
}

function combinedSoft(
  levels: LevelRating[],
  mode: 'std' | 'nf',
  levelWeights: Record<Level, number>,
): number {
  return levels.reduce(
    (sum, item) => sum + (mode === 'std' ? item.soft : item.nfSoft) * levelWeights[item.level],
    0,
  )
}

/**
 * 单级评级：软实力 / NF软实力保留单级尺度，LSF 为该级贡献（已乘级别权重）。
 * 单级定阶把单级 100 尺度按固定倍数换算到 4000 尺度，因此不随级别权重变化。
 */
export function levelRating(
  level: Level,
  soft: number,
  nfSoft: number,
  anchors: LsfAnchors,
  levelWeights: Record<Level, number> = WORKBOOK_LEVEL_WEIGHTS,
): LevelRating {
  const title = titleFor(soft * LSF_LEVEL_SCALE, anchors[anchorKey('std', 'e', 't')])
  const nfTitle = titleFor(nfSoft * LSF_LEVEL_SCALE, anchors[anchorKey('nf', 'e', 't')])
  return {
    level,
    soft,
    nfSoft,
    lsf: levelWeights[level] * (soft * 0.97 + nfSoft * 0.03),
    title: title.title,
    progress: title.progress,
    nfTitle: nfTitle.title,
    nfProgress: nfTitle.progress,
  }
}

/** 由三级评级汇总综合软实力、综合 LSF 与综合定阶。 */
export function snapshotFromLevels(
  levels: LevelRating[],
  anchors: LsfAnchors,
  levelWeights: Record<Level, number> = WORKBOOK_LEVEL_WEIGHTS,
): RatingSnapshot {
  const soft = combinedSoft(levels, 'std', levelWeights)
  const nfSoft = combinedSoft(levels, 'nf', levelWeights)
  // 各级 LSF 贡献相加即综合 LSF：三级相加等于综合，不允许另算一套。
  const lsf = levels.reduce((sum, item) => sum + item.lsf, 0)
  const title = titleFor(soft, anchors[anchorKey('std', 'e', 't')])
  const nfTitle = titleFor(nfSoft, anchors[anchorKey('nf', 'e', 't')])
  return {
    soft,
    nfSoft,
    lsf,
    title: title.title,
    progress: title.progress,
    nfTitle: nfTitle.title,
    nfProgress: nfTitle.progress,
    levels,
  }
}

/** 等价 et 映射到称号；区间内按软实力线性插值。 */
export function titleFor(combined: number, etAnchor: number | undefined): { title: string; progress: number } {
  if (!etAnchor || etAnchor <= 0 || combined <= 0) return { title: '新手', progress: 0 }
  const ratio = combined / 4000
  const et = etAnchor / ratio
  if (et > 100) {
    const progress = Math.min(10, ratio / (etAnchor / 100) * 10)
    return { title: '新手', progress }
  }
  for (let index = 0; index < TITLE_BOUNDARIES.length - 1; index += 1) {
    const high = TITLE_BOUNDARIES[index] as number
    const low = TITLE_BOUNDARIES[index + 1] as number
    if (et <= high && et > low) {
      const highSoft = etAnchor / high
      const lowSoft = etAnchor / low
      const progress = ((ratio - highSoft) / (lowSoft - highSoft)) * 10
      return { title: TITLE_NAMES[index] as string, progress }
    }
  }
  const highSoft = etAnchor / 30
  const lowSoft = etAnchor / 25
  return { title: '外星人', progress: ((ratio - highSoft) / (lowSoft - highSoft)) * 10 }
}

/** 全部三级别 + 普通/NF 综合软实力与 LSF。 */
export function ratingSnapshot(
  games: AnalysisGame[],
  anchors: LsfAnchors,
  weights: SoftWeights = WORKBOOK_SOFT_WEIGHTS,
  levelWeights: Record<Level, number> = WORKBOOK_LEVEL_WEIGHTS,
  floors: Record<Level, number> = MIN_BV,
): RatingSnapshot {
  const levels = LEVELS.map((level) => {
    const levelGames = games.filter(
      (game) => game.level === level && game.bv >= floors[level],
    )
    if (levelGames.length === 0) return levelRating(level, 0, 0, anchors, levelWeights)
    const nfGames = levelGames.filter((game) => game.nf)
    return levelRating(
      level,
      levelSoft(level, topAverages(levelGames), anchors, 'std', weights),
      levelSoft(level, topAverages(nfGames), anchors, 'nf', weights),
      anchors,
      levelWeights,
    )
  })
  return snapshotFromLevels(levels, anchors, levelWeights)
}
