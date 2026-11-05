import { describe, expect, it, vi } from 'vitest'
import { analyzeGames, applyBvFloors, monthStats, todayStats } from '../src/features/player-stats/analysis'
import { createAnalysisController } from '../src/features/player-stats/analysis-controller'
import { createAnalysisDataProvider } from '../src/features/player-stats/analysis-data'
import { inDateRange, resolveRange } from '../src/features/player-stats/analysis-range'
import { DEFAULT_ANALYSIS_SETTINGS } from '../src/features/player-stats/analysis-settings'
import type { AnalysisSettings } from '../src/features/player-stats/analysis-settings'
import { ratingSnapshot } from '../src/features/player-stats/ratings'
import type { Video } from '../src/features/player-stats/model'
import type { DatasetSnapshot } from '../src/features/player-stats/model'

const DAY = 86_400_000
const NOW = new Date(2026, 10, 3, 12).getTime()

let nextId = 1

function video(overrides: Partial<Video> = {}): Video {
  const id = overrides.id ?? nextId++
  return {
    id,
    upload_time: new Date(NOW).toISOString(),
    state: 'c',
    ongoing_tournament: false,
    software: 'e',
    level: 'b',
    mode: '00',
    end_time: new Date(NOW).toISOString(),
    timems: 12_000,
    bv: 20,
    left: 20,
    right: 2,
    double: 0,
    left_ce: 18,
    right_ce: 2,
    double_ce: 0,
    path: 800,
    op: 3,
    isl: 4,
    ...overrides,
  }
}

function makeSettings(): AnalysisSettings {
  return JSON.parse(JSON.stringify(DEFAULT_ANALYSIS_SETTINGS)) as AnalysisSettings
}

function dataset(videos: Video[], contentVersion = 1): DatasetSnapshot {
  return { source: 'site', identity: 'player-16', contentVersion, videos }
}

const ALL = resolveRange('all', { start: '', end: '' }, NOW)

function sampleVideos(): Video[] {
  return [
    video({ id: 1, level: 'b', bv: 5, timems: 20_000 }),
    video({ id: 2, level: 'b', bv: 20, timems: 12_000 }),
    video({ id: 3, level: 'e', bv: 150, timems: 60_000 }),
  ]
}

function dataInput(settings = makeSettings(), videos = sampleVideos()) {
  return {
    dataset: dataset(videos),
    filters: { software: 'all', nfOnly: false },
    settings,
    bounds: ALL,
    dataNow: NOW,
  }
}

function harness(options: Parameters<typeof createAnalysisController>[0] = {}) {
  let now = NOW
  const saveSettings = vi.fn()
  const controller = createAnalysisController({
    autoSiteAnchors: false,
    clock: () => now,
    loadSettings: makeSettings,
    saveSettings,
    ...options,
  })
  return { controller, saveSettings, setNow: (value: number) => (now = value) }
}

describe('统计派生与缓存', () => {
  it('相同输入复用统计与历史对象', () => {
    const provider = createAnalysisDataProvider()
    const first = provider.get(dataInput())
    const second = provider.get(dataInput())
    expect(second.games).toBe(first.games)
    expect(second.rangeGames).toBe(first.rangeGames)
    expect(second.ratingGames).toBe(first.ratingGames)
    expect(second.history).toBe(first.history)
    expect(second.today).toBe(first.today)
  })

  it('筛选变化只重建普通数据集，不重建梁山分历史', () => {
    const provider = createAnalysisDataProvider()
    const first = provider.get(dataInput())
    const filtered = provider.get({
      ...dataInput(),
      filters: { software: 'all', nfOnly: true },
    })
    expect(filtered.history).toBe(first.history)
    // 样本全部是 FL，只看 NF 后普通数据集为空。
    expect(filtered.games).toHaveLength(0)
  })

  it('日期变化只重建时段数据集，锚点与 3BV 下限变化才重建历史', () => {
    const provider = createAnalysisDataProvider()
    const first = provider.get(dataInput())

    const anchors = makeSettings()
    anchors.anchors = { ...anchors.anchors, 'std:bt': 3 }
    const anchorChange = provider.get({ ...dataInput(anchors), bounds: ALL })
    expect(anchorChange.history).not.toBe(first.history)
    expect(anchorChange.games).toBe(first.games)

    const todayBounds = resolveRange('today', { start: '', end: '' }, NOW + DAY)
    const shifted = provider.get({ ...dataInput(anchors), bounds: todayBounds })
    expect(shifted.history).toBe(anchorChange.history)
    expect(shifted.games).not.toBe(first.games)

    const floors = makeSettings()
    floors.bvFloors.b = 30
    const floorChange = provider.get({ ...dataInput(floors), bounds: todayBounds })
    expect(floorChange.history).not.toBe(anchorChange.history)
    expect(floorChange.games).not.toBe(shifted.games)
  })

  it('数据内容版本变化重建全部统计', () => {
    const provider = createAnalysisDataProvider()
    const first = provider.get(dataInput())
    const changed = provider.get({
      ...dataInput(),
      dataset: dataset([...sampleVideos(), video({ id: 9 })], 2),
    })
    expect(changed.history).not.toBe(first.history)
    expect(changed.games).not.toBe(first.games)
  })

  it('各数据集保留独立口径，PB、今日、月年、评分与既有链路一致', () => {
    const provider = createAnalysisDataProvider()
    const settings = makeSettings()
    const videos = sampleVideos()
    const data = provider.get(dataInput(settings, videos))

    // 普通统计套用 3BV 下限；月年保留 2–9；评分与今日使用基础有效记录。
    expect(data.games.map((game) => game.video.id)).toEqual([2, 3])
    expect(data.rangeGames.map((game) => game.video.id)).toEqual([1, 2, 3])
    expect(data.ratingGames.map((game) => game.video.id)).toEqual([1, 2, 3])
    expect(data.history.includedCount).toBe(2)
    expect(data.history.excludedCount).toBe(1)
    const today = Object.fromEntries(data.today.map((row) => [row.level, row]))
    expect(today.b?.count).toBe(2)
    expect(today.e?.count).toBe(1)

    const filtered = analyzeGames(videos, { software: 'all', nfOnly: false }, 1)
    const expectedGames = applyBvFloors(filtered, settings.bvFloors).filter((game) =>
      inDateRange(game.date, ALL),
    )
    const expectedRangeGames = filtered.filter((game) => game.bv >= 2 && inDateRange(game.date, ALL))
    const expectedRating = analyzeGames(videos, {}, 1)

    // PB 标记在 analyzeGames 阶段写入，等价比较同时覆盖 pb / pbPrev。
    expect(data.games).toEqual(expectedGames)
    expect(data.rangeGames).toEqual(expectedRangeGames)
    expect(data.ratingGames).toEqual(expectedRating)
    expect(data.today).toEqual(todayStats(expectedRating, NOW))

    const months = monthStats(data.games, 'e', data.rangeGames)
    const again = monthStats(expectedGames, 'e', expectedRangeGames)
    expect(months).toEqual(again)

    const rating = ratingSnapshot(
      data.ratingGames,
      settings.anchors,
      settings.softWeights,
      settings.levelWeights,
      settings.bvFloors,
    )
    const expectedRatingSnapshot = ratingSnapshot(
      expectedRating,
      settings.anchors,
      settings.softWeights,
      settings.levelWeights,
      settings.bvFloors,
    )
    expect(rating).toEqual(expectedRatingSnapshot)
    expect(data.history.snapshot).toEqual(rating)
  })
})

describe('大表控制器：日期与页签', () => {
  it('自定义日期先编辑、校验失败保留草稿、成功后应用', () => {
    const view = harness()
    const { controller } = view
    controller.setDataset(dataset([video({ id: 1 })]))
    controller.beginRangeEdit('lsf')
    let snapshot = controller.getSnapshot()
    expect(snapshot.rangeEditor?.owner).toBe('lsf')
    expect(snapshot.rangeControl.panel).toBe('lsf')
    expect(snapshot.rangeControl.uiKey).toBe('custom')

    controller.setRangeDraft({ start: '2026-11-03', end: '2026-11-01' })
    const invalid = controller.applyRange()
    expect(invalid.ok).toBe(false)
    expect(invalid.message).toContain('开始日期不能晚于结束日期')
    snapshot = controller.getSnapshot()
    expect(snapshot.range.key).toBe('all')
    expect(snapshot.rangeEditor?.error).toContain('开始日期不能晚于结束日期')
    expect(snapshot.rangeEditor?.draft).toEqual({ start: '2026-11-03', end: '2026-11-01' })

    controller.setRangeDraft({ start: '2026-11-01', end: '2026-11-02' })
    const applied = controller.applyRange()
    expect(applied.ok).toBe(true)
    snapshot = controller.getSnapshot()
    expect(snapshot.range).toEqual({ key: 'custom', custom: { start: '2026-11-01', end: '2026-11-02' } })
    expect(snapshot.rangeEditor).toBeNull()
    expect(snapshot.rangeControl.editable).toBe(true)
    expect(snapshot.bounds.start).toBe(new Date(2026, 10, 1).getTime())
  })

  it('取消编辑、切换页签与快捷时段符合现有规则', () => {
    const { controller } = harness()
    controller.selectTab('lsf')
    controller.beginRangeEdit('lsf')
    expect(controller.getSnapshot().rangeEditor?.owner).toBe('lsf')
    controller.selectTab('rank')
    expect(controller.getSnapshot().rangeEditor).toBeNull()

    controller.beginRangeEdit('global')
    controller.cancelRangeEdit()
    expect(controller.getSnapshot().rangeEditor).toBeNull()

    controller.selectRangeKey('today', 'global')
    const snapshot = controller.getSnapshot()
    expect(snapshot.range.key).toBe('today')
    expect(snapshot.bounds.key).toBe('today')
    expect(snapshot.tab.nav).toBe('rank')
  })

  it('连续编辑两端日期后切页与锚点异步返回仍保留完整草稿', async () => {
    let resolveLoad: (value: { anchors: Record<string, number>; stale: boolean; fetchedAt: number }) => void = () => {}
    const loadSiteAnchors = vi.fn(
      () =>
        new Promise<{ anchors: Record<string, number>; stale: boolean; fetchedAt: number }>((resolve) => {
          resolveLoad = resolve
        }),
    )
    const { controller } = harness({ loadSiteAnchors })
    controller.beginRangeEdit('global')
    const initialEnd = controller.getSnapshot().rangeEditor!.draft.end
    controller.setRangeDraft({ start: '2026-11-01' })
    expect(controller.getSnapshot().rangeEditor?.draft).toEqual({
      start: '2026-11-01',
      end: initialEnd,
    })
    controller.setRangeDraft({ end: '2026-11-02' })

    controller.selectTab('rank')
    expect(controller.getSnapshot().rangeEditor?.draft).toEqual({
      start: '2026-11-01',
      end: '2026-11-02',
    })

    const pending = controller.refreshSiteAnchors(true)
    resolveLoad({ anchors: { 'std:bt': 3 }, stale: false, fetchedAt: NOW })
    expect(await pending).toBe(true)
    const afterAnchor = controller.getSnapshot()
    expect(afterAnchor.rangeEditor?.draft).toEqual({ start: '2026-11-01', end: '2026-11-02' })
    expect(afterAnchor.tab.nav).toBe('rank')
  })

  it('跨午夜后时段边界按新时钟解析', () => {
    const view = harness()
    view.controller.selectRangeKey('today', 'global')
    const before = view.controller.getSnapshot()
    expect(before.bounds.start).toBe(new Date(2026, 10, 3).getTime())
    view.setNow(NOW + DAY)
    const after = view.controller.getSnapshot()
    expect(after.bounds.start).toBe(new Date(2026, 10, 4).getTime())
  })

  it('替换数据快照会清理旧定位与草稿，但保留已应用时段和页签', () => {
    const view = harness()
    const { controller } = view
    controller.setDataset(dataset([video({ id: 1 })]))
    controller.selectTab('lsf')
    controller.selectRangeKey('last30', 'global')
    controller.beginRangeEdit('lsf')
    controller.toggleLsfDetail('event-1')
    controller.showMoreLsfEvents()

    let snapshot = controller.getSnapshot()
    expect(snapshot.tab.lsfExpanded.has('event-1')).toBe(true)
    expect(snapshot.tab.lsfLimit).toBe(200)
    expect(snapshot.rangeEditor).not.toBeNull()

    controller.setDataset(dataset([video({ id: 2 })], 2))
    snapshot = controller.getSnapshot()
    expect(snapshot.tab.lsfExpanded.size).toBe(0)
    expect(snapshot.tab.lsfLimit).toBe(100)
    expect(snapshot.tab.lsfFocus).toBe('')
    expect(snapshot.rangeEditor).toBeNull()
    expect(snapshot.range.key).toBe('last30')
    expect(snapshot.tab.nav).toBe('lsf')
  })

  it('页签动作更新展示状态，周期模式或难度切换会清空已选周期', () => {
    const { controller } = harness()
    controller.updateTab({ periodMode: 'month', periodKey: '2026-10' })
    expect(controller.getSnapshot().tab.periodKey).toBe('2026-10')
    controller.updateTab({ periodMode: 'year' })
    expect(controller.getSnapshot().tab.periodMode).toBe('year')
    expect(controller.getSnapshot().tab.periodKey).toBe('')

    controller.updateTab({ periodKey: '2026' })
    controller.updateTab({ periodLevel: 'b' })
    expect(controller.getSnapshot().tab.periodKey).toBe('')
    controller.updateTab({ hideEmptyMonths: true, rankStat: 'bvs', rankLayout: 'triple' })
    const tab = controller.getSnapshot().tab
    expect(tab.hideEmptyMonths).toBe(true)
    expect(tab.rankStat).toBe('bvs')
    expect(tab.rankLayout).toBe('triple')
  })
})

describe('大表控制器：设置、锚点与缓存', () => {
  it('设置 patch 按参数面板规则规范化并保存', () => {
    const { controller, saveSettings } = harness()
    controller.setDataset(dataset([video({ id: 1 })]))
    controller.updateSettings({ rankLimit: 999, monthTop: 0, bvFloors: { b: 0 } })
    let settings = controller.getSettings()
    expect(settings.rankLimit).toBe(200)
    expect(settings.monthTop).toBe(1)
    // 评分字段越界时保留原值，与参数面板一致。
    expect(settings.bvFloors.b).toBe(10)
    expect(saveSettings).toHaveBeenCalledTimes(1)

    controller.updateSettings({
      bvFloors: { b: 30 },
      softWeights: { b: { t: 50 } },
      colorThresholds: [1, 2, 3],
    })
    settings = controller.getSettings()
    expect(settings.bvFloors.b).toBe(30)
    expect(settings.softWeights.b.t).toBe(50)
    // 色板长度不符时不写入。
    expect(settings.colorThresholds).toEqual(DEFAULT_ANALYSIS_SETTINGS.colorThresholds)
    expect(saveSettings).toHaveBeenCalledTimes(2)
  })

  it('设置与锚点变化发布新快照并重建历史，展开与切页不重建', () => {
    const { controller } = harness()
    controller.setDataset(dataset([video({ id: 1 })]))
    const first = controller.getSnapshot().data.history

    controller.updateTab({ hideEmptyMonths: true })
    expect(controller.getSnapshot().data.history).toBe(first)
    controller.toggleLsfDetail('x')
    expect(controller.getSnapshot().data.history).toBe(first)

    controller.updateSettings({ anchors: { 'std:bt': 3 } })
    expect(controller.getSnapshot().data.history).not.toBe(first)
    expect(controller.getSnapshot().anchors.error).toBe(false)
    expect(controller.getSnapshot().anchors.revision).toBe(1)
  })

  it('锚点改动只提升锚点修订，设置改动才提升设置修订', () => {
    const { controller } = harness()
    const before = controller.getSnapshot()
    controller.updateSettings({ anchors: { 'std:bt': 3 } })
    const anchorOnly = controller.getSnapshot()
    expect(anchorOnly.settingsRevision).toBe(before.settingsRevision)
    expect(anchorOnly.anchors.revision).toBe(before.anchors.revision + 1)

    controller.updateSettings({ rankLimit: 60 })
    const settingOnly = controller.getSnapshot()
    expect(settingOnly.settingsRevision).toBe(anchorOnly.settingsRevision + 1)
    expect(settingOnly.anchors.revision).toBe(anchorOnly.anchors.revision)
  })

  it('使用大表锚点与恢复默认会重置状态并保存', () => {
    const { controller, saveSettings } = harness()
    controller.updateSettings({ anchors: { 'std:bt': 9 }, anchorMode: 'workbook' })
    controller.useWorkbookAnchors()
    let snapshot = controller.getSnapshot()
    expect(snapshot.settings.anchors).toEqual(DEFAULT_ANALYSIS_SETTINGS.anchors)
    expect(snapshot.settings.anchorMode).toBe('workbook')
    expect(snapshot.anchors.status).toBe('已使用大表锚点')

    controller.updateSettings({ rankLimit: 100 })
    controller.resetSettings()
    snapshot = controller.getSnapshot()
    expect(snapshot.settings.rankLimit).toBe(DEFAULT_ANALYSIS_SETTINGS.rankLimit)
    expect(snapshot.anchors.status).toBe('已使用大表锚点')
    expect(saveSettings).toHaveBeenCalled()
  })

  it('网站锚点成功、失败与销毁后的晚到结果', async () => {
    let resolveLoad: (value: { anchors: Record<string, number>; stale: boolean; fetchedAt: number }) => void = () => {}
    const loadSiteAnchors = vi.fn(
      () =>
        new Promise<{ anchors: Record<string, number>; stale: boolean; fetchedAt: number }>((resolve) => {
          resolveLoad = resolve
        }),
    )
    const { controller } = harness({ loadSiteAnchors })

    const pending = controller.refreshSiteAnchors(true)
    expect(loadSiteAnchors).toHaveBeenCalledWith(true)
    resolveLoad({ anchors: { 'std:bt': 8.5 }, stale: false, fetchedAt: NOW })
    expect(await pending).toBe(true)
    let snapshot = controller.getSnapshot()
    expect(snapshot.settings.anchors['std:bt']).toBe(8.5)
    expect(snapshot.settings.anchorMode).toBe('site')
    expect(snapshot.anchors.status).toBe('已读取网站锚点')

    const stale = controller.refreshSiteAnchors(true)
    resolveLoad({ anchors: { 'std:bt': 7 }, stale: true, fetchedAt: NOW - 2 * 60 * 60 * 1000 })
    expect(await stale).toBe(true)
    snapshot = controller.getSnapshot()
    expect(snapshot.settings.anchors['std:bt']).toBe(7)
    expect(snapshot.anchors.error).toBe(true)
    expect(snapshot.anchors.status).toContain('沿用 2 小时前的网站锚点')
  })

  it('销毁后晚到的锚点结果不写回设置', async () => {
    let resolveLoad: (value: { anchors: Record<string, number>; stale: boolean; fetchedAt: number }) => void = () => {}
    const loadSiteAnchors = vi.fn(
      () =>
        new Promise<{ anchors: Record<string, number>; stale: boolean; fetchedAt: number }>((resolve) => {
          resolveLoad = resolve
        }),
    )
    const { controller, saveSettings } = harness({ loadSiteAnchors })
    const pending = controller.refreshSiteAnchors(true)
    controller.destroy()
    resolveLoad({ anchors: { 'std:bt': 3 }, stale: false, fetchedAt: NOW })
    expect(await pending).toBe(false)
    expect(saveSettings).not.toHaveBeenCalled()
    expect(controller.getSettings().anchors['std:bt']).not.toBe(3)
  })

  it('手动改锚点会让进行中的网站锚点请求失效', async () => {
    let resolveLoad: (value: { anchors: Record<string, number>; stale: boolean; fetchedAt: number }) => void = () => {}
    const loadSiteAnchors = vi.fn(
      () =>
        new Promise<{ anchors: Record<string, number>; stale: boolean; fetchedAt: number }>((resolve) => {
          resolveLoad = resolve
        }),
    )
    const { controller } = harness({ loadSiteAnchors })
    const pending = controller.refreshSiteAnchors(true)
    controller.updateSettings({ anchors: { 'std:bt': 6 }, anchorMode: 'workbook' })
    resolveLoad({ anchors: { 'std:bt': 2 }, stale: false, fetchedAt: NOW })
    expect(await pending).toBe(false)
    expect(controller.getSettings().anchors['std:bt']).toBe(6)
    expect(controller.getSettings().anchorMode).toBe('workbook')
  })

  it('独立 CSV 启动不自动请求网站锚点；网站模式按保存的锚点来源自动读取', () => {
    const loadSiteAnchors = vi.fn(async () => ({
      anchors: { 'std:bt': 8 },
      stale: false,
      fetchedAt: NOW,
    }))
    createAnalysisController({
      autoSiteAnchors: false,
      loadSettings: () => {
        const settings = makeSettings()
        settings.anchorMode = 'site'
        return settings
      },
      loadSiteAnchors,
    })
    expect(loadSiteAnchors).not.toHaveBeenCalled()

    createAnalysisController({
      autoSiteAnchors: true,
      loadSettings: () => {
        const settings = makeSettings()
        settings.anchorMode = 'site'
        return settings
      },
      loadSiteAnchors,
    })
    expect(loadSiteAnchors).toHaveBeenCalledTimes(1)
  })
})
