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
import type { CsvError, CsvRecord } from './csv'
import type { Video } from './model'

export const CSV_MAX_BYTES = 20 * 1024 * 1024
export const CSV_REGISTRY_ID = 'current'

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
  handle: CsvFileHandle
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

/** 重新关联沿用规则时，提交阶段仍需核对的排除作用域修订。 */
export interface CsvScopeGuard {
  scopeId: string
  revision: number
  /** 内存存储或跨 store 预检；IndexedDB 事务内还会再次读取。 */
  verify?: () => Promise<boolean>
}

export interface CsvSourceStore {
  load(): Promise<CsvSourceRegistry>
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
    if (!record.handle || typeof record.handle !== 'object') continue
    sources.push({
      sourceId: record.sourceId,
      name: record.name,
      handle: record.handle as CsvFileHandle,
      addedAt: typeof record.addedAt === 'number' ? record.addedAt : 0,
      revision: typeof record.revision === 'number' && record.revision >= 0 ? record.revision : 0,
      lastSuccess: isSummary(record.lastSuccess) ? record.lastSuccess : null,
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

async function updateRegistry(
  mutate: (registry: CsvSourceRegistry) => CsvSourceRegistry | null,
  scopeGuard?: CsvScopeGuard,
): Promise<CsvSourceRegistry | null> {
  const db = await getDb()
  const tx = db.transaction(
    scopeGuard ? ['csvSources', 'statExclusions'] : ['csvSources'],
    'readwrite',
  )
  const sourceStore = tx.objectStore('csvSources')
  if (scopeGuard) {
    // 关联清单与排除作用域在同一事务中校验，文件读取期间规则变化也不会写绑定。
    const scope = await tx.objectStore('statExclusions').get(scopeGuard.scopeId)
    if (!scope || scope.revision !== scopeGuard.revision) {
      await tx.done
      return null
    }
  }
  const current = normalizeCsvRegistry(await sourceStore.get(CSV_REGISTRY_ID))
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
  await sourceStore.put(registry)
  await tx.done
  return registry
}

export async function loadCsvRegistry(): Promise<CsvSourceRegistry> {
  const db = await getDb()
  return normalizeCsvRegistry(await db.get('csvSources', CSV_REGISTRY_ID))
}

type RegistryMutation = (registry: CsvSourceRegistry) => CsvSourceRegistry | null

/** 两种存储只负责读写，来源更新与版本校验共用同一份实现。 */
function createSourceStore(
  load: CsvSourceStore['load'],
  update: (
    mutate: RegistryMutation,
    scopeGuard?: CsvScopeGuard,
  ) => Promise<CsvSourceRegistry | null>,
): CsvSourceStore {
  return {
    load,
    async addMany(inputs, expectedRevision, isValid) {
      if (inputs.length === 0) return null
      const addedAt = Date.now()
      return update((current) => {
        if (isValid && !isValid()) return null
        if (current.revision !== expectedRevision) return null
        const existing = new Set(current.sources.map((source) => source.sourceId))
        const added = inputs
          .filter((input) => !existing.has(input.sourceId))
          .map<CsvSourceRecord>((input) => ({
            sourceId: input.sourceId,
            name: input.handle.name,
            handle: input.handle,
            addedAt,
            revision: 1,
            lastSuccess: input.summary,
          }))
        if (added.length === 0) return null
        return { ...current, sources: [...current.sources, ...added] }
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
          ...current,
          sources: current.sources.map((item) => {
            if (item.sourceId !== sourceId) return item
            const next: CsvSourceRecord = {
              ...item,
              name: handle.name,
              handle,
              revision: item.revision + 1,
              lastSuccess: summary,
            }
            if (inherited) next.exclusionScopeId = inherited
            else delete next.exclusionScopeId
            return next
          }),
        }
      }, scopeGuard)
    },
    async remove(sourceId) {
      const registry = await update((current) => ({
        ...current,
        sources: current.sources.filter((source) => source.sourceId !== sourceId),
      }))
      return registry ?? emptyCsvRegistry()
    },
    async clear() {
      const registry = await update((current) => ({ ...current, sources: [] }))
      return registry ?? emptyCsvRegistry()
    },
    async commit(revision, summaries, isValid) {
      return update((current) => {
        if (isValid && !isValid()) return null
        if (current.revision !== revision) return null
        return {
          ...current,
          sources: current.sources.map((source) => {
            const summary = summaries.get(source.sourceId)
            return summary ? { ...source, lastSuccess: summary } : source
          }),
        }
      })
    },
  }
}

export function createIndexedDbCsvStore(): CsvSourceStore {
  return createSourceStore(loadCsvRegistry, updateRegistry)
}

/** 降级模式只保存本次选择的 File，不持久化关联。 */
export function createMemoryCsvStore(): CsvSourceStore {
  let registry = emptyCsvRegistry()
  return createSourceStore(
    async () => copyRegistry(registry),
    async (mutate, _scopeGuard) => {
      const next = mutate(copyRegistry(registry))
      if (!next) return null
      registry = { ...next, id: CSV_REGISTRY_ID, revision: registry.revision + 1 }
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
    file = await handle.getFile()
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
    return await a.isSameEntry(b)
  } catch (error) {
    throw new CsvIdentityError(`无法比较文件身份：${errorMessage(error)}`)
  }
}

export type CsvPermissionState = PermissionState | 'unsupported'

export async function queryCsvPermission(handle: CsvFileHandle): Promise<CsvPermissionState> {
  if (typeof handle.queryPermission !== 'function') return 'unsupported'
  try {
    return await handle.queryPermission({ mode: 'read' })
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
    return await handle.requestPermission({ mode: 'read' })
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
