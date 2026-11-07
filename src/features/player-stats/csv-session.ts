/**
 * CSV 读取与快照协调：批次暂存、权限检查、整批提交、取消和版本冲突。
 *
 * 视图只负责触发操作和渲染；所有文件读取都在这里按「读完整批 → 一次提交」处理，
 * 任何一个文件失败都不替换页面上的旧快照。
 */

import { formatCount } from '../../shared/format'
import { errorMessage } from '../../shared/ui'
import {
  CsvFileError,
  CsvIdentityError,
  buildCsvSnapshot,
  createCsvSourceId,
  formatValidDelta,
  isPermissionGranted,
  isSameCsvHandle,
  queryCsvPermission,
  readCsvFile,
  requestCsvPermission,
} from './csv-sources'
import type {
  CsvAddInput,
  CsvFileHandle,
  CsvLoadedSource,
  CsvPermissionState,
  CsvSourceRecord,
  CsvScopeGuard,
  CsvSourceRegistry,
  CsvSourceStore,
  CsvSourceSummary,
} from './csv-sources'
import type { CsvRecord } from './csv'
import type { Video } from './model'

/** 添加 / 重新关联的结果，供视图决定是否自动切到 CSV。 */
export type CsvOperationResult = 'success' | 'cancelled' | 'failed'

interface StagedAdd {
  input: CsvAddInput
  videos: Video[]
  records: CsvRecord[]
}

export interface CsvSourceDelta {
  before: number
  after: number
}

export interface CsvSessionState {
  /** 关联清单是否已经从数据库（或内存清单）恢复。 */
  ready: boolean
  sources: CsvSourceRecord[]
  revision: number
  /** 本页已加载的来源快照，按 sourceId 保存。 */
  loaded: Map<string, CsvLoadedSource>
  loading: boolean
  progress: { done: number; total: number } | null
  message: string
  errors: string[]
  needsPermission: string[]
  /** 本次刷新成功后的逐文件局数变化。 */
  deltas: Map<string, CsvSourceDelta>
  /** 快照内容版本；变化时视图才重建分析，不因进度提示反复重算。 */
  snapshotVersion: number
}

export interface CsvSessionOptions {
  store: CsvSourceStore
  onChange?: () => void
  readFile?: (handle: CsvFileHandle, now: number) => ReturnType<typeof readCsvFile>
  permission?: (handle: CsvFileHandle) => Promise<CsvPermissionState>
  requestPermission?: (handle: CsvFileHandle) => Promise<CsvPermissionState>
  now?: () => number
}

/** 重新关联确认时依据的清单 / 来源版本；对话框等待期间变化则旧确认作废。 */
export interface CsvRelinkBasis {
  registryRevision: number
  sourceRevision?: number
}

export interface CsvSession {
  readonly state: CsvSessionState
  restore(): Promise<void>
  refreshAll(): Promise<void>
  addFiles(handles: CsvFileHandle[]): Promise<CsvOperationResult>
  relink(
    sourceId: string,
    handle: CsvFileHandle,
    exclusionScopeId?: string | null,
    basis?: CsvRelinkBasis,
    scopeGuard?: CsvScopeGuard,
  ): Promise<CsvOperationResult>
  removeSource(sourceId: string): Promise<void>
  removeAll(): Promise<void>
  grant(sourceId: string): Promise<void>
  cancel(): void
  checkRegistry(): Promise<void>
  setMessage(message: string): void
  clearMessage(): void
  hasSnapshot(): boolean
  videos(): Video[]
  /** 按关联清单顺序返回本页已成功加载的原始快照（含原始列身份）。 */
  loadedSources(): CsvLoadedSource[]
  loadedCount(): number
  sourceSummary(sourceId: string): CsvSourceSummary | null
  destroy(): void
}

function describeFailure(error: unknown): string {
  if (error instanceof CsvFileError || error instanceof CsvIdentityError) return error.message
  return errorMessage(error)
}

export function createCsvSession(options: CsvSessionOptions): CsvSession {
  const state: CsvSessionState = {
    ready: false,
    sources: [],
    revision: 0,
    loaded: new Map(),
    loading: false,
    progress: null,
    message: '',
    errors: [],
    needsPermission: [],
    deltas: new Map(),
    snapshotVersion: 0,
  }

  let version = 0
  let disposed = false
  let snapshotCache: { version: number; videos: Video[] } | null = null

  const now = (): number => options.now?.() ?? Date.now()
  const read = (handle: CsvFileHandle, at: number) =>
    (options.readFile ?? readCsvFile)(handle, at)
  const queryPermission = options.permission ?? queryCsvPermission
  const requestPermission = options.requestPermission ?? requestCsvPermission

  function notify(): void {
    options.onChange?.()
  }

  function hasSnapshot(): boolean {
    return (
      state.sources.length > 0 &&
      state.sources.every((source) => state.loaded.has(source.sourceId))
    )
  }

  function videos(): Video[] {
    if (!hasSnapshot()) return []
    if (!snapshotCache || snapshotCache.version !== state.snapshotVersion) {
      const sources = state.sources.map((source) => state.loaded.get(source.sourceId)!)
      snapshotCache = { version: state.snapshotVersion, videos: buildCsvSnapshot(sources) }
    }
    return snapshotCache.videos
  }

  function loadedSources(): CsvLoadedSource[] {
    if (!hasSnapshot()) return []
    return state.sources.map((source) => state.loaded.get(source.sourceId)!)
  }

  function loadedCount(): number {
    return videos().length
  }

  function sourceSummary(sourceId: string): CsvSourceSummary | null {
    const loaded = state.loaded.get(sourceId)
    if (loaded) return loaded.summary
    return state.sources.find((source) => source.sourceId === sourceId)?.lastSuccess ?? null
  }

  function adopt(registry: CsvSourceRegistry): void {
    const before = state.sources.map((source) => source.sourceId).join('|')
    const after = registry.sources.map((source) => source.sourceId).join('|')
    let changed = before !== after
    const byId = new Map(registry.sources.map((source) => [source.sourceId, source]))
    for (const [sourceId, loaded] of [...state.loaded]) {
      const record = byId.get(sourceId)
      // 同一 sourceId 被另一页面重新关联后 revision 变化，旧录像不能再使用。
      if (!record || record.revision !== loaded.sourceRevision) {
        state.loaded.delete(sourceId)
        changed = true
      }
    }
    state.needsPermission = state.needsPermission.filter((sourceId) => byId.has(sourceId))
    state.sources = registry.sources
    state.revision = registry.revision
    if (changed) state.snapshotVersion += 1
  }

  function invalidate(): number {
    version += 1
    return version
  }

  function stopLoading(): void {
    state.loading = false
    state.progress = null
  }

  async function restore(): Promise<void> {
    if (state.ready || disposed) return
    const request = version
    try {
      const registry = await options.store.load()
      if (disposed || request !== version) return
      adopt(registry)
      state.ready = true
    } catch (error) {
      if (disposed || request !== version) return
      state.ready = true
      state.message = `读取 CSV 关联失败：${errorMessage(error)}`
    }
    if (!disposed) notify()
  }

  async function refreshAll(): Promise<void> {
    if (state.loading || disposed) return
    if (!state.ready) await restore()
    if (disposed) return
    const request = invalidate()

    let registry: CsvSourceRegistry
    try {
      registry = await options.store.load()
    } catch (error) {
      if (request !== version) return
      state.message = `读取 CSV 关联失败：${errorMessage(error)}`
      notify()
      return
    }
    if (request !== version) return
    adopt(registry)
    if (state.sources.length === 0) {
      state.message = '还没有关联 CSV 文件，请先添加。'
      notify()
      return
    }

    // 先检查权限：需要授权的文件不在后台弹框，由用户点「授权读取」。
    const pending: string[] = []
    for (const source of state.sources) {
      const permission = await queryPermission(source.handle)
      if (request !== version) return
      if (!isPermissionGranted(permission)) pending.push(source.sourceId)
    }
    state.needsPermission = pending
    if (pending.length > 0) {
      state.message = `${pending.length} 个文件需要授权读取：点击文件行的「授权读取」，全部完成后再次点击「刷新」。`
      notify()
      return
    }

    const beforeCounts = new Map<string, number>()
    for (const source of state.sources) {
      const before =
        state.loaded.get(source.sourceId)?.summary.validCount ?? source.lastSuccess?.validCount
      if (before !== undefined) beforeCounts.set(source.sourceId, before)
    }

    const total = state.sources.length
    state.loading = true
    state.progress = { done: 0, total }
    state.message = ''
    state.errors = []
    notify()

    const staged: CsvLoadedSource[] = []
    const errors: string[] = []
    const failed: string[] = []
    let done = 0
    for (const source of state.sources) {
      try {
        const result = await read(source.handle, now())
        if (request !== version) return
        staged.push({
          sourceId: source.sourceId,
          sourceRevision: source.revision,
          name: source.name,
          videos: result.videos,
          records: result.records,
          summary: result.summary,
        })
        for (const error of result.errors) {
          errors.push(`${source.name} 第 ${error.line} 行：${error.message}`)
        }
      } catch (error) {
        if (request !== version) return
        failed.push(`${source.name}：${describeFailure(error)}`)
        if (error instanceof CsvFileError && error.code === 'permission') {
          state.needsPermission = [...new Set([...state.needsPermission, source.sourceId])]
        }
      }
      done += 1
      state.progress = { done, total }
      notify()
    }

    if (request !== version) return
    if (failed.length > 0) {
      stopLoading()
      state.errors = errors
      state.message = `刷新失败：${failed.join('；')}。已保留上次成功结果。`
      notify()
      return
    }

    const summaries = new Map(staged.map((source) => [source.sourceId, source.summary]))
    let committed: CsvSourceRegistry | null
    try {
      // 事务内再检查一次批次是否仍有效，取消后不能再写回摘要。
      committed = await options.store.commit(state.revision, summaries, () =>
        request === version && !disposed,
      )
    } catch (error) {
      if (request !== version) return
      stopLoading()
      state.errors = errors
      state.message = `保存读取结果失败：${errorMessage(error)}。已保留上次结果。`
      notify()
      return
    }
    if (request !== version) return
    if (!committed) {
      // 其他页面改过清单：采用新清单，等用户重新刷新，不能拿旧清单覆盖。
      stopLoading()
      let fresh: CsvSourceRegistry | null = null
      try {
        fresh = await options.store.load()
      } catch {
        // 读不到就保持原清单，提示仍然有效。
      }
      // 读取清单期间可能又被移除全部 / 取消 / 切源，旧结果必须丢弃。
      if (request !== version) return
      if (fresh) adopt(fresh)
      state.snapshotVersion += 1
      state.errors = errors
      state.message = '关联清单已在其他页面变化，请重新刷新。'
      notify()
      return
    }

    state.sources = committed.sources
    state.revision = committed.revision
    state.loaded = new Map(staged.map((source) => [source.sourceId, source]))
    state.needsPermission = []
    state.deltas = new Map()
    let beforeTotal = 0
    let allKnown = true
    for (const source of staged) {
      const before = beforeCounts.get(source.sourceId)
      const after = source.summary.validCount
      if (before === undefined) {
        allKnown = false
        continue
      }
      beforeTotal += before
      state.deltas.set(source.sourceId, { before, after })
    }
    state.errors = errors
    state.message = describeRefresh(staged, {
      beforeTotal,
      afterTotal: staged.reduce((sum, source) => sum + source.videos.length, 0),
      allKnown,
      deltas: state.deltas,
    })
    state.snapshotVersion += 1
    stopLoading()
    notify()
  }

  function describeRefresh(
    staged: CsvLoadedSource[],
    info: {
      beforeTotal: number
      afterTotal: number
      allKnown: boolean
      deltas: Map<string, CsvSourceDelta>
    },
  ): string {
    const count = staged.length
    const changed = [...info.deltas].filter(([, delta]) => delta.before !== delta.after)
    if (info.allKnown && changed.length === 0) {
      return `刷新完成：${count} 个文件，局数未变（${formatCount(info.afterTotal)} 局）。`
    }
    if (info.allKnown && changed.length > 0) {
      const parts = changed.map(([sourceId, delta]) => {
        const name = staged.find((source) => source.sourceId === sourceId)?.name ?? '文件'
        return `${name} ${formatValidDelta(delta.before, delta.after)}`
      })
      return `刷新完成：${count} 个文件，${formatCount(info.beforeTotal)} → ${formatCount(info.afterTotal)} 局（${parts.join('；')}）。`
    }
    return `刷新完成：${count} 个文件，${formatCount(info.afterTotal)} 局。`
  }

  /** 已有来源和本批暂存文件使用同一套身份判断。 */
  async function hasDuplicate(
    handle: CsvFileHandle,
    staged: readonly StagedAdd[] = [],
    excludeSourceId?: string,
  ): Promise<boolean> {
    const candidates = [
      ...state.sources.filter((source) => source.sourceId !== excludeSourceId).map((source) => source.handle),
      ...staged.map((item) => item.input.handle),
    ]
    for (const candidate of candidates) {
      if (await isSameCsvHandle(handle, candidate)) return true
    }
    return false
  }

  async function ensureReadable(handle: CsvFileHandle, request: number): Promise<boolean> {
    const permission = await queryPermission(handle)
    if (request !== version) return false
    if (isPermissionGranted(permission)) return true
    const granted = await requestPermission(handle)
    return request === version && isPermissionGranted(granted)
  }

  async function addFiles(handles: CsvFileHandle[]): Promise<CsvOperationResult> {
    if (state.loading || disposed || handles.length === 0) return 'cancelled'
    if (!state.ready) await restore()
    if (disposed) return 'cancelled'
    const request = invalidate()
    const current = (): boolean => request === version && !disposed

    let registry: CsvSourceRegistry
    try {
      registry = await options.store.load()
    } catch (error) {
      if (!current()) return 'cancelled'
      state.message = `读取 CSV 关联失败：${errorMessage(error)}`
      notify()
      return 'failed'
    }
    if (!current()) return 'cancelled'
    adopt(registry)
    state.deltas.clear()

    state.loading = true
    state.progress = null
    state.message = '正在读取选中的文件…'
    state.errors = []
    notify()

    // 先读完、校验完再一次性写库，取消时不能留下半批关联。
    const staged: StagedAdd[] = []
    const failed: string[] = []
    const duplicates: string[] = []
    const errors: string[] = []
    try {
      for (const handle of handles) {
        if (!current()) return 'cancelled'
        try {
          const duplicate = await hasDuplicate(handle, staged)
          if (!current()) return 'cancelled'
          if (duplicate) {
            duplicates.push(handle.name)
            continue
          }
          if (!(await ensureReadable(handle, request))) {
            if (!current()) return 'cancelled'
            failed.push(`${handle.name}：没有读取权限`)
            continue
          }
          const result = await read(handle, now())
          if (!current()) return 'cancelled'
          staged.push({
            input: { sourceId: createCsvSourceId(), handle, summary: result.summary },
            videos: result.videos,
            records: result.records,
          })
          for (const error of result.errors) {
            errors.push(`${handle.name} 第 ${error.line} 行：${error.message}`)
          }
        } catch (error) {
          if (!current()) return 'cancelled'
          failed.push(`${handle.name}：${describeFailure(error)}`)
        }
      }

      if (!current()) return 'cancelled'
      state.errors = errors
      if (staged.length === 0) {
        state.message = describeAdd([], duplicates, failed)
        return 'failed'
      }

      let committed: CsvSourceRegistry | null = null
      let accepted = staged
      for (let attempt = 0; attempt < 2; attempt += 1) {
        committed = await options.store.addMany(
          accepted.map((item) => item.input), registry.revision, current,
        )
        if (!current()) return 'cancelled'
        if (committed) break
        if (attempt === 1) {
          state.message = '关联清单已在其他页面变化，请稍后重新添加。'
          return 'failed'
        }

        // 只重试一次，先读取新清单并重新判断身份，不能直接重放旧提交。
        try {
          registry = await options.store.load()
        } catch (error) {
          if (!current()) return 'cancelled'
          state.message = `读取 CSV 关联失败：${errorMessage(error)}`
          return 'failed'
        }
        if (!current()) return 'cancelled'
        adopt(registry)
        accepted = []
        for (const item of staged) {
          try {
            const duplicate = await hasDuplicate(item.input.handle, accepted)
            if (!current()) return 'cancelled'
            if (duplicate) duplicates.push(item.input.handle.name)
            else accepted.push(item)
          } catch (error) {
            if (!current()) return 'cancelled'
            failed.push(`${item.input.handle.name}：${describeFailure(error)}`)
          }
        }
        if (accepted.length === 0) {
          state.message = '关联清单已在其他页面变化，这些文件已关联或无法添加，请刷新后重试。'
          return 'failed'
        }
      }
      if (!committed) return 'failed'

      adopt(committed)
      const byId = new Map(committed.sources.map((source) => [source.sourceId, source]))
      const added: CsvLoadedSource[] = []
      for (const item of accepted) {
        const record = byId.get(item.input.sourceId)
        if (!record) continue
        const loaded: CsvLoadedSource = {
          sourceId: record.sourceId,
          sourceRevision: record.revision,
          name: record.name,
          videos: item.videos,
          records: item.records,
          summary: item.input.summary,
        }
        state.loaded.set(record.sourceId, loaded)
        added.push(loaded)
      }
      if (added.length > 0) state.snapshotVersion += 1
      state.message = describeAdd(added, duplicates, failed)
      if (!hasSnapshot() && state.sources.length > 0) {
        state.message += ' 点击「刷新」加载全部成绩。'
      }
      return added.length > 0 ? 'success' : 'failed'
    } catch (error) {
      if (!current()) return 'cancelled'
      state.message = `保存关联失败：${errorMessage(error)}。原关联和成绩保持不变。`
      return 'failed'
    } finally {
      if (current()) {
        stopLoading()
        notify()
      }
    }
  }

  function describeAdd(
    added: CsvLoadedSource[],
    duplicates: string[],
    failed: string[],
  ): string {
    const parts: string[] = []
    if (added.length > 0) {
      const count = added.reduce((sum, source) => sum + source.summary.validCount, 0)
      parts.push(`已添加 ${added.length} 个文件（${formatCount(count)} 局）`)
    }
    if (duplicates.length > 0) {
      parts.push(`${duplicates.join('、')} 已在关联清单中，更新请点「刷新」`)
    }
    if (failed.length > 0) {
      parts.push(`失败：${failed.join('；')}`)
    }
    if (parts.length === 0) return '没有添加任何文件。'
    const text = `${parts.join('；')}。`
    if (added.length === 0) return `${text} 原关联和成绩保持不变。`
    return text
  }

  async function relink(
    sourceId: string,
    handle: CsvFileHandle,
    exclusionScopeId?: string | null,
    basis?: CsvRelinkBasis,
    scopeGuard?: CsvScopeGuard,
  ): Promise<CsvOperationResult> {
    if (state.loading || disposed) return 'cancelled'
    if (!state.ready) await restore()
    if (disposed) return 'cancelled'
    const request = invalidate()
    const current = (): boolean => request === version && !disposed

    let registry: CsvSourceRegistry
    try {
      registry = await options.store.load()
    } catch (error) {
      if (!current()) return 'cancelled'
      state.message = `读取 CSV 关联失败：${errorMessage(error)}`
      notify()
      return 'failed'
    }
    if (!current()) return 'cancelled'
    adopt(registry)
    const source = state.sources.find((item) => item.sourceId === sourceId)
    if (!source) {
      state.message = '该文件已在其他页面移除，请刷新关联清单。'
      notify()
      return 'failed'
    }
    if (
      basis &&
      (registry.revision !== basis.registryRevision ||
        (basis.sourceRevision !== undefined &&
          source.revision !== basis.sourceRevision))
    ) {
      state.message = '关联清单已在其他页面变化，请重新选择并确认；原来源未改变。'
      notify()
      return 'failed'
    }
    const wasLoaded = state.loaded.has(sourceId)

    state.loading = true
    state.progress = null
    state.message = '正在读取文件…'
    notify()
    try {
      const duplicate = await hasDuplicate(handle, [], sourceId)
      if (!current()) return 'cancelled'
      if (duplicate) {
        state.message = `${handle.name} 已关联为另一来源，不能重复绑定；原来源未改变。`
        return 'failed'
      }
      if (!(await ensureReadable(handle, request))) {
        if (!current()) return 'cancelled'
        state.message = `${handle.name}：没有读取权限，原来源未改变。`
        return 'failed'
      }
      const result = await read(handle, now())
      if (!current()) return 'cancelled'
      const next = await options.store.relink(
        sourceId,
        handle,
        result.summary,
        basis?.registryRevision ?? registry.revision,
        current,
        exclusionScopeId ?? null,
        basis?.sourceRevision,
        scopeGuard,
      )
      if (!current()) return 'cancelled'
      if (!next) {
        let fresh: CsvSourceRegistry | null = null
        try {
          fresh = await options.store.load()
        } catch {
          // 读不到也按冲突处理，至少不能继续使用旧来源。
        }
        if (!current()) return 'cancelled'
        if (fresh) adopt(fresh)
        state.message = fresh?.sources.some((item) => item.sourceId === sourceId)
          ? '关联清单或排除规则已在其他页面变化，请重新关联；原来源未改变。'
          : '该文件已在其他页面移除，原来源未改变。'
        return 'failed'
      }
      adopt(next)
      const record = next.sources.find((item) => item.sourceId === sourceId)
      if (!record) {
        state.message = '该文件已在其他页面移除，原来源未改变。'
        return 'failed'
      }
      if (wasLoaded) {
        state.loaded.set(sourceId, {
          sourceId,
          sourceRevision: record.revision,
          name: record.name,
          videos: result.videos,
          records: result.records,
          summary: result.summary,
        })
        state.snapshotVersion += 1
      }
      state.deltas.clear()
      state.message = `已重新关联 ${record.name}：${formatCount(result.summary.validCount)} 局。`
      if (!hasSnapshot()) state.message += ' 点击「刷新」加载全部成绩。'
      return 'success'
    } catch (error) {
      if (!current()) return 'cancelled'
      state.message = `重新关联失败：${describeFailure(error)}。原来源未改变。`
      return 'failed'
    } finally {
      if (request === version) {
        stopLoading()
        notify()
      }
    }
  }

  async function removeSource(sourceId: string): Promise<void> {
    if (state.loading || disposed) return
    const request = invalidate()
    const name = state.sources.find((source) => source.sourceId === sourceId)?.name ?? '文件'
    try {
      const next = await options.store.remove(sourceId)
      if (request !== version) return
      adopt(next)
      state.loaded.delete(sourceId)
      state.deltas.delete(sourceId)
      state.needsPermission = state.needsPermission.filter((id) => id !== sourceId)
      state.snapshotVersion += 1
      if (state.sources.length === 0) {
        state.message = ''
        state.errors = []
      } else {
        state.message = `已移除 ${name}。`
        if (!hasSnapshot()) state.message += ' 点击「刷新」加载剩余文件。'
      }
    } catch (error) {
      if (request !== version) return
      state.message = `移除失败：${errorMessage(error)}。`
    }
    notify()
  }

  async function removeAll(): Promise<void> {
    if (disposed) return
    invalidate()
    stopLoading()
    try {
      const registry = await options.store.clear()
      adopt(registry)
      state.loaded.clear()
      state.deltas.clear()
      state.needsPermission = []
      state.errors = []
      state.message = ''
      state.snapshotVersion += 1
    } catch (error) {
      state.message = `移除全部失败：${errorMessage(error)}。`
    }
    notify()
  }

  async function grant(sourceId: string): Promise<void> {
    if (state.loading || disposed) return
    const source = state.sources.find((item) => item.sourceId === sourceId)
    if (!source) return
    const result = await requestPermission(source.handle)
    state.needsPermission = state.needsPermission.filter((id) => id !== sourceId)
    if (!isPermissionGranted(result)) {
      state.message = `未获得 ${source.name} 的读取权限。`
      notify()
      return
    }
    state.message =
      state.needsPermission.length === 0
        ? '所有文件已授权，点击「刷新」读取。'
        : `已授权 ${source.name}，还有 ${state.needsPermission.length} 个文件需要授权。`
    notify()
  }

  function cancel(): void {
    if (disposed) return
    invalidate()
    if (!state.loading) return
    stopLoading()
    state.message = '已取消读取，已保留上次结果。'
    notify()
  }

  async function checkRegistry(): Promise<void> {
    if (state.loading || disposed || !state.ready) return
    const request = version
    const wasEmpty = state.sources.length === 0
    let registry: CsvSourceRegistry
    try {
      registry = await options.store.load()
    } catch {
      return
    }
    // 等待期间发生取消、移除全部、刷新或切源后，旧检查结果必须作废；
    // 多个检查乱序返回时，较早的检查不能把清单版本倒退回去。
    if (disposed || request !== version) return
    if (registry.revision <= state.revision) return
    adopt(registry)
    if (registry.sources.length === 0) {
      state.message = '关联清单已在其他页面变化。'
    } else if (wasEmpty) {
      state.message = '其他页面已添加 CSV 关联，点击「刷新」加载成绩。'
    } else {
      state.message = '关联清单已在其他页面变化，请点击「刷新」更新成绩。'
    }
    notify()
  }

  function setMessage(message: string): void {
    state.message = message
    notify()
  }

  function clearMessage(): void {
    if (state.message === '') return
    state.message = ''
    notify()
  }

  function destroy(): void {
    disposed = true
    invalidate()
    state.loading = false
  }

  return {
    state,
    restore,
    refreshAll,
    addFiles,
    relink,
    removeSource,
    removeAll,
    grant,
    cancel,
    checkRegistry,
    setMessage,
    clearMessage,
    hasSnapshot,
    videos,
    loadedSources,
    loadedCount,
    sourceSummary,
    destroy,
  }
}
