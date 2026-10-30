import type { Level, TopStat } from './model'

interface ColorScheme {
  thresholds: number[]
  colors: string[]
}

/**
 * 通用色阶：从「没有颜色」到「最好」。
 * 来自配色表，门槛升序，颜色数量 = 门槛数量 + 1。
 */
const PALETTE = [
  'rgba(255,255,255,0)',
  '#808080',
  '#595959',
  '#AE78D6',
  '#7030A0',
  '#FF5B5B',
  '#FFA7A7',
  '#FF0000',
  '#BC0000',
  '#92D050',
  '#B2DE82',
  '#00B050',
  '#009242',
  '#00B0F0',
  '#81DEFF',
  '#0070C0',
  '#005696',
  '#FFC000',
  '#FFE07D',
  '#E7831D',
  '#A65C12',
  '#FF57B7',
  '#FF97D2',
  '#D6007B',
  '#A2005D',
  '#14D2A0',
  '#7DF3D4',
  '#0F9D78',
  '#0B7B5E',
  '#CCFF66',
]

/** 用时色阶和上面正好相反：最快的是绿色。 */
const TIME_PALETTE = [...PALETTE].reverse()

const B_TIME_THRESHOLDS = [
  -4, -3.5, -3, -2.5, -2, -1.5, -1, -0.5, 0, 0.5,
  1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5,
  6, 6.5, 7, 7.5, 8, 9, 10, 11, 11.98,
]

const I_TIME_THRESHOLDS = [
  -2, -1, 0, 1, 2, 3, 4, 5, 6, 7,
  8, 9, 10, 11, 12, 13, 14, 15, 16, 17,
  18, 19, 20, 21, 22, 24, 26, 28, 29.96,
]

const E_TIME_THRESHOLDS = [
  10, 12.5, 15, 17.5, 20, 22.5, 25, 27.5, 30, 32.5,
  35, 37.5, 40, 42.5, 45, 47.5, 50, 52.5, 55, 57.5,
  60, 62.5, 65, 67.5, 70, 75, 80, 85, 89.9,
]

const BVS_THRESHOLDS = [
  0.01, 0.5, 1, 1.5, 2, 2.25, 2.5, 2.75, 3, 3.25,
  3.5, 3.75, 4, 4.25, 4.5, 4.75, 5, 5.25, 5.5, 5.75,
  6, 6.25, 6.5, 6.75, 7, 7.25, 7.5, 7.75, 8,
]

const STNB_THRESHOLDS = [
  0.25, 12.5, 25, 37.5, 50, 56.25, 62.5, 68.75, 75, 81.25,
  87.5, 93.75, 100, 106.25, 112.5, 118.75, 125, 131.25, 137.5, 143.75,
  150, 156.25, 162.5, 168.75, 175, 181.25, 187.5, 193.75, 200,
]

const TIME_SCHEMES: Record<Level, ColorScheme> = {
  b: { thresholds: B_TIME_THRESHOLDS, colors: TIME_PALETTE },
  i: { thresholds: I_TIME_THRESHOLDS, colors: TIME_PALETTE },
  e: { thresholds: E_TIME_THRESHOLDS, colors: TIME_PALETTE },
}

const BVS_SCHEME: ColorScheme = { thresholds: BVS_THRESHOLDS, colors: PALETTE }
const STNB_SCHEME: ColorScheme = { thresholds: STNB_THRESHOLDS, colors: PALETTE }

/** 门槛升序：返回 value 落在的区间下标（0 到 thresholds.length）。 */
function bucketIndex(scheme: ColorScheme, value: number): number {
  let low = 0
  let high = scheme.thresholds.length
  while (low < high) {
    const mid = (low + high) >> 1
    if ((scheme.thresholds[mid] as number) < value) low = mid + 1
    else high = mid
  }
  return Math.min(low, scheme.colors.length - 1)
}

function parseColor(color: string): { r: number; g: number; b: number; a: number } | null {
  const hex = /^#([0-9a-f]{6})$/i.exec(color)
  if (hex) {
    const value = Number.parseInt(hex[1] as string, 16)
    return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff, a: 1 }
  }
  const rgba = /^rgba?\(([^)]+)\)$/i.exec(color)
  if (rgba) {
    const parts = (rgba[1] as string).split(',').map((part) => Number(part.trim()))
    const [r, g, b, a = 1] = parts
    if ([r, g, b].every((part) => Number.isFinite(part))) {
      return { r: r as number, g: g as number, b: b as number, a }
    }
  }
  return null
}

/** 和站点一致：按感知亮度选黑字或白字。 */
function textColorFor(color: string): string {
  const parsed = parseColor(color)
  if (!parsed) return '#000000'
  const brightness = (parsed.r * 299 + parsed.g * 587 + parsed.b * 114) / 1000
  return brightness < 128 ? '#ffffff' : '#000000'
}

/**
 * PB 格子的配色。返回 null 表示这个区间是透明的，保持默认样式。
 * 用时的数值单位是秒，3BVS / STNB 用原值。
 */
export function pbColorStyle(
  level: Level,
  stat: TopStat,
  value: number,
): { backgroundColor: string; color: string } | null {
  const scheme =
    stat === 'time' ? TIME_SCHEMES[level] : stat === 'bvs' ? BVS_SCHEME : STNB_SCHEME
  const color = scheme.colors[bucketIndex(scheme, value)]
  if (!color) return null

  const parsed = parseColor(color)
  if (!parsed || parsed.a === 0) return null
  return { backgroundColor: color, color: textColorFor(color) }
}
