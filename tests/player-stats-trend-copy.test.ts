import { describe, expect, it } from 'vitest'
import type { MonthStat, WeekLevelDetail, WeekStat, YearStat } from '../src/features/player-stats/analysis'
import {
  analyzeGames,
  monthStats,
  weekStats,
  yearStats,
} from '../src/features/player-stats/analysis'
import type { Video } from '../src/features/player-stats/model'
import {
  formatCopyDate,
  formatCopyMonth,
  formatCopyWeek,
  monthCopyText,
  weekCopyEntries,
  weekCopyText,
  weekDeltaClass,
  yearCopyText,
} from '../src/features/player-stats/trend-copy'
import type { WeekCopyContext } from '../src/features/player-stats/trend-copy'

const MONTH_TEXT = {
  avgTime: 65.432,
  medianTime: 64.321,
  avgBv: 150.2,
  avgBvs: 2.345,
  avgStnb: 88.8,
  avgOp: 12.3,
  avgIs: 4.5,
  avgCls: 4.56,
  avgCes: 3.45,
  avgCorr: 0.76,
  avgThrp: 0.68,
  avgPath: 1234,
  avgMov: 18.9,
}

function month(overrides: Partial<MonthStat> = {}): MonthStat {
  return {
    key: '2026-10',
    days: 20,
    count: 1200,
    hasScores: true,
    hasCl: true,
    hasCe: true,
    hasOp: true,
    hasIs: true,
    hasPath: true,
    gamesPerDay: 60,
    breakRate: 100,
    headScore: 12,
    pbCount: 3,
    timeTierShare: [],
    bvsTierShare: [],
    ...MONTH_TEXT,
    ...overrides,
  }
}

function year(overrides: Partial<YearStat> = {}): YearStat {
  return {
    year: 2026,
    count: 12345,
    hasScores: true,
    hasCl: true,
    hasCe: true,
    hasPath: true,
    pbCount: 28,
    avgTime: 65.432,
    avgBv: 150.2,
    avgBvs: 2.345,
    avgStnb: 88.8,
    avgCls: 4.56,
    avgCes: 3.45,
    avgMov: 18.9,
    ...overrides,
  }
}

let nextId = 1

function video(overrides: Partial<Video> = {}): Video {
  return {
    id: overrides.id ?? nextId++,
    upload_time: '2025-01-01T00:00:00.000Z',
    state: 'c',
    ongoing_tournament: false,
    software: 'e',
    level: 'b',
    mode: '00',
    end_time: '2025-01-01T00:00:00.000Z',
    timems: 5000,
    bv: 20,
    left: 10,
    right: 2,
    double: 3,
    left_ce: 9,
    right_ce: 1,
    double_ce: 2,
    path: 800,
    op: 3,
    isl: 4,
    ...overrides,
  }
}

describe('月均复制文本', () => {
  it('默认恰好三行，字段、顺序、小数位和难度标签与设计一致', () => {
    const text = monthCopyText(month(), 'e', [])
    expect(text.split('\n')).toEqual([
      '月成绩 · 2026/10 · exp',
      'Games 1200 | 活跃 20 天 | 日均 60.0',
      'Avg T 65.432 | B 2.345 | S 88.8 | 3BV 150.2',
    ])
  })

  it('全部选项按分组合并，输出顺序固定', () => {
    const fields = [
      'medianTime',
      'op',
      'is',
      'cls',
      'ces',
      'corr',
      'thrp',
      'path',
      'mov',
      'breakRate',
      'headScore',
      'pbCount',
    ] as const
    const lines = monthCopyText(month(), 'e', fields).split('\n')
    expect(lines).toHaveLength(7)
    expect(lines.slice(3)).toEqual([
      'Median T 64.321 | op 12.3 | is 4.5',
      'cl/s 4.56 | ce/s 3.45 | Corr 0.76 | Thrp 0.68',
      '路径 1234 | 移速 18.9',
      '1/破率 100 | 头部表现 12 | 新 PB 3',
    ])
  })

  it('部分选项仍按固定顺序输出，未选分组不产生空行', () => {
    const reversed = ['pbCount', 'medianTime', 'cls'] as const
    expect(monthCopyText(month(), 'b', reversed).split('\n').slice(3)).toEqual([
      'Median T 64.321',
      'cl/s 4.56',
      '新 PB 3',
    ])
  })

  it('缺失点击 / 开空 / 岛屿 / 路径字段时输出 —', () => {
    const lines = monthCopyText(
      month({ hasCl: false, hasCe: false, hasOp: false, hasIs: false, hasPath: false }),
      'e',
      ['medianTime', 'op', 'is', 'cls', 'ces', 'corr', 'thrp', 'path', 'mov'],
    ).split('\n')
    expect(lines.slice(3)).toEqual([
      'Median T 64.321 | op — | is —',
      'cl/s — | ce/s — | Corr — | Thrp —',
      '路径 — | 移速 —',
    ])
  })

  it('保留真实零值，破率哨兵 0 输出 —', () => {
    const lines = monthCopyText(
      month({ avgOp: 0, avgMov: 0, breakRate: 0, pbCount: 0 }),
      'b',
      ['op', 'mov', 'breakRate', 'pbCount'],
    ).split('\n')
    expect(lines[3]).toBe('op 0.0')
    expect(lines[4]).toBe('移速 0.0')
    expect(lines[5]).toBe('1/破率 — | 新 PB 0')
  })

  it('没有达标成绩时第三行和所有附加指标使用 —', () => {
    const row = month({
      hasScores: false,
      hasCl: false,
      hasCe: false,
      hasOp: false,
      hasIs: false,
      hasPath: false,
    })
    const fields = [
      'medianTime',
      'op',
      'is',
      'cls',
      'ces',
      'corr',
      'thrp',
      'path',
      'mov',
      'breakRate',
      'headScore',
      'pbCount',
    ] as const
    const lines = monthCopyText(row, 'b', fields).split('\n')
    expect(lines[2]).toBe('Avg T — | B — | S — | 3BV —')
    expect(lines.slice(3)).toEqual([
      'Median T — | op — | is —',
      'cl/s — | ce/s — | Corr — | Thrp —',
      '路径 — | 移速 —',
      '1/破率 — | 头部表现 — | 新 PB —',
    ])
  })

  it('难度标签使用 beg / int / exp', () => {
    expect(monthCopyText(month(), 'b', []).split('\n')[0]).toBe('月成绩 · 2026/10 · beg')
    expect(monthCopyText(month(), 'i', []).split('\n')[0]).toBe('月成绩 · 2026/10 · int')
  })
})

describe('年汇总复制文本', () => {
  it('默认恰好三行，新 PB 已在第二行', () => {
    const text = yearCopyText(year(), 'e', [])
    expect(text.split('\n')).toEqual([
      '年成绩 · 2026 · exp',
      'Games 12345 | 新 PB 28',
      'Avg T 65.432 | B 2.345 | S 88.8 | 3BV 150.2',
    ])
  })

  it('全部选项合并为一行并保持顺序', () => {
    const lines = yearCopyText(year(), 'b', ['mov', 'ces', 'cls']).split('\n')
    expect(lines).toHaveLength(4)
    expect(lines[3]).toBe('cl/s 4.56 | ce/s 3.45 | 移速 18.9')
  })

  it('缺失字段、零值和没有达标成绩时输出 —', () => {
    const missing = yearCopyText(year({ hasCl: false, hasCe: false, hasPath: false }), 'b', [
      'cls',
      'ces',
      'mov',
    ]).split('\n')
    expect(missing[3]).toBe('cl/s — | ce/s — | 移速 —')

    const blank = yearCopyText(year({ hasScores: false }), 'b', ['cls']).split('\n')
    expect(blank[1]).toBe('Games 12345 | 新 PB —')
    expect(blank[2]).toBe('Avg T — | B — | S — | 3BV —')
    expect(blank[3]).toBe('cl/s —')

    expect(yearCopyText(year({ pbCount: 0 }), 'e', []).split('\n')[1]).toBe('Games 12345 | 新 PB 0')
  })
})

describe('复制与统计口径一致', () => {
  it('月年局数含低于下限的局，成绩指标只取达标局', () => {
    const videos = [
      video({ id: 1, bv: 20, timems: 5000, end_time: '2025-01-10T00:00:00.000Z' }),
      video({ id: 2, bv: 5, timems: 1000, end_time: '2025-01-11T00:00:00.000Z' }),
    ]
    const games = analyzeGames(videos)
    const all = analyzeGames(videos, {}, 2)
    const row = monthStats(games, 'b', all)[0]!
    const lines = monthCopyText(row, 'b', []).split('\n')
    expect(lines[1]).toBe('Games 2 | 活跃 2 天 | 日均 1.0')
    expect(lines[2]).toBe(
      `Avg T 5.000 | B 4.000 | S ${row.avgStnb.toFixed(1)} | 3BV 20.0`,
    )
    const yearRow = yearStats(games, 'b', all)[0]!
    expect(yearCopyText(yearRow, 'b', []).split('\n')[1]).toBe('Games 2 | 新 PB 1')
  })

  it('整月 / 整年只有低于下限的局时仍可复制，平均成绩占位', () => {
    const videos = [video({ id: 1, bv: 5, timems: 1000, end_time: '2025-01-10T00:00:00.000Z' })]
    const games = analyzeGames(videos)
    const all = analyzeGames(videos, {}, 2)
    const monthRow = monthStats(games, 'b', all)[0]!
    const monthLines = monthCopyText(monthRow, 'b', ['medianTime', 'pbCount']).split('\n')
    expect(monthLines[1]).toBe('Games 1 | 活跃 1 天 | 日均 1.0')
    expect(monthLines[2]).toBe('Avg T — | B — | S — | 3BV —')
    expect(monthLines[3]).toBe('Median T —')
    expect(monthLines[4]).toBe('新 PB —')

    const yearRow = yearStats(games, 'b', all)[0]!
    const yearLines = yearCopyText(yearRow, 'b', ['cls']).split('\n')
    expect(yearLines[1]).toBe('Games 1 | 新 PB —')
    expect(yearLines[2]).toBe('Avg T — | B — | S — | 3BV —')
    expect(yearLines[3]).toBe('cl/s —')
  })
})

function weekLevel(
  totals: { time: number; bvs: number; stnb: number },
  ppp: number,
): WeekLevelDetail {
  return {
    slot: 1,
    slots: [],
    totals,
    // 复制只允许用各级总计，平均值故意给出明显不同的值。
    averages: { time: 999, bvs: 999, stnb: 999 },
    ppp,
  }
}

const WEEK_START = new Date(2026, 9, 26).getTime()

/** 三级分项之和与总值一致；PPP 用三级因子乘积开立方。 */
function week(patch: Partial<WeekStat> = {}): WeekStat {
  return {
    start: WEEK_START,
    count: 128,
    t37: 820.06,
    b37: 42.14,
    s37: 1532.44,
    ppp: Math.cbrt(1.234 * 2.345 * 3.456),
    levels: {
      b: weekLevel({ time: 200, bvs: 12.14, stnb: 500.44 }, 1.234),
      i: weekLevel({ time: 300, bvs: 20, stnb: 600 }, 2.345),
      e: weekLevel({ time: 320.06, bvs: 10, stnb: 432 }, 3.456),
    },
    ...patch,
  }
}

function weekLines(context: WeekCopyContext = { delta: null }, row: WeekStat = week()): string[] {
  return weekCopyText(row, context).split('\n')
}

describe('周复制文本', () => {
  it('固定六行，按初级、中级、高级输出各级总计和 PP 因子', () => {
    const row = week()
    expect(weekLines({ delta: -12.34 })).toEqual([
      '周成绩 · 2026/10/26–2026/11/01',
      'Games 128 | ΔT37 −12.3',
      'T37 820.1 = 200.0 + 300.0 + 320.1',
      'B37 42.1 = 12.1 + 20.0 + 10.0',
      'S37 1532.4 = 500.4 + 600.0 + 432.0',
      `PPP ${row.ppp.toFixed(3)} = ∛(1.234 × 2.345 × 3.456)`,
    ])
  })

  it('ΔT37 正值带 +、负值用 −、无前项为 —，负零归零后输出 +0.0', () => {
    const second = (delta: number | null): string => weekLines({ delta })[1] as string
    expect(second(12.34)).toBe('Games 128 | ΔT37 +12.3')
    expect(second(-12.34)).toBe('Games 128 | ΔT37 −12.3')
    expect(second(null)).toBe('Games 128 | ΔT37 —')
    expect(second(0)).toBe('Games 128 | ΔT37 +0.0')
    expect(second(-0.04)).toBe('Games 128 | ΔT37 +0.0')
    expect(second(-0.06)).toBe('Games 128 | ΔT37 −0.1')

    expect(weekDeltaClass(-0.04)).toBe('')
    expect(weekDeltaClass(0)).toBe('')
    expect(weekDeltaClass(-1)).toBe('delta-up')
    expect(weekDeltaClass(1)).toBe('delta-down')
    expect(weekDeltaClass(null)).toBe('')
  })

  it('日期用本地日历运算得到周日，复制展示统一斜杠，跨月跨年完整写出两端', () => {
    expect(formatCopyWeek(new Date(2026, 11, 28).getTime())).toBe('2026/12/28–2027/01/03')
    expect(formatCopyWeek(new Date(2026, 2, 2).getTime())).toBe('2026/03/02–2026/03/08')
    expect(
      weekLines({ delta: null }, week({ start: new Date(2026, 11, 28).getTime() }))[0],
    ).toBe('周成绩 · 2026/12/28–2027/01/03')
    expect(formatCopyDate(new Date(2026, 10, 1).getTime())).toBe('2026/11/01')
    expect(formatCopyMonth('2026-11')).toBe('2026/11')
    expect(formatCopyMonth('2026')).toBe('2026')
  })

  it('筛选标记放在首行末尾，部分周把统计日期并入首行，始终六行', () => {
    const first = (context: WeekCopyContext): string => weekLines(context)[0] as string
    expect(first({ delta: null, software: 'all' })).toBe('周成绩 · 2026/10/26–2026/11/01')
    expect(first({ delta: null, software: 'a' })).toBe('周成绩 · 2026/10/26–2026/11/01 · avf')
    expect(first({ delta: null, nfOnly: true })).toBe('周成绩 · 2026/10/26–2026/11/01 · 仅 NF')
    expect(first({ delta: null, software: 'e', nfOnly: true })).toBe(
      '周成绩 · 2026/10/26–2026/11/01 · evf · 仅 NF',
    )
    // 完整覆盖自然周、完全不限时段都不加说明。
    const full = {
      start: new Date(2026, 9, 26).getTime(),
      endExclusive: new Date(2026, 10, 2).getTime(),
    }
    expect(first({ delta: null, range: full })).toBe('周成绩 · 2026/10/26–2026/11/01')
    expect(first({ delta: null, range: { start: null, endExclusive: null } })).toBe(
      '周成绩 · 2026/10/26–2026/11/01',
    )
    expect(first({ delta: null, range: null })).toBe('周成绩 · 2026/10/26–2026/11/01')

    // 只统计自然周的一部分：统计日期并入首行括号，筛选标记继续跟在后面。
    const clipped = {
      start: new Date(2026, 9, 28).getTime(),
      endExclusive: new Date(2026, 9, 31).getTime(),
    }
    expect(first({ delta: null, range: clipped })).toBe(
      '周成绩 · 2026/10/26–2026/11/01（统计日期 2026/10/28–2026/10/30）',
    )
    expect(first({ delta: null, range: clipped, software: 'a', nfOnly: true })).toBe(
      '周成绩 · 2026/10/26–2026/11/01（统计日期 2026/10/28–2026/10/30） · avf · 仅 NF',
    )
    expect(weekLines({ delta: 1.2, range: clipped, software: 'a', nfOnly: true })).toHaveLength(6)

    // 只截一头也按交集写。
    expect(
      first({ delta: null, range: { start: new Date(2026, 9, 30).getTime(), endExclusive: null } }),
    ).toBe('周成绩 · 2026/10/26–2026/11/01（统计日期 2026/10/30–2026/11/01）')
    expect(
      first({ delta: null, range: { start: null, endExclusive: new Date(2026, 9, 29).getTime() } }),
    ).toBe('周成绩 · 2026/10/26–2026/11/01（统计日期 2026/10/26–2026/10/28）')
  })

  it('显示精度产生尾差时仍统一用等号，不增加行也不改真实分项', () => {
    const levels = {
      b: weekLevel({ time: 0.04, bvs: 0, stnb: 0 }, 1.2344),
      i: weekLevel({ time: 0.04, bvs: 0, stnb: 0 }, 2.3454),
      e: weekLevel({ time: 0.04, bvs: 0, stnb: 0 }, 3.4564),
    }
    const row = week({ t37: 0.12, b37: 0, s37: 0, ppp: Math.cbrt(1.2344 * 2.3454 * 3.4564), levels })
    const lines = weekLines({ delta: null }, row)
    expect(lines).toHaveLength(6)
    expect(lines[2]).toBe('T37 0.1 = 0.0 + 0.0 + 0.0')
    expect(lines[3]).toBe('B37 0.0 = 0.0 + 0.0 + 0.0')
    expect(lines[4]).toBe('S37 0.0 = 0.0 + 0.0 + 0.0')
    expect(lines[5]).toBe('PPP 2.155 = ∛(1.234 × 2.345 × 3.456)')
  })

  it('真实零值保留对应精度，不换成 —', () => {
    const levels = {
      b: weekLevel({ time: 0, bvs: 0, stnb: 0 }, 0),
      i: weekLevel({ time: 0, bvs: 0, stnb: 0 }, 0),
      e: weekLevel({ time: 0, bvs: 0, stnb: 0 }, 0),
    }
    const lines = weekLines(
      { delta: null },
      week({ count: 0, t37: 0, b37: 0, s37: 0, ppp: 0, levels }),
    )
    expect(lines[1]).toBe('Games 0 | ΔT37 —')
    expect(lines[2]).toBe('T37 0.0 = 0.0 + 0.0 + 0.0')
    expect(lines[3]).toBe('B37 0.0 = 0.0 + 0.0 + 0.0')
    expect(lines[4]).toBe('S37 0.0 = 0.0 + 0.0 + 0.0')
    expect(lines[5]).toBe('PPP 0.000 = ∛(0.000 × 0.000 × 0.000)')
  })

  it('缺少某级时保留该级补位用时和 PP 结果，六行不塌陷', () => {
    const games = analyzeGames([
      video({ id: 1, level: 'b', bv: 20, timems: 2000, end_time: '2026-10-27T04:00:00.000Z' }),
    ])
    const row = weekStats(games, 1, new Date(2026, 9, 29, 12).getTime())[0]!
    expect(row.levels.b.totals.time).toBe(2 + 19 * 10)
    expect(row.levels.i.totals.time).toBe(12 * 30)
    expect(row.levels.e.totals.time).toBe(5 * 99)
    const lines = weekCopyText(row, { delta: null }).split('\n')
    expect(lines).toHaveLength(6)
    expect(lines[2]).toBe('T37 1047.0 = 192.0 + 360.0 + 495.0')
    expect(lines[3]).toBe('B37 10.0 = 10.0 + 0.0 + 0.0')
    expect(lines[4]).toBe('S37 221.6 = 221.6 + 0.0 + 0.0')
    expect(lines[5]).toBe('PPP 0.000 = ∛(0.008 × 0.000 × 0.000)')
  })

  it('槽位、补位值与 PPP 常数修改后，六行内的总值与分项同步变化', () => {
    const games = analyzeGames([
      video({ id: 1, level: 'b', bv: 20, timems: 2000, end_time: '2026-10-27T04:00:00.000Z' }),
    ])
    const now = new Date(2026, 9, 29, 12).getTime()
    const custom = weekStats(
      games,
      1,
      now,
      true,
      { b: 2, i: 2, e: 2 },
      { b: 5, i: 6, e: 7 },
      { b: 1, i: 1, e: 1 },
    )[0]!
    expect(custom.levels.b.totals.time).toBe(7)
    expect(custom.levels.i.totals.time).toBe(12)
    expect(custom.levels.e.totals.time).toBe(14)
    const lines = weekCopyText(custom, { delta: null }).split('\n')
    expect(lines[2]).toBe('T37 33.0 = 7.0 + 12.0 + 14.0')
    expect(lines[5]).toContain(
      `∛(${custom.levels.b.ppp.toFixed(3)} × ${custom.levels.i.ppp.toFixed(3)} × ${custom.levels.e.ppp.toFixed(3)})`,
    )
    expect(lines[5]).toMatch(/^PPP [\d.]+ = ∛\([\d.]+ × [\d.]+ × [\d.]+\)$/)
  })

  it('没有前项的第一条 Δ 为 —，跳过空周后仍只跟上一条有成绩周比较', () => {
    const videos = [
      video({ id: 1, end_time: '2026-10-06T04:00:00.000Z' }),
      video({ id: 2, end_time: '2026-10-27T04:00:00.000Z' }),
    ]
    const visible = weekStats(analyzeGames(videos), 5, new Date(2026, 10, 4, 12).getTime()).filter(
      (item) => item.count > 0,
    )
    expect(visible.map((item) => item.start)).toEqual([
      new Date(2026, 9, 5).getTime(),
      new Date(2026, 9, 26).getTime(),
    ])
    const entries = weekCopyEntries(visible)
    expect(entries.map((entry) => entry.delta)).toEqual([null, 0])
  })
})

