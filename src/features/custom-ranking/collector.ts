import { getDb } from '../../shared/db'
import { ApiError } from '../user-search/api'
import { putUsers } from '../user-search/db'
import { toRecord } from '../user-search/model'
import {
  fetchAbstractBucket,
  fetchDetailBucket,
  fetchPlayerInfos,
  fetchStaticDetails,
  type RankingApiOptions,
} from './api'
import { normalizeDetail, withDetailMetadata } from './fields'
import {
  RANK_SCHEMA_VERSION,
  RANK_STRATEGY_VERSION,
  type GlobalRankDataset,
  type GlobalRankTask,
  type GlobalRankVideoRow,
  type RankScanMode,
} from './model'
import {
  deleteDataset,
  getDataset,
  getDatasetPlayerIds,
  getRankingMeta,
  getTask,
  getTaskChunk,
  getTaskForDataset,
  getVideoRange,
  getVideosByDetailState,
  listDatasetsForBase,
  listTasks,
  publishRankingDataset,
  putDataset,
  putRankingMeta,
  putTask,
  putTaskChunks,
} from './store'

export const RANKING_LOCK_NAME = 'yuanshen-helper:global-ranking'

export class RankingBusyError extends Error {
  constructor(message = '另一个页面正在采集全站排行榜') {
    super(message)
    this.name = 'RankingBusyError'
  }
}

export class RankingAbortError extends Error {
  constructor(message = '采集已暂停') {
    super(message)
    this.name = 'RankingAbortError'
  }
}

export class RankingRangeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RankingRangeError'
  }
}

export interface ScanRange {
  startId: number
  endId: number
  endExclusive: number
}

export interface CollectionProgress {
  task: GlobalRankTask
  dataset: GlobalRankDataset
  estimatedRequests: number | null
}

export interface CollectionRunResult {
  task: GlobalRankTask
  dataset: GlobalRankDataset
  complete: boolean
  message: string
}

export type CollectionMode = 'auto' | 'initial' | 'sync' | 'expand'

export interface CollectionOptions {
  signal?: AbortSignal
  gapMs?: number
  mode?: CollectionMode
  /** 首次建库 / 重新建库的包含两端范围。 */
  startId?: number
  endId?: number
  onProgress?: (progress: CollectionProgress) => void
}

const DETAIL_STEP = 500
const ABSTRACT_STEP = 10_000
const PROFILE_BATCH = 100
const STATIC_BATCH = 100
const PLAYER_CHUNK = 1_000
const ERROR_LIMIT = 100
const WARNING_LIMIT = 100

function uid(prefix: string): string {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10)
  return `${prefix}-${Date.now().toString(36)}-${random}`
}

function chunksOf<T>(items: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size))
  }
  return result
}

function asSafeId(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function aborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true
}

function ensureNotAborted(signal?: AbortSignal): void {
  if (aborted(signal)) throw new RankingAbortError()
}

/** 持久 token 校验：删除、重建或另一页面替换任务后，旧运行不能继续写入。 */
async function ensureTaskActive(task: GlobalRankTask): Promise<void> {
  const stored = await getTask(task.id)
  if (!stored || stored.runToken !== task.runToken) {
    throw new RankingAbortError('任务已失效，旧响应不会再写入')
  }
}

function isRangeValid(range: ScanRange): boolean {
  return (
    Number.isSafeInteger(range.startId) &&
    Number.isSafeInteger(range.endId) &&
    Number.isSafeInteger(range.endExclusive) &&
    range.startId > 0 &&
    range.endId >= range.startId &&
    range.endExclusive === range.endId + 1
  )
}

/** 用户输入是包含两端的 [startId, endId]；内部统一为左闭右开。 */
export function normalizeScanRange(
  rawStart: number | undefined,
  rawEnd: number | undefined,
): ScanRange {
  const startId = rawStart ?? 1
  const endId = rawEnd
  if (!Number.isSafeInteger(startId) || startId <= 0) {
    throw new RankingRangeError('起始 ID 必须是正整数')
  }
  if (endId === undefined || !Number.isSafeInteger(endId) || endId <= 0) {
    throw new RankingRangeError('结束 ID 必须是正整数')
  }
  if (startId > endId) throw new RankingRangeError('起始 ID 不能大于结束 ID')
  const endExclusive = endId + 1
  if (!Number.isSafeInteger(endExclusive)) {
    throw new RankingRangeError('结束 ID 太大，超出安全整数范围')
  }
  return { startId, endId, endExclusive }
}

function savedRange(meta: { startId: number; endId: number }): ScanRange | null {
  try {
    return normalizeScanRange(meta.startId, meta.endId)
  } catch {
    return null
  }
}

function stepForMode(mode: RankScanMode): number {
  return mode === 'initial' ? DETAIL_STEP : ABSTRACT_STEP
}

function intervalTotal(range: ScanRange, mode: RankScanMode): number {
  return Math.ceil((range.endExclusive - range.startId) / stepForMode(mode))
}

function estimatedRequests(task: GlobalRankTask): number | null {
  if (task.intervalTotal === 0) return null
  return (
    task.intervalTotal +
    Math.ceil(task.missingDetailCount / STATIC_BATCH) +
    Math.ceil(task.playerCount / PROFILE_BATCH)
  )
}

function pushWarning(task: GlobalRankTask, text: string): void {
  if (task.warnings.length < WARNING_LIMIT) task.warnings.push(text)
}

function pushError(task: GlobalRankTask, phase: string, scope: string, message: string): void {
  if (task.errors.length >= ERROR_LIMIT) return
  task.errors.push({ at: Date.now(), phase, scope, message })
}

function syncTaskToDataset(task: GlobalRankTask, dataset: GlobalRankDataset): void {
  dataset.videoCount = task.targetCount
  dataset.detailCount = task.detailCount
  dataset.missingDetailCount = task.missingDetailCount
  dataset.intervalDone = task.intervalDone
  dataset.intervalTotal = task.intervalTotal
  dataset.responseAnomalies = task.responseAnomalies
  dataset.detailReusedCount = task.detailReusedCount
  dataset.playerCount = task.playerCount
}

function touch(task: GlobalRankTask, dataset: GlobalRankDataset): void {
  const now = Date.now()
  task.updatedAt = now
  dataset.updatedAt = now
  syncTaskToDataset(task, dataset)
}

async function persist(task: GlobalRankTask, dataset: GlobalRankDataset): Promise<void> {
  const db = await getDb()
  const tx = db.transaction(
    ['globalRankTasks', 'globalRankDatasets'],
    'readwrite',
  )
  const stored = await tx.objectStore('globalRankTasks').get(task.id)
  if (!stored || stored.runToken !== task.runToken) {
    throw new RankingAbortError('任务已失效，旧运行不会恢复数据')
  }
  touch(task, dataset)
  await tx.objectStore('globalRankTasks').put(task)
  await tx.objectStore('globalRankDatasets').put(dataset)
  await tx.done
}

function emit(options: CollectionOptions, task: GlobalRankTask, dataset: GlobalRankDataset): void {
  options.onProgress?.({
    task,
    dataset,
    estimatedRequests: estimatedRequests(task),
  })
}

async function makeTask(
  baseUrl: string,
  range: ScanRange,
  mode: RankScanMode,
  baseDatasetId: string | null,
  generation: number,
): Promise<{ task: GlobalRankTask; dataset: GlobalRankDataset }> {
  const now = Date.now()
  const id = uid('ranking')
  const dataset: GlobalRankDataset = {
    id,
    baseUrl,
    schemaVersion: RANK_SCHEMA_VERSION,
    strategyVersion: RANK_STRATEGY_VERSION,
    scanMode: mode,
    startId: range.startId,
    endId: range.endId,
    endExclusive: range.endExclusive,
    generation,
    status: 'collecting',
    stage: mode === 'initial' ? 'detailbulk 建库' : 'abstractbulk 同步',
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    baseDatasetId,
    playerCount: 0,
    videoCount: 0,
    detailCount: 0,
    missingDetailCount: 0,
    errorCount: 0,
    intervalDone: 0,
    intervalTotal: intervalTotal(range, mode),
    detailReusedCount: 0,
    responseAnomalies: 0,
    complete: false,
    warnings: [],
  }
  const task: GlobalRankTask = {
    id,
    datasetId: id,
    baseUrl,
    schemaVersion: RANK_SCHEMA_VERSION,
    strategyVersion: RANK_STRATEGY_VERSION,
    scanMode: mode,
    startId: range.startId,
    endId: range.endId,
    endExclusive: range.endExclusive,
    baseDatasetId,
    generation,
    status: 'running',
    phase: mode === 'initial' ? 'initial' : 'sync',
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    runToken: uid('run'),
    intervalCursor: range.startId,
    intervalDone: 0,
    intervalTotal: intervalTotal(range, mode),
    responseAnomalies: 0,
    detailReusedCount: 0,
    playerCount: 0,
    playerChunkCount: 0,
    profileChunksDone: 0,
    targetCount: 0,
    detailCount: 0,
    missingDetailCount: 0,
    errors: [],
    warnings: [],
  }
  return { task, dataset }
}

export async function findResumableTask(baseUrl: string): Promise<GlobalRankTask | null> {
  const tasks = await listTasks()
  const candidates = tasks
    .filter(
      (task) =>
        task.baseUrl === baseUrl &&
        task.strategyVersion === RANK_STRATEGY_VERSION &&
        (task.status === 'running' || task.status === 'paused'),
    )
    .sort((left, right) => right.updatedAt - left.updatedAt)
  return candidates[0] ?? null
}

interface PreparedTask {
  task: GlobalRankTask
  dataset: GlobalRankDataset
}

async function prepareTask(
  baseUrl: string,
  options: CollectionOptions,
): Promise<PreparedTask> {
  const meta = await getRankingMeta(baseUrl)
  const baseCandidate = meta.readyDatasetId ? await getDataset(meta.readyDatasetId) : undefined
  const base =
    baseCandidate?.strategyVersion === RANK_STRATEGY_VERSION && baseCandidate.complete
      ? baseCandidate
      : null
  const saved = savedRange(meta)

  if (options.mode !== 'initial' && options.mode !== 'sync' && options.mode !== 'expand') {
    const resumable = await findResumableTask(baseUrl)
    const latestMatches =
      resumable !== null &&
      (meta.latestDatasetId === null || meta.latestDatasetId === resumable.datasetId)
    if (resumable && latestMatches) {
      const dataset = await getDataset(resumable.datasetId)
      if (dataset) {
        resumable.status = 'running'
        resumable.runToken = uid('run')
        resumable.updatedAt = Date.now()
        await putTask(resumable)
        return { task: resumable, dataset }
      }
    }
  }

  let mode: RankScanMode
  let range: ScanRange
  let baseDatasetId: string | null = null

  if (options.mode === 'sync') {
    if (!base) throw new RankingRangeError('没有可复用的新版区间快照，请先完成一次建库')
    if (!saved) throw new RankingRangeError('还没有保存扫描范围，请先填写结束 ID 并开始加载')
    mode = 'sync'
    range = saved
    baseDatasetId = base.id
  } else if (options.mode === 'expand') {
    if (!base) throw new RankingRangeError('没有可复用的新版区间快照，请先完成一次建库')
    if (!saved) throw new RankingRangeError('还没有保存扫描范围')
    if (options.endId === undefined) throw new RankingRangeError('请输入新的结束 ID')
    const expanded = normalizeScanRange(saved.startId, options.endId)
    if (expanded.endId <= saved.endId) {
      throw new RankingRangeError('扩大范围的新结束 ID 必须大于已保存的结束 ID')
    }
    mode = 'expand'
    range = expanded
    baseDatasetId = base.id
  } else if (options.mode === 'initial') {
    mode = 'initial'
    range = normalizeScanRange(options.startId ?? 1, options.endId)
  } else {
    // auto：有新版成功快照和保存范围时同步，否则使用已保存范围或表单范围建库。
    if (base && saved) {
      mode = 'sync'
      range = saved
      baseDatasetId = base.id
    } else {
      mode = 'initial'
      range = saved ?? normalizeScanRange(options.startId ?? 1, options.endId)
    }
  }

  if (!isRangeValid(range)) throw new RankingRangeError('扫描范围不合法')
  const datasets = await listDatasetsForBase(baseUrl)
  const generation = Math.max(0, ...datasets.map((item) => item.generation)) + 1
  const { task, dataset } = await makeTask(
    baseUrl,
    range,
    mode,
    baseDatasetId,
    generation,
  )
  await putDataset(dataset)
  await putTask(task)
  await putRankingMeta({
    ...meta,
    key: baseUrl,
    startId: range.startId,
    endId: range.endId,
    strategyVersion: RANK_STRATEGY_VERSION,
    latestDatasetId: dataset.id,
    updatedAt: Date.now(),
    revision: meta.revision + 1,
  })
  return { task, dataset }
}

interface ParsedRows {
  rows: GlobalRankVideoRow[]
  anomalies: number
}

function parseInitialRows(
  datasetId: string,
  rawRows: Record<string, unknown>[],
  first: number,
  count: number,
): ParsedRows {
  const rows = new Map<number, GlobalRankVideoRow>()
  let anomalies = 0
  const last = first + count - 1
  for (const raw of rawRows) {
    const id = asSafeId(raw.id)
    const playerId = asSafeId(raw.player)
    if (id === null || id < first || id > last) {
      anomalies += 1
      continue
    }
    if (playerId === null) {
      anomalies += 1
      continue
    }
    if (rows.has(id)) {
      anomalies += 1
      continue
    }
    const detail = normalizeDetail(raw)
    rows.set(id, {
      datasetId,
      videoId: id,
      playerId,
      state: typeof raw.state === 'string' ? raw.state : '',
      uploadTime: typeof raw.upload_time === 'string' ? raw.upload_time : '',
      detail,
      detailState: 'complete',
      discoveredAt: Date.now(),
      updatedAt: Date.now(),
    })
  }
  return { rows: [...rows.values()].sort((a, b) => a.videoId - b.videoId), anomalies }
}

/** 录像与区间断点同事务提交；首次建库和同步共用 token 校验及计数。 */
async function writeInterval(
  task: GlobalRankTask,
  dataset: GlobalRankDataset,
  first: number,
  count: number,
  parsed: ParsedRows,
  reused = 0,
): Promise<void> {
  const db = await getDb()
  const tx = db.transaction(
    ['globalRankVideos', 'globalRankTasks', 'globalRankDatasets'],
    'readwrite',
  )
  const stored = await tx.objectStore('globalRankTasks').get(task.id)
  if (!stored || stored.runToken !== task.runToken) {
    throw new RankingAbortError('任务已失效，旧运行不会写入区间')
  }
  for (const row of parsed.rows) {
    void tx.objectStore('globalRankVideos').put(row)
    if (row.detailState === 'complete') task.detailCount += 1
    else task.missingDetailCount += 1
  }
  task.intervalCursor = first + count
  task.intervalDone += 1
  task.responseAnomalies += parsed.anomalies
  task.detailReusedCount += reused
  task.targetCount += parsed.rows.length
  syncTaskToDataset(task, dataset)
  await tx.objectStore('globalRankTasks').put(task)
  await tx.objectStore('globalRankDatasets').put(dataset)
  await tx.done
}

async function runInitial(
  task: GlobalRankTask,
  dataset: GlobalRankDataset,
  options: CollectionOptions,
): Promise<void> {
  task.phase = 'initial'
  dataset.stage = 'detailbulk 区间建库'
  await persist(task, dataset)
  emit(options, task, dataset)
  const apiOptions: RankingApiOptions = {
    baseUrl: task.baseUrl,
    signal: options.signal,
    gapMs: options.gapMs,
  }
  while (task.intervalCursor < task.endExclusive) {
    ensureNotAborted(options.signal)
    await ensureTaskActive(task)
    const first = task.intervalCursor
    const count = Math.min(DETAIL_STEP, task.endExclusive - first)
    const rawRows = await fetchDetailBucket(first, count, apiOptions)
    await ensureTaskActive(task)
    const parsed = parseInitialRows(dataset.id, rawRows, first, count)
    await writeInterval(task, dataset, first, count, parsed)
    emit(options, task, dataset)
  }
  task.phase = 'profiles'
  dataset.stage = '玩家名称补全'
  await persist(task, dataset)
  emit(options, task, dataset)
}

interface ParsedMetadata extends ParsedRows {
  reused: number
}

function parseAbstractRows(
  dataset: GlobalRankDataset,
  rawRows: Record<string, unknown>[],
  first: number,
  count: number,
  baseRows: Map<number, GlobalRankVideoRow>,
  reuseStableFields: boolean,
): ParsedMetadata {
  const rows = new Map<number, GlobalRankVideoRow>()
  let reused = 0
  let anomalies = 0
  const last = first + count - 1
  for (const raw of rawRows) {
    const id = asSafeId(raw.id)
    const playerId = asSafeId(raw.player)
    if (id === null || id < first || id > last) {
      anomalies += 1
      continue
    }
    if (playerId === null) {
      anomalies += 1
      continue
    }
    if (rows.has(id)) {
      anomalies += 1
      continue
    }
    const state = typeof raw.state === 'string' ? raw.state : ''
    const uploadTime = typeof raw.upload_time === 'string' ? raw.upload_time : ''
    const previous = baseRows.get(id)
    let detail = null
    let detailState: GlobalRankVideoRow['detailState'] = 'pending'
    if (reuseStableFields && previous?.detailState === 'complete' && previous.detail) {
      // 玩家 / 审核 / 上传时间采用 abstractbulk 的最新元信息，不沿用旧值。
      detail = withDetailMetadata(previous.detail, { player: playerId, state, uploadTime })
      detailState = 'complete'
      reused += 1
    }
    rows.set(id, {
      datasetId: dataset.id,
      videoId: id,
      playerId,
      state,
      uploadTime,
      detail,
      detailState,
      discoveredAt: Date.now(),
      updatedAt: Date.now(),
    })
  }
  return { rows: [...rows.values()].sort((a, b) => a.videoId - b.videoId), reused, anomalies }
}

async function runSync(
  task: GlobalRankTask,
  dataset: GlobalRankDataset,
  options: CollectionOptions,
): Promise<void> {
  task.phase = 'sync'
  dataset.stage = 'abstractbulk 区间同步'
  await persist(task, dataset)
  emit(options, task, dataset)
  const apiOptions: RankingApiOptions = {
    baseUrl: task.baseUrl,
    signal: options.signal,
    gapMs: options.gapMs,
  }
  const baseDataset =
    task.baseDatasetId === null ? null : (await getDataset(task.baseDatasetId)) ?? null
  const reuseStableFields =
    baseDataset !== null && baseDataset.schemaVersion === task.schemaVersion
  while (task.intervalCursor < task.endExclusive) {
    ensureNotAborted(options.signal)
    await ensureTaskActive(task)
    const first = task.intervalCursor
    const count = Math.min(ABSTRACT_STEP, task.endExclusive - first)
    const rawRows = await fetchAbstractBucket(first, count, apiOptions)
    await ensureTaskActive(task)
    const baseRows =
      task.baseDatasetId === null
        ? new Map<number, GlobalRankVideoRow>()
        : new Map(
            (await getVideoRange(task.baseDatasetId, first, count)).map((row) => [
              row.videoId,
              row,
            ]),
          )
    const parsed = parseAbstractRows(
      dataset,
      rawRows,
      first,
      count,
      baseRows,
      reuseStableFields,
    )
    await writeInterval(task, dataset, first, count, parsed, parsed.reused)
    emit(options, task, dataset)
  }
  task.phase = 'supplement'
  dataset.stage = 'staticdetailbatch 补齐'
  await persist(task, dataset)
  emit(options, task, dataset)
}

async function runSupplement(
  task: GlobalRankTask,
  dataset: GlobalRankDataset,
  options: CollectionOptions,
): Promise<void> {
  task.phase = 'supplement'
  dataset.stage = 'staticdetailbatch 补齐'
  await persist(task, dataset)
  emit(options, task, dataset)

  const pending = await getVideosByDetailState(dataset.id, 'pending')
  const missing = await getVideosByDetailState(dataset.id, 'missing')
  const rows = [...new Map([...pending, ...missing].map((row) => [row.videoId, row])).values()]
    .sort((left, right) => left.videoId - right.videoId)

  for (const batch of chunksOf(rows, STATIC_BATCH)) {
    ensureNotAborted(options.signal)
    await ensureTaskActive(task)
    const ids = batch.map((row) => row.videoId)
    const rawRows = await fetchStaticDetails(ids, {
      baseUrl: task.baseUrl,
      signal: options.signal,
      gapMs: options.gapMs,
    })
    await ensureTaskActive(task)
    const byId = new Map<number, Record<string, unknown>>()
    for (const raw of rawRows) {
      const id = asSafeId(raw.id)
      if (id !== null) byId.set(id, raw)
    }
    let completed = 0
    let resolvedMissing = 0
    let markedMissing = 0
    for (const row of batch) {
      const raw = byId.get(row.videoId)
      if (!raw) {
        // pending 已经在同步阶段计入缺失数，转为 missing 不新增计数。
        if (row.detailState !== 'missing') {
          row.detailState = 'missing'
          markedMissing += 1
        }
        continue
      }
      const detail = normalizeDetail(raw)
      row.detail = withDetailMetadata(detail, {
        player: row.playerId,
        state: row.state,
        uploadTime: row.uploadTime,
      })
      if (row.detailState !== 'complete') resolvedMissing += 1
      row.detailState = 'complete'
      row.updatedAt = Date.now()
      completed += 1
    }
    if (completed > 0 || resolvedMissing > 0 || markedMissing > 0) {
      task.detailCount += completed
      task.missingDetailCount = Math.max(0, task.missingDetailCount - resolvedMissing)
      syncTaskToDataset(task, dataset)
      const db = await getDb()
      const tx = db.transaction(
        ['globalRankVideos', 'globalRankTasks', 'globalRankDatasets'],
        'readwrite',
      )
      const stored = await tx.objectStore('globalRankTasks').get(task.id)
      if (!stored || stored.runToken !== task.runToken) {
        throw new RankingAbortError('任务已失效，旧运行不会写入补齐结果')
      }
      for (const row of batch) {
        if (row.detailState === 'complete' || row.detailState === 'missing') {
          void tx.objectStore('globalRankVideos').put(row)
        }
      }
      await tx.objectStore('globalRankTasks').put(task)
      await tx.objectStore('globalRankDatasets').put(dataset)
      await tx.done
      emit(options, task, dataset)
    }
  }

  if (task.missingDetailCount > 0) {
    pushWarning(task, `仍有 ${task.missingDetailCount} 条公开元信息缺少解析详情`)
  }
  task.phase = 'profiles'
  dataset.stage = '玩家名称补全'
  await persist(task, dataset)
  emit(options, task, dataset)
}

async function runProfiles(
  task: GlobalRankTask,
  dataset: GlobalRankDataset,
  options: CollectionOptions,
): Promise<void> {
  task.phase = 'profiles'
  dataset.stage = '玩家名称补全'
  await persist(task, dataset)
  emit(options, task, dataset)

  if (task.playerChunkCount === 0) {
    const ids = await getDatasetPlayerIds(dataset.id)
    const playerChunks = chunksOf(ids, PLAYER_CHUNK)
    await putTaskChunks(task.id, 'players', playerChunks)
    task.playerCount = ids.length
    task.playerChunkCount = playerChunks.length
    dataset.playerCount = ids.length
    await persist(task, dataset)
    emit(options, task, dataset)
  }

  const apiOptions: RankingApiOptions = {
    baseUrl: task.baseUrl,
    signal: options.signal,
    gapMs: options.gapMs,
  }
  for (let chunkIndex = task.profileChunksDone; chunkIndex < task.playerChunkCount; chunkIndex += 1) {
    const chunk = await getTaskChunk(task.id, 'players', chunkIndex)
    if (!chunk) throw new Error(`缺少玩家分块 ${chunkIndex}`)
    const ids = chunk.items
    for (const batch of chunksOf(ids, PROFILE_BATCH)) {
      ensureNotAborted(options.signal)
      await ensureTaskActive(task)
      try {
        const rows = await fetchPlayerInfos(batch, apiOptions)
        const records = rows
          .map((row) => toRecord(row))
          .filter((record): record is NonNullable<typeof record> => record !== null)
        await putUsers(records)
      } catch (error) {
        if (error instanceof ApiError && error.kind === 'aborted') throw new RankingAbortError()
        pushWarning(task, `玩家资料批次读取失败：${error instanceof Error ? error.message : String(error)}`)
      }
      emit(options, task, dataset)
    }
    task.profileChunksDone = chunkIndex + 1
    await persist(task, dataset)
  }
  task.phase = 'publish'
  dataset.stage = '发布'
  await persist(task, dataset)
  emit(options, task, dataset)
}

async function publish(
  task: GlobalRankTask,
  dataset: GlobalRankDataset,
): Promise<CollectionRunResult> {
  await ensureTaskActive(task)
  const covered = task.intervalDone === task.intervalTotal
  const complete =
    covered &&
    task.responseAnomalies === 0 &&
    task.missingDetailCount === 0
  const now = Date.now()
  dataset.status = complete ? 'ready' : 'partial'
  dataset.complete = complete
  dataset.finishedAt = now
  dataset.stage = complete ? '已完成' : '部分完成'
  dataset.errorCount = task.errors.length + task.responseAnomalies
  task.status = 'completed'
  task.phase = 'publish'
  task.finishedAt = now
  touch(task, dataset)
  await publishRankingDataset(dataset, task, complete)
  await pruneOldDatasets(
    dataset.baseUrl,
    new Set([dataset.id, dataset.baseDatasetId].filter((id): id is string => id !== null)),
  ).catch(() => {})
  const range = `ID ${task.startId}–${task.endId}`
  return {
    task,
    dataset,
    complete,
    message: complete
      ? `${range} 区间扫描完成`
      : `${range} 区间仅完成部分数据，可计算当前部分数据，但不代表完整区间`,
  }
}

/** 成功指针切换后清理更老的 generation；保护仍有运行 / 暂停任务的数据集。 */
async function pruneOldDatasets(baseUrl: string, keep: Set<string>): Promise<void> {
  const [datasets, tasks, meta] = await Promise.all([
    listDatasetsForBase(baseUrl),
    listTasks(),
    getRankingMeta(baseUrl),
  ])
  // 当前成功指针始终受保护：部分发布不得删除上一份可计算的成功快照。
  if (meta.readyDatasetId) keep.add(meta.readyDatasetId)
  const protectedByTask = new Set(
    tasks
      .filter((task) => task.status === 'running' || task.status === 'paused')
      .map((task) => task.datasetId),
  )
  for (const item of datasets) {
    if (keep.has(item.id) || protectedByTask.has(item.id) || item.status === 'collecting') continue
    await deleteDataset(item.id)
  }
}

async function execute(
  baseUrl: string,
  options: CollectionOptions,
): Promise<CollectionRunResult> {
  ensureNotAborted(options.signal)
  const prepared = await prepareTask(baseUrl, options)
  const { task, dataset } = prepared
  dataset.status = 'collecting'
  dataset.finishedAt = null
  dataset.complete = false
  task.status = 'running'
  task.finishedAt = null
  await persist(task, dataset)
  emit(options, task, dataset)

  try {
    if (task.phase === 'initial') {
      await runInitial(task, dataset, options)
    }
    if (task.phase === 'sync') {
      await runSync(task, dataset, options)
    }
    if (task.phase === 'supplement') {
      await runSupplement(task, dataset, options)
    }
    if (task.phase === 'profiles') {
      await runProfiles(task, dataset, options)
    }
    if (task.phase !== 'publish') {
      throw new Error(`未知采集阶段：${task.phase}`)
    }
    return await publish(task, dataset)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const wasAbort =
      error instanceof RankingAbortError ||
      (error instanceof ApiError && error.kind === 'aborted') ||
      aborted(options.signal)
    if (!wasAbort) {
      pushError(task, task.phase, '采集任务', message)
    }
    task.status = 'paused'
    dataset.status = 'partial'
    dataset.stage = wasAbort ? '已暂停' : '已暂停（可继续）'
    dataset.errorCount = task.errors.length + task.responseAnomalies
    const stored = await getTask(task.id).catch(() => undefined)
    if (!stored || stored.runToken !== task.runToken) {
      throw new RankingAbortError('任务已失效，旧运行不会恢复数据')
    }
    await persist(task, dataset).catch(() => {})
    if (wasAbort) throw new RankingAbortError()
    throw error
  }
}

export async function startCollection(
  baseUrl: string,
  options: CollectionOptions = {},
): Promise<CollectionRunResult> {
  const run = () => execute(baseUrl, options)
  const nav = typeof navigator === 'undefined' ? null : navigator
  if (nav && 'locks' in nav) {
    return nav.locks.request(`${RANKING_LOCK_NAME}:${baseUrl}`, { ifAvailable: true }, async (lock) => {
      if (!lock) throw new RankingBusyError()
      return run()
    })
  }
  return run()
}

export async function getRankingOverview(baseUrl: string): Promise<{
  meta: Awaited<ReturnType<typeof getRankingMeta>>
  latest: GlobalRankDataset | null
  ready: GlobalRankDataset | null
  task: GlobalRankTask | null
}> {
  const meta = await getRankingMeta(baseUrl)
  const ready = meta.readyDatasetId ? (await getDataset(meta.readyDatasetId)) ?? null : null
  let latest = meta.latestDatasetId ? (await getDataset(meta.latestDatasetId)) ?? null : null
  if (!latest && ready) latest = ready
  const task = latest ? (await getTaskForDataset(latest.id)) ?? null : null
  return { meta, latest, ready, task }
}

