/** Runs at document_start in MAIN world. Observe only the native replay response; never fetch it again. */
import { SITE_ORIGIN } from '../shared/constants'
import { isObject, MAX_ARCHIVE_BYTES, safeInteger } from '../features/minigame-export/model'
import { onlineRequestTarget, playbackTarget, PLAYBACK_BRIDGE, targetIdentity } from '../features/minigame-export/playback'

type OnlineTarget = NonNullable<ReturnType<typeof onlineRequestTarget>>
interface Capture {
  sequence: number
  url: string
  target: OnlineTarget
  loading: boolean
  data?: ArrayBuffer
  scoreMs?: number
  error?: string
}

let sequence = 0
let routeIdentity = targetIdentity(playbackTarget(location.href))
let capture: Capture | undefined

function publish(): void {
  window.postMessage({ channel: PLAYBACK_BRIDGE, type: 'state',
    ...(capture ?? { url: location.href, error: '未取得本页加载的录像，请刷新页面后重试' }) }, SITE_ORIGIN)
}

function syncRoute(): void {
  const identity = targetIdentity(playbackTarget(location.href))
  if (identity === routeIdentity) return
  routeIdentity = identity
  sequence++
  capture = undefined
  publish()
}

function begin(target: OnlineTarget | null): Capture | undefined {
  syncRoute()
  if (!target || targetIdentity(target) !== routeIdentity) return undefined
  capture = { sequence: ++sequence, target, url: location.href, loading: true }
  publish()
  return capture
}

function finish(request: Capture, data?: ArrayBuffer, scoreMs?: number, error?: string): void {
  syncRoute()
  if (request.sequence !== sequence || targetIdentity(request.target) !== routeIdentity) return
  capture = { ...request, loading: false, data, scoreMs, error }
  publish()
}

function accept(request: Capture, data: ArrayBuffer, score: string | null): void {
  const scoreMs = Number(score)
  if (!safeInteger(scoreMs, 1)) { finish(request, undefined, undefined, '网站未返回有效的录像成绩'); return }
  if (!data.byteLength || data.byteLength > MAX_ARCHIVE_BYTES) {
    finish(request, undefined, undefined, '录像为空或超过 16 MiB，未留存导出副本')
    return
  }
  finish(request, data, scoreMs)
}

// Vue Router may update the hash through history APIs without a hashchange event.
for (const method of ['pushState', 'replaceState'] as const) {
  const original = history[method]
  history[method] = function (...args: Parameters<History[typeof method]>): void {
    original.apply(this, args)
    syncRoute()
  }
}
window.addEventListener('hashchange', syncRoute)
window.addEventListener('popstate', syncRoute)
window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.source !== window || event.origin !== SITE_ORIGIN || !isObject(event.data)
    || event.data.channel !== PLAYBACK_BRIDGE || event.data.type !== 'snapshot') return
  syncRoute()
  publish()
})

const requests = new WeakMap<XMLHttpRequest, OnlineTarget | null>()
const originalOpen = XMLHttpRequest.prototype.open
XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL,
  async: boolean = true, username?: string | null, password?: string | null): void {
  originalOpen.call(this, method, url, async, username, password)
  requests.set(this, onlineRequestTarget(String(url), method))
}
const originalSend = XMLHttpRequest.prototype.send
XMLHttpRequest.prototype.send = function (body?): void {
  const request = begin(requests.get(this) ?? null)
  if (request) {
    this.addEventListener('loadend', () => {
      if (this.status < 200 || this.status >= 300
        || targetIdentity(onlineRequestTarget(this.responseURL, 'GET')) !== targetIdentity(request.target)) {
        finish(request, undefined, undefined, '网站录像加载失败，请刷新页面后重试')
        return
      }
      if (this.responseType === 'arraybuffer' && this.response instanceof ArrayBuffer) {
        // Keep a copy: the website is free to transfer or mutate its own buffer afterwards.
        if (this.response.byteLength > MAX_ARCHIVE_BYTES) {
          finish(request, undefined, undefined, '录像超过 16 MiB，未留存导出副本')
        } else accept(request, this.response.slice(0), this.getResponseHeader('X-Minigame-Score'))
      } else {
        finish(request, undefined, undefined, '网站录像响应格式不受支持，请刷新页面后重试')
      }
    }, { once: true })
  }
  try { originalSend.call(this, body) }
  catch (error) {
    if (request) finish(request, undefined, undefined, '网站录像请求未能发出')
    throw error
  }
}

async function copyResponse(response: Response): Promise<ArrayBuffer> {
  if (Number(response.headers.get('Content-Length')) > MAX_ARCHIVE_BYTES) throw new Error('录像超过 16 MiB')
  const reader = response.body?.getReader()
  if (!reader) throw new Error('网站返回了空录像')
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let total = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      total += part.value.byteLength
      if (total > MAX_ARCHIVE_BYTES) throw new Error('录像超过 16 MiB')
      chunks.push(Uint8Array.from(part.value))
    }
    return await new Blob(chunks).arrayBuffer()
  } finally { void reader.cancel().catch(() => undefined) }
}

const originalFetch = window.fetch
window.fetch = function (input, init): Promise<Response> {
  const url = input instanceof Request ? input.url : String(input)
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
  const request = begin(onlineRequestTarget(url, method))
  const response = originalFetch.call(this, input, init)
  if (request) {
    void response.then(async (result) => {
      if (!result.ok || targetIdentity(onlineRequestTarget(result.url, 'GET')) !== targetIdentity(request.target)) {
        throw new Error('网站录像加载失败，请刷新页面后重试')
      }
      accept(request, await copyResponse(result.clone()), result.headers.get('X-Minigame-Score'))
    }).catch((error: unknown) => finish(request, undefined, undefined,
      error instanceof Error ? error.message : '无法留存当前录像，请刷新页面后重试'))
  }
  return response
}
