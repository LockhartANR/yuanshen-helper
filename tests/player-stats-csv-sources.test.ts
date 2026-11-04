import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  CsvFileError,
  CsvIdentityError,
  buildCsvSnapshot,
  createIndexedDbCsvStore,
  isSameCsvHandle,
  loadCsvRegistry,
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
    expect(updated.handle.name).toBe('renamed.csv')

    const stale = await store.relink('src-a', storedHandle('again.csv'), summary(10), 2)
    expect(stale).toBeNull()
    expect((await loadCsvRegistry()).sources[0]!.name).toBe('renamed.csv')
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

  it('移除与清空只改清单，不触碰其他来源', async () => {
    const store = createIndexedDbCsvStore()
    await addOne(store, 'a.csv', 1, 'src-a')
    await addOne(store, 'b.csv', 2, 'src-b')

    const removed = await store.remove('src-a')
    expect(removed.sources.map((source) => source.sourceId)).toEqual(['src-b'])

    const cleared = await store.clear()
    expect(cleared.sources).toEqual([])
    expect(cleared.revision).toBeGreaterThan(removed.revision)
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
})
