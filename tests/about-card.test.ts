import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAboutCard } from '../src/shared/about-card'

class TestElement {
  children: TestElement[] = []
  className = ''
  href = ''
  target = ''
  rel = ''
  private text = ''
  constructor(readonly tag: string) {}
  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join('')
  }
  set textContent(value: string) {
    this.text = value
    this.children = []
  }
  append(...children: TestElement[]): void {
    this.children.push(...children)
  }
  all(): TestElement[] {
    return [this, ...this.children.flatMap((child) => child.all())]
  }
}

beforeEach(() => {
  vi.stubGlobal('document', {
    createElement: (tag: string) => new TestElement(tag),
  })
  vi.stubGlobal('chrome', {
    runtime: { getManifest: () => ({ version: '1.3.1-test' }) },
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('统一「关于」卡片', () => {
  it('显示 manifest 版本、仓库、开发者、站点和大表原作者五个链接', () => {
    const card = createAboutCard() as unknown as TestElement
    expect(card.tag).toBe('section')
    expect(card.className).toBe('about-card')
    expect(card.textContent).toContain('关于元神助手 v1.3.1-test · 开源扫雷网辅助工具')

    const heading = card.children[0]!
    const desc = card.children[1]!
    expect(heading.textContent).toBe('关于')
    expect(desc.textContent).toBe('元神助手 v1.3.1-test · 开源扫雷网辅助工具')

    const links = card.all().filter((node) => node.tag === 'a')
    expect(links.map((link) => [link.textContent, link.href])).toEqual([
      ['github.com/LockhartANR/yuanshen-helper ↗', 'https://github.com/LockhartANR/yuanshen-helper'],
      ['GitHub ↗', 'https://github.com/LockhartANR'],
      ['开源扫雷网 ↗', 'https://openms.top/#/player/16'],
      ['openms.top ↗', 'https://openms.top'],
      ['原作者主页 ↗', 'https://openms.top/#/player/48'],
    ])
    for (const link of links) {
      expect(link.target).toBe('_blank')
      expect(link.rel).toBe('noreferrer')
    }
  })
})
