import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import { readLocalPlayback } from '../src/features/minigame-export/site-history'
import { playbackFile } from '../src/features/minigame-export/playback-file'
import {
  onlineMode, onlineRequestTarget, parsePlaybackSnapshot,
  playbackTarget, targetIdentity, type PlaybackTarget,
} from '../src/features/minigame-export/playback'

const origin = 'https://openms.top'
const localUrl = `${origin}/#/minigame/left-click?history=528`
const onlineUrl = `${origin}/#/minigame/left-click?player=95&key=b-50-v1`
const metadata = { id: 528, game: 'left-click', mode: { key: 'b', rows: 8, columns: 8, density: 50 },
  scoreMs: 1234, playedAt: 1000 }
const replay = { version: 1, initialBoard: 'AAAA', events: [], specialEvents: [] }
const record = { metadata, payload: { encoding: 'json', data: replay } }
const online: Extract<PlaybackTarget, { kind: 'online' }> = { kind: 'online', game: 'left-click', playerId: 95, key: 'b-50-v1' }

describe('原生小游戏回放目标', () => {
  it('区分本地记录与线上玩家，查询参数顺序不影响目标身份', () => {
    expect(playbackTarget(localUrl)).toEqual({ kind: 'local', game: 'left-click', id: 528 })
    expect(playbackTarget(onlineUrl)).toEqual(online)
    expect(targetIdentity(playbackTarget(`${origin}/#/minigame/left-click/?key=b-50-v1&player=095`)))
      .toBe(targetIdentity(online))
    expect(targetIdentity(playbackTarget(localUrl))).not.toBe(targetIdentity(online))
  })

  it.each([
    'https://evil.test/#/minigame/left-click?history=528',
    `${origin}/#https://evil.test/minigame/left-click?history=528`,
    `${origin}/#/minigame/left-click-extra?history=528`,
    `${origin}/#/minigame/left-click/extra?history=528`,
    `${origin}/#/minigame/left-click?history=0`,
    `${localUrl}&history=528`, `${localUrl}&player=95`, `${localUrl}&key=b-50-v1`,
    `${onlineUrl}&player=95`, `${onlineUrl}&key=i-50-v1`,
    `${origin}/#/minigame/left-click?player=95`,
    `${origin}/#/minigame/left-click?player=9007199254740992&key=b-50-v1`,
    `${origin}/#/minigame/left-click?key=b-50-v1`,
  ])('拒绝歧义或非原生回放链接 %s', (url) => { expect(playbackTarget(url)).toBeNull() })

  it('只留存对应站点的 GET 录像接口，不把其他请求当成录像', () => {
    expect(onlineRequestTarget('/api/minigame/left-click/replay?key=b-50-v1&player=95', 'get')).toEqual(online)
    expect(onlineRequestTarget('/api/minigame/left-click/replay?key=b-50-v1&player=95', 'POST')).toBeNull()
    expect(onlineRequestTarget('https://evil.test/api/minigame/left-click/replay?key=b-50-v1&player=95', 'GET')).toBeNull()
    expect(onlineRequestTarget('/api/minigame/left-click/rank?key=b-50-v1&player=95', 'GET')).toBeNull()
  })

})

describe('线上录像元信息和单局文件', () => {
  it.each([
    ['left-click', 'e-87.5-v1', { key: 'e', rows: 16, columns: 30, density: 87.5 }],
    ['multi-touch', 'i-75-v1', { key: 'i', rows: 16, columns: 16, density: 75 }],
    ['flag-chord', 'i-v1', { key: 'i', rows: 16, columns: 16, total: 15 }],
    ['missing-cell', 'e-v1', { key: 'e', rows: 16, columns: 30, mines: 99 }],
    ['reaction', 'b-25-v1', { key: 'b', length: 5, target: 10, probability: 25, rankingKey: 'reaction-b-25-v1' }],
  ] as const)('还原 %s 的原生模式 %s', (game, key, expected) => {
    expect(onlineMode({ ...online, game, key })).toEqual(expected)
  })

  it.each([
    ['left-click', 'b-25-v1'], ['left-click', 'b-50-v2'], ['flag-chord', 'e-v1'],
    ['flag-chord', 'b-50-v1'], ['reaction', 'b-75-v1'], ['missing-cell', 'b-50-v1'],
  ] as const)('拒绝未知模式 %s %s', (game, key) => {
    expect(() => onlineMode({ ...online, game, key })).toThrow()
  })

  it('本地按钮导出与历史列表保持相同结构、名称和原始载荷', async () => {
    const snapshot = parsePlaybackSnapshot({ url: localUrl, record })
    const file = playbackFile(snapshot, replay)
    expect(file.filename).toBe('left-click-beg-1-2-1.234s-528.json')
    expect(JSON.parse(await file.blob.text())).toEqual({ localId: 528, game: 'left-click', mode: metadata.mode,
      scoreMs: 1234, playedAt: 1000, replay })
  })

  it('线上导出包含玩家与榜单，不伪造本地编号或完成时间', async () => {
    const { id: _id, playedAt: _playedAt, ...onlineMetadata } = metadata
    const snapshot = parsePlaybackSnapshot({ url: onlineUrl, record: { ...record, metadata: onlineMetadata } })
    const file = playbackFile(snapshot, replay)
    expect(file.filename).toBe('left-click-beg-1-2-1.234s-player95.json')
    expect(JSON.parse(await file.blob.text())).toEqual({ playerId: 95, rankingKey: 'left-click-b-50-v1',
      game: 'left-click', mode: metadata.mode, scoreMs: 1234, replay })
  })

  it('校验消息中的录像来源、模式和成绩', () => {
    expect(() => parsePlaybackSnapshot({ url: localUrl, record: { ...record, metadata: { ...metadata, id: 529 } } })).toThrow('不一致')
    expect(() => parsePlaybackSnapshot({ url: onlineUrl, record: { ...record, metadata: { ...metadata, mode: { ...metadata.mode, density: 75 } } } })).toThrow('不一致')
    expect(() => parsePlaybackSnapshot({ url: onlineUrl, record: { ...record, metadata: { ...metadata, scoreMs: 0 } } })).toThrow('成绩')
  })
})

describe('按当前本地编号只读导出', () => {
  it('不扫描历史，检查游戏、编号及存储格式，并保持数据不变', async () => {
    const factory = new IDBFactory()
    await new Promise<void>((resolve, reject) => {
      const opening = factory.open('saolei-minigame', 2)
      opening.onupgradeneeded = () => opening.result.createObjectStore('results', { keyPath: 'id' })
      opening.onerror = () => reject(opening.error)
      opening.onsuccess = () => {
        const db = opening.result
        const tx = db.transaction('results', 'readwrite')
        tx.objectStore('results').put({ ...metadata, replay })
        tx.oncomplete = () => { db.close(); resolve() }
      }
    })
    expect(await readLocalPlayback('left-click', 528, factory)).toEqual(record)
    await expect(readLocalPlayback('flag-chord', 528, factory)).rejects.toThrow('当前游戏不一致')
    await expect(readLocalPlayback('left-click', 529, factory)).rejects.toThrow('已不存在')
    expect(await factory.databases()).toEqual([{ name: 'saolei-minigame', version: 2 }])
  })
})
