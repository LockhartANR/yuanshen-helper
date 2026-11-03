import { describe, expect, it } from 'vitest'
import { analyzeGames } from '../src/features/player-stats/analysis'
import type { AnalysisGame } from '../src/features/player-stats/analysis'
import type { Video } from '../src/features/player-stats/model'
import {
  buildLsfHistory,
  formatLsfDelta,
  levelContributionTotal,
  lsfRange,
} from '../src/features/player-stats/lsf-history'
import type { LsfEvent, LsfHistory, LsfHistoryOptions } from '../src/features/player-stats/lsf-history'
import {
  WORKBOOK_ANCHORS,
  WORKBOOK_LEVEL_WEIGHTS,
  WORKBOOK_SOFT_WEIGHTS,
  ratingSnapshot,
} from '../src/features/player-stats/ratings'
import type { Level } from '../src/features/player-stats/model'

const DAY = 86_400_000
const BASE = Date.parse('2025-01-01T00:00:00.000Z')
const NOW = Date.parse('2026-06-01T00:00:00.000Z')

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

function toGames(videos: Video[]): AnalysisGame[] {
  return analyzeGames(videos, {}, 1)
}

function options(overrides: Partial<LsfHistoryOptions> = {}): LsfHistoryOptions {
  return { anchors: WORKBOOK_ANCHORS, now: NOW, ...overrides }
}

function expectSnapshotMatches(history: ReturnType<typeof buildLsfHistory>, games: AnalysisGame[], opts: LsfHistoryOptions): void {
  const direct = ratingSnapshot(
    games,
    opts.anchors,
    opts.softWeights ?? WORKBOOK_SOFT_WEIGHTS,
    opts.levelWeights ?? WORKBOOK_LEVEL_WEIGHTS,
    opts.floors,
  )
  expect(history.snapshot.soft).toBeCloseTo(direct.soft, 9)
  expect(history.snapshot.nfSoft).toBeCloseTo(direct.nfSoft, 9)
  expect(history.snapshot.lsf).toBeCloseTo(direct.lsf, 9)
  expect(history.snapshot.title).toBe(direct.title)
  expect(history.snapshot.nfTitle).toBe(direct.nfTitle)
  for (let index = 0; index < 3; index += 1) {
    expect(history.snapshot.levels[index]?.soft).toBeCloseTo(direct.levels[index]?.soft ?? 0, 10)
    expect(history.snapshot.levels[index]?.nfSoft).toBeCloseTo(direct.levels[index]?.nfSoft ?? 0, 10)
    expect(history.snapshot.levels[index]?.lsf).toBeCloseTo(direct.levels[index]?.lsf ?? 0, 10)
  }
  // 三级 LSF 贡献相加必须等于综合 LSF。
  const sum = history.snapshot.levels.reduce((total, level) => total + level.lsf, 0)
  expect(sum).toBeCloseTo(history.snapshot.lsf, 9)
}

function seeded(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
}

/** 明细贡献合计必须能加回事件差值（相对容差，避免大金额下的浮点误差）。 */
function expectContributionMatches(event: LsfEvent, digits = 9): void {
  const total = levelContributionTotal(event.change)
  const scale = Math.max(1, Math.abs(event.delta), Math.abs(total))
  expect(Math.abs(total - event.delta)).toBeLessThan(0.5 * 10 ** -digits * scale)
}

function randomVideos(): Video[] {
  const random = seeded(20261103)
  const videos: Video[] = []
  const levels: Array<[Level, number, [number, number]]> = [
    ['b', 20, [6, 30]],
    ['i', 60, [25, 120]],
    ['e', 150, [80, 400]],
  ]
  for (let index = 0; index < 45; index += 1) {
    const [level, bv, [minTime, maxTime]] = levels[Math.floor(random() * levels.length)] as [
      Level,
      number,
      [number, number],
    ]
    const time = minTime + random() * (maxTime - minTime)
    const nf = random() < 0.35
    videos.push(
      video({
        id: index + 1,
        level,
        bv: bv + Math.floor(random() * 5),
        timems: Math.round(time * 1000),
        right: nf ? 0 : 3,
        right_ce: nf ? 0 : 3,
        // 每天最多四条，允许日期并列。
        end_time: iso(Math.floor(index / 4)),
        upload_time: iso(Math.floor(index / 4)),
      }),
    )
  }
  return videos
}

describe('梁山分历史：与直接快照一致', () => {
  it('每个历史前缀的增量重建都等于该前缀直接调用 ratingSnapshot', () => {
    const games = toGames(randomVideos())
    const opts = options()
    for (let size = 1; size <= games.length; size += 1) {
      const prefix = games.slice(0, size)
      const history = buildLsfHistory(prefix, opts)
      expectSnapshotMatches(history, prefix, opts)
    }
  })

  it('自定义锚点、权重与 3BV 下限下仍然一致', () => {
    const games = toGames(randomVideos())
    const opts = options({
      anchors: { ...WORKBOOK_ANCHORS, 'std:bt': 1.9, 'nf:es': 140 },
      softWeights: {
        b: { t: 20, b: 50, s: 30 },
        i: { t: 40, b: 30, s: 30 },
        e: { t: 34, b: 33, s: 33 },
      },
      levelWeights: { b: 8, i: 12, e: 18 },
      floors: { b: 12, i: 40, e: 120 },
    })
    const history = buildLsfHistory(games, opts)
    expectSnapshotMatches(history, games, opts)
    const counted = games.filter((game) => game.bv >= opts.floors![game.level])
    expect(history.includedCount).toBe(counted.length)
    expect(history.excludedCount).toBe(games.length - counted.length)
  })

})

describe('梁山分历史：Top5 与事件归因', () => {
  it('用时越低越好，新成绩替换榜尾并记录名次与被替换值', () => {
    const times = [20, 18, 16, 14, 12, 10]
    const videos = times.map((time, index) =>
      video({ id: index + 1, level: 'b', bv: 20, timems: time * 1000, end_time: iso(index) }),
    )
    const games = toGames(videos)
    const history = buildLsfHistory(games, options())
    const last = history.events[history.events.length - 1] as LsfEvent
    expect(last.game.video.id).toBe(6)
    const timeBoard = last.change.boards.find((board) => board.metric === 't')
    expect(timeBoard?.rank).toBe(1)
    expect(timeBoard?.value).toBe(10)
    expect(timeBoard?.replacedValue).toBe(20)
    expect(timeBoard?.replacedVideo?.id).toBe(1)
    const bvsBoard = last.change.boards.find((board) => board.metric === 'b')
    expect(bvsBoard?.rank).toBe(1)
    expect(last.delta).toBeGreaterThan(0)
  })

  it('进不了前五的成绩不生成流水', () => {
    const videos = [10, 11, 12, 13, 14].map((time, index) =>
      video({ id: index + 1, level: 'b', bv: 20, timems: time * 1000, end_time: iso(index) }),
    )
    videos.push(video({ id: 6, level: 'b', bv: 20, timems: 30000, end_time: iso(6) }))
    const games = toGames(videos)
    const history = buildLsfHistory(games, options())
    expect(history.events.some((event) => event.game.video.id === 6)).toBe(false)
    expect(history.events.length).toBeLessThan(games.length)
  })

  it('指标并列时后到的成绩排在已有一条之后，名次不抢占', () => {
    const first = video({ id: 1, level: 'b', bv: 20, timems: 10000, end_time: iso(0) })
    const second = video({ id: 2, level: 'b', bv: 20, timems: 10000, end_time: iso(1) })
    const history = buildLsfHistory(toGames([first, second]), options())
    const last = history.events[history.events.length - 1] as LsfEvent
    const board = last.change.boards.find((item) => item.metric === 't')
    expect(board?.rank).toBe(2)
    expect(board?.replacedValue).toBeNull()
  })

  it('NF 录像同时改写普通榜与 NF 榜，但仍只算一次事件', () => {
    const videos = [12, 13, 14, 15, 16].map((time, index) =>
      video({ id: index + 1, level: 'b', bv: 20, timems: time * 1000, end_time: iso(index) }),
    )
    videos.push(
      video({ id: 9, level: 'b', bv: 20, timems: 8000, end_time: iso(6), right: 0, right_ce: 0 }),
    )
    const games = toGames(videos)
    const history = buildLsfHistory(games, options())
    const nfEvents = history.events.filter((event) => event.game.video.id === 9)
    expect(nfEvents).toHaveLength(1)
    const event = nfEvents[0] as LsfEvent
    expect(event.game.nf).toBe(true)
    expect(event.sources).toEqual(
      expect.arrayContaining(['用时', 'NF用时', 'NF3BVS', 'NFSTNB']),
    )
    expect(event.sources).not.toContain('普通用时')
    const levelChange = event.change
    const contributed = levelChange.boards.reduce(
      (total, board) => total + board.contributionDelta,
      0,
    )
    expect(contributed).toBeCloseTo(event.delta, 9)
    expect(event.lsfAfter - event.lsfBefore).toBeCloseTo(event.delta, 12)
  })

  it('没有有效录像时返回零分快照和空历史', () => {
    const empty = buildLsfHistory([], options())
    expect(empty.snapshot.soft).toBe(0)
    expect(empty.snapshot.lsf).toBe(0)
    expect(empty.events).toEqual([])
    expect(empty.includedCount).toBe(0)
    expect(empty.baseline).toBe(0)

  })
})

describe('梁山分历史：时间与排序', () => {
  it('同一时间的录像按网站 ID / CSV 导入顺序保持内部顺序', () => {
    const videos = [
      video({ id: 2, level: 'b', bv: 20, timems: 9000, end_time: iso(0) }),
      video({ id: 1, level: 'b', bv: 20, timems: 8000, end_time: iso(0) }),
    ]
    const history = buildLsfHistory(toGames(videos), options())
    expect(history.events.map((event) => event.game.video.id)).toEqual([1, 2])
    expect(new Set(history.events.map((event) => event.id)).size).toBe(history.events.length)
  })

  it('CSV 记录用导入顺序作为同分先后，事件 ID 不重复', () => {
    const videos = [0, 1, 2].map((order) =>
      video({
        id: -(order + 1),
        importOrder: order,
        csvNf: false,
        level: 'b',
        bv: 20,
        timems: 9000,
        end_time: iso(0),
        upload_time: iso(0),
      }),
    )
    const history = buildLsfHistory(toGames(videos), options())
    expect(history.events.map((event) => event.game.video.importOrder)).toEqual([0, 1, 2])
    expect(new Set(history.events.map((event) => event.id)).size).toBe(history.events.length)
  })

  it('结束时间缺失时退回上传时间并标记', () => {
    const videos = [
      video({ id: 1, level: 'b', bv: 20, timems: 12000, end_time: null, upload_time: iso(3) }),
    ]
    const history = buildLsfHistory(toGames(videos), options())
    const event = history.events[0] as LsfEvent
    expect(event.dateFromUpload).toBe(true)
    expect(event.date).toBe(BASE + 3 * DAY)
    expect(event.undated).toBe(false)
  })

  it('两个时间都不可用时作为未定日期基线，不显示成 1970 年', () => {
    const videos = [
      video({ id: 1, level: 'b', bv: 20, timems: 12000, end_time: null, upload_time: '' }),
    ]
    const games = toGames(videos)
    const history = buildLsfHistory(games, options())
    expect(history.undatedCount).toBe(1)
    const event = history.events[0] as LsfEvent
    expect(event.undated).toBe(true)
    expect(event.date).toBe(0)
    expect(history.baseline).toBeCloseTo(history.snapshot.lsf, 9)
    const range = lsfRange(history, { start: null, endExclusive: null, now: NOW })
    expect(range.events).toEqual([])
    expect(range.baseline).toBeCloseTo(history.snapshot.lsf, 9)
    expect(range.latest).toBeCloseTo(history.snapshot.lsf, 9)
    expectSnapshotMatches(history, games, options())
  })
})

describe('梁山分历史：时间范围与时段统计', () => {
  function dayEvents(): ReturnType<typeof buildLsfHistory> {
    const videos = [20, 18, 16].map((time, index) =>
      video({ id: index + 1, level: 'b', bv: 20, timems: time * 1000, end_time: iso(index) }),
    )
    return buildLsfHistory(toGames(videos), options())
  }

  it('起点只累计严格早于 cutoff 的记录，恰好在边界的事件计入区间', () => {
    const history = dayEvents()
    const [first, second, third] = history.events as [LsfEvent, LsfEvent, LsfEvent]
    const range = lsfRange(history, { start: second.date, endExclusive: null, now: NOW })
    expect(range.baseline).toBeCloseTo(first.lsfAfter, 9)
    expect(range.events.map((event) => event.id)).toEqual([second.id, third.id])
    expect(range.change).toBeCloseTo(third.lsfAfter - first.lsfAfter, 9)
    expect(range.upCount).toBe(2)
    expect(range.downCount).toBe(0)
    expect(range.maxGain).not.toBeNull()
    expect(range.maxGainDate).not.toBeNull()
    expect(range.points[0]?.eventId).toBeNull()
    expect(range.points[0]?.lsf).toBeCloseTo(range.baseline, 9)
  })

  it('空区间、早于全部记录与晚于全部记录的区间', () => {
    const history = dayEvents()
    const empty = lsfRange(history, { start: NOW - DAY, endExclusive: null, now: NOW })
    expect(empty.events).toEqual([])
    expect(empty.change).toBe(0)
    expect(empty.upCount).toBe(0)
    expect(empty.maxGain).toBeNull()
    expect(empty.maxGainDate).toBeNull()
    expect(empty.points).toHaveLength(1)

    const all = lsfRange(history, { start: null, endExclusive: null, now: NOW })
    expect(all.baseline).toBe(0)
    expect(all.events).toHaveLength(3)
    expect(all.latest).toBeCloseTo(history.snapshot.lsf, 9)

    const afterAll = lsfRange(history, { start: NOW + DAY, endExclusive: null, now: NOW + DAY })
    expect(afterAll.baseline).toBeCloseTo(history.snapshot.lsf, 9)
    expect(afterAll.change).toBe(0)
    expect(afterAll.events).toEqual([])
  })

  it('时间晚于当前时点的记录不计入时段历史，只留在完整快照里', () => {
    const videos = [
      video({ id: 1, level: 'b', bv: 20, timems: 20000, end_time: iso(0) }),
      video({ id: 2, level: 'b', bv: 20, timems: 18000, end_time: iso(1) }),
      video({ id: 3, level: 'b', bv: 20, timems: 12000, end_time: new Date(NOW + DAY).toISOString() }),
    ]
    const history = buildLsfHistory(toGames(videos), options())
    expect(history.futureCount).toBe(1)
    const range = lsfRange(history, { start: null, endExclusive: null, now: NOW })
    expect(range.events).toHaveLength(2)
    expect(range.latest).toBeLessThan(history.snapshot.lsf)
    expect(history.snapshot.lsf).toBeCloseTo(
      ratingSnapshot(toGames(videos), WORKBOOK_ANCHORS).lsf,
      9,
    )
  })
})

describe('梁山分历史：参数与数据变化', () => {
  it('补入旧录像会插入其结束时间位置，并重建后续历史', () => {
    const older = video({ id: 1, level: 'b', bv: 20, timems: 25000, end_time: iso(0) })
    const newer = [2, 3].map((id, index) =>
      video({ id, level: 'b', bv: 20, timems: (12000 - index * 1000), end_time: iso(index + 5) }),
    )
    const withoutOlder = buildLsfHistory(toGames(newer), options())
    const withOlder = buildLsfHistory(toGames([older, ...newer]), options())
    expect(withOlder.events[0]?.game.video.id).toBe(1)
    expect(withOlder.events[0]?.date).toBe(BASE)
    expect(withoutOlder.snapshot.lsf).not.toBeCloseTo(withOlder.snapshot.lsf, 9)
    expect(withOlder.snapshot.lsf).toBeCloseTo(
      ratingSnapshot(toGames([older, ...newer]), WORKBOOK_ANCHORS).lsf,
      9,
    )
  })

  it('不足 0.01 的真实变动仍生成事件，并显示为 +<0.01', () => {
    const videos = [10, 10, 10, 10, 10].map((time, index) =>
      video({ id: index + 1, level: 'b', bv: 20, timems: time * 1000, end_time: iso(index) }),
    )
    videos.push(video({ id: 9, level: 'b', bv: 20, timems: 9999, end_time: iso(9) }))
    const history = buildLsfHistory(toGames(videos), options())
    const event = history.events[history.events.length - 1] as LsfEvent
    expect(event.game.video.id).toBe(9)
    expect(event.delta).toBeGreaterThan(0)
    expect(event.delta).toBeLessThan(0.005)
    expect(formatLsfDelta(event.delta)).toBe('+<0.01')
  })

  it('负向变化保留符号，流水不只存正向事件', () => {
    // 真实用时大于 999.999 秒时，后一条更慢的成绩补入空位仍会拉低该项目。
    const slow = video({ id: 1, level: 'b', bv: 20, timems: 1_200_000, end_time: iso(0) })
    const slower = video({ id: 2, level: 'b', bv: 10, timems: 3_000_000, end_time: iso(1) })
    const history = buildLsfHistory(toGames([slow, slower]), options())
    const [first, second] = history.events as [LsfEvent, LsfEvent]
    const firstTime = first.change.boards.find((board) => board.metric === 't')
    expect(firstTime?.avgBefore).toBeCloseTo(999.999, 9)
    expect(firstTime?.avgAfter).toBeCloseTo((1200 + 4 * 999.999) / 5, 9)
    const secondTime = second.change.boards.find((board) => board.metric === 't')!
    expect(secondTime.replacedValue).toBeNull()
    expect(secondTime.avgAfter).toBeGreaterThan(secondTime.avgBefore)
    expect(second.delta).toBeLessThan(0)
    expect(formatLsfDelta(second.delta).startsWith('−')).toBe(true)
    const range = lsfRange(history, { start: null, endExclusive: null, now: NOW })
    expect(range.upCount).toBe(1)
    expect(range.downCount).toBe(1)
    expect(range.maxGain).toBeCloseTo(first.delta, 9)
    expect(range.maxGainDate).toBe(first.date)
  })
})

describe('梁山分历史：初始化基线贡献', () => {
  it('首条高级录像的明细加上初始化基线后等于总涨分', () => {
    const only = video({ id: 1, level: 'e', bv: 150, timems: 60_000, end_time: iso(0) })
    const history = buildLsfHistory(toGames([only]), options())
    const event = history.events[0] as LsfEvent
    const change = event.change
    const boardSum = change.boards.reduce((sum, board) => sum + board.contributionDelta, 0)

    // 该级此前按 0 计，各榜「变化前」却是空榜补位；差额就是初始化基线，必须显式加回。
    expect(event.delta).toBeGreaterThan(0)
    expect(boardSum).toBeLessThan(event.delta)
    expect(event.delta - boardSum).toBeCloseTo(change.baselineContribution, 9)
    expect(change.baselineContribution).toBeGreaterThan(20)
    expect(levelContributionTotal(event.change)).toBeCloseTo(event.delta, 9)
    expect(levelContributionTotal(change)).toBeCloseTo(change.lsfAfter - change.lsfBefore, 9)

    // 初始化基线只来自用时补位（3BVS / STNB 补 0），由普通 + NF 两部分组成。
    const stdTime = 20 * 0.97 * 32 * (WORKBOOK_ANCHORS['std:et']! / 999.999)
    const nfTime = 20 * 0.03 * 32 * (WORKBOOK_ANCHORS['nf:et']! / 999.999)
    expect(change.baselineContribution).toBeCloseTo(stdTime + nfTime, 9)
    expect(change.nfBaselineContribution).toBeCloseTo(nfTime, 9)
    expect(change.baseline).toBe(true)
    expect(change.nfPadded).toBe(true)
    expect(event.sources).toContain('NF补位')
    expect(event.lsfBefore).toBe(0)
    expect(event.lsfAfter).toBeCloseTo(history.snapshot.lsf, 9)
    expect(change.nfSoftBefore).toBe(0)
    expect(change.nfSoftAfter).toBeGreaterThan(0)
    expectSnapshotMatches(history, toGames([only]), options())
  })

  it('首条 NF 录像同样能加总，NF补位金额单独可见', () => {
    const only = video({
      id: 1,
      level: 'e',
      bv: 150,
      timems: 60_000,
      end_time: iso(0),
      right: 0,
      right_ce: 0,
    })
    const history = buildLsfHistory(toGames([only]), options())
    const event = history.events[0] as LsfEvent
    const change = event.change
    // 首条就是 NF 录像：六个榜都被写入，不再有「缺 NF」的补位说明。
    expect(change.nfPadded).toBe(false)
    expect(change.nfBaselineContribution).toBeGreaterThan(0)
    const nfTime = 20 * 0.03 * 32 * (WORKBOOK_ANCHORS['nf:et']! / 999.999)
    const stdTime = 20 * 0.97 * 32 * (WORKBOOK_ANCHORS['std:et']! / 999.999)
    expect(change.nfBaselineContribution).toBeCloseTo(nfTime, 9)
    expect(change.baselineContribution).toBeCloseTo(stdTime + nfTime, 9)
    expect(levelContributionTotal(event.change)).toBeCloseTo(event.delta, 9)
  })

  it('非首条事件没有初始化基线，贡献合计仍等于差值', () => {
    const videos = [20, 18, 16, 14, 12, 10].map((time, index) =>
      video({ id: index + 1, level: 'b', bv: 20, timems: time * 1000, end_time: iso(index) }),
    )
    const history = buildLsfHistory(toGames(videos), options())
    expect(history.events.length).toBeGreaterThan(1)
    for (const event of history.events) {
      const change = event.change
      if (!change.baseline) expect(change.baselineContribution).toBe(0)
      expect(levelContributionTotal(event.change)).toBeCloseTo(event.delta, 9)
    }
  })
})

describe('梁山分历史：有效日期统一', () => {
  it('结束时间为 epoch 时按回退后的上传时间排序', () => {
    const epochEnd = video({
      id: 1,
      level: 'e',
      bv: 150,
      timems: 20_000,
      end_time: '1970-01-01T00:00:00.000Z',
      upload_time: iso(100),
    })
    const earlier = video({ id: 2, level: 'e', bv: 150, timems: 30_000, end_time: iso(10) })
    const history = buildLsfHistory(toGames([epochEnd, earlier]), options())
    expect(history.events.map((event) => event.game.video.id)).toEqual([2, 1])
    expect(history.events[1]?.date).toBe(BASE + 100 * DAY)
    expect(history.events[1]?.dateFromUpload).toBe(true)
    expect(history.events.every((event) => !event.undated)).toBe(true)
  })

  it('未来上传时间的录像不影响截至当前的累计分数', () => {
    // 审查复现场景：当前一局 60 秒 / 150 BV（246.88），另有一条结束时间为 epoch、
    // 上传时间在未来的 20 秒成绩；旧实现会把它提前处理，把累计分数抬到 1445.56。
    const future = video({
      id: 1,
      level: 'e',
      bv: 150,
      timems: 20_000,
      end_time: '1970-01-01T00:00:00.000Z',
      upload_time: new Date(NOW + 30 * DAY).toISOString(),
    })
    const current = video({ id: 2, level: 'e', bv: 150, timems: 60_000, end_time: iso(0) })
    const history = buildLsfHistory(toGames([future, current]), options())
    expect(history.futureCount).toBe(1)

    const range = lsfRange(history, { start: null, endExclusive: null, now: NOW })
    expect(range.events.some((event) => event.game.video.id === 1)).toBe(false)
    // 截至当前只应包含那局 60 秒成绩。
    const onlyCurrent = buildLsfHistory(toGames([current]), options())
    expect(range.latest).toBeCloseTo(onlyCurrent.snapshot.lsf, 9)
    expect(range.latest).toBeCloseTo(246.884668, 4)
    // 完整快照仍按现有口径包含未来录像。
    expect(history.snapshot.lsf).toBeGreaterThan(range.latest)
  })
})

describe('梁山分历史：贡献明细不按均值阈值裁剪', () => {
  it('1 毫秒的改进在极小 3BVS 锚点下仍计入 3BVS 明细', () => {
    const anchors = { ...WORKBOOK_ANCHORS, 'std:eb': 0.00001 }
    const videos = Array.from({ length: 5 }, (_, index) =>
      video({ id: index + 1, level: 'e', bv: 150, timems: 6_000_000, end_time: iso(index) }),
    )
    videos.push(video({ id: 6, level: 'e', bv: 150, timems: 5_999_999, end_time: iso(6) }))
    const history = buildLsfHistory(toGames(videos), options({ anchors }))
    const event = history.events[history.events.length - 1] as LsfEvent
    expect(event.game.video.id).toBe(6)
    expect(event.delta).toBeGreaterThan(0.05)

    const board = event.change.boards.find((item) => item.metric === 'b')!
    // 原始均值变化低于 1e-9，但经锚点折算后的贡献是这次涨分的主要部分。
    expect(Math.abs(board.avgAfter - board.avgBefore)).toBeLessThan(1e-9)
    expect(Math.abs(board.contributionDelta)).toBeGreaterThan(0.01)
    expect(event.sources).toContain('3BVS')
    expectContributionMatches(event, 6)
  })

  it('慢成绩与自定义锚点下逐事件贡献守恒', () => {
    const anchors = { ...WORKBOOK_ANCHORS, 'std:eb': 0.002, 'std:bt': 0.5, 'nf:bs': 210 }
    const times = [10, 40, 12, 1000, 8, 120, 6, 30]
    const videos = times.map((time, index) =>
      video({
        id: index + 1,
        level: 'b',
        bv: 20,
        timems: Math.round(time * 1000),
        end_time: iso(index),
        ...(index % 3 === 2 ? { right: 0, right_ce: 0 } : {}),
      }),
    )
    const history = buildLsfHistory(toGames(videos), options({ anchors }))
    expect(history.events.length).toBeGreaterThan(1)
    for (const event of history.events) {
      expect(event.change.boards.length).toBeGreaterThan(0)
      expectContributionMatches(event, 6)
    }
  })
})

describe('梁山分历史：任意时段查询', () => {
  const day = (month: number, date: number): number => new Date(2026, month - 1, date).getTime()

  function fakeEvent(id: string, date: number, delta: number, lsfAfter: number): LsfEvent {
    return { id, date, delta, lsfAfter, undated: false } as unknown as LsfEvent
  }

  function fakeHistory(events: LsfEvent[]): LsfHistory {
    return { events } as unknown as LsfHistory
  }

  it('单日净增量按本地自然日聚合，正负一起求和', () => {
    const events = [
      fakeEvent('a', day(5, 1) + 3_600_000, 5, 5),
      fakeEvent('b', day(5, 1) + 7_200_000, 7, 12),
      fakeEvent('c', day(5, 1) + 10_800_000, -2, 10),
      fakeEvent('d', day(5, 2) + 3_600_000, 9, 19),
    ]
    const range = lsfRange(fakeHistory(events), { start: null, endExclusive: null, now: day(6, 1) })
    expect(range.events).toHaveLength(4)
    expect(range.maxGain).toBe(9)
    expect(range.maxGainEventId).toBe('d')
    // 5 月 1 日净增 +10，大于 5 月 2 日的 +9。
    expect(range.maxDayGain).toBe(10)
    expect(range.maxDayDate).toBe(day(5, 1))
    expect(range.maxDayEventId).toBe('c')
  })

  it('单局 / 单日并列都取最近一条', () => {
    const events = [
      fakeEvent('a', day(5, 1) + 3_600_000, 10, 10),
      fakeEvent('b', day(5, 2) + 3_600_000, 10, 20),
    ]
    const range = lsfRange(fakeHistory(events), { start: null, endExclusive: null, now: day(6, 1) })
    expect(range.maxGain).toBe(10)
    expect(range.maxGainEventId).toBe('b')
    expect(range.maxDayGain).toBe(10)
    expect(range.maxDayDate).toBe(day(5, 2))
    expect(range.maxDayEventId).toBe('b')
  })

  it('容差内视为并列，并列时保留较大值并指向最近一条', () => {
    const events = [
      fakeEvent('a', day(5, 1) + 3_600_000, 10, 10),
      fakeEvent('b', day(5, 2) + 3_600_000, 10 - 1e-10, 20 - 1e-10),
    ]
    const range = lsfRange(fakeHistory(events), { start: null, endExclusive: null, now: day(6, 1) })
    expect(range.maxGain).toBe(10)
    expect(range.maxGainEventId).toBe('b')
  })

  it('只有负增量时两个最大值都显示空值', () => {
    const events = [
      fakeEvent('a', day(5, 1) + 3_600_000, -3, -3),
      fakeEvent('b', day(5, 2) + 3_600_000, -1, -4),
    ]
    const range = lsfRange(fakeHistory(events), { start: null, endExclusive: null, now: day(6, 1) })
    expect(range.maxGain).toBeNull()
    expect(range.maxGainEventId).toBeNull()
    expect(range.maxDayGain).toBeNull()
    expect(range.maxDayDate).toBeNull()
    expect(range.maxDayEventId).toBeNull()
    expect(range.upCount).toBe(0)
    expect(range.downCount).toBe(2)
  })

  it('独立结束边界：起点前成绩作基线，终点后的成绩不计入', () => {
    const events = [
      fakeEvent('a', day(5, 1) + 3_600_000, 2, 2),
      fakeEvent('b', day(5, 2) + 3_600_000, 3, 5),
      fakeEvent('c', day(5, 3) + 3_600_000, 4, 9),
      fakeEvent('d', day(5, 4) + 3_600_000, 5, 14),
    ]
    const range = lsfRange(fakeHistory(events), {
      start: day(5, 2),
      endExclusive: day(5, 4),
      now: day(6, 1),
    })
    expect(range.start).toBe(day(5, 2))
    expect(range.end).toBe(day(5, 4))
    expect(range.baseline).toBe(2)
    expect(range.latest).toBe(9)
    expect(range.change).toBe(7)
    expect(range.events.map((event) => event.id)).toEqual(['b', 'c'])
    expect(range.points[0]?.date).toBe(day(5, 2))
  })

  it('终点晚于真实 now 时按 now 截断，未来事件不进入统计', () => {
    const now = day(5, 3) + 1_800_000
    const events = [
      fakeEvent('a', day(5, 1) + 3_600_000, 2, 2),
      fakeEvent('b', day(5, 2) + 3_600_000, 3, 5),
      fakeEvent('c', day(5, 4) + 3_600_000, 4, 9),
    ]
    const range = lsfRange(fakeHistory(events), {
      start: null,
      endExclusive: day(6, 1),
      now,
    })
    expect(range.end).toBe(now)
    expect(range.latest).toBe(5)
    expect(range.events.map((event) => event.id)).toEqual(['a', 'b'])
  })

  it('未定日期基线计入累计，但不参与最大涨分', () => {
    const undated = { ...fakeEvent('u', 0, 6, 6), undated: true } as LsfEvent
    const events = [undated, fakeEvent('a', day(5, 1) + 3_600_000, 2, 8)]
    const range = lsfRange(fakeHistory(events), { start: null, endExclusive: null, now: day(6, 1) })
    expect(range.baseline).toBe(6)
    expect(range.latest).toBe(8)
    expect(range.events.map((event) => event.id)).toEqual(['a'])
    expect(range.maxGainEventId).toBe('a')
    expect(range.maxDayEventId).toBe('a')
  })

  it('真实历史：起点前的成绩继续作为 Top5 基线', () => {
    const videos = [20, 18, 16].map((time, index) =>
      video({ id: index + 1, level: 'b', bv: 20, timems: time * 1000, end_time: iso(index) }),
    )
    const history = buildLsfHistory(toGames(videos), options())
    const events = history.events
    const second = events[1] as LsfEvent
    const range = lsfRange(history, { start: second.date, endExclusive: null, now: NOW })
    expect(range.baseline).toBeCloseTo((events[0] as LsfEvent).lsfAfter, 9)
    expect(range.events[0]?.id).toBe(second.id)
    expect(range.latest).toBeCloseTo(history.snapshot.lsf, 9)
  })
})
