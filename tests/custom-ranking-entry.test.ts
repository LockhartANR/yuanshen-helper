import { describe, expect, it } from 'vitest'
import { findRankingTabGroup } from '../src/content/ranking-entry'

/** 只实现入口定位用到的 DOM 能力，覆盖真实站点的 el-tabs 结构。 */
class FakeElement {
  className: string
  attributes = new Map<string, string>()
  children: FakeElement[] = []
  parentElement: FakeElement | null = null
  private text: string

  constructor(
    readonly tag: string,
    text = '',
    className = '',
  ) {
    this.text = text
    this.className = className
  }

  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join('')
  }

  set textContent(value: string) {
    this.text = value
    this.children = []
  }

  get isConnected(): boolean {
    return true
  }

  getClientRects(): ArrayLike<unknown> {
    return [{}]
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.parentElement = this
      this.children.push(node)
    }
  }

  all(): FakeElement[] {
    return [this, ...this.children.flatMap((child) => child.all())]
  }

  matches(selector: string): boolean {
    const value = selector.trim()
    if (value.startsWith('.')) return this.className.split(' ').includes(value.slice(1))
    if (value === '[role="tab"]') return this.attributes.get('role') === 'tab'
    return this.tag === value
  }

  querySelectorAll(selector: string): FakeElement[] {
    const parts = selector.split(',').map((part) => part.trim())
    return this.all()
      .slice(1)
      .filter((node) => parts.some((part) => node.matches(part)))
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null
  }

  closest(selector: string): FakeElement | null {
    let node: FakeElement | null = this
    while (node) {
      if (node.matches(selector)) return node
      node = node.parentElement
    }
    return null
  }
}

const LABELS = ['竞速', '效率', '密度', '比赛', '小游戏', '作品']

function page(labels: string[] = LABELS): {
  root: FakeElement
  tabs: FakeElement
  nav: FakeElement
  content: FakeElement
} {
  const root = new FakeElement('body')
  const wrapper = new FakeElement('div', '', 'ranking-layout')
  const header = new FakeElement('div', '排行榜')
  const tabs = new FakeElement('div', '', 'el-tabs')
  const nav = new FakeElement('div', '', 'el-tabs__nav')
  const content = new FakeElement('div', '', 'el-tabs__content')
  tabs.append(nav, content)
  wrapper.append(header, tabs)
  root.append(wrapper)
  for (const label of labels) {
    const item = new FakeElement('div', label, 'el-tabs__item')
    item.attributes.set('role', 'tab')
    nav.append(item)
  }
  return { root, tabs, nav, content }
}

describe('站内排行榜入口挂载点', () => {
  it('页签未渲染完整时不猜测位置', () => {
    const { root } = page(['竞速', '效率', '密度'])
    expect(findRankingTabGroup(root as unknown as ParentNode)).toBeNull()
  })

  it('六个同名按钮位于表格内时不挂载', () => {
    const root = new FakeElement('body')
    const wrapper = new FakeElement('div')
    const table = new FakeElement('table')
    const row = new FakeElement('tr')
    table.append(row)
    wrapper.append(table)
    root.append(wrapper)
    for (const label of LABELS) {
      const button = new FakeElement('button', label)
      row.append(button)
    }
    expect(findRankingTabGroup(root as unknown as ParentNode)).toBeNull()
  })

  it('兼容没有 el-tabs 类的标签组，并返回共同父容器', () => {
    const root = new FakeElement('body')
    const wrapper = new FakeElement('div')
    const group = new FakeElement('div', '', 'tab-bar')
    wrapper.append(group)
    root.append(wrapper)
    for (const label of LABELS) {
      const button = new FakeElement('button', label)
      group.append(button)
    }
    expect(findRankingTabGroup(root as unknown as ParentNode)).toBe(
      group as unknown as HTMLElement,
    )
  })

  it('内容加载表格前后均定位到同一外层页签容器', () => {
    const { root, tabs, content } = page()
    expect(findRankingTabGroup(root as unknown as ParentNode)).toBe(tabs as unknown as HTMLElement)
    // 模拟站点切换子榜单后重绘内容区：表格出现在内容区，页签导航不变。
    content.children = []
    const table = new FakeElement('table')
    const row = new FakeElement('tr')
    row.append(new FakeElement('td', '成绩'), new FakeElement('td', '时间'))
    table.append(row)
    content.append(table)
    expect(findRankingTabGroup(root as unknown as ParentNode)).toBe(tabs as unknown as HTMLElement)
  })
})
