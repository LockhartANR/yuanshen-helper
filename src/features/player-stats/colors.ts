import type { Level, TopStat } from './model'

/**
 * 原表 `Set!AE2:AE30` 的色板（k=2..30）。
 * 阈值从 9 递减到 0.01，VBA 的 bt/it/et/bvs/stnb/numcolor 都按这个序列取色。
 */
const PALETTE = [
  '#FF6666',
  '#6699FF',
  '#FFFF66',
  '#00CC99',
  '#00FF99',
  '#FF9999',
  '#FF6699',
  '#FFCCFF',
  '#FF99FF',
  '#FFFF66',
  '#FF9900',
  '#FFCC99',
  '#FFCC00',
  '#0099CC',
  '#0099FF',
  '#66FFFF',
  '#33CCFF',
  '#00FF99',
  '#00CC00',
  '#CCFFCC',
  '#99CC33',
  '#CC9900',
  '#CC6666',
  '#CCCC00',
  '#996666',
  '#CCCCFF',
  '#FFCCFF',
  '#CC99FF',
  '#CCCCCC',
]

export const DEFAULT_COLOR_THRESHOLDS = [
  9, 8.5, 8, 7.5, 7, 6.75, 6.5, 6.25, 6, 5.75,
  5.5, 5.25, 5, 4.75, 4.5, 4.25, 4, 3.75, 3.5, 3.25,
  3, 2.75, 2.5, 2.25, 2, 1.5, 1, 0.5, 0.01,
]

let activeValues = [...DEFAULT_COLOR_THRESHOLDS]

/** 用参数面板里的 29 档阈值覆盖默认色板阈值。 */
export function configureColors(values: number[]): void {
  if (values.length !== DEFAULT_COLOR_THRESHOLDS.length) return
  if (values.some((value) => !Number.isFinite(value) || value <= 0)) return
  activeValues = [...values]
}

/** VBA：bt = 12 - 2x，it = 30 - 4x，et = 90 - 10x。 */
const TIME_BASE: Record<Level, number> = { b: 12, i: 30, e: 90 }
const TIME_SCALE: Record<Level, number> = { b: 2, i: 4, e: 10 }

/** 和站点一致：按感知亮度选黑字或白字。 */
function textColorFor(color: string): string {
  const match = /^#([0-9a-f]{6})$/i.exec(color)
  if (!match) return '#000000'
  const value = Number.parseInt(match[1] as string, 16)
  const brightness =
    (((value >> 16) & 0xff) * 299 + ((value >> 8) & 0xff) * 587 + (value & 0xff) * 114) / 1000
  return brightness < 128 ? '#ffffff' : '#000000'
}

function styleAt(index: number): { backgroundColor: string; color: string } | null {
  const color = PALETTE[index]
  if (!color) return null
  return { backgroundColor: color, color: textColorFor(color) }
}

/**
 * PB / 榜单格子的配色。
 * 返回 null 表示超出色板范围（用时太慢，或 3BVS/STNB 低于最低档），保持默认样式。
 */
export function pbColorStyle(
  level: Level,
  stat: TopStat,
  value: number,
): { backgroundColor: string; color: string } | null {
  if (stat === 'time') {
    // VBA 从 k=9 开始，阈值 = base - scale * x，取第一个「用时 < 阈值」的档。
    for (let k = 9; k <= 30; k += 1) {
      const threshold = TIME_BASE[level] - TIME_SCALE[level] * (activeValues[k - 2] as number)
      if (value < threshold) return styleAt(k - 2)
    }
    return null
  }

  const factor = stat === 'stnb' ? 25 : 1
  for (let k = 2; k <= 30; k += 1) {
    if (value >= (activeValues[k - 2] as number) * factor) return styleAt(k - 2)
  }
  return null
}

/** 原表 numcolor：阈值 × 系数，从高到低取第一个命中的档。 */
export function numColorStyle(
  value: number,
  factor = 1,
): { backgroundColor: string; color: string } | null {
  for (let k = 2; k <= 30; k += 1) {
    if (value >= (activeValues[k - 2] as number) * factor) return styleAt(k - 2)
  }
  return null
}

const DATE_LOW = '#F8696B'
const DATE_MID = '#FCFCFF'
const DATE_HIGH = '#5A8AC6'

/** 已排序日期数组的中位数；偶数取中间两值的平均。 */
export function medianOf(sorted: number[]): number {
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle] as number
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
}

function mixColor(from: string, to: string, ratio: number): string {
  const parse = (hex: string): [number, number, number] => {
    const value = Number.parseInt(hex.slice(1), 16)
    return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
  }
  const [r1, g1, b1] = parse(from)
  const [r2, g2, b2] = parse(to)
  const channel = (a: number, b: number): string =>
    Math.round(a + (b - a) * ratio)
      .toString(16)
      .padStart(2, '0')
  return `#${channel(r1, r2)}${channel(g1, g2)}${channel(b1, b2)}`.toUpperCase()
}

/** 原表日期列的色阶：最早红、50% 白、最新蓝。 */
export function dateColorStyle(
  value: number,
  min: number,
  mid: number,
  max: number,
): { backgroundColor: string; color: string } | null {
  if (value <= 0 || max <= min) return null
  const color =
    value <= mid
      ? mixColor(DATE_LOW, DATE_MID, (value - min) / Math.max(1, mid - min))
      : mixColor(DATE_MID, DATE_HIGH, (value - mid) / Math.max(1, max - mid))
  return { backgroundColor: color, color: textColorFor(color) }
}
