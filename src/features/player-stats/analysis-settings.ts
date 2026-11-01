import type { Level } from './model'
import { DEFAULT_COLOR_THRESHOLDS } from './colors'
import type { LsfAnchors, SoftWeights } from './ratings'
import { WORKBOOK_ANCHORS, WORKBOOK_LEVEL_WEIGHTS, WORKBOOK_SOFT_WEIGHTS } from './ratings'

export interface AnalysisSettings {
  /** 当前使用的锚点来源。 */
  anchorMode: 'workbook' | 'site'
  /** 大表锚点（18 项），也允许手动改。 */
  anchors: LsfAnchors
  /** 单难度榜单的 Top N。 */
  rankLimit: number
  /** 月 Top 每期条数。 */
  monthTop: number
  /** 年 Top 每期条数。 */
  yearTop: number
  /** 效率 / 杂项榜每条榜单的条数。 */
  smallTop: number
  /** Sub 率阶梯档数。 */
  subTiers: number
  /** 软实力三项权重。 */
  softWeights: SoftWeights
  /** 综合软实力三级权重。 */
  levelWeights: Record<Level, number>
  /** T37 槽位与补位值。 */
  t37Slots: Record<Level, number>
  t37Pads: Record<Level, number>
  /** 各级别前端成绩 / LSF 的最低 3BV。 */
  bvFloors: Record<Level, number>
  /** 29 档色板阈值。 */
  colorThresholds: number[]
  /** T37 ppp 的归一化常数。 */
  pppConsts: Record<Level, number>
  /** 狗预测目标（逗号分隔）。 */
  dogTargetsE: string
  dogTargetsI: string
}

export const DEFAULT_ANALYSIS_SETTINGS: AnalysisSettings = {
  anchorMode: 'workbook',
  anchors: { ...WORKBOOK_ANCHORS },
  rankLimit: 50,
  monthTop: 8,
  yearTop: 14,
  smallTop: 5,
  subTiers: 14,
  softWeights: {
    b: { ...WORKBOOK_SOFT_WEIGHTS.b },
    i: { ...WORKBOOK_SOFT_WEIGHTS.i },
    e: { ...WORKBOOK_SOFT_WEIGHTS.e },
  },
  levelWeights: { ...WORKBOOK_LEVEL_WEIGHTS },
  t37Slots: { b: 20, i: 12, e: 5 },
  t37Pads: { b: 10, i: 30, e: 99 },
  bvFloors: { b: 10, i: 30, e: 100 },
  colorThresholds: [...DEFAULT_COLOR_THRESHOLDS],
  pppConsts: {
    b: 69.69099147046637,
    i: 5.783604002526971,
    e: 1,
  },
  dogTargetsE: '50,45,40,35',
  dogTargetsI: '13,12,11,10',
}

const STORAGE_KEY = 'analysisSettings'

function defaultSettings(): AnalysisSettings {
  return JSON.parse(JSON.stringify(DEFAULT_ANALYSIS_SETTINGS)) as AnalysisSettings
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

function positive(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function loadAnalysisSettings(): AnalysisSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaultSettings()
    const value = JSON.parse(raw) as Partial<AnalysisSettings>
    const source = (value.anchors ?? {}) as Partial<LsfAnchors>
    const anchors: LsfAnchors = {}
    for (const [key, fallback] of Object.entries(WORKBOOK_ANCHORS)) {
      anchors[key] = positive(source[key], fallback)
    }
    const sw = (value.softWeights ?? {}) as Partial<SoftWeights>
    const lw = (value.levelWeights ?? {}) as Partial<Record<Level, number>>
    const slots = (value.t37Slots ?? {}) as Partial<Record<Level, number>>
    const pads = (value.t37Pads ?? {}) as Partial<Record<Level, number>>
    const floors = (value.bvFloors ?? {}) as Partial<Record<Level, number>>
    const ppp = (value.pppConsts ?? {}) as Partial<Record<Level, number>>
    return {
      anchorMode: value.anchorMode === 'site' ? 'site' : 'workbook',
      anchors,
      rankLimit: clampInt(value.rankLimit, 10, 200, DEFAULT_ANALYSIS_SETTINGS.rankLimit),
      monthTop: clampInt(value.monthTop, 1, 50, DEFAULT_ANALYSIS_SETTINGS.monthTop),
      yearTop: clampInt(value.yearTop, 1, 50, DEFAULT_ANALYSIS_SETTINGS.yearTop),
      smallTop: clampInt(value.smallTop, 1, 20, DEFAULT_ANALYSIS_SETTINGS.smallTop),
      subTiers: clampInt(value.subTiers, 5, 20, DEFAULT_ANALYSIS_SETTINGS.subTiers),
      softWeights: {
        b: {
          t: clampInt(sw.b?.t, 0, 100, WORKBOOK_SOFT_WEIGHTS.b.t),
          b: clampInt(sw.b?.b, 0, 100, WORKBOOK_SOFT_WEIGHTS.b.b),
          s: clampInt(sw.b?.s, 0, 100, WORKBOOK_SOFT_WEIGHTS.b.s),
        },
        i: {
          t: clampInt(sw.i?.t, 0, 100, WORKBOOK_SOFT_WEIGHTS.i.t),
          b: clampInt(sw.i?.b, 0, 100, WORKBOOK_SOFT_WEIGHTS.i.b),
          s: clampInt(sw.i?.s, 0, 100, WORKBOOK_SOFT_WEIGHTS.i.s),
        },
        e: {
          t: clampInt(sw.e?.t, 0, 100, WORKBOOK_SOFT_WEIGHTS.e.t),
          b: clampInt(sw.e?.b, 0, 100, WORKBOOK_SOFT_WEIGHTS.e.b),
          s: clampInt(sw.e?.s, 0, 100, WORKBOOK_SOFT_WEIGHTS.e.s),
        },
      },
      levelWeights: {
        b: clampInt(lw.b, 0, 100, WORKBOOK_LEVEL_WEIGHTS.b),
        i: clampInt(lw.i, 0, 100, WORKBOOK_LEVEL_WEIGHTS.i),
        e: clampInt(lw.e, 0, 100, WORKBOOK_LEVEL_WEIGHTS.e),
      },
      t37Slots: {
        b: clampInt(slots.b, 1, 50, DEFAULT_ANALYSIS_SETTINGS.t37Slots.b),
        i: clampInt(slots.i, 1, 50, DEFAULT_ANALYSIS_SETTINGS.t37Slots.i),
        e: clampInt(slots.e, 1, 50, DEFAULT_ANALYSIS_SETTINGS.t37Slots.e),
      },
      t37Pads: {
        b: clampInt(pads.b, 1, 999, DEFAULT_ANALYSIS_SETTINGS.t37Pads.b),
        i: clampInt(pads.i, 1, 999, DEFAULT_ANALYSIS_SETTINGS.t37Pads.i),
        e: clampInt(pads.e, 1, 999, DEFAULT_ANALYSIS_SETTINGS.t37Pads.e),
      },
      bvFloors: {
        b: clampInt(floors.b, 1, 300, DEFAULT_ANALYSIS_SETTINGS.bvFloors.b),
        i: clampInt(floors.i, 1, 300, DEFAULT_ANALYSIS_SETTINGS.bvFloors.i),
        e: clampInt(floors.e, 1, 300, DEFAULT_ANALYSIS_SETTINGS.bvFloors.e),
      },
      colorThresholds:
        Array.isArray(value.colorThresholds) &&
        value.colorThresholds.length === DEFAULT_COLOR_THRESHOLDS.length &&
        value.colorThresholds.every((item) => typeof item === 'number' && item > 0 && Number.isFinite(item))
          ? [...value.colorThresholds]
          : [...DEFAULT_COLOR_THRESHOLDS],
      pppConsts: {
        b: positive(ppp.b, DEFAULT_ANALYSIS_SETTINGS.pppConsts.b),
        i: positive(ppp.i, DEFAULT_ANALYSIS_SETTINGS.pppConsts.i),
        e: positive(ppp.e, DEFAULT_ANALYSIS_SETTINGS.pppConsts.e),
      },
      dogTargetsE:
        typeof value.dogTargetsE === 'string' && value.dogTargetsE.trim()
          ? value.dogTargetsE
          : DEFAULT_ANALYSIS_SETTINGS.dogTargetsE,
      dogTargetsI:
        typeof value.dogTargetsI === 'string' && value.dogTargetsI.trim()
          ? value.dogTargetsI
          : DEFAULT_ANALYSIS_SETTINGS.dogTargetsI,
    }
  } catch {
    return defaultSettings()
  }
}

export function saveAnalysisSettings(settings: AnalysisSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // 存不下就只在本次页面生效。
  }
}

/** 解析逗号分隔的狗预测目标，只保留正数。 */
export function parseDogTargets(value: string): number[] {
  return value
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 0)
    .map((item) => Math.round(item))
}
