export const SITE_ORIGIN = 'https://openms.top'
export const REPO_URL = 'https://github.com/LockhartANR/yuanshen-helper'

/** 开发者主页：GitHub、开源扫雷网、扫雷网各一个 */
export const DEVELOPER_LINKS: ReadonlyArray<{ label: string; url: string }> = [
  { label: 'GitHub', url: 'https://github.com/LockhartANR' },
  { label: '开源扫雷网', url: 'https://openms.top/#/player/16' },
  { label: '扫雷网', url: 'https://saolei.wang/user/31660' },
]

export const DEFAULT_API_BASE = SITE_ORIGIN
export const PLAYER_URL = (id: number): string => `${SITE_ORIGIN}/#/player/${id}`

/** 扩展内玩家页路径（相对扩展根目录）。启动参数约定见 features/player-stats/launch.ts。 */
export const PLAYER_PAGE = 'player.html'
export const CSV_PLAYER_PAGE = `${PLAYER_PAGE}?source=csv`
export const ANALYSIS_PLAYER_PAGE = (id: number): string =>
  `${PLAYER_PAGE}?id=${id}&view=analysis`
export const EMBEDDED_ANALYSIS_PLAYER_PAGE = (id: number): string =>
  `${PLAYER_PAGE}?id=${id}&embed=analysis`
export const SYNC_LOCK_NAME = 'yuanshen-helper:user-sync'
export const IDENTIFIER_CACHE_TTL_MS = 60 * 60 * 1000
export const MAX_RESULTS = 50
export const PAGE_SIZE = 300
