import { describe, expect, it } from 'vitest'
import type { Video } from '../src/features/player-stats/model'
import type { Level } from '../src/features/player-stats/model'
import type { ExclusionEntry } from '../src/features/player-stats/statistics-exclusion'
import {
  buildExclusionCandidates,
  directCandidateScope,
  intersectCandidateRange,
  sortCandidateRows,
} from '../src/features/player-stats/statistics-exclusion-candidates'

const DAY = '2026-11-01T12:00:00+08:00'

function video(
  id: number,
  level: Level,
  time: number,
  options: {
    bv?: number
    date?: string
    timems?: number
    mode?: string
    state?: string
  } = {},
): Video {
  const bv = options.bv ?? (level === 'b' ? 12 : level === 'i' ? 40 : 120)
  return {
    id,
    upload_time: options.date ?? DAY,
    state: options.state ?? 'c',
    ongoing_tournament: false,
    software: 'e',
    level,
    mode: options.mode ?? '00',
    end_time: options.date ?? DAY,
    timems: options.timems ?? time * 1000,
    bv,
    left: 10,
    right: 3,
    double: 3,
    left_ce: 10,
    right_ce: 3,
    double_ce: 3,
    path: 100,
    op: 3,
    isl: 3,
  }
}

function entry(item: Video, index: number, excluded = false): ExclusionEntry {
  return {
    key: `site|entry|${item.id}`,
    source: 'site',
    scopeId: 'site|test',
    sourceId: null,
    sourceName: '网站数据',
    recordIndex: index,
    globalIndex: null,
    videoId: item.id,
    importOrder: null,
    summary: {
      date: item.end_time,
      level: item.level,
      timems: item.timems,
      bv: item.bv,
      nf: false,
      state: item.state,
      videoId: item.id,
      sourceName: '网站数据',
    },
    ioe: null,
    excluded,
    ruleId: excluded ? `rule-${item.id}` : null,
  }
}

describe('慢局候选与均值预览', () => {
  it('按难度分别取慢局前 N，中位数来自完整有效范围', () => {
    const videos = [
      video(1, 'b', 10),
      video(2, 'b', 20),
      video(3, 'b', 30),
      video(4, 'b', 40),
      video(5, 'i', 30),
      video(6, 'i', 60),
      video(7, 'e', 100),
      video(8, 'e', 200),
    ]
    const entries = videos.map((item, index) => entry(item, index))
    const result = buildExclusionCandidates(
      entries,
      videos,
      directCandidateScope('site', { b: 10, i: 30, e: 100 }),
      20,
    )

    expect(result.baselines.b).toMatchObject({ count: 4, total: 100, mean: 25, median: 25 })
    expect(result.baselines.i).toMatchObject({ count: 2, total: 90, mean: 45, median: 45 })
    expect(result.baselines.e).toMatchObject({ count: 2, total: 300, mean: 150, median: 150 })
    const bRows = result.candidates.filter((row) => row.level === 'b')
    expect(bRows.map((row) => row.time)).toEqual([40, 30, 20, 10])
    expect(bRows[0]).toMatchObject({ before: 25, after: 20, preview: 'decrease' })
    expect(bRows[0]!.delta).toBeCloseTo(-5, 10)
  })

  it('排除记录、低于 3BV 下限、无效用时和范围外记录都不进入候选与基准', () => {
    const inside = video(1, 'b', 20)
    const excluded = video(2, 'b', 40)
    const lowBv = video(3, 'b', 50, { bv: 9 })
    const invalid = video(4, 'b', 70, { timems: 0 })
    const unapproved = video(5, 'b', 80, { state: 'p' })
    const outside = video(6, 'b', 90, { date: '2026-09-01T12:00:00+08:00' })
    const videos = [inside]
    const entries = [
      entry(inside, 0),
      entry(excluded, 1, true),
      entry(lowBv, 2),
      entry(invalid, 3),
      entry(unapproved, 4),
      entry(outside, 5),
    ]
    const scope = {
      ...directCandidateScope('site', { b: 10, i: 30, e: 100 }),
      start: Date.parse('2026-10-25T00:00:00+08:00'),
      endExclusive: Date.parse('2026-11-02T00:00:00+08:00'),
    }
    const result = buildExclusionCandidates(entries, videos, scope, 20)
    expect(result.baselines.b).toMatchObject({ count: 1, total: 20 })
    expect(result.candidates.map((row) => row.video.id)).toEqual([1])
    expect(result.candidates[0]!.preview).toBe('empty')
    expect(result.candidates[0]!.after).toBeNull()
  })

  it('候选数量只截取慢局，不改变完整基准；并列用时保持项目稳定顺序', () => {
    const videos = Array.from({ length: 60 }, (_, index) =>
      video(index + 1, 'i', 30 + (index % 5)),
    )
    // 追加两条用时相同的慢局，验证并列顺序按原始 ID。
    videos.push(video(100, 'i', 90), video(101, 'i', 90))
    const entries = videos.map((item, index) => entry(item, index))
    const scope = directCandidateScope('site', { b: 10, i: 30, e: 100 })
    const twenty = buildExclusionCandidates(entries, videos, scope, 20)
    const fifty = buildExclusionCandidates(entries, videos, scope, 50)
    expect(twenty.baselines.i!.count).toBe(62)
    expect(fifty.baselines.i!.count).toBe(62)
    expect(twenty.candidates).toHaveLength(20)
    expect(fifty.candidates).toHaveLength(50)
    expect(twenty.candidates.slice(0, 2).map((row) => row.video.id)).toEqual([100, 101])
    expect(twenty.baselines.i!.median).toBe(32)
  })

  it('均值下降按未舍入差值排序，并区分下降、不变和升高', () => {
    const videos = [
      video(1, 'b', 10),
      video(2, 'b', 20),
      video(3, 'b', 30),
    ]
    const entries = videos.map((item, index) => entry(item, index))
    const result = buildExclusionCandidates(
      entries,
      videos,
      directCandidateScope('site', { b: 10, i: 30, e: 100 }),
      20,
    )
    expect(result.candidates.map((row) => row.preview)).toEqual([
      'decrease',
      'zero',
      'increase',
    ])
    const sorted = sortCandidateRows(result.candidates)
    expect(sorted[0]!.video.id).toBe(3)
    expect(sorted[1]!.video.id).toBe(2)
    expect(sorted[2]!.video.id).toBe(1)
  })

  it('实际排除后当前范围均值与单行预览一致', () => {
    const all = [
      video(1, 'e', 60, { bv: 120 }),
      video(2, 'e', 120, { bv: 120 }),
      video(3, 'e', 180, { bv: 120 }),
    ]
    const entries = all.map((item, index) => entry(item, index))
    const result = buildExclusionCandidates(
      entries,
      all,
      directCandidateScope('site', { b: 10, i: 30, e: 100 }),
      20,
    )
    const target = result.candidates.find((row) => row.video.id === 3)!
    const remaining = all.filter((item) => item.id !== 3)
    const remainingEntries = remaining.map((item, index) => entry(item, index))
    const after = buildExclusionCandidates(
      remainingEntries,
      remaining,
      directCandidateScope('site', { b: 10, i: 30, e: 100 }),
      20,
    )
    expect(after.baselines.e!.mean).toBeCloseTo(target.after!, 10)
  })

  it('日期交集保留已应用边界，空交集不扩回其他日期', () => {
    expect(
      intersectCandidateRange(
        Date.parse('2026-10-01T00:00:00+08:00'),
        Date.parse('2026-11-01T00:00:00+08:00'),
        {
          start: Date.parse('2026-10-15T00:00:00+08:00'),
          endExclusive: Date.parse('2026-11-11T00:00:00+08:00'),
        },
      ),
    ).toEqual({
      start: Date.parse('2026-10-15T00:00:00+08:00'),
      endExclusive: Date.parse('2026-11-01T00:00:00+08:00'),
    })
    expect(
      intersectCandidateRange(
        Date.parse('2026-09-01T00:00:00+08:00'),
        Date.parse('2026-09-02T00:00:00+08:00'),
        {
          start: Date.parse('2026-10-15T00:00:00+08:00'),
          endExclusive: Date.parse('2026-11-11T00:00:00+08:00'),
        },
      ),
    ).toEqual({
      start: Date.parse('2026-10-15T00:00:00+08:00'),
      endExclusive: Date.parse('2026-10-15T00:00:00+08:00'),
    })
  })
})
