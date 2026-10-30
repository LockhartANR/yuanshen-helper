export type WatchMode = 'backfill' | 'new-only'

export type WatchState =
  | 'idle'
  | 'watching'
  | 'paused'
  | 'needs-permission'
  | 'waiting-login'
  | 'stopped'

export interface WatchSettings {
  /** backfill：启动时补传目录里已有的录像；new-only：只传启动之后出现的 */
  mode: WatchMode
  /** 轮询间隔，5–300 秒 */
  intervalSec: number
  /** 是否递归子目录 */
  recursive: boolean
  /** 接受的文件扩展名（小写，含点） */
  exts: string[]
  /** 跳过 *_fail 录像 */
  skipFail: boolean
  state: WatchState
  dirName: string
  /** 下一次启动是否需要先做基线（换目录、清台账、换模式时置真） */
  baselinePending: boolean
  lastError: string
}

export const DEFAULT_WATCH_SETTINGS: WatchSettings = {
  mode: 'new-only',
  intervalSec: 10,
  recursive: false,
  exts: ['.evf'],
  skipFail: true,
  state: 'idle',
  dirName: '',
  baselinePending: false,
  lastError: '',
}

export const INTERVAL_MIN = 5
export const INTERVAL_MAX = 300

export type WatchFileStatus =
  | 'seen'
  | 'queued'
  | 'done'
  | 'skipped'
  | 'ignored'
  | 'failed'

export interface WatchFile {
  relPath: string
  size: number
  mtime: number
  status: WatchFileStatus
  firstSeenAt: number
  attempts: number
  nextAttemptAt: number
  reason: string
}

export interface WatchStatus {
  state: WatchState
  dirName: string
  lastScanAt: number
  pending: number
  uploaded: number
  skipped: number
  failed: number
  /** 最近一轮目录里看到的文件总数（未过滤） */
  totalFiles: number
  /** 最近一轮命中的录像数 */
  matchedFiles: number
  /** 最近一轮看到的子目录数 */
  subdirs: number
  message: string
  updatedAt: number
}

export const DEFAULT_WATCH_STATUS: WatchStatus = {
  state: 'idle',
  dirName: '',
  lastScanAt: 0,
  pending: 0,
  uploaded: 0,
  skipped: 0,
  failed: 0,
  totalFiles: 0,
  matchedFiles: 0,
  subdirs: 0,
  message: '',
  updatedAt: 0,
}

export type WatchLogKind = 'ok' | 'warn' | 'err' | 'dim'

export interface WatchLogEntry {
  at: number
  text: string
  kind: WatchLogKind
}

export interface UploadRawResponse {
  status: number
  body: string
  retryAfter: string
  error?: string
}

export type FatalKind = 'auth' | 'quota' | 'realname' | 'banned' | 'censorship'

export type UploadOutcome =
  | { kind: 'done'; id: number; state: string }
  | { kind: 'duplicate' }
  | { kind: 'skipped'; reason: string }
  | { kind: 'retry'; reason: string; retryAfterMs: number }
  | { kind: 'failed'; reason: string }
  | { kind: 'fatal'; reason: string; fatal: FatalKind }
