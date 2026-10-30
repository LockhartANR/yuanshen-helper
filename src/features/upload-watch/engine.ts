import { errorMessage } from '../../shared/ui'
import { resolveFile, type DirectoryLike } from './scan'
import type { FatalKind, UploadOutcome, WatchFile } from './types'

export const MAX_ATTEMPTS = 5

export function backoffMs(attempts: number): number {
  return Math.min(1000 * 2 ** Math.max(0, attempts - 1), 16000)
}

export interface UploadInput {
  relPath: string
  name: string
  bytes: ArrayBuffer
}

export type UploadFn = (input: UploadInput) => Promise<UploadOutcome>

export interface DrainResult {
  attempted: number
  done: number
  duplicate: number
  skipped: number
  failed: number
  retry: number
  fatal: { kind: FatalKind; reason: string } | null
}

function emptyDrainResult(): DrainResult {
  return {
    attempted: 0,
    done: 0,
    duplicate: 0,
    skipped: 0,
    failed: 0,
    retry: 0,
    fatal: null,
  }
}

function basename(relPath: string): string {
  return relPath.slice(relPath.lastIndexOf('/') + 1)
}

/**
 * 串行消费队列。一次最多处理 `limit` 条，避免一次 tick 长时间占用。
 * 账号级错误（登录失效、额度满、未实名…）会立刻返回 fatal，由调用方停机。
 */
export async function drainQueue(args: {
  dir: DirectoryLike
  files: Map<string, WatchFile>
  upload: UploadFn
  now: number
  limit: number
  onPersist: (file: WatchFile) => Promise<void>
}): Promise<DrainResult> {
  const { dir, files, upload, now, limit, onPersist } = args
  const result = emptyDrainResult()

  const queue = [...files.values()]
    .filter((file) => file.status === 'queued' && file.nextAttemptAt <= now)
    .sort((a, b) => a.firstSeenAt - b.firstSeenAt)
    .slice(0, limit)

  for (const file of queue) {
    if (result.fatal) break
    result.attempted += 1

    let outcome: UploadOutcome
    try {
      const handle = await resolveFile(dir, file.relPath)
      const data = await handle.getFile()
      const bytes = await data.arrayBuffer()
      outcome = await upload({ relPath: file.relPath, name: basename(file.relPath), bytes })
    } catch (error) {
      outcome = { kind: 'retry', reason: errorMessage(error), retryAfterMs: 0 }
    }

    switch (outcome.kind) {
      case 'done':
        file.status = 'done'
        file.reason = ''
        result.done += 1
        break
      case 'duplicate':
        file.status = 'done'
        file.reason = '网站已有'
        result.duplicate += 1
        break
      case 'skipped':
        file.status = 'skipped'
        file.reason = outcome.reason
        result.skipped += 1
        break
      case 'failed':
        file.status = 'failed'
        file.reason = outcome.reason
        result.failed += 1
        break
      case 'retry': {
        file.attempts += 1
        if (file.attempts >= MAX_ATTEMPTS) {
          file.status = 'failed'
          file.reason = outcome.reason
          result.failed += 1
        } else {
          file.nextAttemptAt = now + Math.max(backoffMs(file.attempts), outcome.retryAfterMs)
          result.retry += 1
        }
        break
      }
      case 'fatal':
        result.fatal = { kind: outcome.fatal, reason: outcome.reason }
        break
    }

    await onPersist(file)
  }

  return result
}
