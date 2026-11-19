export const RANK_SCHEMA_VERSION = 1
/** v1 为多指标优先级配置；v2 起改为单一默认排序指标。 */
export const RANK_CONFIG_VERSION = 2
export const RANK_CONFIG_LEGACY_VERSION = 1
export const RANK_LANGUAGE_VERSION = 1
export const RANK_STRATEGY_VERSION = 2
export const RANK_CONFIG_FORMAT = 'yuanshen-ranking-config'

export type RankScanMode = 'initial' | 'sync' | 'expand'
export type RankPhase =
  | 'initial'
  | 'sync'
  | 'profiles'
  | 'supplement'
  | 'publish'
  // 旧逐玩家策略的历史阶段，仅用于展示旧任务，不参与新版续传。
  | 'discovery'
  | 'indexing'
  | 'details'

export type RankLevel = 'b' | 'i' | 'e'
export type RankDirection = 'asc' | 'desc'
export type RankState = 'c' | 'a' | 'b' | 'd' | 'e'
export type RankNfMode = 'all' | 'only' | 'exclude'

export interface RankMetric {
  id: string
  name: string
  formula: string
  direction: RankDirection
  digits: number
}

export interface RankFilter {
  levels: RankLevel[]
  states: RankState[]
  modes: string[]
  software: string
  nf: RankNfMode
  from: string
  to: string
  floors: Record<RankLevel, number>
  minGames: number
}

export interface RankConfig {
  id: string
  name: string
  configVersion: number
  languageVersion: number
  fieldSchemaVersion: number
  metrics: RankMetric[]
  /** 默认排序指标，引用稳定 metricId；无指标时为 null。 */
  defaultSortMetricId: string | null
  filter: RankFilter
  updatedAt: number
}

export type GlobalRankFieldValue = number | string | boolean | null

/** 规范化字段由字段注册表统一生成；原始响应同时保留，便于 Schema 升级。 */
export interface GlobalRankDetail {
  raw: Record<string, unknown>
  fields: Record<string, GlobalRankFieldValue>
}

export interface GlobalRankVideoRow {
  datasetId: string
  videoId: number
  playerId: number
  state: string
  uploadTime: string
  detail: GlobalRankDetail | null
  detailState: 'pending' | 'complete' | 'missing'
  discoveredAt: number
  updatedAt: number
}

export interface GlobalRankDataset {
  id: string
  baseUrl: string
  schemaVersion: number
  strategyVersion: number
  scanMode: RankScanMode | 'legacy'
  startId: number
  endId: number
  endExclusive: number
  generation: number
  status: 'collecting' | 'partial' | 'ready' | 'failed'
  stage: string
  startedAt: number
  updatedAt: number
  finishedAt: number | null
  baseDatasetId: string | null
  playerCount: number
  videoCount: number
  detailCount: number
  missingDetailCount: number
  errorCount: number
  intervalDone: number
  intervalTotal: number
  detailReusedCount: number
  responseAnomalies: number
  complete: boolean
  warnings: string[]
}

export interface GlobalRankTaskError {
  at: number
  phase: string
  scope: string
  message: string
}

export interface GlobalRankTask {
  id: string
  datasetId: string
  baseUrl: string
  schemaVersion: number
  strategyVersion: number
  scanMode: RankScanMode | 'legacy'
  startId: number
  endId: number
  endExclusive: number
  baseDatasetId: string | null
  generation: number
  status: 'running' | 'paused' | 'completed' | 'failed'
  phase: RankPhase
  startedAt: number
  updatedAt: number
  finishedAt: number | null
  runToken: string
  intervalCursor: number
  intervalDone: number
  intervalTotal: number
  responseAnomalies: number
  detailReusedCount: number
  playerCount: number
  playerChunkCount: number
  profileChunksDone: number
  targetCount: number
  detailCount: number
  missingDetailCount: number
  errors: GlobalRankTaskError[]
  warnings: string[]
}

export interface GlobalRankTaskChunk {
  taskId: string
  kind: 'players'
  chunkId: string
  items: number[]
}

export interface GlobalRankMeta {
  key: string
  startId: number
  endId: number
  strategyVersion: number
  readyDatasetId: string | null
  latestDatasetId: string | null
  configId: string | null
  readyAt: number
  updatedAt: number
  revision: number
}

/** 聚合阶段输出，与列顺序无关；值向量按 metricIds 对应。 */
export interface RankPlayerValues {
  playerId: number
  games: number
  values: Array<number | null>
  samples: number[]
}

export interface RankingResultRow {
  /** 当前排序指标为空时显示“—”，不参与并列名次。 */
  rank: number | null
  playerId: number
  games: number
  values: Array<number | null>
  samples: number[]
  valid: boolean[]
}

export interface RankingResult {
  /** 聚合阶段的有效玩家值，尚未按当前排序指标重排。 */
  players: RankPlayerValues[]
  metricIds: string[]
  /** 当前排序视图与玩家 ID → 实际数组位置，供分页和定位使用。 */
  rows: RankingResultRow[]
  rowIndexById: Record<number, number>
  sortMetricId: string | null
  direction: RankDirection
  datasetId: string
  configKey: string
  computedAt: number
  elapsedMs: number
  playerCount: number
  videoCount: number
  filteredGames: number
}

export const RANK_LEVELS: readonly RankLevel[] = ['b', 'i', 'e']
export const RANK_LEVEL_LABELS: Record<RankLevel, string> = {
  b: '初级',
  i: '中级',
  e: '高级',
}
export const RANK_STATE_LABELS: Record<string, string> = {
  c: '已审核',
  a: '未审核',
  b: '冻结',
  d: '标识不符',
  e: '外部审核',
}
export const RANK_SOFTWARE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'all', label: '全部软件' },
  { value: 'e', label: 'evf' },
  { value: 'a', label: 'avf' },
  { value: 'm', label: 'mvf' },
  { value: 'r', label: 'rmv' },
]

export const DEFAULT_RANK_FILTER: RankFilter = {
  levels: [...RANK_LEVELS],
  states: ['c'],
  modes: ['00'],
  software: 'all',
  nf: 'all',
  from: '',
  to: '',
  floors: { b: 0, i: 0, e: 0 },
  minGames: 1,
}

/** 默认指标只用于新建配置；用户可全部删除后重新添加。 */
export const DEFAULT_RANK_METRICS: RankMetric[] = [
  {
    id: 'speed',
    name: '最高 3BVS',
    formula: 'max(bv / time)',
    direction: 'desc',
    digits: 3,
  },
  {
    id: 'ioe',
    name: '平均 IOE',
    formula: 'avg(bv / cl)',
    direction: 'desc',
    digits: 3,
  },
  {
    id: 'games',
    name: '局数',
    formula: 'count()',
    direction: 'desc',
    digits: 0,
  },
]

export const DEFAULT_RANK_CONFIG: RankConfig = {
  id: 'default',
  name: '默认全站排行',
  configVersion: RANK_CONFIG_VERSION,
  languageVersion: RANK_LANGUAGE_VERSION,
  fieldSchemaVersion: RANK_SCHEMA_VERSION,
  metrics: DEFAULT_RANK_METRICS,
  defaultSortMetricId: DEFAULT_RANK_METRICS[0]!.id,
  filter: DEFAULT_RANK_FILTER,
  updatedAt: 0,
}

/** 排行榜每页选项；偏好保存在本机设置中，不写入配置导出文件。 */
export const RANK_PAGE_SIZES: readonly number[] = [20, 50, 100, 200]
export const DEFAULT_RANK_PAGE_SIZE = 20

export const DEFAULT_RANK_META = (key: string): GlobalRankMeta => ({
  key,
  startId: 1,
  endId: 0,
  strategyVersion: RANK_STRATEGY_VERSION,
  readyDatasetId: null,
  latestDatasetId: null,
  configId: null,
  readyAt: 0,
  updatedAt: 0,
  revision: 0,
})
