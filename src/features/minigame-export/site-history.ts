import { bufferToBase64 } from '../upload-watch/bytes'
import {
  HISTORY_DATABASE, HISTORY_PAGE_SIZE, HISTORY_STORE, MAX_ARCHIVE_BYTES,
  isObject, jsonObject, parseMetadata, safeInteger, sameMetadata,
  type HistoryIssue, type HistoryMetadata, type HistoryPage, type HistoryRecord,
} from './model'

/** Never supply a version, create a store, or migrate the website's database. */
export function openHistoryDatabase(factory: IDBFactory = indexedDB): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    let missing = false
    let expired = false
    const request = factory.open(HISTORY_DATABASE)
    const timeout = setTimeout(() => {
      expired = true
      reject(new Error('等待站点数据库超时；请等待小游戏格式升级结束后重试'))
    }, 8000)
    request.onupgradeneeded = () => {
      missing = true
      request.transaction?.abort()
    }
    request.onerror = () => {
      clearTimeout(timeout)
      if (missing) resolve(null)
      else reject(new Error('无法打开小游戏历史数据库，请在普通站点标签页重试'))
    }
    request.onsuccess = () => {
      clearTimeout(timeout)
      const db = request.result
      if (expired) { db.close(); return }
      db.onversionchange = () => db.close()
      if (db.version > 3 || !db.objectStoreNames.contains(HISTORY_STORE)) {
        db.close()
        reject(new Error('不支持此小游戏数据库结构，请更新元神助手'))
      } else resolve(db)
    }
  })
}

function assertVersion(db: IDBDatabase, expected?: number): void {
  if (expected !== undefined && db.version !== expected) {
    throw new Error('站点历史格式已变化，请重新读取历史后导出')
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('读取小游戏历史失败'))
  })
}

export async function listSiteHistory(afterId: number, upperId?: number, version?: number,
  factory: IDBFactory = indexedDB): Promise<HistoryPage> {
  const db = await openHistoryDatabase(factory)
  if (db === null) {
    if (version !== undefined) throw new Error('小游戏历史已被清除，请重新读取')
    return { databaseVersion: null, upperId: 0, nextAfterId: null, entries: [], issues: [] }
  }
  try {
    assertVersion(db, version)
    const transaction = db.transaction(HISTORY_STORE, 'readonly')
    const store = transaction.objectStore(HISTORY_STORE)
    const last = await requestResult(store.openKeyCursor(null, 'prev'))
    const maximum = upperId ?? (last === null ? 0 : last.primaryKey)
    if (!safeInteger(maximum)) throw new Error('历史记录主键格式不受支持')
    if (maximum <= afterId) {
      return { databaseVersion: db.version, upperId: maximum, nextAfterId: null, entries: [], issues: [] }
    }
    const result = await new Promise<{ entries: HistoryMetadata[]; issues: HistoryIssue[]; nextAfterId: number | null }>((resolve, reject) => {
      const entries: HistoryMetadata[] = []
      const issues: HistoryIssue[] = []
      let scanned = 0
      let previousId = afterId
      const cursorRequest = store.openCursor(IDBKeyRange.bound(afterId, maximum, true, false))
      transaction.onabort = () => reject(transaction.error ?? new Error('历史读取被站点中断，请重试'))
      cursorRequest.onerror = () => reject(cursorRequest.error)
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result
        if (cursor === null) { resolve({ entries, issues, nextAfterId: null }); return }
        if (scanned === HISTORY_PAGE_SIZE) {
          resolve({ entries, issues, nextAfterId: previousId })
          return
        }
        const id = cursor.primaryKey
        if (!safeInteger(id, 1)) { reject(new Error('历史记录主键格式不受支持')); return }
        scanned++
        previousId = id
        try {
          const value: unknown = cursor.value
          if (!isObject(value) || value.id !== id) throw new Error('历史记录编号与主键不一致')
          entries.push(parseMetadata(value))
        } catch (error) {
          issues.push({ id, error: error instanceof Error ? error.message : '历史记录无效' })
        }
        cursor.continue()
      }
    })
    return { databaseVersion: db.version, upperId: maximum, ...result }
  } finally { db.close() }
}

export async function readSiteHistory(expected: HistoryMetadata, version: number,
  factory: IDBFactory = indexedDB): Promise<HistoryRecord> {
  const db = await openHistoryDatabase(factory)
  if (db === null) throw new Error('小游戏历史已被清除')
  try {
    assertVersion(db, version)
    const value: unknown = await requestResult(db.transaction(HISTORY_STORE, 'readonly').objectStore(HISTORY_STORE).get(expected.id))
    if (!isObject(value)) throw new Error('这条本地录像已不存在，请重新读取历史')
    const metadata = parseMetadata(value)
    if (!sameMetadata(metadata, expected)) throw new Error('这条历史记录已发生变化，请重新读取历史')
    if (value.replay instanceof ArrayBuffer) {
      if (value.replay.byteLength === 0 || value.replay.byteLength > MAX_ARCHIVE_BYTES) {
        throw new Error('压缩录像为空或超过 16 MiB，未导出')
      }
      return { metadata, payload: { encoding: '7z', data: bufferToBase64(value.replay) } }
    }
    if (version >= 3) throw new Error('新版历史缺少有效的压缩录像')
    const replay = metadata.game === 'missing-cell'
      ? { ...(value.version === undefined ? {} : { version: value.version }), rounds: value.rounds }
      : value.replay
    return { metadata, payload: { encoding: 'json', data: jsonObject(replay) } }
  } finally { db.close() }
}
