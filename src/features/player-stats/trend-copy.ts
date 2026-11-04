import { LEVEL_EN } from './analysis'
import type { MonthStat, WeekStat, YearStat } from './analysis'
import { addLocalDays, formatDateInput } from './analysis-range'
import { LEVELS, softwareLabel } from './model'
import type { Level } from './model'

/** 周复制固定格式，以及月年复制与预览共用的字段顺序、设置标签。 */

export type MonthCopyField =
  | 'medianTime'
  | 'op'
  | 'is'
  | 'cls'
  | 'ces'
  | 'corr'
  | 'thrp'
  | 'path'
  | 'mov'
  | 'breakRate'
  | 'headScore'
  | 'pbCount'

export type YearCopyField = 'cls' | 'ces' | 'mov'

/** 周复制的统计上下文，与周结果来自同一次渲染。 */
export interface WeekCopyContext {
  /** 与当前列表上一条有成绩周的 T37 差；null 表示没有比较对象。 */
  delta: number | null
  /** 全局软件筛选；'all' 或未设置表示不限制。 */
  software?: string
  /** 是否只看 NF。 */
  nfOnly?: boolean
  /** 已应用的全局时段，自然周被截断时在首行注明统计日期。 */
  range?: { start: number | null; endExclusive: number | null } | null
}

/** 设置区按分组展示，复制时同组已选字段合并成一行。 */
export const MONTH_COPY_GROUPS = [
  { key: 'game', label: '每局数据' },
  { key: 'clicks', label: '点击与转化' },
  { key: 'path', label: '路径' },
  { key: 'head', label: '头部表现' },
] as const

interface CopyFieldSpec<Row, Field extends string> {
  field: Field
  label: string
  copyLabel: string
  value: (row: Row) => string
}

interface MonthCopyFieldSpec extends CopyFieldSpec<MonthStat, MonthCopyField> {
  group: (typeof MONTH_COPY_GROUPS)[number]['key']
}

/** 依赖成绩样本的指标：没有达标成绩时统一输出 —。 */
function scoreText(row: { hasScores: boolean }, available: boolean, text: string): string {
  return row.hasScores && available ? text : '—'
}

function averageLine(row: {
  hasScores: boolean
  avgTime: number
  avgBvs: number
  avgStnb: number
  avgBv: number
}): string {
  return row.hasScores
    ? `Avg T ${row.avgTime.toFixed(3)} | B ${row.avgBvs.toFixed(3)} | S ${row.avgStnb.toFixed(1)} | 3BV ${row.avgBv.toFixed(1)}`
    : 'Avg T — | B — | S — | 3BV —'
}

/** 顺序即输出顺序；小数位、缺失占位和真实零值都在这里定死。 */
export const MONTH_COPY_FIELDS: readonly MonthCopyFieldSpec[] = [
  {
    field: 'medianTime',
    group: 'game',
    label: '中位用时',
    copyLabel: 'Median T',
    value: (row) => scoreText(row, true, row.medianTime.toFixed(3)),
  },
  {
    field: 'op',
    group: 'game',
    label: 'op',
    copyLabel: 'op',
    value: (row) => scoreText(row, row.hasOp, row.avgOp.toFixed(1)),
  },
  {
    field: 'is',
    group: 'game',
    label: 'is',
    copyLabel: 'is',
    value: (row) => scoreText(row, row.hasIs, row.avgIs.toFixed(1)),
  },
  {
    field: 'cls',
    group: 'clicks',
    label: 'cl/s',
    copyLabel: 'cl/s',
    value: (row) => scoreText(row, row.hasCl, row.avgCls.toFixed(2)),
  },
  {
    field: 'ces',
    group: 'clicks',
    label: 'ce/s',
    copyLabel: 'ce/s',
    value: (row) => scoreText(row, row.hasCe, row.avgCes.toFixed(2)),
  },
  {
    field: 'corr',
    group: 'clicks',
    label: 'Corr',
    copyLabel: 'Corr',
    value: (row) => scoreText(row, row.hasCl && row.hasCe, row.avgCorr.toFixed(2)),
  },
  {
    field: 'thrp',
    group: 'clicks',
    label: 'Thrp',
    copyLabel: 'Thrp',
    value: (row) => scoreText(row, row.hasCe, row.avgThrp.toFixed(2)),
  },
  {
    field: 'path',
    group: 'path',
    label: '路径长度',
    copyLabel: '路径',
    value: (row) => scoreText(row, row.hasPath, String(Math.round(row.avgPath))),
  },
  {
    field: 'mov',
    group: 'path',
    label: '移速',
    copyLabel: '移速',
    value: (row) => scoreText(row, row.hasPath, row.avgMov.toFixed(1)),
  },
  {
    // 0 是内部哨兵，不当作有效破率。
    field: 'breakRate',
    group: 'head',
    label: '1/破率',
    copyLabel: '1/破率',
    value: (row) => scoreText(row, row.breakRate !== 0, String(row.breakRate)),
  },
  {
    field: 'headScore',
    group: 'head',
    label: '头部表现',
    copyLabel: '头部表现',
    value: (row) => scoreText(row, true, String(row.headScore)),
  },
  {
    field: 'pbCount',
    group: 'head',
    label: '新 PB',
    copyLabel: '新 PB',
    value: (row) => scoreText(row, true, String(row.pbCount)),
  },
]

/** 年汇总三个难度共用这一套选项，按此顺序合并成一行。 */
export const YEAR_COPY_FIELDS: readonly CopyFieldSpec<YearStat, YearCopyField>[] = [
  {
    field: 'cls',
    label: 'cl/s',
    copyLabel: 'cl/s',
    value: (row) => scoreText(row, row.hasCl, row.avgCls.toFixed(2)),
  },
  {
    field: 'ces',
    label: 'ce/s',
    copyLabel: 'ce/s',
    value: (row) => scoreText(row, row.hasCe, row.avgCes.toFixed(2)),
  },
  {
    field: 'mov',
    label: '移速',
    copyLabel: '移速',
    value: (row) => scoreText(row, row.hasPath, row.avgMov.toFixed(1)),
  },
]

function normalizeFields<T extends string>(value: unknown, specs: readonly { field: T }[]): T[] {
  const selected = new Set<unknown>(Array.isArray(value) ? value : [])
  return specs.map((spec) => spec.field).filter((field) => selected.has(field))
}

/** 只保留允许列表内的字符串，去重并归一化到固定输出顺序。 */
export function normalizeMonthCopyFields(value: unknown): MonthCopyField[] {
  return normalizeFields(value, MONTH_COPY_FIELDS)
}

/** 只保留允许列表内的字符串，去重并归一化到固定输出顺序。 */
export function normalizeYearCopyFields(value: unknown): YearCopyField[] {
  return normalizeFields(value, YEAR_COPY_FIELDS)
}

/** 复制展示用的完整日期：本地时区 `YYYY/MM/DD`，不修改日期控件使用的 formatDateInput。 */
export function formatCopyDate(timestamp: number): string {
  return formatDateInput(timestamp).replace(/-/g, '/')
}

/** 复制展示用的月份：内部键仍是 `YYYY-MM`，只在显示时换成斜杠。 */
export function formatCopyMonth(key: string): string {
  return /^\d{4}-\d{2}$/.test(key) ? key.replace('-', '/') : key
}

/** 月均复制文本：固定三行 + 按分组合并的可选行。 */
export function monthCopyText(
  row: MonthStat,
  level: Level,
  fields: readonly MonthCopyField[],
): string {
  const selected = new Set<MonthCopyField>(fields)
  const lines = [
    `月成绩 · ${formatCopyMonth(row.key)} · ${LEVEL_EN[level]}`,
    `Games ${row.count} | 活跃 ${row.days} 天 | 日均 ${row.days > 0 ? row.gamesPerDay.toFixed(1) : '—'}`,
    averageLine(row),
  ]
  for (const group of MONTH_COPY_GROUPS) {
    const parts = MONTH_COPY_FIELDS.filter(
      (spec) => spec.group === group.key && selected.has(spec.field),
    ).map((spec) => `${spec.copyLabel} ${spec.value(row)}`)
    if (parts.length > 0) lines.push(parts.join(' | '))
  }
  return lines.join('\n')
}

/** 年汇总复制文本：固定三行 + 一行可选指标。 */
export function yearCopyText(
  row: YearStat,
  level: Level,
  fields: readonly YearCopyField[],
): string {
  const selected = new Set<YearCopyField>(fields)
  const lines = [
    `年成绩 · ${row.year} · ${LEVEL_EN[level]}`,
    `Games ${row.count} | 新 PB ${row.hasScores ? row.pbCount : '—'}`,
    averageLine(row),
  ]
  const parts = YEAR_COPY_FIELDS.filter((spec) => selected.has(spec.field)).map(
    (spec) => `${spec.copyLabel} ${spec.value(row)}`,
  )
  if (parts.length > 0) lines.push(parts.join(' | '))
  return lines.join('\n')
}

/**
 * 周统计的自然周日期：周一起点加 6 天得到周日，用日历运算而不是固定毫秒数，
 * 跨月、跨年和夏令时都按本地日期走；复制展示统一用斜杠。
 */
export function formatCopyWeek(start: number): string {
  return `${formatCopyDate(start)}–${formatCopyDate(addLocalDays(start, 6))}`
}

/**
 * ΔT37 文本：正值带 +，负值用 −，没有比较对象为 —。
 * 先按输出精度舍入再定符号，-0.04 这类差值归零后输出 +0.0，不出现 −0.0。
 */
export function formatWeekDelta(delta: number | null): string {
  if (delta === null || !Number.isFinite(delta)) return '—'
  const rounded = Number(delta.toFixed(1))
  if (rounded === 0) return '+0.0'
  return `${rounded < 0 ? '−' : '+'}${Math.abs(rounded).toFixed(1)}`
}

/** 主行 ΔT37 按显示值配色：变小为绿，变大为红，持平或无前项不着色。 */
export function weekDeltaClass(delta: number | null): string {
  if (delta === null || !Number.isFinite(delta)) return ''
  const rounded = Number(delta.toFixed(1))
  if (rounded < 0) return 'delta-up'
  if (rounded > 0) return 'delta-down'
  return ''
}

/**
 * 当前可见周列表（按时间升序）的 ΔT37：只跟列表里上一条有成绩周比，
 * 第一条没有前项。空周不进入列表，因此 Δ 可能跨过空周。
 */
export function weekCopyEntries(
  weeks: readonly WeekStat[],
): Array<{ week: WeekStat; delta: number | null }> {
  return weeks.map((week, index) => ({
    week,
    delta: index > 0 ? week.t37 - (weeks[index - 1] as WeekStat).t37 : null,
  }))
}

/** 全局时段截断自然周时，返回两端日期；未截断时返回 null。 */
function clippedRangeText(weekStart: number, range: WeekCopyContext['range']): string | null {
  if (!range) return null
  const weekEnd = addLocalDays(weekStart, 7)
  const start = range.start === null ? weekStart : Math.max(range.start, weekStart)
  const end = range.endExclusive === null ? weekEnd : Math.min(range.endExclusive, weekEnd)
  if (start <= weekStart && end >= weekEnd) return null
  if (start >= end) return null
  return `${formatCopyDate(start)}–${formatCopyDate(addLocalDays(end, -1))}`
}

/**
 * 一行「总值 = 三级分解」。总值与分项各自格式化，统一使用等号。
 */
function breakdownLine(
  label: string,
  total: number,
  parts: readonly number[],
  digits: number,
  kind: 'sum' | 'cbrt',
): string {
  const shown = parts.map((part) => part.toFixed(digits))
  const right = kind === 'sum' ? shown.join(' + ') : `∛(${shown.join(' × ')})`
  return `${label} ${total.toFixed(digits)} = ${right}`
}

/** 周复制文本：固定六行，第一行日期与筛选，第二行局数与 Δ，后四行各带三级分解。 */
export function weekCopyText(week: WeekStat, context: WeekCopyContext): string {
  const scope: string[] = []
  if (context.software && context.software !== 'all') scope.push(softwareLabel(context.software))
  if (context.nfOnly) scope.push('仅 NF')
  const clipped = clippedRangeText(week.start, context.range)
  const head = `周成绩 · ${formatCopyWeek(week.start)}${clipped ? `（统计日期 ${clipped}）` : ''}`
  return [
    scope.length > 0 ? `${head} · ${scope.join(' · ')}` : head,
    `Games ${week.count} | ΔT37 ${formatWeekDelta(context.delta)}`,
    breakdownLine('T37', week.t37, LEVELS.map((level) => week.levels[level].totals.time), 1, 'sum'),
    breakdownLine('B37', week.b37, LEVELS.map((level) => week.levels[level].totals.bvs), 1, 'sum'),
    breakdownLine('S37', week.s37, LEVELS.map((level) => week.levels[level].totals.stnb), 1, 'sum'),
    breakdownLine('PPP', week.ppp, LEVELS.map((level) => week.levels[level].ppp), 3, 'cbrt'),
  ].join('\n')
}

