import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { IdentifierItem } from '../features/user-search/api'
import type { UserRecord } from '../features/user-search/model'
import type {
  GlobalRankDataset,
  GlobalRankMeta,
  GlobalRankTask,
  GlobalRankTaskChunk,
  GlobalRankVideoRow,
  RankConfig,
} from '../features/custom-ranking/model'
import type { CsvHandleRecord, CsvSourceRegistry } from '../features/player-stats/csv-sources'
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
  /** 关联清单元数据：不包含文件句柄。 */
  csvSourceMeta: {
    key: string
    value: CsvSourceRegistry
  }
  /** 文件句柄按来源独立保存，修改一个来源不重写其他句柄。 */
  csvHandles: {
    key: string
    value: CsvHandleRecord
  }
  statExclusions: {
    key: string
    value: ExclusionScopeRecord
  }
  globalRankDatasets: {
    key: string
    value: GlobalRankDataset
    indexes: { 'by-status': string; 'by-base': string }
  }
  globalRankVideos: {
    key: [string, number]
    value: GlobalRankVideoRow
    indexes: {
      'by-dataset-player': [string, number]
      'by-dataset-detail': [string, string]
    }
  }
  globalRankTasks: {
    key: string
    value: GlobalRankTask
    indexes: { 'by-dataset': string }
  }
  globalRankTaskChunks: {
    key: [string, string, string]
    value: GlobalRankTaskChunk
    indexes: { 'by-task': string }
  }
  globalRankConfigs: {
    key: string
    value: RankConfig
  }
  globalRankMeta: {
    key: string
    value: GlobalRankMeta
  }
}

const DB_NAME = 'yuanshen-helper'
const DB_VERSION = 7

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
        if (!db.objectStoreNames.contains('csvSourceMeta')) {
          db.createObjectStore('csvSourceMeta', { keyPath: 'id' })
        }
        if (!db.objectStoreNames.contains('csvHandles')) {
          db.createObjectStore('csvHandles', { keyPath: 'sourceId' })
        }
        if (!db.objectStoreNames.contains('statExclusions')) {
          db.createObjectStore('statExclusions', { keyPath: 'scopeId' })
        }
        if (!db.objectStoreNames.contains('globalRankDatasets')) {
          const store = db.createObjectStore('globalRankDatasets', { keyPath: 'id' })
          store.createIndex('by-status', 'status')
          store.createIndex('by-base', 'baseUrl')
        }
        if (!db.objectStoreNames.contains('globalRankVideos')) {
          const store = db.createObjectStore('globalRankVideos', {
            keyPath: ['datasetId', 'videoId'],
          })
          store.createIndex('by-dataset-player', ['datasetId', 'playerId'])
          store.createIndex('by-dataset-detail', ['datasetId', 'detailState'])
        }
        if (!db.objectStoreNames.contains('globalRankTasks')) {
          const store = db.createObjectStore('globalRankTasks', { keyPath: 'id' })
          store.createIndex('by-dataset', 'datasetId')
        }
        if (!db.objectStoreNames.contains('globalRankTaskChunks')) {
          const store = db.createObjectStore('globalRankTaskChunks', {
            keyPath: ['taskId', 'kind', 'chunkId'],
          })
          store.createIndex('by-task', 'taskId')
        }
        if (!db.objectStoreNames.contains('globalRankConfigs')) {
          db.createObjectStore('globalRankConfigs', { keyPath: 'id' })
        }
        if (!db.objectStoreNames.contains('globalRankMeta')) {
          db.createObjectStore('globalRankMeta', { keyPath: 'key' })
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
