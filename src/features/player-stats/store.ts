import { getDb } from '../../shared/db'
import type { PlayerMeta, PlayerVideoRow } from '../../shared/db'

export async function readUserRows(userId: number): Promise<PlayerVideoRow[]> {
  const db = await getDb()
  return db.getAllFromIndex('playerVideos', 'by-user', userId)
}

export async function readUserMeta(userId: number): Promise<PlayerMeta | undefined> {
  const db = await getDb()
  return db.get('playerMeta', userId)
}

export async function putRows(
  userId: number,
  rows: PlayerVideoRow[],
  removedIds: number[] = [],
): Promise<void> {
  const db = await getDb()
  const tx = db.transaction('playerVideos', 'readwrite')
  for (const row of rows) void tx.store.put(row)
  for (const id of removedIds) void tx.store.delete([userId, id])
  await tx.done
}

export async function saveFetchedAt(userId: number, fetchedAt = Date.now()): Promise<void> {
  const db = await getDb()
  await db.put('playerMeta', { userId, fetchedAt })
}
