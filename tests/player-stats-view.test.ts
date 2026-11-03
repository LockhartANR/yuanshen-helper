import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountPlayerStats } from '../src/features/player-stats/view'
import { loadPlayer, ensureDetails } from '../src/features/player-stats/service'
import { fetchUserInfo } from '../src/features/player-stats/api'
import type { LoadedPlayer } from '../src/features/player-stats/service'
import { parseStatsCsv } from '../src/features/player-stats/csv'

const { updateAnalysis, createAnalysisViewMock } = vi.hoisted(() => ({
  updateAnalysis: vi.fn(),
  createAnalysisViewMock: vi.fn(),
}))

vi.mock('../src/features/player-stats/service', () => ({ loadPlayer: vi.fn(), ensureDetails: vi.fn() }))
vi.mock('../src/features/player-stats/api', () => ({ fetchUserInfo: vi.fn(async () => null) }))
vi.mock('../src/features/player-stats/analysis-settings', () => ({
  loadAnalysisSettings: () => ({ bvFloors: { b: 10, i: 30, e: 100 }, colorThresholds: [] }),
}))
vi.mock('../src/features/player-stats/colors', () => ({
  configureColors: vi.fn(), pbColorStyle: () => null, dateColorStyle: () => null, medianOf: () => 0,
}))
vi.mock('../src/features/player-stats/software-icon', () => ({ softwareIcon: () => null }))
vi.mock('../src/features/player-stats/analysis-view', () => ({
  createAnalysisView: (options: unknown) => {
    createAnalysisViewMock(options)
    return {
      root: document.createElement('section'),
      update: updateAnalysis,
      destroy: vi.fn(),
    }
  },
}))

// 只替代本页使用的 DOM 基础操作；事件直接驱动真实 mountPlayerStats 和异步加载逻辑。
// 不模拟浏览器布局，视觉效果仍需浏览器验证。
class TestElement {
  children: TestElement[] = []
  parent: TestElement | null = null
  className = ''
  type = ''
  title = ''
  value = ''
  disabled = false
  checked = false
  files: ReturnType<typeof csvFile>[] = []
  attributes = new Map<string, string>()
  listeners = new Map<string, Array<() => void>>()
  private text = ''
  constructor(readonly tag: string) {}
  get textContent(): string { return this.text + this.children.map((child) => child.textContent).join('') }
  set textContent(value: string) { this.text = value; this.children = [] }
  classList = {
    contains: (name: string): boolean => this.className.split(' ').includes(name),
    add: (name: string): void => { this.classList.toggle(name, true) },
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
  replaceChildren(...children: TestElement[]): void { this.textContent = ''; this.append(...children) }
  setAttribute(key: string, value: string): void { this.attributes.set(key, value) }
  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  emit(type: string): void { for (const listener of this.listeners.get(type) ?? []) listener() }
  click(): void { if (!this.disabled) this.emit('click') }
  all(): TestElement[] { return [this, ...this.children.flatMap((child) => child.all())] }
  visible(): boolean { return !this.classList.contains('hidden') && (this.parent?.visible() ?? true) }
}

const HEADER = 'Day,Month,Year,Hour,Min,Sec,mode,Time,BBBV,BBBVs,style,cell0,cell1,cell2,cell3,cell4,cell5,cell6,cell7,cell8,Lcl,Rcl,Dcl,Leff,Reff,Deff,Openings,Islands,Path,GZiNi,HZiNi'
const ROW = '2,8,2024,16,1,12,BEG,5.00,12,2.40,Flag,19,21,10,4,0,0,0,0,0,12,3,3,12,1,3,3,3,992,12,12'
const CSV = `${HEADER}\n${ROW}`
function csvFile(name: string, text = CSV, size = text.length) {
  return { name, size, text: async () => text }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function loaded(): LoadedPlayer {
  const video = { ...parseStatsCsv(CSV).videos[0]!, id: 123 }
  return { userId: 16, fetchedAt: 1, fromCache: false, missing: [], rows: [
    { userId: 16, id: video.id, state: 'c', uploadTime: video.upload_time, ongoing: false, detail: video },
  ] }
}
let root: TestElement
const find = (predicate: (node: TestElement) => boolean): TestElement => {
  const node = root.all().find(predicate)
  if (!node) throw new Error('未找到测试节点')
  return node
}
const button = (text: string) => find((node) => node.tag === 'button' && node.textContent === text)
const importStatus = () => find((node) => node.attributes.get('role') === 'status')
async function importFiles(files: ReturnType<typeof csvFile>[]): Promise<void> {
  startImport(files)
  // 普通夹具立即返回文件内容，先让整批异步读取完成再检查反馈。
  await new Promise((resolve) => setTimeout(resolve, 0))
  await vi.waitFor(() => expect(importStatus().textContent).toContain('本次导入'))
}
function startImport(files: ReturnType<typeof csvFile>[]): void {
  const input = find((node) => node.type === 'file')
  input.files = files
  input.emit('change')
}
async function mount(): Promise<void> {
  await mountPlayerStats(root as unknown as HTMLElement)
}

beforeEach(() => {
  vi.clearAllMocks()
  root = new TestElement('div')
  vi.stubGlobal('document', { createElement: (tag: string) => new TestElement(tag), title: '' })
  vi.stubGlobal('location', { search: '?id=16' })
  vi.mocked(loadPlayer).mockResolvedValue(loaded())
})
afterEach(() => vi.unstubAllGlobals())

describe('玩家页 CSV 集成', () => {
  it('网站初次失败后，从 CSV 切回网站在加载期间及失败后均为空', async () => {
    const next = deferred<LoadedPlayer>()
    vi.mocked(loadPlayer).mockRejectedValueOnce(new Error('首次失败')).mockReturnValueOnce(next.promise)
    await mount()
    await importFiles([csvFile('ok.csv')])
    expect(updateAnalysis).toHaveBeenLastCalledWith(expect.any(Array), { csv: true })
    button('网站数据').click()
    const assertEmptySite = () => {
      expect(find((node) => node.tag === 'h1').textContent).toBe('#16')
      expect(find((node) => node.classList.contains('player-meta')).textContent).not.toContain('CSV')
      expect(root.all().filter((node) => node.classList.contains('pb-rowlabel'))).toHaveLength(0)
      expect(root.all().filter((node) => node.classList.contains('top5-item'))).toHaveLength(0)
      expect(updateAnalysis).toHaveBeenLastCalledWith([], { csv: false })
    }
    assertEmptySite()
    next.reject(new Error('再次失败'))
    await next.promise.catch(() => {})
    await Promise.resolve()
    assertEmptySite()
  })

  it.each(['成功', '失败'])('清除使多文件导入整批失效，旧读取%s不会恢复数据或提示', async (completion) => {
    await mount()
    await importFiles([csvFile('existing.csv')])
    const slow = deferred<string>()
    const read = vi.fn(() => slow.promise)
    startImport([csvFile('staged.csv'), { ...csvFile('slow.csv'), text: read }])
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
    button('清除 CSV').click()
    if (completion === '成功') slow.resolve(CSV)
    else slow.reject(new Error('已失效文件读取失败'))
    await slow.promise.catch(() => {})
    await Promise.resolve()
    expect(find((node) => node.tag === 'h1').textContent).toBe('#16')
    expect(importStatus().textContent).toBe('')
    expect(updateAnalysis).toHaveBeenLastCalledWith(expect.any(Array), { csv: false })
    await importFiles([csvFile('fresh.csv')])
    expect(find((node) => node.classList.contains('source-files') && node.tag === 'p').textContent)
      .toBe('fresh.csv：1/1 局')
    expect(updateAnalysis.mock.lastCall?.[0]).toHaveLength(1)
  })

  it.each([false, true])('网站已有 CSV=%s 时主动选择网站使旧导入失效', async (hasCsv) => {
    await mount()
    if (hasCsv) await importFiles([csvFile('existing.csv')])
    const slow = deferred<string>()
    startImport([{ ...csvFile('slow.csv'), text: () => slow.promise }])
    const message = importStatus().textContent
    button('网站数据').click()
    slow.resolve(CSV)
    await slow.promise
    await Promise.resolve()
    expect(find((node) => node.tag === 'h1').textContent).toBe('#16')
    expect(importStatus().textContent).toBe(message)
    expect(updateAnalysis).toHaveBeenLastCalledWith(expect.any(Array), { csv: false })
    if (hasCsv) {
      button('本地 CSV').click()
      expect(updateAnalysis.mock.lastCall?.[0]).toHaveLength(1)
    }
  })

  it('后批次取代未完成批次，旧批次不追加记录或覆盖新反馈', async () => {
    await mount()
    await importFiles([csvFile('existing.csv')])
    const slow = deferred<string>()
    const read = vi.fn(() => slow.promise)
    startImport([csvFile('staged.csv'), { ...csvFile('slow.csv'), text: read }])
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
    startImport([csvFile('new.csv'), csvFile('bad.csv', 'bad')])
    await vi.waitFor(() => expect(importStatus().textContent).toContain('bad.csv'))
    const message = importStatus().textContent
    slow.resolve(CSV)
    await slow.promise
    await Promise.resolve()
    expect(importStatus().textContent).toBe(message)
    const videos = updateAnalysis.mock.lastCall?.[0]
    expect(videos).toHaveLength(2)
    expect(videos.map((video: { id: number }) => video.id)).toEqual([-1, -2])
    expect(find((node) => node.classList.contains('source-files') && node.tag === 'p').textContent)
      .toBe('existing.csv：1/1 局 · new.csv：1/1 局')
  })

  it.each(['成绩概况', '赛博大表'])('%s 可见全部失败、部分失败和超大文件提示', async (page) => {
    await mount()
    button(page).click()
    await importFiles([csvFile('<坏文件>.csv', 'bad')])
    expect(importStatus().visible()).toBe(true)
    expect(importStatus().textContent).toContain('<坏文件>.csv')
    expect(importStatus().textContent).toContain('失败 1 个文件')
    expect(importStatus().children).toHaveLength(0)
    await importFiles([csvFile('ok.csv'), csvFile('bad.csv', 'bad')])
    await vi.waitFor(() => expect(importStatus().textContent).toContain('成功 1 个文件'))
    expect(importStatus().visible()).toBe(true)
    expect(importStatus().textContent).toContain('bad.csv')
    await importFiles([csvFile('big.csv', '', 21 * 1024 * 1024)])
    await vi.waitFor(() => expect(root.textContent).toContain('big.csv：超过 20 MB'))
    expect(importStatus().visible()).toBe(true)
  })

  it('无效行详情包含文件和物理行号，并限制展示条数', async () => {
    await mount()
    const badRows = Array(60).fill(ROW.replace(',5.00,', ',0,')).join('\n')
    await importFiles([csvFile('rows.csv', `${CSV}\n${badRows}`)])
    expect(root.textContent).toContain('rows.csv 第 3 行')
    expect(root.textContent).toContain('仅显示前 50 项')
    const details = find((node) => node.tag === 'details')
    expect(details.all().filter((node) => node.tag === 'li')).toHaveLength(50)
  })

  it('网站旧请求取消后不覆盖 CSV 导入错误', async () => {
    const old = deferred<LoadedPlayer>()
    vi.mocked(loadPlayer).mockReturnValueOnce(old.promise)
    await mount()
    await importFiles([csvFile('ok.csv'), csvFile('bad.csv', 'bad')])
    const message = importStatus().textContent
    expect(vi.mocked(loadPlayer).mock.calls[0]![1]!.signal!.aborted).toBe(true)
    old.reject(new DOMException('Aborted', 'AbortError'))
    await old.promise.catch(() => {})
    await Promise.resolve()
    expect(importStatus().textContent).toBe(message)
    expect(find((node) => node.classList.contains('player-status')).textContent).toBe('')
  })

  it.each(['成功', '失败'])('快速切回网站后旧请求%s不能清理新任务', async (completion) => {
    const old = deferred<LoadedPlayer>()
    const next = deferred<LoadedPlayer>()
    vi.mocked(loadPlayer).mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
    await mount()
    await importFiles([csvFile('ok.csv')])
    button('网站数据').click()
    expect(vi.mocked(loadPlayer)).toHaveBeenCalledTimes(2)
    const oldOptions = vi.mocked(loadPlayer).mock.calls[0]![1]!
    const nextOptions = vi.mocked(loadPlayer).mock.calls[1]![1]!
    if (completion === '成功') old.resolve(loaded())
    else old.reject(new Error('旧任务失败'))
    await old.promise.catch(() => {})
    await Promise.resolve()
    oldOptions.onProgress?.({ done: 9, total: 9 })
    expect(button('刷新').disabled).toBe(true)
    expect(root.textContent).not.toContain('9/9')
    button('取消').click()
    expect(nextOptions.signal!.aborted).toBe(true)
    next.resolve(loaded())
    await next.promise
  })

  it('补抓未过审的旧任务晚到，不覆盖 CSV 或显示加载状态', async () => {
    const initial = loaded()
    initial.rows.push({ userId: 16, id: 124, state: 'a', uploadTime: '', ongoing: false, detail: null })
    vi.mocked(loadPlayer).mockResolvedValueOnce(initial)
    const pending = deferred<Awaited<ReturnType<typeof ensureDetails>>>()
    vi.mocked(ensureDetails).mockReturnValueOnce(pending.promise)
    await mount()
    const check = find((node) => node.tag === 'input' && node.title.startsWith('把未审核'))
    check.checked = true
    check.emit('change')
    expect(ensureDetails).toHaveBeenCalledTimes(1)
    await importFiles([csvFile('ok.csv')])
    vi.mocked(ensureDetails).mock.calls[0]![3]!.onProgress?.({ done: 1, total: 1 })
    pending.resolve({ rows: initial.rows, missing: [] })
    await pending.promise
    await Promise.resolve()
    expect(find((node) => node.tag === 'h1').textContent).toBe('本地 CSV')
    expect(button('取消').visible()).toBe(false)
    expect(find((node) => node.classList.contains('player-status')).textContent).toBe('')
  })

  it('PB 只画有成绩的十位分组，异常网站 BBBV 不进入渲染', async () => {
    const data = loaded()
    data.rows.push({ ...data.rows[0]!, id: 124, detail: { ...data.rows[0]!.detail!, id: 124, bv: 1e20 } })
    vi.mocked(loadPlayer).mockResolvedValueOnce(data)
    await mount()
    expect(root.all().filter((node) => node.classList.contains('pb-rowlabel'))
      .map((node) => node.textContent)).toEqual(['10–19'])
    await importFiles([csvFile('sparse.csv', `${CSV}\n${ROW.replace(',12,2.40,', ',54,2.40,')}`)])
    const labels = root.all().filter((node) => node.classList.contains('pb-rowlabel'))
    expect(labels.map((node) => node.textContent)).toEqual(['10–19', '50–59'])
  })
})

describe('独立 CSV 启动模式', () => {
  async function mountCsv(): Promise<void> {
    vi.stubGlobal('location', { search: '?source=csv' })
    await mount()
  }

  it('首次打开不调用玩家接口，显示空态并隐藏网站控件', async () => {
    await mountCsv()
    expect(loadPlayer).not.toHaveBeenCalled()
    expect(ensureDetails).not.toHaveBeenCalled()
    expect(fetchUserInfo).not.toHaveBeenCalled()
    expect(createAnalysisViewMock).toHaveBeenLastCalledWith({
      autoSiteAnchors: false,
    })
    expect(find((node) => node.tag === 'h1').textContent).toBe('本地 CSV')
    expect(document.title).toBe('本地 CSV · 元神助手')
    expect(find((node) => node.classList.contains('csv-empty')).visible()).toBe(true)
    expect(button('选择 CSV 文件').visible()).toBe(true)
    expect(button('网站数据').visible()).toBe(false)
    expect(button('本地 CSV').visible()).toBe(false)
    expect(button('刷新').visible()).toBe(false)
    expect(root.all().filter((node) => node.tag === 'button' && node.textContent === '我的成绩'))
      .toHaveLength(0)
    expect(find((node) => node.classList.contains('page-tabs')).visible()).toBe(false)
    expect(updateAnalysis).toHaveBeenLastCalledWith([], { csv: true })
  })

  it('导入后可切换成绩概况，清除后仍留在 CSV 空态', async () => {
    await mountCsv()
    const empty = find((node) => node.classList.contains('csv-empty'))
    await importFiles([csvFile('ok.csv')])
    expect(updateAnalysis).toHaveBeenLastCalledWith(expect.any(Array), { csv: true })
    expect(empty.visible()).toBe(false)
    expect(button('成绩概况').visible()).toBe(true)
    expect(button('赛博大表').visible()).toBe(true)

    button('成绩概况').click()
    expect(find((node) => node.classList.contains('pb-grids')).visible()).toBe(true)

    button('清除 CSV').click()
    expect(empty.visible()).toBe(true)
    expect(find((node) => node.tag === 'h1').textContent).toBe('本地 CSV')
    expect(updateAnalysis).toHaveBeenLastCalledWith([], { csv: true })
    expect(loadPlayer).not.toHaveBeenCalled()
  })

  it('首次读取期间可取消导入，旧批次失效并回到空态', async () => {
    await mountCsv()
    const empty = find((node) => node.classList.contains('csv-empty'))
    const slow = deferred<string>()
    startImport([{ ...csvFile('slow.csv'), text: () => slow.promise }])

    expect(find((node) => node.classList.contains('csv-empty-note')).visible()).toBe(true)
    const cancel = button('取消导入')
    expect(cancel.visible()).toBe(true)
    cancel.click()
    expect(cancel.visible()).toBe(false)
    expect(find((node) => node.classList.contains('csv-empty-note')).visible()).toBe(false)
    expect(empty.visible()).toBe(true)
    expect(importStatus().textContent).toBe('')

    slow.resolve(CSV)
    await slow.promise
    await Promise.resolve()
    // 旧读取完成后不能提交数据、恢复提示或改变页面。
    expect(updateAnalysis).toHaveBeenLastCalledWith([], { csv: true })
    expect(empty.visible()).toBe(true)
    expect(importStatus().textContent).toBe('')
    expect(find((node) => node.tag === 'h1').textContent).toBe('本地 CSV')
  })
})

describe('站内嵌入模式', () => {
  it('自动带入玩家 ID，只保留赛博大表与加载操作', async () => {
    vi.stubGlobal('location', { search: '?id=16&embed=analysis' })
    await mount()
    expect(loadPlayer).toHaveBeenCalledWith(16, expect.objectContaining({ force: false }))
    expect(createAnalysisViewMock).toHaveBeenLastCalledWith({
      autoSiteAnchors: true,
    })
    expect(find((node) => node.tag === 'h1').textContent).toBe('#16')
    expect(find((node) => node.classList.contains('player-id')).textContent).toBe('ID 16')
    expect(find((node) => node.classList.contains('page-tabs')).visible()).toBe(false)
    expect(button('成绩概况').visible()).toBe(false)
    expect(button('导入 CSV').visible()).toBe(false)
    expect(button('我的成绩').visible()).toBe(false)
    expect(button('刷新').visible()).toBe(true)
    const panes = root.all().filter((node) => node.classList.contains('player-pane') && node.visible())
    expect(panes).toHaveLength(1)
    expect(panes[0]!.classList.contains('hidden')).toBe(false)
  })

  it('加载进度与失败原因在只有大表时仍然可见', async () => {
    const pending = deferred<LoadedPlayer>()
    vi.mocked(loadPlayer).mockReturnValueOnce(pending.promise)
    vi.stubGlobal('location', { search: '?id=16&embed=analysis' })
    await mount()

    const status = find((node) => node.classList.contains('player-status'))
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

describe('启动参数错误', () => {
  // 参数边界由 player-stats-launch.test.ts 覆盖，这里验证错误不会启动页面或请求。
  it('参数错误时不挂载大表、不加载数据', async () => {
    vi.stubGlobal('location', { search: '?id=0' })
    await mount()
    expect(root.textContent).toContain('缺少合法的用户 ID')
    expect(root.all().filter((node) => node.tag === 'main')).toHaveLength(0)
    expect(loadPlayer).not.toHaveBeenCalled()
    expect(createAnalysisViewMock).not.toHaveBeenCalled()
  })
})
