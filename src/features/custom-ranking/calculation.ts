import { computeRanking } from './calculator'
import { compileConfig } from './config'
import type { RankingResult, RankConfig } from './model'
import { getAllDatasetVideos } from './store'

export interface CalculationOptions {
  signal?: AbortSignal
  onProgress?: (scanned: number) => void
}

interface WorkerDone {
  type: 'done'
  requestId: string
  result: RankingResult
}

interface WorkerError {
  type: 'error'
  requestId: string
  message: string
}

interface WorkerProgress {
  type: 'progress'
  requestId: string
  scanned: number
}

type WorkerReply = WorkerDone | WorkerError | WorkerProgress

function makeRequestId(): string {
  return `calc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 独立 Worker 扫描 IDB；测试与不支持 Worker 的环境退回主线程逐条聚合。
 * 页面调用方必须按请求版本丢弃旧结果。
 */
export async function calculateRanking(
  datasetId: string,
  config: RankConfig,
  options: CalculationOptions = {},
): Promise<RankingResult> {
  const compiled = compileConfig(config)
  if (typeof Worker === 'undefined') {
    if (options.signal?.aborted) throw new Error('计算已取消')
    const rows = await getAllDatasetVideos(datasetId)
    if (options.signal?.aborted) throw new Error('计算已取消')
    options.onProgress?.(rows.length)
    return computeRanking(rows, compiled, datasetId)
  }

  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  const requestId = makeRequestId()
  return new Promise<RankingResult>((resolve, reject) => {
    const cleanup = (): void => {
      options.signal?.removeEventListener('abort', onAbort)
      worker.terminate()
    }
    const onAbort = (): void => {
      worker.postMessage({ type: 'cancel', requestId })
      cleanup()
      reject(new Error('计算已取消'))
    }
    if (options.signal?.aborted) {
      onAbort()
      return
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    worker.addEventListener('message', (event: MessageEvent<WorkerReply>) => {
      const reply = event.data
      if (reply.requestId !== requestId) return
      if (reply.type === 'progress') {
        options.onProgress?.(reply.scanned)
        return
      }
      cleanup()
      if (reply.type === 'done') resolve(reply.result)
      else reject(new Error(reply.message))
    })
    worker.addEventListener('error', (event) => {
      cleanup()
      reject(new Error(event.message || '排行榜计算 Worker 失败'))
    })
    worker.postMessage({ type: 'calculate', requestId, datasetId, config })
  })
}
