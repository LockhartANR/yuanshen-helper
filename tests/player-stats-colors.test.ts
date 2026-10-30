import { describe, expect, it } from 'vitest'
import { pbColorStyle } from '../src/features/player-stats/colors'

describe('PB 配色', () => {
  it('用时：区间按门槛升序，颜色和门槛一一对应', () => {
    expect(pbColorStyle('b', 'time', 0.2)).toEqual({
      backgroundColor: '#A65C12',
      color: '#ffffff',
    })
    expect(pbColorStyle('b', 'time', 2.5)).toEqual({
      backgroundColor: '#005696',
      color: '#ffffff',
    })
  })

  it('用时超出最高门槛时落到最后一段（透明）', () => {
    expect(pbColorStyle('b', 'time', 20)).toBeNull()
    expect(pbColorStyle('e', 'time', 120)).toBeNull()
  })

  it('3BVS 越高颜色越靠后，深色底自动配白字', () => {
    expect(pbColorStyle('b', 'bvs', 0)).toBeNull()
    expect(pbColorStyle('b', 'bvs', 4.6)).toEqual({
      backgroundColor: '#0070C0',
      color: '#ffffff',
    })
    expect(pbColorStyle('b', 'bvs', 8.5)).toEqual({
      backgroundColor: '#CCFF66',
      color: '#000000',
    })
  })

  it('STNB 用同一套色阶，超过 200 是最高的绿色', () => {
    expect(pbColorStyle('e', 'stnb', 400)).toEqual({
      backgroundColor: '#CCFF66',
      color: '#000000',
    })
    expect(pbColorStyle('e', 'stnb', 10)).toEqual({
      backgroundColor: '#808080',
      color: '#000000',
    })
  })
})
