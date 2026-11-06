import { SITE_ORIGIN } from '../../../../shared/constants'
import type { AnalysisGame } from '../../analysis'
import { dateColorStyle, medianOf, numColorStyle, pbColorStyle } from '../../colors'
import type { Level, TopStat, Video } from '../../model'

export const STAT_LABELS: Record<TopStat, string> = { time: '用时', bvs: '3BVS', stnb: 'STNB' }

export function formatTime(seconds: number): string {
  return seconds.toFixed(3)
}

export function linkToVideo(video: Video, text: string, className = ''): string {
  if (video.id <= 0) return `<span class="${className}">${text}</span>`
  const href = `${SITE_ORIGIN}/#/video/${video.id}`
  return `<a class="${className}" href="${href}" target="_blank" rel="noreferrer">${text}</a>`
}

export function videoLink(game: AnalysisGame, text: string, className = ''): string {
  return linkToVideo(game.video, text, className)
}

export function rowClass(index: number): string {
  if (index === 0) return ' class="top1"'
  if (index < 3) return ' class="top3"'
  return ''
}

export function colorAttr(level: Level, stat: 'time' | 'bvs' | 'stnb', value: number): string {
  const style = pbColorStyle(level, stat, value)
  return style
    ? ` style="background:${style.backgroundColor};color:${style.color}"`
    : ''
}

export function numColorAttr(value: number, factor = 1): string {
  const style = numColorStyle(value, factor)
  return style
    ? ` style="background:${style.backgroundColor};color:${style.color}"`
    : ''
}
const dateStatsCache = new WeakMap<number[], { min: number; mid: number; max: number }>()

export function dateAttr(value: number, dates: number[]): string {
  let stats = dateStatsCache.get(dates)
  if (!stats) {
    const sorted = dates.filter((item) => item > 0).sort((a, b) => a - b)
    stats =
      sorted.length < 2
        ? { min: 0, mid: 0, max: 0 }
        : {
            min: sorted[0] as number,
            mid: medianOf(sorted),
            max: sorted[sorted.length - 1] as number,
          }
    dateStatsCache.set(dates, stats)
  }
  if (stats.max <= stats.min) return ''
  const style = dateColorStyle(value, stats.min, stats.mid, stats.max)
  return style
    ? ` style="background:${style.backgroundColor};color:${style.color}"`
    : ''
}
