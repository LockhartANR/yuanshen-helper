import { describe, expect, it, vi } from 'vitest'
import type { PlayerVideoRow } from '../src/shared/db'
import { createPlayerController } from '../src/features/player-stats/player-controller'
import type { CsvSession, CsvSessionState } from '../src/features/player-stats/csv-session'
import { createMemoryCsvStore } from '../src/features/player-stats/csv-sources'
import type { LoadedPlayer } from '../src/features/player-stats/service'
import { deferred } from './helpers/stats-csv'

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

function harness(session = fakeSession()) {
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
  })
  return {
    controller, session, load,
    finishLoad: () => pending.resolve({
      userId: 16, rows: [row(1)], fetchedAt: 1, fromCache: false, missing: [],
    }),
  }
}

describe('玩家页面控制器：竞态与销毁', () => {
  it('切到 CSV 后晚到的网站结果不写回旧来源', async () => {
    const view = harness()
    void view.controller.start()
    view.controller.setSource('csv')
    view.finishLoad()
    await Promise.resolve()
    await Promise.resolve()
    const snapshot = view.controller.getSnapshot()
    expect(snapshot.source).toBe('csv')
    expect(snapshot.rows).toEqual([])
    expect(snapshot.updatedAt).toBe(0)
    expect(snapshot.dataset.source).toBe('csv')
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
