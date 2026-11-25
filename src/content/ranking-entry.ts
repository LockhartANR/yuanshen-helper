/** 在 openms.top 排行榜的外层页签栏末尾挂载扩展入口。 */
import { RANKING_OPEN_MESSAGE, isRankingUrl } from '../shared/ranking-route'

const HOST_ID = 'ysh-ranking-entry'
const STYLE_ID = 'ysh-ranking-entry-style'
const SYNC_DELAY_MS = 120
const ROUTE_POLL_MS = 800

const RANKING_TABS = [
  ['tab-speed', '竞速'],
  ['tab-efficiency', '效率'],
  ['tab-density', '密度'],
  ['tab-tournament', '比赛'],
  ['tab-minigame', '小游戏'],
  ['tab-media', '作品'],
] as const

const ENTRY_STYLE = `
#${HOST_ID} {
  --ysh-ranking-accent: var(--ui-color-primary-dark-2, var(--el-color-primary-dark-2, #337ecc));
  --ysh-ranking-label: color-mix(in srgb, var(--ysh-ranking-accent) 85%, black);
  --ysh-ranking-hover: color-mix(in srgb, var(--ysh-ranking-accent) 70%, black);
  position: relative;
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  min-height: var(--el-tabs-header-height, 40px);
  padding-inline: 4px;
}
html.dark #${HOST_ID} {
  --ysh-ranking-label: var(--ui-color-primary-dark-2, var(--el-color-primary-dark-2, #66b1ff));
  --ysh-ranking-hover: var(--ui-color-primary, var(--el-color-primary, #409eff));
}
#${HOST_ID} .ysh-ranking-button {
  display: inline-flex;
  align-items: center;
  min-height: 28px;
  padding: 2px 10px;
  border: 0;
  background: transparent;
  color: var(--ysh-ranking-label);
  font: inherit;
  font-size: var(--el-font-size-base, 14px);
  font-weight: 500;
  line-height: 1.25;
  cursor: pointer;
}
#${HOST_ID} .ysh-ranking-button:hover {
  color: var(--ysh-ranking-hover);
}
#${HOST_ID} .ysh-ranking-button:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 2px;
}
#${HOST_ID} .ysh-ranking-button:disabled {
  cursor: wait;
  opacity: 0.7;
}
#${HOST_ID} .ysh-ranking-status {
  position: absolute;
  z-index: 1;
  inset-block-start: 100%;
  inset-inline-end: 0;
  width: min(220px, 75vw);
  margin: 0;
  padding: 6px 8px;
  border: 1px solid var(--el-border-color, #dcdfe6);
  border-radius: 5px;
  background: var(--el-bg-color-overlay, Canvas);
  color: var(--el-text-color-primary, CanvasText);
  font-size: 12px;
  white-space: normal;
  overflow-wrap: anywhere;
}
#${HOST_ID} .ysh-ranking-status[hidden] {
  display: none;
}
`

let started = false
let syncTimer: ReturnType<typeof setTimeout> | undefined
let host: HTMLElement | null = null
let busy = false

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = ENTRY_STYLE
  document.head.append(style)
}

/** 只匹配拥有完整六个原生页签的独立导航栏，优先用与语言无关的 ID。 */
export function findRankingTabNav(root: ParentNode = document): HTMLElement | null {
  let fallback: HTMLElement | null = null
  for (const nav of root.querySelectorAll<HTMLElement>('.el-tabs__nav, [role="tablist"]')) {
    if (!nav.getClientRects().length || nav.closest('table')) continue
    const items = Array.from(nav.children).filter((child) =>
      child.matches('.el-tabs__item, [role="tab"]'),
    )
    if (RANKING_TABS.every(([id]) => items.some((item) => item.id === id))) return nav
    if (!fallback && RANKING_TABS.every(([, label]) =>
      items.some((item) => item.textContent?.replace(/\s+/g, '') === label),
    )) {
      fallback = nav
    }
  }
  return fallback
}

function createEntry(): HTMLElement {
  const container = document.createElement('div')
  container.id = HOST_ID
  const control = document.createElement('button')
  control.type = 'button'
  control.className = 'ysh-ranking-button'
  control.textContent = '自定义'
  control.setAttribute('aria-label', '自定义：在新标签页打开排行榜')
  control.title = '在新标签页打开自定义排行榜'
  const status = document.createElement('p')
  status.className = 'ysh-ranking-status'
  status.setAttribute('role', 'alert')
  status.hidden = true
  container.append(control, status)
  control.addEventListener('click', () => {
    void openRanking(control, status)
  })
  control.addEventListener('keydown', (event) => {
    // Element Plus 在 tablist 上监听方向键，不能把按钮当作原生页签处理。
    if (event.key.startsWith('Arrow')) event.stopPropagation()
  })
  return container
}

async function openRanking(control: HTMLButtonElement, status: HTMLElement): Promise<void> {
  if (busy) return
  busy = true
  control.disabled = true
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
  }
}

function removeEntry(): void {
  host?.remove()
  host = null
}

function sync(): void {
  const nav = isRankingUrl(window.location.href) ? findRankingTabNav() : null
  if (!nav) {
    removeEntry()
    return
  }
  if (!host) {
    ensureStyle()
    host = createEntry()
  }
  // Vue 重绘时复用入口；位置正确时跳过写入，避免触发观察器循环。
  if (nav.lastElementChild !== host) nav.append(host)
}

function scheduleSync(): void {
  if (syncTimer !== undefined) clearTimeout(syncTimer)
  syncTimer = setTimeout(() => {
    syncTimer = undefined
    sync()
  }, SYNC_DELAY_MS)
}

export function startRankingEntry(): void {
  if (started || window.top !== window) return
  started = true
  window.addEventListener('hashchange', scheduleSync)
  window.addEventListener('popstate', scheduleSync)
  window.addEventListener('pageshow', scheduleSync)
  window.addEventListener('pagehide', removeEntry)
  const observer = new MutationObserver(scheduleSync)
  observer.observe(document.documentElement, { childList: true, subtree: true })

  // Vue Router 可通过 replaceState 更新 hash，而不触发 hashchange。
  let lastHref = window.location.href
  setInterval(() => {
    if (window.location.href === lastHref) return
    lastHref = window.location.href
    scheduleSync()
  }, ROUTE_POLL_MS)
  scheduleSync()
}
