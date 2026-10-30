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
export const SYNC_LOCK_NAME = 'yuanshen-helper:user-sync'
export const IDENTIFIER_CACHE_TTL_MS = 60 * 60 * 1000
export const MAX_RESULTS = 50
export const PAGE_SIZE = 300
