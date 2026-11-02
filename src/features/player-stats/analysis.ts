import { bvsOf, eligible, stnbOf } from './compute'
import { BV_RATE } from './gc-coefficients'
import type { AnalyzeOptions, Level, Video } from './model'
import { LEVELS, isLevel, compareVideoOrder } from './model'

/** 工作簿里绝大多数榜单要求 3BV > 9。 */
const MIN_ANALYSIS_BV = 10

const EPSILON = 1e-9

export interface AnalysisGame {
  video: Video
  level: Level
  bv: number
  /** 秒。 */
  time: number
  bvs: number
  stnb: number
  /** 点击总数、有效点击、右键数。 */
  cl: number
  ce: number
  right: number
  /** 路径长度，1/16 格；缺失时为 0。 */
  path: number
  op: number
  isl: number
  /** 明细是否包含对应字段；缺失时相关榜单和平均不参与。 */
  hasPath: boolean
  hasOp: boolean
  hasIsl: boolean
  hasCl: boolean
  hasCe: boolean
  hasRight: boolean
  /** 结束时间（毫秒），缺失时退回上传时间。 */
  date: number
  nf: boolean
  /** 是否是「当时」的个人最好成绩，以及被打破的旧纪录。 */
  pb: boolean
  pbPrev: number | null
}

interface AnalysisFilter {
  software?: string
  nfOnly?: boolean
}

export interface LevelSummary {
  level: Level
  count: number
  pb: AnalysisGame | null
  top5Bvs: number
  nfRatio: number
  last30: number
}

export interface TodayStat {
  level: Level
  count: number
  fl: number
  nf: number
  bestTime: AnalysisGame | null
  bestBvs: AnalysisGame | null
  bestStnb: AnalysisGame | null
  avgTime: number
  avgBv: number
  avgBvs: number
  avgStnb: number
}

const LEVEL_EN: Record<Level, string> = {
  b: 'beg',
  i: 'int',
  e: 'exp',
}

/** 今日数据复制文本；纯函数，表格和剪贴板共用同一套格式。 */
export function todayCopyText(row: TodayStat): string {
  const avgBv = row.avgBv.toFixed(1)
  const best =
    row.bestTime && row.bestBvs && row.bestStnb
      ? `T ${row.bestTime.time.toFixed(3)}/${row.bestTime.bv} | B ${row.bestBvs.bvs.toFixed(3)}/${row.bestBvs.bv} | S ${row.bestStnb.stnb.toFixed(1)}/${row.bestStnb.bv}`
      : 'T — | B — | S —'
  const avg =
    row.count > 0
      ? `T ${row.avgTime.toFixed(3)} | B ${row.avgBvs.toFixed(3)} | S ${row.avgStnb.toFixed(1)} | 3BV ${avgBv}`
      : 'T — | B — | S — | 3BV —'
  return [
    `/me has finished ${row.count} ${LEVEL_EN[row.level]} games today`,
    `Games ${row.count} = ${row.fl} FL + ${row.nf} NF`,
    `Best ${best}`,
    `Avg  ${avg}`,
  ].join('\n')
}

export interface RecentPb {
  game: AnalysisGame
  prev: number
}

interface WeekLevelDetail {
  slot: number
  slots: Array<{ time: number; bvs: number; stnb: number }>
  totals: { time: number; bvs: number; stnb: number }
  averages: { time: number; bvs: number; stnb: number }
  ppp: number
}

interface WeekStat {
  start: number
  count: number
  t37: number
  b37: number
  s37: number
  ppp: number
  levels: Record<Level, WeekLevelDetail>
}

interface MonthStat {
  key: string
  days: number
  count: number
  hasScores: boolean
  avgTime: number
  medianTime: number
  avgBv: number
  avgBvs: number
  avgStnb: number
  hasCl: boolean
  hasCe: boolean
  hasOp: boolean
  hasIs: boolean
  hasPath: boolean
  gamesPerDay: number
  avgOp: number
  avgIs: number
  avgCls: number
  avgCes: number
  avgCorr: number
  avgThrp: number
  avgPath: number
  avgMov: number
  breakRate: number
  headScore: number
  pbCount: number
  timeTierShare: number[]
  bvsTierShare: number[]
}

function sumNumbers(values: Array<number | null>): number {
  let total = 0
  for (const value of values) if (value !== null) total += value
  return total
}

function videoDate(video: Video): number {
  const end = Date.parse(video.end_time ?? '')
  if (!Number.isNaN(end)) return end
  const upload = Date.parse(video.upload_time ?? '')
  return Number.isNaN(upload) ? 0 : upload
}

export function buildGames(
  videos: Video[],
  options: AnalyzeOptions = {},
  minBv = MIN_ANALYSIS_BV,
): AnalysisGame[] {
  const games: AnalysisGame[] = []
  for (const video of videos) {
    if (!eligible(video, { ...options, nfOnly: false })) continue
    if (!isLevel(video.level)) continue
    const bv = video.bv
    if (bv === null || bv < minBv) continue

    const time = video.timems / 1000
    const right = video.right ?? 0
    const path = video.path ?? 0
    const game: AnalysisGame = {
      video,
      level: video.level,
      bv,
      time,
      bvs: bvsOf(video),
      stnb: stnbOf(video),
      cl: sumNumbers([video.left, video.right, video.double]),
      ce: sumNumbers([video.left_ce, video.right_ce, video.double_ce]),
      right,
      path,
      op: video.op ?? 0,
      isl: video.isl ?? 0,
      hasPath: typeof video.path === 'number' && Number.isFinite(video.path),
      hasOp: typeof video.op === 'number' && Number.isFinite(video.op),
      hasIsl: typeof video.isl === 'number' && Number.isFinite(video.isl),
      hasCl: [video.left, video.right, video.double].every(
        (value) => typeof value === 'number' && Number.isFinite(value),
      ),
      hasCe: [video.left_ce, video.right_ce, video.double_ce].every(
        (value) => typeof value === 'number' && Number.isFinite(value),
      ),
      hasRight: typeof video.right === 'number' && Number.isFinite(video.right),
      date: videoDate(video),
      nf: video.csvNf ?? (video.right === 0),
      pb: false,
      pbPrev: null,
    }
    games.push(game)
  }

  games.sort((a, b) => a.date - b.date || compareVideoOrder(a.video, b.video))
  return games
}

function filterGames(games: AnalysisGame[], filter: AnalysisFilter): AnalysisGame[] {
  return games.filter((game) => {
    if (filter.software !== undefined && filter.software !== 'all' && game.video.software !== filter.software) {
      return false
    }
    if (filter.nfOnly === true && !game.nf) return false
    return true
  })
}

/** 按各级 3BV 下限过滤；GC、今日成绩等统计由调用方使用未套用下限的数据。 */
export function applyBvFloors(
  games: AnalysisGame[],
  floors: Record<Level, number>,
): AnalysisGame[] {
  return games.filter((game) => game.bv >= floors[game.level])
}

/** 按时间顺序标记「当时的最好成绩」。输入需要按日期升序。 */
export function markPb(games: AnalysisGame[]): void {
  const best = new Map<string, number>()
  for (const game of games) {
    const key = `${game.level}:${game.bv}`
    const prev = best.get(key)
    game.pbPrev = prev ?? null
    game.pb = prev === undefined || game.time < prev - EPSILON
    if (game.pb) best.set(key, game.time)
  }
}

export function analyzeGames(
  videos: Video[],
  filter: AnalysisFilter = {},
  minBv = MIN_ANALYSIS_BV,
): AnalysisGame[] {
  const games = filterGames(buildGames(videos, {}, minBv), filter)
  markPb(games)
  return games
}

export function summarize(games: AnalysisGame[], now: number, days = 30): LevelSummary[] {
  return LEVELS.map((level) => {
    const rows = games.filter((game) => game.level === level)
    const pb = rows.reduce<AnalysisGame | null>(
      (best, game) => (best === null || game.time < best.time ? game : best),
      null,
    )
    const top5 = [...rows].sort((a, b) => b.bvs - a.bvs).slice(0, 5)
    return {
      level,
      count: rows.length,
      pb,
      top5Bvs: top5.length === 0 ? 0 : top5.reduce((sum, game) => sum + game.bvs, 0) / top5.length,
      nfRatio: rows.length === 0 ? 0 : rows.filter((game) => game.nf).length / rows.length,
      last30: rows.filter((game) => game.date >= addLocalDays(now, -days)).length,
    }
  })
}

export function todayStats(games: AnalysisGame[], now: number): TodayStat[] {
  const start = startOfLocalDay(now)
  const end = addLocalDays(start, 1)
  return LEVELS.map((level) => {
    const rows = games.filter(
      (game) => game.level === level && game.date >= start && game.date < end,
    )
    const bestTime = rows.reduce<AnalysisGame | null>(
      (best, game) => (best === null || game.time < best.time ? game : best),
      null,
    )
    const bestBvs = rows.reduce<AnalysisGame | null>(
      (best, game) => (best === null || game.bvs > best.bvs ? game : best),
      null,
    )
    const bestStnb = rows.reduce<AnalysisGame | null>(
      (best, game) => (best === null || game.stnb > best.stnb ? game : best),
      null,
    )
    return {
      level,
      count: rows.length,
      nf: rows.filter((game) => game.nf).length,
      fl: rows.filter((game) => !game.nf).length,
      bestTime,
      bestBvs,
      bestStnb,
      avgTime: average(rows.map((game) => game.time)),
      avgBv: average(rows.map((game) => game.bv)),
      avgBvs: average(rows.map((game) => game.bvs)),
      avgStnb: average(rows.map((game) => game.stnb)),
    }
  })
}

export function recentPb(games: AnalysisGame[], now: number, days = 30, limit = 8): RecentPb[] {
  return games
    .filter(
      (game) =>
        game.pb &&
        game.pbPrev !== null &&
        game.date >= addLocalDays(now, -days) &&
        game.date <= now,
    )
    .sort((a, b) => b.date - a.date)
    .slice(0, limit)
    .map((game) => ({ game, prev: game.pbPrev as number }))
}

export function activeDays(games: AnalysisGame[], now: number, days = 30): number {
  const end = new Date(now)
  end.setHours(23, 59, 59, 999)
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - (days - 1))
  const from = start.getTime()
  const to = end.getTime()

  const seen = new Set<string>()
  for (const game of games) {
    if (game.date < from || game.date > to) continue
    const date = new Date(game.date)
    seen.add(`${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`)
  }
  return seen.size
}

function mondayOf(timestamp: number): number {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  const offset = (date.getDay() + 6) % 7
  date.setDate(date.getDate() - offset)
  return date.getTime()
}

/** 按本地日历加减天数，跨 DST 不会偏移小时。 */
function addLocalDays(timestamp: number, days: number): number {
  const date = new Date(timestamp)
  date.setDate(date.getDate() + days)
  return date.getTime()
}

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** 工作簿 week 页的槽位：初级取 20 条、中级 12 条、高级 5 条。 */
const WEEK_SLOTS: Record<Level, number> = { b: 20, i: 12, e: 5 }
/** 不足槽位时按原表补齐：用时 10 / 30 / 99 秒。 */
const WEEK_TIME_PAD: Record<Level, number> = { b: 10, i: 30, e: 99 }
/** ppp 的归一化常数，来自 Set!AL31:AL33。 */
const WEEK_PPP_CONST: Record<Level, number> = {
  b: 69.69099147046637,
  i: 5.783604002526971,
  e: 1,
}

export function weekStats(
  games: AnalysisGame[],
  weeks = 10,
  now = Date.now(),
  pad = true,
  slots: Record<Level, number> = WEEK_SLOTS,
  pads: Record<Level, number> = WEEK_TIME_PAD,
  pppConsts: Record<Level, number> = WEEK_PPP_CONST,
): WeekStat[] {
  const lastStart = mondayOf(now)
  const starts: number[] = []
  for (let index = weeks - 1; index >= 0; index -= 1) {
    starts.push(addLocalDays(lastStart, -index * 7))
  }

  return starts.map((start) => {
    const end = addLocalDays(start, 7)
    const rows = games.filter((game) => game.date >= start && game.date < end)
    const tParts: Record<Level, number> = { b: 0, i: 0, e: 0 }
    const bParts: Record<Level, number> = { b: 0, i: 0, e: 0 }
    const sParts: Record<Level, number> = { b: 0, i: 0, e: 0 }
    const levels = {} as Record<Level, WeekLevelDetail>

    for (const level of LEVELS) {
      const slot = slots[level]
      const levelRows = rows.filter((game) => game.level === level)
      const fastest = levelRows
        .map((game) => game.time)
        .sort((a, b) => a - b)
        .slice(0, slot)
      const quickest = levelRows
        .map((game) => game.bvs)
        .sort((a, b) => b - a)
        .slice(0, slot)
      const best = levelRows
        .map((game) => game.stnb)
        .sort((a, b) => b - a)
        .slice(0, slot)
      const missing = Math.max(0, slot - fastest.length)
      const timeSlots = [...fastest, ...Array<number>(missing).fill(pads[level])]
      const bvsSlots = [...quickest, ...Array<number>(Math.max(0, slot - quickest.length)).fill(0)]
      const stnbSlots = [...best, ...Array<number>(Math.max(0, slot - best.length)).fill(0)]
      const totalTime =
        fastest.reduce((sum, value) => sum + value, 0) + (pad ? missing * pads[level] : 0)
      const totalBvs = quickest.reduce((sum, value) => sum + value, 0)
      const totalStnb = best.reduce((sum, value) => sum + value, 0)
      const levelPpp =
        totalTime > 0
          ? (totalStnb * totalBvs) / totalTime / pppConsts[level] / slot
          : 0

      tParts[level] = totalTime
      bParts[level] = totalBvs
      sParts[level] = totalStnb
      levels[level] = {
        slot,
        slots: timeSlots.map((time, index) => ({
          time,
          bvs: bvsSlots[index] ?? 0,
          stnb: stnbSlots[index] ?? 0,
        })),
        totals: { time: totalTime, bvs: totalBvs, stnb: totalStnb },
        averages: {
          time: totalTime / slot,
          bvs: totalBvs / slot,
          stnb: totalStnb / slot,
        },
        ppp: levelPpp,
      }
    }

    let ppp = 0
    if (tParts.b > 0 && tParts.i > 0 && tParts.e > 0) {
      ppp = Math.cbrt(levels.b.ppp * levels.i.ppp * levels.e.ppp)
    }

    return {
      start,
      count: rows.length,
      t37: tParts.b + tParts.i + tParts.e,
      b37: bParts.b + bParts.i + bParts.e,
      s37: sParts.b + sParts.i + sParts.e,
      ppp,
      levels,
    }
  })
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle] as number
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
}

/** 月表分档：原表 Beg/Int/Exp 的 Y:AG 与 AH:AP 表头。 */
export const MONTH_TIME_TIERS: Record<Level, number[]> = {
  b: [2.7, 2.6, 2.5, 2.4, 2.3, 2.2, 2.1, 2, 1.9],
  i: [15, 14.5, 14, 13.5, 13, 12.5, 12, 11.5, 11],
  e: [50, 49, 48, 47, 46, 45, 44, 43, 42],
}
export const MONTH_BVS_TIERS: Record<Level, number[]> = {
  b: [5.6, 5.8, 6, 6.2, 6.4, 6.6, 6.8, 7, 7.2],
  i: [4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 5, 5.1],
  e: [3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 4],
}

export function monthStats(
  games: AnalysisGame[],
  level: Level,
  allGames: AnalysisGame[] = games,
): MonthStat[] {
  const rows = games.filter((game) => game.level === level && game.date > 0)
  const allRows = allGames.filter((game) => game.level === level && game.date > 0)
  if (allRows.length === 0) return []
  const counts = new Map<string, number>()
  const activeDays = new Map<string, Set<string>>()
  for (const game of allGames) {
    if (game.level !== level || game.date <= 0) continue
    const date = new Date(game.date)
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
    const dayKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
    const days = activeDays.get(key)
    if (days) days.add(dayKey)
    else activeDays.set(key, new Set([dayKey]))
  }

  const makeRank = (pick: (game: AnalysisGame) => number, ascending: boolean): Map<number, number> => {
    const sorted = [...rows].sort((a, b) => (ascending ? pick(a) - pick(b) : pick(b) - pick(a)))
    const ranks = new Map<number, number>()
    sorted.forEach((game, index) => ranks.set(game.video.id, index + 1))
    return ranks
  }
  const ranks = [
    makeRank((game) => game.time, true),
    makeRank((game) => game.bvs, false),
    makeRank((game) => game.stnb, false),
  ]

  const groups = new Map<string, AnalysisGame[]>()
  let earliest = allRows[0]!.date
  let latest = allRows[0]!.date
  for (const game of allRows) {
    if (game.date < earliest) earliest = game.date
    if (game.date > latest) latest = game.date
  }
  for (const game of rows) {
    const date = new Date(game.date)
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
    const bucket = groups.get(key)
    if (bucket) bucket.push(game)
    else groups.set(key, [game])
  }

  // 从最早录像所在月，一直补到最晚录像所在月，再倒序（最新在上）。
  const startDate = new Date(earliest)
  const endDate = new Date(latest)
  const startYear = startDate.getFullYear()
  const startMonth = startDate.getMonth()
  const total =
    (endDate.getFullYear() - startYear) * 12 + (endDate.getMonth() - startMonth) + 1

  const keys: string[] = []
  for (let index = 0; index < total; index += 1) {
    const monthIndex = startMonth + index
    const year = startYear + Math.floor(monthIndex / 12)
    const month = monthIndex % 12
    keys.push(`${year}-${String(month + 1).padStart(2, '0')}`)
  }
  keys.reverse()

  return keys.map((key) => {
    const monthRows = groups.get(key) ?? []
    const totalCount = counts.get(key) ?? 0
    const days = activeDays.get(key)?.size ?? 0
    if (totalCount === 0) {
      return {
        key,
        days,
        count: 0,
        hasScores: false,
      hasCl: false,
      hasCe: false,
      hasOp: false,
      hasIs: false,
      hasPath: false,
        avgTime: 0,
        medianTime: 0,
        avgBv: 0,
        avgBvs: 0,
        avgStnb: 0,
        gamesPerDay: 0,
        avgOp: 0,
        avgIs: 0,
        avgCls: 0,
        avgCes: 0,
        avgCorr: 0,
        avgThrp: 0,
        avgPath: 0,
        avgMov: 0,
        breakRate: 0,
        headScore: 0,
        pbCount: 0,
        timeTierShare: MONTH_TIME_TIERS[level].map(() => 0),
        bvsTierShare: MONTH_BVS_TIERS[level].map(() => 0),
      }
    }
    let top5 = 0
    let mid = 0
    let low = 0
    for (const game of monthRows) {
      for (const rank of ranks) {
        const value = rank.get(game.video.id) ?? 0
        if (value <= 5) top5 += 1
        else if (value <= 25) mid += 1
        else if (value <= 50) low += 1
      }
    }
    const topHits = top5 + mid + low

    return {
      key,
      days,
      count: totalCount,
      hasScores: monthRows.length > 0,
      hasCl: monthRows.some((game) => game.hasCl),
      hasCe: monthRows.some((game) => game.hasCe),
      hasOp: monthRows.some((game) => game.hasOp),
      hasIs: monthRows.some((game) => game.hasIsl),
      hasPath: monthRows.some((game) => game.hasPath),
      avgTime: average(monthRows.map((game) => game.time)),
      medianTime: median(monthRows.map((game) => game.time)),
      avgBv: average(monthRows.map((game) => game.bv)),
      avgBvs: average(monthRows.map((game) => game.bvs)),
      avgStnb: average(monthRows.map((game) => game.stnb)),
      gamesPerDay:
        days === 0 ? 0 : totalCount / days,
      avgOp: average(monthRows.filter((game) => game.hasOp).map((game) => game.op)),
      avgIs: average(monthRows.filter((game) => game.hasIsl).map((game) => game.isl)),
      avgCls: average(monthRows.filter((game) => game.hasCl).map((game) => game.cl / game.time)),
      avgCes: average(monthRows.filter((game) => game.hasCe).map((game) => game.ce / game.time)),
      avgCorr: average(
        monthRows
          .filter((game) => game.hasCl && game.hasCe)
          .map((game) => (game.cl > 0 ? game.ce / game.cl : 0)),
      ),
      avgThrp: average(
        monthRows
          .filter((game) => game.hasCe)
          .map((game) => (game.ce > 0 ? game.bv / game.ce : 0)),
      ),
      avgPath: average(monthRows.filter((game) => game.hasPath).map((game) => game.path / 16)),
      avgMov: average(
        monthRows
          .filter((game) => game.hasPath && game.time > 0)
          .map((game) => game.path / 16 / game.time),
      ),
      breakRate: topHits === 0 ? 0 : Math.floor((50 * monthRows.length) / topHits),
      headScore: monthRows.filter((game) => game.pb).length * 5 + top5 * 15 + mid * 7 + low * 2,
      pbCount: monthRows.filter((game) => game.pb).length,
      timeTierShare:
        monthRows.length === 0
          ? MONTH_TIME_TIERS[level].map(() => 0)
          : MONTH_TIME_TIERS[level].map(
              (limit) => monthRows.filter((game) => game.time < limit).length / monthRows.length,
            ),
      bvsTierShare:
        monthRows.length === 0
          ? MONTH_BVS_TIERS[level].map(() => 0)
          : MONTH_BVS_TIERS[level].map(
              (limit) => monthRows.filter((game) => game.bvs >= limit).length / monthRows.length,
            ),
    }
  })
}

export function rankGames(
  games: AnalysisGame[],
  stat: 'time' | 'bvs' | 'stnb',
  level?: Level,
): AnalysisGame[] {
  const rows = level === undefined ? games : games.filter((game) => game.level === level)
  const sorted = [...rows]
  sorted.sort((a, b) => {
    if (stat === 'time') return a.time - b.time || a.date - b.date || compareVideoOrder(a.video, b.video)
    const diff = b[stat] - a[stat]
    return Math.abs(diff) > EPSILON ? diff : a.time - b.time
  })
  return sorted
}

interface BvBucket {
  start: number
  end: number
  count: number
  share: number
  avgTime: number
  avgBvs: number
  avgStnb: number
  best: AnalysisGame
}

/** 3BV 分档：初级 5 一格、中级 20、高级 50。 */
export function bucketStats(games: AnalysisGame[], level: Level): BvBucket[] {
  const rows = games.filter((game) => game.level === level)
  if (rows.length === 0) return []
  const step = level === 'b' ? 5 : level === 'i' ? 20 : 50
  const groups = new Map<number, AnalysisGame[]>()
  for (const game of rows) {
    const start = Math.floor(game.bv / step) * step
    const bucket = groups.get(start)
    if (bucket) bucket.push(game)
    else groups.set(start, [game])
  }

  return [...groups.keys()]
    .sort((a, b) => a - b)
    .map((start) => {
      const bucket = groups.get(start) as AnalysisGame[]
      const best = bucket.reduce((fastest, game) =>
        game.time < fastest.time ? game : fastest,
      )
      return {
        start,
        end: start + step - 1,
        count: bucket.length,
        share: bucket.length / rows.length,
        avgTime: average(bucket.map((game) => game.time)),
        avgBvs: average(bucket.map((game) => game.bvs)),
        avgStnb: average(bucket.map((game) => game.stnb)),
        best,
      }
    })
}

interface SubTier {
  limit: number
  count: number
  share: number
  every: number
  label: string
}

function rarityLabel(every: number): string {
  if (every >= 512) return '狗运'
  if (every >= 256) return '发财'
  if (every >= 128) return '突然'
  if (every >= 64) return '惊喜'
  if (every >= 32) return '量产'
  if (every >= 16) return '强局'
  return '基操'
}

/** Sub 率阶梯：用时小于档位的累计局数，默认 14 档。 */
export function subStats(games: AnalysisGame[], level: Level, tiers = 14): SubTier[] {
  const rows = games.filter((game) => game.level === level)
  const total = rows.length
  const base = level === 'b' ? 4.5 : level === 'i' ? 13 : 55
  const step = level === 'b' ? 0.25 : level === 'i' ? 0.75 : 3

  const result: SubTier[] = []
  for (let index = 0; index < tiers; index += 1) {
    const limit = base - index * step
    const count = rows.filter((game) => game.time < limit).length
    const share = total === 0 ? 0 : count / total
    const every = share > 0 ? 1 / share : Infinity
    result.push({
      limit,
      count,
      share,
      every,
      label: count === 0 ? '—' : rarityLabel(every),
    })
  }
  return result
}

export type EfficiencyMetric = 'cls' | 'ces' | 'mov' | 'ioe'

interface EfficiencyRow {
  game: AnalysisGame
  value: number
}

/** 点击效率榜：cl/s、ce/s、移速、bv/cl，取前 N。 */
export function efficiencyTop(
  games: AnalysisGame[],
  level: Level,
  metric: EfficiencyMetric,
  limit = 5,
): EfficiencyRow[] {
  const rows = games.filter((game) => {
    if (game.level !== level) return false
    if (metric === 'ioe') return game.hasCl && game.cl > 0
    if (metric === 'mov') return game.hasPath && game.path > 0 && game.time > 0
    if (metric === 'ces') return game.hasCe && game.time > 0
    return game.hasCl && game.time > 0
  })

  const valueOf = (game: AnalysisGame): number => {
    if (metric === 'cls') return game.cl / game.time
    if (metric === 'ces') return game.ce / game.time
    if (metric === 'mov') return game.path / 16 / game.time
    return game.bv / game.cl
  }

  return rows
    .map((game) => ({ game, value: valueOf(game) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit)
}

export type OthMetric = 'invCe' | 'ce' | 'invPath' | 'invIs' | 'invOp' | 'is' | 'op'

export interface OthRow {
  game: AnalysisGame
  value: number
}

/** 杂项榜七项，对应原表 oth 页。 */
export function othTop(
  games: AnalysisGame[],
  level: Level,
  metric: OthMetric,
  limit = 5,
): OthRow[] {
  const rows = games.filter((game) => {
    if (game.level !== level) return false
    if (metric === 'invCe') return game.hasCe && game.ce > 0
    if (metric === 'ce') return game.hasCe
    if (metric === 'invPath') return game.hasPath && game.path > 0
    if (metric === 'invIs' || metric === 'is') return game.hasIsl
    if (metric === 'invOp' || metric === 'op') return game.hasOp
    return true
  })

  const valueOf = (game: AnalysisGame): number => {
    switch (metric) {
      case 'invCe':
        return game.ce
      case 'ce':
        return game.ce
      case 'invPath':
        return game.path
      case 'invIs':
        return game.isl
      case 'invOp':
        return game.op
      case 'is':
        return game.isl
      default:
        return game.op
    }
  }

  const descending = !['invCe', 'invPath', 'invIs', 'invOp'].includes(metric)
  return rows
    .map((game) => ({ game, value: valueOf(game) }))
    .sort((a, b) => (descending ? b.value - a.value : a.value - b.value))
    .slice(0, limit)
}

export interface RangeStat {
  start: number
  end: number
  count: number
  share: number
  theoryShare: number | null
  avgTime: number
  avgBvs: number
  avgStnb: number
}

const RANGE_BOUNDS: Record<Level, Array<[number, number]>> = {
  b: [
    [2, 10],
    [10, 20],
    [20, 30],
    [30, 55],
  ],
  i: [
    [30, 40],
    [40, 50],
    [50, 60],
    [60, 70],
    [70, 80],
    [80, 90],
    [90, 100],
    [100, 161],
  ],
  e: [
    [100, 130],
    [130, 140],
    [140, 150],
    [150, 160],
    [160, 170],
    [170, 180],
    [180, 190],
    [190, 200],
    [200, 210],
    [210, 220],
    [220, 230],
    [230, 240],
    [240, 250],
    [250, 260],
    [260, 270],
    [270, 280],
    [280, 382],
  ],
}

/** 原表 rAvg 的 Theory 列。 */
const RANGE_THEORY: Record<Level, Array<number | null>> = {
  b: [0.06141897955556758, 0.6270466409878247, 0.2887192709227459, 0.022810017468745503],
  i: [
    0.008052092254,
    0.07856671798999999,
    0.248061785445,
    0.331416924006,
    0.223531548786,
    0.08598653859699999,
    0.020569727529000003,
    0.0036432964520000002,
  ],
  e: [
    0.008453358919,
    0.026629438406,
    0.07009706077599999,
    0.133194923621,
    0.18793569771599997,
    0.20163106555899996,
    0.16779560557600004,
    0.11014232450500001,
    0.05783422923999999,
    0.024580025853999998,
    0.011696266019999997,
    null,
    null,
    null,
    null,
    null,
    null,
  ],
}

/** 原表 rAvg：按 3BV 区间汇总局数占比、平均用时与 STNB。 */
export function rangeStats(games: AnalysisGame[], level: Level): RangeStat[] {
  const rows = games.filter((game) => game.level === level)
  const total = rows.length
  return RANGE_BOUNDS[level].map(([start, end], index) => {
    const bucket = rows.filter((game) => game.bv >= start && game.bv < end)
    return {
      start,
      end: end - 1,
      count: bucket.length,
      share: total === 0 ? 0 : bucket.length / total,
      theoryShare: RANGE_THEORY[level][index] ?? null,
      avgTime: average(bucket.map((game) => game.time)),
      avgBvs: average(bucket.map((game) => game.bvs)),
      avgStnb: average(bucket.map((game) => game.stnb)),
    }
  })
}

export interface YearStat {
  year: number
  count: number
  hasScores: boolean
  avgTime: number
  avgBv: number
  avgBvs: number
  avgStnb: number
  avgCls: number
  avgCes: number
  avgMov: number
  hasCl: boolean
  hasCe: boolean
  hasPath: boolean
  pbCount: number
}

/** 年汇总：按年聚合当前难度。 */
export function yearStats(
  games: AnalysisGame[],
  level: Level,
  allGames: AnalysisGame[] = games,
): YearStat[] {
  const rows = games.filter((game) => game.level === level && game.date > 0)
  const groups = new Map<number, AnalysisGame[]>()
  for (const game of rows) {
    const year = new Date(game.date).getFullYear()
    const bucket = groups.get(year)
    if (bucket) bucket.push(game)
    else groups.set(year, [game])
  }
  const counts = new Map<number, number>()
  for (const game of allGames) {
    if (game.level !== level || game.date <= 0) continue
    const year = new Date(game.date).getFullYear()
    counts.set(year, (counts.get(year) ?? 0) + 1)
  }
  const years = [...new Set([...groups.keys(), ...counts.keys()])].sort((a, b) => b - a)
  return years.map((year) => {
    const yearRows = groups.get(year) ?? []
    return {
      year,
      count: counts.get(year) ?? yearRows.length,
      hasScores: yearRows.length > 0,
      hasCl: yearRows.some((game) => game.hasCl),
      hasCe: yearRows.some((game) => game.hasCe),
      hasPath: yearRows.some((game) => game.hasPath),
      avgTime: average(yearRows.map((game) => game.time)),
      avgBv: average(yearRows.map((game) => game.bv)),
      avgBvs: average(yearRows.map((game) => game.bvs)),
      avgStnb: average(yearRows.map((game) => game.stnb)),
      avgCls: average(yearRows.filter((game) => game.hasCl).map((game) => game.cl / game.time)),
      avgCes: average(yearRows.filter((game) => game.hasCe).map((game) => game.ce / game.time)),
      avgMov: average(
        yearRows
          .filter((game) => game.hasPath && game.time > 0)
          .map((game) => game.path / 16 / game.time),
      ),
      pbCount: yearRows.filter((game) => game.pb).length,
    }
  })
}

export interface GcSegmentStat {
  start: number
  end: number
  count: number
  power: number
  bv: number
  time: number
}

export interface GcStat {
  level: Level
  asb: number
  power: number
  typicalTime: number
  segments: GcSegmentStat[]
}

const GC_SEGMENTS: Record<Level, Array<[number, number]>> = {
  b: [
    [2, 9],
    [10, 19],
    [20, 29],
    [30, 54],
  ],
  i: [
    [30, 39],
    [40, 49],
    [50, 59],
    [60, 69],
    [70, 79],
    [80, 89],
    [90, 99],
    [100, 216],
  ],
  e: [
    [100, 129],
    ...Array.from({ length: 9 }, (_, index) => [130 + index * 10, 139 + index * 10] as [number, number]),
    [220, 381],
  ],
}

/** 原表 GC 的 ASB / 战力 / 典型时（按 3BV 分段汇总）。 */
export function gcStats(games: AnalysisGame[]): GcStat[] {
  return LEVELS.map((level) => {
    const ranges = GC_SEGMENTS[level]
    const segmentOf = (bv: number): number =>
      ranges.findIndex(([start, end]) => bv >= start && bv <= end)
    const counts = ranges.map(() => 0)
    const pbBvs = new Map<number, number>()
    for (const game of games) {
      if (game.level !== level) continue
      const index = segmentOf(game.bv)
      if (index < 0) continue
      counts[index] += 1
      pbBvs.set(game.bv, Math.max(pbBvs.get(game.bv) ?? 0, game.bvs))
    }

    let asb = 0
    let powerSum = 0
    let typicalTime = 0
    const rateOf = (bv: number): number => {
      const maxBv = level === 'b' ? 54 : level === 'i' ? 134 : 278
      if (bv > maxBv) return 0
      const coefficientIndex = bv + (level === 'b' ? 0 : level === 'i' ? 36 : 82)
      return BV_RATE[coefficientIndex - 1] ?? 0
    }

    const segments: GcSegmentStat[] = ranges.map(([start, end], index) => {
      let rateSum = 0
      let powerNum = 0
      let bvNum = 0
      let segmentAsb = 0
      for (let bv = start; bv <= end; bv += 1) {
        const pb = pbBvs.get(bv) ?? 0
        const rate = rateOf(bv)
        rateSum += rate
        powerNum += pb * rate
        bvNum += bv * rate
        segmentAsb += pb
      }
      asb += level === 'b' && start === 2 ? 0 : segmentAsb
      powerSum += powerNum
      const power = rateSum > 0 ? powerNum / rateSum : 0
      const bv = rateSum > 0 ? bvNum / rateSum : 0
      const time = power > 0 ? bv / power : 0
      typicalTime += time
      return {
        start,
        end,
        count: counts[index],
        power,
        bv,
        time,
      }
    })

    return {
      level,
      asb,
      power: powerSum / 100,
      typicalTime,
      segments,
    }
  })
}

export type PeriodMode = 'month' | 'year'

export interface PeriodGroup {
  key: string
  start: number
  /** 该期全部局数，包含 3BV < 10 的局。 */
  count: number
  /** 达到各级 3BV 下限、参与 Top 排名的局。 */
  rows: AnalysisGame[]
}

/** 月 / 年 Top 的分组，按时间倒序；count 统计全部局，rows 只保留可排名的局。 */
export function periodGroups(
  games: AnalysisGame[],
  level: Level,
  mode: PeriodMode,
  allGames: AnalysisGame[] = games,
): PeriodGroup[] {
  const groups = new Map<string, PeriodGroup>()
  const periodOf = (game: AnalysisGame): { key: string; start: number } | null => {
    if (game.level !== level || game.date <= 0) return null
    const date = new Date(game.date)
    return {
      key:
        mode === 'month'
          ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
          : String(date.getFullYear()),
      start:
        mode === 'month'
          ? new Date(date.getFullYear(), date.getMonth(), 1).getTime()
          : new Date(date.getFullYear(), 0, 1).getTime(),
    }
  }

  for (const game of allGames) {
    const period = periodOf(game)
    if (!period) continue
    const group = groups.get(period.key)
    if (group) group.count += 1
    else groups.set(period.key, { key: period.key, start: period.start, count: 1, rows: [] })
  }
  for (const game of games) {
    const period = periodOf(game)
    if (!period) continue
    groups.get(period.key)?.rows.push(game)
  }

  return [...groups.values()].sort((a, b) => b.start - a.start)
}

const MAP_BOUNDS: Record<Level, { time: number; bvs: number }> = {
  b: { time: 12, bvs: 12 },
  i: { time: 40, bvs: 7 },
  e: { time: 90, bvs: 5 },
}

export interface Heatmap {
  cols: number
  rows: number
  maxTime: number
  maxBvs: number
  maxCount: number
  cells: number[][]
}

/** 时间 × 3BVS 热力网格，供地图页使用。 */
export function heatmapStats(games: AnalysisGame[], level: Level): Heatmap {
  const cols = 30
  const rows = 20
  const bounds = MAP_BOUNDS[level]
  const cells = Array.from({ length: rows }, () => Array<number>(cols).fill(0))
  let maxCount = 0

  for (const game of games) {
    if (game.level !== level) continue
    const x = Math.floor((game.time / bounds.time) * cols)
    const y = Math.floor((game.bvs / bounds.bvs) * rows)
    if (x < 0 || x >= cols || y < 0 || y >= rows) continue
    cells[rows - 1 - y]![x] += 1
    maxCount = Math.max(maxCount, cells[rows - 1 - y]![x] as number)
  }

  return { cols, rows, maxTime: bounds.time, maxBvs: bounds.bvs, maxCount, cells }
}

export interface CalendarCell {
  start: number
  count: number
}

/** 最近 N 天（按周对齐）的每日局数，用于活跃日历。 */
export function activityCalendar(
  games: AnalysisGame[],
  now = Date.now(),
  days = 84,
): {
  start: number
  cells: CalendarCell[]
  max: number
  total: number
  activeDays: number
  longestStreak: number
  best: CalendarCell | null
} {
  const end = addLocalDays(mondayOf(now), 7)
  const start = addLocalDays(end, -days)
  const counts = new Map<number, number>()
  for (const game of games) {
    if (game.date < start || game.date >= end) continue
    const date = new Date(game.date)
    const key = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const cells: CalendarCell[] = []
  let max = 0
  let total = 0
  let activeDays = 0
  let longestStreak = 0
  let streak = 0
  let best: CalendarCell | null = null
  for (let index = 0; index < days; index += 1) {
    const key = addLocalDays(start, index)
    const count = counts.get(key) ?? 0
    const cell = { start: key, count }
    cells.push(cell)
    if (count > max) max = count
    total += count
    if (count > 0) {
      activeDays += 1
      streak += 1
      if (streak > longestStreak) longestStreak = streak
      if (!best || count > best.count) best = cell
    } else {
      streak = 0
    }
  }
  return { start, cells, max, total, activeDays, longestStreak, best }
}

export interface DogCell {
  target: number
  count: number
  probability: number
}

export interface DogYear {
  year: number
  total: number
  baseTime: number
  cells: DogCell[]
}

/** 原表狗预测：按年度累计局数首次 > 20 的时间点作基准，再按 1.55 / 2.3 / 3.8 衰减出达标概率。 */
export function dogPredictions(
  games: AnalysisGame[],
  targets: number[],
  level: Level = 'e',
): DogYear[] {
  const unique = [...new Set(targets.filter((target) => target > 0))].sort((a, b) => b - a)
  const byYear = new Map<number, AnalysisGame[]>()
  for (const game of games) {
    if (game.level !== level || game.date <= 0) continue
    const year = new Date(game.date).getFullYear()
    const bucket = byYear.get(year)
    if (bucket) bucket.push(game)
    else byYear.set(year, [game])
  }

  const result: DogYear[] = []
  for (const [year, rows] of [...byYear.entries()].sort((a, b) => a[0] - b[0])) {
    const cumulative = Array<number>(91).fill(0)
    for (const game of rows) {
      const cutoff = Math.max(1, Math.min(90, Math.ceil(game.time)))
      cumulative[cutoff] += 1
    }
    for (let second = 1; second <= 90; second += 1) {
      cumulative[second] = (cumulative[second] ?? 0) + (cumulative[second - 1] ?? 0)
    }
    const baseTime = cumulative.findIndex((count) => count > 20)
    if (baseTime < 0) continue
    const baseCount = cumulative[baseTime] ?? 0
    const cells = unique.map((target) => {
      let count = cumulative[Math.min(90, target)] ?? 0
      if (target < baseTime) {
        const delta = baseTime - target
        if (delta < 5) count = baseCount / 1.55 ** delta
        else if (delta < 9) count = baseCount / 2.3 ** (delta - 5) / 1.55 ** 5
        else if (delta < 14) count = baseCount / 3.8 ** (delta - 9) / 1.55 ** 5 / 2.3 ** 4
        else count = 0
      }
      return {
        target,
        count,
        probability: rows.length === 0 ? 0 : count / rows.length,
      }
    })
    result.push({ year, total: rows.length, baseTime, cells })
  }
  return result
}

export interface FrontierPoint {
  time: number
  bvs: number
}

/** 效率前沿：时间升序，保留不断刷新最高 3BVS 的点。 */
export function frontier(games: AnalysisGame[], level: Level): FrontierPoint[] {
  const rows = games
    .filter((game) => game.level === level)
    .map((game) => ({ time: game.time, bvs: game.bvs }))
    .sort((a, b) => a.time - b.time || b.bvs - a.bvs)
  const points: FrontierPoint[] = []
  let best = 0
  for (const point of rows) {
    if (point.bvs > best + 1e-9) {
      points.push(point)
      best = point.bvs
    }
  }
  return points
}
