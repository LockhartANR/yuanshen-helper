import { isObject, MAX_REPLAY_BYTES } from './model'
import { PLAYBACK_FRAME, type PlaybackSnapshot } from './playback'

/** A short-lived extension frame owns the WASM worker; the website page owns the download. */
export function decodePlayback(snapshot: PlaybackSnapshot, url: string, signal: AbortSignal): Promise<{ blob: Blob; filename: string }> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe')
    frame.id = 'ysh-minigame-decoder'
    frame.hidden = true
    frame.title = '录像解压'
    frame.src = chrome.runtime.getURL('minigame-frame.html')
    const extensionOrigin = chrome.runtime.getURL('').replace(/\/+$/, '')
    const channel = new MessageChannel()
    let settled = false
    const finish = (error?: Error, file?: { blob: Blob; filename: string }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      channel.port1.postMessage({ type: 'cancel' })
      channel.port1.close()
      channel.port2.close()
      frame.remove()
      if (error) reject(error)
      else if (file) resolve(file)
    }
    const abort = (): void => finish(new DOMException('已取消', 'AbortError'))
    let timer = setTimeout(() => finish(new Error('录像解压器未能启动，请重新加载扩展并刷新站点后重试')), 10_000)
    signal.addEventListener('abort', abort, { once: true })
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data
      if (!isObject(data) || typeof data.ok !== 'boolean') { finish(new Error('录像解压响应无效')); return }
      if (!data.ok) {
        finish(new Error(typeof data.error === 'string' ? data.error.slice(0, 240) : '录像解压失败'))
      } else if (!(data.blob instanceof Blob) || data.blob.size === 0 || data.blob.size > MAX_REPLAY_BYTES + 64 * 1024
        || typeof data.filename !== 'string' || !/^[a-z0-9.-]{1,240}\.json$/.test(data.filename)) {
        finish(new Error('录像文件响应无效'))
      } else finish(undefined, { blob: data.blob, filename: data.filename })
    }
    channel.port1.onmessageerror = () => finish(new Error('无法接收录像文件，请重试'))
    frame.addEventListener('load', () => {
      if (settled) return
      clearTimeout(timer)
      timer = setTimeout(() => finish(new Error('录像解压超时，请重试')), 40_000)
      try {
        if (!frame.contentWindow) throw new Error('无法启动录像解压器')
        frame.contentWindow.postMessage({ type: PLAYBACK_FRAME, url, record: snapshot.record }, extensionOrigin, [channel.port2])
      } catch { finish(new Error('无法启动录像解压器，请重新加载扩展并刷新站点后重试')) }
    }, { once: true })
    frame.addEventListener('error', () => finish(new Error('录像解压器加载失败，请重试')), { once: true })
    document.body.append(frame)
  })
}
