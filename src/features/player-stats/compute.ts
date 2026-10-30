import {
  APPROVED_STATE,
  LEVELS,
  MIN_BV,
  STANDARD_MODE,
  STNB_COEFFICIENT,
  TOP_STATS,
  isLevel,
} from './model'
import type {
  AnalyzeOptions,
  Level,
  PbRow,
  Top5Group,
  Top5Row,
  TopStat,
  Video,
  VideoDetail,
  VideoMeta,
} from './model'

function seconds(video: { timems: number }): number {
  return video.timems / 1000
}

/** 3bv/s：3BV ÷ 用时（秒）。 */
export function bvsOf(video: { bv: number | null; timems: number }): number {
  if (video.bv === null || video.timems <= 0) return 0
  return video.bv / seconds(video)
}

/** iqg：3BV ÷ 用时^1.7，站点前端成绩的 `s` 值就是它。 */
export function iqgOf(video: { bv: number | null; timems: number }): number {
  if (video.bv === null || video.timems <= 0) return 0
  return video.bv / seconds(video) ** 1.7
}

/** stnb：等级系数 × iqg；等级未知时返回 0。 */
export function stnbOf(video: { bv: number | null; timems: number; level: string }): number {
  if (!isLevel(video.level)) return 0
  return STNB_COEFFICIENT[video.level] * iqgOf(video)
}

function metricValue(video: Video, stat: TopStat): number {
  if (stat === 'time') return video.timems
  if (stat === 'bvs') return bvsOf(video)
  return stnbOf(video)
}

function uploadTime(video: { upload_time: string }): number {
  const parsed = Date.parse(video.upload_time)
  return Number.isNaN(parsed) ? 0 : parsed
}

function levelIndex(level: string): number {
  const index = (LEVELS as readonly string[]).indexOf(level)
  return index < 0 ? LEVELS.length : index
}

/** PB 的先后：用时短的优先，同用时按上传时间、ID 升序。 */
function faster(a: Video, b: Video): boolean {
  if (a.timems !== b.timems) return a.timems < b.timems
  const at = uploadTime(a)
  const bt = uploadTime(b)
  if (at !== bt) return at < bt
  return a.id < b.id
}

function compareTime(a: Video, b: Video): number {
  return a.timems - b.timems || uploadTime(a) - uploadTime(b) || a.id - b.id
}

function compareMetric(stat: TopStat): (a: Video, b: Video) => number {
  return (a, b) => {
    const diff = metricValue(b, stat) - metricValue(a, stat)
    if (Math.abs(diff) > 1e-9) return diff
    return compareTime(a, b)
  }
}

/**
 * 把列表和明细按 id 合并。
 * 明细拿不到的 id 单独返回，调用方可以提示「N 条解析字段缺失」。
 */
export function joinVideos(
  metas: VideoMeta[],
  details: Map<number, VideoDetail>,
): { videos: Video[]; missing: number[] } {
  const videos: Video[] = []
  const missing: number[] = []
  for (const meta of metas) {
    const detail = details.get(meta.id)
    if (!detail) {
      missing.push(meta.id)
      continue
    }
    videos.push({
      ...meta,
      ...detail,
      ongoing_tournament: meta.ongoing_tournament === true,
      duplicate: false,
      duplicateOf: null,
      suspectDuplicate: false,
    })
  }
  return { videos, missing }
}

/**
 * 判重键：成绩 + 点击结构。同一局被多次导出时这些值完全一致。
 * `endTime` 为真时带上结束时间，作为「确定重复」；否则是「疑似重复」。
 */
function fingerprint(video: Video, endTime: boolean): string {
  const parts = [
    video.level,
    video.mode,
    video.bv,
    video.timems,
    video.left,
    video.right,
    video.double,
    video.left_ce,
    video.right_ce,
    video.double_ce,
  ]
  if (endTime) parts.push(video.end_time ?? '')
  return parts.join('|')
}

/** 就地给重复/疑似重复打标；保留上传最早的一条。返回确定重复的条数。 */
export function markDuplicates(videos: Video[]): number {
  const ordered = [...videos].sort(
    (a, b) => uploadTime(a) - uploadTime(b) || a.id - b.id,
  )
  const strongSeen = new Map<string, number>()
  const weakSeen = new Map<string, number>()
  let duplicates = 0

  for (const video of ordered) {
    const weak = fingerprint(video, false)
    const strong = video.end_time === null ? null : fingerprint(video, true)

    if (strong !== null) {
      const first = strongSeen.get(strong)
      if (first !== undefined) {
        video.duplicate = true
        video.duplicateOf = first
        duplicates += 1
        continue
      }
      strongSeen.set(strong, video.id)
    }

    const firstWeak = weakSeen.get(weak)
    if (firstWeak !== undefined) {
      video.suspectDuplicate = true
      video.duplicateOf = firstWeak
    } else {
      weakSeen.set(weak, video.id)
    }
  }

  return duplicates
}

/** 是否计入统计。PB 和前端成绩共用，差别只在 3BV 下限。 */
export function eligible(video: Video, options: AnalyzeOptions = {}): boolean {
  if (!isLevel(video.level)) return false
  if (video.mode !== STANDARD_MODE) return false
  if (video.bv === null || video.timems <= 0) return false
  if (!options.includeUnapproved && video.state !== APPROVED_STATE) return false
  if (video.ongoing_tournament) return false
  if (options.nfOnly === true && video.right_ce !== 0) return false
  if (
    options.software !== undefined &&
    options.software !== 'all' &&
    video.software !== options.software
  ) {
    return false
  }
  if (options.hideDuplicates === true && (video.duplicate || video.suspectDuplicate)) {
    return false
  }
  return true
}

/** 每个 3BV 的最好成绩。 */
export function computePb(videos: Video[], options: AnalyzeOptions = {}): PbRow[] {
  const best = new Map<string, Video>()
  for (const video of videos) {
    if (!eligible(video, options)) continue
    const key = `${video.level}:${video.bv}`
    const current = best.get(key)
    if (!current || faster(video, current)) best.set(key, video)
  }

  return [...best.values()]
    .sort((a, b) => levelIndex(a.level) - levelIndex(b.level) || (a.bv as number) - (b.bv as number))
    .map((video) => ({ level: video.level as Level, bv: video.bv as number, video }))
}

/**
 * 前端成绩：等级 × 指标 × 普通/NF 的前五。
 * 注意这里刻意不接受 `software` 筛选——软件筛选只作用于 PB 表。
 */
export function computeTop5(videos: Video[], options: AnalyzeOptions = {}): Top5Group[] {
  const groups: Top5Group[] = []
  const base = {
    includeUnapproved: options.includeUnapproved,
    hideDuplicates: options.hideDuplicates,
  }

  for (const nf of [false, true]) {
    for (const level of LEVELS) {
      const candidates = videos.filter(
        (video) =>
          eligible(video, { ...base, nfOnly: nf }) &&
          video.level === level &&
          (video.bv as number) >= MIN_BV[level],
      )
      for (const stat of TOP_STATS) {
        // time 是越小越好，bvs / stnb 是越大越好，所以两者用不同的比较器。
        const compare = stat === 'time' ? compareTime : compareMetric(stat)
        const rows: Top5Row[] = [...candidates]
          .sort(compare)
          .slice(0, 5)
          .map((video, index) => ({ rank: index + 1, video, value: metricValue(video, stat) }))
        groups.push({ level, stat, nf, rows })
      }
    }
  }

  return groups
}
