import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { IdentifierItem } from '../features/user-search/api'
import type { UserRecord } from '../features/user-search/model'
import type { CsvSourceRegistry } from '../features/player-stats/csv-sources'
import type { VideoDetail } from '../features/player-stats/model'
import type { ExclusionScopeRecord } from '../features/player-stats/statistics-exclusion'
import type { WatchFile } from '../features/upload-watch/types'

export type SyncPhase = 'idle' | 'listing' | 'fetching' | 'paused'

export interface SyncMeta {
  key: string
  watermark: number
  userCount: number
  lastSyncAt: number
  phase: SyncPhase
  cursor: number
}

export interface IdentifierCacheEntry {
  key: string
  items: IdentifierItem[]
  fetchedAt: number
}

export interface WatchHandleRecord {
  id: string
  name: string
  handle: FileSystemDirectoryHandle
  savedAt: number
}

/** 玩家数据缓存：一条录像一行，解析字段可以缺失（未过审的默认不抓）。 */
export interface PlayerVideoRow {
  userId: number
  id: number
  state: string
  uploadTime: string
  ongoing: boolean
  detail: VideoDetail | null
  /** 明细缺 path/op/isl，已按部分可用降级缓存，避免反复重拉。 */
  detailPartial?: boolean
}

export interface PlayerMeta {
  userId: number
  fetchedAt: number
  /** 明细字段版本；老缓存没有这一项，需要重拉。 */
  version?: number
}

interface YuanshenDB extends DBSchema {
  users: {
    key: number
    value: UserRecord
    indexes: { 'by-username': string }
  }
  meta: {
    key: string
    value: SyncMeta
  }
  identifierCache: {
    key: string
    value: IdentifierCacheEntry
  }
  watchHandle: {
    key: string
    value: WatchHandleRecord
  }
  watchFiles: {
    key: string
    value: WatchFile
    indexes: { 'by-status': string }
  }
  playerVideos: {
    key: [number, number]
    value: PlayerVideoRow
    indexes: { 'by-user': number }
  }
  playerMeta: {
    key: number
    value: PlayerMeta
  }
  csvSources: {
    key: string
    value: CsvSourceRegistry
  }
  statExclusions: {
    key: string
    value: ExclusionScopeRecord
  }
}

const DB_NAME = 'yuanshen-helper'
const DB_VERSION = 5

let dbPromise: Promise<IDBPDatabase<YuanshenDB>> | null = null
const blockedListeners = new Set<(version: number) => void>()

/** 数据库升级被其他页面占用时通知界面；不能一直无提示等待。 */
export function onDbBlocked(listener: (version: number) => void): () => void {
  blockedListeners.add(listener)
  return () => {
    blockedListeners.delete(listener)
  }
}

/**
 * 所有 store 共用一个数据库连接和版本号。
 * 两个模块各开一份不同版本的连接会让后开的那个直接 VersionError。
 */
export function getDb(): Promise<IDBPDatabase<YuanshenDB>> {
  if (!dbPromise) {
    dbPromise = openDB<YuanshenDB>(DB_NAME, DB_VERSION, {
      blocked(_currentVersion, nextVersion) {
        for (const listener of blockedListeners) listener(nextVersion ?? DB_VERSION)
      },
      blocking(_currentVersion, _nextVersion, event) {
        // 别的页面要升级：主动断开本页连接，下次 getDb() 按新版本重开。
        const target = event.target as IDBDatabase | null
        target?.close()
        dbPromise = null
      },
      terminated() {
        dbPromise = null
      },
      upgrade(db) {
        if (!db.objectStoreNames.contains('users')) {
          const store = db.createObjectStore('users', { keyPath: 'id' })
          store.createIndex('by-username', 'usernameLower')
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' })
        }
        if (!db.objectStoreNames.contains('identifierCache')) {
          db.createObjectStore('identifierCache', { keyPath: 'key' })
        }
        if (!db.objectStoreNames.contains('watchHandle')) {
          db.createObjectStore('watchHandle', { keyPath: 'id' })
        }
        if (!db.objectStoreNames.contains('watchFiles')) {
          const store = db.createObjectStore('watchFiles', { keyPath: 'relPath' })
          store.createIndex('by-status', 'status')
        }
        if (!db.objectStoreNames.contains('playerVideos')) {
          const store = db.createObjectStore('playerVideos', { keyPath: ['userId', 'id'] })
          store.createIndex('by-user', 'userId')
        }
        if (!db.objectStoreNames.contains('playerMeta')) {
          db.createObjectStore('playerMeta', { keyPath: 'userId' })
        }
        if (!db.objectStoreNames.contains('csvSources')) {
          db.createObjectStore('csvSources', { keyPath: 'id' })
        }
        if (!db.objectStoreNames.contains('statExclusions')) {
          db.createObjectStore('statExclusions', { keyPath: 'scopeId' })
        }
      },
    })
      .catch((error: unknown) => {
        dbPromise = null
        throw error
      })
  }
  return dbPromise
}
