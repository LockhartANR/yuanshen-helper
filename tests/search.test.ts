import { describe, expect, it } from 'vitest'
import { toRecord, type UserRecord } from '../src/features/user-search/model'
import {
  mergeIdentifierItems,
  searchRecords,
  type UserHit,
} from '../src/features/user-search/search'

function makeUser(overrides: Record<string, unknown>): UserRecord {
  const record = toRecord({ id: 1, username: 'user', ...overrides })
  if (!record) throw new Error('invalid fixture')
  return record
}

const zhangsan = makeUser({
  id: 1,
  username: 'zhangsan',
  realname: '张三',
  firstname: 'San',
  lastname: 'Zhang',
})
const zhangsan2 = makeUser({
  id: 2,
  username: 'zhangsan2',
  realname: '张三丰',
  firstname: 'Sanfeng',
  lastname: 'Zhang',
})
const abc = makeUser({
  id: 3,
  username: 'abc',
  realname: '张三',
  firstname: '',
  lastname: '',
})
const ghost = makeUser({
  id: 4,
  username: 'ghost',
  realname: 'hidden',
  firstname: 'hidden',
  lastname: 'hidden',
})
const anonymous = makeUser({
  id: 5,
  username: 'someuser',
  realname: '匿名',
  firstname: 'Xiao',
  lastname: 'Lin',
})
const numericName = makeUser({ id: 7, username: '42' })
const idFortyTwo = makeUser({ id: 42, username: 'abc42', realname: 'Other' })

const records = [
  zhangsan,
  zhangsan2,
  abc,
  ghost,
  anonymous,
  numericName,
  idFortyTwo,
]
const recordsById = new Map(records.map((record) => [record.id, record]))

describe('searchRecords', () => {
  it('returns exact username before prefix and pinyin matches', () => {
    const hits = searchRecords(records, 'zhangsan')
    expect(hits.map((hit) => hit.record.id)).toEqual([1, 2, 3])
    expect(hits[0].source).toBe('text')
  })

  it('ranks prefix before contains', () => {
    const hits = searchRecords(records, 'zhang')
    expect(hits[0].record.id).toBe(1)
    expect(hits[1].record.id).toBe(2)
    expect(hits[2].record.id).toBe(3)
  })

  it('matches multi-word English names in either order or compact form', () => {
    expect(searchRecords(records, 'san zhang')[0]?.record.id).toBe(1)
    expect(searchRecords(records, 'zhang san')[0]?.record.id).toBe(1)
    expect(searchRecords(records, 'sanzhang')[0]?.record.id).toBe(1)
  })

  it('puts an exact numeric ID first, then text matches', () => {
    const hits = searchRecords(records, '42')
    expect(hits[0].record.id).toBe(42)
    expect(hits[0].source).toBe('id')
    expect(hits[0].rank[0]).toBe(0)
    expect(hits[1].record.id).toBe(7)
    expect(hits[1].source).toBe('text')
  })

  it('does not match hidden names', () => {
    expect(searchRecords(records, 'hidden')).toEqual([])
    expect(searchRecords(records, '实名已隐藏')).toEqual([])
  })

  it('still finds hidden users by username', () => {
    const hits = searchRecords(records, 'ghost')
    expect(hits.map((hit) => hit.record.id)).toEqual([4])
  })

  it('finds anonymous users by their public English name', () => {
    const hits = searchRecords(records, 'xiao')
    expect(hits.map((hit) => hit.record.id)).toEqual([5])
  })

  it('supports pinyin initials', () => {
    const hits = searchRecords(records, 'zs')
    expect(hits.some((hit) => hit.record.id === 1)).toBe(true)
    expect(hits.find((hit) => hit.record.id === 1)?.source).toBe('pinyin')
  })

  it('normalizes full-width and uppercase queries', () => {
    expect(searchRecords(records, 'ＺＨＡＮＧ')[0].record.id).toBe(1)
  })

  it('returns no results for an empty query', () => {
    expect(searchRecords(records, '   ')).toEqual([])
  })
})

describe('mergeIdentifierItems', () => {
  it('attaches identifiers to local users and keeps unbound rows', () => {
    const hits: UserHit[] = searchRecords(records, 'zhang')
    const merged = mergeIdentifierItems(
      hits,
      [
        { identifier: 'Zhang San 01', user_id: 1 },
        { identifier: 'unbound', user_id: null },
        { identifier: 'outside', user_id: 99 },
      ],
      recordsById,
    )

    const first = merged.users.find((hit) => hit.record.id === 1)
    expect(first?.identifiers).toEqual(['Zhang San 01'])
    expect(merged.identifierOnly).toEqual([
      { identifier: 'unbound', userId: null },
      { identifier: 'outside', userId: 99 },
    ])
  })

  it('creates a result for a local user matched only by identifier', () => {
    const merged = mergeIdentifierItems(
      [],
      [{ identifier: 'abc123', user_id: 5 }],
      recordsById,
    )

    expect(merged.users).toHaveLength(1)
    expect(merged.users[0].record.id).toBe(5)
    expect(merged.users[0].source).toBe('identifier')
    expect(merged.users[0].identifiers).toEqual(['abc123'])
  })
})
