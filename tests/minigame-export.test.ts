import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import SevenZip, { type SevenZipModule } from '7z-wasm'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { bufferToBase64 } from '../src/features/upload-watch/bytes'
import { unpackReplayArchive, validateReplay } from '../src/features/minigame-export/archive'
import { loadHistory, type HistorySource } from '../src/features/minigame-export/client'
import { exportHistory, replayFilename } from '../src/features/minigame-export/export'
import { filterHistory } from '../src/features/minigame-export/filter'
import { densityFraction, modeIdentity, modeLabel, type HistoryMetadata, type HistoryRecord } from '../src/features/minigame-export/model'

const metadata = (id = 1): HistoryMetadata => ({ id, game: 'flag-chord', mode: { key: 'b', rows: 8, columns: 8, total: 4 }, scoreMs: 1234, playedAt: new Date('2026-11-25T12:00:00').getTime() })
const replay = { version: 1, cellSize: 32, initialBoard: [[1, 1, 2]], events: [[0, 10, 20, 3], [15, -2, 0, 4]], specialEvents: [] }
const record = (id = 1): HistoryRecord => ({ metadata: metadata(id), payload: { encoding: 'json', data: replay } })
const source = (): HistorySource => ({ page: vi.fn(), read: vi.fn(async (entry) => record(entry.id)) })

describe('密度显示与单局文件名', () => {
  it.each([
    [50, '1/2'], [75, '3/4'], [87.5, '7/8'], [25, '1/4'], [12.5, '1/8'],
    [33.33, '3333/10000'], [0.0000001, '1/1000000000'], [0, '0/1'], [100, '1/1'],
  ])('将百分比值 %s 显示为最简分数 %s', (value, expected) => {
    expect(densityFraction(value)).toBe(expected)
  })

  it('不把缺失或无效密度伪装成有效分数', () => {
    for (const value of [undefined, null, '50', -1, 101, NaN, Infinity]) expect(densityFraction(value)).toBeUndefined()
  })

  it('模式标签显示尺寸、密度分数与概率，保留原始参数', () => {
    const mode = { key: 'i', rows: 16, columns: 16, density: 75, probability: 25 }
    expect(modeLabel(mode)).toBe('中级 · 16×16 · 密度 3/4 · 概率 25%')
    expect(mode).toEqual({ key: 'i', rows: 16, columns: 16, density: 75, probability: 25 })
  })

  it.each([
    ['b', 50, 'beg-1-2'], ['i', 75, 'int-3-4'], ['e', 87.5, 'exp-7-8'],
  ])('文件名包含难度 %s、密度分数与成绩', (key, density, segment) => {
    const entry: HistoryMetadata = { ...metadata(586), game: 'left-click', mode: { key, density } }
    expect(replayFilename(entry)).toBe(`left-click-${segment}-1.234s-586.json`)
    expect(replayFilename(entry)).not.toMatch(/[<>:"/\\|?*\u0000-\u001f]/)
  })

  it('无密度模式省略密度段，未知难度安全命名，不生成目录', () => {
    expect(replayFilename(metadata(586))).toBe('flag-chord-beg-1.234s-586.json')
    expect(replayFilename({ ...metadata(), mode: { key: '../../自定义:*?' } })).toBe('flag-chord-custom-1.234s-1.json')
    expect(replayFilename({ ...metadata(), mode: { key: 'b', density: Number.MIN_VALUE } })).toBe('flag-chord-beg-custom-density-1.234s-1.json')
  })

  it('成绩使用秒和三位小数，保留毫秒精度', () => {
    expect(replayFilename({ ...metadata(), scoreMs: 1 })).toBe('flag-chord-beg-0.001s-1.json')
    expect(replayFilename({ ...metadata(), scoreMs: 60_000 })).toBe('flag-chord-beg-60.000s-1.json')
    expect(replayFilename({ ...metadata(), scoreMs: Number.MAX_SAFE_INTEGER })).toBe('flag-chord-beg-9007199254740.991s-1.json')
  })
})

let zip: SevenZipModule
beforeAll(async () => {
  zip = await SevenZip({ wasmBinary: Uint8Array.from(readFileSync(fileURLToPath(new URL('../node_modules/7z-wasm/7zz.wasm', import.meta.url)))).buffer,
    print: () => undefined, printErr: () => undefined })
})

async function unzip(blob: Blob): Promise<Record<string, string>> {
  zip.FS.mkdir('/read-back')
  zip.FS.writeFile('/export.zip', new Uint8Array(await blob.arrayBuffer()))
  try {
    expect(Reflect.apply(zip.callMain, zip, [['x', '-y', '-o/read-back', '/export.zip']])).toBe(0)
    return Object.fromEntries(zip.FS.readdir('/read-back').filter((name) => name !== '.' && name !== '..')
      .map((name) => [name, new TextDecoder('utf-8', { fatal: true }).decode(zip.FS.readFile(`/read-back/${name}`))]))
  } finally {
    for (const name of zip.FS.readdir('/read-back')) {
      if (name !== '.' && name !== '..') zip.FS.unlink(`/read-back/${name}`)
    }
    zip.FS.rmdir('/read-back')
    zip.FS.unlink('/export.zip')
  }
}

describe('真实 7z 录像解压', () => {
  function packed(value: unknown): string {
    zip.FS.writeFile('replay.json', JSON.stringify(value))
    expect(Reflect.apply(zip.callMain, zip, [['a', '-t7z', '-m0=LZMA2', '-mx=1', '-md=1m', '-mmt=off', 'fixture.7z', 'replay.json']])).toBe(0)
    const data = bufferToBase64(Uint8Array.from(zip.FS.readFile('fixture.7z')).buffer)
    zip.FS.unlink('fixture.7z')
    zip.FS.unlink('replay.json')
    return data
  }

  it('用站点相同的 LZMA2 参数打包，再无损还原 JSON 和事件顺序', () => {
    const input = packed(replay)
    expect(unpackReplayArchive(input, zip)).toEqual(replay)
    expect(zip.FS.readdir('/')).not.toContain('minigame-export')
  })

  it('坏归档不会污染下一条解压任务', () => {
    expect(() => unpackReplayArchive('AQID', zip)).toThrow()
    expect(unpackReplayArchive(packed(replay), zip)).toEqual(replay)
  })

  it('校验录像类型所需数据与支持的载荷版本', () => {
    expect(() => validateReplay('flag-chord', { ...replay, version: 2 })).toThrow('版本')
    expect(() => validateReplay('left-click', { version: null, events: [] })).toThrow('版本')
    expect(() => validateReplay('reaction', { version: 1, draws: [] })).toThrow('点击')
    expect(() => validateReplay('missing-cell', { version: 1, rounds: [] })).toThrow('各局')
    expect(validateReplay('multi-touch', { version: 1, initialBoard: 'AAAA', events: [] })).toHaveProperty('version', 1)
  })

  it('旧版 JSON 不重新编码、补字段或丢弃附加数据', () => {
    const old = { initialBoard: [[1, 16]], events: [{ timeMs: 0, action: 'rc', row: 1.1, column: 2.2 }], extra: '保留' }
    expect(validateReplay('flag-chord', old)).toEqual(old)
  })
})

describe('本地历史扫描与筛选', () => {
  it('分页合并后按完成时间倒序，跨页传递固定范围与版本', async () => {
    const api = source()
    api.page = vi.fn().mockResolvedValueOnce({ databaseVersion: 3, upperId: 2, nextAfterId: 1, entries: [metadata()], issues: [] })
      .mockResolvedValueOnce({ databaseVersion: 3, upperId: 2, nextAfterId: null, entries: [metadata(2)], issues: [] })
    const result = await loadHistory(api, () => undefined)
    expect(result.entries.map((entry) => entry.id)).toEqual([2, 1])
    expect(api.page).toHaveBeenLastCalledWith(1, 2, 3, undefined)
  })

  it('拒绝停滞分页或中途改变的范围', async () => {
    const api = source()
    api.page = vi.fn(async () => ({ databaseVersion: 3, upperId: 2, nextAfterId: 0, entries: [], issues: [] }))
    await expect(loadHistory(api, () => undefined)).rejects.toThrow('没有前进')
    api.page = vi.fn().mockResolvedValueOnce({ databaseVersion: 3, upperId: 2, nextAfterId: 1, entries: [metadata()], issues: [] })
      .mockResolvedValueOnce({ databaseVersion: 3, upperId: 3, nextAfterId: null, entries: [metadata(2)], issues: [] })
    await expect(loadHistory(api, () => undefined)).rejects.toThrow('已变化')
  })

  it('按本地完整自然日和完整模式筛选，不只比较级别 key', () => {
    const today = metadata()
    const yesterday = { ...metadata(2), playedAt: new Date('2026-11-24T23:59:59').getTime() }
    const otherMode = { ...metadata(3), mode: { ...today.mode, density: 20 } }
    expect(filterHistory([today, yesterday, otherMode], { game: '', mode: '', from: '2026-11-25', to: '2026-11-25' })).toEqual([today, otherMode])
    expect(filterHistory([today, otherMode], { game: 'flag-chord', mode: modeIdentity(today), from: '', to: '' })).toEqual([today])
    expect(() => filterHistory([], { game: '', mode: '', from: '2026-11-26', to: '2026-11-25' })).toThrow('开始日期')
    expect(() => filterHistory([], { game: '', mode: '', from: '2026-02-30', to: '' })).toThrow('有效的日期')
  })

  it.each([
    { timezone: 'Asia/Shanghai', day: '2026-09-06', start: '2026-09-05T16:00:00Z', end: '2026-09-06T16:00:00Z', hours: 24 },
    { timezone: 'America/Santiago', day: '2026-09-05', start: '2026-09-05T04:00:00Z', end: '2026-09-06T04:00:00Z', hours: 24 },
    { timezone: 'America/Santiago', day: '2026-09-06', start: '2026-09-06T04:00:00Z', end: '2026-09-07T03:00:00Z', hours: 23 },
    { timezone: 'America/Santiago', day: '2026-04-04', start: '2026-04-04T03:00:00Z', end: '2026-04-05T04:00:00Z', hours: 25 },
    { timezone: 'America/Los_Angeles', day: '2026-03-08', start: '2026-03-08T08:00:00Z', end: '2026-03-09T07:00:00Z', hours: 23 },
    { timezone: 'America/Los_Angeles', day: '2026-11-01', start: '2026-11-01T07:00:00Z', end: '2026-11-02T08:00:00Z', hours: 25 },
  ])('$timezone 的 $day 按完整 $hours 小时自然日筛选', ({ timezone, day, start, end, hours }) => {
    vi.stubEnv('TZ', timezone)
    try {
      const startTime = Date.parse(start)
      const endTime = Date.parse(end)
      expect(new Date(`${day}T00:00:00`).getTime()).toBe(startTime)
      expect(endTime - startTime).toBe(hours * 60 * 60 * 1000)
      const entries = [startTime - 1, startTime, endTime - 1, endTime, endTime + 30 * 60 * 1000]
        .map((playedAt, index) => ({ ...metadata(index + 1), playedAt }))
      const ids = (from: string, to: string): number[] => filterHistory(entries, { game: '', mode: '', from, to })
        .map((entry) => entry.id)
      expect(ids(day, day)).toEqual([2, 3])
      expect(ids('', day)).toEqual([1, 2, 3])
      expect(ids(day, '')).toEqual([2, 3, 4, 5])
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('单局 JSON 与多局 ZIP 导出', () => {
  it('单条输出完整的单局 JSON 对象', async () => {
    const api = source()
    const decoder = { decode: vi.fn(async () => replay), dispose: vi.fn() }
    const result = await exportHistory(api, decoder, [metadata()], 3, () => undefined)
    expect(result.exported).toBe(1)
    expect(result.filename).toBe('flag-chord-beg-1.234s-1.json')
    expect(JSON.parse(await result.blob!.text())).toEqual({ localId: 1, game: 'flag-chord',
      mode: metadata().mode, scoreMs: 1234, playedAt: metadata().playedAt, replay })
    expect(decoder.dispose).toHaveBeenCalledOnce()
  })

  it('多条打包为标准 ZIP，每个文件与单独导出的 JSON 完全相同', async () => {
    const decoder = { decode: vi.fn(async () => replay), dispose: vi.fn() }
    const now = new Date(2026, 10, 26, 0, 0, 0, 123)
    const entries: HistoryMetadata[] = [metadata(1), { ...metadata(2), game: 'left-click', mode: { key: 'i', density: 75 }, scoreMs: 12_345 }]
    const api = source()
    api.read = vi.fn(async (entry) => ({ ...record(entry.id), metadata: entry }))
    const result = await exportHistory(api, decoder, entries, 3, () => undefined, undefined, now)
    expect(result.blob!.type).toBe('application/zip')
    const zone = new Intl.DateTimeFormat('en', { timeZoneName: 'longOffset' }).formatToParts(now)
      .find((part) => part.type === 'timeZoneName')?.value
    if (!zone) throw new Error('无法读取测试环境的本地时区')
    const offset = (zone.replace('GMT', '') || '+00:00').replace(':', '')
    expect(result.filename).toBe(`openms-minigame-history-2026-11-26T00-00-00-123${offset}.zip`)
    const files = await unzip(result.blob!)
    expect(Object.keys(files).sort()).toEqual(['flag-chord-beg-1.234s-1.json', 'left-click-int-3-4-12.345s-2.json'])
    for (const entry of entries) {
      const single = await exportHistory(api, { decode: vi.fn(async () => replay), dispose: vi.fn() }, [entry], 3, () => undefined)
      expect(files[single.filename]).toBe(await single.blob!.text())
    }
    expect(decoder.dispose).toHaveBeenCalledOnce()
  })

  it.each([{ ids: [1, 2] }, { ids: [1, 2, 3] }])('部分失败时打包成功记录并继续后续导出：$ids', async ({ ids }) => {
    const api = source()
    api.read = vi.fn(async (entry) => { if (entry.id === 2) throw new Error('录像已不存在'); return record(entry.id) })
    const decoder = { decode: vi.fn(async () => replay), dispose: vi.fn() }
    const entries = ids.map((id) => metadata(id))
    const successful = entries.filter((entry) => entry.id !== 2)
    const progress = vi.fn()
    const result = await exportHistory(api, decoder, entries, 3, progress)
    const files = await unzip(result.blob!)
    expect(result.blob!.type).toBe('application/zip')
    expect(Object.keys(files).sort()).toEqual(['errors.txt', ...successful.map(replayFilename)].sort())
    for (const entry of successful) expect(JSON.parse(files[replayFilename(entry)])).toMatchObject({ localId: entry.id, replay })
    expect(files['errors.txt']).toContain(`请求：${entries.length} 条\n成功：${successful.length} 条\n失败：1 条`)
    expect(files['errors.txt']).toContain('#2：录像已不存在')
    expect(result.filename).toMatch(/-partial\.zip$/)
    expect(result.exported).toBe(successful.length)
    expect(result.issues).toHaveLength(1)
    expect(progress).toHaveBeenCalledTimes(entries.length)
    expect(progress).toHaveBeenLastCalledWith({ completed: entries.length, total: entries.length, exported: successful.length, failed: 1 })
    expect(decoder.dispose).toHaveBeenCalledOnce()
  })

  it('读取元信息与选择不一致时拒绝导出', async () => {
    const api = source()
    api.read = vi.fn(async () => record(99))
    const decoder = { decode: vi.fn(async () => replay), dispose: vi.fn() }
    const result = await exportHistory(api, decoder, [metadata()], 3, () => undefined)
    expect(result.blob).toBeNull()
    expect(result.issues[0].error).toContain('不一致')
    expect(decoder.decode).not.toHaveBeenCalled()
  })

  it('多条全部失败不生成只含错误说明的 ZIP', async () => {
    const api = source()
    api.read = vi.fn(async () => { throw new Error('录像已不存在') })
    const decoder = { decode: vi.fn(async () => replay), dispose: vi.fn() }
    const result = await exportHistory(api, decoder, [metadata(1), metadata(2)], 3, () => undefined)
    expect(result.blob).toBeNull()
    expect(result.exported).toBe(0)
    expect(result.issues).toHaveLength(2)
    expect(decoder.dispose).toHaveBeenCalledOnce()
  })

  it('取消时停止后续读取、释放解压器，不返回部分文件', async () => {
    const control = new AbortController()
    const api = source()
    api.read = vi.fn(async (entry) => { control.abort(); return record(entry.id) })
    const decoder = { decode: vi.fn(async () => replay), dispose: vi.fn() }
    await expect(exportHistory(api, decoder, [metadata(1), metadata(2)], 3, () => undefined, control.signal)).rejects.toThrow()
    expect(api.read).toHaveBeenCalledOnce()
    expect(decoder.decode).not.toHaveBeenCalled()
    expect(decoder.dispose).toHaveBeenCalledOnce()
  })

  it('ZIP 已写入首条后取消，不继续读取也不返回残缺文件', async () => {
    const control = new AbortController()
    const api = source()
    const decoder = { decode: vi.fn(async () => replay), dispose: vi.fn() }
    await expect(exportHistory(api, decoder, [metadata(1), metadata(2)], 3, (progress) => {
      if (progress.completed === 1) control.abort()
    }, control.signal)).rejects.toThrow()
    expect(api.read).toHaveBeenCalledOnce()
    expect(decoder.dispose).toHaveBeenCalledOnce()
    const retry = await exportHistory(source(), { decode: vi.fn(async () => replay), dispose: vi.fn() }, [metadata(1), metadata(2)], 3, () => undefined)
    expect(Object.keys(await unzip(retry.blob!))).toHaveLength(2)
  })
})
