import { displayName, type UserRecord } from '../user-search/model'
import type { RankingResultRow } from './model'

export const RANK_SEARCH_LIMIT = 8

/** 输入时复用：只在结果快照或名称修订变化时重建。 */
export interface RankSearchEntry {
  playerId: number
  name: string
  idText: string
  rank: number | null
  /** 当前排序结果中的实际数组位置，不按显示名次推算。 */
  index: number
}

export function buildRankSearchIndex(
  rows: RankingResultRow[],
  names: Map<number, UserRecord>,
): RankSearchEntry[] {
  return rows.map((row, index) => {
    const user = names.get(row.playerId)
    return {
      playerId: row.playerId,
      name: user ? displayName(user) : '',
      idText: String(row.playerId),
      rank: row.rank,
      index,
    }
  })
}

function matchGroup(entry: RankSearchEntry, query: string): number | null {
  const name = entry.name.toLowerCase()
  if (entry.idText === query) return 0
  if (name && name === query) return 1
  if (entry.idText.startsWith(query)) return 2
  if (name && name.startsWith(query)) return 3
  if (entry.idText.includes(query) || name.includes(query)) return 4
  return null
}

export interface RankSearchMatches {
  candidates: RankSearchEntry[]
  truncated: boolean
}

/** 不区分大小写的名称 / ID 子串匹配；同组按当前榜单行顺序，最多 limit 项。 */
export function searchRankingEntries(
  entries: RankSearchEntry[],
  rawQuery: string,
  limit = RANK_SEARCH_LIMIT,
): RankSearchMatches {
  const query = rawQuery.trim().toLowerCase()
  if (!query) return { candidates: [], truncated: false }
  const matched: Array<{ entry: RankSearchEntry; group: number }> = []
  for (const entry of entries) {
    const group = matchGroup(entry, query)
    if (group !== null) matched.push({ entry, group })
  }
  matched.sort((left, right) =>
    left.group !== right.group ? left.group - right.group : left.entry.index - right.entry.index,
  )
  return {
    candidates: matched.slice(0, Math.max(1, limit)).map((item) => item.entry),
    truncated: matched.length > Math.max(1, limit),
  }
}
