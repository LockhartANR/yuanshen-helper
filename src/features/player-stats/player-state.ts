import type { PlayerVideoRow } from '../../shared/db'
import type { CsvSessionState } from './csv-session'
import type { DatasetSnapshot, TopStat, Video } from './model'
import type { PlayerLaunch, PlayerPage } from './launch'
import type {
  ExclusionEntry,
  UnmatchedExclusion,
} from './statistics-exclusion'

export type PlayerSource = 'site' | 'csv'
export type PbStat = TopStat | 'date'

/** PB / 前端成绩的筛选与显示选项；与赛博大表筛选相互独立。 */
export interface PlayerFilters {
  software: string
  nfOnly: boolean
  includeUnapproved: boolean
  pbStat: PbStat
}

/** 统计排除的管理状态；entries 来自未裁剪的原始快照。 */
export interface PlayerExclusionState {
  ready: boolean
  saving: boolean
  error: string
  /** 当前来源的全部原始记录，包括已排除记录。 */
  entries: ExclusionEntry[]
  /** 规则仍在、当前无法确认的记录。 */
  unmatched: UnmatchedExclusion[]
  /** 当前实际匹配并排除的记录数。 */
  excludedCount: number
  unmatchedCount: number
  /** 当前作用域内的规则总数（含未匹配）。 */
  ruleCount: number
  /** 面板展示对应的来源 / 数据身份 / 内容版本；提交时由控制器校验。 */
  snapshotKey: string
  /** 降级模式下当前尚未绑定历史来源的 CSV 文件。 */
  unboundSources: Array<{ sourceId: string; name: string }>
  /** 仍有规则、但当前没有文件绑定的历史 CSV 作用域。 */
  historicalScopes: Array<{ scopeId: string; name: string; ruleCount: number }>
}

export interface ExclusionActionResult {
  ok: boolean
  message: string
}

/** 玩家页面控制器发布的只读快照。 */
export interface PlayerSnapshot {
  launch: PlayerLaunch
  standaloneCsv: boolean
  embedded: boolean
  source: PlayerSource
  page: PlayerPage
  filters: PlayerFilters
  /** 网站接口 / 缓存的原始行，切到 CSV 时保留以供切回复用。 */
  rows: PlayerVideoRow[]
  /** 当前来源排除后的统计候选录像（CSV 为合并快照）。 */
  videos: Video[]
  loading: boolean
  message: string
  updatedAt: number
  fromCache: boolean
  siteName: string
  /** 快照身份与内容版本：只有变化时页面才重建大表。 */
  dataset: DatasetSnapshot
  /** CSV 面板读取的 session 状态；进度与提示变化不增加数据版本。 */
  csv: CsvSessionState
  csvPersistent: boolean
  exclusion: PlayerExclusionState
}

/** 三种启动模式对页面数据源的约束。 */
export function launchMode(launch: PlayerLaunch): {
  standaloneCsv: boolean
  embedded: boolean
  siteUserId: number | null
} {
  return {
    standaloneCsv: launch.kind === 'csv',
    embedded: launch.kind === 'site' && launch.embedded,
    siteUserId: launch.kind === 'site' ? launch.userId : null,
  }
}

export const PB_STAT_LABELS: Record<PbStat, string> = {
  time: '用时',
  bvs: '3BVS',
  stnb: 'STNB',
  date: '日期',
}

export const PB_STATS: PbStat[] = ['time', 'bvs', 'stnb', 'date']
