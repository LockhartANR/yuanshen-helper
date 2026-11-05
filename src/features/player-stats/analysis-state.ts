import type { AnalysisGame, PeriodMode, TodayStat } from './analysis'
import type { CustomRange, DateRange, RangeKey } from './analysis-range'
import type { AnalysisSettings } from './analysis-settings'
import type { LsfHistory } from './lsf-history'
import type { DatasetSnapshot, Level } from './model'
import type { LsfAnchors, LsfMetric } from './ratings'

/** 两个时段入口：顶部筛选条与梁山分卡片。 */
export type RangeControlOwner = 'global' | 'lsf'

/** 两个入口共用：已应用的时段 + 正在编辑的草稿状态。 */
export interface RangeControlState {
  uiKey: RangeKey
  panel: RangeControlOwner | null
  draft: CustomRange
  error: string
  now: number
  /** 已应用的是自定义范围时显示「编辑日期」，可直接重新打开面板。 */
  editable?: boolean
}

/** 大表的八个页签。 */
export type AnalysisTab =
  | 'overview'
  | 'lsf'
  | 'rank'
  | 'trend'
  | 'period'
  | 'dist'
  | 'eff'
  | 'map'

export type RankStat = 'time' | 'bvs' | 'stnb'
export type RankLayout = 'single' | 'triple'

/** 流水默认每页条数；展开定位时按这个步长追加。 */
export const LSF_LEDGER_STEP = 100

/** 软件 / NF 筛选；软件值 `'all'` 表示全部。 */
export interface AnalysisFilterState {
  software: string
  nfOnly: boolean
}

/** 已应用的时段，全局筛选与梁山分共用。 */
export interface AnalysisAppliedRange {
  key: RangeKey
  custom: CustomRange
}

/** 正在编辑的自定义日期草稿；关闭时只保留已应用时段中的上次有效日期。 */
export interface AnalysisRangeEditorState {
  owner: RangeControlOwner
  draft: CustomRange
  error: string
}

/** 跨切页保留的展示状态；只存在本次视图会话。 */
export interface AnalysisTabState {
  nav: AnalysisTab
  rankStat: RankStat
  rankLevel: Level
  rankLayout: RankLayout
  trendLevel: Level
  hideEmptyMonths: boolean
  distLevel: Level
  effLevel: Level
  periodMode: PeriodMode
  periodLevel: Level
  periodStat: RankStat
  periodKey: string
  mapLevel: Level
  monthCopyOpen: boolean
  yearCopyOpen: Record<Level, boolean>
  /** 梁山分流水展开集合。 */
  lsfExpanded: ReadonlySet<string>
  lsfLimit: number
  lsfFocus: string
  /** 单日最大涨分定位后高亮该日已显示的流水。 */
  lsfFocusDay: number | null
}

/** 锚点刷新状态；与设置分开，避免提示变化触发统计重建。 */
export interface AnalysisAnchorsState {
  error: boolean
  status: string
  /** 锚点值变化时递增，视图据此回填参数面板。 */
  revision: number
}

/** 控制器发布的只读统计数据；消费者不得修改数组或对象。 */
export interface AnalysisDataSnapshot {
  games: AnalysisGame[]
  rangeGames: AnalysisGame[]
  ratingGames: AnalysisGame[]
  today: TodayStat[]
  history: LsfHistory
}

/** 视图渲染所需的全部状态与派生数据。 */
export interface AnalysisSnapshot {
  dataset: DatasetSnapshot
  tab: AnalysisTabState
  filters: AnalysisFilterState
  range: AnalysisAppliedRange
  rangeEditor: AnalysisRangeEditorState | null
  /** 从已应用时段与草稿派生的两个入口共用控件状态。 */
  rangeControl: RangeControlState
  settings: AnalysisSettings
  /** 设置对象每次更新递增，视图据此同步色板与参数面板。 */
  settingsRevision: number
  anchors: AnalysisAnchorsState
  data: AnalysisDataSnapshot
  /** 已应用时段按当前时钟解析的结果。 */
  bounds: DateRange
  /** 本次数据快照建立时的时钟；今日与梁山分历史使用它，跨午夜不重算历史。 */
  dataNow: number
  /** 生成快照时的时钟；时段控件与梁山分区间使用它。 */
  clock: number
}

/** 设置 patch：只允许明确字段，缺失值由控制器按现有输入规则补默认。 */
export interface AnalysisSettingsPatch {
  rankLimit?: number
  monthTop?: number
  yearTop?: number
  smallTop?: number
  subTiers?: number
  anchors?: Partial<LsfAnchors>
  softWeights?: Partial<Record<Level, Partial<Record<LsfMetric, number>>>>
  levelWeights?: Partial<Record<Level, number>>
  t37Slots?: Partial<Record<Level, number>>
  t37Pads?: Partial<Record<Level, number>>
  bvFloors?: Partial<Record<Level, number>>
  pppConsts?: Partial<Record<Level, number>>
  colorThresholds?: number[]
  dogTargetsE?: string
  dogTargetsI?: string
  monthCopyFields?: unknown
  yearCopyFields?: unknown
  anchorMode?: 'workbook' | 'site'
}

/** 新建大表时的默认展示状态。 */
export function createInitialAnalysisTabState(): AnalysisTabState {
  return {
    nav: 'overview',
    rankStat: 'time',
    rankLevel: 'b',
    rankLayout: 'single',
    trendLevel: 'e',
    hideEmptyMonths: false,
    distLevel: 'b',
    effLevel: 'b',
    periodMode: 'month',
    periodLevel: 'e',
    periodStat: 'time',
    periodKey: '',
    mapLevel: 'e',
    monthCopyOpen: false,
    yearCopyOpen: { b: false, i: false, e: false },
    lsfExpanded: new Set<string>(),
    lsfLimit: LSF_LEDGER_STEP,
    lsfFocus: '',
    lsfFocusDay: null,
  }
}
