import { addLog } from '../../shared/log'
import { PAGE_SIZE, SYNC_LOCK_NAME } from '../../shared/constants'
import { isAbortError } from '../../shared/ui'
import {
  ApiError,
  chunkIds,
  getRequestCount,
  infobulk,
  infoupdated,
  resetRequestCount,
} from './api'
import {
  countUsers,
  getSyncMeta,
  pruneUsers,
  putUsers,
  setSyncMeta,
} from './db'
import { toRecord, type RawUser, type UserRecord } from './model'

export type SyncMode = 'full' | 'incremental'

export interface SyncProgress {
  phase: 'listing' | 'fetching'
  batch: number
  totalBatches: number
  processed: number
  total: number
}

export interface SyncOptions {
  signal?: AbortSignal
  resume?: boolean
  onProgress?: (progress: SyncProgress) => void
}

export interface SyncResult {
  mode: SyncMode
  updated: number
  userCount: number
  requests: number
  durationMs: number
}

export class SyncBusyError extends Error {
  constructor(message = '正在同步中，请稍后再试') {
    super(message)
    this.name = 'SyncBusyError'
  }
}

export class SyncAbortError extends Error {
  constructor(message = '已取消') {
    super(message)
    this.name = 'SyncAbortError'
  }
}

const WATERMARK_OVERLAP_MS = 5 * 60_000

function nextWatermark(startedAt: number): number {
  return Math.max(0, startedAt - WATERMARK_OVERLAP_MS)
}

function report(
  options: SyncOptions,
  progress: SyncProgress,
): void {
  options.onProgress?.(progress)
}

export async function runSync(
  mode: SyncMode,
  options: SyncOptions = {},
): Promise<SyncResult> {
  if (typeof navigator !== 'undefined' && 'locks' in navigator) {
    const result = await navigator.locks.request(
      SYNC_LOCK_NAME,
      { ifAvailable: true },
      async (lock) => {
        if (!lock) return null
        return executeSync(mode, options)
      },
    )
    if (result) return result
    throw new SyncBusyError()
  }

  return executeSync(mode, options)
}

async function executeSync(
  requestedMode: SyncMode,
  options: SyncOptions,
): Promise<SyncResult> {
  const startedAt = Date.now()
  resetRequestCount()

  let mode = requestedMode
  try {
    if (mode === 'incremental') {
      const meta = await getSyncMeta()
      if (!meta.watermark || meta.userCount === 0) {
        mode = 'full'
      }
    }

    return mode === 'full'
      ? await fullSync(startedAt, options)
      : await incrementalSync(startedAt, options)
  } catch (error) {
    await setSyncMeta({ phase: 'paused' }).catch(() => {})

    if (
      isAbortError(error) ||
      (error instanceof ApiError && error.kind === 'aborted') ||
      error instanceof SyncAbortError
    ) {
      await addLog('info', '同步已取消，可重新开始续跑').catch(() => {})
      throw new SyncAbortError()
    }

    const message = error instanceof Error ? error.message : String(error)
    await addLog('error', `同步失败：${message}`).catch(() => {})
    throw error
  }
}

async function fullSync(startedAt: number, options: SyncOptions): Promise<SyncResult> {
  const meta = await getSyncMeta()
  let startBatch = 0
  if (options.resume && meta.phase !== 'idle' && meta.cursor > 0) {
    startBatch = meta.cursor
  }

  await setSyncMeta({ phase: 'listing', cursor: 0 })
  report(options, {
    phase: 'listing',
    batch: 0,
    totalBatches: 0,
    processed: 0,
    total: 0,
  })

  const ids = await infoupdated(0, { signal: options.signal })
  if (ids.length === 0) {
    throw new ApiError('format', '站点返回 0 个用户，已中止以免清空本地数据')
  }

  const chunks = chunkIds(ids, PAGE_SIZE)
  if (startBatch >= chunks.length) startBatch = 0

  await setSyncMeta({ phase: 'fetching', cursor: startBatch })
  let processed = Math.min(ids.length, startBatch * PAGE_SIZE)
  let updated = 0

  for (let index = startBatch; index < chunks.length; index += 1) {
    if (options.signal?.aborted) throw new SyncAbortError()
    await setSyncMeta({ phase: 'fetching', cursor: index })

    const raw = await infobulk(chunks[index], { signal: options.signal })
    const records: UserRecord[] = []
    for (const item of raw) {
      const record = toRecord(item as RawUser)
      if (record) records.push(record)
    }
    await putUsers(records)

    updated += records.length
    processed = Math.min(ids.length, processed + chunks[index].length)
    report(options, {
      phase: 'fetching',
      batch: index + 1,
      totalBatches: chunks.length,
      processed,
      total: ids.length,
    })
  }

  const pruned = await pruneUsers(new Set(ids))
  const userCount = await countUsers()
  await setSyncMeta({
    phase: 'idle',
    cursor: 0,
    watermark: nextWatermark(startedAt),
    userCount,
    lastSyncAt: Date.now(),
  })

  const requests = getRequestCount()
  const pruneText = pruned > 0 ? `，清理 ${pruned} 个已删用户` : ''
  await addLog(
    'info',
    `全量同步完成：${userCount} 人，${requests} 个请求${pruneText}`,
  ).catch(() => {})

  return {
    mode: 'full',
    updated,
    userCount,
    requests,
    durationMs: Date.now() - startedAt,
  }
}

async function incrementalSync(
  startedAt: number,
  options: SyncOptions,
): Promise<SyncResult> {
  const meta = await getSyncMeta()
  if (!meta.watermark) return fullSync(startedAt, options)

  await setSyncMeta({ phase: 'listing', cursor: 0 })
  report(options, {
    phase: 'listing',
    batch: 0,
    totalBatches: 0,
    processed: 0,
    total: 0,
  })

  const changedIds = await infoupdated(meta.watermark, { signal: options.signal })
  const chunks = chunkIds(changedIds, PAGE_SIZE)

  if (changedIds.length === 0) {
    const userCount = await countUsers()
    await setSyncMeta({
      phase: 'idle',
      cursor: 0,
      watermark: nextWatermark(startedAt),
      userCount,
      lastSyncAt: Date.now(),
    })
    await addLog('info', `增量同步：无变更，${getRequestCount()} 个请求`).catch(() => {})
    return {
      mode: 'incremental',
      updated: 0,
      userCount,
      requests: getRequestCount(),
      durationMs: Date.now() - startedAt,
    }
  }

  await setSyncMeta({ phase: 'fetching', cursor: 0 })
  let processed = 0
  let updated = 0

  for (let index = 0; index < chunks.length; index += 1) {
    if (options.signal?.aborted) throw new SyncAbortError()
    await setSyncMeta({ phase: 'fetching', cursor: index })

    const raw = await infobulk(chunks[index], { signal: options.signal })
    const records: UserRecord[] = []
    for (const item of raw) {
      const record = toRecord(item as RawUser)
      if (record) records.push(record)
    }
    await putUsers(records)

    updated += records.length
    processed = Math.min(changedIds.length, processed + chunks[index].length)
    report(options, {
      phase: 'fetching',
      batch: index + 1,
      totalBatches: chunks.length,
      processed,
      total: changedIds.length,
    })
  }

  const userCount = await countUsers()
  await setSyncMeta({
    phase: 'idle',
    cursor: 0,
    watermark: nextWatermark(startedAt),
    userCount,
    lastSyncAt: Date.now(),
  })

  await addLog(
    'info',
    `增量同步完成：更新 ${updated} 人，${getRequestCount()} 个请求`,
  ).catch(() => {})

  return {
    mode: 'incremental',
    updated,
    userCount,
    requests: getRequestCount(),
    durationMs: Date.now() - startedAt,
  }
}
