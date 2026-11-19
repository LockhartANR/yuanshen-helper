import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CsvFileError,
  CSV_FILE_OPEN_TIMEOUT_MS,
  CSV_IDENTITY_CHECK_TIMEOUT_MS,
  CsvIdentityError,
  buildCsvSnapshot,
  createIndexedDbCsvStore,
  isSameCsvHandle,
  loadCsvHandles,
  loadCsvRegistry,
  migrateLegacyRegistry,
  normalizeCsvRegistry,
  readCsvFile,
} from '../src/features/player-stats/csv-sources'
import type {
  CsvFileHandle,
  CsvLoadedSource,
  CsvSourceRegistry,
  CsvSourceSummary,
} from '../src/features/player-stats/csv-sources'
import { getDb } from '../src/shared/db'
import { parseStatsCsv } from '../src/features/player-stats/csv'

const HEADER =
  'Day,Month,Year,Hour,Min,Sec,mode,Time,BBBV,BBBVs,style,cell0,cell1,cell2,cell3,cell4,cell5,cell6,cell7,cell8,Lcl,Rcl,Dcl,Leff,Reff,Deff,Openings,Islands,Path,GZiNi,HZiNi'
const ROW = (time = '5.00') =>
  `2,8,2024,16,1,12,BEG,${time},12,2.40,Flag,19,21,10,4,0,0,0,0,0,12,3,3,12,1,3,3,3,992,12,12`
const CSV = `${HEADER}\n${ROW()}`

it('浏览器打开文件未返回时结束等待并提示重新关联', async () => {
  vi.useFakeTimers()
  try {
    const reading = readCsvFile({
      name: 'a.csv',
      getFile: () => new Promise<File>(() => {}),
    })
    const assertion = expect(reading).rejects.toMatchObject({
      code: 'io',
      message: '打开文件超时，请重新关联原文件',
    })
    await vi.advanceTimersByTimeAsync(CSV_FILE_OPEN_TIMEOUT_MS)
    await assertion
  } finally {
    vi.useRealTimers()
  }
})

interface FakeFile {
  name: string
  size: number
  lastModified: number
  text(): Promise<string>
}

function fileOf(text: string, name = 'stats.csv', size = text.length): FakeFile {
  return { name, size, lastModified: 1, text: async () => text }
}

function handleOf(
  name: string,
  options: {
    text?: string
    size?: number
    getFile?: () => Promise<File>
    same?: string
  } = {},
): CsvFileHandle & { same: string } {
  const handle = {
    name,
    same: options.same ?? name,
    getFile:
      options.getFile ??
      (async () => fileOf(options.text ?? CSV, name, options.size) as unknown as File),
    isSameEntry: async (other: CsvFileHandle): Promise<boolean> =>
      (other as CsvFileHandle & { same?: string }).same === (options.same ?? name),
  }
  return handle
}

/** fake-indexeddb 无法克隆真实句柄上的方法；持久化测试只关心可序列化字段。 */
function storedHandle(name: string): CsvFileHandle {
  return { name } as unknown as CsvFileHandle
}

const summary = (validCount: number): CsvSourceSummary => ({
  readAt: 1_700_000_000_000,
  validCount,
  totalRows: validCount,
  invalidRows: 0,
  size: 100,
  lastModified: 1,
})

function loadedSource(name: string, rows: number): CsvLoadedSource {
  const text = `${HEADER}\n${Array.from({ length: rows }, (_, index) => ROW((5 + index).toFixed(2))).join('\n')}`
  const videos = parseStatsCsv(text).videos
  return {
    sourceId: name,
    sourceRevision: 0,
    name,
    videos,
    summary: summary(videos.length),
  }
}

async function clearRegistry(): Promise<void> {
  const db = await getDb()
  await db.clear('csvSources')
  await db.clear('csvSourceMeta')
  await db.clear('csvHandles')
  await db.clear('statExclusions')
}

/** 旧句柄已失效的排除作用域：写入它就会失败，用来确认事务没有留下半批结果。 */
async function seedScope(scopeId: string, revision = 1): Promise<void> {
  const db = await getDb()
  await db.put('statExclusions', {
    scopeId,
    kind: 'csv',
    revision,
    owner: {
      kind: 'csv',
      name: '旧.csv',
      handle: { name: '旧.csv', legacy: true } as unknown as CsvFileHandle,
      sourceId: scopeId,
    },
    rules: [],
  })
}

async function scopeState(scopeId: string): Promise<{ revision: number; name: unknown } | null> {
  const db = await getDb()
  const scope = await db.get('statExclusions', scopeId)
  if (!scope) return null
  return {
    revision: scope.revision,
    name: scope.owner.kind === 'csv' ? (scope.owner.handle as { name?: string } | undefined)?.name : null,
  }
}

beforeEach(clearRegistry)

describe('读取 CSV 文件', () => {
  it('返回有效局数、无效行数和文件摘要', async () => {
    const handle = handleOf('stats.csv', {
      text: `${CSV}\n${ROW('0')}`,
    })
    const result = await readCsvFile(handle, 123)
    expect(result.videos).toHaveLength(1)
    expect(result.errors).toHaveLength(1)
    expect(result.summary).toMatchObject({
      readAt: 123,
      validCount: 1,
      totalRows: 2,
      invalidRows: 1,
      size: expect.any(Number),
      lastModified: 1,
    })
  })

  it('正确表头加 0 行数据是合法的 0 局数据源', async () => {
    const result = await readCsvFile(handleOf('empty.csv', { text: HEADER }))
    expect(result.videos).toEqual([])
    expect(result.summary).toMatchObject({ validCount: 0, totalRows: 0, invalidRows: 0 })
  })

  it.each([
    ['空白文件', ''],
    ['表头错误', 'a,b,c\n1,2,3'],
  ])('%s 属于文件级失败', async (_name, text) => {
    await expect(readCsvFile(handleOf('bad.csv', { text }))).rejects.toMatchObject({
      name: 'CsvFileError',
      code: 'format',
    })
  })

  it('有数据行但全部无效时失败并说明没有有效数据', async () => {
    const error = await readCsvFile(
      handleOf('bad.csv', { text: `${HEADER}\n${ROW('0')}` }),
    ).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(CsvFileError)
    expect((error as CsvFileError).code).toBe('invalid')
    expect((error as CsvFileError).message).toContain('没有有效数据')
  })

  it('超过 20 MB 的文件不读取内容', async () => {
    const error = await readCsvFile(
      handleOf('big.csv', { text: CSV, size: 21 * 1024 * 1024 }),
    ).catch((reason: unknown) => reason)
    expect((error as CsvFileError).code).toBe('size')
    expect((error as CsvFileError).message).toContain('20 MB')
  })

  it('句柄失效与权限错误给出可操作的提示', async () => {
    const gone = await readCsvFile(
      handleOf('gone.csv', {
        getFile: async () => {
          throw new DOMException('gone', 'NotFoundError')
        },
      }),
    ).catch((reason: unknown) => reason)
    expect(gone).toBeInstanceOf(CsvFileError)
    expect((gone as CsvFileError).code).toBe('not-found')
    expect((gone as CsvFileError).message).toBe('文件不可用，请重新关联')

    const denied = await readCsvFile(
      handleOf('denied.csv', {
        getFile: async () => {
          throw new DOMException('denied', 'NotAllowedError')
        },
      }),
    ).catch((reason: unknown) => reason)
    expect((denied as CsvFileError).code).toBe('permission')
  })
})

describe('快照编号', () => {
  it('按来源与行顺序生成唯一 ID，反复生成保持并列取舍顺序', () => {
    const sources = [loadedSource('a.csv', 2), loadedSource('b.csv', 1)]
    const snapshot = buildCsvSnapshot(sources)
    expect(snapshot.map((video) => video.id)).toEqual([-1, -2, -3])
    expect(snapshot.map((video) => video.importOrder)).toEqual([0, 1, 2])
    expect(buildCsvSnapshot(sources)).toEqual(snapshot)
  })
})

describe('文件身份', () => {
  it('同一对象直接视为相同，isSameEntry 决定其余情况', async () => {
    const first = handleOf('a.csv', { same: 'key-1' })
    const second = handleOf('b.csv', { same: 'key-1' })
    const other = handleOf('a.csv', { same: 'key-2' })
    expect(await isSameCsvHandle(first, first)).toBe(true)
    expect(await isSameCsvHandle(first, second)).toBe(true)
    expect(await isSameCsvHandle(first, other)).toBe(false)
  })

  it('比较异常时抛出身份错误，不按同名认定相同', async () => {
    const broken: CsvFileHandle = {
      name: 'a.csv',
      getFile: async () => fileOf(CSV) as unknown as File,
      isSameEntry: async () => {
        throw new Error('nope')
      },
    }
    await expect(isSameCsvHandle(broken, handleOf('a.csv'))).rejects.toBeInstanceOf(
      CsvIdentityError,
    )
  })

  it('缺少 isSameEntry 时不认为相同', async () => {
    const plain: CsvFileHandle = {
      name: 'a.csv',
      getFile: async () => fileOf(CSV) as unknown as File,
    }
    expect(await isSameCsvHandle(plain, handleOf('a.csv'))).toBe(false)
  })

  it('浏览器中止身份检查时给出明确说明，不误报用户取消', async () => {
    const aborting: CsvFileHandle = {
      name: 'a.csv',
      getFile: async () => fileOf(CSV) as unknown as File,
      isSameEntry: async () => {
        throw new DOMException('The user aborted a request', 'AbortError')
      },
    }
    await expect(isSameCsvHandle(aborting, handleOf('a.csv'))).rejects.toMatchObject({
      name: 'CsvIdentityError',
      message: '浏览器中止文件身份检查',
    })
  })

  it('身份比较未返回时超时结束等待', async () => {
    vi.useFakeTimers()
    try {
      const hanging: CsvFileHandle = {
        name: 'a.csv',
        getFile: async () => fileOf(CSV) as unknown as File,
        isSameEntry: () => new Promise<boolean>(() => {}),
      }
      const assertion = expect(isSameCsvHandle(hanging, handleOf('a.csv'))).rejects.toMatchObject({
        name: 'CsvIdentityError',
        message: expect.stringContaining('超时'),
      })
      await vi.advanceTimersByTimeAsync(CSV_IDENTITY_CHECK_TIMEOUT_MS)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('关联清单持久化', () => {
  async function addOne(
    store: ReturnType<typeof createIndexedDbCsvStore>,
    name: string,
    validCount: number,
    sourceId = `src-${name}`,
  ): Promise<CsvSourceRegistry> {
    const registry = await store.load()
    const next = await store.addMany(
      [{ sourceId, handle: storedHandle(name), summary: summary(validCount) }],
      registry.revision,
    )
    if (!next) throw new Error('addMany failed')
    return next
  }

  it('按添加顺序保存，重新读取保留摘要和来源版本', async () => {
    const store = createIndexedDbCsvStore()
    expect(await store.load()).toMatchObject({ revision: 0, sources: [] })

    const first = await addOne(store, 'a.csv', 1, 'src-a')
    const second = await addOne(store, 'b.csv', 2, 'src-b')
    expect(first.revision).toBe(1)
    expect(second.revision).toBe(2)

    const loaded = await loadCsvRegistry()
    expect(loaded.sources.map((source) => source.name)).toEqual(['a.csv', 'b.csv'])
    expect(loaded.sources.map((source) => source.sourceId)).toEqual(['src-a', 'src-b'])
    expect(loaded.sources.map((source) => source.revision)).toEqual([1, 1])
    expect(loaded.sources[1]!.lastSuccess).toMatchObject({ validCount: 2 })
    expect(loaded.sources[0]!.addedAt).toBeGreaterThan(0)
  })

  it('重新关联保持 sourceId、位置和添加时间，并提升来源版本', async () => {
    const store = createIndexedDbCsvStore()
    await addOne(store, 'a.csv', 1, 'src-a')
    await addOne(store, 'b.csv', 2, 'src-b')
    const before = (await loadCsvRegistry()).sources[0]!

    const next = await store.relink(
      'src-a',
      storedHandle('renamed.csv'),
      summary(9),
      2,
    )
    expect(next?.sources.map((source) => source.name)).toEqual(['renamed.csv', 'b.csv'])
    const updated = next?.sources[0]!
    expect(updated.sourceId).toBe('src-a')
    expect(updated.addedAt).toBe(before.addedAt)
    expect(updated.revision).toBe(before.revision + 1)
    expect(updated.lastSuccess).toMatchObject({ validCount: 9 })
    // 元数据不再嵌句柄；句柄按来源单独保存。
    expect((await store.handles()).get('src-a')?.name).toBe('renamed.csv')

    const stale = await store.relink('src-a', storedHandle('again.csv'), summary(10), 2)
    expect(stale).toBeNull()
    expect((await loadCsvRegistry()).sources[0]!.name).toBe('renamed.csv')
    expect((await store.handles()).get('src-a')?.name).toBe('renamed.csv')
  })

  it('重新关联可持久保存沿用的排除作用域，且同一作用域不能绑定两个文件', async () => {
    const store = createIndexedDbCsvStore()
    await addOne(store, 'a.csv', 1, 'src-a')
    await addOne(store, 'b.csv', 2, 'src-b')

    const inherited = await store.relink(
      'src-a',
      storedHandle('a-next.csv'),
      summary(3),
      2,
      undefined,
      'scope-a',
    )
    expect(inherited?.sources[0]!.exclusionScopeId).toBe('scope-a')
    const reloaded = await loadCsvRegistry()
    expect(reloaded.sources[0]!.exclusionScopeId).toBe('scope-a')

    const duplicate = await store.relink(
      'src-b',
      storedHandle('b-next.csv'),
      summary(4),
      reloaded.revision,
      undefined,
      'scope-a',
    )
    expect(duplicate).toBeNull()
    expect((await loadCsvRegistry()).sources[1]!.name).toBe('b.csv')

    const fresh = await store.relink(
      'src-a',
      storedHandle('a-new.csv'),
      summary(5),
      reloaded.revision,
      undefined,
      null,
    )
    expect(fresh?.sources[0]!.exclusionScopeId).toBeUndefined()
    expect((await loadCsvRegistry()).sources[0]!.exclusionScopeId).toBeUndefined()
  })

  it('批量添加在事务内校验 revision，并发提交不会重复关联', async () => {
    const store = createIndexedDbCsvStore()
    const first = await addOne(store, 'a.csv', 1, 'src-a')
    await addOne(store, 'b.csv', 2, 'src-b')
    expect((await loadCsvRegistry()).revision).toBe(2)

    const stale = await store.addMany(
      [{ sourceId: 'src-b', handle: storedHandle('b.csv'), summary: summary(2) }],
      first.revision,
    )
    expect(stale).toBeNull()
    expect((await loadCsvRegistry()).sources.map((source) => source.name)).toEqual([
      'a.csv',
      'b.csv',
    ])

    const current = await store.load()
    const batch = await store.addMany(
      [
        { sourceId: 'src-c', handle: storedHandle('c.csv'), summary: summary(3) },
        { sourceId: 'src-d', handle: storedHandle('d.csv'), summary: summary(4) },
      ],
      current.revision,
    )
    expect(batch?.sources.map((source) => source.name)).toEqual([
      'a.csv',
      'b.csv',
      'c.csv',
      'd.csv',
    ])
  })

  it('批量添加或取消时不写入任何来源', async () => {
    const store = createIndexedDbCsvStore()
    const registry = await store.load()
    const cancelled = await store.addMany(
      [{ sourceId: 'src-a', handle: storedHandle('a.csv'), summary: summary(1) }],
      registry.revision,
      () => false,
    )
    expect(cancelled).toBeNull()
    expect((await loadCsvRegistry()).sources).toEqual([])
  })

  it('提交摘要时校验 revision，冲突不写入', async () => {
    const store = createIndexedDbCsvStore()
    const added = await store.addMany(
      [{ sourceId: 'src-a', handle: storedHandle('a.csv'), summary: summary(1) }],
      0,
    )
    expect(added).not.toBeNull()

    const conflict = await store.commit((added?.revision ?? 0) - 1, new Map([
      ['src-a', summary(9)],
    ]))
    expect(conflict).toBeNull()
    expect((await loadCsvRegistry()).sources[0]!.lastSuccess).toMatchObject({
      validCount: 1,
    })

    const committed = await store.commit(added!.revision, new Map([['src-a', summary(9)]]))
    expect(committed?.sources[0]!.lastSuccess).toMatchObject({ validCount: 9 })
    expect(committed?.revision).toBe(added!.revision + 1)
  })

  it('事务内检查批次有效性，已取消的批次不写回摘要', async () => {
    const store = createIndexedDbCsvStore()
    const added = await addOne(store, 'a.csv', 1, 'src-a')
    const cancelled = await store.commit(
      added.revision,
      new Map([['src-a', summary(9)]]),
      () => false,
    )
    expect(cancelled).toBeNull()
    expect((await loadCsvRegistry()).sources[0]!.lastSuccess).toMatchObject({
      validCount: 1,
    })
  })

  it('提交时只更新仍存在的来源，其他页面移除的来源不会复活', async () => {
    const store = createIndexedDbCsvStore()
    await addOne(store, 'a.csv', 1, 'src-a')
    await addOne(store, 'b.csv', 2, 'src-b')
    await store.remove('src-a')
    const revision = (await loadCsvRegistry()).revision

    const committed = await store.commit(
      revision,
      new Map([
        ['src-a', summary(8)],
        ['src-b', summary(9)],
      ]),
    )
    expect(committed?.sources.map((source) => source.name)).toEqual(['b.csv'])
    expect(committed?.sources[0]!.lastSuccess).toMatchObject({ validCount: 9 })
  })

  it('收敛损坏或被手动改写的清单', () => {
    expect(normalizeCsvRegistry(null)).toMatchObject({ revision: 0, sources: [] })
    const normalized = normalizeCsvRegistry({
      revision: -3,
      sources: [
        { sourceId: 'a', name: 'a.csv', handle: {}, lastSuccess: { bad: true } },
        { sourceId: 3, name: 'b.csv' },
        'nope',
      ],
    })
    expect(normalized.revision).toBe(0)
    expect(normalized.sources).toHaveLength(1)
    expect(normalized.sources[0]).toMatchObject({
      sourceId: 'a',
      revision: 0,
      lastSuccess: null,
    })
  })

  /** 在 fake-indexeddb 上模拟某个句柄写入失败，不影响其他来源。 */
  function patchPut(handler: (storeName: string, value: unknown) => void): () => void {
    const proto = IDBObjectStore.prototype as unknown as {
      put: (this: IDBObjectStore, value: unknown, key?: IDBValidKey) => IDBRequest
    }
    const original = proto.put
    proto.put = function (value: unknown, key?: IDBValidKey) {
      handler(this.name, value)
      return key === undefined ? original.call(this, value) : original.call(this, value, key)
    }
    return () => {
      proto.put = original
    }
  }

  async function seedLegacy(
    sources: Array<{
      sourceId: string
      name: string
      revision?: number
      exclusionScopeId?: string
    }>,
    revision = 5,
  ): Promise<void> {
    const db = await getDb()
    await db.put('csvSources', {
      id: 'current',
      revision,
      sources: sources.map((source, index) => ({
        sourceId: source.sourceId,
        name: source.name,
        handle: storedHandle(source.name),
        addedAt: index + 1,
        revision: source.revision ?? 1,
        lastSuccess: null,
        ...(source.exclusionScopeId ? { exclusionScopeId: source.exclusionScopeId } : {}),
      })),
    })
  }

  it('旧库迁移逐个来源写句柄，单个句柄写入失败不阻断其他来源且保留旧记录', async () => {
    await seedLegacy([
      { sourceId: 'src-ok', name: 'ok.csv' },
      { sourceId: 'src-bad', name: 'bad.csv' },
    ])
    const restore = patchPut((storeName, value) => {
      if (storeName === 'csvHandles' && (value as { sourceId?: string }).sourceId === 'src-bad') {
        throw new DOMException('bad handle', 'DataCloneError')
      }
    })
    let registry: Awaited<ReturnType<typeof loadCsvRegistry>>
    let handles: Awaited<ReturnType<typeof loadCsvHandles>>
    try {
      registry = await loadCsvRegistry()
      handles = await loadCsvHandles()
    } finally {
      restore()
    }
    expect(registry.revision).toBe(5)
    expect(registry.sources.map((source) => source.sourceId)).toEqual(['src-ok', 'src-bad'])
    expect(registry.sources.every((source) => source.handle === undefined)).toBe(true)
    expect(handles.get('src-ok')?.name).toBe('ok.csv')
    expect(handles.has('src-bad')).toBe(false)
    // 旧记录保留，迁移失败或回退时不丢原关联。
    expect(await (await getDb()).get('csvSources', 'current')).toMatchObject({ revision: 5 })
  })

  it('迟到的旧库迁移不覆盖新清单，也不恢复已移除来源', async () => {
    await seedLegacy([
      { sourceId: 'src-a', name: 'a.csv' },
      { sourceId: 'src-b', name: 'b.csv' },
    ])
    // 页面 A 读到旧清单后暂停；页面 B 完成迁移并移除 src-b。
    const db = await getDb()
    const legacy = normalizeCsvRegistry(await db.get('csvSources', 'current'))
    await loadCsvRegistry()
    const store = createIndexedDbCsvStore()
    const removed = await store.remove('src-b')
    expect(removed.sources.map((source) => source.sourceId)).toEqual(['src-a'])

    // A 返回并写完自己的部分：不得改写元数据，也不得留下 src-b 的孤儿句柄。
    const late = await migrateLegacyRegistry(legacy)
    expect(late.sources.map((source) => source.sourceId)).toEqual(['src-a'])
    expect(late.revision).toBe(removed.revision)
    const fresh = await loadCsvRegistry()
    expect(fresh.revision).toBe(removed.revision)
    expect(fresh.sources.map((source) => source.sourceId)).toEqual(['src-a'])
    expect((await loadCsvHandles()).has('src-b')).toBe(false)
  })

  it('迟到的旧库迁移不覆盖重新关联后的文件名与来源版本', async () => {
    await seedLegacy([
      { sourceId: 'src-a', name: 'a.csv' },
      { sourceId: 'src-b', name: 'b.csv' },
    ])
    const db = await getDb()
    const legacy = normalizeCsvRegistry(await db.get('csvSources', 'current'))
    const migrated = await loadCsvRegistry()
    const store = createIndexedDbCsvStore()
    const relinked = await store.relink(
      'src-b',
      storedHandle('b-new.csv'),
      summary(6),
      migrated.revision,
      undefined,
      null,
      migrated.sources[1]!.revision,
    )
    expect(relinked?.sources[1]!.name).toBe('b-new.csv')

    const late = await migrateLegacyRegistry(legacy)
    expect(late.sources.map((source) => source.name)).toEqual(['a.csv', 'b-new.csv'])
    expect(late.revision).toBe(relinked!.revision)
    const handles = await loadCsvHandles()
    expect(handles.get('src-b')?.name).toBe('b-new.csv')
  })

  it('迟到的旧库迁移不会把清空后的清单写回来', async () => {
    await seedLegacy([{ sourceId: 'src-a', name: 'a.csv' }])
    const db = await getDb()
    const legacy = normalizeCsvRegistry(await db.get('csvSources', 'current'))
    await loadCsvRegistry()
    const store = createIndexedDbCsvStore()
    const cleared = await store.clear()
    expect(cleared.sources).toEqual([])

    const late = await migrateLegacyRegistry(legacy)
    expect(late.sources).toEqual([])
    expect((await loadCsvRegistry()).sources).toEqual([])
    expect((await loadCsvHandles()).size).toBe(0)
  })

  it('移除、更新摘要和清空保留版本语义且不重写无关句柄', async () => {
    await seedLegacy([
      { sourceId: 'src-bad', name: 'bad.csv' },
      { sourceId: 'src-ok', name: 'ok.csv' },
    ])
    await loadCsvRegistry()
    const store = createIndexedDbCsvStore()
    const touched: string[] = []
    const restore = patchPut((storeName, value) => {
      if (storeName === 'csvHandles') {
        touched.push((value as { sourceId: string }).sourceId)
      }
    })
    try {
      const removed = await store.remove('src-bad')
      expect(removed.sources.map((source) => source.sourceId)).toEqual(['src-ok'])
      const committed = await store.commit(removed.revision, new Map([['src-ok', summary(9)]]))
      expect(committed?.sources[0]!.lastSuccess).toMatchObject({ validCount: 9 })
    } finally {
      restore()
    }
    // 移除只删除对应句柄，摘要只写元数据，都不重新写入未变化的句柄。
    expect(touched).toEqual([])
    expect((await loadCsvHandles()).get('src-ok')?.name).toBe('ok.csv')
    expect((await loadCsvHandles()).has('src-bad')).toBe(false)

    const previous = await store.load()
    const cleared = await store.clear()
    expect(cleared.sources).toEqual([])
    expect(cleared.revision).toBeGreaterThan(previous.revision)
    expect((await loadCsvHandles()).size).toBe(0)
  })

  it('批量修复只写本批句柄，保持来源顺序与规则绑定', async () => {
    await seedLegacy(
      [
        { sourceId: 'src-a', name: 'a.csv', revision: 2, exclusionScopeId: 'scope-a' },
        { sourceId: 'src-b', name: 'b.csv', revision: 3 },
        { sourceId: 'src-c', name: 'c.csv', revision: 1 },
      ],
      4,
    )
    const registry = await loadCsvRegistry()
    const store = createIndexedDbCsvStore()
    const touched: string[] = []
    const restore = patchPut((storeName, value) => {
      if (storeName === 'csvHandles') touched.push((value as { sourceId: string }).sourceId)
    })
    let repaired: Awaited<ReturnType<typeof store.repair>>
    try {
      repaired = await store.repair(
        [
          {
            sourceId: 'src-a',
            handle: storedHandle('a2.csv'),
            summary: summary(2),
            exclusionScopeId: 'scope-a',
            expectedSourceRevision: registry.sources[0]!.revision,
          },
          {
            sourceId: 'src-b',
            handle: storedHandle('b2.csv'),
            summary: summary(4),
            exclusionScopeId: null,
            expectedSourceRevision: registry.sources[1]!.revision,
          },
        ],
        registry.revision,
      )
    } finally {
      restore()
    }
    expect(repaired?.sources.map((source) => source.name)).toEqual([
      'a2.csv',
      'b2.csv',
      'c.csv',
    ])
    expect(repaired?.sources.map((source) => source.sourceId)).toEqual([
      'src-a',
      'src-b',
      'src-c',
    ])
    expect(repaired?.sources[0]!.exclusionScopeId).toBe('scope-a')
    expect(repaired?.sources[1]!.exclusionScopeId).toBeUndefined()
    expect(repaired?.sources[0]!.revision).toBe(registry.sources[0]!.revision + 1)
    // 未参与本批修复的来源句柄没有被写入。
    expect(touched.sort()).toEqual(['src-a', 'src-b'])
    const handles = await loadCsvHandles()
    expect(handles.get('src-a')?.name).toBe('a2.csv')
    expect(handles.get('src-b')?.name).toBe('b2.csv')
    expect(handles.get('src-c')?.name).toBe('c.csv')

    // 清单版本过期时整批不写。
    const stale = await store.repair(
      [
        {
          sourceId: 'src-a',
          handle: storedHandle('a3.csv'),
          summary: summary(5),
          exclusionScopeId: null,
        },
      ],
      registry.revision,
    )
    expect(stale).toBeNull()
    expect((await store.handles()).get('src-a')?.name).toBe('a2.csv')
  })

  it('批量修复不能把同一作用域绑定到两个来源', async () => {
    const store = createIndexedDbCsvStore()
    await addOne(store, 'a.csv', 1, 'src-a')
    await addOne(store, 'b.csv', 2, 'src-b')
    const current = await store.load()
    const repaired = await store.repair(
      [
        {
          sourceId: 'src-a',
          handle: storedHandle('a2.csv'),
          summary: summary(1),
          exclusionScopeId: 'scope-shared',
        },
        {
          sourceId: 'src-b',
          handle: storedHandle('b2.csv'),
          summary: summary(2),
          exclusionScopeId: 'scope-shared',
        },
      ],
      current.revision,
    )
    expect(repaired).toBeNull()
    expect((await store.load()).sources.map((source) => source.name)).toEqual([
      'a.csv',
      'b.csv',
    ])
  })

  it('清单版本冲突时不写入沿用规则的作用域 owner', async () => {
    const store = createIndexedDbCsvStore()
    const added = await addOne(store, 'a.csv', 1, 'src-a')
    expect(added.sources).toHaveLength(1)
    await seedScope('scope-a', 1)
    const stale = await store.relink(
      'src-a',
      storedHandle('a2.csv'),
      summary(2),
      999,
      undefined,
      'scope-a',
      undefined,
      {
        scopeId: 'scope-a',
        revision: 1,
        owner: {
          kind: 'csv',
          name: 'a2.csv',
          handle: storedHandle('a2.csv'),
          sourceId: 'src-a',
        },
      },
    )
    expect(stale).toBeNull()
    // 校验失败前不能先写 owner：作用域与清单都保持原样。
    expect(await scopeState('scope-a')).toEqual({ revision: 1, name: '旧.csv' })
    const current = await store.load()
    expect(current.revision).toBe(added.revision)
    expect(current.sources[0]!.name).toBe('a.csv')
  })

  it('后续作用域修订冲突时整批不写，前一个作用域也不换 owner', async () => {
    const store = createIndexedDbCsvStore()
    await addOne(store, 'a.csv', 1, 'src-a')
    const added2 = await addOne(store, 'b.csv', 2, 'src-b')
    await seedScope('scope-a', 1)
    await seedScope('scope-b', 5)
    const repaired = await store.repair(
      [
        {
          sourceId: 'src-a',
          handle: storedHandle('a2.csv'),
          summary: summary(1),
          exclusionScopeId: 'scope-a',
        },
        {
          sourceId: 'src-b',
          handle: storedHandle('b2.csv'),
          summary: summary(2),
          exclusionScopeId: 'scope-b',
        },
      ],
      added2.revision,
      undefined,
      [
        {
          scopeId: 'scope-a',
          revision: 1,
          owner: {
            kind: 'csv',
            name: 'a2.csv',
            handle: storedHandle('a2.csv'),
            sourceId: 'src-a',
          },
        },
        {
          scopeId: 'scope-b',
          revision: 4,
          owner: {
            kind: 'csv',
            name: 'b2.csv',
            handle: storedHandle('b2.csv'),
            sourceId: 'src-b',
          },
        },
      ],
    )
    expect(repaired).toBeNull()
    expect(await scopeState('scope-a')).toEqual({ revision: 1, name: '旧.csv' })
    expect(await scopeState('scope-b')).toEqual({ revision: 5, name: '旧.csv' })
    const current = await store.load()
    expect(current.revision).toBe(added2.revision)
    expect(current.sources.map((source) => source.name)).toEqual(['a.csv', 'b.csv'])
  })

  it('新句柄写入失败时回滚，作用域 owner 与清单都不改变', async () => {
    const store = createIndexedDbCsvStore()
    const added = await addOne(store, 'a.csv', 1, 'src-a')
    await seedScope('scope-a', 1)
    const restore = patchPut((storeName, value) => {
      if (storeName === 'csvHandles' && (value as { sourceId?: string }).sourceId === 'src-a') {
        throw new DOMException('bad handle', 'DataCloneError')
      }
    })
    try {
      await expect(
        store.repair(
          [
            {
              sourceId: 'src-a',
              handle: storedHandle('a2.csv'),
              summary: summary(2),
              exclusionScopeId: 'scope-a',
            },
          ],
          added.revision,
          undefined,
          [
            {
              scopeId: 'scope-a',
              revision: 1,
              owner: {
                kind: 'csv',
                name: 'a2.csv',
                handle: storedHandle('a2.csv'),
                sourceId: 'src-a',
              },
            },
          ],
        ),
      ).rejects.toThrow()
    } finally {
      restore()
    }
    expect(await scopeState('scope-a')).toEqual({ revision: 1, name: '旧.csv' })
    const current = await store.load()
    expect(current.revision).toBe(added.revision)
    expect(current.sources[0]!.name).toBe('a.csv')
    expect((await store.handles()).get('src-a')?.name).toBe('a.csv')
  })
})
