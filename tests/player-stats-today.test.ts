import { describe, expect, it } from 'vitest'
import {
  analyzeGames,
  todayCopyText,
  todayStats,
} from '../src/features/player-stats/analysis'
import type { Video } from '../src/features/player-stats/model'

function video(overrides: Partial<Video> = {}): Video {
  return {
    id: overrides.id ?? 1,
    upload_time: '2025-01-01T00:00:00.000Z',
    state: 'c',
    ongoing_tournament: false,
    software: 'e',
    level: 'b',
    mode: '00',
    end_time: new Date().toISOString(),
    timems: 5000,
    bv: 20,
    left: 10,
    right: 0,
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

describe('今日成绩', () => {
  it('包含低于 3BV 下限的局，并排除昨天和明天', () => {
    const now = Date.now()
    const today = new Date(now).toISOString()
    const yesterday = new Date(now - 86_400_000).toISOString()
    const tomorrow = new Date(now + 86_400_000).toISOString()
    const games = analyzeGames(
      [
        video({ id: 1, bv: 5, end_time: today, right: 0 }),
        video({ id: 2, bv: 12, end_time: today, right: 3 }),
        video({ id: 3, bv: 30, end_time: yesterday }),
        video({ id: 4, bv: 30, end_time: tomorrow }),
      ],
      {},
      1,
    )

    const beginner = todayStats(games, now)[0]!
    expect(beginner.count).toBe(2)
    expect(beginner.nf).toBe(1)
    expect(beginner.fl).toBe(1)
    expect(beginner.avgBv).toBeCloseTo(8.5)
  })

  it('复制文本使用 beg/int/exp、B/S、FL + NF', () => {
    const now = Date.now()
    const games = analyzeGames(
      [
        video({ id: 1, timems: 5000, bv: 20, right: 0, end_time: new Date(now).toISOString() }),
        video({ id: 2, timems: 7000, bv: 30, right: 2, end_time: new Date(now).toISOString() }),
      ],
      {},
      1,
    )
    const row = todayStats(games, now)[0]!
    const lines = todayCopyText(row).split('\n')

    expect(lines[0]).toBe('/me has finished 2 beg games today')
    expect(lines[1]).toBe('Games 2 = 1 FL + 1 NF')
    expect(lines[2]).toMatch(/^Best T 5\.000\/20 \| B 4\.286\/30 \| S \d+\.\d\/20$/)
    expect(lines[3]).toMatch(/^Avg  T 6\.000 \| B 4\.143 \| S \d+\.\d \| 3BV 25\.0$/)
  })
})
