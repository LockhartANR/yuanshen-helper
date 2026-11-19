import { describe, expect, it } from 'vitest'
import { compileFormula } from '../src/features/custom-ranking/expression/validate'
import {
  createPlayerAccumulator,
  evaluateForGames,
} from '../src/features/custom-ranking/expression/evaluate'
import type { GlobalRankFieldValue } from '../src/features/custom-ranking/model'

const fields = (overrides: Record<string, GlobalRankFieldValue> = {}) => ({
  bv: 20,
  time: 10,
  timems: 10_000,
  clicks: 20,
  cl: 20,
  effectiveClicks: 15,
  ce: 15,
  left: 10,
  right: 5,
  double: 5,
  level: 'b',
  ...overrides,
})

function value(formula: string, games: Array<Record<string, GlobalRankFieldValue>>): number | null {
  const result = evaluateForGames(compileFormula(formula), games)
  return result.values[0] ?? null
}

describe('排行榜公式解析', () => {
  it('支持优先级、幂右结合和一元负号', () => {
    expect(value('max(2 + 3 * 4)', [fields()])).toBe(14)
    expect(value('max(-2 ^ 2)', [fields()])).toBe(-4)
    expect(value('max(2 ^ 3 ^ 2)', [fields()])).toBe(512)
    expect(value('max(2 ^ -2)', [fields()])).toBe(0.25)
    expect(value('max((2 + 3) * 4)', [fields()])).toBe(20)
  })

  it('逐局表达式与聚合函数组合', () => {
    const games = [fields({ bv: 20, time: 10 }), fields({ bv: 60, time: 10 })]
    expect(value('max(bv / time)', games)).toBe(6)
    expect(value('avg(bv / time)', games)).toBe(4)
    expect(value('sum(bv) / sum(time)', games)).toBe(4)
    expect(value('count()', games)).toBe(2)
  })

  it('条件短路、null 与 isNull', () => {
    const games = [fields({ level: 'b' }), fields({ level: 'e', time: 4 })]
    expect(value('avg(if(level == "e", time, null))', games)).toBe(4)
    expect(value('countValid(if(level == "e", time, null))', games)).toBe(1)
    expect(value('if(count() > 0, 7, 1 / 0)', games)).toBe(7)
    expect(value('max(if(isNull(clicks), 1, 2))', [fields({ clicks: null })])).toBe(1)
    expect(value('avg(if(clicks == null, 1, 0))', [fields({ clicks: null })])).toBe(0)
  })

  it('除零、非法定义域和 null 不产生伪数值', () => {
    expect(value('avg(bv / 0)', [fields()])).toBeNull()
    expect(value('avg(sqrt(-1))', [fields()])).toBeNull()
    expect(value('avg(log(0))', [fields()])).toBeNull()
    expect(value('avg(bv + null)', [fields()])).toBeNull()
    expect(value('countValid(bv / 0)', [fields({ bv: 0 })])).toBe(0)
  })

  it('round 只改变计算值，显示精度不参与排序', () => {
    expect(value('round(avg(bv / time), 2)', [fields({ bv: 1, time: 3 })])).toBe(0.33)
    expect(value('round(avg(bv / time), 7)', [fields()])).toBeNull()
  })

  it('拒绝裸字段、未知字段、嵌套聚合和脚本能力', () => {
    expect(() => compileFormula('bv / time')).toThrow(/字段/)
    expect(() => compileFormula('max(nope)')).toThrow(/未知字段/)
    expect(() => compileFormula('avg(max(bv))')).toThrow(/嵌套/)
    expect(() => compileFormula('max(bv.constructor)')).toThrow(/无法识别/)
    expect(() => compileFormula('max(fetch(bv))')).toThrow(/未知函数/)
    expect(() => compileFormula('max(bv) + avg(bv)')).not.toThrow()
  })

  it('兼容别名与标准字段共享类型和计算结果', () => {
    const games = [fields({ cl: 11, clicks: 11, ce: 9, effectiveClicks: 9 })]
    expect(value('avg(clicks)', games)).toBe(11)
    expect(value('avg(cl)', games)).toBe(11)
    expect(value('avg(effectiveClicks)', games)).toBe(9)
    expect(value('avg(ce)', games)).toBe(9)
    expect(() => compileFormula('avg(clicks)')).not.toThrow()
    expect(() => compileFormula('avg(effectiveClicks)')).not.toThrow()
  })

  it('拒绝字符串参与数值聚合、数学函数和最终非数值结果', () => {
    expect(() => compileFormula('avg(software)')).toThrow(/数值/)
    expect(() => compileFormula('max(level)')).toThrow(/数值/)
    expect(() => compileFormula('sum(software)')).toThrow(/数值/)
    expect(() => compileFormula('max(sqrt(software))')).toThrow(/数值/)
    expect(() => compileFormula('max(pow(bv, software))')).toThrow(/数值/)
    expect(() => compileFormula('max(bv == 1)')).toThrow(/数值/)
    expect(() => compileFormula('if(count() > 0, "yes", "no")')).toThrow(/最终结果/)
    expect(() => compileFormula('avg(if(level == "e", time, null))')).not.toThrow()
  })

  it('字符串只用于字符串比较，类型不一致的运算在编译期拒绝', () => {
    expect(() => compileFormula('max(if(level == 1, bv, 0))')).toThrow(/类型/)
    expect(() => compileFormula('max(bv + software)')).toThrow(/数值/)
    expect(() => compileFormula('max(if(level == "e", time, 0))')).not.toThrow()
    expect(() => compileFormula('countValid(software)')).not.toThrow()
  })

  it('超过节点、深度或长度限制时拒绝', () => {
    expect(() => compileFormula(Array.from({ length: 100 }, () => 'max(bv)').join(' + '))).toThrow(/节点|层级/)
    expect(() => compileFormula(`${'max(bv) + '.repeat(40)}max(bv)`)).toThrow(/层级/)
    expect(() => compileFormula(`max(${'1+'.repeat(20)}1)`.padEnd(2001, ' '))).toThrow(/字符/)
  })

  it('聚合器按玩家流式累计并记录有效样本数', () => {
    const accumulator = createPlayerAccumulator([
      compileFormula('avg(bv / time)'),
      compileFormula('countValid(clicks)'),
    ])
    accumulator.addGame(fields({ bv: 20, time: 10, clicks: 4 }))
    accumulator.addGame(fields({ bv: 60, time: 10, clicks: null }))
    const result = accumulator.finish()
    expect(result.values).toEqual([4, 1])
    expect(result.samples).toEqual([2, 2])
  })
})
