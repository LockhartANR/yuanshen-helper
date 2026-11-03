import { describe, expect, it } from 'vitest'
import {
  activeDays,
  activityCalendar,
  analyzeGames,
  applyBvFloors,
  bucketStats,
  dogPredictions,
  buildGames,
  efficiencyTop,
  frontier,
  gcStats,
  heatmapStats,
  markPb,
  monthStats,
  othTop,
  periodGroups,
  rangeStats,
  rankGames,
  recentPb,
  subStats,
  summarize,
  todayStats,
  weekStats,
  yearStats,
} from '../src/features/player-stats/analysis'
import type { Video } from '../src/features/player-stats/model'
import { BV_RATE } from '../src/features/player-stats/gc-coefficients'

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

describe('buildGames', () => {
  it('只收标准模式、已过审、默认 3BV ≥ 10 的局', () => {
    const games = buildGames([
      video({ id: 1 }),
      video({ id: 2, bv: 9 }),
      video({ id: 3, mode: '05' }),
      video({ id: 4, state: 'a' }),
      video({ id: 5, timems: 0 }),
      video({ id: 6, ongoing_tournament: true }),
    ])
    expect(games.map((game) => game.video.id)).toEqual([1])
  })

  it('派生点击、路径、NF 和日期', () => {
    const [game] = buildGames([
      video({ left: 10, right: 0, double: 4, left_ce: 8, right_ce: 0, double_ce: 3 }),
    ])
    expect(game?.cl).toBe(14)
    expect(game?.ce).toBe(11)
    expect(game?.right).toBe(0)
    expect(game?.nf).toBe(true)
    expect(game?.path).toBe(800)
    expect(game?.date).toBe(Date.parse('2025-01-01T00:00:00.000Z'))
  })

  it.each([null, '', 'invalid', '1970-01-01T00:00:00.000Z', '1969-12-31T23:59:59.000Z'])(
    '结束时间 %s 无效时统一回退上传日期并保留来源',
    (end_time) => {
      const [game] = buildGames([video({ end_time, upload_time: '2025-02-03T00:00:00.000Z' })])
      expect(game).toMatchObject({
        date: Date.parse('2025-02-03T00:00:00.000Z'),
        dateFromUpload: true,
        undated: false,
      })
    },
  )

  it('有效结束时间优先；两个日期都无效时标记为未定日期', () => {
    const [valid] = buildGames([video({ upload_time: '2025-02-03T00:00:00.000Z' })])
    expect(valid).toMatchObject({
      date: Date.parse('2025-01-01T00:00:00.000Z'), dateFromUpload: false, undated: false,
    })
    for (const upload_time of ['', 'invalid', '1970-01-01T00:00:00.000Z', '1969-12-31T23:59:59.000Z']) {
      const [undated] = buildGames([video({ end_time: null, upload_time })])
      expect(undated).toMatchObject({ date: 0, dateFromUpload: false, undated: true })
    }
  })
})

describe('markPb / recentPb', () => {
  it('按时间顺序标记 PB 和被打破的旧纪录', () => {
    const games = buildGames([
      video({ id: 1, timems: 6000, end_time: '2025-01-01T00:00:00.000Z' }),
      video({ id: 2, timems: 5000, end_time: '2025-01-02T00:00:00.000Z' }),
      video({ id: 3, timems: 7000, end_time: '2025-01-03T00:00:00.000Z' }),
      video({ id: 4, timems: 4000, end_time: '2025-01-04T00:00:00.000Z' }),
    ])
    markPb(games)
    expect(games.map((game) => [game.pb, game.pbPrev])).toEqual([
      [true, null],
      [true, 6],
      [false, 5],
      [true, 5],
    ])
  })

  it('最近 PB 只给 30 天内、且打破旧纪录的', () => {
    const games = buildGames([
      video({ id: 1, timems: 6000, end_time: '2025-01-01T00:00:00.000Z' }),
      video({ id: 2, timems: 5000, end_time: '2025-01-02T00:00:00.000Z' }),
      video({ id: 3, timems: 4000, end_time: '2025-03-01T00:00:00.000Z' }),
    ])
    markPb(games)
    const now = Date.parse('2025-01-31T00:00:00.000Z')
    const recent = recentPb(games, now)
    expect(recent.map((entry) => entry.game.video.id)).toEqual([2])
    expect(recent[0]?.prev).toBe(6)
  })
})

describe('summarize', () => {
  it('按难度给出局数、PB、Top5 均速和 NF 占比', () => {
    const games = analyzeGames([
      video({ id: 1, timems: 5000, bv: 20 }),
      video({ id: 2, timems: 4000, bv: 20 }),
      video({ id: 3, timems: 4000, bv: 24, right: 0, right_ce: 0 }),
      video({ id: 4, level: 'e', bv: 120, timems: 40000, end_time: '2025-01-05T00:00:00.000Z' }),
    ])
    const summary = summarize(games, Date.parse('2025-01-31T00:00:00.000Z'))
    const beginner = summary[0]!
    expect(beginner.count).toBe(3)
    expect(beginner.pb?.video.id).toBe(2)
    expect(beginner.nfRatio).toBeCloseTo(1 / 3)
    expect(summary[2]!.count).toBe(1)
  })

  it('今日成绩按难度拆分 FL / NF，并给出最佳与平均', () => {
    const now = Date.now()
    const today = new Date(now).toISOString()
    const games = analyzeGames([
      video({ id: 1, timems: 5000, bv: 20, right: 0, right_ce: 0, end_time: today }),
      video({ id: 2, timems: 7000, bv: 30, right: 2, right_ce: 2, end_time: today }),
    ])
    const beginner = todayStats(games, now)[0]!
    expect(beginner.count).toBe(2)
    expect(beginner.fl).toBe(1)
    expect(beginner.nf).toBe(1)
    expect(beginner.bestTime?.video.id).toBe(1)
    expect(beginner.bestBvs?.video.id).toBe(2)
    expect(beginner.avgTime).toBeCloseTo(6)
    expect(beginner.avgBv).toBeCloseTo(25)
  })
})

describe('rankGames', () => {
  it('按指标排序，时间越小越好、3BVS 越大越好', () => {
    const games = analyzeGames([
      video({ id: 1, timems: 5000, bv: 20 }),
      video({ id: 2, timems: 4000, bv: 20 }),
      video({ id: 3, timems: 6000, bv: 32 }),
    ])
    expect(rankGames(games, 'time').map((game) => game.video.id)).toEqual([2, 1, 3])
    expect(rankGames(games, 'bvs')[0]?.video.id).toBe(3)
  })

  it('可以按难度过滤', () => {
    const games = analyzeGames([
      video({ id: 1, level: 'b' }),
      video({ id: 2, level: 'i', bv: 40 }),
    ])
    expect(rankGames(games, 'time', 'i').map((game) => game.video.id)).toEqual([2])
  })
})

describe('weekStats', () => {
  it('按 初20 / 中12 / 高5 的槽位求和', () => {
    const videos: Video[] = []
    for (let index = 0; index < 25; index += 1) {
      videos.push(
        video({
          level: 'b',
          bv: 20,
          timems: 1000 + index * 100,
          end_time: '2025-01-06T04:00:00.000Z',
        }),
      )
    }
    for (let index = 0; index < 15; index += 1) {
      videos.push(
        video({
          level: 'i',
          bv: 50,
          timems: 8000 + index * 200,
          end_time: '2025-01-06T04:00:00.000Z',
        }),
      )
    }
    for (let index = 0; index < 8; index += 1) {
      videos.push(
        video({
          level: 'e',
          bv: 150,
          timems: 40000 + index * 1000,
          end_time: '2025-01-06T04:00:00.000Z',
        }),
      )
    }
    const weeks = weekStats(analyzeGames(videos), 1, Date.parse('2025-01-08T00:00:00.000Z'))
    const beginner = 20 * 1 + ((19 * 20) / 2) * 0.1
    const intermediate = 12 * 8 + ((11 * 12) / 2) * 0.2
    const expert = 5 * 40 + ((4 * 5) / 2) * 1
    expect(weeks[0]?.t37).toBeCloseTo(beginner + intermediate + expert, 0)
    expect(weeks[0]?.ppp).toBeGreaterThan(0)
    const levels = weeks[0]!.levels
    expect(levels.b.totals.time + levels.i.totals.time + levels.e.totals.time).toBeCloseTo(
      weeks[0]!.t37,
      6,
    )
    expect(levels.e.totals.time).toBeCloseTo(expert, 6)
    expect(levels.e.slots).toHaveLength(5)
  })

  it('不足槽位时用时按 10 / 30 / 99 秒补齐', () => {
    const games = analyzeGames([
      video({ id: 1, level: 'b', bv: 20, timems: 2000, end_time: '2025-01-06T04:00:00.000Z' }),
    ])
    const weeks = weekStats(games, 1, Date.parse('2025-01-08T00:00:00.000Z'))
    expect(weeks[0]?.t37).toBeCloseTo(2 + 19 * 10 + 12 * 30 + 5 * 99, 0)
  })
})

describe('monthStats', () => {
  it('按月给出平均值、PB 数和 STNB 占比', () => {
    const games = analyzeGames([
      video({ id: 1, timems: 6000, bv: 20, end_time: '2025-01-10T00:00:00.000Z' }),
      video({ id: 2, timems: 5000, bv: 20, end_time: '2025-01-20T00:00:00.000Z' }),
      video({ id: 3, timems: 4000, bv: 22, end_time: '2025-02-02T00:00:00.000Z' }),
    ])
    const months = monthStats(games, 'b')
    expect(months.map((month) => month.key)).toEqual(['2025-02', '2025-01'])
    expect(months[1]?.count).toBe(2)
    expect(months[1]?.avgTime).toBeCloseTo(5.5)
    expect(months[1]?.pbCount).toBe(2)
    expect(months[0]?.pbCount).toBe(1)
  })

  it('覆盖最早到最晚录像之间的全部月份，倒序排列', () => {
    const games = analyzeGames([
      video({ id: 1, end_time: '2025-01-10T00:00:00.000Z' }),
      video({ id: 2, end_time: '2025-03-20T00:00:00.000Z' }),
    ])
    const months = monthStats(games, 'b')
    expect(months.map((month) => month.key)).toEqual(['2025-03', '2025-02', '2025-01'])
    expect(months.map((month) => month.count)).toEqual([1, 0, 1])
  })
})

describe('activeDays', () => {
  it('最多只算 days 天，且不把未来的局算进来', () => {
    const games = analyzeGames([
      video({ id: 1, end_time: '2025-01-01T12:00:00.000Z' }),
      video({ id: 2, end_time: '2025-01-02T12:00:00.000Z' }),
      video({ id: 3, end_time: '2025-02-05T12:00:00.000Z' }),
    ])
    const now = Date.parse('2025-01-02T12:00:00.000Z')
    expect(activeDays(games, now, 30)).toBe(2)
  })
})

describe('bucketStats', () => {
  it('按 3BV 分档统计局数、占比和该档最好成绩', () => {
    const games = analyzeGames([
      video({ id: 1, bv: 10, timems: 3000 }),
      video({ id: 2, bv: 12, timems: 2000 }),
      video({ id: 3, bv: 20, timems: 4000 }),
    ])
    const buckets = bucketStats(games, 'b')
    expect(buckets.map((bucket) => bucket.start)).toEqual([10, 20])
    expect(buckets[0]?.count).toBe(2)
    expect(buckets[0]?.best.video.id).toBe(2)
    expect(buckets[0]?.share).toBeCloseTo(2 / 3)
  })
})

describe('subStats', () => {
  it('按用时档位累计，14 档', () => {
    const games = analyzeGames([
      video({ id: 1, timems: 2000 }),
      video({ id: 2, timems: 3000 }),
      video({ id: 3, timems: 5000 }),
    ])
    const tiers = subStats(games, 'b')
    expect(tiers).toHaveLength(14)
    expect(tiers[0]?.limit).toBeCloseTo(4.5)
    expect(tiers[0]?.count).toBe(2)
    expect(tiers[6]?.count).toBe(1)
    expect(tiers[0]?.every).toBeCloseTo(1.5)
  })
})

describe('efficiencyTop', () => {
  it('按 cl/s、移速、bv/cl 排序，并过滤缺少路径的局', () => {
    const games = analyzeGames([
      video({
        id: 1,
        left: 28,
        right: 2,
        double: 0,
        left_ce: 18,
        right_ce: 2,
        double_ce: 0,
        timems: 3000,
        path: 480,
      }),
      video({
        id: 2,
        left: 20,
        right: 0,
        left_ce: 15,
        right_ce: 0,
        timems: 3000,
        path: 0,
      }),
      video({
        id: 3,
        left: 38,
        right: 2,
        left_ce: 28,
        right_ce: 2,
        timems: 3000,
        path: 960,
      }),
    ])
    expect(efficiencyTop(games, 'b', 'cls')[0]?.game.video.id).toBe(3)
    expect(efficiencyTop(games, 'b', 'mov').map((row) => row.game.video.id)).toEqual([3, 1])
    expect(efficiencyTop(games, 'b', 'ioe')[0]?.game.video.id).toBe(2)
  })
})

describe('othTop', () => {
  it('七项按指标方向排序，并跳过无效的 ce / path', () => {
    const games = analyzeGames([
      video({ id: 1, left_ce: 0, right_ce: 0, double_ce: 0, path: 0, isl: 1 }),
      video({
        id: 2,
        left_ce: 10,
        right_ce: 5,
        double_ce: 0,
        path: 320,
        isl: 2,
        op: 4,
      }),
      video({
        id: 3,
        left_ce: 8,
        right_ce: 2,
        double_ce: 0,
        path: 640,
        isl: 3,
        op: 2,
      }),
    ])
    expect(othTop(games, 'b', 'ce')[0]?.game.video.id).toBe(2)
    const invCe = othTop(games, 'b', 'invCe')[0]
    expect(invCe?.game.video.id).toBe(3)
    expect(invCe?.value).toBe(10)
    const invPath = othTop(games, 'b', 'invPath')[0]
    expect(invPath?.game.video.id).toBe(2)
    expect(invPath?.value).toBe(320)
    expect(othTop(games, 'b', 'invIs')[0]?.game.video.id).toBe(1)
    expect(othTop(games, 'b', 'op')[0]?.game.video.id).toBe(2)
  })
})

describe('applyBvFloors', () => {
  it('按各级下限过滤分析局', () => {
    const games = analyzeGames(
      [
        video({ id: 1, bv: 5 }),
        video({ id: 2, bv: 12 }),
        video({ id: 3, level: 'i', bv: 35 }),
        video({ id: 4, level: 'e', bv: 99 }),
      ],
      {},
      1,
    )
    const filtered = applyBvFloors(games, { b: 10, i: 30, e: 100 })
    expect(filtered.map((game) => game.video.id)).toEqual([2, 3])
  })
})

describe('rangeStats', () => {
  it('按 3BV 区间汇总局数和占比，并包含初级 2–9', () => {
    const games = analyzeGames(
      [
        video({ id: 1, bv: 5 }),
        video({ id: 2, bv: 12 }),
        video({ id: 3, bv: 18 }),
        video({ id: 4, bv: 25 }),
        video({ id: 5, bv: 40 }),
      ],
      {},
      2,
    )
    const ranges = rangeStats(games, 'b')
    expect(ranges.map((range) => range.count)).toEqual([1, 2, 1, 1])
    expect(ranges[1]?.share).toBeCloseTo(0.4)
    expect(ranges[0]?.theoryShare).toBeCloseTo(0.0614189796)
  })
})

describe('periodGroups', () => {
  it('月 / 年分组按时间倒序', () => {
    const games = analyzeGames([
      video({ id: 1, end_time: '2025-01-10T00:00:00.000Z' }),
      video({ id: 2, end_time: '2025-02-10T00:00:00.000Z' }),
      video({ id: 3, end_time: '2026-01-10T00:00:00.000Z' }),
    ])
    expect(periodGroups(games, 'b', 'month').map((group) => group.key)).toEqual([
      '2026-01',
      '2025-02',
      '2025-01',
    ])
    expect(periodGroups(games, 'b', 'year').map((group) => group.key)).toEqual(['2026', '2025'])
  })
})

describe('地图数据', () => {
  it('热力网格按时间和 3BVS 落格', () => {
    const games = analyzeGames([
      video({ id: 1, level: 'e', bv: 150, timems: 50000 }),
      video({ id: 2, level: 'e', bv: 150, timems: 50000 }),
    ])
    const map = heatmapStats(games, 'e')
    expect(map.cells.flat().reduce((sum, value) => sum + value, 0)).toBe(2)
    expect(map.maxCount).toBe(2)
  })

  it('效率前沿只保留不断刷新最高 3BVS 的点', () => {
    const games = analyzeGames([
      video({ id: 1, level: 'e', bv: 120, timems: 60000, end_time: '2025-06-01T00:00:00.000Z' }),
      video({ id: 2, level: 'e', bv: 130, timems: 55000, end_time: '2025-07-01T00:00:00.000Z' }),
      video({ id: 3, level: 'e', bv: 140, timems: 50000, end_time: '2026-07-01T00:00:00.000Z' }),
    ])
    const points = frontier(games, 'e')
    expect(points[0]?.time).toBe(50)
    expect(points[0]?.bvs).toBeCloseTo(2.8)
    expect(points).toHaveLength(1)
  })
})

describe('活跃日历', () => {
  it('按天统计最近 12 周局数', () => {
    const games = analyzeGames([
      video({ id: 1, end_time: '2025-01-06T04:00:00.000Z' }),
      video({ id: 2, end_time: '2025-01-06T05:00:00.000Z' }),
    ])
    const calendar = activityCalendar(games, Date.parse('2025-01-08T00:00:00.000Z'))
    expect(calendar.cells).toHaveLength(84)
    expect(calendar.cells.reduce((sum, cell) => sum + cell.count, 0)).toBe(2)
    expect(calendar.max).toBe(2)
    expect(calendar.total).toBe(2)
    expect(calendar.activeDays).toBe(1)
    expect(calendar.longestStreak).toBe(1)
    expect(calendar.best?.count).toBe(2)
  })
})

describe('年汇总与 GC 指标', () => {
  it('按年聚合局数、平均值和 PB 数', () => {
    const games = analyzeGames([
      video({ id: 1, end_time: '2025-01-10T00:00:00.000Z' }),
      video({ id: 2, end_time: '2025-02-10T00:00:00.000Z' }),
      video({ id: 3, end_time: '2026-01-10T00:00:00.000Z' }),
    ])
    const years = yearStats(games, 'b')
    expect(years.map((item) => [item.year, item.count])).toEqual([
      [2026, 1],
      [2025, 2],
    ])
  })

  it('年表点击字段缺失时只平均完整局', () => {
    const games = analyzeGames([
      video({
        id: 1,
        timems: 10000,
        left: 30,
        right: 0,
        double: 0,
        end_time: '2025-01-10T00:00:00.000Z',
      }),
      video({
        id: 2,
        timems: 10000,
        left: 12,
        right: 0,
        double: null,
        end_time: '2025-02-10T00:00:00.000Z',
      }),
    ])
    const year = yearStats(games, 'b')[0]!
    expect(year.hasCl).toBe(true)
    expect(year.avgCls).toBeCloseTo(3)
  })

  it('GC 指标按 3BV 分段给出 ASB / 分段战力 / 分段典型时', () => {
    const games = analyzeGames([
      video({ id: 1, level: 'e', bv: 150, timems: 50000 }),
      video({ id: 2, level: 'e', bv: 150, timems: 55000 }),
    ])
    const stats = gcStats(games)
    const expert = stats.find((item) => item.level === 'e')
    const rates = Array.from({ length: 10 }, (_, index) => BV_RATE[150 + index + 82 - 1]!)
    const rateSum = rates.reduce((sum, value) => sum + value, 0)
    const expectedPower = (3 * rates[0]!) / rateSum
    const expectedBv = rates.reduce((sum, rate, index) => sum + (150 + index) * rate, 0) / rateSum
    expect(expert?.asb).toBeCloseTo(3)
    expect(expert?.power).toBeCloseTo((3 * rates[0]!) / 100)
    expect(expert?.typicalTime).toBeCloseTo(expectedBv / expectedPower)
    const segment = expert?.segments.find((item) => item.start === 150)
    expect(segment?.end).toBe(159)
    expect(segment?.count).toBe(2)
    expect(segment?.power).toBeCloseTo(expectedPower)
    expect(segment?.bv).toBeCloseTo(expectedBv)
    expect(segment?.time).toBeCloseTo(expectedBv / expectedPower)
  })

  it.each([
    ['i', 134, 100, 104.03],
    ['e', 278, 220, 226.96],
  ] as const)('%s 在 %i 以上 rate 为 0，末段典型 3BV 正确', (level, limit, start, typicalBv) => {
    const atLimit = gcStats(analyzeGames([video({ level, bv: limit, timems: 90000 })])).find(
      (item) => item.level === level,
    )
    const aboveLimit = gcStats(
      analyzeGames([video({ level, bv: limit + 1, timems: 90000 })]),
    ).find((item) => item.level === level)
    expect(atLimit?.power).toBeGreaterThan(0)
    expect(aboveLimit?.power).toBe(0)
    expect(aboveLimit?.typicalTime).toBe(0)
    expect(atLimit?.segments.find((item) => item.start === start)?.bv).toBeCloseTo(typicalBv, 1)
  })

  it('初级 2–9 计入战力和典型时，但不计入 ASB', () => {
    const games = analyzeGames([video({ id: 1, level: 'b', bv: 5, timems: 1000 })], {}, 1)
    const beginner = gcStats(games).find((item) => item.level === 'b')
    const segment = beginner?.segments.find((item) => item.start === 2)
    expect(beginner?.asb).toBe(0)
    expect(segment?.count).toBe(1)
    expect(segment?.power).toBeGreaterThan(0)
    expect(segment?.time).toBeGreaterThan(0)
    expect(beginner?.typicalTime).toBeCloseTo(segment?.time ?? 0)
  })

})

describe('局数口径', () => {
  it('月 / 年局数包含 3BV<10，但不参与平均', () => {
    const videos = [
      video({ id: 1, bv: 20, timems: 5000, end_time: '2025-01-10T00:00:00.000Z' }),
      video({ id: 2, bv: 20, timems: 6000, end_time: '2025-01-20T00:00:00.000Z' }),
      video({ id: 3, bv: 5, timems: 1000, end_time: '2025-01-15T00:00:00.000Z' }),
    ]
    const games = analyzeGames(videos)
    const all = analyzeGames(videos, {}, 2)
    const month = monthStats(games, 'b', all)[0]
    expect(month?.days).toBe(3)
    expect(month?.count).toBe(3)
    expect(month?.hasScores).toBe(true)
    expect(month?.avgTime).toBeCloseTo(5.5)
    expect(yearStats(games, 'b', all)[0]?.count).toBe(3)
  })

  it('结束时间为空时回退上传时间', () => {
    const games = analyzeGames([
      video({
        end_time: '',
        upload_time: '2025-03-04T00:00:00.000Z',
      }),
    ])
    expect(games[0]?.date).toBe(Date.parse('2025-03-04T00:00:00.000Z'))
  })

  it('整月只有 3BV<10 时保留局数但不产出平均', () => {    const videos = [video({ id: 1, bv: 5, timems: 1000, end_time: '2025-01-15T00:00:00.000Z' })]
    const all = analyzeGames(videos, {}, 2)
    const month = monthStats(analyzeGames(videos), 'b', all)[0]
    expect(month?.count).toBe(1)
    expect(month?.hasScores).toBe(false)
    expect(yearStats(analyzeGames(videos), 'b', all)[0]?.hasScores).toBe(false)
  })

  it('月表用时分档和 3BVS 分档都按有效局数占比', () => {
    const videos = [
      video({ id: 1, bv: 10, timems: 2000, end_time: '2025-01-10T00:00:00.000Z' }),
      video({ id: 2, bv: 10, timems: 3000, end_time: '2025-01-11T00:00:00.000Z' }),
    ]
    const month = monthStats(analyzeGames(videos), 'b', analyzeGames(videos))[0]
    expect(month?.timeTierShare).toHaveLength(9)
    expect(month?.timeTierShare[0]).toBeCloseTo(0.5)
    expect(month?.bvsTierShare[0]).toBe(0)
  })
})

describe('NF 判定', () => {
  it('右键缺失不算 NF', () => {
    const game = analyzeGames([video({ right: null })])[0]
    expect(game?.nf).toBe(false)
    const nfGame = analyzeGames([video({ right: 0 })])[0]
    expect(nfGame?.nf).toBe(true)
  })

  it('点击字段缺失时 hasCl / hasCe 为 false，相关榜单跳过', () => {
    const games = analyzeGames([
      video({ left: null, right: 5, double: 0, left_ce: null, right_ce: null, double_ce: null }),
    ])
    const game = games[0]!
    expect(game.hasCl).toBe(false)
    expect(game.hasCe).toBe(false)
    expect(game.hasRight).toBe(true)
    expect(efficiencyTop(games, 'b', 'cls')).toHaveLength(0)
    expect(othTop(games, 'b', 'ce')).toHaveLength(0)
    expect(monthStats(games, 'b')[0]?.hasCl).toBe(false)
  })
})

describe('狗预测', () => {
  it('按年度累计达标数找基准，再向更快目标衰减', () => {
    const videos: Video[] = []
    for (let index = 0; index < 25; index += 1) {
      videos.push(
        video({
          id: index + 1,
          level: 'e',
          bv: 150,
          timems: 40000,
          end_time: '2024-06-01T00:00:00.000Z',
        }),
      )
    }
    const result = dogPredictions(analyzeGames(videos), [35])
    expect(result).toHaveLength(1)
    expect(result[0]?.year).toBe(2024)
    expect(result[0]?.baseTime).toBe(40)
    const cell = result[0]?.cells[0]
    expect(cell?.count).toBeGreaterThan(0)
    expect(cell?.count).toBeLessThan(25)
    expect(cell?.probability).toBeGreaterThan(0)
    expect(cell?.probability).toBeLessThanOrEqual(1)
  })
})
