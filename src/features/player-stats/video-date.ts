import type { Video } from './model'

export interface EffectiveVideoDate {
  /** 有效结束时间（毫秒）；无效或非正数时退回上传时间，两者均不可用时为 0。 */
  date: number
  dateFromUpload: boolean
  undated: boolean
}

function parseTime(value: string | null | undefined): number {
  const parsed = Date.parse(value ?? '')
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

/** 分析记录、时段筛选与历史重建共用的日期及来源口径。 */
export function effectiveVideoDate(video: Video): EffectiveVideoDate {
  const end = parseTime(video.end_time)
  if (end > 0) return { date: end, dateFromUpload: false, undated: false }
  const upload = parseTime(video.upload_time)
  if (upload > 0) return { date: upload, dateFromUpload: true, undated: false }
  return { date: 0, dateFromUpload: false, undated: true }
}
