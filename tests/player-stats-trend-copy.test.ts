import { describe, expect, it } from 'vitest'
import type { MonthStat, YearStat } from '../src/features/player-stats/analysis'
import { analyzeGames, monthStats, yearStats } from '../src/features/player-stats/analysis'
import type { Video } from '../src/features/player-stats/model'
import {
  monthCopyText,
  yearCopyText,
} from '../src/features/player-stats/trend-copy'

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
      '月成绩 · 2026-10 · exp',
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
    expect(monthCopyText(month(), 'b', []).split('\n')[0]).toBe('月成绩 · 2026-10 · beg')
    expect(monthCopyText(month(), 'i', []).split('\n')[0]).toBe('月成绩 · 2026-10 · int')
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

