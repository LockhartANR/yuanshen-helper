import { describe, expect, it } from 'vitest'
import {
  RANGE_OPTIONS,
  addLocalDays,
  customDraftFor,
  formatDateInput,
  inDateRange,
  parseDateInput,
  rangeHint,
  rangeSignature,
  resolveRange,
  startOfLocalDay,
  validateCustomRange,
} from '../src/features/player-stats/analysis-range'
import type { CustomRange } from '../src/features/player-stats/analysis-range'

/** 2026-11-03 15:30 本地时间。 */
const NOW = new Date(2026, 10, 3, 15, 30).getTime()
const TODAY = new Date(2026, 10, 3).getTime()
const EMPTY: CustomRange = { start: '', end: '' }

function label(value: number): string {
  return formatDateInput(value)
}

describe('时段选项', () => {
  it('顺序固定：全部第一、自定义最后；本月 / 上月 / 今年 / 去年紧跟昨天', () => {
    expect(RANGE_OPTIONS.map((option) => option.key)).toEqual([
      'all',
      'today',
      'yesterday',
      'thisMonth',
      'lastMonth',
      'thisYear',
      'lastYear',
      'last7',
      'last30',
      'last90',
      'last365',
      'custom',
    ])
    expect(RANGE_OPTIONS.map((option) => option.label)).toEqual([
      '全部',
      '今天',
      '昨天',
      '本月',
      '上月',
      '今年',
      '去年',
      '近7天',
      '近30天',
      '近90天',
      '近一年',
      '自定义',
    ])
    expect(RANGE_OPTIONS[0]?.label).toBe('全部')
    expect(RANGE_OPTIONS[RANGE_OPTIONS.length - 1]?.label).toBe('自定义')
  })
})

describe('快捷时段边界', () => {
  const cases: Array<[Parameters<typeof resolveRange>[0], string, string]> = [
    ['today', '2026-11-03', '2026-11-04'],
    ['yesterday', '2026-11-02', '2026-11-03'],
    ['last7', '2026-10-28', '2026-11-04'],
    ['last30', '2026-10-05', '2026-11-04'],
    ['last90', '2026-08-06', '2026-11-04'],
    ['last365', '2025-11-04', '2026-11-04'],
    ['thisMonth', '2026-11-01', '2026-11-04'],
    ['lastMonth', '2026-10-01', '2026-11-01'],
    ['thisYear', '2026-01-01', '2026-11-04'],
    ['lastYear', '2025-01-01', '2026-01-01'],
  ]

  for (const [key, start, end] of cases) {
    it(`${key} 的起止边界`, () => {
      const range = resolveRange(key, EMPTY, NOW)
      expect(range.start).not.toBeNull()
      expect(range.endExclusive).not.toBeNull()
      expect(formatDateInput(range.start as number)).toBe(start)
      expect(formatDateInput(range.endExclusive as number)).toBe(end)
    })
  }

  it('单日选项的终点就是次日零点', () => {
    for (const key of ['today', 'yesterday'] as const) {
      const range = resolveRange(key, EMPTY, NOW)
      expect(range.endExclusive).toBe(addLocalDays(range.start as number, 1))
      expect(range.start).toBe(startOfLocalDay(range.start as number))
    }
  })

  it('跨度按自然日计算：近7 / 30 / 90 / 365 天', () => {
    for (const [key, days] of [
      ['last7', 7],
      ['last30', 30],
      ['last90', 90],
      ['last365', 365],
    ] as const) {
      const range = resolveRange(key, EMPTY, NOW)
      const span = range.endExclusive as number
      const start = range.start as number
      // 用日历运算验证，不假设每天固定 86 400 000 毫秒（夏令时）。
      expect(addLocalDays(start, days)).toBe(span)
    }
  })

  it('「全部」不设日期边界', () => {
    const range = resolveRange('all', EMPTY, NOW)
    expect(range.start).toBeNull()
    expect(range.endExclusive).toBeNull()
    expect(rangeHint(range)).toBe('全部有效记录')
  })

  it('跨年时上月 / 去年仍按日历构造', () => {
    const january = new Date(2026, 0, 15, 9, 0).getTime()
    const lastMonth = resolveRange('lastMonth', EMPTY, january)
    expect(label(lastMonth.start as number)).toBe('2025-12-01')
    expect(label(lastMonth.endExclusive as number)).toBe('2026-01-01')
    const lastYear = resolveRange('lastYear', EMPTY, january)
    expect(label(lastYear.start as number)).toBe('2025-01-01')
    expect(label(lastYear.endExclusive as number)).toBe('2026-01-01')
  })

  it('闰年 2 月边界正确', () => {
    const leap = new Date(2024, 2, 1, 12, 0).getTime()
    const lastMonth = resolveRange('lastMonth', EMPTY, leap)
    expect(label(lastMonth.start as number)).toBe('2024-02-01')
    expect(label(lastMonth.endExclusive as number)).toBe('2024-03-01')
    expect(resolveRange('last7', EMPTY, leap).start).toBe(
      new Date(2024, 1, 24, 0, 0).getTime(),
    )
  })
})

describe('自定义日期', () => {
  it('同一天有效，终点为次日零点', () => {
    const draft: CustomRange = { start: '2026-11-03', end: '2026-11-03' }
    expect(validateCustomRange(draft, NOW)).toEqual({ ok: true, message: '' })
    const range = resolveRange('custom', draft, NOW)
    expect(range.start).toBe(TODAY)
    expect(range.endExclusive).toBe(new Date(2026, 10, 4).getTime())
    expect(rangeHint(range)).toBe('自定义 · 26/11/3–26/11/3')
  })

  it('缺少一端、格式无效、倒置或超过今天都阻止应用', () => {
    expect(validateCustomRange({ start: '', end: '2026-11-03' }, NOW).ok).toBe(false)
    expect(validateCustomRange({ start: '2026-11-03', end: '' }, NOW).ok).toBe(false)
    expect(validateCustomRange({ start: '2026-02-30', end: '2026-03-01' }, NOW).ok).toBe(false)
    expect(
      validateCustomRange({ start: '2026-11-05', end: '2026-11-03' }, NOW).message,
    ).toBe('开始日期不能晚于结束日期')
    expect(
      validateCustomRange({ start: '2026-11-03', end: '2026-11-04' }, NOW).message,
    ).toBe('结束日期不能晚于今天')
    expect(
      validateCustomRange({ start: '2026-11-04', end: '2026-11-04' }, NOW).message,
    ).toBe('开始日期不能晚于今天')
  })


  it('打开自定义面板时优先回填上次有效范围，与当前选项无关', () => {
    const saved: CustomRange = { start: '2026-10-01', end: '2026-10-15' }
    expect(customDraftFor(saved, NOW)).toEqual(saved)
    expect(customDraftFor({ start: '', end: '' }, NOW)).toEqual({
      start: '2026-11-03',
      end: '2026-11-03',
    })
  })

  it('解析只接受本地 YYYY-MM-DD', () => {
    expect(parseDateInput('2026-11-03')).toBe(TODAY)
    expect(parseDateInput('2026-1-3')).toBeNull()
    expect(parseDateInput('2026-02-30')).toBeNull()
    expect(parseDateInput('')).toBeNull()
  })
})

describe('区间判断与说明', () => {
  it('左闭右开：起点计入、终点不计入', () => {
    const range = resolveRange('yesterday', EMPTY, NOW)
    const start = range.start as number
    const end = range.endExclusive as number
    expect(inDateRange(start, range)).toBe(true)
    expect(inDateRange(start - 1, range)).toBe(false)
    expect(inDateRange(end - 1, range)).toBe(true)
    expect(inDateRange(end, range)).toBe(false)
  })

  it('说明包含标签与实际起止日期', () => {
    expect(rangeHint(resolveRange('last90', EMPTY, NOW))).toBe('近90天 · 26/8/6–26/11/3')
    expect(rangeHint(resolveRange('lastMonth', EMPTY, NOW))).toBe('上月 · 26/10/1–26/10/31')
  })

  it('跨午夜后快捷时段的签名会变化，固定范围不变', () => {
    const nextDay = new Date(2026, 10, 4, 0, 0, 1).getTime()
    expect(rangeSignature(resolveRange('today', EMPTY, NOW))).not.toBe(
      rangeSignature(resolveRange('today', EMPTY, nextDay)),
    )
    expect(rangeSignature(resolveRange('all', EMPTY, NOW))).toBe('|')
    expect(rangeSignature(resolveRange('all', EMPTY, nextDay))).toBe('|')
    const custom: CustomRange = { start: '2026-10-01', end: '2026-10-15' }
    expect(rangeSignature(resolveRange('custom', custom, NOW))).toBe(
      rangeSignature(resolveRange('custom', custom, nextDay)),
    )
  })
})
