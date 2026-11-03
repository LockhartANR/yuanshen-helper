import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAnalysisView } from '../src/features/player-stats/analysis-view'
import type { AnalysisView } from '../src/features/player-stats/analysis-view'
import type { Video } from '../src/features/player-stats/model'

// 替代节点与事件派发，直接驱动真实视图处理函数并检查渲染结果；不模拟浏览器布局。
class TestElement {
  children: TestElement[] = []
  parent: TestElement | null = null
  dataset: Record<string, string> = {}
  attributes = new Map<string, string>()
  listeners = new Map<string, Array<(event: { target: TestElement }) => void>>()
  className = ''
  textContent = ''
  innerHTML = ''
  value = ''
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
    const match = /^(\w+)?\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector)
    return !!match && (!match[1] || match[1] === this.tag) && this.getAttribute(match[2]!) !== null &&
      (match[3] === undefined || this.getAttribute(match[2]!) === match[3])
  }
  closest(selector: string): TestElement | null {
    return this.matches(selector) ? this : this.parent?.closest(selector) ?? null
  }
  all(): TestElement[] { return [this, ...this.children.flatMap((child) => child.all())] }
  querySelector(selector: string): TestElement | null {
    return this.all().slice(1).find((node) => node.matches(selector)) ?? null
  }
  addEventListener(type: string, listener: (event: { target: TestElement }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  emit(type: string, target: TestElement = this): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ target })
    this.parent?.emit(type, target)
  }
  focus(): void {}
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
function applyDraft(start: string, end: string): void {
  const panel = new TestElement('div')
  panel.dataset.rangePanel = 'lsf'
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
  vi.stubGlobal('document', {
    createElement: (tag: string) => new TestElement(tag),
    createTextNode: (text: string) => Object.assign(new TestElement('#text'), { textContent: text }),
  })
  view = createAnalysisView({ autoSiteAnchors: false })
  root = view.root as unknown as TestElement
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('时段编辑切页', () => {
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
    expect(findClass('source-note').textContent).toBe('计入 1 局')
    expect(findClass('analysis-view').innerHTML).toContain('26/11/3')
    nav('lsf')
    expect(findClass('analysis-view').innerHTML.match(/data-lsf-event-row=/g)).toHaveLength(1)
    expect(findClass('analysis-view').innerHTML).toContain('上传时间')

  })
})
