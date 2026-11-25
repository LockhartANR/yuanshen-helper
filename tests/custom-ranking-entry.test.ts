import { describe, expect, it } from 'vitest'
import { findRankingTabNav } from '../src/content/ranking-entry'

class FakeElement {
  readonly children: FakeElement[] = []
  private parent: FakeElement | null = null

  constructor(
    private readonly selectors: string[],
    readonly textContent = '',
    readonly id = '',
  ) {}

  append(...children: FakeElement[]): void {
    for (const child of children) {
      child.parent = this
      this.children.push(child)
    }
  }

  getClientRects(): readonly object[] {
    return [{}]
  }

  matches(selector: string): boolean {
    return selector.split(',').some((part) => this.selectors.includes(part.trim()))
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ])
  }

  closest(selector: string): FakeElement | null {
    if (this.matches(selector)) return this
    return this.parent?.closest(selector) ?? null
  }
}

const LABELS = ['竞速', '效率', '密度', '比赛', '小游戏', '作品']

function tabNav(labels: string[] = LABELS, ids: string[] = []): FakeElement {
  const nav = new FakeElement(['.el-tabs__nav', '[role="tablist"]'])
  labels.forEach((label, index) => {
    nav.append(new FakeElement(['.el-tabs__item', '[role="tab"]'], label, ids[index]))
  })
  return nav
}

describe('站内排行榜入口挂载点', () => {
  it('跳过表格中的同名页签', () => {
    const root = new FakeElement(['body'])
    const table = new FakeElement(['table'])
    table.append(tabNav())
    root.append(table)
    expect(findRankingTabNav(root as unknown as ParentNode)).toBeNull()
  })

  it('优先通过原生页签 ID 定位其他语言的导航栏', () => {
    const root = new FakeElement(['body'])
    const nav = tabNav(
      ['Speed', 'Efficiency', 'Density', 'Tournament', 'Minigame', 'Works'],
      ['tab-speed', 'tab-efficiency', 'tab-density', 'tab-tournament', 'tab-minigame', 'tab-media'],
    )
    root.append(tabNav(), nav)
    expect(findRankingTabNav(root as unknown as ParentNode)).toBe(nav)
  })

  it('等待完整页签组，不合并分散在内外层导航中的页签', () => {
    const root = new FakeElement(['body'])
    const nav = tabNav(LABELS.slice(0, 3))
    nav.append(tabNav(LABELS.slice(3)))
    root.append(nav)
    expect(findRankingTabNav(root as unknown as ParentNode)).toBeNull()
  })

  it('通过中文标签定位导航栏，已注入的入口和内容区表格不影响匹配', () => {
    const root = new FakeElement(['body'])
    const nav = tabNav()
    nav.append(new FakeElement(['button'], '自定义'))
    root.append(nav, new FakeElement(['table']))
    expect(findRankingTabNav(root as unknown as ParentNode)).toBe(nav)
  })
})
