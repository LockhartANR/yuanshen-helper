import SevenZip from '7z-wasm'
import type { SevenZipModule } from '7z-wasm'
import wasmUrl from '7z-wasm/7zz.wasm?url'
import { isObject, parseHistoryRecord, safeInteger } from './model'
import { unpackReplayArchive, validateReplay } from './archive'

let codec: Promise<SevenZipModule> | undefined

async function getCodec(): Promise<SevenZipModule> {
  codec ??= (async () => {
    const response = await fetch(wasmUrl)
    if (!response.ok) throw new Error('无法加载扩展内置的录像解压器')
    return SevenZip({ wasmBinary: await response.arrayBuffer(), print: () => undefined, printErr: () => undefined })
  })().catch((error: unknown) => { codec = undefined; throw error })
  return codec
}

globalThis.addEventListener('message', (event: MessageEvent<unknown>) => {
  const message = event.data
  if (!isObject(message) || !safeInteger(message.requestId, 1)) return
  const requestId = message.requestId
  void (async () => {
    try {
      const record = parseHistoryRecord(message.record)
      const data = record.payload.encoding === 'json'
        ? record.payload.data
        : unpackReplayArchive(record.payload.data, await getCodec())
      const replay = validateReplay(record.metadata.game, data)
      globalThis.postMessage({ requestId, ok: true, replay })
    } catch (error) {
      globalThis.postMessage({ requestId, ok: false, error: error instanceof Error ? error.message : '录像解压失败' })
    }
  })()
})
