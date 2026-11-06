import type { LsfTabData } from '../../analysis-tab-data'
import {
  lsfChartHtml,
  lsfLedgerHtml,
  lsfNoticeHtml,
  lsfStatsHtml,
} from '../lsf-view'
import { ratingOverviewHtml } from '../rating-view'

/** 梁山分：定阶总览（全时段快照）+ 时段统计 + 阶梯图 + 变动流水。 */
export function renderLsfTab(data: LsfTabData): string {
  const summary =
    ratingOverviewHtml(data.history.snapshot, {
      anchorMode: data.anchorMode,
      anchorError: data.anchorError,
    }) + lsfStatsHtml(data.range, data.bounds, data.controls)
  if (data.history.includedCount === 0) {
    return (
      summary +
      '<div class="card"><div class="card-body"><p class="muted">' +
      `当前各级 3BV 下限是 ${data.floorLabel}；计入有效录像后，这里会显示阶梯图与变动流水。` +
      '</p></div></div>' +
      lsfNoticeHtml(data.history, data.range)
    )
  }
  return (
    summary +
    lsfChartHtml(data.range) +
    lsfNoticeHtml(data.history, data.range) +
    lsfLedgerHtml({
      events: data.events,
      expanded: data.expanded,
      limit: data.limit,
      focus: data.focus,
      highlightDay: data.highlightDay,
    })
  )
}
