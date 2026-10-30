/** 标准三阶难度。自定义难度（c8_8_40 等）不参与统计。 */
export const LEVELS = ['b', 'i', 'e'] as const
export type Level = (typeof LEVELS)[number]

/** 前端成绩的三个指标：time / 3bvs / stnb。 */
export const TOP_STATS = ['time', 'bvs', 'stnb'] as const
export type TopStat = (typeof TOP_STATS)[number]

/** 站点前端成绩的 3BV 下限，低于下限的录像不计入。 */
export const MIN_BV: Record<Level, number> = { b: 10, i: 30, e: 100 }

/** STNB 系数：stnb = coefficient × bv / seconds^1.7。 */
export const STNB_COEFFICIENT: Record<Level, number> = { b: 36, i: 162, e: 435 }

/** 站点只把标准模式当作正式成绩。 */
export const STANDARD_MODE = '00'

/** 只有已通过审核的录像进站点 PB / 前端成绩。 */
export const APPROVED_STATE = 'c'

const SOFTWARE_LABELS: Record<string, string> = {
  a: 'avf',
  e: 'evf',
  m: 'mvf',
  r: 'rmv',
}

export function isLevel(value: string): value is Level {
  return (LEVELS as readonly string[]).includes(value)
}

export function softwareLabel(code: string): string {
  return SOFTWARE_LABELS[code] ?? (code === '' ? '未知' : code)
}

/** `videolist` 里的一条。 */
export interface VideoMeta {
  id: number
  upload_time: string
  state: string
  ongoing_tournament?: boolean
}

/** `staticdetailbatch` 里的一条（只保留用得上的字段）。 */
export interface VideoDetail {
  id: number
  software: string
  level: string
  mode: string
  end_time: string | null
  timems: number
  bv: number | null
  left: number | null
  right: number | null
  double: number | null
  left_ce: number | null
  right_ce: number | null
  double_ce: number | null
}

/** 列表与明细合并后的记录，`duplicate` 系列字段由 `markDuplicates` 填。 */
export interface Video extends VideoMeta, VideoDetail {
  ongoing_tournament: boolean
  duplicate: boolean
  duplicateOf: number | null
  suspectDuplicate: boolean
}

export interface AnalyzeOptions {
  /** `'all'` 或 `a` / `e` / `m` / `r`；只作用于 PB 表，前端成绩不吃这个筛选。 */
  software?: string
  nfOnly?: boolean
  /** 是否把 `a/b/d/e` 也算进来（默认关，关掉才能和站点对拍）。 */
  includeUnapproved?: boolean
  /** 隐藏重复与疑似重复（默认关，调用方按界面状态传）。 */
  hideDuplicates?: boolean
}

export interface PbRow {
  level: Level
  bv: number
  video: Video
}

export interface Top5Row {
  rank: number
  video: Video
  /** 该指标下这条成绩的原始值：time 是毫秒，bvs 是 3bv/s，stnb 是 stnb。 */
  value: number
}

export interface Top5Group {
  level: Level
  stat: TopStat
  nf: boolean
  rows: Top5Row[]
}
