import { describe, expect, it, vi } from 'vitest'
import { createCsvSession } from '../src/features/player-stats/csv-session'
import type { CsvSession, CsvSessionOptions } from '../src/features/player-stats/csv-session'
import {
  createCsvSourceId,
  createMemoryCsvStore,
  readCsvFile,
} from '../src/features/player-stats/csv-sources'
import type {
  CsvSourceRegistry,
  CsvSourceStore,
} from '../src/features/player-stats/csv-sources'

import { CsvTestHandle as FakeHandle, csv, deferred } from './helpers/stats-csv'

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

async function associate(
  store: CsvSourceStore,
  handle: FakeHandle,
): Promise<CsvSourceRegistry> {
  const read = await readCsvFile(handle)
  const registry = await store.load()
  const next = await store.addMany(
    [{ sourceId: createCsvSourceId(), handle, summary: read.summary }],
    registry.revision,
  )
  if (!next) throw new Error('associate failed')
  return next
}

let clock = 1_000

function create(
  store: CsvSourceStore = createMemoryCsvStore(),
  overrides: Partial<CsvSessionOptions> = {},
): { session: CsvSession; store: CsvSourceStore; changes: ReturnType<typeof vi.fn> } {
  const changes = vi.fn()
  const session = createCsvSession({
    store,
    onChange: changes,
    now: () => {
      clock += 1
      return clock
    },
    ...overrides,
  })
  return { session, store, changes }
}

describe('恢复关联清单', () => {
  it('只恢复清单与摘要，不读取文件也不请求授权', async () => {
    const store = createMemoryCsvStore()
    const handle = new FakeHandle('a.csv', csv(5000))
    await associate(store, handle)
    const { session } = create(store)

    await session.restore()
    expect(session.state.ready).toBe(true)
    expect(session.state.sources).toHaveLength(1)
    expect(session.state.loaded.size).toBe(0)
    expect(session.hasSnapshot()).toBe(false)
    expect(handle.reads).toBe(1)
    const sourceId = session.state.sources[0]!.sourceId
    expect(session.sourceSummary(sourceId)).toMatchObject({ validCount: 1 })
    expect(session.videos()).toEqual([])
  })

  it('数据库读取失败时给出提示并保持空清单', async () => {
    const store = createMemoryCsvStore()
    const failing: CsvSourceStore = {
      ...store,
      load: async () => {
        throw new Error('db down')
      },
    }
    const { session } = create(failing)
    await session.restore()
    expect(session.state.ready).toBe(true)
    expect(session.state.sources).toEqual([])
    expect(session.state.message).toContain('db down')
  })
})

describe('整批刷新', () => {
  it('读取全部文件并生成连续编号的完整快照', async () => {
    const store = createMemoryCsvStore()
    const first = new FakeHandle('a.csv', csv(5000, 6000))
    const second = new FakeHandle('b.csv', csv(7000))
    await associate(store, first)
    await associate(store, second)
    const { session } = create(store)
    await session.restore()

    await session.refreshAll()
    expect(session.hasSnapshot()).toBe(true)
    expect(session.videos().map((video) => video.id)).toEqual([-1, -2, -3])
    expect(session.videos().map((video) => video.importOrder)).toEqual([0, 1, 2])
    expect(session.loadedCount()).toBe(3)
    expect(session.state.deltas.size).toBe(2)
    expect(session.state.message).toBe('刷新完成：2 个文件，局数未变（3 局）。')
    const registry = await store.load()
    expect(registry.sources.map((source) => source.lastSuccess?.validCount)).toEqual([2, 1])
  })

  it('再次刷新显示逐文件和整批局数变化', async () => {
    const store = createMemoryCsvStore()
    const first = new FakeHandle('a.csv', csv(5000, 6000))
    const second = new FakeHandle('b.csv', csv(7000))
    await associate(store, first)
    await associate(store, second)
    const { session } = create(store)
    await session.restore()
    await session.refreshAll()

    first.text = csv(5000, 6000, 8000)
    await session.refreshAll()
    expect(session.state.message).toContain('3 → 4 局')
    expect(session.state.message).toContain('a.csv 2 → 3 局')
    expect(session.state.deltas.get(session.state.sources[0]!.sourceId)).toEqual({
      before: 2,
      after: 3,
    })
    expect(session.videos()).toHaveLength(4)

    const previousTime = session.state.sources[0]!.lastSuccess!.readAt
    await session.refreshAll()
    expect(session.state.message).toContain('局数未变')
    expect(session.state.sources[0]!.lastSuccess!.readAt).toBeGreaterThan(previousTime)
  })

  it('同名覆盖或条目减少时整体替换，不拼接旧内容', async () => {
    const store = createMemoryCsvStore()
    const first = new FakeHandle('a.csv', csv(5000, 6000, 7000))
    await associate(store, first)
    const { session } = create(store)
    await session.restore()
    await session.refreshAll()
    expect(session.videos()).toHaveLength(3)

    first.text = csv(9000)
    await session.refreshAll()
    expect(session.videos()).toHaveLength(1)
    expect(session.videos()[0]!.timems).toBe(9000)
    expect(session.state.message).toContain('3 → 1 局')
  })

  it('单个文件失败时整批不提交，旧快照和成功摘要都保留', async () => {
    const store = createMemoryCsvStore()
    const first = new FakeHandle('a.csv', csv(5000))
    const second = new FakeHandle('b.csv', csv(6000))
    await associate(store, first)
    await associate(store, second)
    const { session } = create(store)
    await session.restore()
    await session.refreshAll()
    const before = await store.load()

    second.text = 'broken'
    await session.refreshAll()
    expect(session.state.message).toContain('刷新失败')
    expect(session.state.message).toContain('b.csv')
    expect(session.state.message).toContain('已保留上次成功结果')
    expect(session.videos()).toHaveLength(2)
    expect(session.state.loading).toBe(false)
    const after = await store.load()
    expect(after.sources.map((source) => source.lastSuccess)).toEqual(
      before.sources.map((source) => source.lastSuccess),
    )
  })

  it('正确表头 0 行是成功的 0 局来源，其他文件照常汇总', async () => {
    const store = createMemoryCsvStore()
    const empty = new FakeHandle('empty.csv', csv())
    const first = new FakeHandle('a.csv', csv(5000))
    await associate(store, empty)
    await associate(store, first)
    const { session } = create(store)
    await session.restore()
    await session.refreshAll()
    expect(session.videos()).toHaveLength(1)
    expect(session.state.message).toContain('刷新完成')
    expect((await store.load()).sources[0]!.lastSuccess).toMatchObject({ validCount: 0 })
  })
})

describe('权限与授权', () => {
  it('需要授权时不读取文件，逐行提供授权后再刷新', async () => {
    const store = createMemoryCsvStore()
    const first = new FakeHandle('a.csv', csv(5000))
    first.permission = 'prompt'
    await associate(store, first)
    const { session } = create(store)
    await session.restore()
    first.reads = 0

    await session.refreshAll()
    expect(first.reads).toBe(0)
    expect(session.state.needsPermission).toHaveLength(1)
    expect(session.state.message).toContain('需要授权读取')
    expect(session.hasSnapshot()).toBe(false)

    await session.grant(session.state.sources[0]!.sourceId)
    expect(session.state.needsPermission).toEqual([])
    expect(session.state.message).toContain('所有文件已授权')

    await session.refreshAll()
    expect(first.reads).toBe(1)
    expect(session.videos()).toHaveLength(1)
  })

  it('拒绝授权时保留关联并提示未获得权限', async () => {
    const store = createMemoryCsvStore()
    const first = new FakeHandle('a.csv', csv(5000))
    first.permission = 'prompt'
    first.requestResult = 'denied'
    await associate(store, first)
    const { session } = create(store)
    await session.restore()
    await session.grant(session.state.sources[0]!.sourceId)
    expect(session.state.message).toContain('未获得 a.csv 的读取权限')
    expect(session.state.sources).toHaveLength(1)
  })
})

describe('添加、重新关联与移除', () => {
  it('首次添加先校验再保存，有效文件立即汇总，失败文件不进清单', async () => {
    const store = createMemoryCsvStore()
    const { session } = create(store)
    await session.restore()
    const valid = new FakeHandle('a.csv', csv(5000, 6000))
    const invalid = new FakeHandle('bad.csv', 'bad')

    await session.addFiles([valid, invalid])
    expect(session.state.sources.map((source) => source.name)).toEqual(['a.csv'])
    expect(session.hasSnapshot()).toBe(true)
    expect(session.videos()).toHaveLength(2)
    expect(session.state.message).toContain('已添加 1 个文件（2 局）')
    expect(session.state.message).toContain('bad.csv')
    expect((await store.load()).sources).toHaveLength(1)
  })

  it('同一文件不能重复关联，提示使用刷新', async () => {
    const store = createMemoryCsvStore()
    const { session } = create(store)
    await session.restore()
    const handle = new FakeHandle('a.csv', csv(5000))
    await session.addFiles([handle])
    await session.addFiles([new FakeHandle('a-copy.csv', csv(6000), handle.key)])
    expect(session.state.sources).toHaveLength(1)
    expect(session.state.message).toContain('已在关联清单中，更新请点「刷新」')
  })

  it('不同目录的同名文件是独立来源', async () => {
    const store = createMemoryCsvStore()
    const { session } = create(store)
    await session.restore()
    await session.addFiles([
      new FakeHandle('stats.csv', csv(5000), 'dir-1'),
      new FakeHandle('stats.csv', csv(6000), 'dir-2'),
    ])
    expect(session.state.sources).toHaveLength(2)
    expect(session.state.sources.map((source) => source.name)).toEqual([
      'stats.csv',
      'stats.csv',
    ])
    expect(session.videos()).toHaveLength(2)
  })

  it('恢复清单后添加文件不冒充完整快照', async () => {
    const store = createMemoryCsvStore()
    const existing = new FakeHandle('a.csv', csv(5000))
    await associate(store, existing)
    const { session } = create(store)
    await session.restore()

    const added = new FakeHandle('b.csv', csv(6000))
    await session.addFiles([added])
    expect(session.state.sources).toHaveLength(2)
    expect(session.hasSnapshot()).toBe(false)
    expect(session.videos()).toEqual([])
    expect(session.state.message).toContain('点击「刷新」加载全部成绩')

    await session.refreshAll()
    expect(session.videos()).toHaveLength(2)
  })

  it('重新关联替换指定来源并保持顺序，其他来源不变', async () => {
    const store = createMemoryCsvStore()
    const first = new FakeHandle('a.csv', csv(5000))
    const second = new FakeHandle('b.csv', csv(6000))
    await associate(store, first)
    await associate(store, second)
    const { session } = create(store)
    await session.restore()
    await session.refreshAll()
    const secondId = session.state.sources[1]!.sourceId

    const replacement = new FakeHandle('c.csv', csv(7000, 8000))
    await session.relink(secondId, replacement)
    expect(session.state.sources.map((source) => source.name)).toEqual(['a.csv', 'c.csv'])
    expect(session.state.sources[1]!.sourceId).toBe(secondId)
    expect(session.videos()).toHaveLength(3)
    expect(session.state.message).toContain('已重新关联 c.csv')
    expect((await store.load()).sources[1]!.handle.name).toBe('c.csv')
  })

  it('重新关联不能绑定到已关联的另一来源', async () => {
    const store = createMemoryCsvStore()
    const first = new FakeHandle('a.csv', csv(5000))
    const second = new FakeHandle('b.csv', csv(6000))
    await associate(store, first)
    await associate(store, second)
    const { session } = create(store)
    await session.restore()
    const secondId = session.state.sources[1]!.sourceId

    await session.relink(secondId, new FakeHandle('a-copy.csv', csv(9000), first.key))
    expect(session.state.sources[1]!.name).toBe('b.csv')
    expect(session.state.message).toContain('不能重复绑定')
  })

  it('重新关联读取失败时原来源与句柄保持不变', async () => {
    const store = createMemoryCsvStore()
    const first = new FakeHandle('a.csv', csv(5000))
    await associate(store, first)
    const { session } = create(store)
    await session.restore()
    await session.refreshAll()

    await session.relink(
      session.state.sources[0]!.sourceId,
      new FakeHandle('bad.csv', 'bad'),
    )
    expect(session.state.sources[0]!.name).toBe('a.csv')
    expect(session.state.message).toContain('重新关联失败')
    expect((await store.load()).sources[0]!.handle.name).toBe('a.csv')
    expect(session.videos()).toHaveLength(1)
  })

  it('移除来源后按剩余文件重新汇总，全部移除后清空', async () => {
    const store = createMemoryCsvStore()
    const first = new FakeHandle('a.csv', csv(5000))
    const second = new FakeHandle('b.csv', csv(6000))
    await associate(store, first)
    await associate(store, second)
    const { session } = create(store)
    await session.restore()
    await session.refreshAll()

    await session.removeSource(session.state.sources[0]!.sourceId)
    expect(session.state.sources.map((source) => source.name)).toEqual(['b.csv'])
    expect(session.videos()).toHaveLength(1)
    expect(session.state.message).toContain('已移除 a.csv')

    await session.removeSource(session.state.sources[0]!.sourceId)
    expect(session.state.sources).toEqual([])
    expect(session.videos()).toEqual([])
    expect((await store.load()).sources).toEqual([])
  })
})

describe('取消、竞态与多页面', () => {
  it('取消后晚到的读取不提交，旧快照保留', async () => {
    const store = createMemoryCsvStore()
    const first = new FakeHandle('a.csv', csv(5000))
    await associate(store, first)
    const { session } = create(store)
    await session.restore()
    await session.refreshAll()

    const gate = deferred<File>()
    first.gate = gate.promise
    first.reads = 0
    const pending = session.refreshAll()
    await vi.waitFor(() => expect(first.reads).toBe(1))

    session.cancel()
    expect(session.state.loading).toBe(false)
    expect(session.state.message).toContain('已取消读取')
    gate.resolve(first.file())
    await pending
    await flush()
    expect(session.videos()).toHaveLength(1)
    expect((await store.load()).sources[0]!.lastSuccess?.readAt).toBe(
      session.state.sources[0]!.lastSuccess?.readAt,
    )
  })

  it('移除全部使进行中的批次失效且不会被复活', async () => {
    const store = createMemoryCsvStore()
    const first = new FakeHandle('a.csv', csv(5000))
    await associate(store, first)
    const { session } = create(store)
    await session.restore()
    await session.refreshAll()

    const gate = deferred<File>()
    first.gate = gate.promise
    first.reads = 0
    const pending = session.refreshAll()
    await vi.waitFor(() => expect(first.reads).toBe(1))

    await session.removeAll()
    expect(session.state.sources).toEqual([])
    gate.resolve(first.file())
    await pending
    await flush()
    expect(session.state.sources).toEqual([])
    expect(session.videos()).toEqual([])
    expect((await store.load()).sources).toEqual([])
  })

  it('其他页面在刷新期间改清单时版本冲突不覆盖', async () => {
    const store = createMemoryCsvStore()
    const first = new FakeHandle('a.csv', csv(5000))
    await associate(store, first)
    const { session } = create(store)
    await session.restore()

    const gate = deferred<File>()
    first.gate = gate.promise
    const pending = session.refreshAll()
    await vi.waitFor(() => expect(first.reads).toBe(1))

    await associate(store, new FakeHandle('c.csv', csv(6000)))
    gate.resolve(first.file())
    await pending
    await flush()

    expect(session.state.message).toContain('关联清单已在其他页面变化')
    expect(session.state.sources.map((source) => source.name)).toEqual(['a.csv', 'c.csv'])
    expect(session.hasSnapshot()).toBe(false)
    const stored = await store.load()
    expect(stored.sources[1]!.lastSuccess).toMatchObject({ validCount: 1 })
    expect(stored.sources[0]!.lastSuccess?.readAt).toBe(
      session.state.sources[0]!.lastSuccess?.readAt,
    )
  })

  it('重获焦点时发现清单变化并提示刷新，不把移除来源算回来', async () => {
    const store = createMemoryCsvStore()
    const first = new FakeHandle('a.csv', csv(5000))
    const second = new FakeHandle('b.csv', csv(6000))
    await associate(store, first)
    await associate(store, second)
    const { session } = create(store)
    await session.restore()
    await session.refreshAll()

    await store.remove(session.state.sources[1]!.sourceId)
    await session.checkRegistry()
    expect(session.state.message).toContain('关联清单已在其他页面变化')
    expect(session.state.sources.map((source) => source.name)).toEqual(['a.csv'])
    expect(session.videos()).toHaveLength(1)
  })

  it('销毁页面后晚到的批次不提交', async () => {
    const store = createMemoryCsvStore()
    const first = new FakeHandle('a.csv', csv(5000))
    await associate(store, first)
    const { session } = create(store)
    await session.restore()
    const revision = (await store.load()).revision

    const gate = deferred<File>()
    first.gate = gate.promise
    const pending = session.refreshAll()
    await vi.waitFor(() => expect(first.reads).toBe(1))
    session.destroy()
    gate.resolve(first.file())
    await pending
    await flush()
    expect((await store.load()).revision).toBe(revision)
  })

  it('数据库写入失败时不留下关联也不替换旧分析', async () => {
    const store = createMemoryCsvStore()
    const failing: CsvSourceStore = {
      ...store,
      addMany: async () => {
        throw new Error('db down')
      },
    }
    const { session } = create(failing)
    await session.restore()
    await session.addFiles([new FakeHandle('a.csv', csv(5000))])
    expect(session.state.sources).toEqual([])
    expect(session.videos()).toEqual([])
    expect(session.state.message).toContain('保存关联失败')
  })
})

describe('关联批次与并发', () => {
  it('添加读到第二个文件时取消，不留下半批关联且保留旧成绩', async () => {
    const store = createMemoryCsvStore()
    await associate(store, new FakeHandle('existing.csv', csv(4000)))
    const { session } = create(store)
    await session.restore()
    await session.refreshAll()
    expect(session.videos()).toHaveLength(1)

    const first = new FakeHandle('a.csv', csv(5000))
    const slow = new FakeHandle('b.csv', csv(6000))
    const gate = deferred<File>()
    slow.gate = gate.promise

    const pending = session.addFiles([first, slow])
    await vi.waitFor(() => expect(slow.reads).toBe(1))
    session.cancel()
    gate.resolve(slow.file())
    await pending
    await flush()

    expect(session.state.sources.map((source) => source.name)).toEqual(['existing.csv'])
    expect(session.videos()).toHaveLength(1)
    expect(session.videos()[0]!.timems).toBe(4000)
    expect((await store.load()).sources).toHaveLength(1)
    expect(session.state.message).toContain('已取消读取')
  })

  it('写库等待期间移除全部，晚到的添加不会重新落库', async () => {
    const base = createMemoryCsvStore()
    const gate = deferred<void>()
    let entered = false
    let started!: () => void
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve
    })
    const delayed: CsvSourceStore = {
      ...base,
      addMany: async (inputs, revision, isValid) => {
        entered = true
        started()
        await gate.promise
        return base.addMany(inputs, revision, isValid)
      },
    }
    const { session } = create(delayed)
    await session.restore()

    const pending = session.addFiles([new FakeHandle('a.csv', csv(5000))])
    await startedPromise
    expect(entered).toBe(true)
    await session.removeAll()
    gate.resolve()
    await pending
    await flush()

    expect(session.state.sources).toEqual([])
    expect((await base.load()).sources).toEqual([])
  })

  it('两个页面并发添加同一个文件，后提交者不会形成重复来源', async () => {
    const base = createMemoryCsvStore()
    const stashed = await base.load()
    let staleNext = false
    const staleStore: CsvSourceStore = {
      ...base,
      load: async () => {
        if (staleNext) {
          staleNext = false
          return stashed
        }
        return base.load()
      },
    }
    const first = create(base).session
    const second = create(staleStore).session
    await first.restore()
    await second.restore()

    const handle = new FakeHandle('a.csv', csv(5000))
    await first.addFiles([handle])
    expect((await base.load()).sources).toHaveLength(1)

    staleNext = true
    const result = await second.addFiles([handle])
    expect(result).toBe('failed')
    expect((await base.load()).sources).toHaveLength(1)
    expect(second.state.sources).toHaveLength(1)
    expect(second.state.message).toContain('关联清单已在其他页面变化')
  })

  it('并发重新关联不会覆盖另一页面刚提交的修改', async () => {
    const base = createMemoryCsvStore()
    const a = new FakeHandle('a.csv', csv(5000))
    const b = new FakeHandle('b.csv', csv(6000))
    await associate(base, a)
    await associate(base, b)
    const registry = await base.load()
    const aId = registry.sources[0]!.sourceId

    const stashed = await base.load()
    let staleNext = false
    const staleStore: CsvSourceStore = {
      ...base,
      load: async () => {
        if (staleNext) {
          staleNext = false
          return stashed
        }
        return base.load()
      },
    }
    const { session } = create(staleStore)
    await session.restore()

    const renamed = new FakeHandle('renamed.csv', csv(7000), 'renamed')
    await base.relink(aId, renamed, (await readCsvFile(renamed)).summary, registry.revision)
    staleNext = true

    const result = await session.relink(aId, new FakeHandle('c.csv', csv(8000), 'c'))
    expect(result).toBe('failed')
    expect((await base.load()).sources[0]!.name).toBe('renamed.csv')
    expect(session.state.message).toContain('关联清单或排除规则已在其他页面变化')
  })

  it('同一批里两个句柄指向同一文件时只关联一次', async () => {
    const store = createMemoryCsvStore()
    const { session } = create(store)
    await session.restore()
    const first = new FakeHandle('a.csv', csv(5000), 'same-file')
    const second = new FakeHandle('a-copy.csv', csv(6000), 'same-file')

    const result = await session.addFiles([first, second])
    expect(result).toBe('success')
    expect(session.state.sources).toHaveLength(1)
    expect(session.videos()).toHaveLength(1)
    expect(session.videos()[0]!.timems).toBe(5000)
    expect((await store.load()).sources).toHaveLength(1)
    expect(session.state.message).toContain('a-copy.csv 已在关联清单中')
  })

  it('冲突重筛时也要去掉批内重复文件', async () => {
    const base = createMemoryCsvStore()
    const stashed = await base.load()
    let staleNext = false
    const staleStore: CsvSourceStore = {
      ...base,
      load: async () => {
        if (staleNext) {
          staleNext = false
          return stashed
        }
        return base.load()
      },
    }
    const { session } = create(staleStore)
    await session.restore()

    // 其他页面先加了一个无关来源，使本批 revision 过期。
    const other = new FakeHandle('other.csv', csv(3000), 'other')
    await base.addMany(
      [{ sourceId: 'src-other', handle: other, summary: (await readCsvFile(other)).summary }],
      0,
    )
    staleNext = true

    const first = new FakeHandle('a.csv', csv(5000), 'same-file')
    const second = new FakeHandle('a-copy.csv', csv(6000), 'same-file')
    const result = await session.addFiles([first, second])
    expect(result).toBe('success')
    const stored = await base.load()
    expect(stored.sources.map((source) => source.name)).toEqual(['other.csv', 'a.csv'])
    expect(session.state.sources.map((source) => source.name)).toEqual([
      'other.csv',
      'a.csv',
    ])
    expect(session.state.message).toContain('a-copy.csv 已在关联清单中')
  })
})

describe('清单变化与旧快照', () => {
  it('另一页面重新关联后，旧来源成绩立即失效且不会被后续添加复用', async () => {
    const store = createMemoryCsvStore()
    const first = new FakeHandle('a.csv', csv(5000))
    const second = new FakeHandle('b.csv', csv(6000))
    await associate(store, first)
    await associate(store, second)
    const { session } = create(store)
    await session.restore()
    await session.refreshAll()
    expect(session.videos()).toHaveLength(2)

    const aId = session.state.sources[0]!.sourceId
    const replacement = new FakeHandle('c.csv', csv(7000, 8000), 'c')
    const registry = await store.load()
    await store.relink(aId, replacement, (await readCsvFile(replacement)).summary, registry.revision)

    await session.checkRegistry()
    expect(session.state.sources.map((source) => source.name)).toEqual(['c.csv', 'b.csv'])
    expect(session.hasSnapshot()).toBe(false)
    expect(session.videos()).toEqual([])

    await session.addFiles([new FakeHandle('d.csv', csv(9000))])
    expect(session.videos()).toEqual([])
  })

  it('另一页面移除来源后，待授权早退也不会返回旧的两文件成绩', async () => {
    const store = createMemoryCsvStore()
    const first = new FakeHandle('a.csv', csv(5000))
    const second = new FakeHandle('b.csv', csv(6000))
    await associate(store, first)
    await associate(store, second)
    const { session } = create(store)
    await session.restore()
    await session.refreshAll()
    expect(session.videos()).toHaveLength(2)

    const aId = session.state.sources[0]!.sourceId
    second.permission = 'prompt'
    await store.remove(aId)
    await session.refreshAll()

    expect(session.state.sources.map((source) => source.name)).toEqual(['b.csv'])
    expect(session.state.needsPermission).toHaveLength(1)
    expect(session.videos()).toHaveLength(1)
    expect(session.videos()[0]!.timems).toBe(6000)
  })
})

describe('焦点检查的旧结果', () => {
  it('晚于移除全部的检查结果被丢弃，清单不会复活', async () => {
    const base = createMemoryCsvStore()
    await associate(base, new FakeHandle('a.csv', csv(5000)))
    const gate = deferred<void>()
    let hold = false
    let started!: () => void
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve
    })
    const gated: CsvSourceStore = {
      ...base,
      load: async () => {
        const registry = await base.load()
        if (hold) {
          hold = false
          started()
          await gate.promise
        }
        return registry
      },
    }
    const { session } = create(gated)
    await session.restore()
    await session.refreshAll()

    hold = true
    const checking = session.checkRegistry()
    await startedPromise
    await session.removeAll()
    gate.resolve()
    await checking
    await flush()

    expect(session.state.sources).toEqual([])
    expect(session.state.message).toBe('')
    expect((await base.load()).sources).toEqual([])
  })

  it('晚于新一次刷新的检查结果不会覆盖刷新提示', async () => {
    const base = createMemoryCsvStore()
    await associate(base, new FakeHandle('a.csv', csv(5000)))
    const gate = deferred<void>()
    let hold = false
    let started!: () => void
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve
    })
    const gated: CsvSourceStore = {
      ...base,
      load: async () => {
        const registry = await base.load()
        if (hold) {
          hold = false
          started()
          await gate.promise
        }
        return registry
      },
    }
    const { session } = create(gated)
    await session.restore()
    await session.refreshAll()

    hold = true
    const checking = session.checkRegistry()
    await startedPromise
    await session.refreshAll()
    expect(session.state.message).toContain('刷新完成')
    gate.resolve()
    await checking
    await flush()
    expect(session.state.message).toContain('刷新完成')
    expect(session.state.message).not.toContain('关联清单已在其他页面变化')
  })

  it('两个焦点检查乱序返回时，较早的清单版本不会倒退覆盖', async () => {
    const base = createMemoryCsvStore()
    await associate(base, new FakeHandle('a.csv', csv(5000)))
    const gate = deferred<void>()
    let hold = false
    let started!: () => void
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve
    })
    const gated: CsvSourceStore = {
      ...base,
      load: async () => {
        const registry = await base.load()
        if (hold) {
          hold = false
          started()
          await gate.promise
        }
        return registry
      },
    }
    const { session } = create(gated)
    await session.restore()

    const b = new FakeHandle('b.csv', csv(6000))
    const firstRegistry = await base.load()
    await base.addMany(
      [{ sourceId: 'src-b', handle: b, summary: (await readCsvFile(b)).summary }],
      firstRegistry.revision,
    )

    hold = true
    const older = session.checkRegistry()
    await startedPromise

    const c = new FakeHandle('c.csv', csv(7000))
    const secondRegistry = await base.load()
    await base.addMany(
      [{ sourceId: 'src-c', handle: c, summary: (await readCsvFile(c)).summary }],
      secondRegistry.revision,
    )
    await session.checkRegistry()
    expect(session.state.sources.map((source) => source.name)).toEqual([
      'a.csv',
      'b.csv',
      'c.csv',
    ])

    gate.resolve()
    await older
    await flush()
    expect(session.state.sources.map((source) => source.name)).toEqual([
      'a.csv',
      'b.csv',
      'c.csv',
    ])
  })

  it('刷新冲突恢复期间移除全部，旧清单不会回到页面', async () => {
    const base = createMemoryCsvStore()
    await associate(base, new FakeHandle('a.csv', csv(5000)))
    const gate = deferred<void>()
    let loadCount = 0
    let started!: () => void
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve
    })
    const store: CsvSourceStore = {
      ...base,
      load: async () => {
        const registry = await base.load()
        loadCount += 1
        if (loadCount === 3) {
          started()
          await gate.promise
        }
        return registry
      },
      commit: async () => null,
    }
    const { session } = create(store)
    await session.restore()

    const pending = session.refreshAll()
    await startedPromise
    await session.removeAll()
    gate.resolve()
    await pending
    await flush()

    expect(session.state.sources).toEqual([])
    expect(session.state.message).toBe('')
    expect((await base.load()).sources).toEqual([])
  })
})
