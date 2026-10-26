import type { IdentifierItem } from './api'
import { displayName, normalize, type UserRecord } from './model'

export type MatchSource = 'id' | 'text' | 'pinyin' | 'identifier'

export type Rank = [source: number, kind: number, field: number, nameLength: number, id: number]

export interface UserHit {
  record: UserRecord
  source: MatchSource
  rank: Rank
  identifiers: string[]
}

export interface IdentifierOnlyHit {
  identifier: string
  userId: number | null
}

const SOURCE_ID = 0
const SOURCE_TEXT = 1
const SOURCE_PINYIN = 2
const SOURCE_IDENTIFIER = 3

const KIND_EXACT = 0
const KIND_PREFIX = 1
const KIND_CONTAINS = 2

const FIELD_USERNAME = 0
const FIELD_REALNAME = 1
const FIELD_FIRSTNAME = 2
const FIELD_LASTNAME = 3
const FIELD_COMBINED = 4

const NUMERIC_QUERY = /^\d{1,10}$/
const ASCII_LETTERS = /^[a-z]+$/

function compareRank(a: Rank, b: Rank): number {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}

function matchKind(value: string, query: string): number | null {
  if (!value) return null
  if (value === query) return KIND_EXACT
  if (value.startsWith(query)) return KIND_PREFIX
  if (value.includes(query)) return KIND_CONTAINS
  return null
}

function rankText(record: UserRecord, query: string): Rank | null {
  const length = displayName(record).length
  let best: Rank | null = null

  const fields: Array<[string, number]> = [
    [record.usernameLower, FIELD_USERNAME],
    [record.realnameLower, FIELD_REALNAME],
    [record.firstnameLower, FIELD_FIRSTNAME],
    [record.lastnameLower, FIELD_LASTNAME],
  ]

  for (const [value, field] of fields) {
    const kind = matchKind(value, query)
    if (kind === null) continue
    const candidate: Rank = [SOURCE_TEXT, kind, field, length, record.id]
    if (!best || compareRank(candidate, best) < 0) best = candidate
  }

  // Multi-word queries such as "San Zhang" / "Zhang San" span fields, so they
  // only match the combined text index. Rank them after single-field matches.
  const combinedKind = matchKind(record.text, query)
  if (combinedKind !== null) {
    const candidate: Rank = [
      SOURCE_TEXT,
      combinedKind,
      FIELD_COMBINED,
      length,
      record.id,
    ]
    if (!best || compareRank(candidate, best) < 0) best = candidate
  }

  return best
}

function rankPinyin(record: UserRecord, query: string): Rank | null {
  if (!ASCII_LETTERS.test(query)) return null

  const length = displayName(record).length
  const candidates: Rank[] = []

  if (record.pyFull) {
    const kind = matchKind(record.pyFull, query)
    if (kind !== null) candidates.push([SOURCE_PINYIN, kind, FIELD_USERNAME, length, record.id])
  }
  if (record.pyInitials) {
    const kind = matchKind(record.pyInitials, query)
    if (kind !== null) candidates.push([SOURCE_PINYIN, kind, FIELD_USERNAME, length, record.id])
  }

  if (candidates.length === 0) return null
  candidates.sort(compareRank)
  return candidates[0]
}

function isNumericQuery(query: string): boolean {
  return NUMERIC_QUERY.test(query)
}

export function searchRecords(records: UserRecord[], rawQuery: string): UserHit[] {
  const query = normalize(rawQuery)
  if (!query) return []

  const numeric = isNumericQuery(query)
  const idQuery = numeric ? Number(query) : null
  const hits: UserHit[] = []

  for (const record of records) {
    let best: Rank | null = null

    if (idQuery !== null && record.id === idQuery) {
      best = [SOURCE_ID, KIND_EXACT, FIELD_USERNAME, displayName(record).length, record.id]
    }

    const textRank = rankText(record, query)
    if (textRank && (!best || compareRank(textRank, best) < 0)) best = textRank

    if (!numeric) {
      const pinyinRank = rankPinyin(record, query)
      if (pinyinRank && (!best || compareRank(pinyinRank, best) < 0)) best = pinyinRank
    }

    if (!best) continue
    hits.push({
      record,
      source:
        best[0] === SOURCE_ID ? 'id' : best[0] === SOURCE_PINYIN ? 'pinyin' : 'text',
      rank: best,
      identifiers: [],
    })
  }

  hits.sort((a, b) => compareRank(a.rank, b.rank))
  return hits
}

export function mergeIdentifierItems(
  hits: UserHit[],
  items: IdentifierItem[],
  recordsById: Map<number, UserRecord>,
): { users: UserHit[]; identifierOnly: IdentifierOnlyHit[] } {
  const byId = new Map<number, UserHit>()
  for (const hit of hits) byId.set(hit.record.id, hit)

  const identifierOnly: IdentifierOnlyHit[] = []
  const seen = new Set<string>()

  for (const item of items) {
    const dedupeKey = `${item.user_id ?? 'null'}|${item.identifier}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)

    if (item.user_id !== null) {
      const record = recordsById.get(item.user_id)
      if (record) {
        let hit = byId.get(record.id)
        if (!hit) {
          hit = {
            record,
            source: 'identifier',
            rank: [SOURCE_IDENTIFIER, KIND_EXACT, FIELD_USERNAME, displayName(record).length, record.id],
            identifiers: [],
          }
          byId.set(record.id, hit)
        }
        if (!hit.identifiers.includes(item.identifier)) {
          hit.identifiers.push(item.identifier)
        }
        continue
      }
    }

    if (identifierOnly.length < 10) {
      identifierOnly.push({ identifier: item.identifier, userId: item.user_id })
    }
  }

  const users = [...byId.values()].sort((a, b) => compareRank(a.rank, b.rank))
  return { users, identifierOnly }
}
