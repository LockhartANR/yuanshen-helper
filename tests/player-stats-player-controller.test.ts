import { describe, expect, it, vi } from 'vitest'
import type { PlayerVideoRow } from '../src/shared/db'
import { parseStatsCsv } from '../src/features/player-stats/csv'
import { createPlayerController } from '../src/features/player-stats/player-controller'
import type { CsvSession, CsvSessionState } from '../src/features/player-stats/csv-session'
import { createMemoryCsvStore, readCsvFile } from '../src/features/player-stats/csv-sources'
import type { ExclusionRule, ExclusionScopeRecord } from '../src/features/player-stats/statistics-exclusion'
import {
  createMemoryExclusionStore,
} from '../src/features/player-stats/statistics-exclusion-store'
import type { StatisticsExclusionStore } from '../src/features/player-stats/statistics-exclusion-store'
import {
  csvFingerprint,
  csvSequenceDigest,
  siteScopeId,
} from '../src/features/player-stats/statistics-exclusion'
import type { LoadedPlayer } from '../src/features/player-stats/service'
import { csv, CsvTestHandle, deferred } from './helpers/stats-csv'

function fakeSession(overrides: Partial<CsvSession> = {}): CsvSession {
  const state: CsvSessionState = {
    ready: true,
    sources: [],
    revision: 0,
    loaded: new Map(),
    loading: false,
    progress: null,
    message: '',
    errors: [],
    needsPermission: [],
    deltas: new Map(),
    snapshotVersion: 0,
  }
  return {
    state,
    restore: vi.fn(async () => {}),
    refreshAll: vi.fn(async () => {}),
    addFiles: vi.fn(async () => 'success' as const),
    relink: vi.fn(async () => 'success' as const),
    removeSource: vi.fn(async () => {}),
    removeAll: vi.fn(async () => {}),
    grant: vi.fn(async () => {}),
    cancel: vi.fn(),
    checkRegistry: vi.fn(async () => {}),
    setMessage: vi.fn(),
    clearMessage: vi.fn(),
    hasSnapshot: () => false,
    videos: () => [],
    loadedSources: () => [],
    loadedCount: () => 0,
    sourceSummary: () => null,
    destroy: vi.fn(),
    ...overrides,
  }
}

function row(id: number): PlayerVideoRow {
  return {
    id,
    userId: 16,
    uploadTime: '2026-11-03T00:00:00.000Z',
    state: 'c',
    ongoing: false,
    detail: null,
  }
}

function detailRows(): PlayerVideoRow[] {
  const videos = parseStatsCsv(csv(5000, 6000)).videos
  return videos.map((video, index) => ({
    userId: 16,
    id: index + 1,
    uploadTime: video.upload_time,
    state: 'c',
    ongoing: false,
    detail: { ...video, id: index + 1 },
  }))
}

function loaded(rows: PlayerVideoRow[] = [row(1)]): LoadedPlayer {
  return { userId: 16, rows, fetchedAt: 1, fromCache: false, missing: [] }
}

const SITE_SCOPE = siteScopeId('https://openms.top', 16)

function siteRule(videoId: number, ruleId = `rule-${videoId}`): ExclusionRule {
  return {
    ruleId,
    target: { kind: 'site', videoId },
    excludedAt: 1,
    summary: {
      date: null,
      level: 'b',
      timems: 5000,
      bv: 12,
      nf: false,
      state: 'c',
      videoId,
      sourceName: '网站数据',
    },
  }
}

function siteStore(rules: ExclusionRule[]): StatisticsExclusionStore {
  const record: ExclusionScopeRecord = {
    scopeId: SITE_SCOPE,
    kind: 'site',
    revision: rules.length > 0 ? 1 : 0,
    owner: { kind: 'site', namespace: 'https://openms.top', userId: 16 },
    rules,
  }
  return createMemoryExclusionStore(rules.length > 0 ? [record] : [])
}

function harness(
  session = fakeSession(),
  options: {
    store?: StatisticsExclusionStore
    loaded?: PlayerVideoRow[]
  } = {},
) {
  const pending = deferred<LoadedPlayer>()
  const load = vi.fn(() => pending.promise)
  const controller = createPlayerController({
    launch: { kind: 'site', userId: 16, initialPage: 'score', embedded: false },
    loadPlayer: load,
    ensureDetails: vi.fn(async () => ({ rows: [], missing: [] })),
    fetchUserInfo: vi.fn(async () => null),
    createCsvStore: () => createMemoryCsvStore(),
    createCsvSession: () => session,
    canRememberCsvFiles: () => true,
    pickCsvFiles: vi.fn(async () => []),
    createExclusionStore: () => options.store ?? createMemoryExclusionStore(),
    loadSiteNamespace: async () => 'https://openms.top',
  })
  return {
    controller, session, load,
    finishLoad: () => pending.resolve(loaded(options.loaded)),
  }
}

describe('玩家页面控制器：竞态与销毁', () => {
  it('切到 CSV 后晚到的网站结果不写回旧来源', async () => {
    const view = harness()
    void view.controller.start()
    await vi.waitFor(() => expect(view.load).toHaveBeenCalled())
    view.controller.setSource('csv')
    view.finishLoad()
    await vi.waitFor(() => expect(view.controller.getSnapshot().dataset.source).toBe('csv'))
    const snapshot = view.controller.getSnapshot()
    expect(snapshot.source).toBe('csv')
    expect(snapshot.rows).toEqual([])
    expect(snapshot.updatedAt).toBe(0)
    view.controller.destroy()
  })

  it('销毁后晚到的网站结果不再更新状态、通知订阅者或遗留请求', async () => {
    const view = harness()
    const listener = vi.fn()
    view.controller.subscribe(listener)
    void view.controller.start()
    const callsBeforeDestroy = listener.mock.calls.length
    view.controller.destroy()
    view.finishLoad()
    await Promise.resolve()
    await Promise.resolve()
    expect(listener).toHaveBeenCalledTimes(callsBeforeDestroy)
    expect(view.controller.getSnapshot().rows).toEqual([])
    expect(view.session.destroy).toHaveBeenCalledTimes(1)
  })

  it.each(['单个来源', '全部'] as const)('移除%s等待期间销毁，不再切回网站或启动请求', async (kind) => {
    const pending = deferred<void>()
    const remove = vi.fn(() => pending.promise)
    const session = fakeSession(kind === '全部' ? { removeAll: remove } : { removeSource: remove })
    const view = harness(session)
    const listener = vi.fn()
    view.controller.subscribe(listener)
    view.controller.setSource('csv')
    const callsBeforeDestroy = listener.mock.calls.length
    const removing = kind === '全部'
      ? view.controller.removeAllCsv()
      : view.controller.removeCsvSource('missing')
    view.controller.destroy()
    pending.resolve()
    await removing
    await Promise.resolve()
    expect(view.load).not.toHaveBeenCalled()
    expect(listener).toHaveBeenCalledTimes(callsBeforeDestroy)
    expect(view.controller.getSnapshot().source).toBe('csv')
  })
})

describe('玩家页面控制器：统计排除', () => {
  it('发布统计前先加载并应用已保存的规则', async () => {
    const view = harness(fakeSession(), {
      store: siteStore([siteRule(1)]),
      loaded: detailRows(),
    })
    void view.controller.start()
    await vi.waitFor(() => expect(view.load).toHaveBeenCalled())
    view.finishLoad()
    await vi.waitFor(() => expect(view.controller.getSnapshot().videos).toHaveLength(1))
    const snapshot = view.controller.getSnapshot()
    expect(snapshot.exclusion.ready).toBe(true)
    expect(snapshot.exclusion.excludedCount).toBe(1)
    expect(snapshot.exclusion.entries).toHaveLength(2)
    expect(snapshot.videos.map((video) => video.id)).toEqual([2])
    expect(snapshot.dataset.videos.map((video) => video.id)).toEqual([2])
    view.controller.destroy()
  })

  it('排除与恢复都更新统计候选，并保留原始记录用于恢复', async () => {
    const store = siteStore([])
    const view = harness(fakeSession(), { store, loaded: detailRows() })
    void view.controller.start()
    await vi.waitFor(() => expect(view.load).toHaveBeenCalled())
    view.finishLoad()
    await vi.waitFor(() => expect(view.controller.getSnapshot().videos).toHaveLength(2))
    const before = view.controller.getSnapshot()
    const entry = before.exclusion.entries.find((item) => item.videoId === 1)!

    const excluded = await view.controller.excludeEntries([entry.key])
    expect(excluded.ok).toBe(true)
    await vi.waitFor(() => expect(view.controller.getSnapshot().videos).toHaveLength(1))
    const after = view.controller.getSnapshot()
    expect(after.exclusion.entries).toHaveLength(2)
    expect(after.exclusion.excludedCount).toBe(1)
    expect(after.exclusion.entries.find((item) => item.videoId === 1)?.excluded).toBe(true)
    expect(after.dataset.contentVersion).toBeGreaterThan(before.dataset.contentVersion)
    expect((await store.get(SITE_SCOPE))?.rules).toHaveLength(1)

    const current = after.exclusion.entries.find((item) => item.videoId === 1)!
    const restored = await view.controller.restoreEntries([current.key])
    expect(restored.ok).toBe(true)
    await vi.waitFor(() => expect(view.controller.getSnapshot().videos).toHaveLength(2))
    expect(view.controller.getSnapshot().exclusion.excludedCount).toBe(0)
    expect((await store.get(SITE_SCOPE))?.rules).toHaveLength(0)
    view.controller.destroy()
  })

  it('尚未成功读取当前快照时不把旧规则标成未匹配', async () => {
    const view = harness(fakeSession(), {
      store: siteStore([siteRule(999, 'rule-missing')]),
      loaded: detailRows(),
    })
    void view.controller.start()
    await vi.waitFor(() => expect(view.controller.getSnapshot().exclusion.ready).toBe(true))
    expect(view.controller.getSnapshot().exclusion.unmatchedCount).toBe(0)
    expect(view.controller.getSnapshot().exclusion.entries).toEqual([])

    view.finishLoad()
    await vi.waitFor(() => expect(view.controller.getSnapshot().exclusion.unmatchedCount).toBe(1))
    view.controller.destroy()
  })

  it('批量排除全部记录后保留管理列表与恢复入口', async () => {
    const view = harness(fakeSession(), { store: siteStore([]), loaded: detailRows() })
    void view.controller.start()
    await vi.waitFor(() => expect(view.load).toHaveBeenCalled())
    view.finishLoad()
    await vi.waitFor(() => expect(view.controller.getSnapshot().videos).toHaveLength(2))
    const keys = view.controller.getSnapshot().exclusion.entries.map((entry) => entry.key)

    const excluded = await view.controller.excludeEntries(keys)
    expect(excluded.ok).toBe(true)
    await vi.waitFor(() => expect(view.controller.getSnapshot().videos).toHaveLength(0))
    const empty = view.controller.getSnapshot()
    expect(empty.exclusion.excludedCount).toBe(2)
    expect(empty.exclusion.entries).toHaveLength(2)
    expect(empty.exclusion.entries.every((entry) => entry.excluded)).toBe(true)
    expect(empty.dataset.videos).toEqual([])

    const restored = await view.controller.restoreEntries(keys)
    expect(restored.ok).toBe(true)
    await vi.waitFor(() => expect(view.controller.getSnapshot().videos).toHaveLength(2))
    expect(view.controller.getSnapshot().exclusion.excludedCount).toBe(0)
    view.controller.destroy()
  })

  it('清除当前未匹配规则不重建统计内容', async () => {
    const view = harness(fakeSession(), {
      store: siteStore([siteRule(999, 'rule-missing')]),
      loaded: detailRows(),
    })
    void view.controller.start()
    await vi.waitFor(() => expect(view.load).toHaveBeenCalled())
    view.finishLoad()
    await vi.waitFor(() => expect(view.controller.getSnapshot().exclusion.ready).toBe(true))
    await vi.waitFor(() => expect(view.controller.getSnapshot().videos).toHaveLength(2))
    const before = view.controller.getSnapshot()
    expect(before.exclusion.unmatchedCount).toBe(1)
    expect(before.videos).toHaveLength(2)

    const cleared = await view.controller.clearExclusionRules(['rule-missing'])
    expect(cleared.ok).toBe(true)
    const after = view.controller.getSnapshot()
    expect(after.exclusion.unmatchedCount).toBe(0)
    expect(after.videos).toHaveLength(2)
    expect(after.dataset.contentVersion).toBe(before.dataset.contentVersion)
    view.controller.destroy()
  })

  it('首次规则读取失败不发布统计，重试后继续加载网站数据', async () => {
    let fail = true
    const memory = createMemoryExclusionStore()
    const store: StatisticsExclusionStore = {
      list: () => (fail ? Promise.reject(new Error('数据库被占用')) : memory.list()),
      get: (scopeId) => memory.get(scopeId),
      commit: (mutations, isValid) => memory.commit(mutations, isValid),
    }
    const view = harness(fakeSession(), { store, loaded: detailRows() })
    void view.controller.start()
    await vi.waitFor(() => expect(view.controller.getSnapshot().exclusion.error).toContain('数据库被占用'))
    expect(view.load).not.toHaveBeenCalled()
    expect(view.controller.getSnapshot().dataset.videos).toEqual([])

    fail = false
    await view.controller.retryExclusions()
    await vi.waitFor(() => expect(view.load).toHaveBeenCalled())
    view.finishLoad()
    await vi.waitFor(() => expect(view.controller.getSnapshot().videos).toHaveLength(2))
    expect(view.controller.getSnapshot().exclusion.ready).toBe(true)
    view.controller.destroy()
  })

  it('CSV 同一文件移除后重新选择沿用作用域，另一同名文件不继承规则', async () => {
    const first = new CsvTestHandle('stats.csv', csv(5000, 6000), 'file-a')
    const second = new CsvTestHandle('stats.csv', csv(5000, 6000), 'file-b')
    let selection: CsvTestHandle[] = [first]
    const store = createMemoryExclusionStore()
    const controller = createPlayerController({
      launch: { kind: 'csv', initialPage: 'analysis' },
      loadPlayer: vi.fn(async () => loaded()),
      createCsvStore: () => createMemoryCsvStore(),
      canRememberCsvFiles: () => true,
      pickCsvFiles: async () => selection,
      createExclusionStore: () => store,
    })

    await controller.start()
    await controller.addCsvFiles()
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(2))
    const entry = controller.getSnapshot().exclusion.entries[0]!
    const excluded = await controller.excludeEntries([entry.key])
    expect(excluded.ok).toBe(true)
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(1))
    const scopes = await store.list()
    expect(scopes).toHaveLength(1)
    const sourceId = controller.getSnapshot().csv.sources[0]!.sourceId

    await controller.removeCsvSource(sourceId)
    await vi.waitFor(() => expect(controller.getSnapshot().csv.sources).toHaveLength(0))

    selection = [first]
    await controller.addCsvFiles()
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(1))
    expect(controller.getSnapshot().exclusion.excludedCount).toBe(1)
    expect((await store.list())[0]!.scopeId).toBe(scopes[0]!.scopeId)

    const readdedSourceId = controller.getSnapshot().csv.sources[0]!.sourceId
    await controller.removeCsvSource(readdedSourceId)
    await vi.waitFor(() => expect(controller.getSnapshot().csv.sources).toHaveLength(0))

    selection = [second]
    await controller.addCsvFiles()
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(2))
    expect(controller.getSnapshot().exclusion.excludedCount).toBe(0)
    expect((await store.list())).toHaveLength(1)
    controller.destroy()
  })

  it('降级模式不按同名或内容自动继承，用户显式关联历史来源后才应用规则', async () => {
    const makeFile = (name: string): File => {
      const text = csv(5000, 6000)
      return {
        name,
        size: text.length,
        lastModified: 1,
        text: async () => text,
      } as unknown as File
    }
    let file = makeFile('stats.csv')
    const store = createMemoryExclusionStore()
    const controller = createPlayerController({
      launch: { kind: 'csv', initialPage: 'analysis' },
      loadPlayer: vi.fn(async () => loaded()),
      createCsvStore: () => createMemoryCsvStore(),
      canRememberCsvFiles: () => false,
      requestFiles: async () => [file],
      createExclusionStore: () => store,
    })

    await controller.start()
    await controller.addCsvFiles()
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(2))
    const firstEntry = controller.getSnapshot().exclusion.entries[0]!
    expect((await controller.excludeEntries([firstEntry.key])).ok).toBe(true)
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(1))
    const scopeId = (await store.list())[0]!.scopeId
    const sourceId = controller.getSnapshot().csv.sources[0]!.sourceId

    await controller.removeCsvSource(sourceId)
    await vi.waitFor(() => expect(controller.getSnapshot().csv.sources).toHaveLength(0))
    // 重新导入的是一个新 File 对象，不能按同名或内容自动继承规则。
    file = makeFile('stats.csv')
    await controller.addCsvFiles()
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(2))
    const unbound = controller.getSnapshot()
    expect(unbound.exclusion.excludedCount).toBe(0)
    expect(unbound.exclusion.historicalScopes).toEqual([
      { scopeId, name: 'stats.csv', ruleCount: 1 },
    ])
    expect(unbound.exclusion.unboundSources).toHaveLength(1)

    const linked = await controller.linkCsvHistory(
      unbound.exclusion.unboundSources[0]!.sourceId,
      scopeId,
    )
    expect(linked.ok).toBe(true)
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(1))
    expect(controller.getSnapshot().exclusion.excludedCount).toBe(1)
    controller.destroy()
  })

  it('重新关联到不同文件后，新排除使用独立作用域且旧文件规则仍保留', async () => {
    const fileA = new CsvTestHandle('a.csv', csv(5000, 6000), 'file-a')
    const fileB = new CsvTestHandle('b.csv', csv(5000, 7000), 'file-b')
    let picked: CsvTestHandle[] = [fileA]
    const store = createMemoryExclusionStore()
    const controller = createPlayerController({
      launch: { kind: 'csv', initialPage: 'analysis' },
      loadPlayer: vi.fn(async () => loaded()),
      createCsvStore: () => createMemoryCsvStore(),
      canRememberCsvFiles: () => true,
      pickCsvFiles: async () => picked,
      createExclusionStore: () => store,
    })

    await controller.start()
    await controller.addCsvFiles()
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(2))
    const sourceId = controller.getSnapshot().csv.sources[0]!.sourceId
    const aEntry = controller
      .getSnapshot()
      .exclusion.entries.find((entry) => entry.summary.timems === 5000)!
    expect((await controller.excludeEntries([aEntry.key])).ok).toBe(true)
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(1))
    expect(controller.getSnapshot().videos[0]!.timems).toBe(6000)
    const aScope = (await store.list())[0]!.scopeId

    picked = [fileB]
    await controller.relinkCsvSource(sourceId)
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(2))
    expect(controller.getSnapshot().exclusion.excludedCount).toBe(0)

    const bEntry = controller
      .getSnapshot()
      .exclusion.entries.find((entry) => entry.summary.timems === 7000)!
    expect((await controller.excludeEntries([bEntry.key])).ok).toBe(true)
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(1))
    expect(controller.getSnapshot().videos[0]!.timems).toBe(5000)
    expect(controller.getSnapshot().exclusion.excludedCount).toBe(1)
    const scopes = await store.list()
    expect(scopes).toHaveLength(2)
    expect(scopes.some((scope) => scope.scopeId === aScope)).toBe(true)
    expect(
      scopes.map((scope) => (scope.owner.kind === 'csv' ? scope.owner.name : '')).sort(),
    ).toEqual(['a.csv', 'b.csv'])
    for (const scope of scopes) expect(scope.rules).toHaveLength(1)

    picked = [fileA]
    await controller.relinkCsvSource(sourceId)
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(1))
    expect(controller.getSnapshot().videos[0]!.timems).toBe(6000)
    expect(controller.getSnapshot().exclusion.excludedCount).toBe(1)
    controller.destroy()
  })

  it('重新关联异名文件选择沿用：规则逐条匹配新文件并持久保存来源关系', async () => {
    const fileA = new CsvTestHandle('stats-1106.csv', csv(5000, 6000), 'file-a')
    const fileB = new CsvTestHandle('stats-1107.csv', csv(5000, 6000, 7000), 'file-b')
    let picked: CsvTestHandle[] = [fileA]
    const exclusionStore = createMemoryExclusionStore()
    const csvStore = createMemoryCsvStore()
    const confirmRelink = vi.fn(async () => 'inherit' as const)
    const makeController = (): ReturnType<typeof createPlayerController> =>
      createPlayerController({
        launch: { kind: 'csv', initialPage: 'analysis' },
        loadPlayer: vi.fn(async () => loaded()),
        createCsvStore: () => csvStore,
        canRememberCsvFiles: () => true,
        pickCsvFiles: async () => picked,
        createExclusionStore: () => exclusionStore,
        confirmRelink,
      })

    const controller = makeController()
    await controller.start()
    await controller.addCsvFiles()
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(2))
    const sourceId = controller.getSnapshot().csv.sources[0]!.sourceId
    const entry = controller
      .getSnapshot()
      .exclusion.entries.find((item) => item.summary.timems === 5000)!
    expect((await controller.excludeEntries([entry.key])).ok).toBe(true)
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(1))
    const aScope = (await exclusionStore.list())[0]!.scopeId

    picked = [fileB]
    await controller.relinkCsvSource(sourceId)
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(2))
    expect(confirmRelink).toHaveBeenCalledWith({
      sourceId,
      sourceName: 'stats-1106.csv',
      newName: 'stats-1107.csv',
      ruleCount: 1,
    })
    const snapshot = controller.getSnapshot()
    expect(snapshot.exclusion.excludedCount).toBe(1)
    expect(snapshot.videos.map((video) => video.timems).sort()).toEqual([6000, 7000])
    expect(snapshot.csv.sources[0]!.exclusionScopeId).toBe(aScope)
    const scopes = await exclusionStore.list()
    expect(scopes).toHaveLength(1)
    expect(scopes[0]!.scopeId).toBe(aScope)
    expect(scopes[0]!.rules).toHaveLength(1)
    controller.destroy()

    // 重开页面：来源清单保存的沿用关系仍然生效，不要求重新选择。
    const reopened = makeController()
    await reopened.start()
    await reopened.refreshCsv()
    await vi.waitFor(() => expect(reopened.getSnapshot().videos).toHaveLength(2))
    expect(reopened.getSnapshot().exclusion.excludedCount).toBe(1)
    expect(reopened.getSnapshot().videos.map((video) => video.timems).sort()).toEqual([
      6000,
      7000,
    ])
    expect(confirmRelink).toHaveBeenCalledTimes(1)
    reopened.destroy()
  })

  it('沿用确认等待期间外部重新关联时拒绝旧确认，不覆盖新文件', async () => {
    const fileA = new CsvTestHandle('a.csv', csv(5000, 6000), 'file-a')
    const fileB = new CsvTestHandle('b.csv', csv(5000, 7000), 'file-b')
    const fileC = new CsvTestHandle('c.csv', csv(8000, 9000), 'file-c')
    let picked: CsvTestHandle[] = [fileA]
    const csvStore = createMemoryCsvStore()
    const gate = deferred<'inherit' | 'new' | 'cancel'>()
    const confirmRelink = vi.fn(() => gate.promise)
    const controller = createPlayerController({
      launch: { kind: 'csv', initialPage: 'analysis' },
      loadPlayer: vi.fn(async () => loaded()),
      createCsvStore: () => csvStore,
      canRememberCsvFiles: () => true,
      pickCsvFiles: async () => picked,
      createExclusionStore: () => createMemoryExclusionStore(),
      confirmRelink,
    })
    await controller.start()
    await controller.addCsvFiles()
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(2))
    const sourceId = controller.getSnapshot().csv.sources[0]!.sourceId
    const entry = controller
      .getSnapshot()
      .exclusion.entries.find((item) => item.summary.timems === 5000)!
    await controller.excludeEntries([entry.key])
    await vi.waitFor(() => expect(controller.getSnapshot().exclusion.excludedCount).toBe(1))

    picked = [fileB]
    const relink = controller.relinkCsvSource(sourceId)
    await vi.waitFor(() => expect(confirmRelink).toHaveBeenCalled())

    // 另一个页面在确认框打开期间把来源从 A 改到 C。
    const registry = await csvStore.load()
    const readC = await readCsvFile(fileC)
    const external = await csvStore.relink(
      sourceId,
      fileC,
      readC.summary,
      registry.revision,
    )
    expect(external).not.toBeNull()
    gate.resolve('inherit')
    await relink

    await vi.waitFor(() =>
      expect(controller.getSnapshot().csv.sources[0]!.name).toBe('c.csv'),
    )
    expect(controller.getSnapshot().csv.message).toContain('其他页面变化')
    expect(controller.getSnapshot().csv.sources[0]!.name).not.toBe('b.csv')
    expect(controller.getSnapshot().csv.sources[0]!.exclusionScopeId).toBeUndefined()
    expect((await csvStore.load()).sources[0]!.name).toBe('c.csv')
    controller.destroy()
  })

  it('沿用确认等待期间规则作用域修订变化时拒绝旧确认', async () => {
    const fileA = new CsvTestHandle('a.csv', csv(5000, 6000), 'file-a')
    const fileB = new CsvTestHandle('b.csv', csv(5000, 7000), 'file-b')
    let picked: CsvTestHandle[] = [fileA]
    const csvStore = createMemoryCsvStore()
    const exclusionStore = createMemoryExclusionStore()
    const gate = deferred<'inherit' | 'new' | 'cancel'>()
    const confirmRelink = vi.fn(() => gate.promise)
    const controller = createPlayerController({
      launch: { kind: 'csv', initialPage: 'analysis' },
      loadPlayer: vi.fn(async () => loaded()),
      createCsvStore: () => csvStore,
      canRememberCsvFiles: () => true,
      pickCsvFiles: async () => picked,
      createExclusionStore: () => exclusionStore,
      confirmRelink,
    })
    await controller.start()
    await controller.addCsvFiles()
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(2))
    const sourceId = controller.getSnapshot().csv.sources[0]!.sourceId
    const entry = controller
      .getSnapshot()
      .exclusion.entries.find((item) => item.summary.timems === 5000)!
    await controller.excludeEntries([entry.key])
    await vi.waitFor(() => expect(controller.getSnapshot().exclusion.excludedCount).toBe(1))
    const scope = (await exclusionStore.list())[0]!

    picked = [fileB]
    const relink = controller.relinkCsvSource(sourceId)
    await vi.waitFor(() => expect(confirmRelink).toHaveBeenCalled())

    const parsed = parseStatsCsv(csv(5000, 6000))
    const row = parsed.records[1]!
    const externalRule: ExclusionRule = {
      ruleId: 'rule-external',
      target: {
        kind: 'csv',
        fingerprintVersion: 1,
        fingerprint: csvFingerprint(row.canonicalRow),
        occurrence: 1,
        canonicalRow: row.canonicalRow,
        anchor: {
          recordCount: parsed.records.length,
          prefixDigest: csvSequenceDigest(parsed.records.map((record) => record.canonicalRow)),
          sameContentCount: 1,
        },
      },
      excludedAt: 2,
      summary: {
        date: null,
        level: 'b',
        timems: 6000,
        bv: 12,
        nf: false,
        state: 'c',
        videoId: null,
        sourceName: 'a.csv',
      },
    }
    const external = await exclusionStore.commit([
      {
        scopeId: scope.scopeId,
        kind: 'csv',
        owner: scope.owner,
        expectedRevision: scope.revision,
        add: [externalRule],
        remove: [],
      },
    ])
    expect(external?.changed).toBe(true)
    gate.resolve('inherit')
    await relink

    expect(controller.getSnapshot().csv.sources[0]!.name).toBe('a.csv')
    expect(controller.getSnapshot().csv.message).toContain('排除规则')
    expect((await csvStore.load()).sources[0]!.name).toBe('a.csv')
    controller.destroy()
  })

  it('确认返回后、新文件读取期间规则变化也会使旧确认失效', async () => {
    const fileA = new CsvTestHandle('a.csv', csv(5000, 6000), 'file-a')
    const fileB = new CsvTestHandle('b.csv', csv(5000, 7000), 'file-b')
    let picked: CsvTestHandle[] = [fileA]
    const csvStore = createMemoryCsvStore()
    const exclusionStore = createMemoryExclusionStore()
    const controller = createPlayerController({
      launch: { kind: 'csv', initialPage: 'analysis' },
      loadPlayer: vi.fn(async () => loaded()),
      createCsvStore: () => csvStore,
      canRememberCsvFiles: () => true,
      pickCsvFiles: async () => picked,
      createExclusionStore: () => exclusionStore,
      confirmRelink: async () => 'inherit',
    })
    await controller.start()
    await controller.addCsvFiles()
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(2))
    const sourceId = controller.getSnapshot().csv.sources[0]!.sourceId
    const entry = controller
      .getSnapshot()
      .exclusion.entries.find((item) => item.summary.timems === 5000)!
    await controller.excludeEntries([entry.key])
    await vi.waitFor(() => expect(controller.getSnapshot().exclusion.excludedCount).toBe(1))

    const gate = deferred<File>()
    fileB.gate = gate.promise
    picked = [fileB]
    const relink = controller.relinkCsvSource(sourceId)
    await vi.waitFor(() => expect(fileB.reads).toBe(1))

    const scope = (await exclusionStore.list())[0]!
    const removed = await exclusionStore.commit([
      {
        scopeId: scope.scopeId,
        kind: 'csv',
        owner: scope.owner,
        expectedRevision: scope.revision,
        add: [],
        remove: [scope.rules[0]!.ruleId],
      },
    ])
    expect(removed?.changed).toBe(true)
    gate.resolve(fileB.file())
    await relink

    expect(controller.getSnapshot().csv.sources[0]!.name).toBe('a.csv')
    expect(controller.getSnapshot().csv.message).toContain('排除规则')
    expect((await csvStore.load()).sources[0]!.name).toBe('a.csv')
    controller.destroy()
  })

  it('重新关联选择作为新来源或取消：不继承旧规则，原规则仍可重新恢复', async () => {
    const fileA = new CsvTestHandle('a.csv', csv(5000, 6000), 'file-a')
    const fileB = new CsvTestHandle('b.csv', csv(5000, 7000), 'file-b')
    let picked: CsvTestHandle[] = [fileA]
    let decision: 'inherit' | 'new' | 'cancel' = 'new'
    const exclusionStore = createMemoryExclusionStore()
    const controller = createPlayerController({
      launch: { kind: 'csv', initialPage: 'analysis' },
      loadPlayer: vi.fn(async () => loaded()),
      createCsvStore: () => createMemoryCsvStore(),
      canRememberCsvFiles: () => true,
      pickCsvFiles: async () => picked,
      createExclusionStore: () => exclusionStore,
      confirmRelink: async () => decision,
    })
    await controller.start()
    await controller.addCsvFiles()
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(2))
    const sourceId = controller.getSnapshot().csv.sources[0]!.sourceId
    const entry = controller
      .getSnapshot()
      .exclusion.entries.find((item) => item.summary.timems === 5000)!
    await controller.excludeEntries([entry.key])
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(1))
    const aScope = (await exclusionStore.list())[0]!.scopeId

    picked = [fileB]
    decision = 'cancel'
    await controller.relinkCsvSource(sourceId)
    expect(controller.getSnapshot().csv.sources[0]!.name).toBe('a.csv')
    expect(controller.getSnapshot().exclusion.excludedCount).toBe(1)

    decision = 'new'
    await controller.relinkCsvSource(sourceId)
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(2))
    expect(controller.getSnapshot().exclusion.excludedCount).toBe(0)
    expect(controller.getSnapshot().csv.sources[0]!.exclusionScopeId).toBeUndefined()
    expect((await exclusionStore.list()).map((scope) => scope.scopeId)).toEqual([aScope])

    picked = [fileA]
    await controller.relinkCsvSource(sourceId)
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(1))
    expect(controller.getSnapshot().exclusion.excludedCount).toBe(1)
    controller.destroy()
  })

  it('成功刷新推进匹配依据：唯一记录追加重复再删减后转为未匹配', async () => {
    const file = new CsvTestHandle('same.csv', csv(5000), 'same-file')
    const store = createMemoryExclusionStore()
    const controller = createPlayerController({
      launch: { kind: 'csv', initialPage: 'analysis' },
      loadPlayer: vi.fn(async () => loaded()),
      createCsvStore: () => createMemoryCsvStore(),
      canRememberCsvFiles: () => true,
      pickCsvFiles: async () => [file],
      createExclusionStore: () => store,
    })

    await controller.start()
    await controller.addCsvFiles()
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(1))
    const entry = controller.getSnapshot().exclusion.entries[0]!
    expect((await controller.excludeEntries([entry.key])).ok).toBe(true)
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(0))

    file.text = csv(5000, 5000)
    await controller.refreshCsv()
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(1))
    await vi.waitFor(async () => {
      const scopes = await store.list()
      const target = scopes[0]?.rules[0]?.target
      expect(target?.kind).toBe('csv')
      if (target?.kind !== 'csv') return
      expect(target.anchor.recordCount).toBe(2)
      expect(target.anchor.sameContentCount).toBe(2)
    })

    file.text = csv(5000)
    await controller.refreshCsv()
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(1))
    const after = controller.getSnapshot()
    expect(after.exclusion.excludedCount).toBe(0)
    expect(after.exclusion.unmatchedCount).toBe(1)
    expect(after.exclusion.unmatched[0]!.reason).toBe('ambiguous')
    controller.destroy()
  })

  it.each([
    { phase: '保持追加快照', shrinkBeforeRetry: false },
    { phase: '先刷新到歧义快照', shrinkBeforeRetry: true },
  ])('锚点写库失败后$phase：保留旧统计，重试不使用过旧依据', async ({ shrinkBeforeRetry }) => {
    const file = new CsvTestHandle('same.csv', csv(5000), 'same-file')
    const base = createMemoryExclusionStore()
    let failAnchor = true
    const store: StatisticsExclusionStore = {
      list: () => base.list(),
      get: (scopeId) => base.get(scopeId),
      commit: (mutations, isValid) => {
        if (failAnchor && mutations.some((mutation) => (mutation.update?.length ?? 0) > 0)) {
          return Promise.reject(new Error('锚点写入失败'))
        }
        return base.commit(mutations, isValid)
      },
    }
    const controller = createPlayerController({
      launch: { kind: 'csv', initialPage: 'analysis' },
      loadPlayer: vi.fn(async () => loaded()),
      createCsvStore: () => createMemoryCsvStore(),
      canRememberCsvFiles: () => true,
      pickCsvFiles: async () => [file],
      createExclusionStore: () => store,
    })

    await controller.start()
    await controller.addCsvFiles()
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(1))
    const entry = controller.getSnapshot().exclusion.entries[0]!
    expect((await controller.excludeEntries([entry.key])).ok).toBe(true)
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(0))

    file.text = csv(5000, 5000)
    await controller.refreshCsv()
    await vi.waitFor(() => expect(controller.getSnapshot().exclusion.error).toContain('匹配依据保存失败'))
    // 新快照已读取，但锚点未落库，统计仍保留上一次成功结果。
    expect(controller.getSnapshot().videos).toHaveLength(0)
    expect(controller.getSnapshot().exclusion.excludedCount).toBe(1)

    if (shrinkBeforeRetry) {
      file.text = csv(5000)
      await controller.refreshCsv()
      await vi.waitFor(() => expect(controller.getSnapshot().exclusion.error).toContain('匹配依据保存失败'))
      expect(controller.getSnapshot().videos).toHaveLength(0)
    }

    failAnchor = false
    await controller.retryExclusions()
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(1))
    expect(controller.getSnapshot().exclusion.error).toBe('')
    await vi.waitFor(async () => {
      const target = (await base.list())[0]?.rules[0]?.target
      expect(target?.kind).toBe('csv')
      if (target?.kind === 'csv') expect(target.anchor.sameContentCount).toBe(2)
    })

    file.text = csv(5000)
    await controller.refreshCsv()
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(1))
    expect(controller.getSnapshot().exclusion.excludedCount).toBe(0)
    expect(controller.getSnapshot().exclusion.unmatchedCount).toBe(1)
    expect(controller.getSnapshot().exclusion.unmatched[0]!.reason).toBe('ambiguous')
    controller.destroy()
  })

  it('延迟锚点写库期间切页或消息不泄漏未提交统计', async () => {
    const file = new CsvTestHandle('same.csv', csv(5000), 'same-file')
    const base = createMemoryExclusionStore()
    const gate = deferred<Awaited<ReturnType<typeof base.commit>>>()
    const started = deferred<void>()
    const store: StatisticsExclusionStore = {
      list: () => base.list(),
      get: (scopeId) => base.get(scopeId),
      commit: (mutations, isValid) => {
        if (mutations.some((mutation) => (mutation.update?.length ?? 0) > 0)) {
          started.resolve()
          return gate.promise.then(() => base.commit(mutations, isValid))
        }
        return base.commit(mutations, isValid)
      },
    }
    const controller = createPlayerController({
      launch: { kind: 'csv', initialPage: 'analysis' },
      loadPlayer: vi.fn(async () => loaded()),
      createCsvStore: () => createMemoryCsvStore(),
      canRememberCsvFiles: () => true,
      pickCsvFiles: async () => [file],
      createExclusionStore: () => store,
    })

    await controller.start()
    await controller.addCsvFiles()
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(1))
    const entry = controller.getSnapshot().exclusion.entries[0]!
    expect((await controller.excludeEntries([entry.key])).ok).toBe(true)
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(0))
    const before = controller.getSnapshot()
    const seen: Array<{ version: number; videos: number }> = []
    controller.subscribe((snapshot) => {
      seen.push({
        version: snapshot.dataset.contentVersion,
        videos: snapshot.videos.length,
      })
    })

    file.text = csv(5000, 5000)
    const refresh = controller.refreshCsv()
    await started.promise
    controller.setPage('score')
    controller.setMessage('正在等待锚点写库')
    const during = controller.getSnapshot()
    expect(during.videos).toHaveLength(0)
    expect(during.dataset.contentVersion).toBe(before.dataset.contentVersion)
    expect(seen.every((item) => item.videos === 0)).toBe(true)
    expect(seen.every((item) => item.version === before.dataset.contentVersion)).toBe(true)

    gate.reject(new Error('锚点写入失败'))
    await refresh
    await vi.waitFor(() => expect(controller.getSnapshot().exclusion.error).toContain('匹配依据保存失败'))
    expect(controller.getSnapshot().videos).toHaveLength(0)
    expect(controller.getSnapshot().dataset.contentVersion).toBe(before.dataset.contentVersion)
    controller.destroy()
  })

  it('外部只修改同作用域其他规则时保留待写入的重复条目依据', async () => {
    const file = new CsvTestHandle('same.csv', csv(5000), 'same-file')
    const base = createMemoryExclusionStore()
    let failAnchor = true
    const store: StatisticsExclusionStore = {
      list: () => base.list(),
      get: (scopeId) => base.get(scopeId),
      commit: (mutations, isValid) => {
        if (failAnchor && mutations.some((mutation) => (mutation.update?.length ?? 0) > 0)) {
          return Promise.reject(new Error('锚点写入失败'))
        }
        return base.commit(mutations, isValid)
      },
    }
    const controller = createPlayerController({
      launch: { kind: 'csv', initialPage: 'analysis' },
      loadPlayer: vi.fn(async () => loaded()),
      createCsvStore: () => createMemoryCsvStore(),
      canRememberCsvFiles: () => true,
      pickCsvFiles: async () => [file],
      createExclusionStore: () => store,
    })

    await controller.start()
    await controller.addCsvFiles()
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(1))
    const entry = controller.getSnapshot().exclusion.entries[0]!
    expect((await controller.excludeEntries([entry.key])).ok).toBe(true)
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(0))

    file.text = csv(5000, 5000)
    await controller.refreshCsv()
    await vi.waitFor(() => expect(controller.getSnapshot().exclusion.error).toContain('匹配依据保存失败'))

    const current = (await base.list())[0]!
    const otherRule: ExclusionRule = {
      ruleId: 'rule-other',
      target: {
        kind: 'csv',
        fingerprintVersion: 1,
        fingerprint: 'v1-other',
        occurrence: 1,
        canonicalRow: ['other'],
        anchor: { recordCount: 1, prefixDigest: 'other', sameContentCount: 1 },
      },
      excludedAt: 2,
      summary: {
        date: null,
        level: 'b',
        timems: 6000,
        bv: 12,
        nf: false,
        state: 'c',
        videoId: null,
        sourceName: 'same.csv',
      },
    }
    const external = await base.commit([
      {
        scopeId: current.scopeId,
        kind: 'csv',
        owner: current.owner,
        expectedRevision: current.revision,
        add: [otherRule],
        remove: [],
      },
    ])
    expect(external?.changed).toBe(true)
    failAnchor = false
    await controller.refreshExclusions()
    file.text = csv(5000)
    await controller.refreshCsv()
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(1))
    expect(controller.getSnapshot().exclusion.excludedCount).toBe(0)
    await vi.waitFor(async () => {
      const rules = (await base.list())[0]?.rules ?? []
      const original = rules.find((rule) => rule.ruleId !== 'rule-other')
      expect(original?.target.kind).toBe('csv')
      if (original?.target.kind === 'csv') {
        expect(original.target.anchor.sameContentCount).toBe(2)
      }
    })
    controller.destroy()
  })

  it('延迟锚点返回时不接受基于旧规则修订计算的 trial', async () => {
    const file = new CsvTestHandle('same.csv', csv(5000, 6000), 'same-file')
    const base = createMemoryExclusionStore()
    let failAnchor = true
    let delayUpdates = false
    const gate = deferred<void>()
    const anchorWritten = deferred<void>()
    const store: StatisticsExclusionStore = {
      list: () => base.list(),
      get: (scopeId) => base.get(scopeId),
      commit: (mutations, isValid) => {
        const isAnchor = mutations.some(
          (mutation) => (mutation.update?.length ?? 0) > 0,
        )
        if (isAnchor && failAnchor) {
          return Promise.reject(new Error('锚点写入失败'))
        }
        if (isAnchor && delayUpdates) {
          return base.commit(mutations, isValid).then(async (result) => {
            anchorWritten.resolve()
            await gate.promise
            return result
          })
        }
        return base.commit(mutations, isValid)
      },
    }
    const controller = createPlayerController({
      launch: { kind: 'csv', initialPage: 'analysis' },
      loadPlayer: vi.fn(async () => loaded()),
      createCsvStore: () => createMemoryCsvStore(),
      canRememberCsvFiles: () => true,
      pickCsvFiles: async () => [file],
      createExclusionStore: () => store,
    })

    await controller.start()
    await controller.addCsvFiles()
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(2))
    const first = controller
      .getSnapshot()
      .exclusion.entries.find((entry) => entry.summary.timems === 5000)!
    expect((await controller.excludeEntries([first.key])).ok).toBe(true)
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(1))

    file.text = csv(5000, 6000, 5000)
    await controller.refreshCsv()
    await vi.waitFor(() => expect(controller.getSnapshot().exclusion.error).toContain('匹配依据保存失败'))
    expect(controller.getSnapshot().videos.map((video) => video.timems)).toEqual([6000])

    failAnchor = false
    delayUpdates = true
    const retry = controller.retryExclusions()
    await anchorWritten.promise

    const parsed = parseStatsCsv(csv(5000, 6000, 5000))
    const bRow = parsed.records[1]!
    const otherRule: ExclusionRule = {
      ruleId: 'rule-other',
      target: {
        kind: 'csv',
        fingerprintVersion: 1,
        fingerprint: csvFingerprint(bRow.canonicalRow),
        occurrence: 1,
        canonicalRow: bRow.canonicalRow,
        anchor: {
          recordCount: parsed.records.length,
          prefixDigest: csvSequenceDigest(parsed.records.map((record) => record.canonicalRow)),
          sameContentCount: 1,
        },
      },
      excludedAt: 2,
      summary: {
        date: null,
        level: 'b',
        timems: 6000,
        bv: 12,
        nf: false,
        state: 'c',
        videoId: null,
        sourceName: 'same.csv',
      },
    }
    const scope = (await base.list())[0]!
    const external = await base.commit([
      {
        scopeId: scope.scopeId,
        kind: 'csv',
        owner: scope.owner,
        expectedRevision: scope.revision,
        add: [otherRule],
        remove: [],
      },
    ])
    expect(external?.changed).toBe(true)
    await controller.refreshExclusions()

    gate.resolve()
    await retry
    await vi.waitFor(() =>
      expect(controller.getSnapshot().videos.map((video) => video.timems)).toEqual([5000]),
    )
    controller.destroy()
  })

  it('切回网站后晚到的 CSV 锚点任务不能覆盖网站统计', async () => {
    const siteVideo = { ...parseStatsCsv(csv(7000)).videos[0]!, id: 101 }
    const siteLoaded: LoadedPlayer = {
      userId: 16,
      fetchedAt: 1,
      fromCache: false,
      missing: [],
      rows: [
        {
          userId: 16,
          id: 101,
          state: 'c',
          uploadTime: siteVideo.upload_time,
          ongoing: false,
          detail: siteVideo,
        },
      ],
    }
    const file = new CsvTestHandle('same.csv', csv(5000), 'same-file')
    const base = createMemoryExclusionStore()
    let failAnchor = true
    let delayUpdates = false
    const gate = deferred<void>()
    const anchorWritten = deferred<void>()
    const store: StatisticsExclusionStore = {
      list: () => base.list(),
      get: (scopeId) => base.get(scopeId),
      commit: (mutations, isValid) => {
        const isAnchor = mutations.some(
          (mutation) => (mutation.update?.length ?? 0) > 0,
        )
        if (isAnchor && failAnchor) {
          return Promise.reject(new Error('锚点写入失败'))
        }
        if (isAnchor && delayUpdates) {
          return base.commit(mutations, isValid).then(async (result) => {
            anchorWritten.resolve()
            await gate.promise
            return result
          })
        }
        return base.commit(mutations, isValid)
      },
    }
    const controller = createPlayerController({
      launch: { kind: 'site', userId: 16, initialPage: 'score', embedded: false },
      loadPlayer: vi.fn(async () => siteLoaded),
      ensureDetails: vi.fn(async () => ({ rows: [], missing: [] })),
      fetchUserInfo: vi.fn(async () => null),
      createCsvStore: () => createMemoryCsvStore(),
      createCsvSession: undefined,
      canRememberCsvFiles: () => true,
      pickCsvFiles: async () => [file],
      createExclusionStore: () => store,
      loadSiteNamespace: async () => 'https://openms.top',
    })

    await controller.start()
    await vi.waitFor(() =>
      expect(controller.getSnapshot().videos.map((video) => video.id)).toEqual([101]),
    )
    await controller.addCsvFiles()
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(1))
    const entry = controller.getSnapshot().exclusion.entries[0]!
    expect((await controller.excludeEntries([entry.key])).ok).toBe(true)
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(0))

    file.text = csv(5000, 5000)
    await controller.refreshCsv()
    await vi.waitFor(() => expect(controller.getSnapshot().exclusion.error).toContain('匹配依据保存失败'))

    controller.setSource('site')
    await vi.waitFor(() =>
      expect(controller.getSnapshot().videos.map((video) => video.id)).toEqual([101]),
    )
    const siteSnapshot = controller.getSnapshot()
    expect(siteSnapshot.dataset.source).toBe('site')
    expect(siteSnapshot.exclusion.error).toBe('')

    failAnchor = false
    delayUpdates = true
    const reenter = controller.enterCsvSource()
    await anchorWritten.promise
    controller.setSource('site')
    await vi.waitFor(() =>
      expect(controller.getSnapshot().videos.map((video) => video.id)).toEqual([101]),
    )
    const beforeLate = controller.getSnapshot()
    gate.resolve()
    await reenter
    await new Promise((resolve) => setTimeout(resolve, 10))
    const afterLate = controller.getSnapshot()
    expect(afterLate.source).toBe('site')
    expect(afterLate.dataset.source).toBe('site')
    expect(afterLate.videos.map((video) => video.id)).toEqual([101])
    expect(afterLate.dataset.contentVersion).toBe(beforeLate.dataset.contentVersion)
    expect(afterLate.exclusion.error).toBe('')
    controller.destroy()
  })

  it('外部删除并恢复原规则时不复活本页待写入的锚点', async () => {
    const file = new CsvTestHandle('same.csv', csv(5000), 'same-file')
    const base = createMemoryExclusionStore()
    let failAnchor = true
    const store: StatisticsExclusionStore = {
      list: () => base.list(),
      get: (scopeId) => base.get(scopeId),
      commit: (mutations, isValid) => {
        if (failAnchor && mutations.some((mutation) => (mutation.update?.length ?? 0) > 0)) {
          return Promise.reject(new Error('锚点写入失败'))
        }
        return base.commit(mutations, isValid)
      },
    }
    const controller = createPlayerController({
      launch: { kind: 'csv', initialPage: 'analysis' },
      loadPlayer: vi.fn(async () => loaded()),
      createCsvStore: () => createMemoryCsvStore(),
      canRememberCsvFiles: () => true,
      pickCsvFiles: async () => [file],
      createExclusionStore: () => store,
    })

    await controller.start()
    await controller.addCsvFiles()
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(1))
    const entry = controller.getSnapshot().exclusion.entries[0]!
    expect((await controller.excludeEntries([entry.key])).ok).toBe(true)
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(0))

    file.text = csv(5000, 5000)
    await controller.refreshCsv()
    await vi.waitFor(() => expect(controller.getSnapshot().exclusion.error).toContain('匹配依据保存失败'))

    const current = (await base.list())[0]!
    const originalRule = current.rules[0]!
    const removed = await base.commit([
      {
        scopeId: current.scopeId,
        kind: 'csv',
        owner: current.owner,
        expectedRevision: current.revision,
        add: [],
        remove: [originalRule.ruleId],
      },
    ])
    expect(removed?.changed).toBe(true)
    await controller.refreshExclusions()
    const restored = await base.commit([
      {
        scopeId: current.scopeId,
        kind: 'csv',
        owner: current.owner,
        expectedRevision: removed!.scopes[0]!.revision,
        add: [originalRule],
        remove: [],
      },
    ])
    expect(restored?.changed).toBe(true)
    await controller.refreshExclusions()

    failAnchor = false
    file.text = csv(5000)
    await controller.refreshCsv()
    await vi.waitFor(() => expect(controller.getSnapshot().exclusion.error).toBe(''))
    // 外部先删除再恢复的是原规则/原依据，本页待写入的“两条同内容”锚点不能复活。
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(0))
    expect(controller.getSnapshot().exclusion.excludedCount).toBe(1)
    const finalTarget = (await base.list())[0]?.rules[0]?.target
    expect(finalTarget?.kind).toBe('csv')
    if (finalTarget?.kind === 'csv') {
      expect(finalTarget.anchor.sameContentCount).toBe(1)
    }
    controller.destroy()
  })

  it('晚到的焦点检查不能回退已推进的规则修订', async () => {
    const file = new CsvTestHandle('same.csv', csv(5000), 'same-file')
    const base = createMemoryExclusionStore()
    let captureRead = false
    let listStarted: (() => void) | null = null
    let staleList: ExclusionScopeRecord[] | null = null
    const staleRead: {
      resolve: ((scopes: Awaited<ReturnType<typeof base.list>>) => void) | null
    } = { resolve: null }
    const store: StatisticsExclusionStore = {
      list: () => {
        if (staleList) {
          const scopes = staleList
          staleList = null
          return Promise.resolve(scopes)
        }
        if (!captureRead) return base.list()
        captureRead = false
        listStarted?.()
        return new Promise((resolve) => {
          staleRead.resolve = resolve
        })
      },
      get: (scopeId) => base.get(scopeId),
      commit: (mutations, isValid) => base.commit(mutations, isValid),
    }
    const controller = createPlayerController({
      launch: { kind: 'csv', initialPage: 'analysis' },
      loadPlayer: vi.fn(async () => loaded()),
      createCsvStore: () => createMemoryCsvStore(),
      canRememberCsvFiles: () => true,
      pickCsvFiles: async () => [file],
      createExclusionStore: () => store,
    })

    await controller.start()
    await controller.addCsvFiles()
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(1))
    const entry = controller.getSnapshot().exclusion.entries[0]!
    expect((await controller.excludeEntries([entry.key])).ok).toBe(true)
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(0))
    const oldScopes = await base.list()

    captureRead = true
    const started = deferred<void>()
    listStarted = started.resolve
    const focusCheck = controller.refreshExclusions()
    await started.promise

    file.text = csv(5000, 5000)
    await controller.refreshCsv()
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(1))
    await vi.waitFor(async () => {
      const target = (await base.list())[0]?.rules[0]?.target
      expect(target?.kind).toBe('csv')
      if (target?.kind === 'csv') expect(target.anchor.sameContentCount).toBe(2)
    })

    staleRead.resolve?.(oldScopes)
    await focusCheck

    // 即使晚到的读取获得新的请求序号，也不能用更低修订覆盖已提交的锚点。
    staleList = oldScopes
    await controller.refreshExclusions()

    file.text = csv(5000)
    await controller.refreshCsv()
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(1))
    expect(controller.getSnapshot().exclusion.excludedCount).toBe(0)
    expect(controller.getSnapshot().exclusion.unmatchedCount).toBe(1)
    expect(controller.getSnapshot().exclusion.unmatched[0]!.reason).toBe('ambiguous')
    controller.destroy()
  })

  it('刷新后旧勾选不能提交到改变了的重复条目', async () => {
    const file = new CsvTestHandle('same.csv', csv(5000, 5000), 'same-file')
    const store = createMemoryExclusionStore()
    const controller = createPlayerController({
      launch: { kind: 'csv', initialPage: 'analysis' },
      loadPlayer: vi.fn(async () => loaded()),
      createCsvStore: () => createMemoryCsvStore(),
      canRememberCsvFiles: () => true,
      pickCsvFiles: async () => [file],
      createExclusionStore: () => store,
    })

    await controller.start()
    await controller.addCsvFiles()
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(2))
    const before = controller.getSnapshot()
    const oldKey = before.exclusion.entries[0]!.key
    const oldSnapshotKey = before.exclusion.snapshotKey

    file.text = csv(5000)
    await controller.refreshCsv()
    await vi.waitFor(() => expect(controller.getSnapshot().videos).toHaveLength(1))
    const after = controller.getSnapshot()
    expect(after.exclusion.entries[0]!.key).toBe(oldKey)
    const rejected = await controller.excludeEntries([oldKey], oldSnapshotKey)
    expect(rejected.ok).toBe(false)
    expect(rejected.message).toContain('数据已刷新')
    expect(controller.getSnapshot().exclusion.excludedCount).toBe(0)
    expect(await store.list()).toEqual([])
    controller.destroy()
  })

  it('保存失败时保留原统计和原规则', async () => {
    let fail = true
    const memory = createMemoryExclusionStore()
    const store: StatisticsExclusionStore = {
      list: () => memory.list(),
      get: (scopeId) => memory.get(scopeId),
      commit: (mutations, isValid) =>
        (fail ? Promise.reject(new Error('写入失败')) : memory.commit(mutations, isValid)),
    }
    const view = harness(fakeSession(), { store, loaded: detailRows() })
    void view.controller.start()
    await vi.waitFor(() => expect(view.load).toHaveBeenCalled())
    view.finishLoad()
    await vi.waitFor(() => expect(view.controller.getSnapshot().videos).toHaveLength(2))
    const before = view.controller.getSnapshot()
    const entry = before.exclusion.entries[0]!

    const result = await view.controller.excludeEntries([entry.key])
    expect(result.ok).toBe(false)
    const after = view.controller.getSnapshot()
    expect(after.videos).toHaveLength(2)
    expect(after.exclusion.excludedCount).toBe(0)
    expect(after.dataset.contentVersion).toBe(before.dataset.contentVersion)
    expect((await memory.list())).toEqual([])

    fail = false
    const retried = await view.controller.excludeEntries([entry.key])
    expect(retried.ok).toBe(true)
    await vi.waitFor(() => expect(view.controller.getSnapshot().videos).toHaveLength(1))
    view.controller.destroy()
  })
})
