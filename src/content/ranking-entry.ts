/**
 * openms.top 排行榜页的「自定义排行榜」入口。
 *
 * 只处理顶层页面 hash 路由 `#/ranking` 及其子路径；通过后台固定消息打开扩展页，
 * 内容脚本不直接调用 chrome.tabs，也不请求网站接口。
 *
 * 入口固定在外层排行榜页签组（竞速／效率／密度／比赛／小游戏／作品）之前，
 * 与该页签组处于同一公共布局层级。找不到可靠的页签组时等待页面渲染，
 * 不按标题、内部标题或 main 猜测位置。
 */
import { RANKING_OPEN_MESSAGE, isRankingUrl } from '../shared/ranking-route'

const HOST_ID = 'ysh-ranking-entry'
const STYLE_ID = 'ysh-ranking-entry-style'
const SYNC_DELAY_MS = 120
const ROUTE_POLL_MS = 800

/** 站内外层排行榜页签；六个标签同时出现才认为是可挂载的页签组。 */
const TAB_LABELS = ['竞速', '效率', '密度', '比赛', '小游戏', '作品'] as const

const ENTRY_STYLE = `
#${HOST_ID} {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin: 12px 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei",
    "PingFang SC", sans-serif;
}
#${HOST_ID} .ysh-ranking-button {
  display: inline-flex;
  align-items: center;
  min-height: 32px;
  padding: 5px 14px;
  border: 1px solid #2563eb;
  border-radius: 8px;
  background: #2563eb;
  color: #fff;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
  cursor: pointer;
  box-shadow: 0 2px 8px rgb(15 23 42 / 16%);
}
#${HOST_ID} .ysh-ranking-button:hover {
  filter: brightness(1.06);
}
#${HOST_ID} .ysh-ranking-button:disabled {
  cursor: wait;
  opacity: 0.7;
}
#${HOST_ID} .ysh-ranking-status {
  margin: 0;
  color: #b45309;
  font-size: 12px;
}
#${HOST_ID} .ysh-ranking-status[hidden] {
  display: none;
}
@media (prefers-color-scheme: dark) {
  #${HOST_ID} .ysh-ranking-button {
    border-color: #3b82f6;
    background: #2563eb;
  }
  #${HOST_ID} .ysh-ranking-status {
    color: #fbbf24;
  }
}
`

let started = false
let observer: MutationObserver | null = null
let syncTimer: ReturnType<typeof setTimeout> | undefined
let routeTimer: ReturnType<typeof setInterval> | undefined
let host: HTMLElement | null = null
let busy = false
let lastHref = ''

function isTopRankingPage(): boolean {
  if (window.top !== window) return false
  return isRankingUrl(window.location.href)
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = ENTRY_STYLE
  document.head.append(style)
}

function isVisible(node: HTMLElement): boolean {
  return node.isConnected && (typeof node.getClientRects !== 'function' || node.getClientRects().length > 0)
}

/** 页签文字必须等于标签本身，避免把表格里的玩家名或说明文字当作页签。 */
function isTabLabel(node: Element, label: string): boolean {
  const text = (node.textContent ?? '').replace(/\s+/g, '')
  return text === label
}

function containsAllLabels(container: Element): boolean {
  for (const label of TAB_LABELS) {
    let found = false
    for (const node of container.querySelectorAll<HTMLElement>('a, button, [role="tab"], li, span, div')) {
      if (isTabLabel(node, label)) {
        found = true
        break
      }
    }
    if (!found) return false
  }
  return true
}

/**
 * 在候选页签元素上向上寻找同时包含六个标签的最深祖先；
 * 再要求该祖先位于页签组件内部，返回整个页签组件（而不是单个按钮的包裹层）。
 */
function commonTabGroup(candidates: HTMLElement[]): HTMLElement | null {
  for (const candidate of candidates) {
    let node: HTMLElement | null = candidate.parentElement
    while (node) {
      // 不越过 body / html；测试与降级环境下没有 document 时也能结束。
      if (node.tagName && /^(BODY|HTML)$/i.test(node.tagName)) break
      if (containsAllLabels(node)) {
        // 返回整个 Element Plus 组件，使入口位于导航与内容区共同容器之前。
        return node.closest<HTMLElement>('.el-tabs') ?? node
      }
      node = node.parentElement
    }
  }
  return null
}

/**
 * 查找站内外层排行榜页签容器。
 *
 * 站点当前使用 Element Plus 的 el-tabs；这里同时兼容 `role=tab` 与普通按钮 /
 * 链接组。导航区须包含完整六个标签且不在表格内；没有独立导航区时，
 * 才要求整个容器不含表格，避免误挂到榜单内容区。
 */
export function findRankingTabGroup(root: ParentNode = document): HTMLElement | null {
  const tabItems = [
    ...root.querySelectorAll<HTMLElement>('.el-tabs__item, [role="tab"]'),
  ].filter((node) => isVisible(node))
  const exacts = tabItems.filter((node) =>
    TAB_LABELS.some((label) => isTabLabel(node, label)),
  )
  let group = exacts.length >= TAB_LABELS.length ? commonTabGroup(exacts) : null
  if (!group) {
    const scans = [
      ...root.querySelectorAll<HTMLElement>('.el-tabs__item, [role="tab"], a, button'),
    ].filter((node) => isVisible(node))
    const candidates = scans.filter((node) =>
      TAB_LABELS.some((label) => isTabLabel(node, label)),
    )
    if (candidates.length >= TAB_LABELS.length) group = commonTabGroup(candidates)
  }
  if (!group) return null
  // 页签导航区：真实站点的榜单表格在 el-tabs__content 内，不能因为内容区有表格就放弃挂载。
  const nav = group.querySelector<HTMLElement>(
    '.el-tabs__header, .el-tabs__nav, [role="tablist"]',
  )
  if (nav && !nav.closest('table') && containsAllLabels(nav)) return group
  // 没有独立导航区，或导航区不含六个标签：退回按整个容器严格判断，含表格就不挂载。
  if (group.closest('table')) return null
  if (group.querySelector('table')) return null
  if (!containsAllLabels(group)) return null
  return group
}

function createEntry(): { host: HTMLElement; button: HTMLButtonElement; status: HTMLElement } {
  const container = document.createElement('div')
  container.id = HOST_ID
  const control = document.createElement('button')
  control.type = 'button'
  control.className = 'ysh-ranking-button'
  control.textContent = '自定义排行榜 ↗'
  control.setAttribute('aria-label', '打开自定义排行榜')
  const status = document.createElement('p')
  status.className = 'ysh-ranking-status'
  status.hidden = true
  container.append(control, status)
  control.addEventListener('click', () => {
    void openRanking(control, status)
  })
  return { host: container, button: control, status }
}

async function openRanking(control: HTMLButtonElement, status: HTMLElement): Promise<void> {
  if (busy) return
  busy = true
  control.disabled = true
  control.textContent = '正在打开…'
  status.hidden = true
  try {
    const response = (await chrome.runtime.sendMessage({
      type: RANKING_OPEN_MESSAGE,
    })) as { ok?: boolean; error?: string } | undefined
    if (!response?.ok) throw new Error(response?.error || '后台未返回打开结果')
  } catch (error) {
    status.textContent = `打开自定义排行榜失败：${error instanceof Error ? error.message : String(error)}`
    status.hidden = false
  } finally {
    busy = false
    control.disabled = false
    control.textContent = '自定义排行榜 ↗'
  }
}

function removeEntry(): void {
  host?.remove()
  host = null
}

/** 同一节点只移动位置，不重复创建；位置正确时不做任何 DOM 写入。 */
function placeBefore(target: HTMLElement): void {
  if (host && host.parentElement === target.parentElement && host.nextElementSibling === target) {
    return
  }
  if (!host || !host.isConnected) {
    ensureStyle()
    host = createEntry().host
  }
  host.dataset.placement = 'tab-group'
  target.parentElement?.insertBefore(host, target)
}

function sync(): void {
  if (!isTopRankingPage()) {
    removeEntry()
    return
  }
  const tabGroup = findRankingTabGroup()
  // 页签尚未渲染或站点正在重绘：等待下一次调度，不猜测挂载点。
  if (!tabGroup) {
    if (host && !host.isConnected) host = null
    return
  }
  placeBefore(tabGroup)
}

function scheduleSync(): void {
  if (syncTimer !== undefined) clearTimeout(syncTimer)
  syncTimer = setTimeout(() => {
    syncTimer = undefined
    sync()
  }, SYNC_DELAY_MS)
}

function startObserver(): void {
  if (observer) return
  observer = new MutationObserver(() => scheduleSync())
  observer.observe(document.documentElement, { childList: true, subtree: true })
}

function startRouteWatcher(): void {
  if (routeTimer !== undefined) return
  lastHref = window.location.href
  routeTimer = setInterval(() => {
    if (window.location.href === lastHref) return
    lastHref = window.location.href
    scheduleSync()
  }, ROUTE_POLL_MS)
}

export function startRankingEntry(): void {
  if (started) return
  started = true
  window.addEventListener('hashchange', scheduleSync)
  window.addEventListener('popstate', scheduleSync)
  window.addEventListener('pageshow', scheduleSync)
  window.addEventListener('pagehide', removeEntry)
  startObserver()
  startRouteWatcher()
  scheduleSync()
}
