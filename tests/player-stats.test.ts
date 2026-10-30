import { describe, expect, it } from 'vitest'
import {
  bvsOf,
  computePb,
  computeTop5,
  eligible,
  iqgOf,
  joinVideos,
  markDuplicates,
  stnbOf,
} from '../src/features/player-stats/compute'
import type { Video } from '../src/features/player-stats/model'

let nextId = 1

function video(overrides: Partial<Video> = {}): Video {
  return {
    id: nextId++,
    upload_time: '2025-01-01T00:00:00Z',
    state: 'c',
    ongoing_tournament: false,
    software: 'a',
    level: 'b',
    mode: '00',
    end_time: '2025-01-01T00:00:00Z',
    timems: 1000,
    bv: 10,
    left: 10,
    right: 0,
    double: 0,
    left_ce: 10,
    right_ce: 0,
    double_ce: 0,
    duplicate: false,
    duplicateOf: null,
    suspectDuplicate: false,
    ...overrides,
  }
}

describe('指标', () => {
  it('3bvs / iqg / stnb 按站点公式计算', () => {
    const item = video({ level: 'b', bv: 10, timems: 2000 })
    expect(bvsOf(item)).toBeCloseTo(5, 10)
    expect(iqgOf(item)).toBeCloseTo(10 / 2 ** 1.7, 10)
    expect(stnbOf(item)).toBeCloseTo(36 * (10 / 2 ** 1.7), 10)
  })

  it('bv 缺失或用时为 0 时不算指标', () => {
    expect(bvsOf(video({ bv: null }))).toBe(0)
    expect(stnbOf(video({ timems: 0 }))).toBe(0)
  })
})

describe('计入范围', () => {
  it('只认标准模式、标准等级、已过审且非比赛', () => {
    expect(eligible(video())).toBe(true)
    expect(eligible(video({ mode: '05' }))).toBe(false)
    expect(eligible(video({ level: 'c8_8_40' }))).toBe(false)
    expect(eligible(video({ state: 'a' }))).toBe(false)
    expect(eligible(video({ ongoing_tournament: true }))).toBe(false)
    expect(eligible(video({ bv: null }))).toBe(false)
    expect(eligible(video({ timems: 0 }))).toBe(false)
  })

  it('includeUnapproved 打开后纳入未过审', () => {
    expect(eligible(video({ state: 'd' }), { includeUnapproved: true })).toBe(true)
    expect(eligible(video({ state: 'd' }))).toBe(false)
  })

  it('NF 只看 right_ce === 0，null 不算 NF', () => {
    expect(eligible(video({ right_ce: 0 }), { nfOnly: true })).toBe(true)
    expect(eligible(video({ right_ce: 3 }), { nfOnly: true })).toBe(false)
    expect(eligible(video({ right_ce: null }), { nfOnly: true })).toBe(false)
  })

  it('软件筛选只认指定软件，all 不过滤', () => {
    const item = video({ software: 'e' })
    expect(eligible(item, { software: 'e' })).toBe(true)
    expect(eligible(item, { software: 'a' })).toBe(false)
    expect(eligible(item, { software: 'all' })).toBe(true)
  })

  it('hideDuplicates 同时隐藏确定重复与疑似重复', () => {
    expect(eligible(video({ duplicate: true }), { hideDuplicates: true })).toBe(false)
    expect(eligible(video({ suspectDuplicate: true }), { hideDuplicates: true })).toBe(false)
    expect(eligible(video({ duplicate: true }))).toBe(true)
  })
})

describe('判重', () => {
  it('同一局被传两次时只保留上传更早的一条', () => {
    const first = video({ id: 1, upload_time: '2025-01-01T00:00:00Z', timems: 1500 })
    const second = video({ id: 2, upload_time: '2025-02-01T00:00:00Z', timems: 1500 })
    expect(markDuplicates([second, first])).toBe(1)
    expect(first.duplicate).toBe(false)
    expect(second.duplicate).toBe(true)
    expect(second.duplicateOf).toBe(1)
  })

  it('成绩相同但点击不同不算重复', () => {
    const first = video({ id: 1, timems: 1500, left: 12 })
    const second = video({ id: 2, timems: 1500, left: 13 })
    expect(markDuplicates([first, second])).toBe(0)
    expect(second.duplicate).toBe(false)
    expect(second.suspectDuplicate).toBe(false)
  })

  it('没有结束时间时降级为疑似重复', () => {
    const first = video({ id: 1, end_time: null })
    const second = video({ id: 2, end_time: null })
    expect(markDuplicates([first, second])).toBe(0)
    expect(first.suspectDuplicate).toBe(false)
    expect(second.suspectDuplicate).toBe(true)
    expect(second.duplicateOf).toBe(1)
  })

  it('结束时间不同但点击结构一致时算疑似', () => {
    const first = video({ id: 1, end_time: '2025-01-01T00:00:00Z' })
    const second = video({ id: 2, end_time: '2025-01-02T00:00:00Z' })
    expect(markDuplicates([first, second])).toBe(0)
    expect(second.suspectDuplicate).toBe(true)
  })
})

describe('PB', () => {
  it('每个 3BV 取最快，按等级和 3BV 排序', () => {
    const slow = video({ id: 1, level: 'b', bv: 11, timems: 2000 })
    const fast = video({ id: 2, level: 'b', bv: 11, timems: 1800 })
    const other = video({ id: 3, level: 'b', bv: 9, timems: 1500 })
    const expert = video({ id: 4, level: 'e', bv: 120, timems: 50000 })

    const rows = computePb([slow, fast, other, expert])
    expect(rows.map((row) => `${row.level}:${row.bv}`)).toEqual(['b:9', 'b:11', 'e:120'])
    expect(rows[1]?.video.id).toBe(2)
  })

  it('同用时时按上传时间、再按 ID 取', () => {
    const later = video({ id: 5, upload_time: '2025-03-01T00:00:00Z', timems: 1800 })
    const earlier = video({ id: 6, upload_time: '2025-02-01T00:00:00Z', timems: 1800 })
    expect(computePb([later, earlier])[0]?.video.id).toBe(6)

    const big = video({ id: 8, timems: 1800 })
    const small = video({ id: 7, timems: 1800 })
    expect(computePb([big, small])[0]?.video.id).toBe(7)
  })

  it('软件筛选只影响 PB', () => {
    const avf = video({ id: 1, bv: 12, timems: 2000, software: 'a' })
    const evf = video({ id: 2, bv: 12, timems: 1900, software: 'e' })

    expect(computePb([avf, evf])[0]?.video.id).toBe(2)
    expect(computePb([avf, evf], { software: 'a' })[0]?.video.id).toBe(1)
  })
})

describe('前端成绩', () => {
  it('按 3BV 下限过滤，初级不足 10 的录像不进榜', () => {
    const low = video({ id: 1, level: 'b', bv: 9, timems: 500 })
    const ok = video({ id: 2, level: 'b', bv: 10, timems: 3000 })
    const group = computeTop5([low, ok]).find(
      (item) => item.level === 'b' && item.stat === 'time' && item.nf === false,
    )
    expect(group?.rows.map((row) => row.video.id)).toEqual([2])
  })

  it('用时升序，3bvs / stnb 降序', () => {
    const slow = video({ id: 1, bv: 12, timems: 3000 })
    const fast = video({ id: 2, bv: 10, timems: 2000 })
    const wide = video({ id: 3, bv: 20, timems: 4000 })

    const groups = computeTop5([slow, fast, wide])
    const time = groups.find((g) => g.level === 'b' && g.stat === 'time' && !g.nf)
    const bvs = groups.find((g) => g.level === 'b' && g.stat === 'bvs' && !g.nf)

    expect(time?.rows.map((row) => row.video.id)).toEqual([2, 1, 3])
    expect(bvs?.rows.map((row) => row.video.id)).toEqual([2, 3, 1])
  })

  it('普通榜包含 NF 录像，NF 榜只含 right_ce === 0', () => {
    const flagged = video({ id: 1, bv: 10, timems: 3000, right_ce: 2 })
    const nf = video({ id: 2, bv: 10, timems: 2000, right_ce: 0 })

    const groups = computeTop5([flagged, nf])
    const std = groups.find((g) => g.level === 'b' && g.stat === 'time' && !g.nf)
    const onlyNf = groups.find((g) => g.level === 'b' && g.stat === 'time' && g.nf)

    expect(std?.rows.map((row) => row.video.id)).toEqual([2, 1])
    expect(onlyNf?.rows.map((row) => row.video.id)).toEqual([2])
  })

  it('不吃软件筛选', () => {
    const avf = video({ id: 1, bv: 10, timems: 3000, software: 'a' })
    const evf = video({ id: 2, bv: 10, timems: 2000, software: 'e' })
    const group = computeTop5([avf, evf], { software: 'a' }).find(
      (item) => item.level === 'b' && item.stat === 'time' && !item.nf,
    )
    expect(group?.rows.map((row) => row.video.id)).toEqual([2, 1])
  })

  it('每个等级各三组、普通与 NF 各一套，共 18 组', () => {
    expect(computeTop5([])).toHaveLength(18)
  })
})

describe('合并列表与明细', () => {
  it('缺明细的 id 单独返回，不进入统计', () => {
    const metas = [
      { id: 1, upload_time: '2025-01-01T00:00:00Z', state: 'c', ongoing_tournament: false },
      { id: 2, upload_time: '2025-01-01T00:00:00Z', state: 'c', ongoing_tournament: false },
    ]
    const details = new Map([[1, video({ id: 1 })]])
    const { videos, missing } = joinVideos(metas, details)

    expect(videos.map((item) => item.id)).toEqual([1])
    expect(missing).toEqual([2])
  })
})
