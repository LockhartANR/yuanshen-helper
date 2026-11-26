import { SITE_ORIGIN } from '../shared/constants'
import { WorkerReplayDecoder } from '../features/minigame-export/decoder'
import { isObject } from '../features/minigame-export/model'
import { parsePlaybackSnapshot, PLAYBACK_FRAME } from '../features/minigame-export/playback'
import { playbackFile } from '../features/minigame-export/playback-file'

let started = false
// This web-accessible page only decodes supplied data. It never reads storage or makes site requests.
window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (started || window.parent === window || event.source !== window.parent || event.origin !== SITE_ORIGIN
    || !isObject(event.data) || event.data.type !== PLAYBACK_FRAME || event.ports.length !== 1) return
  started = true
  const port = event.ports[0]
  const decoder = new WorkerReplayDecoder()
  const controller = new AbortController()
  port.onmessage = (message: MessageEvent<unknown>) => {
    if (isObject(message.data) && message.data.type === 'cancel') controller.abort()
  }
  window.addEventListener('pagehide', () => { controller.abort(); decoder.dispose(); port.close() }, { once: true })
  void (async () => {
    try {
      const snapshot = parsePlaybackSnapshot(event.data)
      const replay = await decoder.decode(snapshot.record, controller.signal)
      controller.signal.throwIfAborted()
      port.postMessage({ ok: true, ...playbackFile(snapshot, replay) })
    } catch (error) {
      if (!controller.signal.aborted) port.postMessage({ ok: false, error: error instanceof Error ? error.message : '录像解压失败' })
    } finally {
      decoder.dispose()
      port.close()
    }
  })()
})
