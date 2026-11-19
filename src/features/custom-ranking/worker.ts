import { getDb } from '../../shared/db'
import { createRankingResult, RankingAccumulator } from './calculator'
import { compileConfig } from './config'
import type { GlobalRankVideoRow, RankConfig } from './model'

interface CalculateMessage {
  type: 'calculate'
  requestId: string
  datasetId: string
  config: RankConfig
}

interface CancelMessage {
  type: 'cancel'
  requestId: string
}

type WorkerMessage = CalculateMessage | CancelMessage

let cancelled = new Set<string>()
let current: string | null = null

const scope = self as unknown as {
  postMessage(message: unknown): void
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<WorkerMessage>) => void,
  ): void
}

async function calculate(message: CalculateMessage): Promise<void> {
  current = message.requestId
  const startedAt = Date.now()
  try {
    const compiled = compileConfig(message.config)
    const db = await getDb()
    const range = IDBKeyRange.bound(
      [message.datasetId, 1],
      [message.datasetId, Number.MAX_SAFE_INTEGER],
    )
    const accumulator = new RankingAccumulator(compiled)
    let scanned = 0
    let lastReport = 0
    let cursor = await db
      .transaction('globalRankVideos')
      .store.index('by-dataset-player')
      .openCursor(range)
    while (cursor) {
      if (cancelled.has(message.requestId)) return
      accumulator.add(cursor.value as GlobalRankVideoRow)
      scanned += 1
      if (scanned - lastReport >= 5_000) {
        lastReport = scanned
        scope.postMessage({
          type: 'progress',
          requestId: message.requestId,
          scanned,
        })
      }
      cursor = await cursor.continue()
    }
    if (cancelled.has(message.requestId)) return
    const result = createRankingResult(accumulator.build(), compiled, message.datasetId, startedAt)
    scope.postMessage({ type: 'done', requestId: message.requestId, result })
  } catch (error) {
    scope.postMessage({
      type: 'error',
      requestId: message.requestId,
      message: error instanceof Error ? error.message : String(error),
    })
  } finally {
    if (current === message.requestId) current = null
    cancelled.delete(message.requestId)
  }
}

scope.addEventListener('message', (event: MessageEvent<WorkerMessage>) => {
  const message = event.data
  if (message.type === 'cancel') {
    cancelled.add(message.requestId)
    return
  }
  if (message.type === 'calculate') {
    if (current !== null) {
      scope.postMessage({
        type: 'error',
        requestId: message.requestId,
        message: '计算进程正在忙',
      })
      return
    }
    void calculate(message)
  }
})
