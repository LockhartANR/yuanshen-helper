import { describe, expect, it } from 'vitest'
import { analyzeGames } from '../src/features/player-stats/analysis'
import type { Video } from '../src/features/player-stats/model'
import { STNB_COEFFICIENT } from '../src/features/player-stats/model'
import {
  WORKBOOK_ANCHORS,
  WORKBOOK_LEVEL_WEIGHTS,
  WORKBOOK_SOFT_WEIGHTS,
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
    expect(snapshot.nfTitle).toBe('新手')
    expect(snapshot.nfProgress).toBe(0)
    expect(snapshot.lsf).toBeCloseTo(4000 * 0.97)
  })

  it('每级 LSF 贡献相加等于综合 LSF，且不随级别权重改变口径', () => {
    const videos: Video[] = []
    const times: Record<'b' | 'i' | 'e', number[]> = {
      b: [9, 11, 13, 15, 17, 19],
      i: [30, 34, 38, 42, 46, 50],
      e: [120, 140, 160, 180, 200, 220],
    }
    for (const level of ['b', 'i', 'e'] as const) {
      const bv = level === 'b' ? 20 : level === 'i' ? 60 : 150
      for (const [index, time] of times[level].entries()) {
        videos.push(
          video({
            level,
            bv,
            timems: time * 1000,
            right: index === 0 ? 0 : 2,
            right_ce: index === 0 ? 0 : 2,
          }),
        )
      }
    }
    const games = analyzeGames(videos)
    const snapshot = ratingSnapshot(games, WORKBOOK_ANCHORS)
    const sum = snapshot.levels.reduce((total, level) => total + level.lsf, 0)
    expect(sum).toBeCloseTo(snapshot.lsf, 9)
    for (const item of snapshot.levels) {
      expect(item.lsf).toBeCloseTo(
        WORKBOOK_LEVEL_WEIGHTS[item.level] * (item.soft * 0.97 + item.nfSoft * 0.03),
        9,
      )
    }
  })

  it('单级定阶按固定 100 尺度换算，改级别权重不影响称号', () => {
    const videos: Video[] = []
    for (const level of ['b', 'i', 'e'] as const) {
      const bv = level === 'b' ? 20 : level === 'i' ? 60 : 150
      for (let index = 0; index < 5; index += 1) {
        videos.push(video({ level, bv, timems: (level === 'e' ? 40 : 10) * 1000 }))
      }
    }
    const games = analyzeGames(videos)
    const base = ratingSnapshot(games, WORKBOOK_ANCHORS)
    const doubled = ratingSnapshot(games, WORKBOOK_ANCHORS, WORKBOOK_SOFT_WEIGHTS, {
      b: 12,
      i: 28,
      e: 40,
    })
    const etAnchor = WORKBOOK_ANCHORS[anchorKey('std', 'e', 't')]
    const nfEtAnchor = WORKBOOK_ANCHORS[anchorKey('nf', 'e', 't')]
    for (let index = 0; index < 3; index += 1) {
      const level = base.levels[index]!
      expect(doubled.levels[index]?.title).toBe(level.title)
      expect(doubled.levels[index]?.lsf).toBeCloseTo(level.lsf * 2, 9)
      expect(level.title).toBe(titleFor(level.soft * 40, etAnchor).title)
      expect(level.progress).toBeCloseTo(titleFor(level.soft * 40, etAnchor).progress, 12)
      expect(level.nfTitle).toBe(titleFor(level.nfSoft * 40, nfEtAnchor).title)
    }
  })
})
