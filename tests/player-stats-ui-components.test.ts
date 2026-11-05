import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ANALYSIS_SETTINGS } from '../src/features/player-stats/analysis-settings'
import type { AnalysisSettings } from '../src/features/player-stats/analysis-settings'
import { anchorKey } from '../src/features/player-stats/ratings'
import { createEditorFocus } from '../src/features/player-stats/ui/editor-focus'
import { createSettingsPanel } from '../src/features/player-stats/ui/settings-panel'

/** 只提供组件实际用到的 DOM 能力；不模拟布局，尺寸由测试固定。 */
class FakeNode {
  readonly children: FakeNode[] = []
  parent: FakeNode | null = null
  className = ''
  textContent = ''
  value = ''
  type = ''
  min = ''
  max = ''
  step = ''
  rows = 0
  isConnected = true
  listeners = new Map<string, Array<() => void>>()
  styleProps = new Map<string, string>()
  style = { setProperty: (key: string, value: string) => this.styleProps.set(key, value) }
  classList = {
    contains: (name: string): boolean => this.className.split(' ').filter(Boolean).includes(name),
    toggle: (name: string, force?: boolean): boolean => {
      const names = new Set(this.className.split(' ').filter(Boolean))
      const active = force ?? !names.has(name)
      if (active) names.add(name)
      else names.delete(name)
      this.className = [...names].join(' ')
      return active
    },
  }
  focus = vi.fn()
  scrollIntoView = vi.fn()
  constructor(readonly tag: string) {}
  append(...nodes: FakeNode[]): void {
    for (const node of nodes) {
      node.parent = this
      this.children.push(node)
    }
  }
  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  removeEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((item) => item !== listener))
  }
  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener()
  }
  getBoundingClientRect(): { top: number; bottom: number; height: number } {
    return { top: 0, bottom: 100, height: 100 }
  }
  contains(node: FakeNode): boolean {
    return this.all().includes(node)
  }
  all(): FakeNode[] {
    return [this, ...this.children.flatMap((child) => child.all())]
  }
  replaceChildren(): void {
    this.children.length = 0
  }
  remove(): void {
    this.isConnected = false
    this.parent = null
  }
}

function createFrameQueue(): {
  request: (callback: () => void) => number
  cancel: (id: number) => void
  run: () => void
  size: () => number
} {
  let nextId = 0
  const frames = new Map<number, () => void>()
  return {
    request(callback) {
      const id = ++nextId
      frames.set(id, callback)
      return id
    },
    cancel(id) {
      frames.delete(id)
    },
    run() {
      const pending = [...frames.values()]
      frames.clear()
      for (const callback of pending) callback()
    },
    size: () => frames.size,
  }
}

function useDocumentStub(): void {
  vi.stubGlobal('document', {
    createElement: (tag: string) => new FakeNode(tag),
  })
}

function editorHarness() {
  useDocumentStub()
  const root = new FakeNode('section')
  const toolbar = new FakeNode('div')
  const control = new FakeNode('input')
  const panel = new FakeNode('div')
  root.append(toolbar, control, panel)
  const frames = createFrameQueue()
  const windowStub = {
    innerHeight: 800,
    requestAnimationFrame: frames.request,
    cancelAnimationFrame: frames.cancel,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
  vi.stubGlobal('window', windowStub)
  const observers: Array<{ observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = []
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn()
      disconnect = vi.fn()
      constructor() {
        observers.push(this)
      }
    },
  )
  let editing = false
  const editor = createEditorFocus({
    root: root as unknown as HTMLElement,
    toolbar: toolbar as unknown as HTMLElement,
    isEditing: () => editing,
  })
  return {
    editor,
    root,
    toolbar,
    control: control as FakeNode & HTMLElement,
    panel: panel as FakeNode & HTMLElement,
    frames,
    observers,
    windowStub,
    setEditing(value: boolean) {
      editing = value
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('吸顶与编辑定位', () => {
  it('编辑状态切换吸顶留白，非编辑时按真实高度设置', () => {
    const view = editorHarness()
    view.editor.updateToolbar()
    expect(view.toolbar.classList.contains('is-static')).toBe(false)
    expect(view.root.styleProps.get('--analysis-toolbar-height')).toBe('100px')

    view.setEditing(true)
    view.editor.updateToolbar()
    expect(view.toolbar.classList.contains('is-static')).toBe(true)
    expect(view.root.styleProps.get('--analysis-toolbar-height')).toBe('0px')
  })

  it('快速开关只执行最后一次定位，旧动画帧被取消', () => {
    const view = editorHarness()
    view.editor.reveal(view.control, view.panel)
    view.editor.reveal(view.control, undefined)
    expect(view.frames.size()).toBe(1)
    view.frames.run()

    expect(view.control.focus).toHaveBeenCalledTimes(1)
    expect(view.control.focus).toHaveBeenCalledWith({ preventScroll: true })
    expect(view.control.scrollIntoView).toHaveBeenCalledWith({
      block: 'nearest',
      behavior: 'instant',
    })
    expect(view.panel.scrollIntoView).not.toHaveBeenCalled()
  })

  it('面板打开时聚焦输入并滚到编辑区起点', () => {
    const view = editorHarness()
    view.editor.reveal(view.control, view.panel)
    view.frames.run()
    expect(view.control.focus).toHaveBeenCalledWith({ preventScroll: true })
    expect(view.panel.scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'instant' })
  })

  it('目标已脱离文档时不再聚焦或滚动', () => {
    const view = editorHarness()
    view.control.isConnected = false
    view.editor.reveal(view.control)
    view.frames.run()
    expect(view.control.focus).not.toHaveBeenCalled()
    expect(view.control.scrollIntoView).not.toHaveBeenCalled()
  })

  it('销毁取消待执行动画帧并释放观察器与窗口监听', () => {
    const view = editorHarness()
    view.editor.reveal(view.control, view.panel)
    expect(view.frames.size()).toBe(1)

    view.editor.destroy()
    expect(view.frames.size()).toBe(0)
    view.frames.run()
    expect(view.control.focus).not.toHaveBeenCalled()
    expect(view.panel.scrollIntoView).not.toHaveBeenCalled()

    expect(view.observers).toHaveLength(1)
    expect(view.observers[0]!.disconnect).toHaveBeenCalledTimes(1)
    expect(view.windowStub.removeEventListener).toHaveBeenCalledWith(
      'resize', view.windowStub.addEventListener.mock.calls[0]![1],
    )
    expect(view.root.listeners.get('focusin')).toHaveLength(0)
  })
})

function settingsHarness() {
  useDocumentStub()
  const settings = JSON.parse(JSON.stringify(DEFAULT_ANALYSIS_SETTINGS)) as AnalysisSettings
  const handlers = {
    onBasicChange: vi.fn(),
    onAnchorChange: vi.fn(),
    onUseWorkbook: vi.fn(),
    onUseSite: vi.fn(),
    onWeightChange: vi.fn(),
    onScoreFieldChange: vi.fn(),
    onColorThresholdsChange: vi.fn(),
    onDogTargetsChange: vi.fn(),
    onReset: vi.fn(),
  }
  const panel = createSettingsPanel({
    getSettings: () => settings,
    handlers,
  })
  return { panel, settings, handlers, root: panel.root as unknown as FakeNode }
}

function labelInput(root: FakeNode, label: string): FakeNode {
  const field = root
    .all()
    .find((node) => node.tag === 'label' && node.children.some((child) => child.textContent === label))
  const input = field?.children.find((child) => child.tag === 'input')
  if (!input) throw new Error(`没有找到参数输入：${label}`)
  return input
}

function tableWithHeader(root: FakeNode, header: string): FakeNode {
  const table = root
    .all()
    .find((node) => node.tag === 'table' && node.all().some((cell) => cell.textContent === header))
  if (!table) throw new Error(`没有找到参数表：${header}`)
  return table
}

function levelRow(root: FakeNode, header: string, level: string): FakeNode {
  const row = tableWithHeader(root, header)
    .all()
    .find((node) => node.tag === 'tr' && node.children[0]?.textContent === level)
  if (!row) throw new Error(`没有找到 ${level} 行`)
  return row
}

describe('参数面板', () => {
  it('基本数值非法时回填原值且不回调，越界值夹紧后回调', () => {
    const { root, handlers } = settingsHarness()
    const rank = labelInput(root, '榜单 Top')
    expect(rank.value).toBe('50')

    rank.value = 'abc'
    rank.emit('change')
    expect(rank.value).toBe('50')
    expect(handlers.onBasicChange).not.toHaveBeenCalled()

    rank.value = '999'
    rank.emit('change')
    expect(rank.value).toBe('200')
    expect(handlers.onBasicChange).toHaveBeenCalledWith('rankLimit', 200)
  })

  it('锚点只接受正数，软实力权重限制在 0–100', () => {
    const { root, settings, handlers } = settingsHarness()
    const row = levelRow(root, '初级 · 用时', '初级 · 用时')
    const anchor = row.children[1]!.children[0]!
    const key = anchorKey('std', 'b', 't')

    anchor.value = '0'
    anchor.emit('change')
    expect(anchor.value).toBe(String(settings.anchors[key]))
    expect(handlers.onAnchorChange).not.toHaveBeenCalled()

    anchor.value = '12.5'
    anchor.emit('change')
    expect(handlers.onAnchorChange).toHaveBeenCalledWith(key, 12.5)

    const weightTable = tableWithHeader(root, '用时')
    const weightRow = weightTable
      .all()
      .find((node) => node.tag === 'tr' && node.children[0]?.textContent === '初级')!
    const weight = weightRow.children[1]!.children[0]!
    weight.value = '150'
    weight.emit('change')
    expect(weight.value).toBe(String(settings.softWeights.b.t))
    expect(handlers.onWeightChange).not.toHaveBeenCalled()

    weight.value = '50'
    weight.emit('change')
    expect(handlers.onWeightChange).toHaveBeenCalledWith('b', 't', 50)
  })

  it('3BV 下限等评分字段按上下限校验，色板长度不符时回填', () => {
    const { root, settings, handlers } = settingsHarness()
    const t37Row = levelRow(root, 'PPP 常数', '初级')
    const floor = t37Row.children[4]!.children[0]!

    floor.value = '0'
    floor.emit('change')
    expect(floor.value).toBe(String(settings.bvFloors.b))
    expect(handlers.onScoreFieldChange).not.toHaveBeenCalled()

    floor.value = '300'
    floor.emit('change')
    expect(handlers.onScoreFieldChange).toHaveBeenCalledWith('bvFloors', 'b', 300)

    const color = root.all().find((node) => node.tag === 'textarea')!
    color.value = '1,2,3'
    color.emit('change')
    expect(color.value).toBe(settings.colorThresholds.join(', '))
    expect(handlers.onColorThresholdsChange).not.toHaveBeenCalled()

    const thresholds = settings.colorThresholds.map((value) => value + 1)
    color.value = thresholds.join(', ')
    color.emit('change')
    expect(handlers.onColorThresholdsChange).toHaveBeenCalledWith(thresholds)
  })

  it('refresh 回填外部替换后的设置，锚点单独回填不覆盖其他字段', () => {
    const { panel, root, settings } = settingsHarness()
    settings.rankLimit = 77
    settings.bvFloors.e = 200
    const anchorKeyValue = anchorKey('nf', 'i', 'b')
    settings.anchors[anchorKeyValue] = 9.5

    panel.refresh()
    expect(labelInput(root, '榜单 Top').value).toBe('77')
    expect(levelRow(root, 'PPP 常数', '高级').children[4]!.children[0]!.value).toBe('200')
    const anchorRow = levelRow(root, '中级 · 3BVS', '中级 · 3BVS')
    expect(anchorRow.children[2]!.children[0]!.value).toBe('9.5')

    settings.rankLimit = 88
    panel.refreshAnchors()
    expect(labelInput(root, '榜单 Top').value).toBe('77')
  })

  it('使用大表锚点与恢复默认按钮只通知调用方', () => {
    const { root, handlers } = settingsHarness()
    const buttons = root.all().filter((node) => node.tag === 'button')
    const workbook = buttons.find((node) => node.textContent === '使用大表锚点')!
    const site = buttons.find((node) => node.textContent === '读取并使用网站锚点')!
    const reset = buttons.find((node) => node.textContent === '恢复默认')!
    workbook.emit('click')
    site.emit('click')
    reset.emit('click')
    expect(handlers.onUseWorkbook).toHaveBeenCalledTimes(1)
    expect(handlers.onUseSite).toHaveBeenCalledTimes(1)
    expect(handlers.onReset).toHaveBeenCalledTimes(1)
  })

  it('销毁后面板节点从文档分离', () => {
    const { panel, root } = settingsHarness()
    panel.destroy()
    expect(root.children).toHaveLength(0)
    expect(root.isConnected).toBe(false)
  })
})
