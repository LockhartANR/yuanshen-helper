import { calculateStoredRanking } from './calculator'
import type { RankConfig } from './model'

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

let current: { requestId: string; controller: AbortController } | null = null

const scope = self as unknown as {
  postMessage(message: unknown): void
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<WorkerMessage>) => void,
  ): void
}

async function calculate(message: CalculateMessage): Promise<void> {
  const { datasetId, config, requestId } = message
  const controller = new AbortController()
  current = { requestId, controller }
  try {
    const result = await calculateStoredRanking(datasetId, config, controller.signal, (scanned) => {
      scope.postMessage({ type: 'progress', requestId, scanned })
    })
    scope.postMessage({ type: 'done', requestId, result })
  } catch (error) {
    if (controller.signal.aborted) return
    scope.postMessage({
      type: 'error',
      requestId,
      message: error instanceof Error ? error.message : String(error),
    })
  } finally {
    current = null
  }
}

scope.addEventListener('message', (event: MessageEvent<WorkerMessage>) => {
  const message = event.data
  if (message.type === 'cancel') {
    if (current?.requestId === message.requestId) current.controller.abort()
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
