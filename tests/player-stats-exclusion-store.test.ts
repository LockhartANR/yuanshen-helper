import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import {
  createIndexedDbExclusionStore,
  createMemoryExclusionStore,
  normalizeExclusionScope,
} from '../src/features/player-stats/statistics-exclusion-store'
import type { ExclusionMutation } from '../src/features/player-stats/statistics-exclusion-store'
import type {
  ExclusionRule,
  ExclusionScopeRecord,
} from '../src/features/player-stats/statistics-exclusion'

function siteRule(videoId: number): ExclusionRule {
  return {
    ruleId: `rule-${videoId}`,
    target: { kind: 'site', videoId },
    excludedAt: 1,
    summary: {
      date: null,
      level: 'b',
      timems: 5000,
      bv: 12,
      nf: false,
      state: 'c',
      videoId,
      sourceName: '网站数据',
    },
  }
}

const siteOwner = {
  kind: 'site' as const,
  namespace: 'https://openms.top',
  userId: 16,
}

function scope(scopeId: string, rules: ExclusionRule[] = []): ExclusionScopeRecord {
  return {
    scopeId,
    kind: 'site',
    revision: rules.length > 0 ? 1 : 0,
    owner: siteOwner,
    rules,
  }
}

function mutation(
  scopeId: string,
  expectedRevision: number,
  add: ExclusionRule[] = [],
  remove: string[] = [],
): ExclusionMutation {
  return {
    scopeId,
    kind: 'site',
    owner: siteOwner,
    expectedRevision,
    add,
    remove,
  }
}

describe('统计排除存储', () => {
  it('新增、幂等排除、恢复与修订号推进', async () => {
    const store = createMemoryExclusionStore()
    const first = await store.commit([mutation('site|a', 0, [siteRule(1)])])
    expect(first?.changed).toBe(true)
    expect(first?.scopes[0]).toMatchObject({ scopeId: 'site|a', revision: 1 })

    const again = await store.commit([mutation('site|a', 1, [siteRule(1)])])
    expect(again?.changed).toBe(false)
    expect((await store.get('site|a'))?.revision).toBe(1)

    const restored = await store.commit([mutation('site|a', 1, [], ['rule-1'])])
    expect(restored?.scopes[0]?.rules).toHaveLength(0)
    expect((await store.get('site|a'))?.revision).toBe(2)
  })

  it('按 ruleId 原位推进匹配依据，不累加重复规则', async () => {
    const store = createMemoryExclusionStore()
    const rule = siteRule(1)
    await store.commit([mutation('site|a', 0, [rule])])
    const updated: ExclusionRule = {
      ...rule,
      target: { kind: 'site', videoId: 1 },
      excludedAt: 2,
    }
    const result = await store.commit([
      { ...mutation('site|a', 1), update: [updated] },
    ])
    expect(result?.changed).toBe(true)
    expect((await store.get('site|a'))?.rules).toHaveLength(1)
    expect((await store.get('site|a'))?.rules[0]?.excludedAt).toBe(2)
    expect((await store.get('site|a'))?.revision).toBe(2)
  })

  it('只替换文件身份引用时也提升修订号，规则与锚点不变', async () => {
    const legacyHandle = { name: '旧成绩.csv', legacy: true }
    const scopeId = 'csv|src-1|1'
    const existing = siteRule(1)
    const store = createMemoryExclusionStore([
      {
        scopeId,
        kind: 'csv',
        revision: 1,
        owner: { kind: 'csv', name: '旧成绩.csv', handle: legacyHandle as never, sourceId: 'src-1' },
        rules: [existing],
      },
    ])
    const newHandle = { name: '新成绩.csv' }
    const rebind: ExclusionMutation = {
      scopeId,
      kind: 'csv',
      owner: { kind: 'csv', name: '新成绩.csv', handle: newHandle as never, sourceId: 'src-1' },
      expectedRevision: 1,
      add: [],
      remove: [],
      rebindOwner: true,
    }
    // 不带 rebindOwner 时按原规则忽略 owner 更新。
    const ignored = await store.commit([{ ...rebind, rebindOwner: false }])
    expect(ignored?.changed).toBe(false)
    expect((await store.get(scopeId))?.revision).toBe(1)

    const result = await store.commit([rebind])
    expect(result?.changed).toBe(true)
    const stored = await store.get(scopeId)
    expect(stored?.revision).toBe(2)
    expect(stored?.rules).toEqual([existing])
    expect(stored?.owner.kind === 'csv' && stored.owner.name).toBe('新成绩.csv')
    expect(
      (stored?.owner.kind === 'csv' ? stored.owner.handle : null) as unknown as {
        name?: string
      } | null,
    ).toBe(newHandle)

    // 所有者没有变化时不再重复提升修订号。
    const again = await store.commit([{ ...rebind, expectedRevision: 2 }])
    expect(again?.changed).toBe(false)
    expect((await store.get(scopeId))?.revision).toBe(2)
  })

  it('修订号冲突时整批不写入', async () => {
    const store = createMemoryExclusionStore([scope('site|a', [siteRule(1)])])
    const result = await store.commit([
      mutation('site|a', 1, [siteRule(2)]),
      mutation('site|b', 7, [siteRule(3)]),
    ])
    expect(result).toBeNull()
    expect((await store.get('site|a'))?.rules.map((rule) => rule.target)).toEqual([
      { kind: 'site', videoId: 1 },
    ])
    expect(await store.get('site|b')).toBeNull()
  })

  it('事务内校验失败时不产生半批结果', async () => {
    const store = createMemoryExclusionStore()
    const result = await store.commit(
      [mutation('site|a', 0, [siteRule(1)]), mutation('site|b', 0, [siteRule(2)])],
      () => false,
    )
    expect(result).toBeNull()
    expect(await store.list()).toEqual([])
  })

  it('读取时收敛损坏数据并去重同目标规则', () => {
    const normalized = normalizeExclusionScope({
      scopeId: 'site|a',
      kind: 'site',
      revision: -3,
      owner: siteOwner,
      rules: [siteRule(1), siteRule(1), { bad: true }],
    })
    expect(normalized?.revision).toBe(0)
    expect(normalized?.rules).toHaveLength(1)
    expect(normalizeExclusionScope({ scopeId: 'x' })).toBeNull()
  })

  it('IndexedDB 实现使用同一套原子语义', async () => {
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase('yuanshen-helper')
      request.onsuccess = () => resolve()
      request.onerror = () => resolve()
      request.onblocked = () => resolve()
    })
    const store = createIndexedDbExclusionStore()
    expect(await store.list()).toEqual([])
    const first = await store.commit([mutation('site|idb', 0, [siteRule(10)])])
    expect(first?.changed).toBe(true)
    const loaded = await store.get('site|idb')
    expect(loaded?.rules).toHaveLength(1)
    expect(loaded?.revision).toBe(1)

    const conflict = await store.commit([mutation('site|idb', 0, [siteRule(11)])])
    expect(conflict).toBeNull()
    expect((await store.get('site|idb'))?.rules.map((rule) => rule.target)).toEqual([
      { kind: 'site', videoId: 10 },
    ])
  })
})
