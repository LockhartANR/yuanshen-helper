/**
 * openms.top 玩家页的「赛博大表」入口。
 *
 * 只在 `https://openms.top/#/player/<ID>` 路由下挂载一个入口；用户点击后才创建
 * 扩展 iframe（player.html?id=…&embed=analysis）。不做预取，不读取站点框架状态。
 *
 * 生命周期：
 * - hash 路由变化（含前进 / 后退）重新解析玩家；
 * - MutationObserver 只用于目标容器延迟出现或站点重绘后恢复入口；
 * - 设置关闭时立即移除入口与 iframe；重新开启只恢复入口；
 * - 收起 / 切换玩家 / 离开玩家页时销毁 iframe，旧实例的晚到消息不会回写。
 */
import { ANALYSIS_PLAYER_PAGE, EMBEDDED_ANALYSIS_PLAYER_PAGE } from '../shared/constants'
import { el } from '../shared/ui'
import { getSettings } from '../shared/settings'
import { parseSitePlayerRoute } from '../features/player-stats/launch'

const HOST_ID = 'ysh-site-analysis'
const STYLE_ID = 'ysh-site-analysis-style'
const READY_MESSAGE = 'YUANSHEN_ANALYSIS_READY'
const READY_VERSION = 1
const READY_TIMEOUT_MS = 10_000
const SYNC_DELAY_MS = 120
const ROUTE_POLL_MS = 800

/** 玩家信息附近的候选容器，按优先级排列；都找不到时用右下角备用入口。 */
const TARGET_SELECTORS = [
  '.player-info',
  '.player-detail',
  '.player-header',
  '.user-info',
  '.user-detail',
  '#player-info',
  '.profile-card',
]

const PANEL_STYLE = `
#${HOST_ID} {
  margin: 14px 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei",
    "PingFang SC", sans-serif;
}
#${HOST_ID}.ysh-floating {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 2147483000;
  margin: 0;
}
#${HOST_ID} .ysh-entry {
  display: inline-flex;
  align-items: center;
  gap: 6px;
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
  box-shadow: 0 2px 8px rgb(15 23 42 / 18%);
}
#${HOST_ID} .ysh-entry:hover {
  filter: brightness(1.06);
}
#${HOST_ID}.ysh-open .ysh-entry {
  display: none;
}
#${HOST_ID} .ysh-panel {
  overflow: hidden;
  border: 1px solid #d7dee8;
  border-radius: 12px;
  background: #fff;
  box-shadow: 0 10px 30px rgb(15 23 42 / 18%);
}
#${HOST_ID}.ysh-floating .ysh-panel {
  width: min(1080px, calc(100vw - 36px));
}
#${HOST_ID} .ysh-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid #e2e8f0;
  background: #f8fafc;
  color: #0f172a;
  font-size: 13px;
}
#${HOST_ID} .ysh-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#${HOST_ID} .ysh-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
}
#${HOST_ID} .ysh-action {
  padding: 4px 10px;
  border: 1px solid #cbd5e1;
  border-radius: 7px;
  background: #fff;
  color: #0f172a;
  font: inherit;
  font-size: 12px;
  line-height: 1.4;
  text-decoration: none;
  cursor: pointer;
}
#${HOST_ID} .ysh-action:hover {
  border-color: #2563eb;
  color: #2563eb;
}
#${HOST_ID} .ysh-status {
  margin: 0;
  padding: 6px 12px;
  border-bottom: 1px solid #e2e8f0;
  background: #fffbeb;
  color: #92400e;
  font-size: 12px;
}
#${HOST_ID} .ysh-status[hidden] {
  display: none;
}
#${HOST_ID} .ysh-frame {
  display: block;
  width: 100%;
  height: min(72vh, 860px);
  min-height: 420px;
  border: 0;
  background: #fff;
}
#${HOST_ID}.ysh-floating .ysh-frame {
  height: min(76vh, 900px);
}
@media (prefers-color-scheme: dark) {
  #${HOST_ID} {
    color-scheme: dark;
  }
  #${HOST_ID} .ysh-panel {
    border-color: #1e293b;
    background: #0b1220;
  }
  #${HOST_ID} .ysh-bar {
    border-color: #1e293b;
    background: #111c31;
    color: #e2e8f0;
  }
  #${HOST_ID} .ysh-action {
    border-color: #334155;
    background: #0b1220;
    color: #e2e8f0;
  }
  #${HOST_ID} .ysh-status {
    border-color: #1e293b;
    background: #2a1a05;
    color: #fbbf24;
  }
}
`

interface EntryState {
  playerId: number
  host: HTMLElement
  entry: HTMLButtonElement
}

let enabled = true
let started = false
let observer: MutationObserver | null = null
let syncTimer: ReturnType<typeof setTimeout> | undefined
let entryState: EntryState | null = null
let panel: HTMLElement | null = null
let frame: HTMLIFrameElement | null = null
let statusNode: HTMLElement | null = null
let readyTimer: ReturnType<typeof setTimeout> | undefined
let instanceId = 0

function currentPlayerId(): number | null {
  // 站点目前用 hash 路由；兼容直接访问 /player/<ID> 的路径形式。
  return parseSitePlayerRoute(window.location.hash) ?? parseSitePlayerRoute(window.location.pathname)
}

function extensionOrigin(): string {
  return chrome.runtime.getURL('').replace(/\/+$/, '')
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = PANEL_STYLE
  document.head.append(style)
}

function findTarget(): HTMLElement | null {
  for (const selector of TARGET_SELECTORS) {
    const node = document.querySelector<HTMLElement>(selector)
    if (!node || !node.isConnected) continue
    // 隐藏容器（例如尚未渲染的 tab）不作为主挂载点。
    if (node.getClientRects().length === 0) continue
    return node
  }
  return null
}

function placeHost(host: HTMLElement): void {
  const target = findTarget()
  if (!target) {
    host.classList.add('ysh-floating')
    ;(document.body ?? document.documentElement).append(host)
    return
  }
  host.classList.remove('ysh-floating')
  target.insertAdjacentElement('afterend', host)
}

function scheduleSync(): void {
  if (syncTimer !== undefined) clearTimeout(syncTimer)
  syncTimer = setTimeout(() => {
    syncTimer = undefined
    sync()
  }, SYNC_DELAY_MS)
}

let routeTimer: ReturnType<typeof setInterval> | undefined
let lastHref = ''

/**
 * 站点的 hash 路由可能通过 history.pushState 切换，不会触发 hashchange；
 * 这里只比较地址是否变化，不读取站点框架状态，也不改 DOM。
 */
function startRouteWatcher(): void {
  if (routeTimer !== undefined) return
  lastHref = window.location.href
  routeTimer = setInterval(() => {
    if (window.location.href === lastHref) return
    lastHref = window.location.href
    scheduleSync()
  }, ROUTE_POLL_MS)
}

function stopObserver(): void {
  observer?.disconnect()
  observer = null
}

function startObserver(): void {
  if (observer) return
  // documentElement 不会随站点重绘被替换；观察范围仅限子节点增删，回调已合并。
  observer = new MutationObserver(() => scheduleSync())
  observer.observe(document.documentElement, { childList: true, subtree: true })
}

function sync(): void {
  const playerId = currentPlayerId()
  if (!enabled || playerId === null) {
    unmount()
    return
  }
  if (entryState?.playerId === playerId) {
    if (!entryState.host.isConnected) {
      // 站点重绘把入口连同 iframe 一起清掉了：只恢复未展开的入口，不自动重载大表。
      unmount()
      mountEntry(playerId)
      return
    }
    // 站点重绘后目标容器可能晚到；只在还没有主挂载点且面板未展开时升级位置，避免来回搬动。
    if (!panel && entryState.host.classList.contains('ysh-floating') && findTarget()) {
      placeHost(entryState.host)
    }
    startObserver()
    return
  }
  unmount()
  mountEntry(playerId)
}

function mountEntry(playerId: number): void {
  const existing = document.getElementById(HOST_ID)
  if (existing) existing.remove()

  ensureStyle()
  const host = el('div')
  host.id = HOST_ID
  const entry = el('button', 'ysh-entry', '赛博大表')
  entry.type = 'button'
  entry.title = `展开玩家 ${playerId} 的完整赛博大表`
  entry.setAttribute('aria-label', `展开玩家 ${playerId} 的赛博大表`)
  entry.addEventListener('click', () => openPanel(playerId))
  host.append(entry)
  placeHost(host)

  entryState = { playerId, host, entry }
  startObserver()
}

function clearReadyTimer(): void {
  if (readyTimer !== undefined) clearTimeout(readyTimer)
  readyTimer = undefined
}

function setStatus(text: string): void {
  if (!statusNode) return
  statusNode.textContent = text
  statusNode.hidden = text === ''
}

function openPanel(playerId: number): void {
  if (entryState?.playerId !== playerId) return
  if (panel) {
    panel.scrollIntoView({ block: 'nearest' })
    return
  }

  instanceId += 1
  const ownInstance = instanceId
  const panelNode = el('section', 'ysh-panel')
  const bar = el('div', 'ysh-bar')
  bar.append(el('span', 'ysh-title', `玩家 #${playerId} · 赛博大表`))

  const closeButton = el('button', 'ysh-action', '收起')
  closeButton.type = 'button'
  closeButton.addEventListener('click', () => {
    closePanel()
    entryState?.entry.focus()
  })

  const openLink = el('a', 'ysh-action', '独立打开')
  openLink.href = chrome.runtime.getURL(ANALYSIS_PLAYER_PAGE(playerId))
  openLink.target = '_blank'
  openLink.rel = 'noopener noreferrer'

  const actions = el('span', 'ysh-actions')
  actions.append(openLink, closeButton)
  bar.append(actions)

  const status = el('p', 'ysh-status', '正在加载大表…')
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  statusNode = status

  const iframe = document.createElement('iframe')
  iframe.className = 'ysh-frame'
  iframe.title = `玩家 ${playerId} 赛博大表`
  iframe.dataset.instance = String(ownInstance)
  iframe.allow = 'clipboard-write'
  iframe.referrerPolicy = 'no-referrer'
  iframe.src = chrome.runtime.getURL(EMBEDDED_ANALYSIS_PLAYER_PAGE(playerId))

  panelNode.append(bar, status, iframe)
  entryState.host.append(panelNode)
  entryState.host.classList.add('ysh-open')
  panel = panelNode
  frame = iframe
  // 入口按钮打开后隐藏，焦点交给「收起」，键盘用户仍能直接退出。
  closeButton.focus()

  // iframe 的 load 事件不能当作“业务已就绪”，只认页面主动发来的就绪消息。
  clearReadyTimer()
  readyTimer = setTimeout(() => {
    if (ownInstance !== instanceId) return
    setStatus('大表加载较慢或被站点拦截，可点「独立打开」查看。')
  }, READY_TIMEOUT_MS)
}

function closePanel(): void {
  instanceId += 1
  clearReadyTimer()
  panel?.remove()
  panel = null
  frame = null
  statusNode = null
  entryState?.host.classList.remove('ysh-open')
}

function unmount(): void {
  closePanel()
  entryState?.host.remove()
  entryState = null
  stopObserver()
  if (syncTimer !== undefined) {
    clearTimeout(syncTimer)
    syncTimer = undefined
  }
}

function handleMessage(event: MessageEvent): void {
  const currentFrame = frame
  if (!currentFrame) return
  if (event.source !== currentFrame.contentWindow) return
  if (event.origin !== extensionOrigin()) return
  const data = event.data as { type?: unknown; v?: unknown; userId?: unknown } | null
  if (!data || data.type !== READY_MESSAGE || data.v !== READY_VERSION) return
  if (data.userId !== entryState?.playerId) return
  if (currentFrame.dataset.instance !== String(instanceId)) return
  clearReadyTimer()
  setStatus('')
  currentFrame.dataset.ready = '1'
}

function handleStorageChange(
  changes: Record<string, chrome.storage.StorageChange>,
  area: string,
): void {
  if (area !== 'local' || !changes.settings) return
  const next = changes.settings.newValue as { siteAnalysisEnabled?: boolean } | undefined
  const nextEnabled = next?.siteAnalysisEnabled !== false
  if (nextEnabled === enabled) return
  enabled = nextEnabled
  if (!enabled) unmount()
  else sync()
}

async function loadSettings(): Promise<void> {
  try {
    const settings = await getSettings()
    enabled = settings.siteAnalysisEnabled
  } catch {
    // 读不到设置时保持默认开启，但不要因此频繁报错。
  }
  sync()
}

/** 内容脚本入口；重复调用无副作用。 */
export function startPlayerAnalysis(): void {
  if (started) return
  started = true
  window.addEventListener('hashchange', scheduleSync)
  window.addEventListener('popstate', scheduleSync)
  window.addEventListener('pagehide', unmount)
  window.addEventListener('message', handleMessage)
  chrome.storage.onChanged.addListener(handleStorageChange)
  startRouteWatcher()
  void loadSettings()
}
