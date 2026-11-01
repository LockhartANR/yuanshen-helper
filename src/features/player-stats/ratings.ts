import type { AnalysisGame } from './analysis'
import type { Level } from './model'
import { LEVELS, MIN_BV } from './model'

export type LsfMode = 'std' | 'nf'
export type LsfMetric = 't' | 'b' | 's'

/** 18 个软实力榜（普通 / NF × 三难度 × 三项）的锚点。 */
export type LsfAnchors = Record<string, number>

export interface TopAverages {
  time: number
  bvs: number
  stnb: number
}

export interface LevelRating {
  level: Level
  soft: number
  nfSoft: number
}

export interface RatingSnapshot {
  soft: number
  nfSoft: number
  lsf: number
  title: string
  progress: number
  nfTitle: string
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

/** 单个榜单的 top5 均值；不足五条按站点规则补位。 */
export function top5Average(values: number[], metric: LsfMetric): number {
  const ascending = metric === 't'
  const top = [...values].sort((a, b) => (ascending ? a - b : b - a)).slice(0, 5)
  const pad = ascending ? 999.999 : 0
  const sum = top.reduce((total, value) => total + value, 0)
  return (sum + (5 - top.length) * pad) / 5
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

function singleSoft(metric: LsfMetric, value: number, anchor: number | undefined): number {
  if (!anchor || anchor <= 0) return 0
  if (metric === 't') return value > 0 ? anchor / value : 0
  if (metric === 'b') return value / anchor
  return (value / anchor) ** (1 / 1.7)
}

function levelSoft(
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
    const nfGames = levelGames.filter((game) => game.nf)
    if (levelGames.length === 0) {
      return { level, soft: 0, nfSoft: 0 }
    }
    return {
      level,
      soft: levelSoft(level, topAverages(levelGames), anchors, 'std', weights),
      nfSoft: levelSoft(level, topAverages(nfGames), anchors, 'nf', weights),
    }
  })
  const soft = combinedSoft(levels, 'std', levelWeights)
  const nfSoft = combinedSoft(levels, 'nf', levelWeights)
  // 与原表一致：每个级别先合并普通 / NF，再按级别权重求和。
  const lsf = levels.reduce(
    (sum, item) =>
      sum +
      levelWeights[item.level] * (item.soft * 0.97 + item.nfSoft * 0.03),
    0,
  )
  const title = titleFor(soft, anchors[anchorKey('std', 'e', 't')])
  const nfTitle = titleFor(nfSoft, anchors[anchorKey('nf', 'e', 't')])
  return {
    soft,
    nfSoft,
    lsf,
    title: `${title.title} ${title.progress.toFixed(1)}`,
    progress: title.progress,
    nfTitle: `${nfTitle.title} ${nfTitle.progress.toFixed(1)}`,
    levels,
  }
}
