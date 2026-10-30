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

async function sessionInfo(): Promise<{ loggedIn: boolean | null; username: string }> {
  try {
    const response = await fetch('/api/common/loginauto', {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return { loggedIn: null, username: '' }
    const data = (await response.json()) as { user?: { username?: string } | null }
    const user = data?.user ?? null
    return { loggedIn: Boolean(user), username: user?.username ?? '' }
  } catch {
    // 网络问题不等于未登录，交给调用方自行决定
    return { loggedIn: null, username: '' }
  }
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const request = message as { type?: string; name?: string; data?: string } | undefined

  if (request?.type === 'YUANSHEN_PING') {
    sendResponse({ ok: true })
    return false
  }
  if (request?.type === 'YUANSHEN_SESSION') {
    void sessionInfo().then(sendResponse, () => sendResponse({ loggedIn: null, username: '' }))
    return true
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
