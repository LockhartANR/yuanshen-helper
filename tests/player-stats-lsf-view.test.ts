import { describe, expect, it } from 'vitest'
import {
  lsfChartHtml,
  lsfDetailHtml,
  lsfLedgerHtml,
  lsfNoticeHtml,
  lsfStatsHtml,
} from '../src/features/player-stats/ui/lsf-view'
import { rangePanelHtml, rangeSelectHtml } from '../src/features/player-stats/ui/range-control'
import type { RangeControlState } from '../src/features/player-stats/analysis-state'
import { ratingOverviewHtml } from '../src/features/player-stats/ui/rating-view'
import { RANGE_OPTIONS, formatDateInput, resolveRange, startOfLocalDay } from '../src/features/player-stats/analysis-range'
import { analyzeGames } from '../src/features/player-stats/analysis'
import { buildLsfHistory, lsfRange } from '../src/features/player-stats/lsf-history'
import type { LsfEvent, LsfHistory, LsfRange } from '../src/features/player-stats/lsf-history'
import type { LsfAnchors } from '../src/features/player-stats/ratings'
import { WORKBOOK_ANCHORS } from '../src/features/player-stats/ratings'
import type { Video } from '../src/features/player-stats/model'

const DAY = 86_400_000
const BASE = Date.parse('2025-01-01T00:00:00.000Z')
const NOW = Date.parse('2026-06-01T00:00:00.000Z')
const ALL_BOUNDS = resolveRange('all', { start: '', end: '' }, NOW)
const ALL_CONTROLS: RangeControlState = {
  uiKey: 'all',
  panel: null,
  draft: { start: '', end: '' },
  error: '',
  now: NOW,
}

function allRange(history: LsfHistory): LsfRange {
  return lsfRange(history, { start: null, endExclusive: null, now: NOW })
}

function lastDayRange(history: LsfHistory): LsfRange {
  return lsfRange(history, { start: NOW - DAY, endExclusive: null, now: NOW })
}

function iso(day: number): string {
  return new Date(BASE + day * DAY).toISOString()
}

let nextId = 1

function video(overrides: Partial<Video> = {}): Video {
  const id = overrides.id ?? nextId++
  return {
    id,
    upload_time: iso(0),
    state: 'c',
    ongoing_tournament: false,
    software: 'e',
    level: 'b',
    mode: '00',
    end_time: iso(0),
    timems: 12000,
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

function sample() {
  const videos: Video[] = [
    video({ id: 2, level: 'b', bv: 20, timems: 14000, end_time: iso(1) }),
    video({ id: 1, level: 'b', bv: 20, timems: 12000, end_time: iso(0) }),
    video({ id: 3, level: 'b', bv: 20, timems: 11000, end_time: iso(2), right: 0, right_ce: 0 }),
    video({ id: 4, level: 'i', bv: 60, timems: 40000, end_time: iso(3) }),
  ]
  const games = analyzeGames(videos, {}, 1)
  const anchors: LsfAnchors = WORKBOOK_ANCHORS
  const history = buildLsfHistory(games, { anchors, now: NOW })
  return { games, history }
}

describe('定阶总览表', () => {
  it('表头与行列固定，综合合计行在三个级别之后', () => {
    const { history } = sample()
    const html = ratingOverviewHtml(history.snapshot, {
      anchorMode: 'workbook',
      anchorError: false,
    })
    expect(html).toContain(
      '<th>级别</th><th class="num">软实力</th><th class="num">NF软实力</th>' +
        '<th class="num">LSF</th><th>定阶</th><th>NF定阶</th>',
    )
    // 表头一行 + 初级 / 中级 / 高级 / 综合四行。
    expect((html.match(/<tr/g) ?? []).length).toBe(5)
    expect((html.match(/<th scope="row">/g) ?? []).length).toBe(4)
    expect(html.indexOf('<th scope="row">初级</th>')).toBeLessThan(
      html.indexOf('<th scope="row">中级</th>'),
    )
    expect(html.indexOf('<th scope="row">中级</th>')).toBeLessThan(
      html.indexOf('<th scope="row">高级</th>'),
    )
    expect(html.indexOf('<th scope="row">高级</th>')).toBeLessThan(
      html.indexOf('<th scope="row">综合</th>'),
    )
    expect(html).toContain('<tr class="total"><th scope="row">综合</th>')
    expect(html).toContain(`<td class="num">${history.snapshot.lsf.toFixed(2)}</td>`)
    for (const level of history.snapshot.levels) {
      expect(html).toContain(`<td class="num">${level.lsf.toFixed(2)}</td>`)
      expect(html).toContain(`<b>${level.title}</b>`)
      expect(html).toContain(`<b>${level.nfTitle}</b>`)
    }
    expect(html).toContain('大表锚点')
    // 总览底部不再有常驻说明段（锚点来源仍在标题里）。
    expect(html).not.toContain('lsf-tip')
    expect(html).toMatch(/NF软实力/)
    expect(html).not.toMatch(/NF LSF|全部软实力|普通定阶|全部定阶/)
  })

  it('锚点来源与读取失败提示由调用方传入', () => {
    const { history } = sample()
    const html = ratingOverviewHtml(history.snapshot, {
      anchorMode: 'site',
      anchorError: true,
    })
    expect(html).toContain('网站锚点')
    expect(html).toContain('锚点刷新失败')
  })

  it('零数据时显示新手而不是占位符', () => {
    const empty = buildLsfHistory([], { anchors: WORKBOOK_ANCHORS, now: NOW })
    const html = ratingOverviewHtml(empty.snapshot, {
      anchorMode: 'workbook',
      anchorError: false,
    })
    expect(html).toContain('<b>新手</b>')
    expect(html).toContain('<td class="num">0.00</td>')
    expect(html).toContain('<td class="num">0.0</td>')
  })
})

describe('时段统计', () => {
  it('五张卡片、十二个时段选项与空区间占位', () => {
    const { history } = sample()
    const range = lastDayRange(history)
    const bounds = resolveRange('yesterday', { start: '', end: '' }, NOW)
    const html = lsfStatsHtml(range, bounds, ALL_CONTROLS)
    expect(html).toContain('时段统计')
    for (const label of ['时段涨分', '涨分次数', '单局最大涨分', '单日最大涨分', '时段末 LSF']) {
      expect(html).toContain(label)
    }
    expect(html).toContain('<b>0</b>')
    expect(html).toContain('该时段没有涨分')
    expect(html).toContain('该时段没有正向日增量')
    expect(html).toContain('区间末 LSF − 区间起点 LSF')
    expect(html).not.toContain('含扣分')
    expect(html).not.toContain('时段只作用于时段统计、阶梯图与流水')
    expect(html).not.toContain('「时段涨分」通常小于总 LSF')
    expect(html).not.toContain('lsf-tip')
    expect(html).not.toContain('没有任何数据')

    // 时段切换就在这张卡上，和顶部筛选条共用十二个选项。
    expect(html).toContain('data-range-select="lsf"')
    expect(html).toContain('<option value="all" selected>全部</option>')
    for (const option of RANGE_OPTIONS) {
      expect(html).toContain(`<option value="${option.key}"`)
    }
    expect(html).toContain('昨天')
    // 「截至」用包含当天的结束日期，不显示次日零点。
    expect(html).toContain('截至 26/5/31')
    expect(html).not.toContain('data-range-panel')
  })

  it('选择自定义时显示起止日期面板与校验错误', () => {
    const { history } = sample()
    const html = lsfStatsHtml(lastDayRange(history), ALL_BOUNDS, {
      ...ALL_CONTROLS,
      uiKey: 'custom',
      panel: 'lsf',
      draft: { start: '2026-05-30', end: '2026-05-20' },
      error: '开始日期不能晚于结束日期',
    })
    expect(html).toContain('data-range-panel="lsf"')
    expect(html).toContain('开始日期')
    expect(html).toContain('结束日期')
    expect(html).toContain('data-range-date="start"')
    expect(html).toContain('data-range-date="end"')
    expect(html).toContain('data-range-apply')
    expect(html).toContain('data-range-cancel')
    expect(html).toContain('role="alert"')
    expect(html).toContain('开始日期不能晚于结束日期')
    expect(html).toContain(`max="${formatDateInput(NOW)}"`)
  })

  it('全部范围显示时段末 LSF 与起点，避免和当前快照混淆', () => {
    const { history } = sample()
    const range = allRange(history)
    const html = lsfStatsHtml(range, ALL_BOUNDS, ALL_CONTROLS)
    expect(html).toContain('时段末 LSF')
    expect(html).toContain(range.latest.toFixed(2))
    expect(html).toContain(`起点 ${range.baseline.toFixed(2)}`)
    expect(html).toContain('全部有效记录')
    expect(html).toContain(`<b>${range.upCount}</b>`)
  })

  it('单局 / 单日最大涨分是原生按钮，无目标时退回静态 —', () => {
    const { history } = sample()
    const range = allRange(history)
    const html = lsfStatsHtml(range, ALL_BOUNDS, ALL_CONTROLS)
    expect(range.maxGainEventId).not.toBeNull()
    expect(range.maxDayEventId).not.toBeNull()
    expect(html).toContain(`data-lsf-event="${range.maxGainEventId}"`)
    expect(html).toContain(`data-lsf-day="${range.maxDayDate}"`)
    expect(html).toContain('<button type="button" class="lsf-stat-value delta-up"')
    expect(html).toContain('点击定位')

    const empty = lsfStatsHtml(lastDayRange(history), ALL_BOUNDS, ALL_CONTROLS)
    expect(empty.match(/lsf-stat-value/g) ?? []).toHaveLength(0)
    expect(empty).toContain('该时段没有涨分')
    expect(empty).toContain('该时段没有正向日增量')
  })
})

describe('时段控件', () => {
  it('选择框按固定顺序输出十二个选项并保留当前选中项', () => {
    const html = rangeSelectHtml('global', 'last90')
    expect(html).toContain('data-range-select="global"')
    expect(html).toContain('<option value="last90" selected>近90天</option>')
    const order = [...html.matchAll(/value="([a-zA-Z0-9]+)"/g)].map((match) => match[1])
    expect(order).toEqual(RANGE_OPTIONS.map((option) => option.key))
    expect(order[0]).toBe('all')
    expect(order[order.length - 1]).toBe('custom')
    // 本月 / 上月 / 今年 / 去年紧跟昨天。
    expect(order.slice(2, 7)).toEqual(['yesterday', 'thisMonth', 'lastMonth', 'thisYear', 'lastYear'])
    expect(html).not.toContain('data-range-edit')
  })

  it('已应用自定义时提供「编辑日期」入口', () => {
    const html = rangeSelectHtml('lsf', 'custom', true)
    expect(html).toContain('data-range-edit="lsf"')
    expect(html).toContain('编辑日期')
    expect(html).toContain('aria-label="编辑自定义日期范围"')
    expect(rangeSelectHtml('global', 'custom', false)).not.toContain('data-range-edit')
  })

  it('统计卡顶部的选择框在自定义时也带编辑入口', () => {
    const html = lsfStatsHtml(allRange(sample().history), ALL_BOUNDS, {
      ...ALL_CONTROLS,
      uiKey: 'custom',
      editable: true,
    })
    expect(html).toContain('data-range-edit="lsf"')
  })

  it('自定义面板带起止标签、日期上限与应用 / 取消按钮', () => {
    const html = rangePanelHtml('lsf', { start: '2026-05-01', end: '2026-05-31' }, '错误提示', NOW)
    expect(html).toContain('data-range-panel="lsf"')
    expect(html).toContain('开始日期')
    expect(html).toContain('结束日期')
    expect(html).toContain('value="2026-05-01"')
    expect(html).toContain('value="2026-05-31"')
    expect(html).toContain(`max="${formatDateInput(NOW)}"`)
    expect(html).toContain('data-range-apply')
    expect(html).toContain('data-range-cancel')
    expect(html).toContain('错误提示')
  })
})

describe('历史阶梯图', () => {
  it('今天中午的终点停在当前时刻，早上六点的事件落在横轴中点', () => {
    const now = new Date(2026, 10, 3, 12).getTime()
    const date = new Date(2026, 10, 3, 6).getTime()
    const history = buildLsfHistory(analyzeGames([video({ end_time: new Date(date).toISOString() })]), {
      anchors: WORKBOOK_ANCHORS, now,
    })
    const bounds = resolveRange('today', { start: '', end: '' }, now)
    const range = lsfRange(history, { ...bounds, now })
    const html = lsfChartHtml(range)
    expect(html).toContain('class="lsf-point" cx="399.0"')
    expect(html).toMatch(/text-anchor="end">26\/11\/3<\/text>/)
    expect(html).not.toContain('26/11/4')
    expect(html).toMatch(/class="lsf-line" d="[^"]* L 742\.0 [\d.]+"/)
  })

  it('零跨度保留真实终点且坐标有限', () => {
    const now = new Date(2026, 10, 3).getTime()
    const history = buildLsfHistory([], { anchors: WORKBOOK_ANCHORS, now })
    const range = lsfRange(history, { start: now, endExclusive: null, now })
    const html = lsfChartHtml(range)
    expect(html).not.toMatch(/NaN|Infinity|26\/11\/4/)
    expect(html).toMatch(/text-anchor="end">26\/11\/3<\/text>/)
  })

  it('每个区间事件一个可聚焦的台阶点，并带完整提示', () => {
    const { history } = sample()
    const range = allRange(history)
    const html = lsfChartHtml(range)
    expect(html).toContain('class="lsf-line"')
    expect((html.match(/class="lsf-point"/g) ?? []).length).toBe(range.events.length)
    expect(html).toContain('tabindex="0" role="button"')
    expect(html).toContain('aria-label=')
    expect(html).toContain('<title>')
    const first = range.events[0] as LsfEvent
    expect(html).toContain(`data-lsf-event="${first.id}"`)
    expect(html).toContain(first.lsfBefore.toFixed(2))
    expect(html).toContain(first.lsfAfter.toFixed(2))
    expect(html).toContain(first.sources[0] as string)
  })

  it('区间没有变化时只画基线，不伪造事件点', () => {
    const { history } = sample()
    const html = lsfChartHtml(lastDayRange(history))
    expect(html).toContain('class="lsf-line"')
    expect(html).not.toContain('class="lsf-point"')
  })
})

describe('变动流水', () => {
  it('一条录像一行，时间倒序，只有展开行渲染明细', () => {
    const { history } = sample()
    const range = allRange(history)
    const events = [...range.events].reverse()
    const ledger = lsfLedgerHtml({
      events,
      expanded: new Set([events[0]!.id]),
      limit: 100,
      focus: '',
    })
    expect((ledger.match(/data-lsf-event-row=/g) ?? []).length).toBe(events.length)
    expect((ledger.match(/data-lsf-detail=/g) ?? []).length).toBe(events.length)
    expect((ledger.match(/data-lsf-toggle=/g) ?? []).length).toBe(events.length)
    expect(ledger.indexOf(events[0]!.id)).toBeLessThan(ledger.indexOf(events[1]!.id))
    expect(ledger).toContain('aria-expanded="true"')
    expect(ledger).toContain('收起')
    expect(ledger).toContain('展开')
    expect(ledger).toContain('时间</th><th>级别 / 方式</th>')
    expect(ledger).toContain('来源')
    expect(ledger).toContain(`时间倒序 · 共 ${events.length} 条`)
    expect(ledger).not.toContain('只列出引起 LSF 变化的录像')
    expect(ledger).not.toContain('一条录像只生成一条事件')
    expect(ledger).not.toContain('可能相差 ±0.01')
    expect(ledger).not.toContain('lsf-tip')
    expect((ledger.match(/class="lsf-row/g) ?? []).length).toBe(events.length)
  })

  it('超过显示上限时给出「显示更多」并只渲染已有部分', () => {
    const { history } = sample()
    const range = allRange(history)
    const events = [...range.events].reverse()
    const ledger = lsfLedgerHtml({ events, expanded: new Set(), limit: 1, focus: '' })
    expect((ledger.match(/data-lsf-event-row=/g) ?? []).length).toBe(1)
    expect(ledger).toContain('显示更多')
    expect(ledger).toContain(`还有 ${events.length - 1} 条`)
  })

  it('单日定位会高亮当前已显示的该日流水', () => {
    const { history } = sample()
    const range = allRange(history)
    const events = [...range.events].reverse()
    const day = startOfLocalDay(events[0]!.date)
    const ledger = lsfLedgerHtml({
      events,
      expanded: new Set(),
      limit: 100,
      focus: '',
      highlightDay: day,
    })
    const highlighted = events.filter(
      (event) => !event.undated && startOfLocalDay(event.date) === day,
    )
    expect(highlighted.length).toBeGreaterThan(0)
    expect(ledger.match(/day-focus/g) ?? []).toHaveLength(highlighted.length)
    expect(
      lsfLedgerHtml({ events, expanded: new Set(), limit: 100, focus: '' }),
    ).not.toContain('day-focus')
  })

  it('展开明细包含均值、贡献差值、级别与综合前后值', () => {
    const { history } = sample()
    const range = allRange(history)
    const event = range.events[range.events.length - 1] as LsfEvent
    const detail = lsfDetailHtml(event, true)
    expect(detail).not.toContain('lsf-detail hidden')
    expect(detail).toContain('综合 LSF')
    expect(detail).toContain(event.lsfBefore.toFixed(2))
    expect(detail).toContain(event.lsfAfter.toFixed(2))
    expect(detail).toContain('Top5 均值')
    expect(detail).toContain('LSF 贡献')
    expect(detail).toContain('该级 LSF')
    expect(detail).toContain('本条录像')
    // 收起时只留空占位，展开时才由前端补内容。
    const closed = lsfDetailHtml(event, false)
    expect(closed).toContain('lsf-detail hidden')
    expect(closed).toContain('data-filled="0"')
    expect(closed).not.toContain('Top5 均值')
  })

  it('首条录像的明细带初始化基线与合计行，非首条没有', () => {
    const only = video({ id: 1, level: 'e', bv: 150, timems: 60_000, end_time: iso(0) })
    const history = buildLsfHistory(analyzeGames([only], {}, 1), {
      anchors: WORKBOOK_ANCHORS,
      now: NOW,
    })
    const first = history.events[0] as LsfEvent
    const detail = lsfDetailHtml(first, true)
    expect(detail).toContain('初始化基线')
    expect(detail).toContain('该级此前按 0 计')
    expect(detail).toContain('>合计<')
    expect(detail).toContain(first.change.baselineContribution.toFixed(2))
    expect(detail).toContain('NF补位折算')

    const { history: multi } = sample()
    const normal = multi.events.find((event) => !event.change.baseline) as LsfEvent
    expect(normal).toBeDefined()
    expect(lsfDetailHtml(normal, true)).not.toContain('初始化基线')
  })

  it('历史点极多时不把数组展开成函数参数', () => {
    const points = Array.from({ length: 150_000 }, (_, index) => ({
      date: BASE + index * 60_000,
      lsf: index * 0.01,
      eventId: null,
    }))
    const range: LsfRange = {
      start: null,
      end: BASE + 150_000 * 60_000,
      now: BASE + 150_000 * 60_000,
      baseline: 0,
      latest: 1499.99,
      change: 1499.99,
      upCount: 0,
      downCount: 0,
      maxGain: null,
      maxGainDate: null,
      maxGainEventId: null,
      maxDayGain: null,
      maxDayDate: null,
      maxDayEventId: null,
      events: [],
      points,
    }
    let html = ''
    expect(() => {
      html = lsfChartHtml(range)
    }).not.toThrow()
    expect(html).toContain('class="lsf-line"')
    expect(html).not.toContain('class="lsf-point"')
    expect(html).not.toContain('NaN')
  })

  it('CSV 记录显示本地标识，不生成网站录像链接', () => {
    const csv = video({
      id: -1,
      importOrder: 7,
      csvNf: false,
      level: 'b',
      bv: 20,
      timems: 12000,
      end_time: iso(0),
      upload_time: iso(0),
    })
    const history = buildLsfHistory(analyzeGames([csv], {}, 1), {
      anchors: WORKBOOK_ANCHORS,
      now: NOW,
    })
    const range = allRange(history)
    const event = range.events[0] as LsfEvent
    expect(lsfDetailHtml(event, true)).toContain('本地记录 #8')
    const ledger = lsfLedgerHtml({
      events: [event],
      expanded: new Set(),
      limit: 10,
      focus: '',
    })
    expect(ledger).toContain('本地记录 #8')
    expect(ledger).not.toContain('openms.top/#/video')
  })
})

describe('梁山分提示', () => {
  it('说明口径、未定日期、未来记录与筛选例外', () => {
    const videos = [
      video({ id: 1, level: 'b', bv: 20, timems: 20000, end_time: iso(0) }),
      video({ id: 2, level: 'b', bv: 20, timems: 18000, end_time: null, upload_time: '' }),
      video({
        id: 3,
        level: 'b',
        bv: 20,
        timems: 12000,
        end_time: new Date(NOW + DAY).toISOString(),
      }),
    ]
    const history = buildLsfHistory(analyzeGames(videos, {}, 1), {
      anchors: WORKBOOK_ANCHORS,
      now: NOW,
    })
    const range = allRange(history)
    const html = lsfNoticeHtml(history, range)
    expect(html).toContain('未定日期基线')
    expect(html).toContain('晚于当前时间')
    expect(html).toContain('软件与只看 NF 筛选在本页不参与重建')
  })

  it('没有任何计入录像时提示空态成因', () => {
    const belowFloor = video({ id: 1, level: 'b', bv: 5, timems: 12000, end_time: iso(0) })
    const history = buildLsfHistory(analyzeGames([belowFloor], {}, 1), {
      anchors: WORKBOOK_ANCHORS,
      now: NOW,
    })
    const range = allRange(history)
    const html = lsfNoticeHtml(history, range)
    expect(html).toContain('还没有计入梁山分的有效录像')
    expect(html).toContain('低于当前 3BV 下限')
  })
})
