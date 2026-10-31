import { describe, expect, it } from 'vitest'
import { formatDateStamp } from '../src/shared/format'

describe('8 位日期', () => {
  it('按本地时区输出 YYYYMMDD', () => {
    expect(formatDateStamp('2025-05-24T10:00:00')).toBe('20250524')
    expect(formatDateStamp('2024-12-31T23:59:00')).toBe('20241231')
  })

  it('缺失或无效返回 —', () => {
    expect(formatDateStamp(null)).toBe('—')
    expect(formatDateStamp('not a date')).toBe('—')
  })
})
