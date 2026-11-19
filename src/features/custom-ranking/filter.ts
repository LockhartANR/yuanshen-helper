import type {
  GlobalRankVideoRow,
  RankFilter,
  RankLevel,
  RankNfMode,
  RankState,
} from './model'
import { RANK_LEVELS } from './model'

const DAY_MS = 86_400_000

/** 严格解析 YYYY-MM-DD；日期按本地自然日处理。 */
export function parseLocalDate(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const date = new Date(year, month - 1, day)
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null
  }
  return date.getTime()
}

export function normalizeFilter(input: Partial<RankFilter> | null | undefined): RankFilter {
  const levels =
    input?.levels === undefined
      ? [...RANK_LEVELS]
      : input.levels.filter((level): level is RankLevel =>
          (RANK_LEVELS as readonly string[]).includes(level),
        )
  const states =
    input?.states === undefined
      ? (['c'] as RankState[])
      : input.states.filter((state): state is RankState =>
          ['c', 'a', 'b', 'd', 'e'].includes(state),
        )
  const modes =
    input?.modes === undefined
      ? ['00']
      : [...new Set(input.modes.filter((mode) => typeof mode === 'string' && mode.length > 0))]
  const floors = input?.floors ?? { b: 0, i: 0, e: 0 }
  const minGames = input?.minGames
  return {
    levels,
    states,
    modes,
    software:
      typeof input?.software === 'string' && input.software !== ''
        ? input.software
        : 'all',
    nf: input?.nf === 'only' || input?.nf === 'exclude' ? input.nf : 'all',
    from: typeof input?.from === 'string' ? input.from : '',
    to: typeof input?.to === 'string' ? input.to : '',
    floors: {
      b: Number.isFinite(floors.b) ? Math.max(0, Math.floor(floors.b)) : 0,
      i: Number.isFinite(floors.i) ? Math.max(0, Math.floor(floors.i)) : 0,
      e: Number.isFinite(floors.e) ? Math.max(0, Math.floor(floors.e)) : 0,
    },
    minGames:
      Number.isFinite(minGames) && (minGames ?? 0) > 0
        ? Math.max(1, Math.floor(minGames as number))
        : 1,
  }
}

export interface ResolvedDateRange {
  from: number | null
  toExclusive: number | null
  invalid: boolean
}

export function resolveDateRange(filter: RankFilter): ResolvedDateRange {
  const from = filter.from.trim() ? parseLocalDate(filter.from) : null
  const to = filter.to.trim() ? parseLocalDate(filter.to) : null
  const invalid =
    (filter.from.trim() !== '' && from === null) ||
    (filter.to.trim() !== '' && to === null) ||
    (from !== null && to !== null && from > to)
  return {
    from,
    toExclusive: to === null ? null : to + DAY_MS,
    invalid,
  }
}

/** 结束时间优先，缺失/无效时回退上传时间；与单玩家统计保持一致。 */
export function videoDate(row: GlobalRankVideoRow): number | null {
  const fields = row.detail?.fields
  const endTime = fields?.end_time
  if (typeof endTime === 'string' && endTime !== '') {
    const parsed = Date.parse(endTime)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  const uploadTime = fields?.upload_time
  if (typeof uploadTime === 'string' && uploadTime !== '') {
    const parsed = Date.parse(uploadTime)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  if (row.uploadTime) {
    const parsed = Date.parse(row.uploadTime)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return null
}

function nfMatches(nf: RankNfMode, value: unknown): boolean {
  if (nf === 'all') return true
  if (typeof value !== 'boolean') return false
  return nf === 'only' ? value : !value
}

/** 全局筛选；用于计算前的逐局筛选，不含公式或玩家聚合。 */
export function matchesFilter(row: GlobalRankVideoRow, filter: RankFilter): boolean {
  const detail = row.detail
  if (!detail) return false
  const fields = detail.fields
  const level = typeof fields.level === 'string' ? fields.level : ''
  if (!filter.levels.includes(level as RankLevel)) return false
  const mode = typeof fields.mode === 'string' ? fields.mode : ''
  if (!filter.modes.includes(mode)) return false
  const state = typeof fields.state === 'string' ? fields.state : row.state
  if (!filter.states.includes(state as RankState)) return false
  if (filter.software !== 'all' && fields.software !== filter.software) return false
  if (!nfMatches(filter.nf, fields.nf)) return false
  const bv = fields.bv
  if (typeof bv !== 'number' || !Number.isFinite(bv)) return false
  const floor = filter.floors[level as RankLevel] ?? 0
  if (bv < floor) return false

  const range = resolveDateRange(filter)
  if (range.invalid) return false
  if (range.from !== null || range.toExclusive !== null) {
    const date = videoDate(row)
    if (date === null) return false
    if (range.from !== null && date < range.from) return false
    if (range.toExclusive !== null && date >= range.toExclusive) return false
  }
  return true
}

