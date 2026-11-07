import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountUploadWatch } from '../src/features/upload-watch/view'
import { DEFAULT_WATCH_SETTINGS, DEFAULT_WATCH_STATUS } from '../src/features/upload-watch/types'
import type { WatchLogEntry, WatchSettings, WatchStatus } from '../src/features/upload-watch/types'

const fixture = vi.hoisted(() => ({
  settings: {} as WatchSettings,
  status: {} as WatchStatus,
  logs: [] as WatchLogEntry[],
  handle: null as object | null,
}))
vi.mock('../src/features/upload-watch/settings', () => ({
  getWatchSettings: async () => fixture.settings,
  getWatchStatus: async () => fixture.status,
  getWatchLogs: async () => fixture.logs,
  saveWatchSettings: async (patch: Partial<WatchSettings>) => Object.assign(fixture.settings, patch),
  clearWatchLogs: async () => { fixture.logs = [] },
}))
vi.mock('../src/features/upload-watch/store', () => ({
  getWatchHandle: async () => fixture.handle,
  setWatchHandle: vi.fn(), loadLedger: vi.fn(), requeueFailed: vi.fn(), resetLedger: vi.fn(),
}))
vi.mock('../src/features/upload-watch/controller', () => ({
  send: async () => ({ ok: true }), startWatch: vi.fn(), pauseWatch: vi.fn(),
}))

// 仅覆盖本视图用到的 DOM 行为；布局与滚动效果另由真实浏览器抽查。
class Node {
  children: Node[] = []
  parent: Node | null = null
  className = ''
  text = ''
  href = ''
  target = ''
  rel = ''
  dataset: Record<string, string> = {}
  style: Record<string, string> = {}
  attrs = new Map<string, string>()
  listeners = new Map<string, Array<() => unknown>>()
  disabled = false
  open = false
  scrollTop = 0
  constructor(readonly tag: string) {}
  get textContent(): string { return this.text + this.children.map((child) => child.textContent).join('') }
  set textContent(value: string) { this.text = value; this.children = [] }
  classList = {
    contains: (key: string) => this.className.split(' ').includes(key),
    toggle: (key: string, force?: boolean) => {
      const names = new Set(this.className.split(' ').filter(Boolean))
      const on = force ?? !names.has(key)
      if (on) names.add(key); else names.delete(key)
      this.className = [...names].join(' ')
      return on
    },
  }
  append(...nodes: Array<Node | string>): void {
    for (const item of nodes) {
      const node = typeof item === 'string' ? Object.assign(new Node('#text'), { text: item }) : item
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
      node.parent = this
      this.children.push(node)
    }
  }
  insertBefore(node: Node, target: Node): void {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
    node.parent = this
    this.children.splice(this.children.indexOf(target), 0, node)
  }
  replaceChildren(...nodes: Node[]): void { this.children = []; this.append(...nodes) }
  setAttribute(key: string, value: string): void { this.attrs.set(key, value) }
  addEventListener(key: string, fn: () => unknown): void {
    this.listeners.set(key, [...(this.listeners.get(key) ?? []), fn])
  }
  all(): Node[] { return [this, ...this.children.flatMap((node) => node.all())] }
  contains(node: Node): boolean { return this.all().includes(node) }
  focus(): void { (document as unknown as { activeElement: Node }).activeElement = this }
  showModal(): void { this.open = true }
  close(): void { this.open = false }
  getBoundingClientRect(): { top: number; bottom: number } {
    const top = this.parent?.className === 'logs'
      ? this.parent.children.indexOf(this) * 30 - this.parent.scrollTop : 0
    return { top, bottom: top + 30 }
  }
}
let root: Node
let change: (changes: Record<string, object>, area: string) => void
let onFocus: () => void
const byClass = (name: string) => root.all().find((node) => node.classList.contains(name))!
const mount = async () => mountUploadWatch(root as unknown as HTMLElement)
async function update(key: string): Promise<void> {
  change({ [key]: {} }, 'local')
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  root = new Node('div')
  fixture.settings = { ...DEFAULT_WATCH_SETTINGS }
  fixture.status = { ...DEFAULT_WATCH_STATUS }
  fixture.logs = []
  fixture.handle = null
  vi.stubGlobal('document', {
    createElement: (tag: string) => new Node(tag),
    createTextNode: (text: string) => Object.assign(new Node('#text'), { text }),
    body: new Node('body'), activeElement: null,
  })
  vi.stubGlobal('window', { addEventListener: vi.fn((event, listener) => {
    if (event === 'focus') onFocus = listener
  }) })
  vi.stubGlobal('location', { search: '' })
  vi.stubGlobal('chrome', {
    runtime: { getURL: (path: string) => path, getManifest: () => ({ version: 'test' }) },
    storage: { onChanged: { addListener: vi.fn((fn) => { change = fn }) } },
  })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('上传页展示', () => {
  it('其他页面重新授权并更换目录后同步新句柄，停止时显示真实原因', async () => {
    fixture.handle = { queryPermission: async () => 'prompt' }
    fixture.settings = { ...fixture.settings, state: 'needs-permission', dirName: '旧目录' }
    await mount()
    expect(byClass('watch-run').textContent).toContain('重新授权')
    const queryPermission = vi.fn(async () => 'granted')
    fixture.handle = { queryPermission }
    fixture.settings = { ...fixture.settings, state: 'watching', dirName: '新目录' }
    await update('uploadWatch')
    expect(queryPermission).toHaveBeenCalled()
    expect(byClass('watch-run').textContent).not.toContain('目录读取权限需要重新授予')
    const recovery = byClass('watch-run').all().find((node) => node.tag === 'button' && node.textContent === '去登录')!
    expect(recovery.classList.contains('hidden')).toBe(true)
    fixture.settings = { ...fixture.settings, state: 'stopped', lastError: '录像额度已满' }
    await update('uploadWatch')
    expect(byClass('watch-run').textContent).toContain('录像额度已满')
    expect(byClass('watch-run').textContent).not.toContain('目录读取权限需要重新授予')
  })

  it.each([
    ['stopped', '录像额度已满'], ['waiting-login', '登录后自动继续'],
  ] as const)('权限未授予时也保留 %s 的当前阻塞原因', async (state, reason) => {
    fixture.handle = { queryPermission: async () => 'prompt' }
    fixture.settings = { ...fixture.settings, state, lastError: '录像额度已满', dirName: '目录' }
    await mount()
    const note = byClass('watch-run').all().find((node) => node.classList.contains('hint-text'))!
    expect(note.textContent).toContain(reason)
    expect(note.textContent).not.toContain('目录读取权限需要重新授予')
  })

  it('返回页面时重新查询已在别处授予的权限', async () => {
    let permission = 'prompt'
    fixture.handle = { queryPermission: async () => permission }
    fixture.settings = { ...fixture.settings, state: 'paused', dirName: '目录' }
    await mount()
    permission = 'granted'
    onFocus()
    await vi.waitFor(() => expect(byClass('watch-run').textContent).not.toContain('目录读取权限需要重新授予'))
    expect(root.textContent).toContain('目录读取权限已授予')
  })

  it('较早的权限查询晚返回时不能覆盖另一页同步的新句柄权限', async () => {
    let resolveOld!: (value: string) => void
    const pending = new Promise<string>((resolve) => { resolveOld = resolve })
    const queryPermission = vi.fn().mockResolvedValueOnce('granted').mockReturnValueOnce(pending)
    fixture.handle = { queryPermission }
    fixture.settings = { ...fixture.settings, state: 'paused', dirName: '目录' }
    await mount()
    onFocus()
    await vi.waitFor(() => expect(queryPermission).toHaveBeenCalledTimes(2))
    fixture.handle = { queryPermission: async () => 'granted' }
    fixture.settings = { ...fixture.settings, state: 'watching' }
    await update('uploadWatch')
    resolveOld('denied')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(root.textContent).toContain('目录读取权限已授予')
    expect(byClass('watch-run').textContent).not.toContain('目录读取权限需要重新授予')
  })

  it('未配置时先配置目录，配置后移动原节点且常规更新不反复移动', async () => {
    await mount()
    const page = byClass('upload-page')
    expect(page.children.slice(1, 4).map((node) => node.textContent.slice(0, 4))).toEqual(['监视目录', '上传设置', '运行状态'])
    const dir = page.children[1]!
    const run = byClass('watch-run')
    const input = root.all().find((node) => node.tag === 'input')!
    input.focus()
    fixture.settings = { ...fixture.settings, dirName: '录像目录', state: 'paused' }
    await update('uploadWatch')
    expect(page.children[1]).toBe(run)
    expect(page.children[2]!.textContent).toContain('最近记录')
    expect(page.children[3]).toBe(dir)
    expect(document.activeElement).toBe(input)
    const insert = vi.spyOn(page, 'insertBefore')
    const help = byClass('rules')
    expect(help.open).toBe(false)
    expect(byClass('watch-diagnostics').open).toBe(false)
    help.open = true
    fixture.status.uploaded = 999
    await update('uploadWatchStatus')
    await update('uploadWatchLog')
    expect(byClass('watch-state').textContent).toBe('已暂停')
    expect(byClass('watch-counters').textContent).toContain('999已传0失败')
    expect(insert).not.toHaveBeenCalled()
    expect(help.open).toBe(true)
    expect(chrome.storage.onChanged.addListener).toHaveBeenCalledTimes(1)
  })

  it('日志按结构化级别展示，限制 40 条且更新时保留阅读位置', async () => {
    fixture.logs = Array.from({ length: 45 }, (_, i) => ({ at: 1000 + i, kind: (['dim', 'ok', 'warn', 'err'] as const)[i % 4]!, text: `条目 ${i}` }))
    await mount()
    const list = byClass('logs')
    expect(list.children).toHaveLength(40)
    expect(list.children.slice(0, 4).map((node) => node.children[1]!.textContent)).toEqual(['记录', '成功', '警告', '错误'])
    list.scrollTop = 75
    const read = list.children[2]!.dataset.logKey
    fixture.logs = [{ at: 9999, kind: 'dim', text: '重试成功也只是记录' }, ...fixture.logs]
    await update('uploadWatchLog')
    expect(list.scrollTop).toBe(105)
    expect(list.children[3]!.dataset.logKey).toBe(read)
    const first = list.children[0]
    await update('uploadWatchStatus')
    expect(list.children[0]).toBe(first)
  })

  it('主要内容之后只有一个统一关于卡片，状态更新不重复创建', async () => {
    await mount()
    const page = byClass('upload-page')
    const card = byClass('about-card')
    expect(page.children[page.children.length - 1]).toBe(card)
    expect(card.textContent).toContain('元神助手 vtest · 开源扫雷网辅助工具')
    expect(page.all().filter((node) => node.classList.contains('page-footer'))).toHaveLength(0)

    fixture.status.uploaded = 3
    await update('uploadWatchStatus')
    await update('uploadWatchLog')
    expect(page.all().filter((node) => node.classList.contains('about-card'))).toEqual([card])
    expect(page.children[page.children.length - 1]).toBe(card)
  })
})
