import { modeIdentity, type HistoryMetadata } from './model'

export interface HistoryFilter { game: string; mode: string; from: string; to: string }

function localDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('请选择有效的日期')
  const date = new Date(`${value}T00:00:00`)
  const canonical = `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  if (!Number.isFinite(date.getTime()) || canonical !== value) throw new Error('请选择有效的日期')
  return date
}

export function filterHistory(entries: readonly HistoryMetadata[], filter: HistoryFilter): HistoryMetadata[] {
  const from = filter.from ? localDate(filter.from).getTime() : undefined
  const end = filter.to ? localDate(filter.to) : undefined
  end?.setHours(24, 0, 0, 0)
  const to = end?.getTime()
  if (from !== undefined && to !== undefined && from >= to) throw new Error('开始日期不能晚于结束日期')
  return entries.filter((entry) => (!filter.game || entry.game === filter.game)
    && (!filter.mode || modeIdentity(entry) === filter.mode)
    && (from === undefined || entry.playedAt >= from) && (to === undefined || entry.playedAt < to))
}
