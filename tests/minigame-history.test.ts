import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { isHistoryReader } from '../src/content/minigame-history'
import { listSiteHistory, openHistoryDatabase, readSiteHistory } from '../src/features/minigame-export/site-history'
import {
  HISTORY_DATABASE, HISTORY_MESSAGE, HISTORY_STORE, jsonObject, localHistoryTarget,
  parseHistoryPage, parseHistoryRecord, parseHistoryRequest, parseMetadata,
  type HistoryMetadata,
} from '../src/features/minigame-export/model'

let factory: IDBFactory
beforeEach(() => { factory = new IDBFactory() })

function metadata(id = 1): HistoryMetadata {
  return { id, game: 'flag-chord', mode: { key: 'b', rows: 8, columns: 8, total: 4 }, scoreMs: 1234, playedAt: 1_790_000_000_000 + id }
}

function seed(version: number, values: unknown[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.open(HISTORY_DATABASE, version)
    request.onupgradeneeded = () => request.result.createObjectStore(HISTORY_STORE, { keyPath: 'id', autoIncrement: true })
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction(HISTORY_STORE, 'readwrite')
      for (const value of values) tx.objectStore(HISTORY_STORE).put(value)
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onabort = () => { db.close(); reject(tx.error) }
    }
  })
}

describe('小游戏只读数据库访问', () => {
  it('历史不存在时不留下空数据库，不触发站点升级', async () => {
    expect(await openHistoryDatabase(factory)).toBeNull()
    expect(await factory.databases()).toEqual([])
    expect(await listSiteHistory(0, undefined, undefined, factory)).toEqual({
      databaseVersion: null, upperId: 0, nextAfterId: null, entries: [], issues: [],
    })
    expect(await factory.databases()).toEqual([])
  })

  it('按主键分批扫描，固定上界，不混入读取期间新增的对局', async () => {
    await seed(3, Array.from({ length: 102 }, (_, index) => ({ ...metadata(index + 1), replay: new ArrayBuffer(3) })))
    const first = await listSiteHistory(0, undefined, undefined, factory)
    expect(first.entries).toHaveLength(100)
    expect(first.nextAfterId).toBe(100)
    expect(first.upperId).toBe(102)
    await seed(3, [{ ...metadata(103), replay: new ArrayBuffer(3) }])
    const second = await listSiteHistory(100, first.upperId, first.databaseVersion ?? undefined, factory)
    expect(second.entries.map((entry) => entry.id)).toEqual([101, 102])
    expect(second.nextAfterId).toBeNull()
  })

  it('坏元信息单独报告，仍扫描后面的记录', async () => {
    await seed(3, [{ ...metadata(1), game: 'unknown' }, { ...metadata(2), replay: new ArrayBuffer(1) }])
    const result = await listSiteHistory(0, undefined, undefined, factory)
    expect(result.entries.map((entry) => entry.id)).toEqual([2])
    expect(result.issues).toEqual([{ id: 1, error: expect.any(String) }])
  })

  it('新版返回压缩字节的 Base64，不修改或重存原始录像', async () => {
    const original = { ...metadata(), replay: Uint8Array.from([55, 122, 188, 175]).buffer }
    await seed(3, [original])
    expect(await readSiteHistory(metadata(), 3, factory)).toEqual({ metadata: metadata(), payload: { encoding: '7z', data: 'N3q8rw==' } })
    const db = await openHistoryDatabase(factory)
    expect(db?.version).toBe(3)
    const request = db?.transaction(HISTORY_STORE).objectStore(HISTORY_STORE).get(1)
    const stored: unknown = await new Promise((resolve) => { if (request) request.onsuccess = () => resolve(request.result) })
    expect(stored).toEqual(original)
    db?.close()
  })

  it.each([1, 2])('不升级 v%i，原样提取旧版 JSON 和漏雷顶层字段', async (version) => {
    const replay = { initialBoard: [[1, 16]], events: [] }
    const missing: HistoryMetadata = { ...metadata(2), game: 'missing-cell' }
    const rounds = [{ board: [[10, 16]], timeMs: 1234 }]
    await seed(version, [{ ...metadata(), replay }, { ...missing, rounds }])
    expect((await readSiteHistory(metadata(), version, factory)).payload).toEqual({ encoding: 'json', data: replay })
    expect((await readSiteHistory(missing, version, factory)).payload).toEqual({ encoding: 'json', data: { rounds } })
    expect((await factory.databases())[0].version).toBe(version)
  })

  it('拒绝静默升级后的格式、被清除或被替换的记录', async () => {
    await seed(3, [{ ...metadata(), replay: new ArrayBuffer(1) }])
    await expect(readSiteHistory(metadata(), 2, factory)).rejects.toThrow('格式已变化')
    await expect(readSiteHistory(metadata(2), 3, factory)).rejects.toThrow('已不存在')
    await expect(readSiteHistory({ ...metadata(), scoreMs: 99 }, 3, factory)).rejects.toThrow('已发生变化')
    await expect(readSiteHistory(metadata(), 3, new IDBFactory())).rejects.toThrow('已被清除')
  })

  it('拒绝未知数据库版本，保持它的版本与数据不变', async () => {
    await seed(4, [{ ...metadata(), replay: 'future' }])
    await expect(openHistoryDatabase(factory)).rejects.toThrow('不支持')
    expect((await factory.databases())[0].version).toBe(4)
  })

  it('不把新版空录像或对象当作可导出的压缩文件', async () => {
    await seed(3, [{ ...metadata(), replay: new ArrayBuffer(0) }, { ...metadata(2), replay: {} }])
    await expect(readSiteHistory(metadata(), 3, factory)).rejects.toThrow('压缩录像为空')
    await expect(readSiteHistory(metadata(2), 3, factory)).rejects.toThrow('缺少有效的压缩录像')
  })
})

describe('消息与录像边界', () => {
  it('只允许本扩展的独立导出页读取历史', () => {
    expect(isHistoryReader({ id: 'ext', url: 'chrome-extension://ext/minigame.html?tab=1' }, 'ext')).toBe(true)
    for (const sender of [
      { id: 'other', url: 'chrome-extension://ext/minigame.html' },
      { id: 'ext', url: 'https://openms.top/minigame.html' },
      { id: 'ext', url: 'chrome-extension://ext/popup.html' },
      { id: 'ext', url: 'chrome-extension://ext/minigame.html/extra' },
      { id: 'ext', url: 'broken' }, {},
    ]) expect(isHistoryReader(sender, 'ext')).toBe(false)
  })

  it('验证读取参数，拒绝伪造模式、非法编号及非 JSON 数据', () => {
    expect(parseHistoryRequest({ type: HISTORY_MESSAGE, action: 'list', afterId: 0 })).toEqual({ type: HISTORY_MESSAGE, action: 'list', afterId: 0 })
    expect(parseHistoryRequest({ type: HISTORY_MESSAGE, action: 'read', databaseVersion: 3, expected: metadata() })).toHaveProperty('expected.id', 1)
    for (const value of [
      { type: HISTORY_MESSAGE, action: 'delete', afterId: 0 },
      { type: HISTORY_MESSAGE, action: 'list', afterId: -1 },
      { type: HISTORY_MESSAGE, action: 'list', afterId: '0' },
      { type: HISTORY_MESSAGE, action: 'read', databaseVersion: 3, expected: { ...metadata(), id: NaN } },
    ]) expect(() => parseHistoryRequest(value)).toThrow()
    expect(() => parseMetadata({ ...metadata(), mode: { key: 'b', handle: new Date() } })).toThrow()
    expect(() => jsonObject({ value: Infinity })).toThrow()
    expect(() => jsonObject({ value: undefined })).toThrow()
    expect(() => jsonObject({ value: 'too long' }, 2)).toThrow('过大')
  })

  it('验证来自站点的响应，拒绝错误编码与超量分页', () => {
    expect(parseHistoryRecord({ metadata: metadata(), payload: { encoding: '7z', data: 'AQID' } }).payload).toEqual({ encoding: '7z', data: 'AQID' })
    for (const data of ['', '{}', 'a===', 'abc', '===a']) {
      expect(() => parseHistoryRecord({ metadata: metadata(), payload: { encoding: '7z', data } })).toThrow()
    }
    expect(() => parseHistoryPage({ databaseVersion: 3, upperId: 1, nextAfterId: null, entries: Array(101).fill(metadata()), issues: [] })).toThrow()
  })

  it('只识别本站明确的本地录像路由', () => {
    expect(localHistoryTarget('https://openms.top/#/minigame/flag-chord?history=586')).toEqual({ game: 'flag-chord', id: 586 })
    for (const url of [
      'https://example.com/#/minigame/flag-chord?history=586',
      'https://openms.top/#/not-minigame/flag-chord?history=586',
      'https://openms.top/#/minigame/flag-chord?history=-1',
      'https://openms.top/#/minigame/flag-chord?history=1&history=2',
      'https://openms.top/#/minigame/flag-chord?history=1&player=3',
      'https://openms.top/#/minigame/flag-chord?history=9007199254740992', 'broken',
    ]) expect(localHistoryTarget(url)).toBeNull()
  })
})
