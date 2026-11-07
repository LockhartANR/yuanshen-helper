import { formatCount, formatShortDate } from '../../../../shared/format'
import type { OverviewTabData } from '../../analysis-tab-data'
import { dateColorStyle, medianOf } from '../../colors'
import { LEVEL_LABELS } from '../../model'
import { ratingOverviewHtml } from '../rating-view'
import {
  colorAttr,
  formatTime,
  videoLink,
} from './common'

const DAY_MS = 86_400_000

/** 概览：定阶总览、今日成绩、三难度摘要、GC、活跃日历与最近 PB。 */
export function renderOverviewTab(data: OverviewTabData): string {
  const { recent, recentCount, lastWeek, activeDays, gamesLast30, summary, today } = data
  const now = data.now

  const todayRows = today
    .map((row) => {
      const bestTime = row.bestTime
        ? `${formatTime(row.bestTime.time)}/${row.bestTime.bv}`
        : '—'
      const bestBvs = row.bestBvs ? `${row.bestBvs.bvs.toFixed(3)}/${row.bestBvs.bv}` : '—'
      const bestStnb = row.bestStnb ? `${row.bestStnb.stnb.toFixed(1)}/${row.bestStnb.bv}` : '—'
      return (
        '<tr>' +
        `<td><span class="lv"><i></i>${LEVEL_LABELS[row.level]}</span></td>` +
        `<td class="num">${row.count}（${row.fl}FL/${row.nf}NF）</td>` +
        `<td class="num"${row.bestTime ? colorAttr(row.level, 'time', row.bestTime.time) : ''}>${bestTime}</td>` +
        `<td class="num"${row.bestBvs ? colorAttr(row.level, 'bvs', row.bestBvs.bvs) : ''}>${bestBvs}</td>` +
        `<td class="num"${row.bestStnb ? colorAttr(row.level, 'stnb', row.bestStnb.stnb) : ''}>${bestStnb}</td>` +
        `<td class="num"${row.count > 0 ? colorAttr(row.level, 'time', row.avgTime) : ''}>${row.count > 0 ? formatTime(row.avgTime) : '—'}</td>` +
        `<td class="num"${row.count > 0 ? colorAttr(row.level, 'bvs', row.avgBvs) : ''}>${row.count > 0 ? row.avgBvs.toFixed(3) : '—'}</td>` +
        `<td class="num"${row.count > 0 ? colorAttr(row.level, 'stnb', row.avgStnb) : ''}>${row.count > 0 ? row.avgStnb.toFixed(1) : '—'}</td>` +
        `<td class="num">${row.count > 0 ? row.avgBv.toFixed(1) : '—'}</td>` +
        `<td class="copy-cell"><button type="button" class="copy-button" data-copy-kind="today" data-copy-level="${row.level}" aria-label="复制今日${LEVEL_LABELS[row.level]}数据" title="复制今日${LEVEL_LABELS[row.level]}数据">复制</button></td>` +
        '</tr>'
      )
    })
    .join('')

  const summaryRows = summary
    .map((row) => {
      const pb = row.pb
      return (
        '<tr>' +
        `<td><span class="lv"><i></i>${LEVEL_LABELS[row.level]}</span></td>` +
        `<td class="num">${formatCount(row.count)}</td>` +
        `<td class="num"${pb ? colorAttr(row.level, 'time', pb.time) : ''}>${pb ? formatTime(pb.time) : '—'}</td>` +
        `<td class="num">${pb ? pb.bv : '—'}</td>` +
        `<td class="num"${pb ? colorAttr(row.level, 'bvs', pb.bvs) : ''}>${pb ? pb.bvs.toFixed(3) : '—'}</td>` +
        `<td class="num"${colorAttr(row.level, 'bvs', row.top5Bvs)}>${row.top5Bvs.toFixed(3)}</td>` +
        `<td class="num">${(row.nfRatio * 100).toFixed(0)}%</td>` +
        `<td class="num">${row.last30}</td>` +
        '</tr>'
      )
    })
    .join('')

  const gc = data.gc
  const gcRows = gc
    .map(
      (item) =>
        '<tr>' +
        `<td>${LEVEL_LABELS[item.level]}</td>` +
        `<td class="num">${item.asb.toFixed(3)}</td>` +
        `<td class="num">${item.power.toFixed(3)}</td>` +
        `<td class="num">${item.typicalTime.toFixed(3)}</td>` +
        '</tr>',
    )
    .join('')
  const gcTotal = gc.reduce(
    (sum, item) => ({
      asb: sum.asb + item.asb,
      power: sum.power + item.power,
      typicalTime: sum.typicalTime + item.typicalTime,
    }),
    { asb: 0, power: 0, typicalTime: 0 },
  )
  const gcTotalRow =
    '<tr class="gc-total">' +
    '<td>合计</td>' +
    `<td class="num">${gcTotal.asb.toFixed(3)}</td>` +
    `<td class="num">${gcTotal.power.toFixed(3)}</td>` +
    `<td class="num">${gcTotal.typicalTime.toFixed(3)}</td>` +
    '</tr>'
  const gcSegmentRows = gc
    .flatMap((item) =>
      item.segments.map(
        (segment) =>
          '<tr>' +
          `<td>${LEVEL_LABELS[item.level]}</td>` +
          `<td class="num">${segment.start}–${segment.end}</td>` +
          `<td class="num">${formatCount(segment.count)}</td>` +
          `<td class="num">${segment.power > 0 ? segment.power.toFixed(4) : '—'}</td>` +
          `<td class="num">${segment.bv > 0 ? segment.bv.toFixed(3) : '—'}</td>` +
          `<td class="num">${segment.time > 0 ? segment.time.toFixed(3) : '—'}</td>` +
          '</tr>',
      ),
    )
    .join('')
  const calendar = data.calendar

  const recentDates = recent.map((item) => item.game.date).sort((a, b) => a - b)
  const recentRows = recent
    .map(({ game, prev }) => {
      const delta = prev - game.time
      const hot = now - game.date <= 7 * DAY_MS
      const dateStyle = recentDates.length > 1
        ? dateColorStyle(game.date, recentDates[0]!, medianOf(recentDates), recentDates[recentDates.length - 1]!)
        : null
      return (
        `<tr${hot ? ' class="hot"' : ''}>` +
        `<td class="date recent-pb-date"${dateStyle ? ` style="--recent-date:${dateStyle.backgroundColor}"` : ''}>${formatShortDate(game.date)}</td>` +
        `<td>${LEVEL_LABELS[game.level]}</td>` +
        `<td class="num">${game.bv}</td>` +
        `<td class="num"${colorAttr(game.level, 'time', game.time)}>${formatTime(game.time)}</td>` +
        `<td class="num"${colorAttr(game.level, 'bvs', game.bvs)}>${game.bvs.toFixed(3)}</td>` +
        `<td class="num"${colorAttr(game.level, 'stnb', game.stnb)}>${game.stnb.toFixed(1)}</td>` +
        `<td class="num">${formatTime(prev)}</td>` +
        `<td class="num delta-up">−${delta.toFixed(3)}</td>` +
        `<td>${videoLink(game, '录像')}</td>` +
        '</tr>'
      )
    })
    .join('')

  return (
    ratingOverviewHtml(data.rating, {
      anchorMode: data.anchorMode,
      anchorError: data.anchorError,
    }) +
    '<div class="kpi-grid kpi-grid-3">' +
    '<div class="kpi"><span>近 30 天新 PB</span>' +
    `<b>${recentCount}</b>` +
    `<small>${recent[0] ? `最近一条 ${formatShortDate(recent[0].game.date)}` : '最近没有新 PB'}</small></div>` +
    '<div class="kpi"><span>本周 T37</span>' +
    `<b>${lastWeek && lastWeek.count > 0 ? lastWeek.t37.toFixed(1) : '—'}</b>` +
    `<small>${lastWeek && lastWeek.count > 0 ? `B37 ${lastWeek.b37.toFixed(1)} · S37 ${lastWeek.s37.toFixed(1)}` : '本周还没有成绩'}</small></div>` +
    '<div class="kpi"><span>近 30 天活跃</span>' +
    `<b>${activeDays} 天</b>` +
    `<small>${gamesLast30} 局</small></div>` +
    '</div>' +

    '<div class="card">' +
    '<div class="card-head"><h2 class="card-title">今日成绩</h2></div>' +
    (today.some((row) => row.count > 0) ?
    '<div class="table-scroll"><table class="data-table summary-table today-table">' +
    '<thead><tr><th>难度</th><th class="num">总局数</th><th class="num">Best Time</th><th class="num">Best 3BVS</th><th class="num">Best STNB</th><th class="num">Avg Time</th><th class="num">Avg 3BVS</th><th class="num">Avg STNB</th><th class="num">Avg 3BV</th><th class="copy-cell"></th></tr></thead>' +
    `<tbody>${todayRows}</tbody>` +
    '</table></div>' : '<p class="today-empty">今日暂无成绩</p>') +
    '</div>' +

    '<div class="card">' +
    '<div class="card-head"><h2 class="card-title">三难度摘要</h2><span class="muted">3BV ≥ ' + data.floorLabel + '</span></div>' +
    '<table class="data-table summary-table">' +
    '<thead><tr><th>难度</th><th class="num">局数</th><th class="num">PB</th><th class="num">3BV</th><th class="num">PB 3BVS</th><th class="num">Top5 均速</th><th class="num">NF 占比</th><th class="num">近 30 天</th></tr></thead>' +
    `<tbody>${summaryRows}</tbody>` +
    '</table>' +
    '</div>' +

    '<div class="card">' +
    '<div class="card-head"><h2 class="card-title">GC 指标</h2><span class="muted">ASB / 战力 / 典型时</span></div>' +
    '<table class="data-table gc-table">' +
    '<thead><tr><th>难度</th><th class="num">ASB 和</th><th class="num">战力</th><th class="num">典型时</th></tr></thead>' +
    `<tbody>${gcRows}${gcTotalRow}</tbody>` +
    '</table>' +
    '<details class="settings-advanced gc-bins"><summary>GC 分段明细</summary>' +
    '<div class="table-scroll"><table class="data-table">' +
    '<thead><tr><th>难度</th><th class="num">分段</th><th class="num">局数</th><th class="num">分段战力</th><th class="num">分段典型3BV</th><th class="num">分段典型时</th></tr></thead>' +
    `<tbody>${gcSegmentRows || '<tr><td colspan="6" class="muted">没有数据</td></tr>'}</tbody>` +
    '</table></div></details>' +
    '</div>' +

    '<div class="card">' +
    '<div class="card-head"><h2 class="card-title">活跃日历</h2><span class="muted">最近 12 周 · 深色表示局数多</span></div>' +
    '<div class="calendar-layout">' +
    '<div class="calendar-side">' +
    '<div class="calendar-body">' +
    '<div class="calendar-weekdays">' +
    ['一', '二', '三', '四', '五', '六', '日'].map((day) => `<span>${day}</span>`).join('') +
    '</div>' +
    `<div class="calendar">${calendar.cells
      .map((cell) => {
        const alpha =
          cell.count === 0 ? 0 : 15 + Math.round((cell.count / Math.max(1, calendar.max)) * 85)
        const style =
          cell.count === 0
            ? ''
            : ` style="background:color-mix(in srgb, var(--accent) ${alpha}%, transparent)"`
        return `<button type="button" class="cal-cell"${style} data-exclusion-day="${cell.start}" title="${formatShortDate(cell.start)} · ${cell.count} 局 · 查看录像" aria-label="${formatShortDate(cell.start)}，${cell.count} 局，查看录像"></button>`
      })
      .join('')}</div>` +
    '</div>' +
    '<div class="cal-legend"><span>少</span>' +
    [15, 40, 65, 90]
      .map(
        (alpha) =>
          `<i class="cal-cell" style="background:color-mix(in srgb, var(--accent) ${alpha}%, transparent)"></i>`,
      )
      .join('') +
    '<span>多</span></div>' +
    '</div>' +
    '<div class="calendar-stats">' +
    `<div class="cal-stat"><span>总对局</span><b>${formatCount(calendar.total)}</b></div>` +
    `<div class="cal-stat"><span>活跃天数</span><b>${calendar.activeDays}</b></div>` +
    `<div class="cal-stat"><span>活跃日均</span><b>${calendar.activeDays > 0 ? (calendar.total / calendar.activeDays).toFixed(1) : '—'}</b></div>` +
    `<div class="cal-stat"><span>最长连续</span><b>${calendar.longestStreak} 天</b></div>` +
    `<div class="cal-stat"><span>最活跃日</span><b class="best-day">${calendar.best ? `<span>${formatShortDate(calendar.best.start)}</span><span>${calendar.best.count} 局</span>` : '—'}</b></div>` +
    '</div>' +
    '</div>' +
    '</div>' +

    '<div class="card">' +
    `<div class="card-head"><h2 class="card-title">最近 PB</h2><span class="muted">30 天内 · 共 ${recentCount} 条，显示最近 ${recent.length} 条</span></div>` +
    '<table class="data-table">' +
    '<thead><tr><th>日期</th><th>难度</th><th class="num">3BV</th><th class="num">用时</th><th class="num">3BVS</th><th class="num">STNB</th><th class="num">原纪录</th><th class="num">提升</th><th>录像</th></tr></thead>' +
    `<tbody>${recentRows || '<tr><td colspan="9" class="muted">最近 30 天没有新 PB</td></tr>'}</tbody>` +
    '</table>' +
    '</div>'
  )
}
