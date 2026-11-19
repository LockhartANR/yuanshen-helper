import { afterEach, describe, expect, it, vi } from 'vitest'
import { openRankingTab, rankingPageUrl } from '../src/shared/ui'

describe('扩展页排行榜入口', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('通过扩展 URL 打开 ranking.html，不硬编码扩展 ID', async () => {
    const create = vi.fn(async () => ({ id: 1 }))
    vi.stubGlobal('chrome', {
      runtime: { getURL: (path: string) => `chrome-extension://abc/${path}` },
      tabs: { create },
    })
    expect(rankingPageUrl()).toBe('chrome-extension://abc/ranking.html')
    await openRankingTab()
    expect(create).toHaveBeenCalledWith({ url: 'chrome-extension://abc/ranking.html' })
  })
})
