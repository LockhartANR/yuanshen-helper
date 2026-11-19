import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDb } from '../src/shared/db'
import {
  buildCsvSnapshot,
  createIndexedDbCsvStore,
} from '../src/features/player-stats/csv-sources'
import type {
  CsvFileHandle,
  CsvLoadedSource,
  CsvSourceStore,
} from '../src/features/player-stats/csv-sources'
import { parseStatsCsv } from '../src/features/player-stats/csv'
import {
  buildCsvExclusionEntries,
  createCsvRuleFromEntries,
  csvScopeIdForSource,
} from '../src/features/player-stats/statistics-exclusion'
import { createIndexedDbExclusionStore } from '../src/features/player-stats/statistics-exclusion-store'
import { createPlayerController } from '../src/features/player-stats/player-controller'
import type {
  CsvRepairDecision,
  CsvRepairPick,
  CsvRepairTarget,
  PlayerControllerOptions,
} from '../src/features/player-stats/player-controller'
import { CsvTestHandle, csv } from './helpers/stats-csv'

const SOURCE_ID = 'csv-src-repair'
const SOURCE_REVISION = 2
const SCOPE_ID = csvScopeIdForSource(SOURCE_ID, SOURCE_REVISION)

async function clearStores(): Promise<void> {
  const db = await getDb()
  await db.clear('csvSources')
  await db.clear('csvSourceMeta')
  await db.clear('csvHandles')
  await db.clear('statExclusions')
}

beforeEach(clearStores)

/**
 * fake-indexeddb 不能保存真实句柄上的方法，恢复出的句柄会失去 getFile。
 * 用活动句柄表模拟浏览器“句柄仍然可用”的行为，其余逻辑仍走真实的 IndexedDB 存储。
 */
function storeWithLiveHandles(): {
  store: CsvSourceStore
  live: Map<string, CsvFileHandle>
} {
  const base = createIndexedDbCsvStore()
  const live = new Map<string, CsvFileHandle>()
  const store: CsvSourceStore = {
    ...base,
    async handles() {
      const stored = await base.handles()
      for (const [sourceId, handle] of live) {
        if (stored.has(sourceId)) stored.set(sourceId, handle)
      }
      return stored
    },
  }
  return { store, live }
}

/** 模拟浏览器拒绝再次序列化失效句柄：写回仍带 legacy 句柄的作用域时失败。 */
function failLegacyScopeWrites(): () => void {
  const proto = IDBObjectStore.prototype as unknown as {
    put: (this: IDBObjectStore, value: unknown, key?: IDBValidKey) => IDBRequest
  }
  const original = proto.put
  proto.put = function (value: unknown, key?: IDBValidKey) {
    const scope = value as {
      owner?: { handle?: { legacy?: boolean } }
    }
    if (this.name === 'statExclusions' && scope?.owner?.handle?.legacy) {
      throw new DOMException('Failed to write blobs', 'DataCloneError')
    }
    return key === undefined ? original.call(this, value) : original.call(this, value, key)
  }
  return () => {
    proto.put = original
  }
}

interface Seeded {
  readonlyHandle: CsvFileHandle
  ruleId: string
}

/** 旧库状态：来源存在但句柄失效，作用域里的规则仍引用那个失效句柄。 */
async function seedBrokenSource(): Promise<Seeded> {
  const db = await getDb()
  const parsed = parseStatsCsv(csv(5000, 6000))
  const loaded: CsvLoadedSource = {
    sourceId: SOURCE_ID,
    sourceRevision: SOURCE_REVISION,
    name: '旧成绩.csv',
    videos: parsed.videos,
    records: parsed.records,
    summary: {
      readAt: 1,
      validCount: 2,
      totalRows: 2,
      invalidRows: 0,
      size: 10,
      lastModified: 1,
    },
  }
  const videos = buildCsvSnapshot([loaded])
  const entries = buildCsvExclusionEntries([loaded], videos, new Map([[SOURCE_ID, SCOPE_ID]]))
  const target = entries.find((entry) => entry.summary.timems === 5000)!
  const rule = createCsvRuleFromEntries(SCOPE_ID, entries, target, 1)
  // 旧句柄：真实浏览器里已无法再次写入，测试用标记模拟。
  const readonlyHandle = { name: '旧成绩.csv', legacy: true } as unknown as CsvFileHandle
  await db.put('statExclusions', {
    scopeId: SCOPE_ID,
    kind: 'csv' as const,
    revision: 1,
    owner: { kind: 'csv' as const, name: '旧成绩.csv', handle: readonlyHandle, sourceId: SOURCE_ID },
    rules: [rule],
  })
  await db.put('csvSourceMeta', {
    id: 'current',
    revision: 3,
    sources: [
      {
        sourceId: SOURCE_ID,
        name: '旧成绩.csv',
        addedAt: 1,
        revision: SOURCE_REVISION,
        lastSuccess: null,
      },
    ],
  })
  return { readonlyHandle, ruleId: rule.ruleId }
}

function makeController(options: {
  store: CsvSourceStore
  handle: CsvTestHandle
  confirmRepair: NonNullable<PlayerControllerOptions['confirmRepair']>
}) {
  return createPlayerController({
    launch: { kind: 'csv', initialPage: 'analysis' },
    loadPlayer: vi.fn(async () => {
      throw new Error('CSV 模式不应读取网站数据')
    }),
    createCsvStore: () => options.store,
    canRememberCsvFiles: () => true,
    pickCsvFiles: async () => [options.handle],
    createExclusionStore: () => createIndexedDbExclusionStore(),
    loadSiteNamespace: async () => 'https://openms.top',
    confirmRepair: options.confirmRepair,
  })
}

/** 共用的起始状态：旧库来源缺句柄，规则仍挂失效句柄；修复时选择沿用。 */
async function openRepaired() {
  const seeded = await seedBrokenSource()
  const restorePut = failLegacyScopeWrites()
  const { store, live } = storeWithLiveHandles()
  const handle = new CsvTestHandle('新成绩.csv', csv(5000, 6000))
  live.set(SOURCE_ID, handle)
  const confirmRepair = vi.fn(
    async (
      targets: readonly CsvRepairTarget[],
      pick: (sourceId: string) => Promise<CsvRepairPick | null>,
    ): Promise<CsvRepairDecision[]> => {
      expect(targets).toEqual([
        { sourceId: SOURCE_ID, sourceName: '旧成绩.csv', ruleCount: 1 },
      ])
      const picked = await pick(SOURCE_ID)
      expect(picked?.handle.name).toBe('新成绩.csv')
      return [{ sourceId: SOURCE_ID, mode: 'inherit' }]
    },
  )
  const controller = makeController({ store, handle, confirmRepair })
  await controller.start()
  await vi.waitFor(() =>
    expect(controller.getSnapshot().csv.problemSources).toEqual([SOURCE_ID]),
  )
  await controller.repairCsvSources()
  return { seeded, store, handle, controller, confirmRepair, restorePut }
}

describe('CSV 修复关联与排除规则的文件身份', () => {
  it('沿用规则时在同一事务里把作用域句柄换成新文件', async () => {
    const opened = await openRepaired()
    try {
      await vi.waitFor(async () => {
        const scope = await createIndexedDbExclusionStore().get(SCOPE_ID)
        expect(scope?.revision).toBe(2)
      })
      const scope = await createIndexedDbExclusionStore().get(SCOPE_ID)
      // 规则目标与锚点保持不变，只有文件身份和修订号变化。
      expect(scope?.rules.map((rule) => rule.ruleId)).toEqual([opened.seeded.ruleId])
      expect(scope?.owner.kind).toBe('csv')
      if (scope?.owner.kind === 'csv') {
        expect(scope.owner.name).toBe('新成绩.csv')
        expect(scope.owner.sourceId).toBe(SOURCE_ID)
        expect(
          (scope.owner.handle as unknown as { legacy?: boolean } | undefined)?.legacy,
        ).toBeUndefined()
      }
      expect(opened.controller.getSnapshot().csv.message).toContain('已修复 1 个文件关联')
      expect(opened.controller.getSnapshot().csv.problemSources).toEqual([])
    } finally {
      opened.controller.destroy()
      opened.restorePut()
    }
  })

  it('修复后追加记录仍能推进锚点，重开页面也能刷新', async () => {
    const opened = await openRepaired()
    const { controller, handle, store, restorePut } = opened
    try {
      await controller.refreshCsv()
      await vi.waitFor(() => expect(controller.getSnapshot().exclusion.excludedCount).toBe(1))
      expect(controller.getSnapshot().videos.map((video) => video.timems)).toEqual([6000])

      // 文件追加记录后刷新：推进锚点会写回整个作用域，不能再用失效句柄。
      handle.text = csv(5000, 6000, 7000)
      await controller.refreshCsv()
      await vi.waitFor(() =>
        expect(controller.getSnapshot().videos.map((video) => video.timems)).toEqual([
          6000,
          7000,
        ]),
      )
      expect(controller.getSnapshot().exclusion.excludedCount).toBe(1)
      expect(controller.getSnapshot().exclusion.error).toBe('')

      // 锚点推进与句柄替换都持久化，作用域修订号继续增长。
      const scope = await createIndexedDbExclusionStore().get(SCOPE_ID)
      expect(scope?.revision).toBeGreaterThanOrEqual(2)
      expect(
        (scope?.owner.kind === 'csv' ? scope.owner.handle : undefined) as unknown as
          | { legacy?: boolean }
          | undefined,
      ).not.toMatchObject({ legacy: true })
      controller.destroy()

      // 重开页面：句柄、绑定和规则都持久化，仍能刷新并保持排除。
      const reopenedConfirm = vi.fn(async () => 'cancel' as const)
      const reopened = makeController({ store, handle, confirmRepair: reopenedConfirm })
      await reopened.start()
      await reopened.refreshCsv()
      await vi.waitFor(() =>
        expect(reopened.getSnapshot().videos.map((video) => video.timems)).toEqual([
          6000,
          7000,
        ]),
      )
      expect(reopened.getSnapshot().exclusion.excludedCount).toBe(1)
      expect(reopened.getSnapshot().exclusion.error).toBe('')
      expect(reopened.getSnapshot().csv.problemSources).toEqual([])
      expect(reopenedConfirm).not.toHaveBeenCalled()
      reopened.destroy()
    } finally {
      restorePut()
    }
  })
})
