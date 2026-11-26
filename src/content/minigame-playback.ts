import { SITE_ORIGIN } from '../shared/constants'
import { isAbortError } from '../shared/ui'
import { bufferToBase64 } from '../features/upload-watch/bytes'
import { isObject, MAX_ARCHIVE_BYTES, safeInteger } from '../features/minigame-export/model'
import { readLocalPlayback } from '../features/minigame-export/site-history'
import { decodePlayback } from '../features/minigame-export/playback-frame'
import { downloadReplay } from '../features/minigame-export/download'
import {
  onlineMode, playbackTarget, PLAYBACK_BRIDGE, targetIdentity,
  type PlaybackSnapshot, type PlaybackTarget,
} from '../features/minigame-export/playback'

const HOST_ID = 'ysh-minigame-export'
const STYLE_ID = `${HOST_ID}-style`
const ENTRY_STYLE = `
#${HOST_ID} { display: flex; flex-wrap: wrap; justify-content: center; align-items: center; gap: 8px;
  width: 100%; max-width: 52rem; min-width: 0; margin-inline: auto; text-align: center; }
#${HOST_ID} button { border: 1px solid var(--ui-color-primary, #409eff); border-radius: 4px;
  padding: 5px 10px; background: var(--ui-color-primary, #337ecc); color: white; font: inherit;
  font-size: 13px; line-height: 1.4; cursor: pointer; }
#${HOST_ID} button:hover { filter: brightness(1.1); }
#${HOST_ID} button:focus-visible { outline: 2px solid var(--ui-color-primary, #409eff); outline-offset: 3px; }
#${HOST_ID} button:disabled { opacity: .65; cursor: wait; }
#${HOST_ID} [role=status] { flex: 0 0 100%; min-width: 0; color: var(--ui-text-color-regular, CanvasText);
  font-size: 12px; overflow-wrap: anywhere; }
#${HOST_ID} [hidden] { display: none; }
`

export function startMinigamePlayback(): void {
  if (window.top !== window) return
  let host: HTMLElement | null = null
  let control: HTMLButtonElement | null = null
  let cancel: HTMLButtonElement | null = null
  let status: HTMLElement | null = null
  let identity = ''
  let active: AbortController | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let online: { url: string; data: ArrayBuffer; scoreMs: number } | null = null
  let captureError = '未取得本页加载的录像，请刷新页面后重试'

  function showStatus(text: string): void {
    if (!status || status.textContent === text) return
    status.textContent = text
    status.hidden = !text
  }

  function updateControls(): void {
    if (control) control.disabled = active !== undefined
    if (cancel) cancel.hidden = active === undefined
  }

  function stopExport(): void {
    const controller = active
    active = undefined
    controller?.abort()
    updateControls()
  }

  async function exportCurrent(): Promise<void> {
    if (active) return
    const url = location.href
    const target = playbackTarget(url)
    if (!target || !document.querySelector('.training-page[data-replay="true"]')) return
    const controller = active = new AbortController()
    const signal = controller.signal
    updateControls()
    showStatus('正在准备当前录像…')
    try {
      let snapshot: PlaybackSnapshot
      if (target.kind === 'local') snapshot = { target, record: await readLocalPlayback(target.game, target.id) }
      else {
        if (!online || targetIdentity(playbackTarget(online.url)) !== targetIdentity(target)) throw new Error(captureError)
        snapshot = { target, record: { metadata: { game: target.game, mode: onlineMode(target), scoreMs: online.scoreMs },
          payload: { encoding: '7z', data: bufferToBase64(online.data) } } }
      }
      signal.throwIfAborted()
      if (targetIdentity(playbackTarget(location.href)) !== targetIdentity(target)) throw new Error('回放已切换，请重新导出')
      showStatus('正在解压当前录像…')
      const file = await decodePlayback(snapshot, url, signal)
      signal.throwIfAborted()
      if (targetIdentity(playbackTarget(location.href)) !== targetIdentity(target)
        || !document.querySelector('.training-page[data-replay="true"]')) throw new Error('回放已切换，请重新导出')
      downloadReplay(file.blob, file.filename)
      showStatus(`已生成单局录像：${file.filename}`)
    } catch (error) {
      if (active === controller) showStatus(isAbortError(error) ? '已取消导出，未生成文件' : error instanceof Error ? error.message : '导出录像失败，请重试')
    } finally {
      if (active === controller) { active = undefined; updateControls() }
    }
  }

  function sync(): void {
    const target = playbackTarget(location.href)
    const key = targetIdentity(target)
    if (key !== identity) {
      stopExport()
      identity = key
      online = null
      captureError = '未取得本页加载的录像，请刷新页面后重试'
      showStatus('')
      window.postMessage({ channel: PLAYBACK_BRIDGE, type: 'snapshot' }, SITE_ORIGIN)
    }
    const page = target && document.querySelector('.training-page[data-replay="true"]')
    const controls = page?.querySelector<HTMLElement>('.minigame-replay-controls')
    // Keep a separate centered row above the timeline, or below the level row for missing-cell.
    const anchor = controls ?? page?.querySelector<HTMLElement>('.training-controls')
    if (!anchor) { host?.remove(); return }
    if (!host) {
      if (!document.getElementById(STYLE_ID)) {
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = ENTRY_STYLE
        document.head.append(style)
      }
      host = document.createElement('div')
      host.id = HOST_ID
      control = document.createElement('button')
      control.type = 'button'
      control.textContent = '导出录像'
      control.title = '直接下载当前完整录像 JSON'
      control.addEventListener('click', (event) => { if (event.isTrusted) void exportCurrent() })
      cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.textContent = '取消导出'
      cancel.addEventListener('click', () => { stopExport(); showStatus('已取消导出，未生成文件') })
      status = document.createElement('span')
      status.setAttribute('role', 'status')
      status.setAttribute('aria-live', 'polite')
      status.hidden = true
      host.append(control, cancel, status)
      updateControls()
    }
    if (controls) {
      if (host.nextElementSibling !== anchor) anchor.before(host)
    } else if (host.previousElementSibling !== anchor) anchor.after(host)
  }

  function scheduleSync(): void {
    if (timer !== undefined) return
    timer = setTimeout(() => { timer = undefined; sync() }, 80)
  }

  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    const data = event.data
    if (event.source !== window || event.origin !== SITE_ORIGIN || !isObject(data)
      || data.channel !== PLAYBACK_BRIDGE || data.type !== 'state' || typeof data.url !== 'string') return
    const target: PlaybackTarget | null = playbackTarget(data.url)
    if (!target || target.kind !== 'online' || targetIdentity(target) !== targetIdentity(playbackTarget(location.href))) return
    // Update the route first so a later DOM mutation cannot clear a newly captured response.
    if (targetIdentity(target) !== identity) { stopExport(); identity = targetIdentity(target); showStatus('') }
    online = null
    captureError = typeof data.error === 'string' ? data.error.slice(0, 240)
      : data.loading === true ? '录像仍在加载，请稍后重试' : '未取得本页加载的录像，请刷新页面后重试'
    if (data.data instanceof ArrayBuffer && data.data.byteLength > 0 && data.data.byteLength <= MAX_ARCHIVE_BYTES
      && safeInteger(data.scoreMs, 1)) online = { url: data.url, data: data.data, scoreMs: data.scoreMs }
    scheduleSync()
  })

  const observer = new MutationObserver(scheduleSync)
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-replay'] })
  for (const name of ['hashchange', 'popstate']) window.addEventListener(name, scheduleSync)
  window.addEventListener('pageshow', () => {
    scheduleSync()
    window.postMessage({ channel: PLAYBACK_BRIDGE, type: 'snapshot' }, SITE_ORIGIN)
  })
  window.addEventListener('pagehide', () => { online = null; stopExport(); showStatus(''); host?.remove() })
  let lastUrl = location.href
  setInterval(() => { if (lastUrl !== location.href) { lastUrl = location.href; scheduleSync() } }, 800)
  sync()
  window.postMessage({ channel: PLAYBACK_BRIDGE, type: 'snapshot' }, SITE_ORIGIN)
}
