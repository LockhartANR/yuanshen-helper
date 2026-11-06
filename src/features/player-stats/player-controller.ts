import type { PlayerVideoRow } from '../../shared/db'
import { onDbBlocked } from '../../shared/db'
import { errorMessage, isAbortError } from '../../shared/ui'
import { fetchUserInfo } from './api'
import { joinVideos } from './compute'
import {
  canRememberCsvFiles,
  createCsvStore,
  pickCsvFiles,
} from './csv-sources'
import type { CsvFileHandle } from './csv-sources'
import { createCsvSession } from './csv-session'
import type { CsvSession } from './csv-session'
import type { PlayerLaunch, PlayerPage } from './launch'
import type { DatasetSnapshot, Video } from './model'
import { launchMode } from './player-state'
import type {
  PlayerFilters,
  PlayerSnapshot,
  PlayerSource,
} from './player-state'
import { ensureDetails, loadPlayer } from './service'

const CSV_DB_BLOCKED_MESSAGE =
  '本地数据库需要升级但被其他页面占用：请关闭或刷新其他元神助手页面后重试。'

type CsvSelectionContext =
  | { kind: 'add'; flow: number }
  | { kind: 'relink'; flow: number; sourceId: string }

export interface PlayerControllerOptions {
  launch: PlayerLaunch
  /** 浏览器不支持文件句柄 API 时，由视图点击隐藏 input 并返回本次选择的文件。 */
  requestFiles?: (multiple: boolean) => Promise<File[]>
  loadPlayer?: typeof loadPlayer
  ensureDetails?: typeof ensureDetails
  fetchUserInfo?: typeof fetchUserInfo
  pickCsvFiles?: typeof pickCsvFiles
  createCsvStore?: typeof createCsvStore
  createCsvSession?: typeof createCsvSession
  canRememberCsvFiles?: typeof canRememberCsvFiles
}

export interface PlayerController {
  getSnapshot(): PlayerSnapshot
  getCsvSession(): CsvSession
  subscribe(listener: (snapshot: PlayerSnapshot) => void): () => void
  start(): Promise<void>
  setSource(source: PlayerSource): void
  setPage(page: PlayerPage): void
  setFilters(patch: Partial<PlayerFilters>): void
  refresh(): Promise<void>
  cancel(): void
  enterCsvSource(): Promise<void>
  addCsvFiles(): Promise<void>
  relinkCsvSource(sourceId: string): Promise<void>
  removeCsvSource(sourceId: string): Promise<void>
  removeAllCsv(): Promise<void>
  refreshCsv(): Promise<void>
  cancelCsv(): void
  grantCsv(sourceId: string): Promise<void>
  checkCsvRegistry(): Promise<void>
  /** 页面级提示（例如「我的成绩」跳转失败），与 CSV 解析消息分开。 */
  setMessage(message: string): void
  destroy(): void
}

function fileHandle(file: File): CsvFileHandle {
  const handle = {
    name: file.name,
    file,
    getFile: async (): Promise<File> => file,
    queryPermission: async (): Promise<PermissionState> => 'granted',
    requestPermission: async (): Promise<PermissionState> => 'granted',
    isSameEntry: async (other: CsvFileHandle): Promise<boolean> =>
      (other as CsvFileHandle & { file?: File }).file === file,
  }
  return handle
}

/**
 * 玩家页面数据源控制器：网站请求、取消、未过审补抓、来源切换、
 * 当前快照选择与 CSV session 编排都集中在这里；不接触 DOM。
 */
export function createPlayerController(options: PlayerControllerOptions): PlayerController {
  const { launch } = options
  const { standaloneCsv, embedded, siteUserId } = launchMode(launch)
  const load = options.loadPlayer ?? loadPlayer
  const ensure = options.ensureDetails ?? ensureDetails
  const fetchInfo = options.fetchUserInfo ?? fetchUserInfo
  const pickFiles = options.pickCsvFiles ?? pickCsvFiles
  const createStore = options.createCsvStore ?? createCsvStore
  const createSession = options.createCsvSession ?? createCsvSession
  const canRemember = options.canRememberCsvFiles ?? canRememberCsvFiles
  const persistentCsv = canRemember()

  let source: PlayerSource = standaloneCsv ? 'csv' : 'site'
  let page: PlayerPage = launch.initialPage
  const filters: PlayerFilters = {
    software: 'all',
    nfOnly: false,
    includeUnapproved: false,
    pbStat: 'time',
  }
  let rows: PlayerVideoRow[] = []
  let videos: Video[] = []
  let loading = false
  let loadingText = ''
  let message = ''
  let updatedAt = 0
  let fromCache = false
  let siteName = siteUserId === null ? '本地 CSV' : `#${siteUserId}`
  let datasetVersion = 0
  let dataset: DatasetSnapshot = {
    source,
    identity: source === 'csv' ? 'csv' : `site:${siteUserId}`,
    contentVersion: 0,
    videos: [],
  }

  let siteController: AbortController | null = null
  let requestVersion = 0
  let pendingUnapproved = false
  let csvFlow = 0
  let appliedCsvSnapshot = -1
  let sourceFlow = 0
  let destroyed = false
  const listeners = new Set<(snapshot: PlayerSnapshot) => void>()

  const session: CsvSession = createSession({
    store: createStore(persistentCsv),
    onChange: () => {
      if (destroyed) return
      if (source === 'csv') syncCsvSnapshot()
      emit()
    },
  })
  const offDbBlocked = onDbBlocked(() => session.setMessage(CSV_DB_BLOCKED_MESSAGE))

  function emit(): void {
    if (destroyed) return
    const snapshot = getSnapshot()
    for (const listener of [...listeners]) listener(snapshot)
  }

  function touchDataset(): void {
    datasetVersion += 1
    dataset = {
      source,
      identity: source === 'csv' ? `csv:${session.state.revision}` : `site:${siteUserId ?? 0}`,
      contentVersion: datasetVersion,
      videos,
    }
  }

  function syncCsvSnapshot(): void {
    if (session.state.snapshotVersion === appliedCsvSnapshot) return
    appliedCsvSnapshot = session.state.snapshotVersion
    videos = session.videos()
    touchDataset()
  }

  function rebuild(): void {
    if (source === 'csv') {
      syncCsvSnapshot()
    } else {
      const metas = rows.map((row) => ({
        id: row.id,
        upload_time: row.uploadTime,
        state: row.state,
        ongoing_tournament: row.ongoing,
      }))
      const details = new Map(
        rows.filter((row) => row.detail !== null).map((row) => [row.id, row.detail!]),
      )
      videos = joinVideos(metas, details).videos
      touchDataset()
    }
    emit()
  }

  function getSnapshot(): PlayerSnapshot {
    return {
      launch,
      standaloneCsv,
      embedded,
      source,
      page,
      filters: { ...filters },
      rows,
      videos,
      loading,
      message: loading ? loadingText || message : message,
      updatedAt,
      fromCache,
      siteName,
      dataset,
      csv: session.state,
      csvPersistent: persistentCsv,
    }
  }

  function setLoading(next: boolean, text = ''): void {
    loading = next
    loadingText = next ? text : ''
    emit()
  }

  function setSource(next: PlayerSource): void {
    if (destroyed) return
    // 独立 CSV 启动固定本地数据源：内部误调用也不允许切回网站。
    if (standaloneCsv && next === 'site') return
    // 切源让「恢复清单 → 选择文件 → 读取」整条流程失效。
    invalidateCsvFlow()
    if (source === next) {
      emit()
      return
    }
    sourceFlow += 1
    source = next
    const csv = next === 'csv'
    if (csv) {
      requestVersion += 1
      siteController?.abort()
      siteController = null
      pendingUnapproved = false
      loading = false
      appliedCsvSnapshot = -1
    }
    message = ''
    // 网站记录为空时也重建，避免等待请求期间残留 CSV。
    rebuild()
    if (!csv) {
      if (rows.length === 0) void runLoad(false)
      else if (filters.includeUnapproved) void loadUnapproved()
    }
  }

  function setPage(next: PlayerPage): void {
    if (embedded && next === 'score') return
    page = next
    emit()
  }

  function setFilters(patch: Partial<PlayerFilters>): void {
    Object.assign(filters, patch)
    emit()
    if (patch.includeUnapproved === true) void loadUnapproved()
  }

  async function runLoad(force: boolean): Promise<void> {
    if (destroyed || siteUserId === null || source === 'csv' || loading) return
    const localController = new AbortController()
    siteController = localController
    const request = ++requestVersion
    const current = (): boolean =>
      !destroyed && source === 'site' && request === requestVersion
    const messageAtStart = message
    message = ''
    setLoading(true, '正在获取录像列表…')
    try {
      const loaded = await load(siteUserId, {
        force,
        signal: localController.signal,
        onProgress: ({ done, total }) => {
          if (current()) setLoading(true, `正在拉取明细：${done}/${total} 批`)
        },
      })
      if (!current()) return
      rows = loaded.rows
      updatedAt = loaded.fetchedAt
      fromCache = loaded.fromCache
      // 加载期间用户点了别处（比如「我的成绩」）就别覆盖提示。
      if (message === '' || message === messageAtStart) {
        message = loaded.missing.length > 0 ? `${loaded.missing.length} 条录像的解析字段没取到` : ''
      }
      rebuild()
      setLoading(false)
    } catch (error) {
      if (!current()) return
      message = isAbortError(error) ? '已取消' : errorMessage(error)
      setLoading(false)
    } finally {
      if (current()) {
        siteController = null
        if (pendingUnapproved && filters.includeUnapproved) {
          pendingUnapproved = false
          void loadUnapproved()
        }
      }
    }
  }

  async function loadUnapproved(): Promise<void> {
    if (destroyed || siteUserId === null || source === 'csv') return
    if (loading) {
      pendingUnapproved = true
      return
    }
    const ids = rows
      .filter((row) => row.state !== 'c' && !row.ongoing && row.detail === null)
      .map((row) => row.id)
    if (ids.length === 0) {
      pendingUnapproved = false
      return
    }
    const localController = new AbortController()
    siteController = localController
    const request = ++requestVersion
    const current = (): boolean => source === 'site' && request === requestVersion
    const previous = message
    setLoading(true, `正在补抓未过审录像：0/${Math.ceil(ids.length / 100)} 批`)
    try {
      const result = await ensure(siteUserId, rows, ids, {
        signal: localController.signal,
        onProgress: ({ done, total }) => {
          if (current()) setLoading(true, `正在补抓未过审录像：${done}/${total} 批`)
        },
      })
      if (!current()) return
      rows = result.rows
      message = previous
      rebuild()
      setLoading(false)
    } catch (error) {
      if (!current()) return
      message = isAbortError(error) ? '已取消' : errorMessage(error)
      setLoading(false)
    } finally {
      if (current()) {
        siteController = null
        if (pendingUnapproved && filters.includeUnapproved) {
          pendingUnapproved = false
          void loadUnapproved()
        }
      }
    }
  }

  async function loadSiteName(): Promise<void> {
    if (destroyed || siteUserId === null) return
    try {
      const info = await fetchInfo(siteUserId)
      if (!info || destroyed) return
      siteName = info.username || info.realname || `#${siteUserId}`
      emit()
    } catch {
      // 名字拿不到不影响主流程。
    }
  }

  function invalidateCsvFlow(): number {
    csvFlow += 1
    return csvFlow
  }

  async function selectCsvFiles(selection: CsvSelectionContext): Promise<void> {
    if (destroyed || selection.flow !== csvFlow || session.state.loading) return
    const multiple = selection.kind === 'add'
    try {
      const handles = persistentCsv
        ? await pickFiles(multiple)
        : (await options.requestFiles?.(multiple) ?? []).map(fileHandle)
      if (destroyed) return
      await applyCsvSelection(selection, handles)
    } catch (error) {
      if (destroyed || selection.flow !== csvFlow || isAbortError(error)) return
      session.setMessage(`选择文件失败：${errorMessage(error)}`)
    }
  }

  async function applyCsvSelection(
    selection: CsvSelectionContext,
    handles: CsvFileHandle[],
  ): Promise<void> {
    if (destroyed || selection.flow !== csvFlow || handles.length === 0) return
    const result = selection.kind === 'add'
      ? await session.addFiles(handles)
      : await session.relink(selection.sourceId, handles[0]!)
    if (destroyed || selection.flow !== csvFlow) return
    if (selection.kind === 'add' && result === 'success' && source === 'site') {
      setSource('csv')
    }
  }

  async function enterCsvSource(): Promise<void> {
    if (destroyed || source === 'csv') return
    const flow = invalidateCsvFlow()
    if (!session.state.ready) await session.restore()
    if (flow !== csvFlow || source !== 'site' || destroyed) return
    if (session.state.sources.length === 0) {
      await selectCsvFiles({ kind: 'add', flow })
      return
    }
    setSource('csv')
  }

  async function addCsvFiles(): Promise<void> {
    if (destroyed) return
    const flow = invalidateCsvFlow()
    await selectCsvFiles({ kind: 'add', flow })
  }

  async function relinkCsvSource(sourceId: string): Promise<void> {
    if (destroyed) return
    const flow = invalidateCsvFlow()
    await selectCsvFiles({ kind: 'relink', flow, sourceId })
  }

  async function removeCsvSource(sourceId: string): Promise<void> {
    if (destroyed) return
    const flow = sourceFlow
    await session.removeSource(sourceId)
    if (destroyed || flow !== sourceFlow) return
    if (session.state.sources.length === 0 && !standaloneCsv) setSource('site')
    else emit()
  }

  async function removeAllCsv(): Promise<void> {
    if (destroyed) return
    const flow = sourceFlow
    invalidateCsvFlow()
    await session.removeAll()
    if (destroyed || flow !== sourceFlow) return
    if (!standaloneCsv) setSource('site')
    else emit()
  }

  async function refreshCsv(): Promise<void> {
    if (destroyed) return
    await session.refreshAll()
  }

  async function grantCsv(sourceId: string): Promise<void> {
    if (destroyed) return
    await session.grant(sourceId)
  }

  async function checkCsvRegistry(): Promise<void> {
    if (destroyed) return
    if (source === 'csv' && session.state.ready) await session.checkRegistry()
  }

  async function start(): Promise<void> {
    if (destroyed) return
    if (standaloneCsv) await session.restore()
    if (destroyed) return
    emit()
    if (siteUserId !== null) {
      void runLoad(false)
      void loadSiteName()
    }
  }

  function subscribe(listener: (snapshot: PlayerSnapshot) => void): () => void {
    if (destroyed) return () => {}
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  function destroy(): void {
    destroyed = true
    sourceFlow += 1
    requestVersion += 1
    siteController?.abort()
    siteController = null
    invalidateCsvFlow()
    offDbBlocked()
    session.destroy()
    listeners.clear()
  }

  return {
    getSnapshot,
    getCsvSession: () => session,
    subscribe,
    start,
    setSource(next) {
      if (destroyed) return
      session.cancel()
      session.clearMessage()
      setSource(next)
    },
    setPage,
    setFilters,
    refresh: () => runLoad(true),
    cancel: () => siteController?.abort(),
    enterCsvSource,
    addCsvFiles,
    relinkCsvSource,
    removeCsvSource,
    removeAllCsv,
    refreshCsv,
    cancelCsv: () => session.cancel(),
    grantCsv,
    checkCsvRegistry,
    setMessage: (text: string) => {
      message = text
      emit()
    },
    destroy,
  }
}
