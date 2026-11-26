import { HISTORY_MESSAGE, isObject, parseHistoryRequest } from '../features/minigame-export/model'
import { listSiteHistory, readSiteHistory } from '../features/minigame-export/site-history'

export function isHistoryReader(sender: chrome.runtime.MessageSender, extensionId: string): boolean {
  if (sender.id !== extensionId || !sender.url) return false
  try {
    const url = new URL(sender.url)
    return url.protocol === 'chrome-extension:' && url.hostname === extensionId && url.pathname === '/minigame.html'
  } catch { return false }
}

export function registerMinigameHistory(): void {
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (!isObject(message) || message.type !== HISTORY_MESSAGE) return false
    if (!isHistoryReader(sender, chrome.runtime.id)) {
      sendResponse({ ok: false, error: '小游戏历史仅向扩展的录像导出页开放' })
      return false
    }
    try {
      const request = parseHistoryRequest(message)
      const reading = request.action === 'list'
        ? listSiteHistory(request.afterId, request.upperId, request.databaseVersion)
        : readSiteHistory(request.expected, request.databaseVersion)
      void reading.then(
        (data) => sendResponse({ ok: true, data }),
        (error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : '读取小游戏历史失败' }),
      )
      return true
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : '读取参数无效' })
      return false
    }
  })
}
