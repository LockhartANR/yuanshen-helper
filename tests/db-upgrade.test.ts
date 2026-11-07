import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { getDb, onDbBlocked } from '../src/shared/db'
import { deferred } from './helpers/stats-csv'

const DB_NAME = 'yuanshen-helper'

function openLegacy(version: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, version)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('users')) {
        db.createObjectStore('users', { keyPath: 'id' }).createIndex(
          'by-username',
          'usernameLower',
        )
      }
      if (!db.objectStoreNames.contains('playerVideos')) {
        const store = db.createObjectStore('playerVideos', {
          keyPath: ['userId', 'id'],
        })
        store.createIndex('by-user', 'userId')
      }
      if (!db.objectStoreNames.contains('csvSources')) {
        db.createObjectStore('csvSources', { keyPath: 'id' })
      }
    }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
  })
}

describe('共享数据库升级', () => {
  it('升级受旧连接阻塞时通知界面，释放后保留旧数据与 CSV 句柄并完成 v5 升级', async () => {
    const legacy = await openLegacy(4)
    await new Promise<void>((resolve, reject) => {
      const tx = legacy.transaction(['users', 'playerVideos', 'csvSources'], 'readwrite')
      tx.objectStore('users').put({
        id: 7,
        username: 'tester',
        usernameLower: 'tester',
        realname: '测试',
        lastSeenAt: 1,
      })
      tx.objectStore('playerVideos').put({
        userId: 7,
        id: 100,
        state: 'c',
        uploadTime: '',
        ongoing: false,
        detail: null,
      })
      tx.objectStore('csvSources').put({
        id: 'current',
        revision: 7,
        sources: [
          {
            sourceId: 'csv-existing',
            name: 'a.csv',
            handle: { name: 'a.csv', marker: 'handle' },
            addedAt: 1,
            revision: 1,
            lastSuccess: null,
          },
        ],
      })
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    const blocked = deferred<number>()
    const unsubscribe = onDbBlocked(blocked.resolve)
    let db: Awaited<ReturnType<typeof getDb>>
    try {
      const upgrading = getDb()
      expect(await blocked.promise).toBe(5)
      legacy.close()
      db = await upgrading
    } finally {
      legacy.close()
      unsubscribe()
    }
    expect(db.version).toBe(5)
    expect(db.objectStoreNames.contains('csvSources')).toBe(true)
    expect(db.objectStoreNames.contains('statExclusions')).toBe(true)
    expect(await db.get('users', 7)).toMatchObject({ username: 'tester' })
    expect(await db.getAll('playerVideos')).toEqual([
      expect.objectContaining({ userId: 7, id: 100 }),
    ])
    expect(await db.get('csvSources', 'current')).toMatchObject({
      revision: 7,
      sources: [
        expect.objectContaining({
          sourceId: 'csv-existing',
          name: 'a.csv',
          handle: { name: 'a.csv', marker: 'handle' },
        }),
      ],
    })
  })
})
