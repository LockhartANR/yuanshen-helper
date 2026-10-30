import { getDb } from '../../shared/db'
import type { WatchFile } from './types'

const HANDLE_ID = 'current'

export async function getWatchHandle(): Promise<FileSystemDirectoryHandle | null> {
  const db = await getDb()
  const record = await db.get('watchHandle', HANDLE_ID)
  return record?.handle ?? null
}

export async function setWatchHandle(
  handle: FileSystemDirectoryHandle,
  name: string,
): Promise<void> {
  const db = await getDb()
  await db.put('watchHandle', {
    id: HANDLE_ID,
    name,
    handle,
    savedAt: Date.now(),
  })
}

export async function loadLedger(): Promise<Map<string, WatchFile>> {
  const db = await getDb()
  const rows = await db.getAll('watchFiles')
  return new Map(rows.map((row) => [row.relPath, row]))
}

export async function putLedger(rows: WatchFile[]): Promise<void> {
  if (rows.length === 0) return
  const db = await getDb()
  const tx = db.transaction('watchFiles', 'readwrite')
  for (const row of rows) void tx.store.put(row)
  await tx.done
}

export async function resetLedger(): Promise<void> {
  const db = await getDb()
  await db.clear('watchFiles')
}

/** 把 failed 重新放回队列，attempts 归零。 */
export async function requeueFailed(): Promise<number> {
  const db = await getDb()
  const tx = db.transaction('watchFiles', 'readwrite')
  let count = 0
  for await (const cursor of tx.store) {
    if (cursor.value.status !== 'failed') continue
    count += 1
    void cursor.update({
      ...cursor.value,
      status: 'queued',
      attempts: 0,
      nextAttemptAt: 0,
      reason: '',
    })
  }
  await tx.done
  return count
}

export function countStatuses(files: Map<string, WatchFile>): {
  pending: number
  uploaded: number
  skipped: number
  failed: number
} {
  let pending = 0
  let uploaded = 0
  let skipped = 0
  let failed = 0
  for (const file of files.values()) {
    if (file.status === 'queued' || file.status === 'seen') pending += 1
    else if (file.status === 'done') uploaded += 1
    else if (file.status === 'skipped') skipped += 1
    else if (file.status === 'failed') failed += 1
  }
  return { pending, uploaded, skipped, failed }
}
