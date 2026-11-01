export function formatCount(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value)
}

export function formatDateTime(timestamp: number): string {
  if (!timestamp) return '从未'
  const date = new Date(timestamp)
  const pad = (n: number) => String(n).padStart(2, '0')
  const year = String(date.getFullYear() % 100).padStart(2, '0')
  return `${year}/${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  if (!timestamp) return '从未'
  const diff = Math.max(0, now - timestamp)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour

  if (diff < minute) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`
  return formatDateTime(timestamp)
}

/** 统一短日期：YY/M/D（本地时区）。缺失或无效返回 —。 */
export function formatShortDate(value: string | number | null): string {
  if (value === null || value === '' || value === 0) return '—'
  const timestamp = typeof value === 'number' ? value : Date.parse(value)
  if (!Number.isFinite(timestamp)) return '—'
  const date = new Date(timestamp)
  const year = String(date.getFullYear() % 100).padStart(2, '0')
  return `${year}/${date.getMonth() + 1}/${date.getDate()}`
}
