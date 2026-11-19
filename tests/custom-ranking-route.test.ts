import { describe, expect, it } from 'vitest'
import {
  isRankingHash,
  isRankingOpenSender,
  isRankingUrl,
} from '../src/shared/ranking-route'

describe('站内排行榜入口路由', () => {
  it('匹配顶层排行榜及子路径，忽略查询参数', () => {
    expect(isRankingHash('#/ranking')).toBe(true)
    expect(isRankingHash('#/ranking/')).toBe(true)
    expect(isRankingHash('#/ranking/3bv')).toBe(true)
    expect(isRankingHash('#/ranking/3bv?tab=all')).toBe(true)
    expect(isRankingHash('#/ranking?from=home')).toBe(true)
  })

  it('不匹配相似路由、玩家页或其他源站', () => {
    expect(isRankingHash('#/ranking-other')).toBe(false)
    expect(isRankingHash('#/player/1')).toBe(false)
    expect(isRankingUrl('https://openms.top/#/ranking-other')).toBe(false)
    expect(isRankingUrl('https://openms.top/#/player/1')).toBe(false)
    expect(isRankingUrl('https://example.com/#/ranking')).toBe(false)
    expect(isRankingUrl('not a url')).toBe(false)
  })

  it('只识别 openms.top 的排行榜 hash', () => {
    expect(isRankingUrl('https://openms.top/#/ranking/')).toBe(true)
    expect(isRankingUrl('https://openms.top/#/ranking/3bv?x=1')).toBe(true)
  })

  it('后台只接受扩展自身顶层排行榜页面来源', () => {
    const base = { id: 'ext', frameId: 0, tab: { url: 'https://openms.top/#/ranking/3bv' } }
    expect(isRankingOpenSender(base, 'ext')).toBe(true)
    expect(isRankingOpenSender({ ...base, id: 'other' }, 'ext')).toBe(false)
    expect(isRankingOpenSender({ ...base, frameId: 2 }, 'ext')).toBe(false)
    expect(
      isRankingOpenSender({ ...base, tab: { url: 'https://openms.top/#/player/1' } }, 'ext'),
    ).toBe(false)
    expect(
      isRankingOpenSender({ ...base, tab: { url: 'https://example.com/#/ranking' } }, 'ext'),
    ).toBe(false)
  })
})
