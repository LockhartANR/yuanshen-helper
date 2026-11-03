import { LEVEL_EN } from './analysis'
import type { MonthStat, YearStat } from './analysis'
import type { Level } from './model'

/** 月年复制与预览共用的格式、字段顺序及设置标签。 */

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

/** 月均复制文本：固定三行 + 按分组合并的可选行。 */
export function monthCopyText(
  row: MonthStat,
  level: Level,
  fields: readonly MonthCopyField[],
): string {
  const selected = new Set<MonthCopyField>(fields)
  const lines = [
    `月成绩 · ${row.key} · ${LEVEL_EN[level]}`,
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

