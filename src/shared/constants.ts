export const SITE_ORIGIN = 'https://openms.top'
export const DEFAULT_API_BASE = SITE_ORIGIN
export const PLAYER_URL = (id: number): string => `${SITE_ORIGIN}/#/player/${id}`
export const SYNC_LOCK_NAME = 'yuanshen-helper:user-sync'
export const IDENTIFIER_CACHE_TTL_MS = 60 * 60 * 1000
export const MAX_RESULTS = 50
export const PAGE_SIZE = 300
