import { formatShortDate } from '../../shared/format'

/**
 * 时段筛选：全局筛选与梁山分页签共用一套选项与边界解析。
 *
 * 所有边界都按浏览器本地时区的自然日构造：起点是开始日期的本地 00:00，
 * 终点是结束日期次日的本地 00:00（左闭右开），因此完整包含结束日期当天。
 * 用日历运算而不是固定 86 400 000 毫秒，避免夏令时日界错位。
 */

/** 顺序固定：「全部」第一，快捷周期在后，「自定义」最后。 */
export const RANGE_OPTIONS = [
  { key: 'all', label: '全部' },
  { key: 'today', label: '今天' },
  { key: 'yesterday', label: '昨天' },
  { key: 'thisMonth', label: '本月' },
  { key: 'lastMonth', label: '上月' },
  { key: 'thisYear', label: '今年' },
  { key: 'lastYear', label: '去年' },
  { key: 'last7', label: '近7天' },
  { key: 'last30', label: '近30天' },
  { key: 'last90', label: '近90天' },
  { key: 'last365', label: '近一年' },
  { key: 'custom', label: '自定义' },
] as const

export type RangeKey = (typeof RANGE_OPTIONS)[number]['key']

/** 自定义起止日期，`YYYY-MM-DD` 本地日期串。 */
export interface CustomRange {
  start: string
  end: string
}

/** 解析后的时段：起点含当日 00:00，终点不含（结束日期次日 00:00）。 */
export interface DateRange {
  key: RangeKey
  start: number | null
  endExclusive: number | null
  label: string
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** 该时刻所在本地自然日的 00:00。 */
export function startOfLocalDay(value: number): number {
  const date = new Date(value)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** 按日历加减天数，返回该日本地 00:00。 */
export function addLocalDays(value: number, days: number): number {
  const date = new Date(value)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days).getTime()
}

/** `YYYY-MM-DD`（本地日期），用作 `<input type="date">` 的值。 */
export function formatDateInput(value: number): string {
  const date = new Date(value)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 解析 `YYYY-MM-DD` 为本地自然日 00:00；格式或日期无效时返回 null。 */
export function parseDateInput(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null
  }
  return date.getTime()
}

function defaultCustomRange(now: number): CustomRange {
  const today = formatDateInput(now)
  return { start: today, end: today }
}

/**
 * 打开自定义面板时回填的草稿：上次有效的自定义范围优先，其次今天至今天。
 * 不依赖当前选项，切到快捷项后再选「自定义」也能回到上次范围。
 */
export function customDraftFor(custom: CustomRange, now: number): CustomRange {
  return custom.start !== '' && custom.end !== '' ? { ...custom } : defaultCustomRange(now)
}

export interface CustomValidation {
  ok: boolean
  message: string
}

/** 自定义日期校验：两端必填、开始不得晚于结束、不得晚于今天。 */
export function validateCustomRange(draft: CustomRange, now: number): CustomValidation {
  const start = parseDateInput(draft.start)
  const end = parseDateInput(draft.end)
  if (start === null || end === null) return { ok: false, message: '请填写有效的开始和结束日期' }
  if (start > end) return { ok: false, message: '开始日期不能晚于结束日期' }
  const today = startOfLocalDay(now)
  if (start > today) return { ok: false, message: '开始日期不能晚于今天' }
  if (end > today) return { ok: false, message: '结束日期不能晚于今天' }
  return { ok: true, message: '' }
}

function monthStart(day: number, offset: number): number {
  const date = new Date(day)
  return new Date(date.getFullYear(), date.getMonth() + offset, 1).getTime()
}

function yearStart(day: number, offset: number): number {
  const date = new Date(day)
  return new Date(date.getFullYear() + offset, 0, 1).getTime()
}

/** 把选项 + 自定义日期解析成统一区间；日期无效的自定义退化为不限边界。 */
export function resolveRange(key: RangeKey, custom: CustomRange, now: number): DateRange {
  const today = startOfLocalDay(now)
  const day = (offset: number): number => addLocalDays(today, offset)
  switch (key) {
    case 'all':
      return { key, start: null, endExclusive: null, label: '全部' }
    case 'today':
      return { key, start: today, endExclusive: day(1), label: '今天' }
    case 'yesterday':
      return { key, start: day(-1), endExclusive: today, label: '昨天' }
    case 'last7':
      return { key, start: day(-6), endExclusive: day(1), label: '近7天' }
    case 'last30':
      return { key, start: day(-29), endExclusive: day(1), label: '近30天' }
    case 'last90':
      return { key, start: day(-89), endExclusive: day(1), label: '近90天' }
    case 'last365':
      return { key, start: day(-364), endExclusive: day(1), label: '近一年' }
    case 'thisMonth':
      return { key, start: monthStart(today, 0), endExclusive: day(1), label: '本月' }
    case 'lastMonth':
      return { key, start: monthStart(today, -1), endExclusive: monthStart(today, 0), label: '上月' }
    case 'thisYear':
      return { key, start: yearStart(today, 0), endExclusive: day(1), label: '今年' }
    case 'lastYear':
      return { key, start: yearStart(today, -1), endExclusive: yearStart(today, 0), label: '去年' }
    case 'custom':
    default: {
      const start = parseDateInput(custom.start)
      const end = parseDateInput(custom.end)
      if (start === null || end === null || start > end) {
        return { key: 'custom', start: null, endExclusive: null, label: '自定义' }
      }
      return { key: 'custom', start, endExclusive: addLocalDays(end, 1), label: '自定义' }
    }
  }
}

/** 时段说明：`近90天 · 26/8/5–26/11/2`；「全部」不给日期。 */
export function rangeHint(range: DateRange): string {
  if (range.start === null || range.endExclusive === null) return '全部有效记录'
  const endInclusive = addLocalDays(range.endExclusive, -1)
  return `${range.label} · ${formatShortDate(range.start)}–${formatShortDate(endInclusive)}`
}

/** 时间戳是否落在区间内（左闭右开）；无边界表示不限。 */
export function inDateRange(value: number, range: DateRange): boolean {
  if (range.start !== null && value < range.start) return false
  if (range.endExclusive !== null && value >= range.endExclusive) return false
  return true
}

/**
 * 边界签名：渲染时用它判断日期边界是否已经变化（例如跨午夜后「今天」「本月」换了范围），
 * 变化时同步重新应用全局筛选，避免左侧筛选结果和梁山分各自按不同日期计算。
 */
export function rangeSignature(range: DateRange): string {
  return `${range.start ?? ''}|${range.endExclusive ?? ''}`
}
