import { isObject, jsonObject, type HistoryRecord, type JsonObject } from './model'

export interface ReplayDecoder {
  decode(record: HistoryRecord, signal?: AbortSignal): Promise<JsonObject>
  dispose(): void
}

/** A worker keeps decoding off the UI thread and can be terminated immediately on cancel. */
export class WorkerReplayDecoder implements ReplayDecoder {
  private worker: Worker | undefined
  private requestId = 0

  async decode(record: HistoryRecord, signal?: AbortSignal): Promise<JsonObject> {
    signal?.throwIfAborted()
    const worker = this.worker ??= new Worker(new URL('./archive-worker.ts', import.meta.url), { type: 'module' })
    const requestId = ++this.requestId
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, replay?: JsonObject): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        worker.removeEventListener('message', receive)
        worker.removeEventListener('error', failed)
        worker.removeEventListener('messageerror', failed)
        if (error) reject(error)
        else if (replay) resolve(replay)
      }
      const abort = (): void => { this.dispose(); finish(new DOMException('已取消', 'AbortError')) }
      const failed = (): void => { this.dispose(); finish(new Error('录像解压器启动或运行失败，请重新加载扩展后重试')) }
      const receive = (event: MessageEvent<unknown>): void => {
        const data = event.data
        if (!isObject(data) || data.requestId !== requestId) return
        try {
          if (data.ok !== true) throw new Error(typeof data.error === 'string' ? data.error : '录像解压失败')
          finish(undefined, jsonObject(data.replay))
        } catch (error) { finish(error instanceof Error ? error : new Error('解压响应无效')) }
      }
      const timer = setTimeout(() => { this.dispose(); finish(new Error('这条录像解压超时，已停止解压器')) }, 30_000)
      signal?.addEventListener('abort', abort, { once: true })
      worker.addEventListener('message', receive)
      worker.addEventListener('error', failed)
      worker.addEventListener('messageerror', failed)
      try { worker.postMessage({ requestId, record }) }
      catch { this.dispose(); finish(new Error('录像过大或无法传给解压器')) }
    })
  }

  dispose(): void { this.worker?.terminate(); this.worker = undefined }
}
