import {
  getDb,
  type IdentifierCacheEntry,
  type SyncMeta,
} from '../../shared/db'
import type { UserRecord } from './model'

export type { SyncMeta }

const SYNC_META_KEY = 'user-search/sync'

export const DEFAULT_SYNC_META: SyncMeta = {
  key: SYNC_META_KEY,
  watermark: 0,
  userCount: 0,
  lastSyncAt: 0,
  phase: 'idle',
  cursor: 0,
}

export async function putUsers(records: UserRecord[]): Promise<void> {
  if (records.length === 0) return
  const db = await getDb()
  const tx = db.transaction('users', 'readwrite')
  const seen = new Set<number>()
  for (const record of records) {
    if (seen.has(record.id)) continue
    seen.add(record.id)
    void tx.store.put(record)
  }
  await tx.done
}

export async function getAllUsers(): Promise<UserRecord[]> {
  const db = await getDb()
  return db.getAll('users')
}

export async function countUsers(): Promise<number> {
  const db = await getDb()
  return db.count('users')
}

export async function pruneUsers(keepIds: Set<number>): Promise<number> {
  const db = await getDb()
  const keys = await db.getAllKeys('users')
  const stale = keys.filter((id) => !keepIds.has(id))
  if (stale.length === 0) return 0

  const tx = db.transaction('users', 'readwrite')
  for (const id of stale) void tx.store.delete(id)
  await tx.done
  return stale.length
}

export async function getSyncMeta(): Promise<SyncMeta> {
  const db = await getDb()
  return (await db.get('meta', SYNC_META_KEY)) ?? { ...DEFAULT_SYNC_META }
}

export async function setSyncMeta(patch: Partial<SyncMeta>): Promise<SyncMeta> {
  const db = await getDb()
  const current = (await db.get('meta', SYNC_META_KEY)) ?? { ...DEFAULT_SYNC_META }
  const next: SyncMeta = { ...current, ...patch, key: SYNC_META_KEY }
  await db.put('meta', next)
  return next
}

export async function clearAllData(): Promise<void> {
  const db = await getDb()
  const tx = db.transaction(['users', 'meta', 'identifierCache'], 'readwrite')
  await Promise.all([
    tx.objectStore('users').clear(),
    tx.objectStore('meta').clear(),
    tx.objectStore('identifierCache').clear(),
  ])
  await tx.done
}

export async function getIdentifierCache(
  key: string,
): Promise<IdentifierCacheEntry | undefined> {
  const db = await getDb()
  return db.get('identifierCache', key)
}

export async function putIdentifierCache(entry: IdentifierCacheEntry): Promise<void> {
  const db = await getDb()
  await db.put('identifierCache', entry)
}
