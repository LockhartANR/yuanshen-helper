import { describe, expect, it } from 'vitest'
import { convertAnchors } from '../src/features/player-stats/lsf-anchors'
import { STNB_COEFFICIENT } from '../src/features/player-stats/model'
import { WORKBOOK_ANCHORS } from '../src/features/player-stats/ratings'

function rawFromWorkbook(): Record<string, { value: number }> {
  const raw: Record<string, { value: number }> = {}
  for (const [key, value] of Object.entries(WORKBOOK_ANCHORS)) {
    const level = key.slice(key.indexOf(':') + 1, key.indexOf(':') + 2) as 'b' | 'i' | 'e'
    const metric = key.slice(-1)
    raw[key] = {
      value: metric === 't' ? value * 1000 : metric === 's' ? value / STNB_COEFFICIENT[level] : value,
    }
  }
  return raw
}

describe('LSF 站点锚点换算', () => {
  it('毫秒转秒、归一化 STNB 转原始值后回到大表锚点', () => {
    const anchors = convertAnchors(rawFromWorkbook())
    for (const [key, value] of Object.entries(WORKBOOK_ANCHORS)) {
      expect(anchors[key]).toBeCloseTo(value, 9)
    }
  })

  it('缺项或非正数时抛错', () => {
    const raw = rawFromWorkbook()
    delete raw['std:bt']
    expect(() => convertAnchors(raw)).toThrow('std:bt')

    const invalid = rawFromWorkbook()
    invalid['nf:es'] = { value: 0 }
    expect(() => convertAnchors(invalid)).toThrow('nf:es')
  })
})
