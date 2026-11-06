import {
  activeDays,
  activityCalendar,
  bucketStats,
  dogPredictions,
  efficiencyTop,
  frontier,
  gcStats,
  heatmapStats,
  monthStats,
  othTop,
  periodGroups,
  rangeStats,
  rankGames,
  recentPb,
  subStats,
  summarize,
  todayCopyText,
  weekStats,
  yearStats,
} from './analysis'
import type {
  AnalysisGame,
  DogYear,
  EfficiencyMetric,
  FrontierPoint,
  GcStat,
  Heatmap,
  LevelSummary,
  MonthStat,
  OthMetric,
  OthRow,
  PeriodGroup,
  PeriodMode,
  RecentPb,
  TodayStat,
  WeekStat,
  YearStat,
} from './analysis'
import type { DateRange } from './analysis-range'
import { parseDogTargets } from './analysis-settings'
import type { AnalysisSettings } from './analysis-settings'
import type {
  AnalysisSnapshot,
  RankLayout,
  RankStat,
  RangeControlState,
} from './analysis-state'
import { lsfViewData } from './analysis-data'
import type { LsfEvent, LsfHistory, LsfRange } from './lsf-history'
import type { Level } from './model'
import { LEVEL_LABELS, LEVELS, STNB_COEFFICIENT } from './model'
import { ratingSnapshot } from './ratings'
import type { RatingSnapshot } from './ratings'
import {
  formatCopyMonth,
  monthCopyText,
  weekCopyEntries,
  weekCopyText,
  yearCopyText,
} from './trend-copy'

/** 复制设置区与复制按钮共用的预览内容。 */
export interface CopyPreview {
  title: string
  text: string
}

export interface OverviewTabData {
  kind: 'overview'
  recent: RecentPb[]
  recentCount: number
  lastWeek: WeekStat | undefined
  activeDays: number
  gamesLast30: number
  summary: LevelSummary[]
  today: TodayStat[]
  /** 今日复制文本按难度回查，点击时不再重新统计。 */
  todayCopies: Map<Level, string>
  rating: RatingSnapshot
  gc: GcStat[]
  calendar: ReturnType<typeof activityCalendar>
  floorLabel: string
  anchorMode: 'workbook' | 'site'
  anchorError: boolean
  /** 数据快照时钟；最近 PB 高亮等展示判断使用它。 */
  now: number
}

export interface TrendTabData {
  kind: 'trend'
  /** 只含有成绩的周，Δ 按当前展示顺序计算。 */
  weeks: ReturnType<typeof weekCopyEntries>
  /** 已按「隐藏无数据月份」过滤后的展示月份。 */
  months: MonthStat[]
  monthLevel: Level
  hideEmptyMonths: boolean
  years: Record<Level, YearStat[]>
  weekCopies: Map<number, string>
  monthCopies: Map<string, string>
  yearCopies: Record<Level, Map<string, string>>
  monthPreview: CopyPreview
  yearPreviews: Record<Level, CopyPreview>
  monthCopyFields: readonly AnalysisSettings['monthCopyFields'][number][]
  yearCopyFields: readonly AnalysisSettings['yearCopyFields'][number][]
  monthCopyOpen: boolean
  yearCopyOpen: Record<Level, boolean>
}

/** 当前页签实际需要的展示数据。 */
export type AnalysisTabData =
  | OverviewTabData
  | TrendTabData
  | LsfTabData
  | RankTabData
  | PeriodTabData
  | DistTabData
  | EffTabData
  | MapTabData

export interface LsfTabData {
  kind: 'lsf'
  history: LsfHistory
  range: LsfRange
  bounds: DateRange
  events: LsfEvent[]
  controls: RangeControlState
  expanded: ReadonlySet<string>
  limit: number
  focus: string
  highlightDay: number | null
  floorLabel: string
  anchorMode: 'workbook' | 'site'
  anchorError: boolean
}

export interface RankTabData {
  kind: 'rank'
  rankStat: RankStat
  rankLevel: Level
  rankLayout: RankLayout
  /** 单难度布局时的排行；三难度布局时为空。 */
  singleRows: AnalysisGame[] | null
  /** 三难度布局时各级排行；单难度布局时为空。 */
  tripleRows: Record<Level, AnalysisGame[]> | null
  limit: number
  floorLabel: string
  nfOnly: boolean
}

export interface PeriodTabData {
  kind: 'period'
  mode: PeriodMode
  level: Level
  stat: RankStat
  groups: PeriodGroup[]
  selected: PeriodGroup | undefined
  rows: AnalysisGame[]
  limit: number
}

export interface DistTabData {
  kind: 'dist'
  level: Level
  buckets: ReturnType<typeof bucketStats>
  subs: ReturnType<typeof subStats>
  ranges: ReturnType<typeof rangeStats>
  floorLabel: string
}

export interface EffTabData {
  kind: 'eff'
  level: Level
  smallTop: number
  efficiency: Record<EfficiencyMetric, ReturnType<typeof efficiencyTop>>
  other: Record<OthMetric, OthRow[]>
}

export interface MapTabData {
  kind: 'map'
  level: Level
  map: Heatmap
  points: FrontierPoint[]
  dog: DogYear[]
  dogTargets: number[]
  maxBv: number
  coefficient: number
  floorBv: number
}

function floorLabel(snapshot: AnalysisSnapshot): string {
  const floors = snapshot.settings.bvFloors
  return `${floors.b}/${floors.i}/${floors.e}`
}

function overviewTabData(snapshot: AnalysisSnapshot): OverviewTabData {
  const { games, rangeGames, ratingGames, today } = snapshot.data
  const { settings } = snapshot
  const now = snapshot.dataNow
  const recent = recentPb(games, now, 30, 8)
  const weeks = weekStats(
    games,
    10,
    now,
    true,
    settings.t37Slots,
    settings.t37Pads,
    settings.pppConsts,
  )
  const rating = ratingSnapshot(
    ratingGames,
    settings.anchors,
    settings.softWeights,
    settings.levelWeights,
    settings.bvFloors,
  )
  const todayCopies = new Map<Level, string>()
  for (const row of today) todayCopies.set(row.level, todayCopyText(row))
  return {
    kind: 'overview',
    recent,
    recentCount: games.filter(
      (game) =>
        game.pb &&
        game.pbPrev !== null &&
        game.date >= now - 30 * 86_400_000 &&
        game.date <= now,
    ).length,
    lastWeek: weeks[weeks.length - 1],
    activeDays: activeDays(games, now, 30),
    gamesLast30: games.filter((game) => game.date >= now - 30 * 86_400_000).length,
    summary: summarize(games, now),
    today,
    todayCopies,
    rating,
    gc: gcStats(rangeGames),
    calendar: activityCalendar(games, now),
    floorLabel: floorLabel(snapshot),
    anchorMode: settings.anchorMode,
    anchorError: snapshot.anchors.error,
    now,
  }
}

/** 初次渲染和局部改字段共用格式化结果，预览直接复用按钮复制文本。 */
function trendCopyData(
  data: Pick<TrendTabData, 'months' | 'monthLevel' | 'years'>,
  settings: Pick<AnalysisSettings, 'monthCopyFields' | 'yearCopyFields'>,
) {
  const { months, monthLevel, years } = data
  const { monthCopyFields, yearCopyFields } = settings
  const monthCopies = new Map<string, string>()
  for (const month of months) {
    if (month.count > 0) monthCopies.set(month.key, monthCopyText(month, monthLevel, monthCopyFields))
  }
  const firstMonth = months.find((month) => month.count > 0)
  const monthPreview: CopyPreview = {
    title: `复制预览 · ${firstMonth ? `${formatCopyMonth(firstMonth.key)} · ` : ''}${LEVEL_LABELS[monthLevel]}`,
    text: firstMonth ? monthCopies.get(firstMonth.key)! : '暂无数据可预览',
  }
  const yearCopies: Record<Level, Map<string, string>> = { b: new Map(), i: new Map(), e: new Map() }
  const yearPreviews = {} as Record<Level, CopyPreview>
  for (const level of LEVELS) {
    for (const year of years[level]) {
      if (year.count > 0) yearCopies[level].set(String(year.year), yearCopyText(year, level, yearCopyFields))
    }
    const firstYear = years[level].find((year) => year.count > 0)
    yearPreviews[level] = {
      title: `复制预览 · ${firstYear ? `${firstYear.year} · ` : ''}${LEVEL_LABELS[level]}`,
      text: firstYear ? yearCopies[level].get(String(firstYear.year))! : '暂无数据可预览',
    }
  }
  return { monthCopies, yearCopies, monthPreview, yearPreviews, monthCopyFields, yearCopyFields }
}

/** 复制字段变化时只重算复制文本与预览，保留已展示的表格统计与时段。 */
export function withTrendCopyFields(
  data: TrendTabData,
  settings: AnalysisSettings,
): TrendTabData {
  return {
    ...data,
    ...trendCopyData(data, settings),
  }
}

function trendTabData(snapshot: AnalysisSnapshot): TrendTabData {
  const { games, rangeGames } = snapshot.data
  const { settings, tab } = snapshot
  const now = snapshot.dataNow
  const level = tab.trendLevel
  const weeks = weekStats(
    games,
    10,
    now,
    true,
    settings.t37Slots,
    settings.t37Pads,
    settings.pppConsts,
  ).filter((week) => week.count > 0)
  const allMonths = monthStats(games, level, rangeGames)
  const months = tab.hideEmptyMonths ? allMonths.filter((month) => month.count > 0) : allMonths
  const weekCopies = new Map<number, string>()
  const trendWeeks = weekCopyEntries(weeks)
  for (const { week, delta } of trendWeeks) {
    weekCopies.set(week.start, weekCopyText(week, {
      delta,
      software: snapshot.dataset.source === 'csv' ? 'all' : snapshot.filters.software,
      nfOnly: snapshot.filters.nfOnly,
      range: snapshot.bounds,
    }))
  }
  const years: Record<Level, YearStat[]> = { b: [], i: [], e: [] }
  for (const yearLevel of LEVELS) {
    years[yearLevel] = yearStats(games, yearLevel, rangeGames)
  }
  return {
    kind: 'trend',
    weeks: trendWeeks,
    months,
    monthLevel: level,
    hideEmptyMonths: tab.hideEmptyMonths,
    years,
    weekCopies,
    ...trendCopyData({ months, monthLevel: level, years }, settings),
    monthCopyOpen: tab.monthCopyOpen,
    yearCopyOpen: tab.yearCopyOpen,
  }
}

/** 按当前页签生成展示数据，只聚合当前页签需要的内容。 */
export function tabDataFor(snapshot: AnalysisSnapshot): AnalysisTabData {
  switch (snapshot.tab.nav) {
    case 'overview':
      return overviewTabData(snapshot)
    case 'trend':
      return trendTabData(snapshot)
    case 'lsf':
      return lsfTabData(snapshot)
    case 'rank':
      return rankTabData(snapshot)
    case 'period':
      return periodTabData(snapshot)
    case 'dist':
      return distTabData(snapshot)
    case 'eff':
      return effTabData(snapshot)
    case 'map':
      return mapTabData(snapshot)
  }
}

function rankTabData(snapshot: AnalysisSnapshot): RankTabData {
  const { rankLayout, rankStat, rankLevel } = snapshot.tab
  const triple = rankLayout === 'triple'
  return {
    kind: 'rank',
    rankStat,
    rankLevel,
    rankLayout,
    singleRows: triple ? null : rankGames(snapshot.data.games, rankStat, rankLevel),
    tripleRows: triple
      ? {
          b: rankGames(snapshot.data.games, rankStat, 'b'),
          i: rankGames(snapshot.data.games, rankStat, 'i'),
          e: rankGames(snapshot.data.games, rankStat, 'e'),
        }
      : null,
    limit: snapshot.settings.rankLimit,
    floorLabel: floorLabel(snapshot),
    nfOnly: snapshot.filters.nfOnly,
  }
}

function periodTabData(snapshot: AnalysisSnapshot): PeriodTabData {
  const { periodMode, periodLevel, periodStat, periodKey } = snapshot.tab
  const groups = periodGroups(
    snapshot.data.games,
    periodLevel,
    periodMode,
    snapshot.data.rangeGames,
  )
  const selected = groups.find((group) => group.key === periodKey) ?? groups[0]
  const limit = periodMode === 'month' ? snapshot.settings.monthTop : snapshot.settings.yearTop
  return {
    kind: 'period',
    mode: periodMode,
    level: periodLevel,
    stat: periodStat,
    groups,
    selected,
    rows: selected ? rankGames(selected.rows, periodStat).slice(0, limit) : [],
    limit,
  }
}

function distTabData(snapshot: AnalysisSnapshot): DistTabData {
  const { distLevel } = snapshot.tab
  return {
    kind: 'dist',
    level: distLevel,
    buckets: bucketStats(snapshot.data.games, distLevel),
    subs: subStats(snapshot.data.games, distLevel, snapshot.settings.subTiers),
    ranges: rangeStats(snapshot.data.rangeGames, distLevel),
    floorLabel: floorLabel(snapshot),
  }
}

const EFFICIENCY_METRICS: Array<EfficiencyMetric> = ['cls', 'ces', 'mov', 'ioe']
const OTHER_METRICS: Array<OthMetric> = [
  'invCe',
  'ce',
  'invPath',
  'invIs',
  'invOp',
  'is',
  'op',
]

function effTabData(snapshot: AnalysisSnapshot): EffTabData {
  const { effLevel } = snapshot.tab
  const { smallTop } = snapshot.settings
  const efficiency = {} as EffTabData['efficiency']
  for (const metric of EFFICIENCY_METRICS) {
    efficiency[metric] = efficiencyTop(snapshot.data.games, effLevel, metric, smallTop)
  }
  const other = {} as EffTabData['other']
  for (const metric of OTHER_METRICS) {
    other[metric] = othTop(snapshot.data.games, effLevel, metric, smallTop)
  }
  return { kind: 'eff', level: effLevel, smallTop, efficiency, other }
}

function mapTabData(snapshot: AnalysisSnapshot): MapTabData {
  const level = snapshot.tab.mapLevel
  const dogTargets = parseDogTargets(
    level === 'e' ? snapshot.settings.dogTargetsE : snapshot.settings.dogTargetsI,
  )
  return {
    kind: 'map',
    level,
    map: heatmapStats(snapshot.data.games, level),
    points: frontier(snapshot.data.games, level),
    dog: dogPredictions(snapshot.data.games, dogTargets, level).slice(-4),
    dogTargets,
    maxBv: level === 'e' ? 278 : 134,
    coefficient: STNB_COEFFICIENT[level],
    floorBv: snapshot.settings.bvFloors[level],
  }
}

function lsfTabData(snapshot: AnalysisSnapshot): LsfTabData {
  const { range, events } = lsfViewData(
    snapshot.data.history,
    snapshot.bounds,
    snapshot.clock,
  )
  return {
    kind: 'lsf',
    history: snapshot.data.history,
    range,
    bounds: snapshot.bounds,
    events,
    controls: snapshot.rangeControl,
    expanded: snapshot.tab.lsfExpanded,
    limit: snapshot.tab.lsfLimit,
    focus: snapshot.tab.lsfFocus,
    highlightDay: snapshot.tab.lsfFocusDay,
    floorLabel: floorLabel(snapshot),
    anchorMode: snapshot.settings.anchorMode,
    anchorError: snapshot.anchors.error,
  }
}
