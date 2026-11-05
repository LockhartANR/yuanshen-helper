import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAnalysisView } from '../src/features/player-stats/analysis-view'
import type { AnalysisView } from '../src/features/player-stats/analysis-view'
import type { Video } from '../src/features/player-stats/model'

// 替代节点与事件派发，直接驱动真实视图处理函数并检查渲染结果；不模拟浏览器布局。
class TestElement {
  children: TestElement[] = []
  parent: TestElement | null = null
  nextElementSibling: TestElement | null = null
  dataset: Record<string, string> = {}
  attributes = new Map<string, string>()
  listeners = new Map<string, Array<(event: { target: TestElement }) => void>>()
  className = ''
  textContent = ''
  private html = ''
  get innerHTML(): string { return this.html }
  set innerHTML(value: string) {
    this.html = value
    this.children = []
    // 只投影动态时段控件，供真实渲染后的焦点与事件测试使用；不模拟表格布局。
    for (const match of value.matchAll(/<select[^>]*data-range-select="([^"]+)"[^>]*>/g)) {
      const select = new TestElement('select')
      select.dataset.rangeSelect = match[1]!
      this.append(select)
    }
    for (const match of value.matchAll(/<div[^>]*data-range-panel="([^"]+)"[^>]*>([\s\S]*?)<\/div>/g)) {
      const panel = new TestElement('div')
      panel.dataset.rangePanel = match[1]!
      for (const inputMatch of match[2]!.matchAll(/<input[^>]*data-range-date="([^"]+)"[^>]*value="([^"]*)"/g)) {
        const input = new TestElement('input')
        input.dataset.rangeDate = inputMatch[1]!
        input.value = inputMatch[2]!
        panel.append(input)
      }
      this.append(panel)
    }
  }
  value = ''
  checked = false
  style = { setProperty: vi.fn(), position: '', opacity: '' }
  /** 复制反馈只写给仍连接在文档中的按钮；测试默认视为已连接。 */
  isConnected = true
  constructor(readonly tag: string) {}
  classList = {
    contains: (name: string): boolean => this.className.split(' ').includes(name),
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
    for (const child of children) { child.parent = this; this.children.push(child) }
  }
  setAttribute(key: string, value: string): void { this.attributes.set(key, value) }
  getAttribute(key: string): string | null {
    if (key.startsWith('data-')) {
      return this.dataset[key.slice(5).replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase())] ?? null
    }
    return this.attributes.get(key) ?? null
  }
  matches(selector: string): boolean {
    if (/^\w+$/.test(selector)) return this.tag === selector
    const match = /^(\w+)?\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector)
    return !!match && (!match[1] || match[1] === this.tag) && this.getAttribute(match[2]!) !== null &&
      (match[3] === undefined || this.getAttribute(match[2]!) === match[3])
  }
  closest(selector: string): TestElement | null {
    return this.matches(selector) ? this : this.parent?.closest(selector) ?? null
  }
  all(): TestElement[] { return [this, ...this.children.flatMap((child) => child.all())] }
  contains(node: TestElement): boolean { return this.all().includes(node) }
  querySelector(selector: string): TestElement | null {
    return this.all().slice(1).find((node) => node.matches(selector)) ?? null
  }
  querySelectorAll(selector: string): TestElement[] {
    return this.all().slice(1).filter((node) => node.matches(selector))
  }
  addEventListener(type: string, listener: (event: { target: TestElement }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  emit(type: string, target: TestElement = this): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ target })
    this.parent?.emit(type, target)
  }
  focus = vi.fn(() => {
    (document as unknown as { activeElement: TestElement }).activeElement = this
  })
  scrollIntoView = vi.fn()
  getBoundingClientRect(): { top: number; bottom: number; height: number } {
    return { top: 0, bottom: 100, height: 100 }
  }
  select(): void {}
  remove(): void {
    this.parent = null
  }
}

const NOW = new Date(2026, 10, 3, 12).getTime()
const date = (day: number) => new Date(2026, 10, day, 6).toISOString()
function video(overrides: Partial<Video> = {}): Video {
  return {
    id: 1, upload_time: date(3), state: 'c', ongoing_tournament: false,
    software: 'e', level: 'b', mode: '00', end_time: date(3), timems: 12000,
    bv: 20, left: 20, right: 2, double: 0, left_ce: 18, right_ce: 2, double_ce: 0,
    path: 800, op: 3, isl: 4, ...overrides,
  }
}

let view: AnalysisView
let root: TestElement
let writeText: ReturnType<typeof vi.fn>
const findClass = (name: string): TestElement => root.all().find((node) => node.classList.contains(name))!
function nav(key: string): void {
  root.all().find((node) => node.dataset.nav === key)!.emit('click')
}
function pick(key: string, owner = 'lsf'): void {
  const select = new TestElement('select')
  select.dataset.rangeSelect = owner
  select.value = key
  root.emit('change', select)
}
function applyDraft(start: string, end: string, owner = 'lsf'): void {
  const panel = new TestElement('div')
  panel.dataset.rangePanel = owner
  for (const [key, value] of [['start', start], ['end', end]]) {
    const input = new TestElement('input')
    input.dataset.rangeDate = key!
    input.value = value!
    panel.append(input)
  }
  const apply = new TestElement('button')
  apply.dataset.rangeApply = ''
  panel.append(apply)
  root.emit('click', apply)
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  // 复制反馈里的 1.2 秒复位不用真的等待。
  vi.stubGlobal('window', {
    setTimeout: () => 0, innerHeight: 800,
    requestAnimationFrame: (callback: () => void) => { callback(); return 0 },
    cancelAnimationFrame: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    disconnect(): void {}
  })
  vi.stubGlobal('document', {
    createElement: (tag: string) => new TestElement(tag),
    createTextNode: (text: string) => Object.assign(new TestElement('#text'), { textContent: text }),
    body: new TestElement('body'),
    execCommand: () => false,
  })
  view = createAnalysisView({ autoSiteAnchors: false })
  root = view.root as unknown as TestElement
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('时段编辑切页', () => {
  it('参数展开时定位编辑区，收起后恢复入口与吸顶', () => {
    const toolbar = findClass('analysis-toolbar')
    const panel = findClass('analysis-settings')
    const button = root.all().find((node) => node.tag === 'button' && node.textContent === '参数')!
    button.emit('click')
    expect(panel.classList.contains('hidden')).toBe(false)
    expect(toolbar.classList.contains('is-static')).toBe(true)
    expect(panel.scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'instant' })
    expect(document.activeElement).toBe(panel.querySelector('input'))
    expect(button.getAttribute('aria-expanded')).toBe('true')
    button.emit('click')
    expect(panel.classList.contains('hidden')).toBe(true)
    expect(toolbar.classList.contains('is-static')).toBe(false)
    expect(document.activeElement).toBe(button)
    expect(button.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'instant' })
  })

  it.each(['global', 'lsf'])('%s 日期编辑打开及校验失败时聚焦开始日期，应用后恢复对应入口', (owner) => {
    if (owner === 'lsf') nav('lsf')
    pick('custom', owner)
    const panelHost = owner === 'global' ? findClass('range-panel-row') : findClass('analysis-view')
    const panel = panelHost.querySelector(`[data-range-panel="${owner}"]`)!
    const start = panel.querySelector('input[data-range-date="start"]')!
    expect(document.activeElement).toBe(start)
    expect(start.focus).toHaveBeenCalledWith({ preventScroll: true })
    expect(panel.scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'instant' })
    applyDraft('2026-11-03', '2026-11-01', owner)
    const invalidPanel = panelHost.querySelector(`[data-range-panel="${owner}"]`)!
    expect(document.activeElement).toBe(invalidPanel.querySelector('input[data-range-date="start"]'))
    expect(invalidPanel.scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'instant' })
    applyDraft('2026-11-01', '2026-11-02', owner)
    const selectHost = owner === 'global' ? findClass('range-select-slot') : findClass('analysis-view')
    const select = selectHost.querySelector(`select[data-range-select="${owner}"]`)!
    expect(document.activeElement).toBe(select)
    expect(select.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'instant' })
  })

  it('全局日期编辑取消后恢复筛选入口，不修改已应用时段', () => {
    pick('today', 'global')
    pick('custom', 'global')
    const cancel = new TestElement('button')
    cancel.dataset.rangeCancel = ''
    root.emit('click', cancel)
    expect(findClass('range-panel-row').classList.contains('hidden')).toBe(true)
    const select = findClass('range-select-slot').querySelector('select[data-range-select="global"]')!
    expect(document.activeElement).toBe(select)
    expect(findClass('range-select-slot').innerHTML).toContain('value="today" selected')
  })

  it.each(['all', 'today'])('打开梁山分页内编辑后切到榜单，恢复已应用的 %s', (key) => {
    nav('lsf')
    pick(key)
    pick('custom')
    expect(findClass('analysis-view').innerHTML).toContain('data-range-panel="lsf"')
    nav('rank')
    expect(findClass('range-select-slot').innerHTML).toContain(`value="${key}" selected`)
    nav('lsf')
    expect(findClass('analysis-view').innerHTML).not.toContain('data-range-panel="lsf"')
    expect(findClass('analysis-view').innerHTML).toContain(`value="${key}" selected`)
  })

  it('重新编辑后切页保留已应用的自定义日期，丢弃未提交草稿', () => {
    nav('lsf')
    pick('custom')
    applyDraft('2026-11-01', '2026-11-02')
    pick('custom')
    const input = new TestElement('input')
    input.dataset.rangeDate = 'start'
    input.value = '2026-10-01'
    root.emit('input', input)
    nav('rank')
    expect(findClass('range-select-slot').innerHTML).toContain('value="custom" selected')
    nav('lsf')
    expect(findClass('analysis-view').innerHTML).not.toContain('data-range-panel="lsf"')
    pick('custom')
    expect(findClass('analysis-view').innerHTML).toContain('value="2026-11-01"')
    expect(findClass('analysis-view').innerHTML).not.toContain('value="2026-10-01"')
  })

  it('全局编辑面板在切页后仍可见且草稿保留', () => {
    nav('lsf')
    pick('custom', 'global')
    nav('rank')
    expect(findClass('range-panel-row').classList.contains('hidden')).toBe(false)
    expect(findClass('range-panel-row').innerHTML).toContain('data-range-panel="global"')
    expect(findClass('range-select-slot').innerHTML).toContain('value="custom" selected')
  })
})

describe('全局与历史共用有效日期', () => {
  it('epoch 结束时间回退到今天上传时间后，今天榜单与梁山分均计入', () => {
    const videos = [video({ end_time: '1970-01-01T00:00:00.000Z' })]
    view.update(videos)
    pick('today', 'global')
    nav('rank')
    expect(findClass('source-note').textContent).toBe('统计样本 1 局')
    expect(findClass('analysis-view').innerHTML).toContain('26/11/3')
    nav('lsf')
    expect(findClass('analysis-view').innerHTML.match(/data-lsf-event-row=/g)).toHaveLength(1)
    expect(findClass('analysis-view').innerHTML).toContain('上传时间')

  })
})

describe('概览今日成绩与样本说明', () => {
  it('三难度都没有今日成绩时显示紧凑空态，隐藏无内容的复制按钮', () => {
    view.update([video({ end_time: date(2) })])
    const html = findClass('analysis-view').innerHTML
    expect(html).toContain('今日暂无成绩')
    expect(html).toContain('不受公共筛选与统计 3BV 下限影响')
    expect(html).not.toContain('today-table')
    expect(html).not.toContain('data-copy-kind="today"')
  })

  it('低于下限的今日成绩在不含今天的范围和 NF 筛选下仍展示完整三难度表', () => {
    view.update([video({ bv: 5, right: 2 })])
    pick('custom', 'global')
    applyDraft('2026-11-01', '2026-11-02', 'global')
    const nf = root.all().find((node) => (node as unknown as { id?: string }).id === 'analysis-nf-global')!
    nf.checked = true
    nf.emit('change')
    expect(findClass('source-note').textContent).toBe('统计样本 0 局 · NF')
    const html = findClass('analysis-view').innerHTML
    expect(html).toContain('today-table')
    expect(html).not.toContain('今日暂无成绩')
    expect(html.match(/data-copy-kind="today"/g)).toHaveLength(3)
    expect(html).toContain('1（1FL/0NF）')
    expect(findClass('sample-floor').textContent).toBe('3BV 下限：初 10 / 中 30 / 高 100')
    nav('lsf')
    expect(findClass('sample-floor').classList.contains('hidden')).toBe(true)
    expect(findClass('source-note').textContent).toContain('全时段有效记录')
    expect(findClass('source-note').textContent).toContain('日期用于历史分析')
  })
})

describe('周 T37 复制', () => {
  const LAST_WEEK = '2026-10-27T04:00:00.000Z'
  const CURRENT_WEEK = '2026-11-03T04:00:00.000Z'
  const CURRENT_START = new Date(2026, 10, 2).getTime()

  function openTrend(): TestElement {
    nav('trend')
    return findClass('analysis-view')
  }

  /** 复制按钮用真实的 data 标识驱动视图处理函数，不依赖渲染出的字符串节点。 */
  function copyButton(kind: string, data: Record<string, string> = {}): TestElement {
    const button = new TestElement('button')
    button.dataset.copyKind = kind
    Object.assign(button.dataset, data)
    return button
  }

  function weekButton(start: number): TestElement {
    return copyButton('week', { copyWeek: String(start) })
  }

  /** 等复制异步链走完；这里只关心写进剪贴板的文本和按钮反馈。 */
  function flush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0))
  }

  function twoWeeks(): void {
    view.update([
      video({ id: 1, end_time: LAST_WEEK }),
      video({ id: 2, end_time: CURRENT_WEEK }),
    ])
  }

  it('每个有成绩周都有带完整日期的复制按钮，明细列跨度正确', () => {
    twoWeeks()
    const html = openTrend().innerHTML
    expect(html).toContain('<button type="button" class="copy-button" data-copy-kind="week"')
    expect(html).toContain('aria-label="复制 2026/10/26 至 2026/11/01 周成绩"')
    expect(html).toContain('aria-label="复制 2026/11/02 至 2026/11/08 周成绩"')
    expect(html).toContain('<th class="copy-cell"></th>')
    expect(html).toContain('<td colspan="8">')
    expect(html).toContain('data-copy-panel="month"')
    expect(html).toContain('data-copy-panel="year"')
    expect(html).toContain('26/11/2 当周明细')
    expect(html).toContain('aria-expanded="false" aria-controls="week-detail-')
  })

  it('复制当前周六行文本，不重绘或收起已展开的明细', async () => {
    twoWeeks()
    const host = openTrend()
    const before = host.innerHTML
    const row = new TestElement('tr')
    row.dataset.weekRow = '1'
    const detail = new TestElement('tr')
    detail.className = 'week-detail hidden'
    row.nextElementSibling = detail
    const button = weekButton(CURRENT_START)
    const toggle = new TestElement('button')
    toggle.dataset.weekToggle = ''
    toggle.textContent = '▸26/11/2'
    row.append(toggle, button)
    host.emit('click', row)
    expect(detail.classList.contains('hidden')).toBe(false)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    host.emit('click', button)
    await flush()
    expect(writeText).toHaveBeenCalledTimes(1)
    const text = writeText.mock.calls[0]![0] as string
    const lines = text.split('\n')
    expect(lines).toHaveLength(6)
    expect(lines[0]).toBe('周成绩 · 2026/11/02–2026/11/08')
    // 两周数据相同，当前周与上一条有成绩周相减为 0，仍输出 +0.0。
    expect(lines[1]).toBe('Games 1 | ΔT37 +0.0')
    // 初 12 秒 + 19 × 10 补位，中 12 × 30，高 5 × 99。
    expect(lines[2]).toBe('T37 1057.0 = 202.0 + 360.0 + 495.0')
    expect(host.innerHTML).toBe(before)
    expect(detail.classList.contains('hidden')).toBe(false)
    expect(row.classList.contains('open')).toBe(true)
    host.emit('click', toggle)
    expect(detail.classList.contains('hidden')).toBe(true)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
  })

  it('未知复制类型直接拒绝，不请求剪贴板', async () => {
    twoWeeks()
    const host = openTrend()
    host.emit('click', copyButton('quarter', { copyKey: '2026', copyLevel: 'b' }))
    await flush()
    expect(writeText).not.toHaveBeenCalled()
  })

  it('复制失败给出失败反馈；节点被重绘替换后不写旧反馈', async () => {
    twoWeeks()
    const host = openTrend()
    writeText.mockRejectedValueOnce(new Error('denied'))
    const failed = weekButton(CURRENT_START)
    host.emit('click', failed)
    await flush()
    expect(failed.textContent).toBe('复制失败')

    const stale = weekButton(CURRENT_START)
    stale.isConnected = false
    host.emit('click', stale)
    await flush()
    expect(stale.textContent).toBe('')
  })

  it('切换月均难度不改变周复制文本', async () => {
    twoWeeks()
    const host = openTrend()
    host.emit('click', weekButton(CURRENT_START))
    await flush()
    const first = writeText.mock.calls[0]![0] as string

    const tab = new TestElement('button')
    tab.dataset.trendLevel = 'b'
    host.emit('click', tab)
    findClass('analysis-view').emit('click', weekButton(CURRENT_START))
    await flush()
    expect(writeText.mock.calls[1]![0]).toBe(first)
  })

  it('月均与年汇总仍按内部键回查，复制与预览日期改为斜杠', async () => {
    twoWeeks()
    const host = openTrend()
    // 数据都是初级，切到初级后月表才有可复制的月份。
    const tab = new TestElement('button')
    tab.dataset.trendLevel = 'b'
    host.emit('click', tab)
    expect(findClass('analysis-view').innerHTML).toContain('复制预览 · 2026/11 · 初级')
    // 按钮上展示的月份也改为斜杠，回查仍用 2026-11 这个内部键。
    expect(findClass('analysis-view').innerHTML).toContain('aria-label="复制 2026/11 初级月均数据"')

    host.emit('click', copyButton('month', { copyKey: '2026-11', copyLevel: 'b' }))
    await flush()
    expect((writeText.mock.calls[0]![0] as string).split('\n')[0]).toBe('月成绩 · 2026/11 · beg')

    host.emit('click', copyButton('year', { copyKey: '2026', copyLevel: 'b' }))
    await flush()
    expect((writeText.mock.calls[1]![0] as string).split('\n')[0]).toBe('年成绩 · 2026 · beg')
  })

  it('月均复制选项与恢复默认仍独立生效', () => {
    twoWeeks()
    openTrend()
    const input = new TestElement('input')
    input.dataset.copyScope = 'month'
    input.dataset.copyField = 'medianTime'
    input.checked = true
    root.emit('change', input)
    nav('rank')
    expect(openTrend().innerHTML).toContain('data-copy-field="medianTime" checked')

    const reset = new TestElement('button')
    reset.dataset.copyReset = 'month'
    findClass('analysis-view').emit('click', reset)
    nav('rank')
    const after = openTrend().innerHTML
    expect(after).not.toContain('data-copy-field="medianTime" checked')
    expect(after).toContain('data-copy-field="medianTime">')
  })

  it('全局时段截断自然周后，统计日期并入首行且不增加行数', async () => {
    twoWeeks()
    pick('today', 'global')
    const host = openTrend()
    expect(host.innerHTML).not.toContain('aria-label="复制 2026/10/26 至 2026/11/01 周成绩"')
    host.emit('click', weekButton(CURRENT_START))
    await flush()
    const lines = (writeText.mock.calls[0]![0] as string).split('\n')
    expect(lines).toHaveLength(6)
    expect(lines[0]).toBe('周成绩 · 2026/11/02–2026/11/08（统计日期 2026/11/03–2026/11/03）')
  })

  it('自定义日期仍能应用，周复制使用新时段', async () => {
    twoWeeks()
    pick('custom', 'global')
    applyDraft('2026-10-27', '2026-10-27', 'global')
    const host = openTrend()
    // 只剩上一条周，当前周的快照已不存在。
    host.emit('click', weekButton(CURRENT_START))
    await flush()
    expect(writeText).not.toHaveBeenCalled()
    host.emit('click', weekButton(new Date(2026, 9, 26).getTime()))
    await flush()
    const lines = (writeText.mock.calls[0]![0] as string).split('\n')
    expect(lines[0]).toBe('周成绩 · 2026/10/26–2026/11/01（统计日期 2026/10/27–2026/10/27）')
  })

  it('软件与只看 NF 标记写在首行末尾，数据源更新后不再复制旧结果', async () => {
    view.update([video({ id: 1, end_time: CURRENT_WEEK, software: 'a', right: 0, right_ce: 0 })])
    const software = root.all().find(
      (node) =>
        node.tag === 'select' &&
        node.children.some((child) => child.tag === 'option' && child.value === 'a'),
    )!
    software.value = 'a'
    software.emit('change')
    const nf = root.all().find(
      (node) => (node as unknown as { id?: string }).id === 'analysis-nf-global',
    )!
    nf.checked = true
    nf.emit('change')

    const host = openTrend()
    host.emit('click', weekButton(CURRENT_START))
    await flush()
    const lines = (writeText.mock.calls[0]![0] as string).split('\n')
    expect(lines).toHaveLength(6)
    expect(lines[0]).toBe('周成绩 · 2026/11/02–2026/11/08 · avf · 仅 NF')

    // 换成另一周的数据源：旧周按钮即使被触发也不能复制旧快照。
    view.update([video({ id: 3, end_time: LAST_WEEK, software: 'a', right: 0, right_ce: 0 })])
    openTrend()
    findClass('analysis-view').emit('click', weekButton(CURRENT_START))
    await flush()
    expect(writeText).toHaveBeenCalledTimes(1)
  })
})

describe('参数面板联动', () => {
  it('修改 3BV 下限立即重筛并保存；非法输入回填且不保存', () => {
    const saved: string[] = []
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: (_key: string, value: string) => saved.push(value),
    })
    view.update([video({ id: 1, bv: 20, end_time: date(2) })])
    expect(findClass('source-note').textContent).toBe('统计样本 1 局')

    const t37 = root.all().find(
      (node) =>
        node.tag === 'table' && node.all().some((cell) => cell.textContent === 'PPP 常数'),
    )!
    const row = t37
      .all()
      .find((node) => node.tag === 'tr' && node.children[0]?.textContent === '初级')!
    const floor = row.children[4]!.children[0]!

    floor.value = '150'
    floor.emit('change')
    expect(findClass('source-note').textContent).toBe('统计样本 0 局')
    expect(findClass('sample-floor').textContent).toBe('3BV 下限：初 150 / 中 30 / 高 100')
    expect(saved).toHaveLength(1)
    expect((JSON.parse(saved[0]!) as { bvFloors: { b: number } }).bvFloors.b).toBe(150)

    floor.value = '0'
    floor.emit('change')
    expect(floor.value).toBe('150')
    expect(saved).toHaveLength(1)
  })
})
