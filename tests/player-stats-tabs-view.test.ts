import { afterEach, describe, expect, it, vi } from 'vitest'
import { todayCopyText } from '../src/features/player-stats/analysis'
import { createAnalysisController } from '../src/features/player-stats/analysis-controller'
import { tabDataFor, withTrendCopyFields } from '../src/features/player-stats/analysis-tab-data'
import { DEFAULT_ANALYSIS_SETTINGS } from '../src/features/player-stats/analysis-settings'
import type { AnalysisSettings } from '../src/features/player-stats/analysis-settings'
import type { AnalysisSnapshot } from '../src/features/player-stats/analysis-state'
import type { Video } from '../src/features/player-stats/model'
import {
  monthCopyText,
  weekCopyText,
  yearCopyText,
} from '../src/features/player-stats/trend-copy'
import { renderDistTab } from '../src/features/player-stats/ui/tabs/dist'
import { renderEffTab } from '../src/features/player-stats/ui/tabs/eff'
import { renderLsfTab } from '../src/features/player-stats/ui/tabs/lsf'
import { renderMapTab } from '../src/features/player-stats/ui/tabs/map'
import { renderOverviewTab } from '../src/features/player-stats/ui/tabs/overview'
import { renderPeriodTab } from '../src/features/player-stats/ui/tabs/period'
import { renderRankTab } from '../src/features/player-stats/ui/tabs/rank'
import { renderTrendTab } from '../src/features/player-stats/ui/tabs/trend'

const NOW = new Date(2026, 10, 3, 12).getTime()

function makeSettings(): AnalysisSettings {
  return JSON.parse(JSON.stringify(DEFAULT_ANALYSIS_SETTINGS)) as AnalysisSettings
}

function video(overrides: Partial<Video> = {}): Video {
  return {
    id: 1,
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

function sampleVideos(): Video[] {
  const day = (offset: number): string => {
    const date = new Date(2026, 10, 3 + offset, 8)
    return date.toISOString()
  }
  return [
    video({ id: 1, level: 'b', bv: 20, timems: 12_000, end_time: day(0) }),
    video({ id: 2, level: 'b', bv: 24, timems: 14_000, end_time: day(0) }),
    video({ id: 3, level: 'i', bv: 60, timems: 40_000, end_time: day(0) }),
    video({ id: 4, level: 'i', bv: 64, timems: 38_000, end_time: day(-1) }),
    video({ id: 5, level: 'e', bv: 150, timems: 60_000, end_time: day(-1) }),
    video({ id: 6, level: 'e', bv: 160, timems: 55_000, end_time: day(-8) }),
    video({ id: 7, level: 'e', bv: 170, timems: 52_000, end_time: day(-40) }),
  ]
}

function snapshotFor(tab: AnalysisSnapshot['tab']['nav']): AnalysisSnapshot {
  const controller = createAnalysisController({
    autoSiteAnchors: false,
    clock: () => NOW,
    loadSettings: makeSettings,
    saveSettings: () => {},
  })
  controller.setDataset({ source: 'site', identity: 'player-16', contentVersion: 1, videos: sampleVideos() })
  controller.selectTab(tab)
  const snapshot = controller.getSnapshot()
  controller.destroy()
  return snapshot
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('页签展示数据与渲染', () => {
  it('八个页签由快照生成并渲染，不读取存储或发起网络请求', () => {
    const getItem = vi.fn()
    const setItem = vi.fn()
    const fetchSpy = vi.fn()
    vi.stubGlobal('localStorage', { getItem, setItem })
    vi.stubGlobal('fetch', fetchSpy)
    const overview = tabDataFor(snapshotFor('overview'))
    expect(overview.kind).toBe('overview')
    if (overview.kind === 'overview') {
      expect(renderOverviewTab(overview)).toContain('GC 指标')
      expect(renderOverviewTab(overview)).toContain('今日成绩')
    }

    const trend = tabDataFor(snapshotFor('trend'))
    expect(trend.kind).toBe('trend')
    if (trend.kind === 'trend') {
      const html = renderTrendTab(trend)
      expect(html).toContain('周 T37')
      expect(html).toContain('月均明细')
      expect(html).toContain('年汇总')
      expect(html).toContain('data-copy-kind="week"')
    }

    const lsf = tabDataFor(snapshotFor('lsf'))
    expect(lsf.kind).toBe('lsf')
    if (lsf.kind === 'lsf') {
      const html = renderLsfTab(lsf)
      expect(html).toContain('时段统计')
      expect(html).toContain('历史阶梯图')
      expect(html).toContain('变动流水')
    }

    const rank = tabDataFor(snapshotFor('rank'))
    expect(rank.kind).toBe('rank')
    if (rank.kind === 'rank') {
      expect(renderRankTab(rank)).toContain('名次')
    }

    const period = tabDataFor(snapshotFor('period'))
    expect(period.kind).toBe('period')
    if (period.kind === 'period') {
      const html = renderPeriodTab(period)
      expect(html).toContain('月 Top')
      expect(html).toContain('id="period-select"')
    }

    const dist = tabDataFor(snapshotFor('dist'))
    expect(dist.kind).toBe('dist')
    if (dist.kind === 'dist') {
      const html = renderDistTab(dist)
      expect(html).toContain('3BV 分档')
      expect(html).toContain('Sub 率')
      expect(html).toContain('3BV 区间')
    }

    const eff = tabDataFor(snapshotFor('eff'))
    expect(eff.kind).toBe('eff')
    if (eff.kind === 'eff') {
      const html = renderEffTab(eff)
      expect(html).toContain('点击 / 秒')
      expect(html).toContain('杂项 7 项')
    }

    const map = tabDataFor(snapshotFor('map'))
    expect(map.kind).toBe('map')
    if (map.kind === 'map') {
      const html = renderMapTab(map)
      expect(html).toContain('狗图')
      expect(html).toContain('class="map-svg"')
      expect(html).toContain('狗预测')
    }
    expect(getItem).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('今日与周 / 月 / 年复制文本来自展示快照，与直接格式化结果一致', () => {
    const overview = tabDataFor(snapshotFor('overview'))
    expect(overview.kind).toBe('overview')
    if (overview.kind === 'overview') {
      for (const row of overview.today) {
        expect(overview.todayCopies.get(row.level)).toBe(todayCopyText(row))
      }
    }

    const trendSnapshot = snapshotFor('trend')
    const trend = tabDataFor(trendSnapshot)
    expect(trend.kind).toBe('trend')
    if (trend.kind === 'trend') {
      for (const entry of trend.weeks) {
        expect(trend.weekCopies.get(entry.week.start)).toBe(
          weekCopyText(entry.week, {
            delta: entry.delta,
            software: 'all',
            nfOnly: false,
            range: trendSnapshot.bounds,
          }),
        )
      }
      for (const month of trend.months) {
        if (month.count === 0) continue
        expect(trend.monthCopies.get(month.key)).toBe(
          monthCopyText(month, trend.monthLevel, trend.monthCopyFields),
        )
      }
      for (const level of ['b', 'i', 'e'] as const) {
        for (const year of trend.years[level]) {
          if (year.count === 0) continue
          expect(trend.yearCopies[level].get(String(year.year))).toBe(
            yearCopyText(year, level, trend.yearCopyFields),
          )
        }
      }
    }
  })

  it('修改复制字段只重算复制文本，保留已展示的表格统计', () => {
    const snapshot = snapshotFor('trend')
    const data = tabDataFor(snapshot)
    expect(data.kind).toBe('trend')
    if (data.kind !== 'trend') return

    const settings = makeSettings()
    settings.monthCopyFields = ['medianTime']
    settings.yearCopyFields = ['cls']
    const next = withTrendCopyFields(data, settings)

    // 周、月、年统计对象与周复制文本都来自当前展示，不重新聚合。
    expect(next.months).toBe(data.months)
    expect(next.years).toBe(data.years)
    expect(next.weeks).toBe(data.weeks)
    expect(next.weekCopies).toBe(data.weekCopies)
    expect(next.monthCopyFields).toEqual(['medianTime'])
    expect(next.yearCopyFields).toEqual(['cls'])

    const month = data.months.find((row) => row.count > 0)!
    expect(next.monthCopies.get(month.key)).toBe(
      monthCopyText(month, data.monthLevel, settings.monthCopyFields),
    )
    const year = data.years[data.monthLevel].find((row) => row.count > 0)!
    expect(next.yearCopies[data.monthLevel].get(String(year.year))).toBe(
      yearCopyText(year, data.monthLevel, settings.yearCopyFields),
    )
    expect(next.monthPreview.text).toBe(
      monthCopyText(month, data.monthLevel, settings.monthCopyFields),
    )
  })
})
