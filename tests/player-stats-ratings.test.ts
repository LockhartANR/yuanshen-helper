import { describe, expect, it } from 'vitest'
import { analyzeGames } from '../src/features/player-stats/analysis'
import type { Video } from '../src/features/player-stats/model'
import { STNB_COEFFICIENT } from '../src/features/player-stats/model'
import {
  anchorKey,
  ratingSnapshot,
  titleFor,
  top5Average,
} from '../src/features/player-stats/ratings'
import type { LsfAnchors } from '../src/features/player-stats/ratings'

let nextId = 1

function video(overrides: Partial<Video> = {}): Video {
  const id = overrides.id ?? nextId++
  return {
    id,
    upload_time: '2025-01-01T00:00:00.000Z',
    state: 'c',
    ongoing_tournament: false,
    software: 'e',
    level: 'b',
    mode: '00',
    end_time: '2025-01-01T00:00:00.000Z',
    timems: 1000,
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

describe('top5Average', () => {
  it('时间不足补 999.999 秒，其余补 0', () => {
    expect(top5Average([1, 2], 't')).toBeCloseTo((1 + 2 + 3 * 999.999) / 5)
    expect(top5Average([1, 2], 'b')).toBeCloseTo(0.6)
  })
})

describe('titleFor', () => {
  it('按等价 et 的区间和软实力插值', () => {
    expect(titleFor(4000, 30).title).toBe('外星人')
    expect(titleFor(3000, 30).title).toBe('小雷帝')
    expect(titleFor(0, 30).title).toBe('新手')
  })
})

describe('ratingSnapshot', () => {
  it('完全没有录像时三级软实力为 0', () => {
    const snapshot = ratingSnapshot([], {})
    expect(snapshot.soft).toBe(0)
    expect(snapshot.nfSoft).toBe(0)
    expect(snapshot.levels.every((level) => level.soft === 0 && level.nfSoft === 0)).toBe(true)
  })

  it('三项都达到锚点时级别软实力为 100，综合为 4000', () => {
    const videos: Video[] = []
    const anchors: LsfAnchors = {}
    for (const level of ['b', 'i', 'e'] as const) {
      const bv = level === 'b' ? 20 : level === 'i' ? 50 : 150
      const bvs = bv / 2
      const stnb = (STNB_COEFFICIENT[level] * bv) / 2 ** 1.7
      anchors[anchorKey('std', level, 't')] = 2
      anchors[anchorKey('std', level, 'b')] = bvs
      anchors[anchorKey('std', level, 's')] = stnb
      for (let index = 0; index < 5; index += 1) {
        videos.push(video({ level, bv, timems: 2000 }))
      }
    }
    const snapshot = ratingSnapshot(analyzeGames(videos), anchors)
    expect(snapshot.soft).toBeCloseTo(4000)
    expect(snapshot.levels.every((level) => Math.abs(level.soft - 100) < 1e-9)).toBe(true)
    expect(snapshot.nfSoft).toBeCloseTo(0)
    expect(snapshot.nfTitle).toBe('新手 0.0')
    expect(snapshot.lsf).toBeCloseTo(4000 * 0.97)
  })
})
