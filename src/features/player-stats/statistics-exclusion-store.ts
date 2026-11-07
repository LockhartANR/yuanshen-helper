/**
 * 统计排除规则的持久化：按作用域保存规则、修订号和文件身份引用。
 *
 * 计算与文件读取都在事务外完成；提交时一次事务读取所有目标作用域的当前修订号，
 * 任一冲突则整批不写入，避免多页面或批量操作产生半批结果。
 */

import { getDb } from '../../shared/db'
import type {
  ExclusionRule,
  ExclusionScopeKind,
  ExclusionScopeOwner,
  ExclusionScopeRecord,
  ExclusionTarget,
} from './statistics-exclusion'
import { exclusionTargetKey } from './statistics-exclusion'

export interface ExclusionMutation {
  scopeId: string
  kind: ExclusionScopeKind
  owner: ExclusionScopeOwner
  /** 期望的当前修订号；作用域不存在时传 0。 */
  expectedRevision: number
  add: readonly ExclusionRule[]
  /** 要清除的规则 ID（恢复或清理未匹配规则）。 */
  remove: readonly string[]
  /** 已匹配规则推进到最近一次成功快照的新匹配依据；按 ruleId 替换。 */
  update?: readonly ExclusionRule[]
}

export interface ExclusionCommitResult {
  scopes: ExclusionScopeRecord[]
  /** 是否真的新增或删除了规则；幂等操作不提升修订号。 */
  changed: boolean
}

export interface StatisticsExclusionStore {
  list(): Promise<ExclusionScopeRecord[]>
  get(scopeId: string): Promise<ExclusionScopeRecord | null>
  /** `isValid` 在事务内、写入前执行；返回 false 时不产生半批结果。 */
  commit(
    mutations: readonly ExclusionMutation[],
    isValid?: () => boolean,
  ): Promise<ExclusionCommitResult | null>
}

function isTarget(value: unknown): value is ExclusionTarget {
  if (!value || typeof value !== 'object') return false
  const target = value as Partial<ExclusionTarget>
  if (target.kind === 'site') {
    return typeof target.videoId === 'number' && Number.isSafeInteger(target.videoId)
  }
  if (target.kind !== 'csv') return false
  return (
    typeof target.fingerprintVersion === 'number' &&
    typeof target.fingerprint === 'string' &&
    typeof target.occurrence === 'number' &&
    Number.isSafeInteger(target.occurrence) &&
    target.occurrence > 0 &&
    Array.isArray(target.canonicalRow) &&
    target.canonicalRow.every((value) => typeof value === 'string') &&
    !!target.anchor &&
    typeof target.anchor === 'object' &&
    typeof target.anchor.recordCount === 'number' &&
    typeof target.anchor.prefixDigest === 'string' &&
    typeof target.anchor.sameContentCount === 'number'
  )
}

function recordSummary(value: unknown): ExclusionRule['summary'] {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const num = (input: unknown): number | null =>
    typeof input === 'number' && Number.isFinite(input) ? input : null
  return {
    date: typeof raw.date === 'string' ? raw.date : null,
    level: typeof raw.level === 'string' ? raw.level : null,
    timems: num(raw.timems),
    bv: num(raw.bv),
    nf: typeof raw.nf === 'boolean' ? raw.nf : null,
    state: typeof raw.state === 'string' ? raw.state : null,
    videoId: num(raw.videoId),
    sourceName: typeof raw.sourceName === 'string' ? raw.sourceName : '',
  }
}

function normalizeRule(value: unknown): ExclusionRule | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<ExclusionRule>
  if (typeof raw.ruleId !== 'string' || raw.ruleId === '' || !isTarget(raw.target)) return null
  return {
    ruleId: raw.ruleId,
    target: raw.target,
    excludedAt: typeof raw.excludedAt === 'number' ? raw.excludedAt : 0,
    summary: recordSummary(raw.summary),
  }
}

function normalizeOwner(value: unknown): ExclusionScopeOwner | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (raw.kind === 'site') {
    if (typeof raw.namespace !== 'string' || typeof raw.userId !== 'number') return null
    return { kind: 'site', namespace: raw.namespace, userId: raw.userId }
  }
  if (raw.kind === 'csv') {
    if (typeof raw.name !== 'string') return null
    return {
      kind: 'csv',
      name: raw.name,
      handle:
        raw.handle && typeof raw.handle === 'object'
          ? (raw.handle as NonNullable<Extract<ExclusionScopeOwner, { kind: 'csv' }>['handle']>)
          : undefined,
      sourceId: typeof raw.sourceId === 'string' ? raw.sourceId : undefined,
    }
  }
  return null
}

/** 数据库内容可能来自旧版本或被手动改写，读取时收敛成可信结构。 */
export function normalizeExclusionScope(
  value: unknown,
  fallbackScopeId = '',
): ExclusionScopeRecord | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<ExclusionScopeRecord>
  const scopeId = typeof raw.scopeId === 'string' ? raw.scopeId : fallbackScopeId
  const owner = normalizeOwner(raw.owner)
  if (!scopeId || !owner) return null
  const kind = raw.kind === 'site' || raw.kind === 'csv' ? raw.kind : owner.kind
  const rules: ExclusionRule[] = []
  const seen = new Set<string>()
  for (const item of Array.isArray(raw.rules) ? raw.rules : []) {
    const rule = normalizeRule(item)
    if (!rule) continue
    const key = exclusionTargetKey(rule.target)
    if (seen.has(key)) continue
    seen.add(key)
    rules.push(rule)
  }
  return {
    scopeId,
    kind,
    revision: typeof raw.revision === 'number' && raw.revision >= 0 ? raw.revision : 0,
    owner,
    rules,
  }
}

function copyScope(scope: ExclusionScopeRecord): ExclusionScopeRecord {
  return {
    ...scope,
    owner: { ...scope.owner },
    rules: scope.rules.map((rule) => ({
      ...rule,
      target:
        rule.target.kind === 'site'
          ? { ...rule.target }
          : {
              ...rule.target,
              canonicalRow: [...rule.target.canonicalRow],
              anchor: { ...rule.target.anchor },
            },
      summary: { ...rule.summary },
    })),
  }
}

function sameRule(a: ExclusionRule, b: ExclusionRule): boolean {
  if (
    a.ruleId !== b.ruleId ||
    a.excludedAt !== b.excludedAt ||
    a.target.kind !== b.target.kind ||
    a.summary.date !== b.summary.date ||
    a.summary.level !== b.summary.level ||
    a.summary.timems !== b.summary.timems ||
    a.summary.bv !== b.summary.bv ||
    a.summary.nf !== b.summary.nf ||
    a.summary.state !== b.summary.state ||
    a.summary.videoId !== b.summary.videoId ||
    a.summary.sourceName !== b.summary.sourceName
  ) {
    return false
  }
  if (a.target.kind === 'site' && b.target.kind === 'site') {
    return a.target.videoId === b.target.videoId
  }
  if (a.target.kind !== 'csv' || b.target.kind !== 'csv') return false
  const targetA = a.target
  const targetB = b.target
  return (
    targetA.fingerprintVersion === targetB.fingerprintVersion &&
    targetA.fingerprint === targetB.fingerprint &&
    targetA.occurrence === targetB.occurrence &&
    targetA.anchor.recordCount === targetB.anchor.recordCount &&
    targetA.anchor.prefixDigest === targetB.anchor.prefixDigest &&
    targetA.anchor.sameContentCount === targetB.anchor.sameContentCount &&
    targetA.canonicalRow.length === targetB.canonicalRow.length &&
    targetA.canonicalRow.every((value, index) => value === targetB.canonicalRow[index])
  )
}

/**
 * 在已读取的当前作用域上生成下一版；保留已有规则，按目标去重。
 * `update` 按 ruleId 原位替换已匹配规则的新匹配依据。
 * 返回 null 表示修订号冲突，调用方必须重读后重新计算。
 */
function applyMutation(
  current: ExclusionScopeRecord | null,
  mutation: ExclusionMutation,
): { scope: ExclusionScopeRecord | null; changed: boolean } | null {
  const revision = current?.revision ?? 0
  if (revision !== mutation.expectedRevision) return null

  const rules = current ? [...current.rules] : []
  const seen = new Set(rules.map((rule) => exclusionTargetKey(rule.target)))
  let changed = false
  for (const rule of mutation.add) {
    const key = exclusionTargetKey(rule.target)
    if (seen.has(key)) continue
    seen.add(key)
    rules.push(rule)
    changed = true
  }
  if (mutation.remove.length > 0) {
    const remove = new Set(mutation.remove)
    const next = rules.filter((rule) => !remove.has(rule.ruleId))
    if (next.length !== rules.length) changed = true
    rules.splice(0, rules.length, ...next)
  }
  if (mutation.update && mutation.update.length > 0) {
    const byId = new Map(rules.map((rule, index) => [rule.ruleId, index]))
    for (const rule of mutation.update) {
      const index = byId.get(rule.ruleId)
      if (index === undefined) continue
      if (sameRule(rules[index]!, rule)) continue
      rules[index] = rule
      changed = true
    }
  }

  if (!changed) {
    return {
      scope: current ? copyScope(current) : null,
      changed: false,
    }
  }
  return {
    scope: {
      scopeId: mutation.scopeId,
      kind: mutation.kind,
      revision: revision + 1,
      owner: { ...mutation.owner },
      rules,
    },
    changed: true,
  }
}

function planMutations(
  mutations: readonly ExclusionMutation[],
  current: (scopeId: string) => ExclusionScopeRecord | null,
): { scopes: ExclusionScopeRecord[]; changed: boolean } | null {
  const planned: ExclusionScopeRecord[] = []
  let changed = false
  for (const mutation of mutations) {
    const result = applyMutation(current(mutation.scopeId), mutation)
    if (!result) return null
    changed ||= result.changed
    if (result.scope) planned.push(result.scope)
  }
  return { scopes: planned, changed }
}

export function createIndexedDbExclusionStore(): StatisticsExclusionStore {
  return {
    async list() {
      const db = await getDb()
      const records = await db.getAll('statExclusions')
      return records
        .map((record) => normalizeExclusionScope(record, record?.scopeId ?? ''))
        .filter((record): record is ExclusionScopeRecord => record !== null)
    },

    async get(scopeId) {
      const db = await getDb()
      return normalizeExclusionScope(await db.get('statExclusions', scopeId), scopeId)
    },

    async commit(mutations, isValid) {
      if (mutations.length === 0) return { scopes: [], changed: false }
      const db = await getDb()
      const tx = db.transaction('statExclusions', 'readwrite')
      const currents = new Map<string, ExclusionScopeRecord | null>()
      for (const mutation of mutations) {
        if (currents.has(mutation.scopeId)) continue
        currents.set(
          mutation.scopeId,
          normalizeExclusionScope(
            await tx.store.get(mutation.scopeId),
            mutation.scopeId,
          ),
        )
      }
      const plan = planMutations(
        mutations,
        (scopeId) => currents.get(scopeId) ?? null,
      )
      if (!plan || (isValid && !isValid())) {
        await tx.done
        return null
      }
      for (const scope of plan.scopes) {
        if (scope.revision > 0) await tx.store.put(scope)
      }
      await tx.done
      return plan
    },
  }
}

/** 测试与降级协调使用；语义与 IndexedDB 实现一致。 */
export function createMemoryExclusionStore(
  initial: readonly ExclusionScopeRecord[] = [],
): StatisticsExclusionStore {
  const records = new Map<string, ExclusionScopeRecord>(
    initial.map((record) => [record.scopeId, copyScope(record)]),
  )
  return {
    async list() {
      return [...records.values()].map(copyScope)
    },
    async get(scopeId) {
      const record = records.get(scopeId)
      return record ? copyScope(record) : null
    },
    async commit(mutations, isValid) {
      if (mutations.length === 0) return { scopes: [], changed: false }
      const plan = planMutations(
        mutations,
        (scopeId) => {
          const record = records.get(scopeId)
          return record ? copyScope(record) : null
        },
      )
      if (!plan || (isValid && !isValid())) return null
      for (const scope of plan.scopes) records.set(scope.scopeId, copyScope(scope))
      return plan
    },
  }
}

export function createExclusionStore(persistent = true): StatisticsExclusionStore {
  return persistent ? createIndexedDbExclusionStore() : createMemoryExclusionStore()
}
