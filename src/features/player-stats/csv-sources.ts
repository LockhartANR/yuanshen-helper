/**
 * 本地 CSV 关联清单：文件身份、持久化、读取与快照。
 *
 * 一个关联文件代表一个数据源；刷新时按清单顺序重新读取每个文件的完整内容，
 * 再用「来源顺序 + 文件内行顺序」重新生成一份负 ID 连续的新快照，不在旧数组上追加。
 */

import { formatCount } from '../../shared/format'
import { errorMessage } from '../../shared/ui'
import { getDb } from '../../shared/db'
import { parseStatsCsv } from './csv'
import { withCsvTimeout } from './csv-timeout'
import type { CsvError, CsvRecord } from './csv'
import type { Video } from './model'
import { rebindScopeOwner } from './statistics-exclusion'
import type { ExclusionScopeOwner } from './statistics-exclusion'

export const CSV_MAX_BYTES = 20 * 1024 * 1024
export const CSV_REGISTRY_ID = 'current'
export const CSV_PERMISSION_CHECK_TIMEOUT_MS = 5_000
export const CSV_PERMISSION_REQUEST_TIMEOUT_MS = 30_000
export const CSV_FILE_OPEN_TIMEOUT_MS = 15_000
/** 句柄身份比较必须有明确结束，不能无限等待浏览器返回。 */
export const CSV_IDENTITY_CHECK_TIMEOUT_MS = 8_000

/**
 * 真实环境是 FileSystemFileHandle；测试与降级模式使用结构相同的替身。
 * 只声明本功能实际用到的成员，避免依赖 Chromium 专有类型。
 */
export interface CsvFileHandle {
  name: string
  getFile(): Promise<File>
  isSameEntry?(other: CsvFileHandle): Promise<boolean>
  queryPermission?(descriptor?: { mode?: 'read' }): Promise<PermissionState>
  requestPermission?(descriptor?: { mode?: 'read' }): Promise<PermissionState>
}

/** 该文件上一次成功读取的摘要；只作展示，不代替重新读取。 */
export interface CsvSourceSummary {
  readAt: number
  validCount: number
  totalRows: number
  invalidRows: number
  size: number
  lastModified: number
}

export interface CsvSourceRecord {
  sourceId: string
  name: string
  /**
   * 仅内存降级存储会在这里回填句柄；IndexedDB 元数据不保存句柄，
   * 句柄按来源单独存放，避免修改一个来源时重写其他文件句柄。
   */
  handle?: CsvFileHandle
  addedAt: number
  /** 该来源自身被替换（重新关联）的版本；清单级版本见 registry.revision。 */
  revision: number
  lastSuccess: CsvSourceSummary | null
  /** 用户明确沿用的统计排除作用域；持久保存，重开页面后继续生效。 */
  exclusionScopeId?: string
}

export interface CsvSourceRegistry {
  id: typeof CSV_REGISTRY_ID
  revision: number
  sources: CsvSourceRecord[]
}

/** 按来源独立保存的文件句柄记录。 */
export interface CsvHandleRecord {
  sourceId: string
  handle: CsvFileHandle
}

/** 批量修复：一个原来源对应一个新选择的文件。 */
export interface CsvRepairInput {
  sourceId: string
  handle: CsvFileHandle
  summary: CsvSourceSummary
  /** null 表示“作为新来源”，清除原规则绑定。 */
  exclusionScopeId: string | null
  /** 用户确认修复依据的原来源版本；事务内复核。 */
  expectedSourceRevision?: number
}

/** 会话层提交的修复请求：摘要由会话读取文件后填入。 */
export type CsvRepairRequest = Omit<CsvRepairInput, 'summary'>

export type CsvFileErrorCode = 'not-found' | 'permission' | 'size' | 'format' | 'invalid' | 'io'

export class CsvFileError extends Error {
  constructor(
    message: string,
    readonly code: CsvFileErrorCode,
  ) {
    super(message)
    this.name = 'CsvFileError'
  }
}

/** 文件身份比较失败时不退回按同名认定相同。 */
export class CsvIdentityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CsvIdentityError'
  }
}

export interface CsvFileRead {
  summary: CsvSourceSummary
  videos: Video[]
  /** 与 videos 一一对应的原始列，用于排除规则身份。 */
  records: CsvRecord[]
  errors: CsvError[]
}

export interface CsvLoadedSource {
  sourceId: string
  /** 加载时来源自身的版本；另一页面重新关联后版本变化，旧缓存必须作废。 */
  sourceRevision: number
  name: string
  videos: Video[]
  /** 旧测试或迁移数据可能没有；真实读取必须保留原始身份。 */
  records?: CsvRecord[]
  summary: CsvSourceSummary
}

export interface CsvAddInput {
  sourceId: string
  handle: CsvFileHandle
  summary: CsvSourceSummary
}

/** 重新关联 / 修复沿用规则时，提交阶段仍需核对的排除作用域修订。 */
export interface CsvScopeGuard {
  scopeId: string
  revision: number
  /**
   * 沿用规则时一并把作用域的文件身份引用换成新句柄。
   * 与清单、句柄在同一事务内写入，避免之后推进锚点时又写回失效的旧句柄。
   */
  owner?: ExclusionScopeOwner
  /** 内存存储或跨 store 预检；IndexedDB 事务内还会再次读取。 */
  verify?: () => Promise<boolean>
}

export interface CsvSourceStore {
  load(): Promise<CsvSourceRegistry>
  /** 当前可用的文件句柄；缺失的 sourceId 需要用户重新选择文件。 */
  handles(): Promise<Map<string, CsvFileHandle>>
  /** 整批添加；事务内校验 revision 与批次有效性，冲突或取消返回 null。 */
  addMany(
    inputs: readonly CsvAddInput[],
    expectedRevision: number,
    isValid?: () => boolean,
  ): Promise<CsvSourceRegistry | null>
  relink(
    sourceId: string,
    handle: CsvFileHandle,
    summary: CsvSourceSummary,
    expectedRevision: number,
    isValid?: () => boolean,
    exclusionScopeId?: string | null,
    expectedSourceRevision?: number,
    scopeGuard?: CsvScopeGuard,
  ): Promise<CsvSourceRegistry | null>
  /**
   * 一次修复多个异常来源：只写本批新句柄和元数据，其他来源句柄不参与写入。
   * 读取与身份校验由调用方完成；事务内复核清单、来源和作用域版本。
   */
  repair(
    inputs: readonly CsvRepairInput[],
    expectedRevision: number,
    isValid?: () => boolean,
    scopeGuards?: readonly CsvScopeGuard[],
  ): Promise<CsvSourceRegistry | null>
  remove(sourceId: string): Promise<CsvSourceRegistry>
  clear(): Promise<CsvSourceRegistry>
  /** 只在注册表仍为读到的 revision 时写入摘要；冲突返回 null。 */
  commit(
    revision: number,
    summaries: ReadonlyMap<string, CsvSourceSummary>,
    isValid?: () => boolean,
  ): Promise<CsvSourceRegistry | null>
}

export function emptyCsvRegistry(): CsvSourceRegistry {
  return { id: CSV_REGISTRY_ID, revision: 0, sources: [] }
}

function isSummary(value: unknown): value is CsvSourceSummary {
  if (!value || typeof value !== 'object') return false
  const summary = value as Partial<CsvSourceSummary>
  return (
    typeof summary.readAt === 'number' &&
    typeof summary.validCount === 'number' &&
    typeof summary.totalRows === 'number' &&
    typeof summary.invalidRows === 'number' &&
    typeof summary.size === 'number' &&
    typeof summary.lastModified === 'number'
  )
}

/** 数据库内容可能来自旧版本或被手动改写，读取时统一收敛成可信结构。 */
export function normalizeCsvRegistry(value: unknown): CsvSourceRegistry {
  if (!value || typeof value !== 'object') return emptyCsvRegistry()
  const raw = value as Partial<CsvSourceRegistry>
  const sources: CsvSourceRecord[] = []
  for (const item of Array.isArray(raw.sources) ? raw.sources : []) {
    if (!item || typeof item !== 'object') continue
    const record = item as Partial<CsvSourceRecord>
    if (typeof record.sourceId !== 'string' || typeof record.name !== 'string') continue
    const handle =
      record.handle && typeof record.handle === 'object'
        ? (record.handle as CsvFileHandle)
        : undefined
    sources.push({
      sourceId: record.sourceId,
      name: record.name,
      addedAt: typeof record.addedAt === 'number' ? record.addedAt : 0,
      revision: typeof record.revision === 'number' && record.revision >= 0 ? record.revision : 0,
      lastSuccess: isSummary(record.lastSuccess) ? record.lastSuccess : null,
      ...(handle ? { handle } : {}),
      ...(typeof record.exclusionScopeId === 'string' && record.exclusionScopeId !== ''
        ? { exclusionScopeId: record.exclusionScopeId }
        : {}),
    })
  }
  return {
    id: CSV_REGISTRY_ID,
    revision: typeof raw.revision === 'number' && raw.revision >= 0 ? raw.revision : 0,
    sources,
  }
}

function copyRegistry(registry: CsvSourceRegistry): CsvSourceRegistry {
  return {
    id: CSV_REGISTRY_ID,
    revision: registry.revision,
    sources: registry.sources.map((source) => ({ ...source })),
  }
}

export function createCsvSourceId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return `csv-${uuid}`
  return `csv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** 一次清单变更：只声明本批要写的句柄和要删的句柄，其他来源不参与写入。 */
interface RegistryChange {
  sources: CsvSourceRecord[]
  writes?: Array<{ sourceId: string; handle: CsvFileHandle }>
  deletes?: string[]
}

type RegistryMutation = (registry: CsvSourceRegistry) => RegistryChange | null

interface UpdateOptions {
  /** 需要与清单一起校验的排除作用域修订。 */
  scopeGuards?: readonly CsvScopeGuard[]
  /** 摘要提交不涉及句柄，避免为无关句柄打开写事务。 */
  withHandles?: boolean
}

/**
 * 元数据与句柄分开保存：
 * - `csvSourceMeta` 只存来源清单和摘要；
 * - `csvHandles` 按 sourceId 存句柄，只写本批涉及的来源；
 * - 旧的 `csvSources` 记录保持只读，作为升级失败时的回退。
 */
async function updateRegistry(
  mutate: RegistryMutation,
  options: UpdateOptions = {},
): Promise<CsvSourceRegistry | null> {
  const db = await getDb()
  const withHandles = options.withHandles !== false
  const stores: Array<'csvSourceMeta' | 'csvHandles' | 'statExclusions'> = ['csvSourceMeta']
  if (withHandles) stores.push('csvHandles')
  if (options.scopeGuards && options.scopeGuards.length > 0) stores.push('statExclusions')
  const tx = db.transaction(stores, 'readwrite')
  const metaStore = tx.objectStore('csvSourceMeta')
  const scopeStore =
    options.scopeGuards && options.scopeGuards.length > 0
      ? tx.objectStore('statExclusions')
      : null
  const handleStore = withHandles ? tx.objectStore('csvHandles') : null
  try {
    // 第一步只做校验，不写任何记录：作用域修订、清单版本、来源与批次有效性。
    // 任一校验失败时事务里还没有写入，直接结束事务不会留下半批结果。
    const reboundScopes: ReturnType<typeof rebindScopeOwner>[] = []
    for (const guard of options.scopeGuards ?? []) {
      // 文件读取期间规则变化时不能写绑定，也不能先把 owner 换掉。
      const scope = await scopeStore!.get(guard.scopeId)
      if (!scope || scope.revision !== guard.revision) {
        await tx.done
        return null
      }
      if (!guard.owner) continue
      // 沿用规则：只换文件身份引用，规则目标与锚点保持不变；修订号提升。
      reboundScopes.push(rebindScopeOwner(scope, guard.owner))
    }
    const current = normalizeCsvRegistry(await metaStore.get(CSV_REGISTRY_ID))
    // mutate 必须是同步函数，事务里不能等待文件选择、授权或文件读取。
    const next = mutate(current)
    if (!next) {
      await tx.done
      return null
    }
    const registry: CsvSourceRegistry = {
      id: CSV_REGISTRY_ID,
      revision: current.revision + 1,
      sources: next.sources,
    }
    // 第二步才写：清单、本批句柄、沿用规则的作用域 owner 一次提交。
    await metaStore.put(registry)
    if (handleStore) {
      for (const write of next.writes ?? []) {
        await handleStore.put({ sourceId: write.sourceId, handle: write.handle })
      }
      for (const sourceId of next.deletes ?? []) {
        await handleStore.delete(sourceId)
      }
    }
    for (const scope of reboundScopes) {
      if (scope) await scopeStore!.put(scope)
    }
    await tx.done
    return registry
  } catch (error) {
    // 写入异常（例如句柄无法序列化）：显式回滚，不能把已写入的 owner / 元数据留在库里。
    try {
      tx.abort()
    } catch {
      // 事务已结束或已中止；下面统一等待结束结果。
    }
    try {
      await tx.done
    } catch {
      // abort 后的 done 以错误结束，属预期。
    }
    throw error
  }
}

/**
 * 旧版清单把句柄嵌在清单记录里；逐个来源单独写入，避免一个坏句柄毁掉整批迁移。
 *
 * 迁移可能与其他页面并发：句柄只补写缺失的来源，元数据在事务内复查迁移标记，
 * 只允许首次初始化。迟到的迁移不得覆盖新清单、新句柄，也不能把已移除的来源写回来。
 *
 * 导出以便回归并发迁移：传入先前读到的旧清单即可模拟“另一个页面稍后才完成迁移”。
 */
export async function migrateLegacyRegistry(
  legacy: CsvSourceRegistry,
): Promise<CsvSourceRegistry> {
  const db = await getDb()
  const registry: CsvSourceRegistry = {
    id: CSV_REGISTRY_ID,
    revision: legacy.revision,
    sources: legacy.sources.map(({ handle: _handle, ...meta }) => ({ ...meta })),
  }
  // 其他页面可能已经完成迁移：先看一次，避免白写句柄。
  const existing = await db.get('csvSourceMeta', CSV_REGISTRY_ID)
  if (existing) return normalizeCsvRegistry(existing)
  for (const source of legacy.sources) {
    if (!source.handle) continue
    try {
      // 每个来源单独一个事务，并保留其他页面刚写入的新句柄。
      const tx = db.transaction('csvHandles', 'readwrite')
      const handleStore = tx.objectStore('csvHandles')
      const current = await handleStore.get(source.sourceId)
      if (!current) {
        await handleStore.put({ sourceId: source.sourceId, handle: source.handle })
      }
      await tx.done
    } catch {
      // 坏句柄不能阻断其他来源；元数据仍保留，界面按“需要修复”处理。
    }
  }
  try {
    // 元数据最后写入，作为迁移完成的标记；同一事务内复查，迟到迁移不覆盖新清单。
    const tx = db.transaction(['csvSourceMeta', 'csvHandles'], 'readwrite')
    const metaStore = tx.objectStore('csvSourceMeta')
    const rawMeta: unknown = await metaStore.get(CSV_REGISTRY_ID)
    if (rawMeta) {
      const written = normalizeCsvRegistry(rawMeta)
      const known = new Set(written.sources.map((source) => source.sourceId))
      const handleStore = tx.objectStore('csvHandles')
      for (const source of legacy.sources) {
        if (known.has(source.sourceId)) continue
        // 迟到迁移写下的句柄已没有对应来源（例如其他页面移除了它），不能残留。
        await handleStore.delete(source.sourceId)
      }
      await tx.done
      return written
    }
    await metaStore.put(registry)
    await tx.done
    return registry
  } catch {
    return copyRegistry(legacy)
  }
}

export async function loadCsvRegistry(): Promise<CsvSourceRegistry> {
  const db = await getDb()
  const meta = await db.get('csvSourceMeta', CSV_REGISTRY_ID)
  if (meta) return normalizeCsvRegistry(meta)
  const legacy = normalizeCsvRegistry(await db.get('csvSources', CSV_REGISTRY_ID))
  if (legacy.sources.length === 0) return legacy
  return migrateLegacyRegistry(legacy)
}

export async function loadCsvHandles(): Promise<Map<string, CsvFileHandle>> {
  const db = await getDb()
  const map = new Map<string, CsvFileHandle>()
  for (const record of await db.getAll('csvHandles')) {
    if (record?.handle) map.set(record.sourceId, record.handle)
  }
  // 尚未完成迁移时，以旧记录里的句柄作为只读回退。
  const meta = await db.get('csvSourceMeta', CSV_REGISTRY_ID)
  if (!meta) {
    const legacy = normalizeCsvRegistry(await db.get('csvSources', CSV_REGISTRY_ID))
    for (const source of legacy.sources) {
      if (source.handle && !map.has(source.sourceId)) map.set(source.sourceId, source.handle)
    }
  }
  return map
}

/** 两种存储只负责读写，来源更新与版本校验共用同一份实现。 */
function createSourceStore(
  load: CsvSourceStore['load'],
  handles: CsvSourceStore['handles'],
  update: (
    mutate: RegistryMutation,
    options?: UpdateOptions,
  ) => Promise<CsvSourceRegistry | null>,
): CsvSourceStore {
  return {
    load,
    handles,
    async addMany(inputs, expectedRevision, isValid) {
      if (inputs.length === 0) return null
      const addedAt = Date.now()
      return update((current) => {
        if (isValid && !isValid()) return null
        if (current.revision !== expectedRevision) return null
        const existing = new Set(current.sources.map((source) => source.sourceId))
        const accepted = inputs.filter((input) => !existing.has(input.sourceId))
        if (accepted.length === 0) return null
        const added = accepted.map<CsvSourceRecord>((input) => ({
          sourceId: input.sourceId,
          name: input.handle.name,
          addedAt,
          revision: 1,
          lastSuccess: input.summary,
        }))
        return {
          sources: [...current.sources, ...added],
          writes: accepted.map((input) => ({ sourceId: input.sourceId, handle: input.handle })),
        }
      })
    },
    async relink(
      sourceId,
      handle,
      summary,
      expectedRevision,
      isValid,
      exclusionScopeId,
      expectedSourceRevision,
      scopeGuard,
    ) {
      if (scopeGuard?.verify && !(await scopeGuard.verify())) return null
      return update((current) => {
        if (isValid && !isValid()) return null
        if (current.revision !== expectedRevision) return null
        const source = current.sources.find((item) => item.sourceId === sourceId)
        if (!source) return null
        if (
          expectedSourceRevision !== undefined &&
          source.revision !== expectedSourceRevision
        ) {
          return null
        }
        const inherited =
          typeof exclusionScopeId === 'string' && exclusionScopeId !== ''
            ? exclusionScopeId
            : undefined
        // 一个排除作用域不能同时绑定两个当前文件；冲突时整次重关联不写入。
        if (
          inherited &&
          current.sources.some(
            (item) => item.sourceId !== sourceId && item.exclusionScopeId === inherited,
          )
        ) {
          return null
        }
        return {
          sources: current.sources.map((item) => {
            if (item.sourceId !== sourceId) return item
            const next: CsvSourceRecord = {
              ...item,
              name: handle.name,
              revision: item.revision + 1,
              lastSuccess: summary,
            }
            if (inherited) next.exclusionScopeId = inherited
            else delete next.exclusionScopeId
            return next
          }),
          writes: [{ sourceId, handle }],
        }
      }, { scopeGuards: scopeGuard ? [scopeGuard] : undefined })
    },
    async repair(inputs, expectedRevision, isValid, scopeGuards) {
      if (inputs.length === 0) return null
      return update((current) => {
        if (isValid && !isValid()) return null
        if (current.revision !== expectedRevision) return null
        const repairing = new Set(inputs.map((input) => input.sourceId))
        if (repairing.size !== inputs.length) return null
        for (const input of inputs) {
          const source = current.sources.find((item) => item.sourceId === input.sourceId)
          if (!source) return null
          if (
            input.expectedSourceRevision !== undefined &&
            source.revision !== input.expectedSourceRevision
          ) {
            return null
          }
        }
        const inheritedScopes = inputs
          .map((input) => input.exclusionScopeId)
          .filter((scopeId): scopeId is string => typeof scopeId === 'string')
        // 同一作用域不能绑定两个文件；本批之外仍保留的来源也不能重复绑定。
        if (new Set(inheritedScopes).size !== inheritedScopes.length) return null
        for (const scopeId of inheritedScopes) {
          if (
            current.sources.some(
              (source) => !repairing.has(source.sourceId) && source.exclusionScopeId === scopeId,
            )
          ) {
            return null
          }
        }
        return {
          sources: current.sources.map((source) => {
            const input = inputs.find((item) => item.sourceId === source.sourceId)
            if (!input) return source
            const next: CsvSourceRecord = {
              ...source,
              name: input.handle.name,
              revision: source.revision + 1,
              lastSuccess: input.summary,
            }
            if (input.exclusionScopeId) next.exclusionScopeId = input.exclusionScopeId
            else delete next.exclusionScopeId
            return next
          }),
          writes: inputs.map((input) => ({
            sourceId: input.sourceId,
            handle: input.handle,
          })),
        }
      }, { scopeGuards: scopeGuards && scopeGuards.length > 0 ? scopeGuards : undefined })
    },
    async remove(sourceId) {
      const registry = await update((current) => ({
        sources: current.sources.filter((source) => source.sourceId !== sourceId),
        deletes: [sourceId],
      }))
      return registry ?? emptyCsvRegistry()
    },
    async clear() {
      const registry = await update((current) => ({
        sources: [],
        deletes: current.sources.map((source) => source.sourceId),
      }))
      return registry ?? emptyCsvRegistry()
    },
    async commit(revision, summaries, isValid) {
      return update((current) => {
        if (isValid && !isValid()) return null
        if (current.revision !== revision) return null
        return {
          sources: current.sources.map((source) => {
            const summary = summaries.get(source.sourceId)
            return summary ? { ...source, lastSuccess: summary } : source
          }),
        }
      }, { withHandles: false })
    },
  }
}

export function createIndexedDbCsvStore(): CsvSourceStore {
  return createSourceStore(loadCsvRegistry, loadCsvHandles, updateRegistry)
}

/** 降级模式只保存本次选择的 File，不持久化关联。 */
export function createMemoryCsvStore(): CsvSourceStore {
  let registry = emptyCsvRegistry()
  const handles = async (): Promise<Map<string, CsvFileHandle>> => {
    const map = new Map<string, CsvFileHandle>()
    for (const source of registry.sources) {
      if (source.handle) map.set(source.sourceId, source.handle)
    }
    return map
  }
  return createSourceStore(
    async () => copyRegistry(registry),
    handles,
    async (mutate, _options) => {
      const next = mutate(copyRegistry(registry))
      if (!next) return null
      const sources = next.sources.map((source) => {
        const written = next.writes?.find((item) => item.sourceId === source.sourceId)
        if (written) return { ...source, handle: written.handle }
        return source
      })
      registry = {
        id: CSV_REGISTRY_ID,
        revision: registry.revision + 1,
        sources: sources.filter((source) => !next.deletes?.includes(source.sourceId)),
      }
      return copyRegistry(registry)
    },
  )
}

export function createCsvStore(persistent: boolean): CsvSourceStore {
  return persistent ? createIndexedDbCsvStore() : createMemoryCsvStore()
}

function mapFileError(error: unknown): CsvFileError {
  if (error instanceof CsvFileError) return error
  const name = error instanceof Error ? error.name : ''
  if (name === 'NotFoundError') return new CsvFileError('文件不可用，请重新关联', 'not-found')
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new CsvFileError('没有读取权限，请先授权', 'permission')
  }
  return new CsvFileError(`读取失败：${errorMessage(error)}`, 'io')
}

/**
 * 每次刷新都通过句柄重新 getFile()，不复用上次的 File 对象；
 * 只有正确表头、没有数据行的文件是有效的 0 局数据源。
 */
export async function readCsvFile(handle: CsvFileHandle, now = Date.now()): Promise<CsvFileRead> {
  let file: File
  try {
    file = await withCsvTimeout(handle.getFile(), CSV_FILE_OPEN_TIMEOUT_MS, () => {
      throw new CsvFileError('打开文件超时，请重新关联原文件', 'io')
    })
  } catch (error) {
    throw mapFileError(error)
  }
  if (file.size > CSV_MAX_BYTES) {
    throw new CsvFileError('超过 20 MB', 'size')
  }
  let text: string
  try {
    text = await file.text()
  } catch (error) {
    throw mapFileError(error)
  }
  let parsed: ReturnType<typeof parseStatsCsv>
  try {
    parsed = parseStatsCsv(text)
  } catch (error) {
    throw new CsvFileError(errorMessage(error), 'format')
  }
  if (parsed.videos.length === 0 && parsed.errors.length > 0) {
    throw new CsvFileError(`没有有效数据（${parsed.errors[0]!.message}）`, 'invalid')
  }
  const summary: CsvSourceSummary = {
    readAt: now,
    validCount: parsed.videos.length,
    totalRows: parsed.total,
    invalidRows: parsed.errors.length,
    size: file.size,
    lastModified: file.lastModified,
  }
  return {
    summary,
    videos: parsed.videos,
    records: parsed.records,
    errors: parsed.errors,
  }
}

/**
 * 每次成功提交都按清单顺序重新编号：负 ID 全快照唯一，importOrder 连续且确定。
 * 内容和顺序相同时，反复刷新不会改变并列成绩的取舍。
 */
export function buildCsvSnapshot(sources: CsvLoadedSource[]): Video[] {
  const videos: Video[] = []
  for (const source of sources) {
    for (const video of source.videos) {
      const index = videos.length
      videos.push({ ...video, id: -(index + 1), importOrder: index })
    }
  }
  return videos
}

export function formatValidDelta(before: number, after: number): string {
  if (before === after) return `局数未变（${formatCount(after)} 局）`
  return `${formatCount(before)} → ${formatCount(after)} 局`
}

export async function isSameCsvHandle(a: CsvFileHandle, b: CsvFileHandle): Promise<boolean> {
  if (a === b) return true
  if (typeof a.isSameEntry !== 'function' || typeof b.isSameEntry !== 'function') return false
  try {
    return await withCsvTimeout(a.isSameEntry(b), CSV_IDENTITY_CHECK_TIMEOUT_MS, () => {
      throw new CsvIdentityError('文件身份检查超时，浏览器未返回结果')
    })
  } catch (error) {
    if (error instanceof CsvIdentityError) throw error
    const aborted =
      typeof DOMException !== 'undefined' &&
      error instanceof DOMException &&
      error.name === 'AbortError'
    throw new CsvIdentityError(
      aborted
        ? '浏览器中止文件身份检查'
        : `无法比较文件身份：${errorMessage(error)}`,
    )
  }
}

export type CsvPermissionState = PermissionState | 'unsupported' | 'timeout'

export async function queryCsvPermission(handle: CsvFileHandle): Promise<CsvPermissionState> {
  if (typeof handle.queryPermission !== 'function') return 'unsupported'
  try {
    return await withCsvTimeout(
      handle.queryPermission({ mode: 'read' }),
      CSV_PERMISSION_CHECK_TIMEOUT_MS,
      () => 'timeout' as const,
    )
  } catch {
    return 'denied'
  }
}

export function isPermissionGranted(state: CsvPermissionState): boolean {
  return state === 'granted' || state === 'unsupported'
}

export async function requestCsvPermission(handle: CsvFileHandle): Promise<CsvPermissionState> {
  if (typeof handle.requestPermission !== 'function') return queryCsvPermission(handle)
  try {
    return await withCsvTimeout(
      handle.requestPermission({ mode: 'read' }),
      CSV_PERMISSION_REQUEST_TIMEOUT_MS,
      () => 'timeout' as const,
    )
  } catch {
    return 'denied'
  }
}

export function canRememberCsvFiles(): boolean {
  return typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function'
}

export async function pickCsvFiles(multiple = true): Promise<CsvFileHandle[]> {
  const picker = typeof window !== 'undefined' ? window.showOpenFilePicker : undefined
  if (typeof picker !== 'function') throw new Error('当前浏览器不支持记住本地文件')
  const handles = await picker.call(window, {
    id: 'yuanshen-csv',
    multiple,
    types: [{ description: 'CSV 文件', accept: { 'text/csv': ['.csv'] } }],
  })
  return (handles ?? []) as unknown as CsvFileHandle[]
}
