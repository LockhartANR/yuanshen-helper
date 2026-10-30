import { PLAYER_URL } from './constants'

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** 站外链接：统一新标签页打开，避免把扩展页面顶掉。 */
export function externalLink(text: string, href: string): HTMLAnchorElement {
  const node = document.createElement('a')
  node.className = 'site-link'
  node.textContent = text
  node.href = href
  node.target = '_blank'
  node.rel = 'noreferrer'
  return node
}

/** 扩展图标，用在高亮页面的标题区，避免再画一个「元」字方块。 */
export function brandLogo(size = 44): HTMLImageElement {
  const img = document.createElement('img')
  img.className = 'logo'
  img.src = chrome.runtime.getURL('icons/icon128.png')
  img.alt = ''
  img.width = size
  img.height = size
  img.decoding = 'async'
  return img
}

export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  waitMs: number,
): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  return (...args: A) => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      fn(...args)
    }, waitMs)
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }

    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

export async function openPlayerTab(id: number): Promise<void> {
  await chrome.tabs.create({ url: PLAYER_URL(id) })
}

export function openOptionsPage(): void {
  void chrome.runtime.openOptionsPage()
}
