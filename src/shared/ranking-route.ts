export const RANKING_OPEN_MESSAGE = 'YUANSHEN_OPEN_RANKING'

/**
 * 只识别 hash 路由 `#/ranking`、`#/ranking/` 及其子路径。
 * 忽略 hash 中的查询参数；`#/ranking-other` 不是匹配项。
 */
export function isRankingHash(hash: string): boolean {
  const path = hash.split('?')[0] ?? ''
  return path === '#/ranking' || path === '#/ranking/' || path.startsWith('#/ranking/')
}

/** 顶层 openms.top 页面上的排行榜路由；iframe 和别的源站不匹配。 */
export function isRankingUrl(href: string): boolean {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.hostname !== 'openms.top') return false
  return isRankingHash(url.hash)
}

/** 后台只接受扩展自身、顶层排行榜页面内容脚本发来的打开请求。 */
export function isRankingOpenSender(
  sender: { id?: string; frameId?: number; tab?: { url?: string } },
  extensionId: string,
): boolean {
  if (sender.id !== extensionId) return false
  if (sender.frameId !== 0) return false
  const tabUrl = sender.tab?.url
  return typeof tabUrl === 'string' && isRankingUrl(tabUrl)
}
