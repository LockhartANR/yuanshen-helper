import { errorMessage } from '../shared/ui'
import { bufferToBase64 } from '../features/upload-watch/bytes'
import { drainQueue, type UploadFn } from '../features/upload-watch/engine'
import { baselineDirectory, scanDirectory, type DirectoryLike } from '../features/upload-watch/scan'
import {
  appendWatchLog,
  getWatchSettings,
  saveWatchSettings,
  saveWatchStatus,
} from '../features/upload-watch/bridge'
import { countStatuses, getWatchHandle, loadLedger, putLedger } from '../features/upload-watch/store'
import type {
  UploadOutcome,
  UploadRawResponse,
  WatchFile,
  WatchSettings,
} from '../features/upload-watch/types'
import { normalizeUploadResult } from '../features/upload-watch/upload'

const UPLOAD_GAP_MS = 300
const UPLOAD_BATCH = 20
const STABILITY_MS = 3000

const STATE_LABEL: Record<string, string> = {
  c: '已通过',
  a: '待审核',
  b: '已冻结',
  d: '标识不符',
  e: '外部审核',
}

let timer: ReturnType<typeof setTimeout> | undefined
let busy = false
let stopped = false
let reloadPending = false
let firstScanLogged = false
let dir: DirectoryLike | null = null
let files = new Map<string, WatchFile>()
let settings: WatchSettings

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function basename(relPath: string): string {
  return relPath.slice(relPath.lastIndexOf('/') + 1)
}

async function permissionOf(handle: FileSystemDirectoryHandle): Promise<PermissionState> {
  const query = handle.queryPermission
  if (!query) return 'granted'
  try {
    return await query.call(handle, { mode: 'read' })
  } catch {
    return 'granted'
  }
}

async function publish(
  message: string,
  scan?: { total: number; matched: number; subdirs: number },
): Promise<void> {
  const counts = countStatuses(files)
  await saveWatchStatus({
    state: settings.state,
    dirName: settings.dirName,
    lastScanAt: Date.now(),
    pending: counts.pending,
    uploaded: counts.uploaded,
    skipped: counts.skipped,
    failed: counts.failed,
    totalFiles: scan?.total ?? 0,
    matchedFiles: scan?.matched ?? 0,
    subdirs: scan?.subdirs ?? 0,
    intervalMs: Math.round(settings.intervalSec * 1000),
    message,
  })
}

async function halt(state: 'needs-permission' | 'stopped', message: string): Promise<void> {
  stopped = true
  clearTimeout(timer)
  settings = await saveWatchSettings({ state, lastError: message })
  await saveWatchStatus({ state, dirName: settings.dirName, message })
  await appendWatchLog(message, state === 'stopped' ? 'err' : 'warn')
  void chrome.runtime.sendMessage({ type: 'WATCH_IDLE' }).catch(() => undefined)
}

async function logOutcome(name: string, outcome: UploadOutcome): Promise<void> {
  switch (outcome.kind) {
    case 'done':
      await appendWatchLog(
        `${name} → 已上传${outcome.state ? `（${STATE_LABEL[outcome.state] ?? outcome.state}）` : ''}`,
        'ok',
      )
      break
    case 'duplicate':
      await appendWatchLog(`${name} → 网站已有`, 'dim')
      break
    case 'skipped':
      await appendWatchLog(`${name} → 已跳过：${outcome.reason}`, 'dim')
      break
    case 'retry':
      await appendWatchLog(`${name} → 重试：${outcome.reason}`, 'warn')
      break
    case 'failed':
      await appendWatchLog(`${name} → 失败：${outcome.reason}`, 'err')
      break
    case 'fatal':
      await appendWatchLog(`${name} → 已停止：${outcome.reason}`, 'err')
      break
  }
}

const upload: UploadFn = async ({ relPath, name, bytes }) => {
  await sleep(UPLOAD_GAP_MS)

  let outcome: UploadOutcome
  try {
    const raw = (await chrome.runtime.sendMessage({
      type: 'WATCH_UPLOAD_REQUEST',
      name,
      data: bufferToBase64(bytes),
    })) as UploadRawResponse | undefined

    if (!raw || typeof raw.status !== 'number' || raw.error) {
      outcome = { kind: 'retry', reason: raw?.error ?? '站点没有响应', retryAfterMs: 0 }
    } else {
      outcome = normalizeUploadResult(raw.status, raw.body, raw.retryAfter)
    }
  } catch (error) {
    outcome = { kind: 'retry', reason: errorMessage(error), retryAfterMs: 0 }
  }

  await logOutcome(basename(relPath), outcome)
  return outcome
}

async function tick(): Promise<void> {
  if (busy || stopped || !dir) return
  busy = true
  try {
    if (reloadPending) {
      files = await loadLedger()
      reloadPending = false
    }

    const current = await getWatchSettings()
    if (current.state !== 'watching') {
      stopped = true
      return
    }
    settings = current

    if (settings.baselinePending) {
      const rows = await baselineDirectory(
        dir,
        {
          recursive: settings.recursive,
          exts: settings.exts,
          skipFail: settings.skipFail,
          now: Date.now(),
        },
        settings.mode,
      )
      for (const row of rows) files.set(row.relPath, row)
      await putLedger(rows)
      settings = await saveWatchSettings({ baselinePending: false })
      await appendWatchLog(
        settings.mode === 'backfill'
          ? `基线：${rows.length} 个已有录像已入队`
          : `基线：${rows.length} 个已有录像不传`,
        'dim',
      )
    }

    const now = Date.now()
    const scan = await scanDirectory(dir, files, {
      recursive: settings.recursive,
      exts: settings.exts,
      skipFail: settings.skipFail,
      stabilityMs: STABILITY_MS,
      maxEntries: 5000,
      now,
    })
    if (!firstScanLogged) {
      firstScanLogged = true
      await appendWatchLog(
        `扫描：目录 ${scan.total} 个文件（子目录 ${scan.subdirs}），命中 ${scan.matched}`,
        scan.matched > 0 ? 'dim' : 'warn',
      )
    } else if (scan.updates.length > 0) {
      await appendWatchLog(`发现 ${scan.updates.length} 个新文件`, 'dim')
    }
    for (const row of scan.updates) files.set(row.relPath, row)
    await putLedger(scan.updates)

    const result = await drainQueue({
      dir,
      files,
      upload,
      now,
      limit: UPLOAD_BATCH,
      onPersist: (file) => putLedger([file]),
    })

    if (result.fatal) {
      await halt('stopped', result.fatal.reason)
      return
    }

    const parts: string[] = []
    if (scan.truncated) parts.push('本轮文件过多，剩余下轮继续')
    if (result.done || result.duplicate) parts.push(`本轮上传 ${result.done + result.duplicate}`)
    if (result.failed) parts.push(`失败 ${result.failed}`)
    if (result.retry) parts.push(`待重试 ${result.retry}`)
    await publish(parts.join(' · '), scan)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotAllowedError') {
      await halt('needs-permission', '目录读取权限失效，请重新授权')
      return
    }
    await appendWatchLog(errorMessage(error), 'err')
    await saveWatchStatus({ message: errorMessage(error) })
  } finally {
    busy = false
  }
}

function schedule(): void {
  clearTimeout(timer)
  const seconds = Math.max(5, Math.min(300, settings.intervalSec))
  timer = setTimeout(() => {
    void tick().then(() => {
      if (!stopped) schedule()
    })
  }, seconds * 1000)
}

async function boot(): Promise<void> {
  settings = await getWatchSettings()
  if (settings.state !== 'watching') return

  const handle = await getWatchHandle()
  if (!handle) {
    await halt('needs-permission', '目录句柄丢失，请重新选择目录')
    return
  }
  if (typeof handle.getFileHandle !== 'function') {
    await halt('stopped', '当前浏览器不支持在后台读取本地目录')
    return
  }
  // offscreen 里 queryPermission 可能拿不到页面那次授权，返回 prompt。
  // 这种情况先不拦，真读不了时 tick 会抛 NotAllowedError，再转 needs-permission。
  if ((await permissionOf(handle)) === 'denied') {
    await halt('needs-permission', '目录访问被拒绝，请重新选择目录')
    return
  }

  dir = handle as unknown as DirectoryLike
  files = await loadLedger()

  await tick()
  if (!stopped) schedule()
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const type = (message as { type?: string } | undefined)?.type

  if (type === 'WATCH_PING') {
    sendResponse({
      ok: true,
      state: settings?.state ?? '',
      hasDir: Boolean(dir),
      stopped,
      at: Date.now(),
    })
    return false
  }
  if (type === 'WATCH_TICK') void tick()
  if (type === 'WATCH_RELOAD') reloadPending = true
  if (type === 'WATCH_STOP') {
    stopped = true
    clearTimeout(timer)
  }
  return false
})

// 先报个到：如果这一行都没到，说明脚本根本没跑起来。
void chrome.runtime.sendMessage({ type: 'WATCH_HELLO', at: Date.now() }).catch(() => undefined)

void boot().catch((error: unknown) => halt('stopped', errorMessage(error)))
