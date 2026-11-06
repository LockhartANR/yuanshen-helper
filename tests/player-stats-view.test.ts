import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountPlayerStats } from '../src/features/player-stats/view'
import { loadPlayer, ensureDetails } from '../src/features/player-stats/service'
import { fetchUserInfo } from '../src/features/player-stats/api'
import type { LoadedPlayer } from '../src/features/player-stats/service'
import { parseStatsCsv } from '../src/features/player-stats/csv'
import {
  createMemoryCsvStore,
  readCsvFile,
} from '../src/features/player-stats/csv-sources'
import type { CsvSourceStore } from '../src/features/player-stats/csv-sources'

const { updateAnalysis, createAnalysisViewMock, storeRef } = vi.hoisted(() => ({
  updateAnalysis: vi.fn(),
  createAnalysisViewMock: vi.fn(),
  storeRef: { current: null as unknown as CsvSourceStore },
}))

vi.mock('../src/features/player-stats/service', () => ({
  loadPlayer: vi.fn(),
  ensureDetails: vi.fn(),
}))
vi.mock('../src/features/player-stats/api', () => ({ fetchUserInfo: vi.fn(async () => null) }))
vi.mock('../src/features/player-stats/analysis-settings', () => ({
  loadAnalysisSettings: () => ({ bvFloors: { b: 10, i: 30, e: 100 }, colorThresholds: [] }),
}))
vi.mock('../src/features/player-stats/colors', () => ({
  configureColors: vi.fn(),
  pbColorStyle: () => null,
  dateColorStyle: () => null,
  medianOf: () => 0,
}))
vi.mock('../src/features/player-stats/software-icon', () => ({ softwareIcon: () => null }))
vi.mock('../src/features/player-stats/analysis-view', () => ({
  createAnalysisView: (options: unknown) => {
    createAnalysisViewMock(options)
    return {
      root: document.createElement('section'),
      update: updateAnalysis,
      destroy: vi.fn(),
    }
  },
}))
vi.mock('../src/features/player-stats/csv-sources', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/features/player-stats/csv-sources')>()
  return {
    ...actual,
    // 视图测试不触碰真实数据库；关联清单放进可控的内存 store。
    createCsvStore: () => storeRef.current,
  }
})

// 只替代本页使用的 DOM 基础操作；事件直接驱动真实 mountPlayerStats 和异步读取逻辑。
// 不模拟浏览器布局，视觉效果仍需浏览器验证。
class TestElement {
  children: TestElement[] = []
  parent: TestElement | null = null
  className = ''
  type = ''
  title = ''
  value = ''
  disabled = false
  checked = false
  files: Array<{ name: string; size: number; text(): Promise<string> }> = []
  attributes = new Map<string, string>()
  listeners = new Map<string, Array<() => void>>()
  private text = ''
  constructor(readonly tag: string) {}
  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join('')
  }
  set textContent(value: string) {
    this.text = value
    this.children = []
  }
  classList = {
    contains: (name: string): boolean => this.className.split(' ').includes(name),
    add: (name: string): void => {
      this.classList.toggle(name, true)
    },
    toggle: (name: string, force?: boolean): boolean => {
      const names = new Set(this.className.split(' ').filter(Boolean))
      const active = force ?? !names.has(name)
      if (active) names.add(name)
      else names.delete(name)
      this.className = [...names].join(' ')
      return active
    },
  }
  append(...children: TestElement[]): void {
    for (const child of children) {
      child.parent = this
      this.children.push(child)
    }
  }
  replaceChildren(...children: TestElement[]): void {
    this.textContent = ''
    this.append(...children)
  }
  setAttribute(key: string, value: string): void {
    this.attributes.set(key, value)
  }
  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener()
  }
  click(): void {
    if (!this.disabled) this.emit('click')
  }
  all(): TestElement[] {
    return [this, ...this.children.flatMap((child) => child.all())]
  }
  visible(): boolean {
    return !this.classList.contains('hidden') && (this.parent?.visible() ?? true)
  }
}

import { CsvTestHandle as ViewHandle, CSV, csv, deferred } from './helpers/stats-csv'

function loaded(): LoadedPlayer {
  const video = { ...parseStatsCsv(CSV).videos[0]!, id: 123 }
  return {
    userId: 16,
    fetchedAt: 1,
    fromCache: false,
    missing: [],
    rows: [
      {
        userId: 16,
        id: video.id,
        state: 'c',
        uploadTime: video.upload_time,
        ongoing: false,
        detail: video,
      },
    ],
  }
}

let root: TestElement
const picker = vi.fn()

const find = (predicate: (node: TestElement) => boolean): TestElement => {
  const node = root.all().find(predicate)
  if (!node) throw new Error('未找到测试节点')
  return node
}
const byClass = (name: string): TestElement =>
  find((node) => node.classList.contains(name))
const visibleButton = (text: string): TestElement =>
  find((node) => node.tag === 'button' && node.textContent === text && node.visible())
const statusText = (): string =>
  find((node) => node.attributes.get('role') === 'status').textContent
const sourceNames = (): string[] =>
  root
    .all()
    .filter((node) => node.classList.contains('csv-source-name'))
    .map((node) => node.textContent)
const sourceRow = (name: string): TestElement =>
  find((node) => node.classList.contains('csv-source') && node.textContent.includes(name))
const rowButton = (name: string, text: string): TestElement => {
  const row = sourceRow(name)
  const node = row
    .all()
    .find((item) => item.tag === 'button' && item.textContent === text)
  if (!node) throw new Error(`文件行缺少按钮：${text}`)
  return node
}

function stubWindow(withPicker = true): void {
  vi.stubGlobal('window', {
    showOpenFilePicker: withPicker ? picker : undefined,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    parent: { postMessage: vi.fn() },
  })
}

async function seed(handles: ViewHandle[]): Promise<void> {
  const store = createMemoryCsvStore()
  for (const handle of handles) {
    const read = await readCsvFile(handle)
    const registry = await store.load()
    await store.addMany(
      [{ sourceId: `seed-${handle.key}`, handle, summary: read.summary }],
      registry.revision,
    )
  }
  storeRef.current = store
}

async function mount(search = '?id=16'): Promise<void> {
  vi.stubGlobal('location', { search })
  await mountPlayerStats(root as unknown as HTMLElement)
}

async function enterCsv(): Promise<void> {
  visibleButton('本地 CSV').click()
  await vi.waitFor(() => expect(byClass('csv-sources').visible()).toBe(true))
}

async function startRefresh(): Promise<void> {
  visibleButton('刷新').click()
}

beforeEach(() => {
  vi.clearAllMocks()
  picker.mockReset()
  storeRef.current = createMemoryCsvStore()
  root = new TestElement('div')
  vi.stubGlobal('document', { createElement: (tag: string) => new TestElement(tag), title: '' })
  vi.stubGlobal('location', { search: '?id=16' })
  stubWindow()
  vi.mocked(loadPlayer).mockResolvedValue(loaded())
  vi.mocked(fetchUserInfo).mockResolvedValue(null)
})
afterEach(() => vi.unstubAllGlobals())

describe('本地 CSV 关联清单', () => {
  it('PB 计数只归属成绩概况，空状态行不占位且初次读取不展示分析空态', async () => {
    const pending = deferred<LoadedPlayer>()
    vi.mocked(loadPlayer).mockReturnValueOnce(pending.promise)
    await mount()
    expect(byClass('pb-grids').visible()).toBe(false)
    expect(byClass('player-status').visible()).toBe(true)
    pending.resolve(loaded())
    await vi.waitFor(() => expect(byClass('pb-count').visible()).toBe(true))
    expect(byClass('pb-count').textContent).toBe('PB 筛选计入 1 局')
    expect(byClass('player-meta').textContent).not.toContain('计入')
    expect(byClass('player-status').visible()).toBe(false)
    visibleButton('赛博大表').click()
    expect(byClass('pb-count').visible()).toBe(false)
    visibleButton('成绩概况').click()
    expect(byClass('pb-count').visible()).toBe(true)
    expect(createAnalysisViewMock).toHaveBeenCalledTimes(1)
  })
  it('普通玩家页默认网站数据，不自动读取已关联文件', async () => {
    const handle = new ViewHandle('a.csv', csv(5000))
    await seed([handle])
    await mount('?id=16')
    expect(loadPlayer).toHaveBeenCalled()
    expect(byClass('player-name').textContent).toBe('#16')
    expect(byClass('csv-sources').visible()).toBe(false)
    expect(handle.reads).toBe(1)
    expect(picker).not.toHaveBeenCalled()
  })

  it('切到本地 CSV 只恢复清单与上次摘要，等待刷新', async () => {
    const handle = new ViewHandle('a.csv', csv(5000, 6000))
    await seed([handle])
    await mount('?id=16')
    await enterCsv()

    expect(byClass('player-name').textContent).toBe('本地 CSV')
    expect(byClass('player-id').textContent).toBe('1 个文件')
    expect(sourceNames()).toEqual(['a.csv'])
    expect(byClass('csv-source-meta').textContent).toContain('上次读取')
    expect(byClass('csv-source-meta').textContent).toContain('2 局')
    expect(byClass('csv-sources-note').textContent).toContain(
      '已关联 1 个文件，点击「刷新」加载成绩',
    )
    expect(byClass('page-tabs').visible()).toBe(false)
    expect(byClass('pb-grids').visible()).toBe(false)
    expect(handle.reads).toBe(1)
  })

  it('刷新后整体加载并显示整批与逐文件变化', async () => {
    const handle = new ViewHandle('a.csv', csv(5000))
    await seed([handle])
    await mount('?id=16')
    await enterCsv()

    handle.text = csv(5000, 6000)
    await startRefresh()
    await vi.waitFor(() => expect(updateAnalysis.mock.lastCall?.[0]).toHaveLength(2))
    expect(updateAnalysis).toHaveBeenLastCalledWith(expect.any(Array), expect.objectContaining({ csv: true }))
    expect(byClass('csv-source-meta').textContent).toContain('已读取')
    expect(byClass('csv-source-delta').textContent).toBe('1 → 2 局')
    expect(statusText()).toContain('刷新完成')
    expect(byClass('csv-sources-note').textContent).toContain('已加载 1 个文件、2 局')
    expect(byClass('page-tabs').visible()).toBe(true)
    expect(byClass('csv-source-meta').textContent).toContain('已读取')
  })

  it('首次选择多个文件时有效项关联，失败项明确列出', async () => {
    const good = new ViewHandle('a.csv', csv(5000, 6000))
    const bad = new ViewHandle('bad.csv', 'bad')
    picker.mockResolvedValue([good, bad])
    await mount('?id=16')
    await enterCsv()

    expect(sourceNames()).toEqual(['a.csv'])
    expect(statusText()).toContain('已添加 1 个文件（2 局）')
    expect(statusText()).toContain('bad.csv')
    expect(updateAnalysis.mock.lastCall?.[0]).toHaveLength(2)
    expect(byClass('page-tabs').visible()).toBe(true)
  })

  it('重复选择同一文件提示使用刷新，不形成重复绑定', async () => {
    const handle = new ViewHandle('a.csv', csv(5000))
    picker.mockResolvedValue([handle])
    await mount('?id=16')
    await enterCsv()
    const before = handle.reads

    picker.mockResolvedValue([new ViewHandle('copy.csv', csv(6000), handle.key)])
    visibleButton('添加 CSV').click()
    await vi.waitFor(() => expect(statusText()).toContain('已在关联清单中'))
    expect(sourceNames()).toEqual(['a.csv'])
    expect(handle.reads).toBe(before)
  })

  it('同名文件来自不同目录时并存并带来源标记', async () => {
    const first = new ViewHandle('stats.csv', csv(5000), 'dir-1')
    const second = new ViewHandle('stats.csv', csv(6000), 'dir-2')
    picker.mockResolvedValue([first, second])
    await mount('?id=16')
    await enterCsv()
    expect(sourceNames()).toEqual(['stats.csv（来源 1）', 'stats.csv（来源 2）'])
  })

  it('刷新失败保留旧成绩与旧成功时间', async () => {
    const handle = new ViewHandle('a.csv', csv(5000))
    await seed([handle])
    await mount('?id=16')
    await enterCsv()
    await startRefresh()
    await vi.waitFor(() => expect(updateAnalysis.mock.lastCall?.[0]).toHaveLength(1))
    const calls = updateAnalysis.mock.calls.length
    const meta = byClass('csv-source-meta').textContent

    handle.getFile = async () => {
      throw new DOMException('gone', 'NotFoundError')
    }
    await startRefresh()
    await vi.waitFor(() => expect(statusText()).toContain('刷新失败'))
    expect(statusText()).toContain('文件不可用，请重新关联')
    expect(updateAnalysis.mock.calls.length).toBe(calls)
    expect(byClass('csv-source-meta').textContent).toBe(meta)
  })

  it('需要授权时提供授权入口，授权后可正常刷新', async () => {
    const handle = new ViewHandle('a.csv', csv(5000))
    handle.permission = 'prompt'
    await seed([handle])
    await mount('?id=16')
    await enterCsv()
    const reads = handle.reads

    await startRefresh()
    await vi.waitFor(() => expect(statusText()).toContain('需要授权读取'))
    expect(handle.reads).toBe(reads)
    expect(byClass('csv-source-flag').textContent).toBe('需要授权')

    rowButton('a.csv', '授权读取').click()
    await vi.waitFor(() => expect(statusText()).toContain('所有文件已授权'))

    await startRefresh()
    await vi.waitFor(() => expect(updateAnalysis.mock.lastCall?.[0]).toHaveLength(1))
    expect(statusText()).toContain('刷新完成')
  })

  it('取消刷新保留旧统计，晚到的读取不提交', async () => {
    const handle = new ViewHandle('a.csv', csv(5000))
    await seed([handle])
    await mount('?id=16')
    await enterCsv()
    await startRefresh()
    await vi.waitFor(() => expect(updateAnalysis.mock.lastCall?.[0]).toHaveLength(1))
    const calls = updateAnalysis.mock.calls.length

    const gate = deferred<File>()
    handle.gate = gate.promise
    handle.reads = 0
    await startRefresh()
    await vi.waitFor(() => expect(handle.reads).toBe(1))
    expect(byClass('csv-sources-note').textContent).toContain('正在读取')

    visibleButton('取消读取').click()
    await vi.waitFor(() => expect(statusText()).toContain('已取消读取'))
    gate.resolve(handle.file())
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(updateAnalysis.mock.calls.length).toBe(calls)
    expect(byClass('csv-source-meta').textContent).toContain('已读取')
  })

  it('移除单个来源后按剩余文件重新汇总', async () => {
    const first = new ViewHandle('a.csv', csv(5000))
    const second = new ViewHandle('b.csv', csv(6000, 7000))
    await seed([first, second])
    await mount('?id=16')
    await enterCsv()
    await startRefresh()
    await vi.waitFor(() => expect(updateAnalysis.mock.lastCall?.[0]).toHaveLength(3))

    rowButton('a.csv', '移除').click()
    await vi.waitFor(() => expect(sourceNames()).toEqual(['b.csv']))
    expect(updateAnalysis.mock.lastCall?.[0]).toHaveLength(2)
    expect(statusText()).toContain('已移除 a.csv')
  })

  it('重新关联替换来源内容但保留清单位置', async () => {
    const first = new ViewHandle('a.csv', csv(5000))
    const second = new ViewHandle('b.csv', csv(6000))
    await seed([first, second])
    await mount('?id=16')
    await enterCsv()
    await startRefresh()
    await vi.waitFor(() => expect(updateAnalysis.mock.lastCall?.[0]).toHaveLength(2))

    picker.mockResolvedValue([new ViewHandle('c.csv', csv(7000, 8000))])
    rowButton('b.csv', '重新关联').click()
    await vi.waitFor(() => expect(sourceNames()).toEqual(['a.csv', 'c.csv']))
    expect(updateAnalysis.mock.lastCall?.[0]).toHaveLength(3)
    expect(statusText()).toContain('已重新关联 c.csv')
  })

  it('独立 CSV 移除全部使进行中的刷新失效并回到空态', async () => {
    const handle = new ViewHandle('a.csv', csv(5000))
    await seed([handle])
    await mount('?source=csv')
    await vi.waitFor(() => expect(byClass('csv-sources').visible()).toBe(true))
    await startRefresh()
    await vi.waitFor(() => expect(updateAnalysis.mock.lastCall?.[0]).toHaveLength(1))

    const gate = deferred<File>()
    handle.gate = gate.promise
    handle.reads = 0
    await startRefresh()
    await vi.waitFor(() => expect(handle.reads).toBe(1))

    visibleButton('移除全部').click()
    await vi.waitFor(() => expect(byClass('csv-empty').visible()).toBe(true))
    expect(sourceNames()).toEqual([])
    gate.resolve(handle.file())
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(sourceNames()).toEqual([])
    expect(updateAnalysis).toHaveBeenLastCalledWith([], expect.objectContaining({ csv: true }))
  })

  it('添加读取期间切回网站，晚到读取不会自动切回 CSV', async () => {
    const existing = new ViewHandle('a.csv', csv(5000))
    await seed([existing])
    await mount('?id=16')
    await enterCsv()

    const slow = new ViewHandle('b.csv', csv(6000))
    const gate = deferred<File>()
    slow.gate = gate.promise
    picker.mockResolvedValue([slow])
    visibleButton('添加 CSV').click()
    await vi.waitFor(() => expect(slow.reads).toBe(1))

    visibleButton('网站数据').click()
    expect(byClass('player-name').textContent).toBe('#16')
    gate.resolve(slow.file())
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(byClass('player-name').textContent).toBe('#16')
    expect(byClass('csv-sources').visible()).toBe(false)
    expect(sourceNames()).toEqual(['a.csv'])
    expect(byClass('player-meta').textContent).toContain('录像')
  })

  it('添加 CSV 选择器返回前切回网站，晚到选择不再新增关联', async () => {
    const existing = new ViewHandle('a.csv', csv(5000))
    await seed([existing])
    await mount('?id=16')
    await enterCsv()

    const gate = deferred<ViewHandle[]>()
    picker.mockReturnValueOnce(gate.promise)
    visibleButton('添加 CSV').click()
    await vi.waitFor(() => expect(picker).toHaveBeenCalledTimes(1))
    visibleButton('网站数据').click()

    const late = new ViewHandle('b.csv', csv(6000))
    gate.resolve([late])
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(byClass('player-name').textContent).toBe('#16')
    expect(sourceNames()).toEqual(['a.csv'])
    expect(late.reads).toBe(0)
    expect((await storeRef.current.load()).sources.map((source) => source.name)).toEqual([
      'a.csv',
    ])
  })

  it('重新关联选择器返回前切回网站，晚到文件不会替换来源', async () => {
    const first = new ViewHandle('a.csv', csv(5000))
    const second = new ViewHandle('b.csv', csv(6000))
    await seed([first, second])
    await mount('?id=16')
    await enterCsv()
    await startRefresh()
    await vi.waitFor(() => expect(updateAnalysis.mock.lastCall?.[0]).toHaveLength(2))

    const gate = deferred<ViewHandle[]>()
    picker.mockReturnValueOnce(gate.promise)
    rowButton('b.csv', '重新关联').click()
    await vi.waitFor(() => expect(picker).toHaveBeenCalledTimes(1))
    visibleButton('网站数据').click()

    const late = new ViewHandle('c.csv', csv(7000))
    gate.resolve([late])
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(byClass('player-name').textContent).toBe('#16')
    expect(sourceNames()).toEqual(['a.csv', 'b.csv'])
    expect(late.reads).toBe(0)
    expect((await storeRef.current.load()).sources.map((source) => source.name)).toEqual([
      'a.csv',
      'b.csv',
    ])
  })

  it('降级模式切源后晚到的文件输入事件被丢弃', async () => {
    stubWindow(false)
    await mount('?id=16')
    visibleButton('本地 CSV').click()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(sourceNames()).toEqual([])

    visibleButton('网站数据').click()
    const input = find((node) => node.type === 'file')
    input.files = [{ name: 'a.csv', size: CSV.length, text: async () => CSV }]
    input.emit('change')
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(byClass('player-name').textContent).toBe('#16')
    expect(sourceNames()).toEqual([])
    expect((await storeRef.current.load()).sources).toEqual([])
  })

  it('恢复清单期间切回网站，不再打开文件选择器', async () => {
    const handle = new ViewHandle('a.csv', csv(5000))
    const base = createMemoryCsvStore()
    const read = await readCsvFile(handle)
    await base.addMany([{ sourceId: 'seed-a', handle, summary: read.summary }], 0)

    const gate = deferred<void>()
    let hold = true
    let started!: () => void
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve
    })
    storeRef.current = {
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

    await mount('?id=16')
    visibleButton('本地 CSV').click()
    await startedPromise
    visibleButton('网站数据').click()
    gate.resolve()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(picker).not.toHaveBeenCalled()
    expect(byClass('player-name').textContent).toBe('#16')
    expect(byClass('csv-sources').visible()).toBe(false)
  })

  it('空清单重获焦点时发现其他页面新增的关联', async () => {
    const base = createMemoryCsvStore()
    storeRef.current = base
    await mount('?source=csv')
    expect(byClass('csv-empty').visible()).toBe(true)

    const handle = new ViewHandle('b.csv', csv(6000))
    const read = await readCsvFile(handle)
    await base.addMany([{ sourceId: 'src-b', handle, summary: read.summary }], 0)

    const win = window as unknown as {
      addEventListener: ReturnType<typeof vi.fn>
    }
    const focus = win.addEventListener.mock.calls.find(([type]) => type === 'focus')?.[1] as
      | (() => void)
      | undefined
    expect(focus).toBeTruthy()
    focus!()
    await vi.waitFor(() => expect(sourceNames()).toEqual(['b.csv']))

    expect(byClass('csv-sources').visible()).toBe(true)
    expect(byClass('csv-empty').visible()).toBe(false)
    expect(byClass('csv-sources-note').textContent).toContain('已关联 1 个文件')
    expect(byClass('csv-sources-note').textContent).toContain('点击「刷新」加载成绩')
    expect(handle.reads).toBe(1)
    expect(updateAnalysis).toHaveBeenLastCalledWith([], expect.objectContaining({ csv: true }))
  })
})

describe('独立 CSV 与降级模式', () => {
  it('首次打开不调用玩家接口，显示空态与格式说明', async () => {
    await mount('?source=csv')
    expect(loadPlayer).not.toHaveBeenCalled()
    expect(ensureDetails).not.toHaveBeenCalled()
    expect(fetchUserInfo).not.toHaveBeenCalled()
    expect(createAnalysisViewMock).toHaveBeenLastCalledWith({ autoSiteAnchors: false })
    expect(byClass('csv-empty').visible()).toBe(true)
    expect(visibleButton('选择 CSV 文件').visible()).toBe(true)
    expect(byClass('page-tabs').visible()).toBe(false)
    expect(byClass('player-name').textContent).toBe('本地 CSV')
    expect(document.title).toBe('本地 CSV · 元神助手')
    expect(updateAnalysis).toHaveBeenLastCalledWith([], expect.objectContaining({ csv: true }))
  })

  it('没有文件句柄 API 时回退到文件输入并提示无法记住', async () => {
    stubWindow(false)
    await mount('?source=csv')
    expect(byClass('csv-empty-remember').visible()).toBe(true)
    expect(byClass('csv-empty-remember').textContent).toContain('不支持记住文件')

    const input = find((node) => node.type === 'file')
    visibleButton('选择 CSV 文件').click()
    input.files = [{ name: 'a.csv', size: CSV.length, text: async () => CSV }]
    input.emit('change')
    await vi.waitFor(() => expect(sourceNames()).toEqual(['a.csv']))
    expect(byClass('csv-empty').visible()).toBe(false)
    expect(updateAnalysis.mock.lastCall?.[0]).toHaveLength(1)
  })
})

describe('站内嵌入模式', () => {
  it('不显示 CSV 关联控件，也不自动恢复清单读取文件', async () => {
    const handle = new ViewHandle('a.csv', csv(5000))
    await seed([handle])
    await mount('?id=16&embed=analysis')
    expect(loadPlayer).toHaveBeenCalledWith(16, expect.objectContaining({ force: false }))
    expect(byClass('csv-sources').visible()).toBe(false)
    expect(byClass('csv-empty').visible()).toBe(false)
    expect(
      root.all().filter((node) => node.tag === 'button' && node.textContent === '添加 CSV' && node.visible()),
    ).toHaveLength(0)
    expect(byClass('page-tabs').visible()).toBe(false)
    expect(handle.reads).toBe(1)
  })

  it('加载进度与失败原因在只有大表时仍然可见', async () => {
    const pending = deferred<LoadedPlayer>()
    vi.mocked(loadPlayer).mockReturnValueOnce(pending.promise)
    await mount('?id=16&embed=analysis')
    const status = byClass('player-status')
    expect(status.visible()).toBe(true)
    expect(status.textContent).toBe('正在获取录像列表…')

    vi.mocked(loadPlayer).mock.calls[0]![1]!.onProgress?.({ done: 1, total: 3 })
    expect(status.textContent).toContain('1/3')

    pending.reject(new Error('网络不可用'))
    await pending.promise.catch(() => {})
    await Promise.resolve()
    expect(status.visible()).toBe(true)
    expect(status.textContent).toBe('网络不可用')
  })
})

describe('原有网站行为', () => {
  it('补抓未过审的旧任务晚到，不覆盖 CSV 或显示加载状态', async () => {
    const initial = loaded()
    initial.rows.push({
      userId: 16,
      id: 124,
      state: 'a',
      uploadTime: '',
      ongoing: false,
      detail: null,
    })
    vi.mocked(loadPlayer).mockResolvedValueOnce(initial)
    const pending = deferred<Awaited<ReturnType<typeof ensureDetails>>>()
    vi.mocked(ensureDetails).mockReturnValueOnce(pending.promise)
    await seed([new ViewHandle('a.csv', csv(5000))])
    await mount()
    const check = find(
      (node) => node.tag === 'input' && node.title.startsWith('把未审核'),
    )
    check.checked = true
    check.emit('change')
    expect(ensureDetails).toHaveBeenCalledTimes(1)

    await enterCsv()
    vi.mocked(ensureDetails).mock.calls[0]![3]!.onProgress?.({ done: 1, total: 1 })
    pending.resolve({ rows: initial.rows, missing: [] })
    await pending.promise
    await Promise.resolve()
    expect(byClass('player-name').textContent).toBe('本地 CSV')
    expect(byClass('player-status').textContent).toBe('')
  })

  it('连续进度通知不重算或替换成绩节点，数据返回后才更新', async () => {
    let refreshProgress: ((progress: { done: number; total: number }) => void) | undefined
    const refresh = deferred<LoadedPlayer>()
    await mount()
    await vi.waitFor(() => expect(byClass('pb-count').visible()).toBe(true))
    const pbNode = byClass('pb-cell')
    const topNode = byClass('top5-cell')

    vi.mocked(loadPlayer).mockImplementationOnce((_id, options) => {
      refreshProgress = options?.onProgress
      return refresh.promise
    })
    visibleButton('刷新').click()
    expect(refreshProgress).toBeTypeOf('function')
    refreshProgress!({ done: 1, total: 3 })
    refreshProgress!({ done: 2, total: 3 })
    expect(byClass('pb-cell')).toBe(pbNode)
    expect(byClass('top5-cell')).toBe(topNode)

    refresh.resolve(loaded())
    await vi.waitFor(() => expect(byClass('pb-cell')).not.toBe(pbNode))
    expect(byClass('top5-cell')).not.toBe(topNode)
  })

  it('启动参数错误时不挂载页面或请求数据', async () => {
    await mount('?id=0')
    expect(root.textContent).toContain('缺少合法的用户 ID')
    expect(root.all().filter((node) => node.tag === 'main')).toHaveLength(0)
    expect(loadPlayer).not.toHaveBeenCalled()
    expect(createAnalysisViewMock).not.toHaveBeenCalled()
  })
})
