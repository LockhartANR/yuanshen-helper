import { base64ToBytes } from '../features/upload-watch/bytes'
import type { UploadRawResponse } from '../features/upload-watch/types'

async function uploadReplay(name: string, data: string): Promise<UploadRawResponse> {
  const bytes = base64ToBytes(data)
  const form = new FormData()
  form.append('file', new File([bytes], name, { type: 'application/octet-stream' }))

  const response = await fetch('/common/uploadvideo/', {
    method: 'POST',
    body: form,
    credentials: 'same-origin',
  })

  return {
    status: response.status,
    body: await response.text(),
    retryAfter: response.headers.get('retry-after') ?? '',
  }
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const request = message as { type?: string; name?: string; data?: string } | undefined

  if (request?.type === 'YUANSHEN_PING') {
    sendResponse({ ok: true })
    return false
  }
  if (request?.type !== 'YUANSHEN_UPLOAD') return false

  void uploadReplay(request.name ?? 'replay.evf', request.data ?? '').then(
    (result) => sendResponse(result),
    (error: unknown) =>
      sendResponse({
        status: 0,
        body: '',
        retryAfter: '',
        error: error instanceof Error ? error.message : String(error),
      }),
  )
  return true
})
