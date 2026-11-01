import { describe, expect, it } from 'vitest'
import {
  configureColors,
  DEFAULT_COLOR_THRESHOLDS,
  dateColorStyle,
  medianOf,
  pbColorStyle,
} from '../src/features/player-stats/colors'

describe('PB 配色', () => {
  it('用时按 VBA 的 bt 阈值取色', () => {
    expect(pbColorStyle('b', 'time', 0.2)).toEqual({
      backgroundColor: '#FFFF66',
      color: '#000000',
    })
    expect(pbColorStyle('b', 'time', 2.5)).toEqual({
      backgroundColor: '#0099FF',
      color: '#ffffff',
    })
  })

  it('用时超出最高档时不填色', () => {
    expect(pbColorStyle('b', 'time', 20)).toBeNull()
    expect(pbColorStyle('e', 'time', 120)).toBeNull()
  })

  it('3BVS 用 9 → 0.01 的原始阈值，越高越靠前', () => {
    expect(pbColorStyle('b', 'bvs', 0)).toBeNull()
    expect(pbColorStyle('b', 'bvs', 4.6)).toEqual({
      backgroundColor: '#0099FF',
      color: '#ffffff',
    })
    expect(pbColorStyle('b', 'bvs', 8.5)).toEqual({
      backgroundColor: '#6699FF',
      color: '#000000',
    })
  })

  it('STNB 用同一套阈值 ×25', () => {
    expect(pbColorStyle('e', 'stnb', 400)).toEqual({
      backgroundColor: '#FF6666',
      color: '#000000',
    })
    expect(pbColorStyle('e', 'stnb', 10)).toEqual({
      backgroundColor: '#CCCCCC',
      color: '#000000',
    })
  })

  it('日期列按最早红 / 50% 白 / 最新蓝取色', () => {
    expect(dateColorStyle(1, 1, 50, 100)?.backgroundColor).toBe('#F8696B')
    expect(dateColorStyle(50, 1, 50, 100)?.backgroundColor).toBe('#FCFCFF')
    expect(dateColorStyle(100, 1, 50, 100)?.backgroundColor).toBe('#5A8AC6')
  })

  it('两个日期时中位数取中间值，最新日期仍是蓝色', () => {
    const dates = [1_700_000_000_000, 1_700_000_000_000 + 86_400_000]
    expect(medianOf(dates)).toBe(1_700_000_000_000 + 43_200_000)
    expect(dateColorStyle(dates[1]!, dates[0]!, medianOf(dates), dates[1]!)?.backgroundColor).toBe(
      '#5A8AC6',
    )
  })

  it('自定义阈值后按新阈值取色，恢复默认后还原', () => {
    const original = pbColorStyle('b', 'bvs', 8.5)
    configureColors(DEFAULT_COLOR_THRESHOLDS.map((value) => value * 2))
    expect(pbColorStyle('b', 'bvs', 8.5)).not.toEqual(original)
    configureColors(DEFAULT_COLOR_THRESHOLDS)
    expect(pbColorStyle('b', 'bvs', 8.5)).toEqual(original)
  })
})
