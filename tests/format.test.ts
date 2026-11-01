import { describe, expect, it } from 'vitest'
import { formatDateTime, formatShortDate } from '../src/shared/format'

describe('短日期', () => {
  it('按本地时区输出 YY/M/D，月和日不补零', () => {
    expect(formatShortDate('2025-05-24T10:00:00')).toBe('25/5/24')
    expect(formatShortDate('2024-12-31T23:59:00')).toBe('24/12/31')
    expect(formatShortDate(Date.parse('2023-01-06T00:00:00'))).toBe('23/1/6')
  })

  it('缺失或无效返回 —', () => {
    expect(formatShortDate(null)).toBe('—')
    expect(formatShortDate('not a date')).toBe('—')
  })
})

describe('日期时间', () => {
  it('日期部分同样用 YY/M/D', () => {
    expect(formatDateTime(Date.parse('2025-05-24T10:05:00'))).toBe('25/5/24 10:05')
  })
})
