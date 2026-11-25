import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountGlobalRanking } from '../src/features/custom-ranking/view'
import {
  getRankingOverview,
  startCollection,
} from '../src/features/custom-ranking/collector'
import { calculateRanking } from '../src/features/custom-ranking/calculation'
import { loadRankingVideoDetails } from '../src/features/custom-ranking/video-details'
import { saveSettings } from '../src/shared/settings'
import { getAllUsers } from '../src/features/user-search/db'

vi.mock('../src/shared/settings', () => ({
  getSettings: async () => ({ apiBase: 'https://mock.test', selfUserId: 1 }),
  saveSettings: vi.fn(async (patch: Record<string, unknown>) => patch),
}))
vi.mock('../src/features/user-search/db', () => ({
  getAllUsers: vi.fn(async () => []),
}))
vi.mock('../src/features/custom-ranking/collector', () => ({
  getRankingOverview: vi.fn(async () => ({
    meta: {
      key: 'https://mock.test',
      startId: 1,
      endId: 0,
      strategyVersion: 2,
      readyDatasetId: null,
      latestDatasetId: null,
      configId: null,
      readyAt: 0,
      updatedAt: 0,
      revision: 0,
    },
    latest: null,
    ready: null,
    task: null,
  })),
  startCollection: vi.fn(),
  normalizeScanRange: vi.fn(),
  RankingAbortError: class extends Error {},
  RankingBusyError: class extends Error {},
  RankingRangeError: class extends Error {},
}))
vi.mock('../src/features/custom-ranking/calculation', () => ({
  calculateRanking: vi.fn(),
}))
vi.mock('../src/features/custom-ranking/video-details', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/features/custom-ranking/video-details')>(),
  loadRankingVideoDetails: vi.fn(),
}))
vi.mock('../src/features/custom-ranking/store', () => ({
  listConfigs: async () => [],
  putConfig: vi.fn(),
  putRankingMeta: vi.fn(),
  getRankingMeta: async () => ({
    key: 'https://mock.test',
    startId: 1,
    endId: 0,
    strategyVersion: 2,
    readyDatasetId: null,
    latestDatasetId: null,
    configId: null,
    readyAt: 0,
    updatedAt: 0,
    revision: 0,
  }),
  deleteConfig: vi.fn(),
  deleteDataset: vi.fn(),
  restoreLatestToReady: vi.fn(),
  clearRankingCache: vi.fn(),
}))

class TestElement {
  children: TestElement[] = []
  parent: TestElement | null = null
  className = ''
  id = ''
  private text = ''
  dataset: Record<string, string> = {}
  attributes = new Map<string, string>()
  title = ''
  type = ''
  value = ''
  selectionStart = 0
  selectionEnd = 0
  placeholder = ''
  spellcheck = true
  hidden = false
  disabled = false
  open = false
  href = ''
  max = 0
  min = 0
  files: Array<{ text(): Promise<string> }> = []
  listeners = new Map<string, Array<() => void>>()
  constructor(readonly tag: string) {}
  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join('')
  }
  set textContent(value: string) {
    this.text = value
    this.children = []
  }
  get classList(): {
    contains(name: string): boolean
    toggle(name: string, force?: boolean): boolean
    add(name: string): void
    remove(name: string): void
  } {
    const names = (): string[] => this.className.split(' ').filter(Boolean)
    return {
      contains: (name) => names().includes(name),
      toggle: (name, force) => {
        const active = force ?? !names().includes(name)
        if (active) {
          if (!names().includes(name)) this.className = [...names(), name].join(' ')
        } else {
          this.className = names().filter((item) => item !== name).join(' ')
        }
        return active
      },
      add: (name) => {
        if (!names().includes(name)) this.className = [...names(), name].join(' ')
      },
      remove: (name) => {
        this.className = names().filter((item) => item !== name).join(' ')
      },
    }
  }
  append(...children: TestElement[]): void {
    for (const child of children) {
      child.parent = this
      this.children.push(child)
    }
  }
  replaceChildren(...children: TestElement[]): void {
    this.children = []
    this.append(...children)
  }
  setAttribute(key: string, value: string): void {
    this.attributes.set(key, value)
  }
  getAttribute(key: string): string | null {
    return this.attributes.get(key) ?? null
  }
  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  click(): void {
    for (const listener of this.listeners.get('click') ?? []) listener()
  }
  showModal(): void {
    this.open = true
  }
  close(): void {
    this.open = false
    this.dispatch('close', undefined)
  }
  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this)
  }
  dispatch(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      ;(listener as (value: unknown) => void)(event)
    }
  }
  scrollIntoView(): void {}
  focus(): void {
    ;(document as unknown as { activeElement: TestElement | null }).activeElement = this
  }
  contains(node: TestElement | null): boolean {
    return node !== null && this.all().includes(node)
  }
  closest(): null {
    return null
  }
  getClientRects(): ArrayLike<unknown> {
    return [{}]
  }
  removeAttribute(key: string): void {
    this.attributes.delete(key)
  }
  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start
    this.selectionEnd = end
  }
  querySelector(selector: string): TestElement | null {
    return this.querySelectorAll(selector)[0] ?? null
  }
  querySelectorAll(selector: string): TestElement[] {
    const byData = /^([a-z]+)\[data-player-id="(\d+)"\]$/.exec(selector)
    if (byData) {
      return this.all().filter(
        (node) => node.tag === byData[1] && node.dataset.playerId === byData[2],
      )
    }
    const byClass = /^([a-z]+)\.([\w-]+)$/.exec(selector)
    if (byClass) {
      return this.all().filter(
        (node) => node.tag === byClass[1] && node.classList.contains(byClass[2]!),
      )
    }
    if (!selector.includes('button') && !selector.includes('input')) return []
    return this.all().filter((node) => {
      if (node.disabled) return false
      if (selector.includes('button') && node.tag === 'button') return true
      if (selector.includes('input') && node.tag === 'input') return true
      if (selector.includes('select') && node.tag === 'select') return true
      return false
    })
  }
  all(): TestElement[] {
    return [this, ...this.children.flatMap((child) => child.all())]
  }
}

let root: TestElement

const inside = (node: TestElement, className: string): boolean => {
  let current: TestElement | null = node
  while (current) {
    if (current.classList.contains(className)) return true
    current = current.parent
  }
  return false
}

beforeEach(() => {
  root = new TestElement('div')
  vi.stubGlobal('document', {
    title: '',
    activeElement: null,
    addEventListener: vi.fn(),
    createElement: (tag: string) => new TestElement(tag),
    createTextNode: (text: string) => Object.assign(new TestElement('#text'), { textContent: text }),
    getElementById: () => null,
  })
  vi.stubGlobal('window', { addEventListener: vi.fn() })
  vi.stubGlobal('chrome', {
    runtime: {
      getURL: (path: string) => path,
      getManifest: () => ({ version: '1.4.0-test' }),
    },
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('全站排行榜页面', () => {
  const readyDataset = () => ({
    id: 'ready',
    baseUrl: 'https://mock.test',
    schemaVersion: 1,
    strategyVersion: 2,
    scanMode: 'sync',
    startId: 1,
    endId: 3,
    endExclusive: 4,
    generation: 1,
    status: 'ready',
    stage: '已完成',
    startedAt: 1,
    updatedAt: 1,
    finishedAt: 1,
    baseDatasetId: null,
    playerCount: 1,
    videoCount: 3,
    detailCount: 3,
    missingDetailCount: 0,
    errorCount: 0,
    intervalDone: 1,
    intervalTotal: 1,
    detailReusedCount: 0,
    responseAnomalies: 0,
    complete: true,
    warnings: [],
  })
  const overviewFor = (ready: ReturnType<typeof readyDataset>) => ({
    meta: {
      key: 'https://mock.test',
      startId: 1,
      endId: 3,
      strategyVersion: 2,
      readyDatasetId: ready.id,
      latestDatasetId: ready.id,
      configId: null,
      readyAt: 1,
      updatedAt: 1,
      revision: 1,
    },
    latest: ready,
    ready: null,
    task: null,
  })
  interface TestPlayer {
    playerId: number
    games: number
    values: number[]
    samples: number[]
  }
  const player = (id: number, ...values: number[]): TestPlayer => ({
    playerId: id,
    games: 3,
    values,
    samples: values.map(() => 3),
  })
  const makeResult = (
    metricIds: string[],
    players: TestPlayer[],
    sortMetricId: string,
    direction: 'asc' | 'desc',
  ) => {
    const index = metricIds.indexOf(sortMetricId)
    const sorted = [...players].sort((left, right) => {
      const diff =
        direction === 'desc'
          ? right.values[index] - left.values[index]
          : left.values[index] - right.values[index]
      return diff || left.playerId - right.playerId
    })
    const rows = sorted.map((item, position) => ({
      rank: position + 1,
      playerId: item.playerId,
      games: item.games,
      values: item.values,
      samples: item.samples,
      valid: item.values.map((value) => Number.isFinite(value)),
    }))
    return {
      players,
      metricIds,
      rows,
      rowIndexById: Object.fromEntries(sorted.map((item, position) => [item.playerId, position])),
      sortMetricId,
      direction,
      datasetId: 'ready',
      configKey: 'x',
      computedAt: 1,
      elapsedMs: 1,
      playerCount: rows.length,
      videoCount: rows.length,
      filteredGames: rows.length,
    }
  }
  const metricRows = (page: TestElement): TestElement[] =>
    page.all().filter((node) => node.classList.contains('ranking-metric-row'))
  const removeButton = (row: TestElement): TestElement =>
    row.all().find((node) => node.tag === 'button' && node.title === '删除指标')!
  const sortButtons = (page: TestElement): TestElement[] =>
    page.all().filter((node) => node.tag === 'button' && node.classList.contains('ranking-sort-button'))
  const metricHeads = (page: TestElement): TestElement[] =>
    page.all().filter((node) => node.tag === 'th' && node.classList.contains('ranking-metric-head'))
  const bodyRows = (page: TestElement): TestElement[] =>
    page.all().filter((node) => node.tag === 'tr' && node.dataset.playerId)
  const valueCells = (page: TestElement): TestElement[] =>
    page.all().filter((node) => node.classList.contains('ranking-metric-value'))
  const fireInput = (node: TestElement, value: string): void => {
    node.value = value
    for (const listener of node.listeners.get('input') ?? []) listener()
  }
  const mountCalculated = async (
    result: ReturnType<typeof makeResult> | Record<string, unknown> & { playerCount: number },
  ): Promise<TestElement> => {
    const ready = readyDataset()
    vi.mocked(getRankingOverview).mockResolvedValue(overviewFor(ready) as never)
    vi.mocked(calculateRanking).mockResolvedValue(result as never)
    await mountGlobalRanking(root as unknown as HTMLElement)
    const page = root.children[0]!
    const calculate = page.all().find(
      (node) => node.tag === 'button' && node.textContent === '计算排行榜',
    )!
    calculate.click()
    await vi.waitFor(() => {
      expect(page.all().find((node) => node.classList.contains('ranking-result-summary'))?.textContent)
        .toContain(`${result.playerCount} 名玩家`)
    })
    return page
  }

  it('空数据时展示采集入口、默认指标、关于卡片且不自动开始采集', async () => {
    await mountGlobalRanking(root as unknown as HTMLElement)
    const page = root.children[0]!
    expect(page.classList.contains('ranking-page')).toBe(true)
    expect(document.title).toBe('全站自定义排行榜 · 元神助手')
    expect(page.textContent).toContain('全站数据集')
    expect(page.textContent).toContain('尚无本地数据集')
    expect(page.textContent).toContain('最高 3BVS')
    expect(page.textContent).toContain('平均 IOE')
    expect(page.textContent).toContain('局数')
    expect(page.textContent).toContain('关于')
    expect(page.textContent).toContain('元神助手 v1.4.0-test · 开源扫雷网辅助工具')
    expect(page.textContent).toContain('尚未保存范围')
    expect(page.textContent).toContain('当前配置：')
    const nodes = page.all()
    const resultsIndex = nodes.findIndex((node) => node.classList.contains('ranking-results'))
    const datasetIndex = nodes.findIndex((node) => node.classList.contains('ranking-dataset'))
    expect(resultsIndex).toBeGreaterThan(-1)
    expect(resultsIndex).toBeLessThan(datasetIndex)
    const toggle = nodes.find(
      (node) => node.tag === 'button' && node.textContent === '筛选与指标设置',
    )!
    expect(toggle.attributes.get('aria-expanded')).toBe('false')
    expect(toggle.attributes.get('aria-controls')).toBe('ranking-settings')
    const sidebar = nodes.find((node) => node.tag === 'aside')!
    expect(sidebar.hidden).toBe(true)
    const calculate = nodes.find(
      (node) => node.tag === 'button' && node.textContent === '计算排行榜',
    )!
    expect(inside(calculate, 'ranking-results')).toBe(true)
    expect(inside(calculate, 'ranking-dataset')).toBe(false)
    const numbers = page.all().filter((node) => node.tag === 'input' && node.type === 'number')
    expect(numbers[0]?.value).toBe('1')
    expect(numbers[1]?.value).toBe('')
    const start = page.all().find((node) => node.tag === 'button' && node.textContent === '开始加载')
    expect(start).toBeTruthy()
    expect(page.all().filter((node) => node.classList.contains('ranking-metric-row'))).toHaveLength(3)
    const notes = page.all().filter((node) => node.classList.contains('ranking-formula-error'))
    expect(notes.every((node) => node.hidden)).toBe(true)
  })

  it('公式编辑错误显示在对应指标且不执行脚本', async () => {
    await mountGlobalRanking(root as unknown as HTMLElement)
    const page = root.children[0]!
    const formula = page.all().find((node) => node.classList.contains('ranking-formula'))!
    formula.value = 'bv / time'
    for (const listener of formula.listeners.get('input') ?? []) listener()
    const error = page.all().find((node) => node.classList.contains('ranking-formula-error'))
    expect(error?.hidden).toBe(false)
    expect(error?.textContent).toContain('聚合函数')
  })

  it('配置侧栏默认收起，展开关闭保留编辑且恢复入口焦点', async () => {
    await mountGlobalRanking(root as unknown as HTMLElement)
    const page = root.children[0]!
    const toggle = page.all().find(
      (node) => node.tag === 'button' && node.textContent === '筛选与指标设置',
    )!
    const sidebar = page.all().find((node) => node.tag === 'aside')!
    expect(sidebar.hidden).toBe(true)
    toggle.click()
    expect(sidebar.hidden).toBe(false)
    expect(toggle.attributes.get('aria-expanded')).toBe('true')
    expect(sidebar.attributes.get('role')).toBe('region')
    const formula = sidebar.all().find((node) => node.classList.contains('ranking-formula'))!
    formula.value = 'max(cl)'
    for (const listener of formula.listeners.get('input') ?? []) listener()
    const close = sidebar.all().find(
      (node) => node.tag === 'button' && node.attributes.get('aria-label') === '关闭筛选与指标设置',
    )!
    close.click()
    expect(sidebar.hidden).toBe(true)
    expect(toggle.attributes.get('aria-expanded')).toBe('false')
    expect((document as unknown as { activeElement: TestElement | null }).activeElement).toBe(toggle)
    toggle.click()
    expect(sidebar.all().find((node) => node.classList.contains('ranking-formula'))?.value)
      .toBe('max(cl)')
  })

  it('同步开始时保留上一份榜单，部分发布后仍保留', async () => {
    const ready = readyDataset()
    const partial = {
      ...ready,
      id: 'partial',
      generation: 2,
      status: 'partial',
      stage: '部分完成',
      baseDatasetId: ready.id,
      intervalDone: 0,
      complete: false,
    }
    const meta = { ...overviewFor(ready).meta, endId: 4 }
    vi.mocked(getRankingOverview)
      .mockResolvedValueOnce({ meta, latest: ready as never, ready: ready as never, task: null })
      .mockResolvedValue({
        meta: { ...meta, latestDatasetId: partial.id },
        latest: partial as never,
        ready: ready as never,
        task: null,
      })
    const calcResult = {
      players: [{ playerId: 1, games: 3, values: [1, 1, 3], samples: [3, 3, 3] }],
      metricIds: ['speed', 'ioe', 'games'],
      rows: [{ rank: 1, playerId: 1, games: 3, values: [1, 1, 3], samples: [3, 3, 3], valid: [true, true, true] }],
      rowIndexById: { 1: 0 },
      sortMetricId: 'speed',
      direction: 'desc' as const,
      datasetId: ready.id,
      configKey: 'x',
      computedAt: 1,
      elapsedMs: 1,
      playerCount: 1,
      videoCount: 3,
      filteredGames: 3,
    }
    let resolveCalculation!: (value: typeof calcResult) => void
    vi.mocked(calculateRanking).mockReturnValue(
      new Promise<typeof calcResult>((resolve) => {
        resolveCalculation = resolve
      }) as never,
    )
    vi.mocked(startCollection).mockResolvedValue({
      task: null as never,
      dataset: partial as never,
      complete: false,
      message: '部分发布',
    })

    await mountGlobalRanking(root as unknown as HTMLElement)
    const page = root.children[0]!
    const calculate = page.all().find((node) => node.tag === 'button' && node.textContent === '计算排行榜')
    expect(calculate).toBeTruthy()
    calculate!.click()
    await vi.waitFor(() => expect(calculateRanking).toHaveBeenCalledTimes(1))
    // 计算尚未返回时修改显示精度：结果仍应被接纳，并按新精度显示。
    const digits = page.all().find((node) => node.classList.contains('ranking-digits'))!
    digits.value = '1'
    for (const listener of digits.listeners.get('input') ?? []) listener()
    resolveCalculation(calcResult)
    await vi.waitFor(() => {
      expect(page.all().find((node) => node.classList.contains('ranking-result-summary'))?.textContent)
        .toContain('1 名玩家')
    })
    expect(page.textContent).toContain('1.0有效')
    expect(vi.mocked(calculateRanking).mock.calls.length).toBe(1)
    const formulaInput = page.all().find((node) => node.classList.contains('ranking-formula'))!
    formulaInput.value = 'max(cl)'
    for (const listener of formulaInput.listeners.get('input') ?? []) listener()
    expect(page.textContent).toContain('旧口径结果')
    expect(page.all().find((node) => node.classList.contains('ranking-result-summary'))?.textContent)
      .toContain('1 名玩家')
    expect(vi.mocked(calculateRanking).mock.calls.length).toBe(1)
    const before = page.all().find((node) => node.classList.contains('ranking-result-summary'))!.textContent
    const sync = page.all().find((node) => node.tag === 'button' && node.textContent === '同步录像')
    expect(sync).toBeTruthy()
    sync!.click()
    await vi.waitFor(() => expect(startCollection).toHaveBeenCalled())
    await vi.waitFor(() => expect(page.textContent).toContain('部分发布'))
    expect(page.all().find((node) => node.classList.contains('ranking-result-summary'))!.textContent)
      .toBe(before)
    expect(page.textContent).toContain('当前显示上一份完整快照')
  })

  it('每页数量默认 20，可切换并保存为本机偏好', async () => {
    await mountGlobalRanking(root as unknown as HTMLElement)
    const page = root.children[0]!
    const select = page.all().find((node) => node.classList.contains('ranking-page-size-select'))!
    expect(select.value).toBe('20')
    expect(select.children.map((child) => child.textContent)).toEqual(['20', '50', '100', '200'])
    select.value = '100'
    for (const listener of select.listeners.get('change') ?? []) listener()
    expect(saveSettings).toHaveBeenCalledWith({ rankingPageSize: 100 })
  })

  it('搜索候选可跨页定位高亮，表头切换单指标排序后清除高亮', async () => {
    vi.mocked(getAllUsers).mockResolvedValue([{ id: 21, username: 'Target' }] as never)
    const players = Array.from({ length: 25 }, (_, index) => {
      const id = index + 1
      return player(id, 26 - id, id, 3)
    })
    const page = await mountCalculated(
      makeResult(['speed', 'ioe', 'games'], players, 'speed', 'desc'),
    )
    expect(page.all().find((node) => node.classList.contains('ranking-pager-text'))?.textContent)
      .toBe('共 25 位玩家 · 第 1 / 2 页')

    const searchInput = page.all().find((node) => node.classList.contains('ranking-search-input'))!
    searchInput.value = 'Target'
    for (const listener of searchInput.listeners.get('input') ?? []) listener()
    const candidate = page.all().find((node) => node.classList.contains('ranking-search-option'))!
    expect(candidate.textContent).toContain('Target')
    expect(candidate.textContent).toContain('第 21 名')
    candidate.click()
    expect(page.all().find((node) => node.classList.contains('ranking-search-feedback'))?.textContent)
      .toBe('已定位玩家 #21，第 2 页')
    const located = page.all().find((node) => node.classList.contains('is-located'))!
    expect(located.dataset.playerId).toBe('21')
    expect((document as unknown as { activeElement: TestElement | null }).activeElement?.classList.contains('ranking-player-link')).toBe(true)

    const sortButton = page.all().find((node) => node.tag === 'button' && node.textContent === '平均 IOE')!
    sortButton.click()
    expect(page.all().find((node) => node.classList.contains('ranking-pager-text'))?.textContent)
      .toBe('共 25 位玩家 · 第 1 / 2 页')
    expect(page.all().some((node) => node.classList.contains('is-located'))).toBe(false)
    const heads = page.all().filter((node) => node.tag === 'th' && node.classList.contains('ranking-metric-head'))
    expect(heads[0]?.attributes.has('aria-sort')).toBe(false)
    expect(heads[1]?.attributes.get('aria-sort')).toBe('descending')
  })

  it('删除后新增指标不复用旧 ID，不显示旧数值且表头禁用', async () => {
    vi.mocked(getAllUsers).mockResolvedValue([])
    await mountGlobalRanking(root as unknown as HTMLElement)
    const page = root.children[0]!
    page.all().find((node) => node.tag === 'button' && node.textContent === '添加指标')!.click()
    const firstRows = metricRows(page)
    const oldId = firstRows.at(-1)!.dataset.metricId!
    const ids = firstRows.map((row) => row.dataset.metricId!)
    vi.mocked(getRankingOverview).mockResolvedValue(overviewFor(readyDataset()) as never)
    vi.mocked(calculateRanking).mockResolvedValue(
      makeResult(ids, [player(1, 9, 8, 7, 6)], ids[0]!, 'desc') as never,
    )
    const calculate = page.all().find(
      (node) => node.tag === 'button' && node.textContent === '计算排行榜',
    )!
    calculate.click()
    await vi.waitFor(() => {
      expect(page.all().find((node) => node.classList.contains('ranking-result-summary'))?.textContent)
        .toContain('1 名玩家')
    })
    expect(valueCells(page).at(-1)?.textContent).toContain('6.000')
    expect(sortButtons(page).at(-1)?.disabled).toBe(false)

    removeButton(metricRows(page).at(-1)!).click()
    expect(metricRows(page)).toHaveLength(3)
    page.all().find((node) => node.tag === 'button' && node.textContent === '添加指标')!.click()
    const newId = metricRows(page).at(-1)!.dataset.metricId!
    expect(newId).not.toBe(oldId)
    expect(valueCells(page)).toHaveLength(4)
    expect(valueCells(page).at(-1)?.textContent).toContain('—')
    expect(sortButtons(page).at(-1)?.disabled).toBe(true)
    expect(page.textContent).toContain('新加的指标尚未计算')
  })

  it('删除默认排序指标后按新默认重排并重置分页、候选与高亮', async () => {
    vi.mocked(getAllUsers).mockResolvedValue([{ id: 21, username: 'Target' }] as never)
    const players = Array.from({ length: 25 }, (_, index) => {
      const id = index + 1
      return player(id, 26 - id, id, 3)
    })
    const page = await mountCalculated(
      makeResult(['speed', 'ioe', 'games'], players, 'speed', 'desc'),
    )
    expect(bodyRows(page)[0]?.dataset.playerId).toBe('1')

    const searchInput = page.all().find((node) => node.classList.contains('ranking-search-input'))!
    fireInput(searchInput, 'Target')
    page.all().find((node) => node.classList.contains('ranking-search-option'))!.click()
    expect(page.all().find((node) => node.classList.contains('ranking-search-feedback'))?.textContent)
      .toContain('已定位玩家 #21，第 2 页')
    expect(page.all().find((node) => node.classList.contains('is-located'))).toBeTruthy()
    fireInput(searchInput, '21')
    const candidateList = page.all().find((node) => node.classList.contains('ranking-search-options'))!
    expect(candidateList.hidden).toBe(false)

    removeButton(metricRows(page)[0]!).click()
    expect(bodyRows(page)[0]?.dataset.playerId).toBe('25')
    const heads = metricHeads(page)
    expect(heads).toHaveLength(2)
    expect(heads[0]?.attributes.get('aria-sort')).toBe('descending')
    expect(sortButtons(page)[0]?.textContent).toContain('平均 IOE ↓')
    expect(page.all().find((node) => node.classList.contains('ranking-pager-text'))?.textContent)
      .toBe('共 25 位玩家 · 第 1 / 2 页')
    expect(page.all().some((node) => node.classList.contains('is-located'))).toBe(false)
    expect(candidateList.hidden).toBe(true)
    expect(page.all().find((node) => node.classList.contains('ranking-search-feedback'))?.textContent)
      .toBe('')
  })

  it('删除临时排序列后回到默认指标', async () => {
    vi.mocked(getAllUsers).mockResolvedValue([])
    const players = [player(1, 1, 3, 3), player(2, 3, 1, 3), player(3, 2, 2, 3)]
    const page = await mountCalculated(
      makeResult(['speed', 'ioe', 'games'], players, 'speed', 'desc'),
    )
    expect(bodyRows(page)[0]?.dataset.playerId).toBe('2')
    page.all().find((node) => node.tag === 'button' && node.textContent === '平均 IOE')!.click()
    expect(bodyRows(page)[0]?.dataset.playerId).toBe('1')
    expect(metricHeads(page)[1]?.attributes.get('aria-sort')).toBe('descending')

    removeButton(metricRows(page)[1]!).click()
    expect(bodyRows(page)[0]?.dataset.playerId).toBe('2')
    expect(metricHeads(page)).toHaveLength(2)
    expect(metricHeads(page)[0]?.attributes.get('aria-sort')).toBe('descending')
    expect(sortButtons(page)[0]?.textContent).toContain('最高 3BVS ↓')
    expect(page.textContent).not.toContain('默认排序指标尚未计算，当前按')
  })

  it('默认指标尚未计算时删除当前排序列会选可用列并明确提示', async () => {
    vi.mocked(getAllUsers).mockResolvedValue([])
    const players = [player(1, 1, 3, 3), player(2, 3, 1, 3), player(3, 2, 2, 3)]
    const page = await mountCalculated(
      makeResult(['speed', 'ioe', 'games'], players, 'speed', 'desc'),
    )
    page.all().find((node) => node.tag === 'button' && node.textContent === '添加指标')!.click()
    const newId = metricRows(page).at(-1)!.dataset.metricId!
    const defaultSort = page.all().find((node) => node.classList.contains('ranking-default-sort-select'))!
    defaultSort.value = newId
    for (const listener of defaultSort.listeners.get('change') ?? []) listener()
    expect(metricHeads(page)[0]?.attributes.get('aria-sort')).toBe('descending')

    removeButton(metricRows(page)[0]!).click()
    expect(bodyRows(page)[0]?.dataset.playerId).toBe('1')
    expect(metricHeads(page)[0]?.attributes.get('aria-sort')).toBe('descending')
    expect(sortButtons(page)[0]?.textContent).toContain('平均 IOE ↓')
    expect(page.textContent).toContain('默认排序指标尚未计算，当前按「平均 IOE」排序')
  })

  it('重复点击当前表头不反转方向，切换表头采用各自设置的方向', async () => {
    vi.mocked(getAllUsers).mockResolvedValue([])
    const players = [player(1, 1, 3, 3), player(2, 3, 1, 3), player(3, 2, 2, 3)]
    const page = await mountCalculated(
      makeResult(['speed', 'ioe', 'games'], players, 'speed', 'desc'),
    )
    expect(bodyRows(page)[0]?.dataset.playerId).toBe('2')
    const speedButton = (): TestElement =>
      sortButtons(page).find((button) => button.textContent.includes('最高 3BVS'))!
    expect(speedButton().title).toBe('当前排序指标，方向在指标设置中修改')

    speedButton().click()
    expect(metricHeads(page)[0]?.attributes.get('aria-sort')).toBe('descending')
    expect(sortButtons(page)[0]?.textContent).toContain('最高 3BVS ↓')
    expect(bodyRows(page)[0]?.dataset.playerId).toBe('2')

    const ioeButton = sortButtons(page).find((button) => button.textContent === '平均 IOE')!
    expect(ioeButton.title).toBe('按此指标排序')
    ioeButton.click()
    expect(metricHeads(page)[0]?.attributes.has('aria-sort')).toBe(false)
    expect(metricHeads(page)[1]?.attributes.get('aria-sort')).toBe('descending')
    expect(bodyRows(page)[0]?.dataset.playerId).toBe('1')
  })

  it('只有当前排序指标的方向修改会立即重排，其他指标只保存设置', async () => {
    vi.mocked(getAllUsers).mockResolvedValue([])
    const players = [player(1, 1, 3, 3), player(2, 3, 1, 3), player(3, 2, 2, 3)]
    const page = await mountCalculated(
      makeResult(['speed', 'ioe', 'games'], players, 'speed', 'desc'),
    )
    const directionOf = (index: number): TestElement =>
      metricRows(page)[index]!.all().find(
        (node) => node.tag === 'select' && node.classList.contains('ranking-direction'),
      )!

    // 修改非当前指标：只更新设置，不抢走当前排序。
    const ioeDirection = directionOf(1)
    ioeDirection.value = 'asc'
    ioeDirection.dispatch('change', {})
    expect(bodyRows(page)[0]?.dataset.playerId).toBe('2')
    expect(metricHeads(page)[1]?.attributes.has('aria-sort')).toBe(false)

    // 切换到该指标时使用刚设置的方向。
    sortButtons(page).find((button) => button.textContent === '平均 IOE')!.click()
    expect(bodyRows(page)[0]?.dataset.playerId).toBe('2')
    expect(metricHeads(page)[1]?.attributes.get('aria-sort')).toBe('ascending')

    // 修改当前指标的方向：立即重排并更新名次。
    const currentDirection = directionOf(1)
    currentDirection.value = 'desc'
    currentDirection.dispatch('change', {})
    expect(bodyRows(page)[0]?.dataset.playerId).toBe('1')
    expect(metricHeads(page)[1]?.attributes.get('aria-sort')).toBe('descending')
    expect(sortButtons(page)[1]?.textContent).toContain('平均 IOE ↓')
  })

  it('指标录像支持分页，返回榜单后关闭明细可恢复入口焦点', async () => {
    vi.mocked(loadRankingVideoDetails).mockResolvedValueOnce({
      validCount: 51,
      videos: Array.from({ length: 51 }, (_, index) => ({
        videoId: index + 1,
        value: 2,
        fields: [20, 10],
      })),
    })
    const page = await mountCalculated({
      ...makeResult(['speed', 'ioe', 'games'], [player(7, 2, 1, 51)], 'speed', 'desc'),
      datasetVideoVersion: '1:51',
    })
    const videoTriggers = () => page.querySelectorAll('button.ranking-video-trigger')
    const triggers = videoTriggers()
    expect(triggers).toHaveLength(1)
    triggers[0]!.click()
    const dialog = page.all().find((node) => node.tag === 'dialog')!
    const links = () => dialog.querySelectorAll('a.site-link')
    await vi.waitFor(() => expect(links()).toHaveLength(50))
    dialog.all().find((node) => node.tag === 'button' && node.textContent === '下一页')!.click()
    expect(links().map((link) => link.href)).toEqual(['https://openms.top/#/video/51'])
    expect(loadRankingVideoDetails).toHaveBeenCalledWith(expect.objectContaining({
      datasetId: 'ready',
      version: '1:51',
      playerId: 7,
      value: 2,
    }), expect.any(AbortSignal))
    const close = dialog.all().find((node) => node.tag === 'button' && node.textContent === '关闭')!
    const focusListener = vi.mocked(window.addEventListener).mock.calls.find(([type]) => type === 'focus')?.[1]
    if (typeof focusListener !== 'function') throw new Error('未注册窗口焦点刷新')
    const refresh = () => focusListener.call(window, new Event('focus'))
    close.focus()
    refresh()
    await vi.waitFor(() => expect(videoTriggers()[0]).not.toBe(triggers[0]))
    const replacement = videoTriggers()[0]
    close.click()
    expect(page.all().some((node) => node.tag === 'dialog')).toBe(false)
    expect(document.activeElement).toBe(replacement)

    // 刷新也可能在明细关闭后才完成。
    refresh()
    await vi.waitFor(() => expect(videoTriggers()[0]).not.toBe(replacement))
    expect(document.activeElement).toBe(videoTriggers()[0])
  })
})
