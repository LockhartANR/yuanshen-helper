import { describe, expect, it } from 'vitest'
import {
  buildRankSearchIndex,
  searchRankingEntries,
} from '../src/features/custom-ranking/ranking-search'
import type { RankingResultRow } from '../src/features/custom-ranking/model'
import type { UserRecord } from '../src/features/user-search/model'

function row(playerId: number, rank: number | null): RankingResultRow {
  return { rank, playerId, games: 1, values: [1], samples: [1], valid: [true] }
}

function record(id: number, username: string): UserRecord {
  return { id, username } as unknown as UserRecord
}

const names = new Map<number, UserRecord>([
  [1, record(1, 'Alice')],
  [2, record(2, 'alice')],
  [3, record(3, 'Bob')],
  [12, record(12, 'Charlie')],
])
const rows = [row(1, 1), row(2, 2), row(3, null), row(12, 4)]
const entries = buildRankSearchIndex(rows, names)

describe('排行榜玩家候选', () => {
  it('名称和 ID 子串匹配不区分大小写，保留实际数组位置', () => {
    expect(searchRankingEntries(entries, 'ALI').candidates.map((item) => item.playerId)).toEqual([1, 2])
    expect(searchRankingEntries(entries, ' 12 ').candidates.map((item) => item.playerId)).toEqual([12])
    expect(searchRankingEntries(entries, '').candidates).toEqual([])
    expect(buildRankSearchIndex(rows, names)[1]!.index).toBe(1)
  })

  it('候选分组：ID 完全、名称完全、ID / 名称前缀、其他子串', () => {
    const extended = buildRankSearchIndex(
      [row(42, 3), row(4, 1), row(5, 2), row(6, 4), row(7, 5)],
      new Map([
        [42, record(42, 'other')],
        [4, record(4, '42')],
        [5, record(5, '42name')],
        [6, record(6, 'prefix42')],
        [7, record(7, 'middle42end')],
      ]),
    )
    expect(searchRankingEntries(extended, '42').candidates.map((item) => item.playerId)).toEqual([
      42, 4, 5, 6, 7,
    ])
  })

  it('同名玩家按 ID 区分，缺名称时仍可按 ID 搜索', () => {
    const sameNames = buildRankSearchIndex([row(9, 1), row(8, 2), row(7, null)], new Map([
      [9, record(9, 'Alice')],
      [8, record(8, 'Alice')],
    ]))
    expect(searchRankingEntries(sameNames, 'alice').candidates.map((item) => item.playerId)).toEqual([9, 8])
    expect(searchRankingEntries(sameNames, '7').candidates.map((item) => item.playerId)).toEqual([7])
    expect(searchRankingEntries(sameNames, '7').candidates[0]!.rank).toBeNull()
  })

  it('最多显示 8 项，更多时提示继续输入而非自动定位', () => {
    const many = buildRankSearchIndex(
      Array.from({ length: 20 }, (_, index) => row(index + 1, index + 1)),
      new Map(Array.from({ length: 20 }, (_, index) => [index + 1, record(index + 1, `match-${index}`)])),
    )
    const result = searchRankingEntries(many, 'match')
    expect(result.candidates).toHaveLength(8)
    expect(result.truncated).toBe(true)
    expect(searchRankingEntries(entries, 'not-found').candidates).toEqual([])
  })

  it('数千玩家中按名称 / ID 定位仍使用实际数组索引', () => {
    const total = 5000
    const bigRows = Array.from({ length: total }, (_, index) => row(index + 1, index + 1))
    const bigNames = new Map<number, UserRecord>(
      Array.from({ length: total }, (_, index) => [index + 1, record(index + 1, `player-${index + 1}`)]),
    )
    const index = buildRankSearchIndex(bigRows, bigNames)
    const matches = searchRankingEntries(index, 'player-49')
    expect(matches.candidates[0]!.playerId).toBe(49)
    expect(matches.candidates).toHaveLength(8)
    expect(matches.truncated).toBe(true)
    expect(searchRankingEntries(index, '4900').candidates[0]!.playerId).toBe(4900)
    // 玩家 4900 在结果数组中的位置是 4899；按 20 条分页应落在第 245 页（内部页码 244）。
    expect(Math.floor(searchRankingEntries(index, '4900').candidates[0]!.index / 20)).toBe(244)
  })
})
