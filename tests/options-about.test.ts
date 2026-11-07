import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountUserSearchOptions } from '../src/features/user-search/options-view'

vi.mock('../src/features/user-search/db', () => ({
  DEFAULT_SYNC_META: { phase: 'idle', lastSyncAt: 0, watermark: 0 },
  clearAllData: vi.fn(),
  countUsers: async () => 0,
  getSyncMeta: async () => ({ phase: 'idle', lastSyncAt: 0, watermark: 0 }),
}))
vi.mock('../src/features/user-search/sync', () => ({
  runSync: vi.fn(),
  SyncAbortError: class extends Error {},
  SyncBusyError: class extends Error {},
}))
vi.mock('../src/shared/log', () => ({
  addLog: vi.fn(async () => undefined),
  clearLogs: vi.fn(async () => undefined),
  getLogs: async () => [],
}))
vi.mock('../src/shared/bus', () => ({
  notifyDataChanged: vi.fn(),
  onDataChanged: vi.fn(),
}))
vi.mock('../src/shared/settings', () => ({
  DEFAULT_SETTINGS: {
    apiBase: 'https://openms.top',
    autoIncrementalOnPopup: false,
    siteAnalysisEnabled: true,
    selfUserId: null,
    identifierLookupEnabled: false,
  },
  getSettings: async () => ({
    apiBase: 'https://openms.top',
    autoIncrementalOnPopup: false,
    siteAnalysisEnabled: true,
    selfUserId: null,
    identifierLookupEnabled: false,
  }),
  saveSettings: vi.fn(),
}))

class TestElement {
  children: TestElement[] = []
  className = ''
  private text = ''
  href = ''
  target = ''
  rel = ''
  src = ''
  alt = ''
  width = 0
  height = 0
  decoding = ''
  type = ''
  id = ''
  htmlFor = ''
  placeholder = ''
  spellcheck = true
  value = ''
  checked = false
  disabled = false
  hidden = false
  max = 0
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
    }
  }
  append(...children: TestElement[]): void {
    this.children.push(...children)
  }
  replaceChildren(...children: TestElement[]): void {
    this.children = [...children]
  }
  setAttribute(): void {}
  removeAttribute(): void {}
  addEventListener(): void {}
  all(): TestElement[] {
    return [this, ...this.children.flatMap((child) => child.all())]
  }
}

let root: TestElement

beforeEach(() => {
  root = new TestElement('div')
  vi.stubGlobal('document', {
    title: '',
    activeElement: null,
    createElement: (tag: string) => new TestElement(tag),
    createTextNode: (text: string) => Object.assign(new TestElement('#text'), {
      textContent: text,
    }),
  })
  vi.stubGlobal('window', { addEventListener: vi.fn(), confirm: vi.fn(() => true) })
  vi.stubGlobal('chrome', {
    runtime: {
      getURL: (path: string) => path,
      getManifest: () => ({ version: '1.3.1-test' }),
      openOptionsPage: vi.fn(),
    },
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('设置页关于卡片', () => {
  it('用共享卡片替换旧内容，保留一个实例和页面底部 Issues 提示', async () => {
    await mountUserSearchOptions(root as unknown as HTMLElement)
    const page = root.children[0]!
    const cards = page.all().filter((node) => node.className.split(' ').includes('about-card'))
    expect(cards).toHaveLength(1)
    const card = cards[0]!
    expect(card.textContent).toContain('关于元神助手 v1.3.1-test · 开源扫雷网辅助工具')
    expect(card.textContent).not.toContain('saolei.wang')
    expect(page.children[page.children.length - 2]).toBe(card)
    expect(page.children[page.children.length - 1]!.textContent).toBe(
      '问题和建议请提到仓库的 Issues。',
    )
  })
})
