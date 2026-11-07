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
import { createMemoryExclusionStore } from '../src/features/player-stats/statistics-exclusion-store'
import {
  siteScopeId,
} from '../src/features/player-stats/statistics-exclusion'
import type { ExclusionRule } from '../src/features/player-stats/statistics-exclusion'

const {
  updateAnalysis,
  createAnalysisViewMock,
  storeRef,
  exclusionStoreRef,
  appliedScopeRef,
} = vi.hoisted(() => ({
  updateAnalysis: vi.fn(),
  createAnalysisViewMock: vi.fn(),
  storeRef: { current: null as unknown as CsvSourceStore },
  exclusionStoreRef: {
    current: null as unknown as import('../src/features/player-stats/statistics-exclusion-store').StatisticsExclusionStore,
  },
  appliedScopeRef: {
    current: null as unknown as import('../src/features/player-stats/statistics-exclusion-candidates').ExclusionCandidateScope | null,
  },
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
      getBvFloors: () => appliedScopeRef.current?.floors ?? { b: 10, i: 30, e: 100 },
      getAppliedScope: () => appliedScopeRef.current,
      destroy: vi.fn(),
    }
  },
}))
vi.mock('../src/features/player-stats/statistics-exclusion-store', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/features/player-stats/statistics-exclusion-store')>()
  return {
    ...actual,
    // 每个页面使用独立内存规则库，视图测试不触碰扩展数据库。
    createExclusionStore: () => exclusionStoreRef.current,
  }
})

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
  placeholder = ''
  value = ''
  href = ''
  target = ''
  rel = ''
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
    remove: (name: string): void => {
      this.classList.toggle(name, false)
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
  focus(): void {
    if (typeof document !== 'undefined') {
      ;(document as unknown as { activeElement: TestElement }).activeElement = this
    }
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

import { CsvTestHandle as ViewHandle, CSV, csv, deferred, HEADER } from './helpers/stats-csv'

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

/** 两条同等级、同 3BV 的录像，用于验证排除 PB 后重新推导。 */
function loadedTwo(): LoadedPlayer {
  const videos = parseStatsCsv(csv(5000, 6000)).videos
  return {
    userId: 16,
    fetchedAt: 1,
    fromCache: false,
    missing: [],
    rows: videos.map((video, index) => ({
      userId: 16,
      id: index + 1,
      state: 'c',
      uploadTime: video.upload_time,
      ongoing: false,
      detail: { ...video, id: index + 1 },
    })),
  }
}

function leveledRows(
  extras: Array<{ mode: string; time: number; bv: number; day: number }> = [],
): LoadedPlayer {
  const row = (mode: string, time: number, bv: number, day = 2): string =>
    `${day},11,2026,16,1,12,${mode},${time.toFixed(3)},${bv},2.40,Flag,19,21,10,4,0,0,0,0,0,12,3,3,12,1,3,3,3,992,12,12`
  const parsed = parseStatsCsv(
    [
      HEADER,
      row('BEG', 20, 12),
      row('BEG', 40, 12),
      row('EXP', 100, 120),
      row('EXP', 200, 120),
      ...extras.map((item) =>
        row(item.mode, item.time, item.bv, item.day),
      ),
    ].join('\n'),
  )
  const rows = parsed.videos.map((video, index) => ({
    userId: 16,
    id: index + 1,
    uploadTime: video.upload_time,
    state: 'c',
    ongoing: false,
    detail: { ...video, id: index + 1 },
  }))
  return { userId: 16, fetchedAt: 1, fromCache: false, missing: [], rows }
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
const selectWith = (value: string): TestElement =>
  find(
    (node) =>
      node.tag === 'select' &&
      node.all().some((item) => item.tag === 'option' && item.value === value),
  )
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
  exclusionStoreRef.current = createMemoryExclusionStore()
  appliedScopeRef.current = null
  root = new TestElement('div')
  vi.stubGlobal('document', { createElement: (tag: string) => new TestElement(tag), title: '' })
  vi.stubGlobal('location', { search: '?id=16' })
  vi.stubGlobal('chrome', {
    runtime: { getManifest: () => ({ version: 'test' }) },
  })
  stubWindow()
  vi.mocked(loadPlayer).mockResolvedValue(loaded())
  vi.mocked(fetchUserInfo).mockResolvedValue(null)
})
afterEach(() => vi.unstubAllGlobals())

describe('统一关于卡片', () => {
  it('网站页切页与刷新后仍只有一个页面级卡片，且位于内容最后', async () => {
    await mount()
    const cards = root.all().filter((node) => node.classList.contains('about-card'))
    expect(cards).toHaveLength(1)
    const card = cards[0]!
    expect(card.visible()).toBe(true)
    expect(card.textContent).toContain('元神助手 vtest · 开源扫雷网辅助工具')
    const wrap = byClass('player-page')
    expect(wrap.children[wrap.children.length - 1]).toBe(card)

    visibleButton('赛博大表').click()
    await startRefresh()
    await vi.waitFor(() => expect(loadPlayer).toHaveBeenCalledTimes(2))
    expect(root.all().filter((node) => node.classList.contains('about-card'))).toEqual([card])
    expect(wrap.children[wrap.children.length - 1]).toBe(card)
  })

  it('嵌入失败态和独立 CSV 空态也显示卡片', async () => {
    const pending = deferred<LoadedPlayer>()
    vi.mocked(loadPlayer).mockReturnValueOnce(pending.promise)
    await mount('?id=16&embed=analysis')
    pending.reject(new Error('网络不可用'))
    await pending.promise.catch(() => {})
    await Promise.resolve()
    expect(byClass('player-status').textContent).toBe('网络不可用')
    expect(byClass('about-card').visible()).toBe(true)

    await mount('?source=csv')
    expect(byClass('csv-empty').visible()).toBe(true)
    expect(byClass('about-card').visible()).toBe(true)
    expect(root.all().filter((node) => node.classList.contains('about-card'))).toHaveLength(1)
  })
})

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
    await vi.waitFor(() => expect(statusText()).toContain('刷新完成'))
    expect(updateAnalysis.mock.lastCall?.[0]).toHaveLength(1)
  })

  it('取消刷新保留旧统计，晚到的读取不提交', async () => {
    const handle = new ViewHandle('a.csv', csv(5000))
    await seed([handle])
    await mount('?id=16')
    await enterCsv()
    await startRefresh()
    await vi.waitFor(() => expect(statusText()).toContain('刷新完成'))
    expect(updateAnalysis.mock.lastCall?.[0]).toHaveLength(1)
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
    await vi.waitFor(() => expect(statusText()).toContain('刷新完成'))
    expect(updateAnalysis.mock.lastCall?.[0]).toHaveLength(1)

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
    expect(createAnalysisViewMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ autoSiteAnchors: false }),
    )
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

function unmatchedSiteRule(): ExclusionRule {
  return {
    ruleId: 'rule-missing',
    target: { kind: 'site', videoId: 999 },
    excludedAt: 1,
    summary: {
      date: '2026-11-01T00:00:00.000Z',
      level: 'b',
      timems: 5000,
      bv: 12,
      nf: false,
      state: 'c',
      videoId: 999,
      sourceName: '网站数据',
    },
  }
}

async function seedSiteRule(rule: ExclusionRule): Promise<void> {
  const scopeId = siteScopeId('https://openms.top', 16)
  const result = await exclusionStoreRef.current.commit([
    {
      scopeId,
      kind: 'site',
      owner: { kind: 'site', namespace: 'https://openms.top', userId: 16 },
      expectedRevision: 0,
      add: [rule],
      remove: [],
    },
  ])
  expect(result?.changed).toBe(true)
}

describe('统计排除面板', () => {
  it('打开面板排除单条后大表使用候选数据，恢复后复原', async () => {
    await mount()
    await vi.waitFor(() => expect(byClass('pb-count').visible()).toBe(true))
    byClass('exclusion-trigger').click()
    expect(byClass('exclusion-panel').visible()).toBe(true)
    expect(byClass('exclusion-summary').textContent).toContain('读取 1 局')

    visibleButton('排除').click()
    await vi.waitFor(() => expect(updateAnalysis.mock.lastCall?.[0]).toHaveLength(0))
    expect(byClass('exclusion-badge').textContent).toBe('已排除')
    expect(byClass('exclusion-trigger').textContent).toContain('已排除 1')

    visibleButton('恢复计入').click()
    await vi.waitFor(() => expect(updateAnalysis.mock.lastCall?.[0]).toHaveLength(1))
    expect(byClass('exclusion-badge').textContent).toBe('计入')
    expect(byClass('exclusion-trigger').textContent).not.toContain('已排除')
  })

  it('网站普通列表与慢局候选显示 IOE，已排除和缺失点击字段仍按规则展示', async () => {
    const base = parseStatsCsv(CSV).videos[0]!
    const make = (
      id: number,
      detail: Partial<typeof base>,
    ): LoadedPlayer['rows'][number] => {
      const video = { ...base, ...detail, id }
      return {
        userId: 16,
        id,
        uploadTime: video.upload_time,
        state: 'c',
        ongoing: false,
        detail: video,
      }
    }
    vi.mocked(loadPlayer).mockResolvedValueOnce({
      userId: 16,
      fetchedAt: 1,
      fromCache: false,
      missing: [],
      rows: [
        make(1, { bv: 12, left: 1, right: 1, double: 1 }),
        make(2, { bv: 12, left: 2, right: 1, double: 1 }),
        make(3, { left: null }),
        make(4, { left: 0, right: 0, double: 0 }),
      ],
    })
    await seedSiteRule({
      ruleId: 'rule-ioe',
      target: { kind: 'site', videoId: 1 },
      excludedAt: 1,
      summary: {
        date: '2026-11-01T00:00:00.000Z',
        level: 'b',
        timems: 5000,
        bv: 12,
        nf: false,
        state: 'c',
        videoId: 1,
        sourceName: '网站数据',
      },
    })
    await mount()
    await vi.waitFor(() => expect(byClass('pb-count').visible()).toBe(true))
    byClass('exclusion-trigger').click()
    const ioeValues = (): string[] =>
      root
        .all()
        .filter((node) => node.classList.contains('exclusion-ioe'))
        .map((node) => node.textContent)
    expect(ioeValues()).toHaveLength(4)
    expect(ioeValues()).toEqual(expect.arrayContaining(['4.000', '3.000', '—']))

    const viewSelect = find(
      (node) =>
        node.tag === 'select' &&
        node.all().some((item) => item.tag === 'option' && item.value === 'candidates'),
    )
    viewSelect.value = 'candidates'
    viewSelect.emit('change')
    expect(ioeValues()).toHaveLength(3)
    expect(ioeValues()).toContain('3.000')
    expect(ioeValues()).not.toContain('4.000')
  })

  it('刷新进度不清除勾选，数据版本变化后清除旧选择', async () => {
    const pending = deferred<LoadedPlayer>()
    let progress: ((value: { done: number; total: number }) => void) | undefined
    await mount()
    await vi.waitFor(() => expect(byClass('pb-count').visible()).toBe(true))
    byClass('exclusion-trigger').click()
    const rowChecks = (): TestElement[] =>
      root
        .all()
        .filter(
          (node) =>
            node.tag === 'input' &&
            node.classList.contains('exclusion-check') &&
            node.title === '' &&
            node.attributes.get('aria-label') !== undefined,
        )
    const check = rowChecks()[0]!
    check.checked = true
    check.emit('change')
    const batchButton = (): TestElement =>
      find(
        (node) =>
          node.tag === 'button' && node.textContent.startsWith('排除选中'),
      )
    expect(batchButton().textContent).toContain('（1）')

    vi.mocked(loadPlayer).mockImplementationOnce((_id, options) => {
      progress = options?.onProgress
      return pending.promise
    })
    visibleButton('刷新').click()
    progress?.({ done: 1, total: 3 })
    expect(rowChecks()[0]!.checked).toBe(true)
    expect(batchButton().textContent).toContain('（1）')

    pending.resolve(loaded())
    await vi.waitFor(() => expect(byClass('player-status').visible()).toBe(false))
    expect(rowChecks()[0]!.checked).toBe(false)
    expect(batchButton().textContent).not.toContain('（1）')
  })

  it('重新关联文件后清除管理面板旧勾选', async () => {
    const handle = new ViewHandle('a.csv', csv(5000, 6000))
    await seed([handle])
    await mount('?id=16')
    await enterCsv()
    await startRefresh()
    await vi.waitFor(() => expect(updateAnalysis.mock.lastCall?.[0]).toHaveLength(2))
    byClass('exclusion-trigger').click()
    const rowChecks = (): TestElement[] =>
      root
        .all()
        .filter(
          (node) =>
            node.tag === 'input' &&
            node.classList.contains('exclusion-check') &&
            node.title === '' &&
            node.attributes.get('aria-label') !== undefined,
        )
    const check = rowChecks()[0]!
    check.checked = true
    check.emit('change')
    const batch = find(
      (node) => node.tag === 'button' && node.textContent.startsWith('排除选中'),
    )
    expect(batch.textContent).toContain('（1）')

    picker.mockResolvedValue([new ViewHandle('b.csv', csv(7000, 8000))])
    rowButton('a.csv', '重新关联').click()
    await vi.waitFor(() => expect(sourceNames()).toEqual(['b.csv']))
    await vi.waitFor(() => expect(updateAnalysis.mock.lastCall?.[0]).toHaveLength(2))
    expect(rowChecks().every((node) => !node.checked)).toBe(true)
    expect(batch.textContent).not.toContain('（1）')
  })

  it('排除当前 PB 后 PB 表重新推导，恢复后回到原成绩', async () => {
    vi.mocked(loadPlayer).mockResolvedValueOnce(loadedTwo())
    await mount()
    await vi.waitFor(() => expect(byClass('pb-count').visible()).toBe(true))
    const pbCell = (seconds: string): TestElement =>
      find(
        (node) =>
          node.classList.contains('pb-cell') &&
          node.all().some((item) => item.textContent === seconds),
      )
    expect(pbCell('5.000')).toBeDefined()
    byClass('exclusion-trigger').click()

    const row = find(
      (node) =>
        node.tag === 'tr' &&
        node.textContent.includes('5.000') &&
        node.all().some((item) => item.tag === 'button' && item.textContent === '排除'),
    )
    row
      .all()
      .find((item) => item.tag === 'button' && item.textContent === '排除')!
      .click()

    await vi.waitFor(() => expect(pbCell('6.000')).toBeDefined())
    expect(updateAnalysis.mock.lastCall?.[0]).toHaveLength(1)
    visibleButton('恢复计入').click()
    await vi.waitFor(() => expect(pbCell('5.000')).toBeDefined())
    expect(updateAnalysis.mock.lastCall?.[0]).toHaveLength(2)
  })

  it('慢局候选按难度展示中位数与单行均值影响，切换不重建统计', async () => {
    vi.mocked(loadPlayer).mockResolvedValueOnce(leveledRows())
    await mount()
    await vi.waitFor(() => expect(byClass('pb-count').visible()).toBe(true))
    const updates = updateAnalysis.mock.calls.length
    byClass('exclusion-trigger').click()

    const viewSelect = selectWith('candidates')
    viewSelect.value = 'candidates'
    viewSelect.emit('change')

    expect(byClass('exclusion-candidate-bar').visible()).toBe(true)
    expect(byClass('exclusion-candidate-scope').textContent).toContain('全部时段')
    expect(byClass('exclusion-candidate-scope').textContent).toContain('3BV 下限 10/30/100')
    const groups = root
      .all()
      .filter((node) => node.classList.contains('exclusion-group-row'))
    expect(groups).toHaveLength(2)
    expect(groups[0]!.textContent).toContain('初级')
    expect(groups[0]!.textContent).toContain('本范围 2 局')
    expect(groups[0]!.textContent).toContain('中位用时 30.000 秒')
    expect(groups[1]!.textContent).toContain('高级')
    expect(groups[1]!.textContent).toContain('中位用时 150.000 秒')

    const previews = root
      .all()
      .filter((node) => node.classList.contains('exclusion-preview'))
      .map((node) => node.textContent)
    expect(previews).toContainEqual(
      expect.stringContaining('排除此局后，初级平均用时：30.000 → 20.000 秒'),
    )
    expect(previews).toContainEqual(
      expect.stringContaining('排除此局后，高级平均用时：150.000 → 100.000 秒'),
    )

    const sortSelect = selectWith('mean-desc')
    sortSelect.value = 'mean-desc'
    sortSelect.emit('change')
    const sortedPreviews = root
      .all()
      .filter(
        (node) =>
          node.classList.contains('exclusion-preview') &&
          node.textContent.includes('平均用时：'),
      )
    expect(sortedPreviews[0]!.textContent).toContain('初级平均用时')

    const countSelect = selectWith('50')
    countSelect.value = '50'
    countSelect.emit('change')
    expect(updateAnalysis.mock.calls.length).toBe(updates)
  })

  it('直接打开候选可使用大表当前已应用时段，并在重新打开后更新', async () => {
    appliedScopeRef.current = {
      source: 'site',
      sourceId: null,
      start: new Date(2026, 10, 2).getTime(),
      endExclusive: new Date(2026, 10, 3).getTime(),
      levels: ['b', 'i', 'e'],
      software: 'all',
      nfOnly: false,
      floors: { b: 10, i: 30, e: 100 },
      label: '自定义 · 26/11/2–26/11/2',
      origin: 'direct',
    }
    vi.mocked(loadPlayer).mockResolvedValueOnce(
      leveledRows([{ mode: 'EXP', time: 300, bv: 120, day: 5 }]),
    )
    await mount()
    await vi.waitFor(() => expect(byClass('pb-count').visible()).toBe(true))
    byClass('exclusion-trigger').click()
    let viewSelect = selectWith('candidates')
    viewSelect.value = 'candidates'
    viewSelect.emit('change')
    const rangeSelect = selectWith('applied')
    const appliedOption = rangeSelect
      .all()
      .find((item) => item.tag === 'option' && item.value === 'applied')!
    expect(appliedOption.disabled).toBe(false)
    rangeSelect.value = 'applied'
    rangeSelect.emit('change')
    expect(byClass('exclusion-candidate-scope').textContent).toContain('26/11/2')
    expect(byClass('exclusion-group-row').textContent).toContain('本范围 2 局')
    expect(byClass('exclusion-panel').textContent).not.toContain('300.000')

    byClass('exclusion-trigger').click()
    appliedScopeRef.current = {
      ...appliedScopeRef.current,
      start: new Date(2026, 10, 5).getTime(),
      endExclusive: new Date(2026, 10, 6).getTime(),
      label: '自定义 · 26/11/5–26/11/5',
    }
    byClass('exclusion-trigger').click()
    viewSelect = selectWith('candidates')
    viewSelect.value = 'candidates'
    viewSelect.emit('change')
    const nextRange = selectWith('applied')
    nextRange.value = 'applied'
    nextRange.emit('change')
    expect(byClass('exclusion-candidate-scope').textContent).toContain('26/11/5')
    expect(byClass('exclusion-group-row').textContent).toContain('本范围 1 局')
    expect(byClass('exclusion-panel').textContent).toContain('300.000')

    // 切回普通列表后，已应用时段仍在过滤记录，范围说明与修改入口必须可见。
    viewSelect = selectWith('candidates')
    viewSelect.value = 'list'
    viewSelect.emit('change')
    expect(byClass('exclusion-candidate-bar').visible()).toBe(true)
    expect(byClass('exclusion-candidate-scope').textContent).toContain('26/11/5')
    const dateInputs = root
      .all()
      .filter((node) => node.tag === 'input' && node.type === 'date')
    expect(dateInputs.every((node) => !node.visible())).toBe(true)
  })

  it('自定义日期统一列表与候选基准，重开保留范围并正确说明单边日期', async () => {
    vi.mocked(loadPlayer).mockResolvedValueOnce(
      leveledRows([
        { mode: 'BEG', time: 300, bv: 12, day: 5 },
        { mode: 'BEG', time: 400, bv: 12, day: 5 },
      ]),
    )
    await mount()
    await vi.waitFor(() => expect(byClass('pb-count').visible()).toBe(true))
    byClass('exclusion-trigger').click()
    const dateInputs = root
      .all()
      .filter((node) => node.tag === 'input' && node.type === 'date')
    expect(dateInputs).toHaveLength(2)
    dateInputs[0]!.value = '2026-11-02'
    dateInputs[1]!.value = '2026-11-02'
    dateInputs[0]!.emit('input')
    const filtered = byClass('exclusion-panel').textContent
    expect(filtered).toContain('30.000 → 20.000 秒')
    expect(filtered).not.toContain('300.000')
    expect(filtered).not.toContain('400.000')

    const viewSelect = find(
      (node) =>
        node.tag === 'select' &&
        node.all().some((item) => item.tag === 'option' && item.value === 'candidates'),
    )
    viewSelect.value = 'candidates'
    viewSelect.emit('change')
    expect(byClass('exclusion-candidate-scope').textContent).toContain('26/11/2')
    const group = byClass('exclusion-group-row').textContent
    expect(group).toContain('本范围 2 局')
    expect(group).toContain('中位用时 30.000 秒')
    expect(byClass('exclusion-panel').textContent).not.toContain('300.000')
    const rangeSelect = find(
      (node) =>
        node.tag === 'select' &&
        node.all().some((item) => item.tag === 'option' && item.value === 'manual'),
    )
    expect(rangeSelect.value).toBe('manual')

    // 关闭再打开保留自定义日期，均值基准不能退回全时段。
    byClass('exclusion-trigger').click()
    byClass('exclusion-trigger').click()
    const reopenedDates = root
      .all()
      .filter((node) => node.tag === 'input' && node.type === 'date')
    expect(reopenedDates.map((node) => node.value)).toEqual([
      '2026-11-02',
      '2026-11-02',
    ])
    expect(byClass('exclusion-panel').textContent).toContain('30.000 → 20.000 秒')
    expect(byClass('exclusion-panel').textContent).not.toContain('300.000')
    const reopenedViewSelect = find(
      (node) =>
        node.tag === 'select' &&
        node.all().some((item) => item.tag === 'option' && item.value === 'candidates'),
    )
    reopenedViewSelect.value = 'candidates'
    reopenedViewSelect.emit('change')
    expect(byClass('exclusion-group-row').textContent).toContain('本范围 2 局')

    reopenedViewSelect.value = 'list'
    reopenedViewSelect.emit('change')
    reopenedDates[1]!.value = ''
    reopenedDates[1]!.emit('input')
    expect(byClass('exclusion-candidate-scope').textContent).toContain('26/11/2 起')
    expect(byClass('exclusion-candidate-scope').textContent).not.toContain('全部时段')

    reopenedDates[0]!.value = ''
    reopenedDates[1]!.value = '2026-11-05'
    reopenedDates[1]!.emit('input')
    expect(byClass('exclusion-candidate-scope').textContent).toContain('截至 26/11/5')
    expect(byClass('exclusion-candidate-scope').textContent).not.toContain('全部时段')
  })

  it('搜索或修改用时不会重新激活旧的自定义日期范围', async () => {
    vi.mocked(loadPlayer).mockResolvedValueOnce(
      leveledRows([{ mode: 'EXP', time: 300, bv: 120, day: 5 }]),
    )
    await mount()
    await vi.waitFor(() => expect(byClass('pb-count').visible()).toBe(true))
    const options = createAnalysisViewMock.mock.lastCall?.[0] as {
      onViewRecordings?: (scope: unknown) => void
    }

    // 先保存一个 11/2 的自定义日期，然后关闭面板。
    byClass('exclusion-trigger').click()
    const firstDates = root
      .all()
      .filter((node) => node.tag === 'input' && node.type === 'date')
    firstDates[0]!.value = '2026-11-02'
    firstDates[1]!.value = '2026-11-02'
    firstDates[0]!.emit('input')
    byClass('exclusion-trigger').click()

    // 从 11/5 的统计结果进入，应只显示当天录像。
    options.onViewRecordings?.({
      source: 'site',
      sourceId: null,
      start: new Date(2026, 10, 5).getTime(),
      endExclusive: new Date(2026, 10, 6).getTime(),
      levels: ['b', 'i', 'e'],
      software: 'all',
      nfOnly: false,
      floors: { b: 10, i: 30, e: 100 },
      label: '2026/11/5',
      origin: 'jump',
    })
    expect(byClass('exclusion-candidate-scope').textContent).toContain('26/11/5')
    expect(byClass('exclusion-panel').textContent).toContain('300.000')
    expect(byClass('exclusion-panel').textContent).not.toContain('40.000')

    // 搜索当天录像 ID：列表定位条件不得改写日期范围。
    const queryInput = find(
      (node) => node.tag === 'input' && node.placeholder === '录像 ID / 文件名',
    )
    queryInput.value = '5'
    queryInput.emit('input')
    expect(byClass('exclusion-candidate-scope').textContent).toContain('26/11/5')
    expect(byClass('exclusion-panel').textContent).toContain('300.000')
    expect(byClass('exclusion-panel').textContent).not.toContain('40.000')

    // 修改用时下限同样只影响列表定位，不恢复旧日期。
    const minInput = find(
      (node) => node.tag === 'input' && node.placeholder === '用时≥秒',
    )
    minInput.value = '250'
    minInput.emit('input')
    expect(byClass('exclusion-candidate-scope').textContent).toContain('26/11/5')
    expect(byClass('exclusion-panel').textContent).toContain('300.000')
    expect(byClass('exclusion-panel').textContent).not.toContain('40.000')
  })

  it('按 CSV 文件筛选后，均值基准与慢局候选只使用所选文件', async () => {
    const a = new ViewHandle('a.csv', csv(20000, 40000), 'file-a')
    const b = new ViewHandle(
      'b.csv',
      csv(...Array.from({ length: 25 }, (_, index) => 100000 + index * 1000)),
      'file-b',
    )
    await seed([a, b])
    await mount('?source=csv')
    await vi.waitFor(() => expect(byClass('csv-sources').visible()).toBe(true))
    await startRefresh()
    await vi.waitFor(() => expect(updateAnalysis.mock.lastCall?.[0]).toHaveLength(27))
    byClass('exclusion-trigger').click()
    const viewSelect = find(
      (node) =>
        node.tag === 'select' &&
        node.all().some((item) => item.tag === 'option' && item.value === 'candidates'),
    )
    viewSelect.value = 'candidates'
    viewSelect.emit('change')
    expect(byClass('exclusion-group-row').textContent).toContain('候选 20 条')
    expect(byClass('exclusion-group-row').textContent).toContain('本范围 27 局')
    expect(byClass('exclusion-panel').textContent).not.toContain('40.000')

    const sourceSelect = find(
      (node) =>
        node.tag === 'select' &&
        node.all().some(
          (item) => item.tag === 'option' && item.textContent === 'a.csv',
        ),
    )
    const sourceId = sourceSelect
      .all()
      .find((item) => item.tag === 'option' && item.textContent === 'a.csv')!
      .value
    sourceSelect.value = sourceId
    sourceSelect.emit('change')
    const group = byClass('exclusion-group-row').textContent
    expect(group).toContain('本范围 2 局')
    expect(group).toContain('中位用时 30.000 秒')
    const panelText = byClass('exclusion-panel').textContent
    expect(panelText).toContain('a.csv')
    expect(panelText).toContain('0.667')
    expect(panelText).toContain('40.000')
    expect(panelText).toContain('30.000 → 20.000 秒')
    expect(panelText).not.toContain('106.667')
    expect(panelText).not.toContain('200.000')
  })

  it('统计结果入口默认展示范围完整列表，切换候选后仍保留日期与难度', async () => {
    vi.mocked(loadPlayer).mockResolvedValueOnce(
      leveledRows([{ mode: 'EXP', time: 300, bv: 120, day: 5 }]),
    )
    await mount()
    await vi.waitFor(() => expect(byClass('pb-count').visible()).toBe(true))
    const options = createAnalysisViewMock.mock.lastCall?.[0] as {
      onViewRecordings?: (scope: unknown) => void
    }
    options.onViewRecordings?.({
      source: 'site',
      sourceId: null,
      start: new Date(2026, 10, 2).getTime(),
      endExclusive: new Date(2026, 10, 3).getTime(),
      levels: ['e'],
      software: 'all',
      nfOnly: false,
      floors: { b: 10, i: 30, e: 100 },
      label: '2026/11/2–11/2 · 高级',
      origin: 'jump',
    })
    expect(byClass('exclusion-panel').visible()).toBe(true)
    expect(byClass('exclusion-candidate-bar').visible()).toBe(true)
    const scope = byClass('exclusion-candidate-scope').textContent
    expect(scope).toContain('26/11/2')
    expect(scope).toContain('高级')
    expect(scope).toContain('网站数据')
    const listText = byClass('exclusion-panel').textContent
    expect(listText).toContain('100.000')
    expect(listText).toContain('200.000')
    expect(listText).not.toContain('300.000')
    expect(listText).toContain('排除此局后，高级平均用时：150.000 → 100.000 秒')
    expect(
      root.all().filter((node) => node.classList.contains('exclusion-group-row')),
    ).toHaveLength(0)

    const viewSelect = selectWith('candidates')
    viewSelect.value = 'candidates'
    viewSelect.emit('change')
    const groups = root
      .all()
      .filter((node) => node.classList.contains('exclusion-group-row'))
    expect(groups).toHaveLength(1)
    expect(groups[0]!.textContent).toContain('高级')
    expect(groups[0]!.textContent).toContain('本范围 2 局')
    expect(byClass('exclusion-panel').textContent).not.toContain('300.000')
  })

  it('跳转到空日期范围后切回普通列表仍保持空态，不扩大到其他日期', async () => {
    vi.mocked(loadPlayer).mockResolvedValueOnce(leveledRows())
    await mount()
    await vi.waitFor(() => expect(byClass('pb-count').visible()).toBe(true))
    const options = createAnalysisViewMock.mock.lastCall?.[0] as {
      onViewRecordings?: (scope: unknown) => void
    }
    options.onViewRecordings?.({
      source: 'site',
      sourceId: null,
      start: new Date(2026, 10, 6).getTime(),
      endExclusive: new Date(2026, 10, 7).getTime(),
      levels: ['e'],
      software: 'all',
      nfOnly: false,
      floors: { b: 10, i: 30, e: 100 },
      label: '2026/11/6',
      origin: 'jump',
    })
    expect(byClass('exclusion-empty').visible()).toBe(true)
    expect(byClass('exclusion-empty').textContent).toContain('没有符合')
    const viewSelect = find(
      (node) =>
        node.tag === 'select' &&
        node.all().some((item) => item.tag === 'option' && item.value === 'candidates'),
    )
    viewSelect.value = 'candidates'
    viewSelect.emit('change')
    expect(byClass('exclusion-empty').visible()).toBe(true)
    viewSelect.value = 'list'
    viewSelect.emit('change')
    expect(byClass('exclusion-empty').visible()).toBe(true)
    expect(byClass('exclusion-panel').textContent).not.toContain('100.000')
    expect(byClass('exclusion-panel').textContent).not.toContain('200.000')
  })

  it('清除未匹配规则不触发大表重建，面板展示未匹配原因', async () => {
    await seedSiteRule(unmatchedSiteRule())
    await mount()
    await vi.waitFor(() => expect(byClass('pb-count').visible()).toBe(true))
    byClass('exclusion-trigger').click()
    expect(byClass('exclusion-summary').textContent).toContain('当前未匹配 1 条')
    expect(byClass('exclusion-badge').textContent).toBe('当前未匹配')
    const unmatchedRow = find(
      (node) => node.tag === 'tr' && node.classList.contains('exclusion-unmatched-row'),
    )
    expect(
      unmatchedRow.all().find((node) => node.classList.contains('exclusion-ioe'))!
        .textContent,
    ).toBe('—')
    const updates = updateAnalysis.mock.calls.length

    visibleButton('清除规则').click()
    await vi.waitFor(() =>
      expect(byClass('exclusion-feedback').textContent).toContain('已清除 1 条未匹配规则'),
    )
    expect(byClass('exclusion-summary').textContent).toContain('当前未匹配 0 条')
    expect(updateAnalysis.mock.calls.length).toBe(updates)
  })
})
