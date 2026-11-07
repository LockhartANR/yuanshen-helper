import { SITE_ORIGIN } from '../../../shared/constants'
import { formatShortDate } from '../../../shared/format'
import { escapeHtml } from '../../../shared/ui'
import { addLocalDays, rangeHint, startOfLocalDay } from '../analysis-range'
import type { DateRange } from '../analysis-range'
import {
  formatLsf,
  formatLsfDelta,
  levelContributionTotal,
  lsfBoardLabel,
} from '../lsf-history'
import type { LsfEvent, LsfHistory, LsfPoint, LsfRange } from '../lsf-history'
import { LEVEL_LABELS } from '../model'
import type { Video } from '../model'
import type { LsfMetric } from '../ratings'
import { rangePanelHtml, rangeSelectHtml } from './range-control'
import type { RangeControlState } from '../analysis-state'

/** 阶梯图上最多标出多少个可交互台阶点；超出时按等距抽样，台阶线仍保留全部变化。 */
const LSF_CHART_DOTS = 1200

function deltaClass(value: number): string {
  if (value > 0) return 'delta-up'
  if (value < 0) return 'delta-down'
  return ''
}

function formatBoardValue(metric: LsfMetric, value: number): string {
  if (metric === 't') return `${value.toFixed(3)}s`
  if (metric === 'b') return value.toFixed(3)
  return value.toFixed(1)
}

function linkToVideo(video: Video, text: string, className = ''): string {
  if (video.id <= 0) return `<span class="${className}">${text}</span>`
  const href = `${SITE_ORIGIN}/#/video/${video.id}`
  return `<a class="${className}" href="${href}" target="_blank" rel="noreferrer">${text}</a>`
}

/** 网站记录打开录像页；CSV 只显示可识别的本地记录信息，不生成网站录像链接。 */
function recordLabel(video: Video): string {
  if (video.importOrder !== undefined) {
    return `<span class="lsf-local">本地记录 #${video.importOrder + 1}</span>`
  }
  return linkToVideo(video, '录像')
}

/** 「截至」用包含当天的结束日期；「全部」没有结束日期，直接显示实际终点。 */
function untilLabel(bounds: DateRange, end: number): string {
  return bounds.endExclusive === null
    ? formatShortDate(end)
    : formatShortDate(addLocalDays(bounds.endExclusive, -1))
}

/** 可点击的大数值；没有目标时退回静态「—」，不产生跳转。 */
function statValueHtml(
  target: { attr: string; value: string } | null,
  text: string | null,
  label: string,
): string {
  if (target === null || text === null) return '<b class="">—</b>'
  return (
    `<button type="button" class="lsf-stat-value delta-up" ${target.attr}="${target.value}"` +
    ` aria-label="${label}" title="${label}">${text}</button>`
  )
}

/** 事件极多时只保留等距抽样点 + 最新一点，避免一次渲染上万 SVG 节点。 */
function chartMarkers(points: LsfPoint[]): { markers: LsfPoint[]; sampled: boolean } {
  const all = points.filter((point) => point.eventId !== null)
  if (all.length <= LSF_CHART_DOTS) return { markers: all, sampled: false }
  const step = Math.ceil(all.length / LSF_CHART_DOTS)
  const markers: LsfPoint[] = []
  for (let index = 0; index < all.length; index += step) markers.push(all[index] as LsfPoint)
  const last = all[all.length - 1] as LsfPoint
  if (markers[markers.length - 1] !== last) markers.push(last)
  return { markers, sampled: true }
}

/** 时段统计：起点 / 终点与涨分计数都只描述所选时段，时段切换就在这张卡上。 */
export function lsfStatsHtml(
  range: LsfRange,
  bounds: DateRange,
  controls: RangeControlState,
): string {
  const hint = rangeHint(bounds)
  const maxGainText = range.maxGain === null ? null : formatLsfDelta(range.maxGain)
  const maxGainNote =
    range.maxGain === null
      ? '该时段没有涨分'
      : `${formatShortDate(range.maxGainDate as number)} · 点击定位这条流水`
  const maxDayText = range.maxDayGain === null ? null : formatLsfDelta(range.maxDayGain)
  const maxDayNote =
    range.maxDayGain === null
      ? '该时段没有正向日增量'
      : `${formatShortDate(range.maxDayDate as number)} · 当天净增量，点击定位`
  const panel =
    controls.panel === 'lsf'
      ? `<div class="range-panel-row">${rangePanelHtml('lsf', controls.draft, controls.error, controls.now)}</div>`
      : ''
  return (
    '<div class="card lsf-stats">' +
    '<div class="card-head"><h2 class="card-title">时段统计</h2>' +
    '<div class="lsf-range"><span class="filter-label">时段</span>' +
    `${rangeSelectHtml('lsf', controls.uiKey, controls.editable === true)}</div></div>` +
    panel +
    '<div class="lsf-stat-grid">' +
    '<div class="lsf-stat"><span>时段涨分</span>' +
    `<b class="${deltaClass(range.change)}">${formatLsfDelta(range.change)}</b>` +
    '<small>区间末 LSF − 区间起点 LSF</small>' +
    `<small>${hint}</small></div>` +
    '<div class="lsf-stat"><span>涨分次数</span>' +
    `<b>${range.upCount}</b>` +
    `<small>${range.downCount > 0 ? `另有 ${range.downCount} 次扣分` : '只统计正向变化事件'}</small>` +
    '<small>同一录像只算一次</small></div>' +
    '<div class="lsf-stat"><span>单局最大涨分</span>' +
    statValueHtml(
      range.maxGainEventId === null
        ? null
        : { attr: 'data-lsf-event', value: range.maxGainEventId },
      maxGainText,
      '定位到单局最大涨分对应的流水',
    ) +
    `<small>${maxGainNote}</small></div>` +
    '<div class="lsf-stat"><span>单日最大涨分</span>' +
    statValueHtml(
      range.maxDayDate === null ? null : { attr: 'data-lsf-day', value: String(range.maxDayDate) },
      maxDayText,
      '定位到单日最大涨分当天最新一条流水',
    ) +
    `<small>${maxDayNote}</small></div>` +
    '<div class="lsf-stat"><span>时段末 LSF</span>' +
    `<b>${formatLsf(range.latest)}</b>` +
    `<small>起点 ${formatLsf(range.baseline)} · 截至 ${untilLabel(bounds, range.end)}</small></div>` +
    '</div>' +
    '</div>'
  )
}

function tickLabel(value: number, span: number): string {
  if (span >= 200) return value.toFixed(0)
  if (span >= 20) return value.toFixed(1)
  return value.toFixed(2)
}

/** 历史阶梯图：离散录像带来的变化用台阶表示，不用平滑曲线。 */
export function lsfChartHtml(range: LsfRange): string {
  const points = range.points
  const W = 760
  const H = 240
  const padL = 56
  const padR = 18
  const padT = 16
  const padB = 30
  const first = points[0] as { date: number; lsf: number }
  const start = first.date
  const end = range.end
  // 零跨度只兜底比例计算，终点与刻度仍保留实际查询时间。
  const timeSpan = Math.max(1, end - start)
  // 历史点可能上万，不能把数组展开成 Math.min / Math.max 的参数（会触发参数上限报错）。
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const point of points) {
    if (point.lsf < min) min = point.lsf
    if (point.lsf > max) max = point.lsf
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 0
    max = 0
  }
  const rawMin = min
  if (max - min < 1e-9) {
    const pad = Math.max(1, Math.abs(max) * 0.05)
    min -= pad
    max += pad
  } else {
    const pad = (max - min) * 0.08
    min -= pad
    max += pad
  }
  // LSF 不会是负数时不要把 0 基线压到轴外，避免出现负刻度。
  if (min < 0 && rawMin >= 0) min = 0
  const x = (value: number): number => padL + ((value - start) / timeSpan) * (W - padL - padR)
  const y = (value: number): number =>
    padT + (1 - (value - min) / (max - min)) * (H - padT - padB)

  let path = `M ${x(first.date).toFixed(1)} ${y(first.lsf).toFixed(1)}`
  let previous = first
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index] as { date: number; lsf: number }
    path +=
      ` L ${x(point.date).toFixed(1)} ${y(previous.lsf).toFixed(1)}` +
      ` L ${x(point.date).toFixed(1)} ${y(point.lsf).toFixed(1)}`
    previous = point
  }
  path += ` L ${x(end).toFixed(1)} ${y(previous.lsf).toFixed(1)}`

  const span = max - min
  let grid = ''
  for (let index = 0; index <= 4; index += 1) {
    const value = max - (index / 4) * span
    const lineY = y(value)
    grid +=
      `<line class="lsf-grid-line" x1="${padL}" y1="${lineY.toFixed(1)}" x2="${W - padR}" y2="${lineY.toFixed(1)}"/>` +
      `<text class="lsf-axis" x="${padL - 8}" y="${(lineY + 3).toFixed(1)}" text-anchor="end">${tickLabel(value, span)}</text>`
  }
  const xTicks: Array<[number, string]> = [
    [start, 'start'],
    [start + (end - start) / 2, 'middle'],
    [end, 'end'],
  ]
  for (const [value, anchor] of xTicks) {
    grid +=
      `<text class="lsf-axis" x="${x(value).toFixed(1)}" y="${H - 8}" text-anchor="${anchor}">${formatShortDate(value)}</text>`
  }

  const events = new Map(range.events.map((event) => [event.id, event]))
  const { markers, sampled } = chartMarkers(points)
  const dots = markers
    .map((point) => {
      const event = events.get(point.eventId as string)
      if (!event) return ''
      const mode = event.game.nf ? 'NF' : 'FL'
      const label =
        `${formatShortDate(event.date)} ${LEVEL_LABELS[event.game.level]} ${mode} · ` +
        `${formatLsf(event.lsfBefore)} → ${formatLsf(event.lsfAfter)}（${formatLsfDelta(event.delta)}）` +
        ` · ${event.sources.join('、')}`
      const text = escapeHtml(label)
      return (
        `<circle class="lsf-point" cx="${x(point.date).toFixed(1)}" cy="${y(point.lsf).toFixed(1)}" r="2.8"` +
        ` tabindex="0" role="button" data-lsf-event="${event.id}" aria-label="${text}">` +
        `<title>${text}</title></circle>`
      )
    })
    .join('')

  return (
    '<div class="card">' +
    '<div class="card-head"><h2 class="card-title">历史阶梯图</h2>' +
    '<span class="muted">横轴日期 · 纵轴累计 LSF · 台阶表示离散变化</span></div>' +
    '<div class="lsf-chart-wrap">' +
    `<svg class="lsf-chart" viewBox="0 0 ${W} ${H}" role="group" aria-label="梁山分历史阶梯图">` +
    grid +
    `<path class="lsf-line" d="${path}"/>` +
    dots +
    '</svg>' +
    '</div>' +
    '<p class="lsf-tip">按当前锚点和参数重建；日期采用录像结束时间，缺失时采用上传时间。' +
    '悬停或聚焦台阶点可看分数与来源，点击定位到下方流水。' +
    (sampled ? `本时段事件较多，图上只标出 ${markers.length} 个抽样点；台阶线与下方流水仍是完整记录。` : '') +
    '</p>' +
    '</div>'
  )
}

export function lsfDetailBody(event: LsfEvent): string {
  const change = event.change
  const total = levelContributionTotal(change)
  const boardRows = change.boards
    .map((board) => {
      const replaced =
        board.replacedValue === null
          ? '补入空位'
          : `${formatBoardValue(board.metric, board.replacedValue)} ${board.replacedVideo ? recordLabel(board.replacedVideo) : ''}`
      return (
        '<tr>' +
        `<td>${lsfBoardLabel(board.mode, board.metric)}</td>` +
        `<td class="num">${formatBoardValue(board.metric, board.value)} · 第 ${board.rank} 位</td>` +
        `<td class="num">${replaced}</td>` +
        `<td class="num">${formatBoardValue(board.metric, board.avgBefore)} → ${formatBoardValue(board.metric, board.avgAfter)}</td>` +
        `<td class="num">${formatLsf(board.contributionBefore)} → ${formatLsf(board.contributionAfter)}（${formatLsfDelta(board.contributionDelta)}）</td>` +
        '</tr>'
      )
    })
    .join('')
  // 该级此前按 0 计，补位折算的贡献不属于任何一榜的差值，单独列一行加回。
  const baselineRow =
    change.baselineContribution > 0
      ? '<tr class="lsf-baseline-row">' +
        '<td>初始化基线</td>' +
        '<td class="num">该级此前按 0 计</td>' +
        '<td class="num">—</td>' +
        '<td class="num">—</td>' +
        `<td class="num">0.00 → ${formatLsf(change.baselineContribution)}（${formatLsfDelta(change.baselineContribution)}）</td>` +
        '</tr>'
      : ''
  const totalRow =
    change.boards.length > 0 || change.baselineContribution > 0
      ? '<tr class="lsf-detail-total">' +
        '<td>合计</td>' +
        '<td class="num">—</td>' +
        '<td class="num">—</td>' +
        '<td class="num" title="各榜贡献差值之和，应等于该级 LSF 变化">—</td>' +
        `<td class="num">${formatLsfDelta(total)}</td>` +
        '</tr>'
      : ''
  const hasRows = change.boards.length > 0 || baselineRow !== ''
  const levelBlock = (
    '<div class="lsf-detail-block">' +
    `<p class="lsf-detail-line"><b>${LEVEL_LABELS[change.level]}</b> · 软实力 ${change.softBefore.toFixed(1)} → ${change.softAfter.toFixed(1)}` +
    ` · NF软实力 ${change.nfSoftBefore.toFixed(1)} → ${change.nfSoftAfter.toFixed(1)}` +
    ` · 该级 LSF ${formatLsf(change.lsfBefore)} → ${formatLsf(change.lsfAfter)}</p>` +
    (hasRows
      ? '<div class="table-scroll"><table class="data-table lsf-detail-table">' +
        '<thead><tr><th>榜</th><th class="num">新成绩</th><th class="num">被替换</th>' +
        '<th class="num">Top5 均值</th><th class="num">LSF 贡献</th></tr></thead>' +
        `<tbody>${boardRows}${baselineRow}${totalRow}</tbody></table></div>`
      : '<p class="muted">本次没有改写任何 Top5 榜。</p>') +
    (change.baselineContribution > 0
      ? `<p class="lsf-detail-note">该级此前没有录像，按 0 计：空榜补位（用时补 999.999 秒，3BVS / STNB 补 0）折算出的 ` +
        `${formatLsf(change.baselineContribution)} 计入「初始化基线」，各榜明细加总才等于本次涨分。</p>`
      : '') +
    (change.nfPadded
      ? `<p class="lsf-detail-note">该级此时还没有 NF 录像：NF 项按补位值参与，NF补位折算 ` +
        `${formatLsf(change.nfBaselineContribution)} 已并入初始化基线，不是 NF 录像带来的。</p>`
      : '') +
    '</div>'
  )

  return (
    '<div class="lsf-detail-body">' +
    `<p class="lsf-detail-line">综合 LSF ${formatLsf(event.lsfBefore)} → ${formatLsf(event.lsfAfter)}（${formatLsfDelta(event.delta)}）` +
    ` · 本条录像 ${recordLabel(event.game.video)}</p>` +
    levelBlock +
    '</div>'
  )
}

/** 明细行：收起时只留空占位，展开时才填充内容，避免几千行流水一起预渲染。 */
export function lsfDetailHtml(event: LsfEvent, open: boolean): string {
  const body = open ? lsfDetailBody(event) : ''
  return (
    `<tr class="lsf-detail${open ? '' : ' hidden'}" id="lsf-detail-${event.id}" data-lsf-detail="${event.id}" data-filled="${open ? '1' : '0'}">` +
    `<td colspan="8">${body}</td></tr>`
  )
}

/** 变动流水：一条录像一条事件，默认时间倒序；展开明细按事件 ID 查。 */
export function lsfLedgerHtml(options: {
  events: LsfEvent[]
  expanded: ReadonlySet<string>
  limit: number
  focus: string
  /** 单日定位：高亮当前已显示的该日流水。 */
  highlightDay?: number | null
}): string {
  const shown = options.events.slice(0, options.limit)
  const highlightDay = options.highlightDay ?? null
  const rows = shown
    .map((event) => {
      const open = options.expanded.has(event.id)
      const dayHit =
        highlightDay !== null && !event.undated && startOfLocalDay(event.date) === highlightDay
      const time = event.undated
        ? '<span class="lsf-tag">未定日期</span>'
        : formatShortDate(event.date) +
          (event.dateFromUpload ? '<span class="lsf-tag">上传时间</span>' : '')
      return (
        `<tr class="lsf-row${open ? ' open' : ''}${options.focus === event.id ? ' focus' : ''}${dayHit ? ' day-focus' : ''}" data-lsf-event-row="${event.id}">` +
        `<td class="date">${time}</td>` +
        `<td>${LEVEL_LABELS[event.game.level]} · ${event.game.nf ? 'NF' : 'FL'}</td>` +
        `<td class="num">${event.game.time.toFixed(3)}s · ${event.game.bv}</td>` +
        `<td class="num">${formatLsf(event.lsfBefore)} → ${formatLsf(event.lsfAfter)}</td>` +
        `<td class="num ${deltaClass(event.delta)}">${formatLsfDelta(event.delta)}</td>` +
        `<td>${event.sources.join('、') || '—'}</td>` +
        `<td><button type="button" class="lsf-toggle" data-lsf-toggle="${event.id}" aria-expanded="${open}" aria-controls="lsf-detail-${event.id}">${open ? '收起' : '展开'}</button></td>` +
        `<td>${recordLabel(event.game.video)}</td>` +
        '</tr>' +
        lsfDetailHtml(event, open)
      )
    })
    .join('')
  const remaining = options.events.length - shown.length

  return (
    '<div class="card">' +
    '<div class="card-head"><h2 class="card-title">变动流水</h2>' +
    `<span class="muted">时间倒序 · 共 ${options.events.length} 条` +
    `${remaining > 0 ? ` · 已显示 ${shown.length} 条` : ''}</span></div>` +
    '<div class="table-scroll"><table class="data-table lsf-ledger">' +
    '<thead><tr><th>时间</th><th>级别 / 方式</th><th class="num">成绩</th><th class="num">LSF</th>' +
    '<th class="num">变动</th><th>来源</th><th>明细</th><th>录像</th></tr></thead>' +
    `<tbody>${rows || '<tr><td colspan="8" class="muted">所选时段没有 LSF 变动</td></tr>'}</tbody>` +
    '</table></div>' +
    (remaining > 0
      ? `<div class="lsf-more"><button type="button" class="button" data-lsf-more>显示更多（还有 ${remaining} 条）</button></div>`
      : '') +
    '</div>'
  )
}

export function lsfNoticeHtml(history: LsfHistory, range: LsfRange): string {
  const items: string[] = []
  if (history.includedCount === 0) {
    items.push('还没有计入梁山分的有效录像：总览按零分 / 新手规则显示，图表与流水为空。')
  }
  if (history.undatedCount > 0) {
    items.push(
      `${history.undatedCount} 局没有可用日期，按「未定日期基线」先计入：不参与时段统计与时序定位，也不假定它们发生在最早日期。`,
    )
  }
  if (history.futureCount > 0) {
    items.push(
      `${history.futureCount} 局时间晚于当前时间：完整快照仍按现有口径计入，时段历史不计入这些未来事件，时段末分数可能低于当前快照。`,
    )
  } else if (Math.abs(range.latest - history.snapshot.lsf) > 1e-9) {
    items.push('时段末分数与当前快照不同，差额来自所选时间范围之外的记录。')
  }
  if (history.excludedCount > 0) {
    items.push(`${history.excludedCount} 局低于当前 3BV 下限，不计入梁山分。`)
  }
  items.push('软件与只看 NF 筛选在本页不参与重建：梁山分始终同时统计 NF 与非 NF 记录。')
  return `<div class="lsf-notice">${items.map((item) => `<p>${item}</p>`).join('')}</div>`
}
