import type { PlayerVideoRow } from '../../shared/db'
import type { CsvSessionState } from './csv-session'
import type { DatasetSnapshot, TopStat, Video } from './model'
import type { PlayerLaunch, PlayerPage } from './launch'

export type PlayerSource = 'site' | 'csv'
export type PbStat = TopStat | 'date'

/** PB / 前端成绩的筛选与显示选项；与赛博大表筛选相互独立。 */
export interface PlayerFilters {
  software: string
  nfOnly: boolean
  includeUnapproved: boolean
  pbStat: PbStat
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
  /** 当前来源可展示的录像（CSV 为合并快照）。 */
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
