import { SITE_ORIGIN } from '../../shared/constants'
import { formatCount, formatShortDate } from '../../shared/format'
import { el } from '../../shared/ui'
import {
  activeDays,
  activityCalendar,
  analyzeGames,
  applyBvFloors,
  bucketStats,
  dogPredictions,
  efficiencyTop,
  frontier,
  gcStats,
  heatmapStats,
  monthStats,
  MONTH_BVS_TIERS,
  MONTH_TIME_TIERS,
  othTop,
  periodGroups,
  rangeStats,
  rankGames,
  recentPb,
  subStats,
  summarize,
  todayCopyText,
  todayStats,
  weekStats,
  yearStats,
} from './analysis'
import { configureColors, dateColorStyle, medianOf, numColorStyle, pbColorStyle } from './colors'
import {
  DEFAULT_ANALYSIS_SETTINGS,
  loadAnalysisSettings,
  parseDogTargets,
  saveAnalysisSettings,
} from './analysis-settings'
import {
  RANGE_OPTIONS,
  addLocalDays,
  customDraftFor,
  formatDateInput,
  inDateRange,
  rangeHint,
  rangeSignature,
  resolveRange,
  startOfLocalDay,
  validateCustomRange,
} from './analysis-range'
import type { CustomRange, DateRange, RangeKey } from './analysis-range'
import type {
  AnalysisGame,
  EfficiencyMetric,
  MonthStat,
  OthMetric,
  PeriodMode,
  YearStat,
} from './analysis'
import { fetchLsfAnchors } from './lsf-anchors'
import { anchorKey, WORKBOOK_ANCHORS } from './ratings'
import type { LsfMetric, LsfMode, RatingSnapshot } from './ratings'
import type { LsfEvent, LsfHistory, LsfPoint, LsfRange } from './lsf-history'
import {
  buildLsfHistory,
  formatLsf,
  formatLsfDelta,
  levelContributionTotal,
  lsfBoardLabel,
  lsfRange,
} from './lsf-history'
import type { Level, Video } from './model'
import { LEVELS, STNB_COEFFICIENT } from './model'
import { ratingSnapshot } from './ratings'
import {
  MONTH_COPY_FIELDS,
  MONTH_COPY_GROUPS,
  YEAR_COPY_FIELDS,
  formatCopyMonth,
  formatCopyWeek,
  formatWeekDelta,
  monthCopyText,
  normalizeMonthCopyFields,
  normalizeYearCopyFields,
  weekCopyText,
  weekCopyEntries,
  weekDeltaClass,
  yearCopyText,
} from './trend-copy'

const LEVEL_LABELS: Record<Level, string> = { b: '初级', i: '中级', e: '高级' }
const STAT_LABELS = { time: '用时', bvs: '3BVS', stnb: 'STNB' } as const

function authorHomeLink(): HTMLAnchorElement {
  const link = document.createElement('a')
  link.href = 'https://openms.top/#/player/48'
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  link.textContent = '原作者主页'
  return link
}

type NavKey = 'overview' | 'lsf' | 'rank' | 'trend' | 'period' | 'dist' | 'eff' | 'map'
type RankStat = keyof typeof STAT_LABELS
type RankLayout = 'single' | 'triple'

const NAV_ITEMS: Array<[NavKey, string]> = [
  ['overview', '概览'],
  ['lsf', '梁山分'],
  ['rank', '榜单'],
  ['trend', '趋势'],
  ['period', '月年'],
  ['dist', '分布'],
  ['eff', '效率'],
  ['map', '地图'],
]

const SOFTWARE_OPTIONS: Array<[string, string]> = [
  ['all', '全部软件'],
  ['e', 'evf'],
  ['a', 'avf'],
  ['m', 'mvf'],
  ['r', 'rmv'],
]

const DAY_MS = 86_400_000

function formatTime(seconds: number): string {
  return seconds.toFixed(3)
}

/** 预览文本按纯文本插入，不当作 HTML 解析。 */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function trendCopyCell(kind: 'month' | 'year', key: string | number, level: Level, disabled = false): string {
  // 按钮上展示的日期也走复制格式；回查仍用 data-copy-key 里的内部键。
  const shown = kind === 'month' ? formatCopyMonth(String(key)) : String(key)
  const label = `复制 ${shown} ${LEVEL_LABELS[level]}${kind === 'month' ? '月均' : '年汇总'}数据`
  return '<td class="copy-cell">' +
    `<button type="button" class="copy-button" data-copy-kind="${kind}" data-copy-key="${key}" data-copy-level="${level}" aria-label="${label}" title="${disabled ? '当月没有局数' : label}"${disabled ? ' disabled' : ''}>复制</button>` +
    '</td>'
}

/** 周复制按钮的可访问名称带完整周一至周日日期；没有成绩的周不渲染按钮。 */
function weekCopyCell(start: number): string {
  const label = `复制 ${formatCopyWeek(start).replace('–', ' 至 ')} 周成绩`
  return '<td class="copy-cell">' +
    `<button type="button" class="copy-button" data-copy-kind="week" data-copy-week="${start}" aria-label="${label}" title="${label}">复制</button>` +
    '</td>'
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const area = document.createElement('textarea')
    try {
      area.value = text
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.append(area)
      area.select()
      return document.execCommand('copy')
    } catch {
      return false
    } finally {
      area.remove()
    }
  }
}

function linkToVideo(video: Video, text: string, className = ''): string {
  if (video.id <= 0) return `<span class="${className}">${text}</span>`
  const href = `${SITE_ORIGIN}/#/video/${video.id}`
  return `<a class="${className}" href="${href}" target="_blank" rel="noreferrer">${text}</a>`
}

function videoLink(game: AnalysisGame, text: string, className = ''): string {
  return linkToVideo(game.video, text, className)
}

/** 网站记录打开录像页；CSV 只显示可识别的本地记录信息，不生成网站录像链接。 */
function recordLabel(video: Video): string {
  if (video.importOrder !== undefined) {
    return `<span class="lsf-local">本地记录 #${video.importOrder + 1}</span>`
  }
  return linkToVideo(video, '录像')
}

function formatSoft(value: number): string {
  return value.toFixed(1)
}

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

const LSF_TABLE_COLUMNS = ['级别', '软实力', 'NF软实力', 'LSF', '定阶', 'NF定阶'] as const

function rankCell(title: string, progress: number): string {
  return `<td class="rank-cell"><b>${title}</b> <span class="muted">${progress.toFixed(1)}</span></td>`
}

/** 概览与梁山分页签共用的定阶总览表；行、列与精度只在这里定义一次。 */
export function ratingOverviewHtml(
  rating: RatingSnapshot,
  options: { anchorMode: 'workbook' | 'site'; anchorError: boolean },
): string {
  const source = options.anchorMode === 'site' ? '网站锚点' : '大表锚点'
  const row = (
    name: string,
    soft: number,
    nfSoft: number,
    lsf: number,
    title: string,
    progress: number,
    nfTitle: string,
    nfProgress: number,
    total = false,
  ): string =>
    `<tr${total ? ' class="total"' : ''}>` +
    `<th scope="row">${name}</th>` +
    `<td class="num">${formatSoft(soft)}</td>` +
    `<td class="num">${formatSoft(nfSoft)}</td>` +
    `<td class="num">${formatLsf(lsf)}</td>` +
    rankCell(title, progress) +
    rankCell(nfTitle, nfProgress) +
    '</tr>'

  const levelRows = rating.levels
    .map((item) =>
      row(
        LEVEL_LABELS[item.level],
        item.soft,
        item.nfSoft,
        item.lsf,
        item.title,
        item.progress,
        item.nfTitle,
        item.nfProgress,
      ),
    )
    .join('')

  const numericColumns = new Set([1, 2, 3])
  const head = LSF_TABLE_COLUMNS.map(
    (label, index) => `<th${numericColumns.has(index) ? ' class="num"' : ''}>${label}</th>`,
  ).join('')
  // 综合是合计行，放在三个级别下面，方便先看各级再看汇总。
  const totalRow = row(
    '综合',
    rating.soft,
    rating.nfSoft,
    rating.lsf,
    rating.title,
    rating.progress,
    rating.nfTitle,
    rating.nfProgress,
    true,
  )

  return (
    '<div class="card lsf-overview">' +
    '<div class="card-head"><h2 class="card-title">定阶总览</h2>' +
    `<span class="muted">综合定阶 ${rating.title} ${rating.progress.toFixed(1)} · ${source}</span></div>` +
    '<div class="table-scroll"><table class="data-table lsf-table">' +
    `<thead><tr>${head}</tr></thead>` +
    '<tbody>' +
    levelRows +
    totalRow +
    '</tbody></table></div>' +
    (options.anchorError
      ? `<p class="lsf-tip anchor-error">锚点刷新失败，继续用已保存的${source}</p>`
      : '') +
    '</div>'
  )
}

const LSF_LEDGER_STEP = 100
/** 阶梯图上最多标出多少个可交互台阶点；超出时按等距抽样，台阶线仍保留全部变化。 */
const LSF_CHART_DOTS = 1200

type RangeControlOwner = 'global' | 'lsf'

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

interface RangeEditor {
  owner: RangeControlOwner
  draft: CustomRange
  error: string
}

export function rangeSelectHtml(
  owner: RangeControlOwner,
  uiKey: RangeKey,
  editable = false,
): string {
  const options = RANGE_OPTIONS.map(
    (option) =>
      `<option value="${option.key}"${option.key === uiKey ? ' selected' : ''}>${option.label}</option>`,
  ).join('')
  const select = `<select class="select range-select" data-range-select="${owner}" aria-label="时段">${options}</select>`
  if (!editable) return select
  return (
    select +
    `<button type="button" class="button range-edit" data-range-edit="${owner}" aria-label="编辑自定义日期范围">编辑日期</button>`
  )
}

export function rangePanelHtml(
  owner: RangeControlOwner,
  draft: CustomRange,
  error: string,
  now: number,
): string {
  const max = formatDateInput(now)
  return (
    `<div class="range-panel" data-range-panel="${owner}">` +
    '<label class="range-field"><span>开始日期</span>' +
    `<input class="range-input" type="date" data-range-date="start" value="${draft.start}" max="${max}" required></label>` +
    '<label class="range-field"><span>结束日期</span>' +
    `<input class="range-input" type="date" data-range-date="end" value="${draft.end}" max="${max}" required></label>` +
    '<button type="button" class="button" data-range-apply>应用</button>' +
    '<button type="button" class="button" data-range-cancel>取消</button>' +
    `<span class="range-error" data-range-error role="alert">${escapeHtml(error)}</span>` +
    '</div>'
  )
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
    '<p class="lsf-tip">时段只作用于时段统计、阶梯图与流水；上面的定阶总览始终是当前完整快照。' +
    '选更短的时段时，区间起点会变成该时段开始前的累计 LSF，所以「时段涨分」通常小于总 LSF。</p>' +
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

function lsfDetailBody(event: LsfEvent): string {
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
    `<p class="lsf-detail-line"><b>${LEVEL_LABELS[change.level]}</b> · 软实力 ${formatSoft(change.softBefore)} → ${formatSoft(change.softAfter)}` +
    ` · NF软实力 ${formatSoft(change.nfSoftBefore)} → ${formatSoft(change.nfSoftAfter)}` +
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
    `<span class="muted">时间倒序 · 只列出引起 LSF 变化的录像 · 共 ${options.events.length} 条` +
    `${remaining > 0 ? ` · 已显示 ${shown.length} 条` : ''}</span></div>` +
    '<div class="table-scroll"><table class="data-table lsf-ledger">' +
    '<thead><tr><th>时间</th><th>级别 / 方式</th><th class="num">成绩</th><th class="num">LSF</th>' +
    '<th class="num">变动</th><th>来源</th><th>明细</th><th>录像</th></tr></thead>' +
    `<tbody>${rows || '<tr><td colspan="8" class="muted">所选时段没有 LSF 变动</td></tr>'}</tbody>` +
    '</table></div>' +
    (remaining > 0
      ? `<div class="lsf-more"><button type="button" class="button" data-lsf-more>显示更多（还有 ${remaining} 条）</button></div>`
      : '') +
    '<p class="lsf-tip">一条录像只生成一条事件；本身不改变 LSF 的录像不在流水里。来源贡献与总差值按未舍入数值计算，显示按两位小数四舍五入，可能相差 ±0.01。</p>' +
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

function rowClass(index: number): string {
  if (index === 0) return ' class="top1"'
  if (index < 3) return ' class="top3"'
  return ''
}

function colorAttr(level: Level, stat: 'time' | 'bvs' | 'stnb', value: number): string {
  const style = pbColorStyle(level, stat, value)
  return style
    ? ` style="background:${style.backgroundColor};color:${style.color}"`
    : ''
}

function numColorAttr(value: number, factor = 1): string {
  const style = numColorStyle(value, factor)
  return style
    ? ` style="background:${style.backgroundColor};color:${style.color}"`
    : ''
}

const dateStatsCache = new WeakMap<number[], { min: number; mid: number; max: number }>()

function dateAttr(value: number, dates: number[]): string {
  let stats = dateStatsCache.get(dates)
  if (!stats) {
    const sorted = dates.filter((item) => item > 0).sort((a, b) => a - b)
    stats =
      sorted.length < 2
        ? { min: 0, mid: 0, max: 0 }
        : {
            min: sorted[0] as number,
            mid: medianOf(sorted),
            max: sorted[sorted.length - 1] as number,
          }
    dateStatsCache.set(dates, stats)
  }
  if (stats.max <= stats.min) return ''
  const style = dateColorStyle(value, stats.min, stats.mid, stats.max)
  return style
    ? ` style="background:${style.backgroundColor};color:${style.color}"`
    : ''
}

export interface AnalysisViewOptions {
  /** 启动时若保存的是网站锚点，是否自动读取网站；独立 CSV 传 false 以免联网。 */
  autoSiteAnchors?: boolean
}

export interface AnalysisView {
  root: HTMLElement
  update(videos: Video[], options?: { csv?: boolean }): void
  /** 销毁视图：使进行中的锚点请求失效并移除节点。 */
  destroy(): void
}

export function createAnalysisView(options: AnalysisViewOptions = {}): AnalysisView {
  const state = {
    nav: 'overview' as NavKey,
    /** 已应用的时段（全局筛选与梁山分共用）。 */
    range: { key: 'all' as RangeKey, custom: { start: '', end: '' } as CustomRange },
    /** 编辑面板与草稿；关闭时只保留已应用时段中的上次有效日期。 */
    rangeEditor: null as RangeEditor | null,
    software: 'all',
    rankStat: 'time' as RankStat,
    rankLevel: 'b' as Level,
    rankLayout: 'single' as RankLayout,
    nfOnly: false,
    trendLevel: 'e' as Level,
    hideEmptyMonths: false,
    distLevel: 'b' as Level,
    effLevel: 'b' as Level,
    periodMode: 'month' as PeriodMode,
    periodLevel: 'e' as Level,
    periodStat: 'time' as RankStat,
    periodKey: '',
    mapLevel: 'e' as Level,
    monthCopyOpen: false,
    yearCopyOpen: { b: false, i: false, e: false } as Record<Level, boolean>,
    /** 梁山分流水展开状态、显示条数与图表定位目标；只留在本次视图会话。 */
    lsfExpanded: new Set<string>(),
    lsfLimit: LSF_LEDGER_STEP,
    lsfFocus: '',
    /** 单日最大涨分定位后高亮该日已显示的流水。 */
    lsfFocusDay: null as number | null,
  }

  let videos: Video[] = []
  let games: AnalysisGame[] = []
  let rangeGames: AnalysisGame[] = []
  let ratingGames: AnalysisGame[] = []
  let todaySnapshot: ReturnType<typeof todayStats> = []
  /** 录像集版本号：换数据源 / 玩家后让梁山分缓存失效。 */
  let videosToken = 0
  /** 梁山分历史缓存：一次数据或计分参数变化才重建，切页 / 展开 / 截取时段复用。 */
  let lsfCache: { key: string; history: LsfHistory } | null = null
  /** 本次渲染的倒序流水，供展开与卡片定位回查。 */
  let lsfEvents: LsfEvent[] = []
  /** 本次渲染的月 / 年统计结果，供复制按钮和预览回查，点击时不再聚合。 */
  let trendMonths: MonthStat[] = []
  let trendMonthLevel: Level = 'e'
  let trendYears: Record<Level, YearStat[]> = { b: [], i: [], e: [] }
  /** 本次渲染的周复制文本，包含已确定的 Δ 和筛选范围，以周起点回查。 */
  const trendWeekCopies = new Map<number, string>()
  let now = Date.now()
  const settings = loadAnalysisSettings()
  configureColors(settings.colorThresholds)
  let anchorError = false
  let anchorRequest = 0
  let csvMode = false
  /** 上一次全局筛选使用的日期边界签名，用于跨午夜等边界变化时同步重筛。 */
  let appliedRangeSignature = ''
  const floorLabel = (): string =>
    `${settings.bvFloors.b}/${settings.bvFloors.i}/${settings.bvFloors.e}`

  const root = el('section', 'analysis-pane')

  const filters = el('section', 'player-filters')
  const softwareSelect = el('select', 'select')
  for (const [value, label] of SOFTWARE_OPTIONS) {
    const option = el('option', undefined, label)
    option.value = value
    softwareSelect.append(option)
  }

  // 时段：快捷项 + 自定义日期，和梁山分卡片共用同一份状态。
  const rangeField = el('div', 'filter range-filter')
  const rangeSelectSlot = el('span', 'range-select-slot')
  rangeField.append(el('span', 'filter-label', '时间'), rangeSelectSlot)
  const rangePanel = el('div', 'range-panel-row hidden')
  const softwareField = el('label', 'filter')
  softwareField.append(el('span', 'filter-label', '软件'), softwareSelect)
  const countNote = el('span', 'source-note')
  const nfField = el('label', 'check')
  const nfInput = el('input')
  nfInput.type = 'checkbox'
  nfInput.id = 'analysis-nf-global'
  nfInput.checked = state.nfOnly
  nfField.append(nfInput, document.createTextNode(' 只看 NF'))
  const settingsButton = el('button', 'button', '参数')
  settingsButton.type = 'button'
  filters.append(rangeField, rangePanel, softwareField, nfField, countNote, settingsButton)

  const settingsPanel = el('section', 'analysis-settings hidden')
  const sourceNote = el('p', 'muted settings-source', '默认参数为大表 57.8 · ')
  sourceNote.append(authorHomeLink())
  settingsPanel.append(sourceNote)
  type BasicKey = 'rankLimit' | 'monthTop' | 'yearTop' | 'smallTop' | 'subTiers'
  const settingFields: Array<[BasicKey, string, number, number]> = [
    ['rankLimit', '榜单 Top', 10, 200],
    ['monthTop', '月 Top', 1, 50],
    ['yearTop', '年 Top', 1, 50],
    ['smallTop', '效率 / 杂项 Top', 1, 20],
    ['subTiers', 'Sub 档数', 5, 20],
  ]
  const settingInputs = new Map<BasicKey, HTMLInputElement>()
  for (const [key, label, min, max] of settingFields) {
    const field = el('label', 'setting-field')
    const input = el('input', 'setting-input')
    input.type = 'number'
    input.min = String(min)
    input.max = String(max)
    input.value = String(settings[key])
    input.addEventListener('change', () => {
      const value = Number(input.value)
      if (!Number.isFinite(value)) {
        input.value = String(settings[key])
        return
      }
      settings[key] = Math.min(max, Math.max(min, Math.round(value)))
      input.value = String(settings[key])
      saveAnalysisSettings(settings)
      render()
    })
    settingInputs.set(key, input)
    field.append(el('span', 'filter-label', label), input)
    settingsPanel.append(field)
  }
  const anchorBlock = el('details', 'settings-advanced')
  anchorBlock.append(el('summary', undefined, '锚点'))
  const anchorActions = el('div', 'setting-fields')
  const anchorStatus = el('span', 'source-note', '')
  const useWorkbook = el('button', 'button', '使用大表锚点')
  useWorkbook.type = 'button'
  useWorkbook.addEventListener('click', () => {
    anchorRequest += 1
    Object.assign(settings.anchors, WORKBOOK_ANCHORS)
    settings.anchorMode = 'workbook'
    anchorError = false
    refreshAnchorInputs()
    anchorStatus.textContent = '已使用大表锚点'
    saveAnalysisSettings(settings)
    render()
  })
  const useSite = el('button', 'button', '读取并使用网站锚点')
  useSite.type = 'button'
  useSite.addEventListener('click', () => {
    void loadSiteAnchors(true).then((ok) => {
      if (!ok) return
      settings.anchorMode = 'site'
      saveAnalysisSettings(settings)
      render()
    })
  })
  anchorActions.append(useWorkbook, useSite, anchorStatus)
  anchorBlock.append(anchorActions)

  const anchorTable = el('table', 'settings-table')
  const anchorHead = el('tr')
  anchorHead.append(
    el('th', undefined, '项目'),
    el('th', undefined, '锚点'),
    el('th', undefined, 'NF锚点'),
  )
  anchorTable.append(anchorHead)
  const anchorInputs: Array<{ mode: LsfMode; level: Level; metric: LsfMetric; input: HTMLInputElement }> = []
  const metricLabels: Array<[LsfMetric, string]> = [
    ['t', '用时'],
    ['b', '3BVS'],
    ['s', 'STNB'],
  ]
  for (const level of LEVELS) {
    for (const [metric, metricLabel] of metricLabels) {
      const row = el('tr')
      row.append(el('th', undefined, `${LEVEL_LABELS[level]} · ${metricLabel}`))
      for (const mode of ['std', 'nf'] as const) {
        const cell = el('td')
        const input = el('input', 'setting-input')
        input.type = 'number'
        input.step = 'any'
        const key = anchorKey(mode, level, metric)
        input.value = String(settings.anchors[key])
        input.addEventListener('change', () => {
          const value = Number(input.value)
          if (!Number.isFinite(value) || value <= 0) {
            input.value = String(settings.anchors[key])
            return
          }
          settings.anchors[key] = value
          settings.anchorMode = 'workbook'
          anchorRequest += 1
          anchorError = false
          saveAnalysisSettings(settings)
          render()
        })
        anchorInputs.push({ mode, level, metric, input })
        cell.append(input)
        row.append(cell)
      }
      anchorTable.append(row)
    }
  }
  anchorBlock.append(anchorTable)

  function refreshAnchorInputs(): void {
    for (const item of anchorInputs) {
      item.input.value = String(settings.anchors[anchorKey(item.mode, item.level, item.metric)])
    }
  }

  const weightInputs: Array<{ input: HTMLInputElement; value: () => number }> = []
  const weightsBlock = el('details', 'settings-advanced')
  weightsBlock.append(el('summary', undefined, '权重 / T37 / 3BV'))

  const weightTable = el('table', 'settings-table')
  const weightHead = el('tr')
  weightHead.append(
    el('th', undefined, '项目'),
    el('th', undefined, '用时'),
    el('th', undefined, '3BVS'),
    el('th', undefined, 'STNB'),
  )
  weightTable.append(weightHead)
  for (const level of LEVELS) {
    const row = el('tr')
    row.append(el('th', undefined, LEVEL_LABELS[level]))
    for (const metric of ['t', 'b', 's'] as const) {
      const input = el('input', 'setting-input')
      input.type = 'number'
      input.min = '0'
      input.max = '100'
      input.value = String(settings.softWeights[level][metric])
      input.addEventListener('change', () => {
        const value = Number(input.value)
        if (!Number.isFinite(value) || value < 0 || value > 100) {
          input.value = String(settings.softWeights[level][metric])
          return
        }
        settings.softWeights[level][metric] = Math.round(value)
        saveAnalysisSettings(settings)
        render()
      })
      weightInputs.push({ input, value: () => settings.softWeights[level][metric] })
      const cell = el('td')
      cell.append(input)
      row.append(cell)
    }
    weightTable.append(row)
  }

  const t37Table = el('table', 'settings-table')
  const t37Head = el('tr')
  t37Head.append(
    el('th', undefined, '项目'),
    el('th', undefined, '综合权重'),
    el('th', undefined, 'T37 槽位'),
    el('th', undefined, '补位用时'),
    el('th', undefined, '3BV 下限'),
    el('th', undefined, 'PPP 常数'),
  )
  t37Table.append(t37Head)
  for (const level of LEVELS) {
    const row = el('tr')
    row.append(el('th', undefined, LEVEL_LABELS[level]))
    const fields: Array<{
      get: () => number
      set: (value: number) => void
      min: number
      max: number
      round?: boolean
      affectsGames?: boolean
    }> = [
      {
        get: () => settings.levelWeights[level],
        set: (value) => {
          settings.levelWeights[level] = value
        },
        min: 0,
        max: 100,
      },
      {
        get: () => settings.t37Slots[level],
        set: (value) => {
          settings.t37Slots[level] = value
        },
        min: 1,
        max: 50,
      },
      {
        get: () => settings.t37Pads[level],
        set: (value) => {
          settings.t37Pads[level] = value
        },
        min: 1,
        max: 999,
      },
      {
        get: () => settings.bvFloors[level],
        set: (value) => {
          settings.bvFloors[level] = value
        },
        min: 1,
        max: 300,
        affectsGames: true,
      },
      {
        get: () => settings.pppConsts[level],
        set: (value) => {
          settings.pppConsts[level] = value
        },
        min: 0.000001,
        max: 10000,
        round: false,
      },
    ]
    for (const field of fields) {
      const input = el('input', 'setting-input')
      input.type = 'number'
      input.min = String(field.min)
      input.max = String(field.max)
      if (field.round === false) input.step = 'any'
      input.value = String(field.get())
      input.addEventListener('change', () => {
        const value = Number(input.value)
        if (!Number.isFinite(value) || value < field.min || value > field.max) {
          input.value = String(field.get())
          return
        }
        field.set(field.round === false ? value : Math.round(value))
        saveAnalysisSettings(settings)
        if (field.affectsGames) applyFilters()
        render()
      })
      weightInputs.push({ input, value: field.get })
      const cell = el('td')
      cell.append(input)
      row.append(cell)
    }
    t37Table.append(row)
  }
  weightsBlock.append(weightTable, t37Table)

  const colorBlock = el('details', 'settings-advanced')
  colorBlock.append(el('summary', undefined, '色板阈值'))
  const colorInput = el('textarea', 'setting-input setting-input-wide')
  colorInput.rows = 3
  colorInput.value = settings.colorThresholds.join(', ')
  colorInput.addEventListener('change', () => {
    const values = colorInput.value
      .split(',')
      .map((item) => Number(item.trim()))
      .filter((item) => Number.isFinite(item) && item > 0)
    if (values.length !== DEFAULT_ANALYSIS_SETTINGS.colorThresholds.length) {
      colorInput.value = settings.colorThresholds.join(', ')
      return
    }
    settings.colorThresholds = values
    configureColors(values)
    saveAnalysisSettings(settings)
    render()
  })
  colorBlock.append(
    el(
      'p',
      'muted',
      `29 档阈值，逗号分隔；从高到低对应色板，默认 ${DEFAULT_ANALYSIS_SETTINGS.colorThresholds.join(', ')}`,
    ),
    colorInput,
  )

  const advanced = el('details', 'settings-advanced')
  advanced.append(el('summary', undefined, '狗预测'))

  const dogEField = el('label', 'setting-field')
  const dogEInput = el('input', 'setting-input setting-input-wide')
  dogEInput.value = settings.dogTargetsE
  dogEInput.addEventListener('change', () => {
    settings.dogTargetsE = dogEInput.value
    saveAnalysisSettings(settings)
    render()
  })
  dogEField.append(el('span', 'filter-label', '高级狗预测目标'), dogEInput)

  const dogIField = el('label', 'setting-field')
  const dogIInput = el('input', 'setting-input setting-input-wide')
  dogIInput.value = settings.dogTargetsI
  dogIInput.addEventListener('change', () => {
    settings.dogTargetsI = dogIInput.value
    saveAnalysisSettings(settings)
    render()
  })
  dogIField.append(el('span', 'filter-label', '中级狗预测目标'), dogIInput)
  advanced.append(dogEField, dogIField)

  const resetSettings = el('button', 'button', '恢复默认')
  resetSettings.type = 'button'
  resetSettings.addEventListener('click', () => {
    anchorRequest += 1
    Object.assign(settings, JSON.parse(JSON.stringify(DEFAULT_ANALYSIS_SETTINGS)) as typeof settings)
    configureColors(settings.colorThresholds)
    for (const [key, input] of settingInputs) input.value = String(settings[key])
    for (const item of weightInputs) item.input.value = String(item.value())
    colorInput.value = settings.colorThresholds.join(', ')
    refreshAnchorInputs()
    anchorStatus.textContent = '已使用大表锚点'
    anchorError = false
    dogEInput.value = settings.dogTargetsE
    dogIInput.value = settings.dogTargetsI
    applyFilters()
    saveAnalysisSettings(settings)
    render()
  })
  settingsPanel.append(anchorBlock, weightsBlock, colorBlock, advanced, resetSettings)
  settingsButton.addEventListener('click', () => settingsPanel.classList.toggle('hidden'))

  const nav = el('nav', 'analysis-nav')
  const navButtons = new Map<NavKey, HTMLButtonElement>()
  for (const [key, label] of NAV_ITEMS) {
    const button = el('button', 'analysis-tab', label)
    button.type = 'button'
    button.dataset.nav = key
    navButtons.set(key, button)
    nav.append(button)
  }

  const viewHost = el('div', 'analysis-view')

  /** 复制按钮的「复制 / 已复制 / 复制失败」反馈；节点被重新渲染替换后不再写旧反馈。 */
  function copyFeedback(button: HTMLButtonElement, ok: boolean): void {
    if (!button.isConnected) return
    button.textContent = ok ? '已复制' : '复制失败'
    button.classList.toggle('copied', ok)
    window.setTimeout(() => {
      if (!button.isConnected) return
      button.textContent = '复制'
      button.classList.remove('copied')
    }, 1200)
  }

  /** 复制设置只有月均、年汇总两个范围；周复制内容固定，没有设置入口。 */
  type CopySettingsScope = 'month' | 'year'

  function isCopySettingsScope(value: string | undefined): value is CopySettingsScope {
    return value === 'month' || value === 'year'
  }

  /** 按按钮上的周期标识回查本次渲染的统计结果，避免点击时重新聚合。 */
  function copyButtonText(button: HTMLButtonElement): string | null {
    const kind = button.dataset.copyKind
    const level = button.dataset.copyLevel as Level | undefined
    if (kind === 'today') {
      if (!level) return null
      const row = todaySnapshot.find((item) => item.level === level)
      return row ? todayCopyText(row) : null
    }
    if (kind === 'week') {
      const start = Number(button.dataset.copyWeek)
      if (!Number.isFinite(start)) return null
      return trendWeekCopies.get(start) ?? null
    }
    const key = button.dataset.copyKey
    if (!key || !level) return null
    if (kind === 'month') {
      // 难度切换后旧按钮已被替换，这里再确认一次，避免用别的难度的快照。
      if (level !== trendMonthLevel) return null
      const row = trendMonths.find((row) => row.key === key && row.count > 0)
      return row ? monthCopyText(row, level, settings.monthCopyFields) : null
    }
    if (kind === 'year') {
      const row = trendYears[level].find((row) => String(row.year) === key && row.count > 0)
      return row ? yearCopyText(row, level, settings.yearCopyFields) : null
    }
    return null
  }

  function copyPreview(
    scope: CopySettingsScope,
    level = trendMonthLevel,
  ): { title: string; text: string } {
    const month = scope === 'month' ? trendMonths.find((row) => row.count > 0) : undefined
    const year = scope === 'year' ? trendYears[level].find((row) => row.count > 0) : undefined
    const period = month ? formatCopyMonth(month.key) : year?.year
    return {
      title: `复制预览${period === undefined ? '' : ` · ${period}`} · ${LEVEL_LABELS[level]}`,
      text: month
        ? monthCopyText(month, level, settings.monthCopyFields)
        : year
          ? yearCopyText(year, level, settings.yearCopyFields)
          : '暂无数据可预览',
    }
  }

  function copyFieldRows(scope: CopySettingsScope, level?: Level): string {
    const selected: readonly string[] =
      scope === 'month' ? settings.monthCopyFields : settings.yearCopyFields
    const checkbox = (field: string, label: string, id: string): string =>
      `<label class="check copy-field"><input type="checkbox" id="${id}" data-copy-scope="${scope}" data-copy-field="${field}"${selected.includes(field) ? ' checked' : ''}> ${label}</label>`
    if (scope === 'year') {
      return (
        '<div class="copy-field-row"><span class="copy-group">可选指标</span>' +
        YEAR_COPY_FIELDS.map((spec) =>
          checkbox(spec.field, spec.label, `copy-year-${spec.field}-${level}`),
        ).join('') +
        '</div>'
      )
    }
    return MONTH_COPY_GROUPS.map((group) => {
      const specs = MONTH_COPY_FIELDS.filter((spec) => spec.group === group.key)
      return (
        '<div class="copy-field-row">' +
        `<span class="copy-group">${group.label}</span>` +
        specs.map((spec) => checkbox(spec.field, spec.label, `copy-month-${spec.field}`)).join('') +
        '</div>'
      )
    }).join('')
  }

  /** 月均卡片与年汇总卡片共用的设置区；年汇总三个难度各渲染一份。 */
  function copySettingsHtml(scope: CopySettingsScope, level?: Level): string {
    const month = scope === 'month'
    const id = month ? 'month-copy-settings' : `year-copy-settings-${level}`
    const open = month ? state.monthCopyOpen : level !== undefined && state.yearCopyOpen[level]
    const preview = copyPreview(scope, level)
    return (
      `<section class="copy-settings${open ? '' : ' hidden'}" id="${id}"${month ? '' : ` data-level="${level}"`}>` +
      '<div class="copy-settings-head"><h3>复制设置</h3>' +
      (month ? '' : '<span class="copy-shared">适用于三个难度</span>') +
      '</div>' +
      `<p class="copy-fixed">固定内容：${month ? '月份' : '年份'}与难度、局数概况、平均成绩（始终保留）</p>` +
      `<div class="copy-field-groups">${copyFieldRows(scope, level)}</div>` +
      `<div class="copy-preview" data-copy-preview="${scope}"${month ? '' : ` data-level="${level}"`}>` +
      `<p class="copy-preview-title">${escapeHtml(preview.title)}</p>` +
      `<pre class="copy-preview-text">${escapeHtml(preview.text)}</pre>` +
      '</div>' +
      '<div class="copy-settings-foot">' +
      `<button type="button" class="button" data-copy-reset="${scope}">恢复默认</button>` +
      '<span class="muted">修改后自动保存</span>' +
      '</div>' +
      '</section>'
    )
  }

  /** 展开 / 收起设置区：只记在当前视图会话，不写入存档。 */
  function toggleCopySettings(button: HTMLElement): void {
    const scope = button.dataset.copyPanel
    if (!isCopySettingsScope(scope)) return
    const target = button.getAttribute('aria-controls')
    const panel = target ? viewHost.querySelector<HTMLElement>(`#${target}`) : null
    if (!panel) return
    panel.classList.toggle('hidden')
    const open = !panel.classList.contains('hidden')
    button.setAttribute('aria-expanded', String(open))
    if (scope === 'month') {
      state.monthCopyOpen = open
      return
    }
    const level = panel.dataset.level as Level | undefined
    if (level) state.yearCopyOpen[level] = open
  }

  /**
   * 勾选、恢复默认后同步所有同名设置区并刷新预览。
   * 不走整页重绘，展开状态和键盘焦点自然保留。
   */
  function setCopyFields(scope: CopySettingsScope, fields: unknown): void {
    if (scope === 'month') settings.monthCopyFields = normalizeMonthCopyFields(fields)
    else settings.yearCopyFields = normalizeYearCopyFields(fields)
    saveAnalysisSettings(settings)
    const selected: readonly string[] =
      scope === 'month' ? settings.monthCopyFields : settings.yearCopyFields
    for (const input of viewHost.querySelectorAll<HTMLInputElement>(
      `input[data-copy-scope="${scope}"]`,
    )) {
      input.checked = selected.includes(input.dataset.copyField ?? '')
    }
    for (const preview of viewHost.querySelectorAll<HTMLElement>(
      `[data-copy-preview="${scope}"]`,
    )) {
      const level = (preview.dataset.level as Level | undefined) ?? trendMonthLevel
      const content = copyPreview(scope, level)
      const title = preview.querySelector<HTMLElement>('.copy-preview-title')
      const text = preview.querySelector<HTMLElement>('.copy-preview-text')
      if (title) title.textContent = content.title
      if (text) text.textContent = content.text
    }
  }

  const note = el(
    'p',
    'analysis-note',
    '赛博大表只统计模式 00 的已审核录像，3BV 下限默认 10 / 30 / 100；网站 NF 按右键 = 0，CSV 按 style=NF。',
  )
  const credit = el('p', 'analysis-note', '统计方式来自大表 ArbiterStatsAuto · ')
  credit.append(authorHomeLink())

  root.append(filters, settingsPanel, nav, viewHost, note, credit)

  function applyFilters(bounds: DateRange = currentBounds(Date.now())): void {
    const filtered = analyzeGames(
      videos,
      { software: csvMode ? 'all' : state.software, nfOnly: state.nfOnly },
      1,
    )
    // 全局筛选与梁山分共用同一份时段；「全部」不设日期边界。
    games = applyBvFloors(filtered, settings.bvFloors).filter((game) =>
      inDateRange(game.date, bounds),
    )
    // 月年局数与 rAvg 保留 2–9，但不再套用各级 3BV 下限。
    rangeGames = filtered.filter(
      (game) => game.bv >= 2 && inDateRange(game.date, bounds),
    )
    appliedRangeSignature = rangeSignature(bounds)
    updateCountNote()
  }

  /**
   * 梁山分历史：只有录像集或计分参数（锚点、权重、3BV 下限）变化才重建。
   * 用缓存键而不是手工失效，避免切页、展开、缩小范围时重复重建。
   */
  function lsfHistory(): LsfHistory {
    const key = [
      videosToken,
      now,
      JSON.stringify(settings.anchors),
      JSON.stringify(settings.softWeights),
      JSON.stringify(settings.levelWeights),
      JSON.stringify(settings.bvFloors),
    ].join('|')
    if (lsfCache !== null && lsfCache.key === key) return lsfCache.history
    const history = buildLsfHistory(ratingGames, {
      anchors: settings.anchors,
      softWeights: settings.softWeights,
      levelWeights: settings.levelWeights,
      floors: settings.bvFloors,
      now,
    })
    lsfCache = { key, history }
    return history
  }

  /** 已应用时段的解析结果；快捷项每次重新按当前时钟解析，跨午夜不会停留在旧日期。 */
  function currentBounds(clock: number): DateRange {
    return resolveRange(state.range.key, state.range.custom, clock)
  }

  /** 计入局数与筛选提示：梁山分有自己的口径，不沿用其他页签筛选后的计数。 */
  function updateCountNote(): void {
    if (state.nav === 'lsf') {
      countNote.textContent =
        `计入 ${formatCount(lsfHistory().includedCount)} 局 · 全时段 · 不受软件 / 只看 NF 筛选`
      return
    }
    countNote.textContent = `计入 ${formatCount(games.length)} 局${state.nfOnly ? ' · NF' : ''}`
  }

  /** 梁山分只用时间截取历史；软件与只看 NF 在该页禁用，离开时恢复。 */
  function updateFilterAvailability(): void {
    const lsfTab = state.nav === 'lsf'
    const softwareOff = lsfTab || csvMode
    softwareField.classList.toggle('disabled', softwareOff)
    nfField.classList.toggle('disabled', lsfTab)
    softwareSelect.disabled = softwareOff
    nfInput.disabled = lsfTab
    softwareSelect.title = lsfTab ? '梁山分使用全时段记录，不受软件筛选' : ''
    nfInput.title = lsfTab ? '梁山分始终同时统计 NF 与非 NF 记录，不单独筛选' : ''
    updateCountNote()
  }

  function renderNav(): void {
    for (const [key, button] of navButtons) {
      button.classList.toggle('active', state.nav === key)
      button.setAttribute('aria-pressed', String(state.nav === key))
    }
  }

  function rangeControls(clock: number): RangeControlState {
    const editor = state.rangeEditor
    return {
      uiKey: editor ? 'custom' : state.range.key,
      panel: editor?.owner ?? null,
      draft: editor?.draft ?? state.range.custom,
      error: editor?.error ?? '',
      now: clock,
      editable: state.range.key === 'custom',
    }
  }

  /** 顶部筛选条与页内控件从同一份已应用时段和编辑草稿派生。 */
  function renderRangeControls(clock: number): void {
    const controls = rangeControls(clock)
    rangeSelectSlot.innerHTML = rangeSelectHtml(
      'global',
      controls.uiKey,
      controls.editable,
    )
    const showPanel = controls.panel === 'global'
    rangePanel.classList.toggle('hidden', !showPanel)
    rangePanel.innerHTML = showPanel
      ? rangePanelHtml('global', controls.draft, controls.error, clock)
      : ''
  }

  /** 重绘后把焦点交回对应入口的时段控件，键盘操作不被打断。 */
  function focusRangeControl(owner: 'global' | 'lsf', target: 'select' | 'start' = 'select'): void {
    const host = owner === 'lsf' ? viewHost : filters
    const selector =
      target === 'select'
        ? `select[data-range-select="${owner}"]`
        : `[data-range-panel="${owner}"] input[data-range-date="start"]`
    host.querySelector<HTMLElement>(selector)?.focus()
  }

  /** 切换时段后，旧的定位与单日高亮不再指向当前流水。 */
  function clearLsfFocus(): void {
    state.lsfFocus = ''
    state.lsfFocusDay = null
  }

  /** 选择快捷时段立即应用；选择「自定义」先进入草稿，应用前不改已应用范围。 */
  function pickRange(key: RangeKey, owner: 'global' | 'lsf'): void {
    if (key === 'custom') {
      state.rangeEditor = { owner, draft: customDraftFor(state.range.custom, Date.now()), error: '' }
      render()
      focusRangeControl(owner, 'start')
      return
    }
    state.range = { key, custom: state.range.custom }
    state.rangeEditor = null
    clearLsfFocus()
    applyFilters()
    render()
    focusRangeControl(owner)
  }

  function syncRangeDraft(input: HTMLInputElement): void {
    const field = input.dataset.rangeDate
    if (state.rangeEditor && (field === 'start' || field === 'end')) {
      state.rangeEditor.draft = { ...state.rangeEditor.draft, [field]: input.value }
    }
  }

  /** 应用自定义日期；校验失败只显示错误，不改变已应用范围。 */
  function applyCustomRange(panel: HTMLElement): void {
    const owner = panel.getAttribute('data-range-panel') === 'lsf' ? 'lsf' : 'global'
    const start = panel.querySelector<HTMLInputElement>('input[data-range-date="start"]')
    const end = panel.querySelector<HTMLInputElement>('input[data-range-date="end"]')
    const draft: CustomRange = { start: start?.value ?? '', end: end?.value ?? '' }
    const check = validateCustomRange(draft, Date.now())
    if (!check.ok) {
      state.rangeEditor = { owner, draft, error: check.message }
      render()
      focusRangeControl(owner, 'start')
      return
    }
    state.range = { key: 'custom', custom: draft }
    state.rangeEditor = null
    clearLsfFocus()
    applyFilters()
    render()
    focusRangeControl(owner)
  }

  function cancelCustomRange(): void {
    const owner = state.rangeEditor?.owner ?? 'global'
    state.rangeEditor = null
    render()
    focusRangeControl(owner)
  }

  function render(): void {
    const clock = Date.now()
    const bounds = currentBounds(clock)
    // 跨午夜后快捷时段的边界会变（今天 / 本月 / 近7天…）：先同步全局筛选，再渲染；
    // 梁山分与全局筛选因此始终基于同一组日期边界，历史缓存照常复用。
    if (rangeSignature(bounds) !== appliedRangeSignature) applyFilters(bounds)
    renderNav()
    renderRangeControls(clock)
    updateFilterAvailability()
    if (state.nav === 'overview') {
      viewHost.innerHTML = overviewHtml()
    } else if (state.nav === 'lsf') {
      viewHost.innerHTML = lsfHtml(bounds, clock)
    } else if (state.nav === 'rank') {
      viewHost.innerHTML = rankHtml()
    } else if (state.nav === 'trend') {
      viewHost.innerHTML = trendHtml(bounds)
    } else if (state.nav === 'period') {
      viewHost.innerHTML = periodHtml()
    } else if (state.nav === 'dist') {
      viewHost.innerHTML = distHtml()
    } else if (state.nav === 'eff') {
      viewHost.innerHTML = effHtml()
    } else {
      viewHost.innerHTML = mapHtml()
    }
  }

  /** 梁山分页签：定阶总览（全时段快照）+ 时段统计 + 阶梯图 + 变动流水。 */
  function lsfHtml(bounds: DateRange, clock: number): string {
    const history = lsfHistory()
    const range = lsfRange(history, {
      start: bounds.start,
      endExclusive: bounds.endExclusive,
      now: clock,
    })
    const controls = rangeControls(clock)
    const summary =
      ratingOverviewHtml(history.snapshot, { anchorMode: settings.anchorMode, anchorError }) +
      lsfStatsHtml(range, bounds, controls)
    if (history.includedCount === 0) {
      lsfEvents = []
      return (
        summary +
        '<div class="card"><div class="card-body"><p class="muted">' +
        `当前各级 3BV 下限是 ${floorLabel()}；计入有效录像后，这里会显示阶梯图与变动流水。` +
        '</p></div></div>' +
        lsfNoticeHtml(history, range)
      )
    }
    const undated = bounds.start === null ? history.events.filter((event) => event.undated) : []
    const events = [...range.events].reverse().concat([...undated].reverse())
    lsfEvents = events
    return (
      summary +
      lsfChartHtml(range) +
      lsfNoticeHtml(history, range) +
      lsfLedgerHtml({
        events,
        expanded: state.lsfExpanded,
        limit: state.lsfLimit,
        focus: state.lsfFocus,
        highlightDay: state.lsfFocusDay,
      })
    )
  }

  function expandLsfDetail(id: string, open: boolean): void {
    const button = viewHost.querySelector<HTMLElement>(`[data-lsf-toggle="${id}"]`)
    const detail = viewHost.querySelector<HTMLElement>(`[data-lsf-detail="${id}"]`)
    const row = viewHost.querySelector<HTMLElement>(`[data-lsf-event-row="${id}"]`)
    if (open && detail && detail.dataset.filled !== '1') {
      const event = lsfEvents.find((item) => item.id === id)
      const cell = detail.firstElementChild
      if (event && cell) {
        cell.innerHTML = lsfDetailBody(event)
        detail.dataset.filled = '1'
      }
    }
    if (button) {
      button.textContent = open ? '收起' : '展开'
      button.setAttribute('aria-expanded', String(open))
    }
    if (detail) detail.classList.toggle('hidden', !open)
    if (row) row.classList.toggle('open', open)
  }

  function toggleLsfDetail(id: string): void {
    if (!id) return
    const open = !state.lsfExpanded.has(id)
    if (open) state.lsfExpanded.add(id)
    else state.lsfExpanded.delete(id)
    expandLsfDetail(id, open)
  }

  /** 点击或键盘激活台阶点：必要时扩大流水显示范围，再滚动定位并展开明细。 */
  function focusLsfEvent(id: string, day: number | null = null): void {
    if (!id) return
    const index = lsfEvents.findIndex((event) => event.id === id)
    if (index < 0) return
    state.lsfFocus = id
    state.lsfFocusDay = day
    state.lsfExpanded.add(id)
    if (index >= state.lsfLimit) {
      state.lsfLimit = Math.ceil((index + 1) / LSF_LEDGER_STEP) * LSF_LEDGER_STEP
    }
    render()
    // 重绘会替换掉刚被激活的台阶点，把焦点交给对应流水的展开按钮，键盘操作可以继续。
    const button = viewHost.querySelector<HTMLButtonElement>(`[data-lsf-toggle="${id}"]`)
    if (button) button.focus()
    const row = viewHost.querySelector<HTMLElement>(`[data-lsf-event-row="${id}"]`)
    if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'center' })
  }

  /**
   * 单日最大涨分定位：加载到该日最新一条流水并展开，同一天已显示的流水一起高亮。
   * 不修改已选时段，也不隐式切换成单日筛选。
   */
  function focusLsfDay(day: number): void {
    const target = lsfEvents.find(
      (event) => !event.undated && startOfLocalDay(event.date) === day,
    )
    if (target) focusLsfEvent(target.id, day)
  }

  function overviewHtml(): string {
    const recent = recentPb(games, now, 30, 8)
    const recentCount = games.filter(
      (game) =>
        game.pb &&
        game.pbPrev !== null &&
        game.date >= now - 30 * DAY_MS &&
        game.date <= now,
    ).length
    const weeks = weekStats(
      games,
      10,
      now,
      true,
      settings.t37Slots,
      settings.t37Pads,
      settings.pppConsts,
    )
    const lastWeek = weeks[weeks.length - 1]
    const days = activeDays(games, now, 30)
    const summary = summarize(games, now)
    const today = todayStats(ratingGames, now)
    todaySnapshot = today
    const rating = ratingSnapshot(
      ratingGames,
      settings.anchors,
      settings.softWeights,
      settings.levelWeights,
      settings.bvFloors,
    )
    const gc = gcStats(rangeGames)
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
    const calendar = activityCalendar(games, now)

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

    const recentRows = recent
      .map(({ game, prev }) => {
        const delta = prev - game.time
        const hot = now - game.date <= 7 * DAY_MS
        return (
          `<tr${hot ? ' class="hot"' : ''}>` +
          `<td class="date"${dateAttr(game.date, recent.map((item) => item.game.date))}>${formatShortDate(game.date)}</td>` +
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

    return (
      ratingOverviewHtml(rating, { anchorMode: settings.anchorMode, anchorError }) +
      '<div class="kpi-grid kpi-grid-3">' +
      '<div class="kpi"><span>近 30 天新 PB</span>' +
      `<b>${recentCount}</b>` +
      `<small>${recent[0] ? `最近一条 ${formatShortDate(recent[0].game.date)}` : '最近没有新 PB'}</small></div>` +
      '<div class="kpi"><span>本周 T37</span>' +
      `<b>${lastWeek && lastWeek.count > 0 ? lastWeek.t37.toFixed(1) : '—'}</b>` +
      `<small>${lastWeek && lastWeek.count > 0 ? `B37 ${lastWeek.b37.toFixed(1)} · S37 ${lastWeek.s37.toFixed(1)}` : '本周还没有成绩'}</small></div>` +
      '<div class="kpi"><span>近 30 天活跃</span>' +
      `<b>${days} 天</b>` +
      `<small>${games.filter((game) => game.date >= now - 30 * DAY_MS).length} 局</small></div>` +
      '</div>' +

      '<div class="card">' +
      '<div class="card-head"><h2 class="card-title">今日成绩</h2></div>' +
      '<div class="table-scroll"><table class="data-table summary-table today-table">' +
      '<thead><tr><th>难度</th><th class="num">总局数</th><th class="num">Best Time</th><th class="num">Best 3BVS</th><th class="num">Best STNB</th><th class="num">Avg Time</th><th class="num">Avg 3BVS</th><th class="num">Avg STNB</th><th class="num">Avg 3BV</th><th class="copy-cell"></th></tr></thead>' +
      `<tbody>${todayRows}</tbody>` +
      '</table></div>' +
      '</div>' +

      '<div class="card">' +
      '<div class="card-head"><h2 class="card-title">三难度摘要</h2><span class="muted">3BV ≥ ' + floorLabel() + '</span></div>' +
      '<table class="data-table summary-table">' +
      '<thead><tr><th>难度</th><th class="num">局数</th><th class="num">PB</th><th class="num">3BV</th><th class="num">PB 3BVS</th><th class="num">Top5 均速</th><th class="num">NF 占比</th><th class="num">近 30 天</th></tr></thead>' +
      `<tbody>${summaryRows}</tbody>` +
      '</table>' +
      '</div>' +

      '<div class="card">' +
      '<div class="card-head"><h2 class="card-title">GC 指标</h2><span class="muted">ASB / 战力 / 典型时</span></div>' +
      '<table class="data-table">' +
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
          return `<span class="cal-cell"${style} title="${formatShortDate(cell.start)} · ${cell.count} 局"></span>`
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
      `<div class="cal-stat"><span>最活跃日</span><b>${calendar.best ? `${formatShortDate(calendar.best.start)} · ${calendar.best.count} 局` : '—'}</b></div>` +
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

  function rankTableHtml(rows: AnalysisGame[], limit: number): string {
    const dates = rows.map((game) => game.date)
    const body = rows
      .slice(0, limit)
      .map((game, index) => {
        const mov = game.path > 0 ? (game.path / 16 / game.time).toFixed(1) : '—'
        const path = game.path > 0 ? String(Math.round(game.path / 16)) : '—'
        const opIs =
          game.video.op === null || game.video.isl === null
            ? '—'
            : `${game.op}op ${game.isl}is`
        return (
          `<tr${rowClass(index)}>` +
          `<td class="rank">${index + 1}</td>` +
          `<td class="date">${opIs}</td>` +
          `<td class="num">${game.bv}</td>` +
          `<td class="num">${game.hasCe ? game.ce : '—'}</td>` +
          `<td class="num">${game.hasRight ? `${game.right}${game.nf ? '<span class="nf-tag">NF</span>' : ''}` : '—'}</td>` +
          `<td class="num"${colorAttr(game.level, 'time', game.time)}>${videoLink(game, formatTime(game.time), 'pb-link')}</td>` +
          `<td class="num"${colorAttr(game.level, 'bvs', game.bvs)}>${game.bvs.toFixed(3)}</td>` +
          `<td class="num"${game.hasCe ? colorAttr(game.level, 'bvs', game.ce / game.time) : ''}>${game.hasCe ? (game.ce / game.time).toFixed(2) : '—'}</td>` +
          `<td class="num"${game.hasCl ? colorAttr(game.level, 'bvs', game.cl / game.time) : ''}>${game.hasCl ? (game.cl / game.time).toFixed(2) : '—'}</td>` +
          `<td class="num"${colorAttr(game.level, 'stnb', game.stnb)}>${game.stnb.toFixed(1)}</td>` +
          `<td class="num">${mov}</td>` +
          `<td class="num">${path}</td>` +
          `<td class="date"${dateAttr(game.date, dates)}>${formatShortDate(game.date)}</td>` +
          '</tr>'
        )
      })
      .join('')

    return (
      '<div class="table-scroll">' +
      '<table class="data-table rank-table">' +
      '<thead><tr><th class="num">名次</th><th>op/is</th><th class="num">3BV</th><th class="num">有效点击</th><th class="num">右键</th><th class="num">用时</th><th class="num">3BVS</th><th class="num">有效/秒</th><th class="num">点击/秒</th><th class="num">STNB</th><th class="num">移速</th><th class="num">路径</th><th>日期</th></tr></thead>' +
      `<tbody>${body || '<tr><td colspan="13" class="muted">没有符合条件的成绩</td></tr>'}</tbody>` +
      '</table>' +
      '</div>'
    )
  }

  function rankHtml(): string {
    const triple = state.rankLayout === 'triple'
    const viewTabs =
      '<div class="tabs">' +
      LEVELS.map(
        (level) =>
          `<button type="button" class="tab${!triple && state.rankLevel === level ? ' active' : ''}" data-rank-view="${level}">${LEVEL_LABELS[level]}</button>`,
      ).join('') +
      `<button type="button" class="tab${triple ? ' active' : ''}" data-rank-view="triple">三难度</button>` +
      '</div>'
    const statTabs =
      '<div class="tabs">' +
      (['time', 'bvs', 'stnb'] as RankStat[])
        .map(
          (stat) =>
            `<button type="button" class="tab${state.rankStat === stat ? ' active' : ''}" data-rank-stat="${stat}">${STAT_LABELS[stat]}</button>`,
        )
        .join('') +
      '</div>'

    const blocks = triple
      ? LEVELS.map((level) => {
          const rows = rankGames(games, state.rankStat, level)
          return (
            '<div class="level-block">' +
            `<div class="level-head"><span class="lv"><i></i>${LEVEL_LABELS[level]}</span><span>${formatCount(rows.length)} 局 · 前 10</span></div>` +
            rankTableHtml(rows, 10) +
            '</div>'
          )
        }).join('')
      : rankTableHtml(
          rankGames(games, state.rankStat, state.rankLevel),
          settings.rankLimit,
        )

    // 未限制 NF 的榜单不加「普通 / 全部」范围标注；只在真的筛了 NF 时说明「仅 NF」。
    const scope = state.nfOnly ? '仅 NF' : ''
    const subtitle = triple
      ? `三难度纵向 · 各前 10${scope ? ` · ${scope}` : ''}`
      : scope
    const subtitleHtml = subtitle ? `<span class="muted">${subtitle}</span>` : ''
    const title = triple
      ? `${STAT_LABELS[state.rankStat]} · 三难度`
      : `${STAT_LABELS[state.rankStat]} Top ${settings.rankLimit} · ${LEVEL_LABELS[state.rankLevel]}`

    return (
      '<div class="toolbar">' +
      statTabs +
      viewTabs +
      '<span class="spacer"></span>' +
      `<span class="note">3BV ≥ ${floorLabel()} · 右键 = 0 记 NF</span>` +
      '</div>' +
      '<div class="card">' +
      `<div class="card-head"><h2 class="card-title">${title}</h2>${subtitleHtml}</div>` +
      blocks +
      '</div>'
    )
  }

  function trendHtml(bounds: DateRange): string {
    const weeks = weekStats(
      games,
      10,
      now,
      true,
      settings.t37Slots,
      settings.t37Pads,
      settings.pppConsts,
    ).filter((week) => week.count > 0)
    const allMonths = monthStats(games, state.trendLevel, rangeGames)
    const months = state.hideEmptyMonths ? allMonths.filter((month) => month.count > 0) : allMonths
    // 保留本次渲染的统计结果：复制按钮按周期标识回查，预览取第一条可复制记录。
    trendMonths = allMonths
    trendMonthLevel = state.trendLevel
    for (const level of LEVELS) trendYears[level] = yearStats(games, level, rangeGames)
    trendWeekCopies.clear()
    const weekRows = weekCopyEntries(weeks)
      .map(({ week, delta }) => {
        trendWeekCopies.set(week.start, weekCopyText(week, {
          delta,
          software: csvMode ? 'all' : state.software,
          nfOnly: state.nfOnly,
          range: bounds,
        }))
        const levelBlock = (level: Level): string => {
          const data = week.levels[level]
          const prefix = level
          const rows = data.slots
            .map(
              (slot, index) =>
                '<tr>' +
                `<td class="num">${index + 1}</td>` +
                `<td class="num"${colorAttr(level, 'time', slot.time)}>${slot.time.toFixed(3)}</td>` +
                `<td class="num"${colorAttr(level, 'bvs', slot.bvs)}>${slot.bvs.toFixed(3)}</td>` +
                `<td class="num"${colorAttr(level, 'stnb', slot.stnb)}>${slot.stnb.toFixed(2)}</td>` +
                '</tr>',
            )
            .join('')
          return (
            '<div class="week-level-block">' +
            `<div class="week-level-head">${LEVEL_LABELS[level]} · ${data.slot} 条</div>` +
            '<table class="data-table week-slot-table">' +
            `<thead><tr><th class="num">排名</th><th class="num">${prefix}t</th><th class="num">${prefix}b</th><th class="num">${prefix}s</th></tr></thead>` +
            `<tbody>${rows}` +
            `<tr class="week-total"><td>总计</td><td class="num">${data.totals.time.toFixed(3)}</td><td class="num">${data.totals.bvs.toFixed(3)}</td><td class="num">${data.totals.stnb.toFixed(2)}</td></tr>` +
            `<tr class="week-average"><td>平均</td><td class="num"${colorAttr(level, 'time', data.averages.time)}>${data.averages.time.toFixed(3)}</td><td class="num"${colorAttr(level, 'bvs', data.averages.bvs)}>${data.averages.bvs.toFixed(3)}</td><td class="num"${colorAttr(level, 'stnb', data.averages.stnb)}>${data.averages.stnb.toFixed(2)}</td></tr>` +
            '</tbody></table></div>'
          )
        }
        const detail =
          '<tr class="week-detail hidden"><td colspan="8"><div class="week-level-grid">' +
          `<div class="week-level-column">${levelBlock('b')}</div>` +
          `<div class="week-level-column">${levelBlock('i')}${levelBlock('e')}</div>` +
          '</div>' +
          '<div class="week-summary">' +
          `<span>T.37 <b>${week.t37.toFixed(2)}</b></span>` +
          `<span>B.37 <b>${week.b37.toFixed(3)}</b></span>` +
          `<span>S.37 <b>${week.s37.toFixed(1)}</b></span>` +
          `<span>BPP${week.levels.b.slot} <b>${week.levels.b.ppp.toFixed(2)}</b></span>` +
          `<span>IPP${week.levels.i.slot} <b>${week.levels.i.ppp.toFixed(2)}</b></span>` +
          `<span>EPP${week.levels.e.slot} <b>${week.levels.e.ppp.toFixed(2)}</b></span>` +
          `<span>PPP37 <b>${week.ppp.toFixed(2)}</b></span>` +
          '</div></td></tr>'
        return (
          '<tr class="week-row" data-week-row="1">' +
          `<td class="date"><span class="week-arrow">▸</span>${formatShortDate(week.start)}</td>` +
          `<td class="num">${week.count}</td>` +
          `<td class="num">${week.t37.toFixed(1)}</td>` +
          `<td class="num">${week.b37.toFixed(1)}</td>` +
          `<td class="num">${week.s37.toFixed(1)}</td>` +
          `<td class="num">${week.ppp.toFixed(3)}</td>` +
          `<td class="num ${weekDeltaClass(delta)}">${formatWeekDelta(delta)}</td>` +
          weekCopyCell(week.start) +
          '</tr>' +
          detail
        )
      })
      .join('')

    const monthRows = months
      .map((month) => {
        const copyCell = trendCopyCell('month', month.key, state.trendLevel, month.count === 0)
        if (month.count === 0) {
          return (
            '<tr>' +
            `<td class="date">${month.key}</td>` +
            `<td class="num">${month.days}</td>` +
            '<td class="num">0</td>' +
            '<td class="num" colspan="17" style="text-align:left">—</td>' +
            copyCell +
            '</tr>'
          )
        }
        const statsCells = month.hasScores
          ? `<td class="num">${month.gamesPerDay.toFixed(1)}</td>` +
            `<td class="num"${colorAttr(state.trendLevel, 'time', month.avgTime)}>${formatTime(month.avgTime)}</td>` +
            `<td class="num">${formatTime(month.medianTime)}</td>` +
            `<td class="num">${month.avgBv.toFixed(1)}</td>` +
            `<td class="num"${colorAttr(state.trendLevel, 'bvs', month.avgBvs)}>${month.avgBvs.toFixed(3)}</td>` +
            `<td class="num"${colorAttr(state.trendLevel, 'stnb', month.avgStnb)}>${month.avgStnb.toFixed(1)}</td>` +
            `<td class="num">${month.hasOp ? month.avgOp.toFixed(1) : '—'}</td>` +
            `<td class="num">${month.hasIs ? month.avgIs.toFixed(1) : '—'}</td>` +
            `<td class="num"${month.hasCl ? colorAttr(state.trendLevel, 'bvs', month.avgCls) : ''}>${month.hasCl ? month.avgCls.toFixed(2) : '—'}</td>` +
            `<td class="num"${month.hasCe ? colorAttr(state.trendLevel, 'bvs', month.avgCes) : ''}>${month.hasCe ? month.avgCes.toFixed(2) : '—'}</td>` +
            `<td class="num"${month.hasCl && month.hasCe ? numColorAttr(month.avgCorr, 1 / 6) : ''}>${month.hasCl && month.hasCe ? month.avgCorr.toFixed(2) : '—'}</td>` +
            `<td class="num"${month.hasCe ? numColorAttr(month.avgThrp, 1 / 6) : ''}>${month.hasCe ? month.avgThrp.toFixed(2) : '—'}</td>` +
            `<td class="num">${month.hasPath ? Math.round(month.avgPath) : '—'}</td>` +
            `<td class="num">${month.hasPath ? month.avgMov.toFixed(1) : '—'}</td>` +
            `<td class="num">${month.breakRate === 0 ? '—' : month.breakRate}</td>` +
            `<td class="num">${month.headScore}</td>` +
            `<td class="num">${month.pbCount}</td>`
          : '<td class="num" colspan="17">—</td>'

        const tierBlock = (title: string, limits: number[], shares: number[]): string =>
          '<div class="month-tier-block">' +
          `<h4>${title}</h4><div class="month-tier-chips">` +
          limits
            .map(
              (limit, index) =>
                `<span class="month-tier-chip"><b>${limit}</b><em>${month.hasScores ? `${(shares[index]! * 100).toFixed(1)}%` : '—'}</em></span>`,
            )
            .join('') +
          '</div></div>'

        const detail =
          '<tr class="month-detail hidden"><td colspan="21">' +
          (month.hasScores
            ? '<div class="month-tier-grid">' +
              tierBlock('用时分档', MONTH_TIME_TIERS[state.trendLevel], month.timeTierShare) +
              tierBlock('3BVS 分档', MONTH_BVS_TIERS[state.trendLevel], month.bvsTierShare) +
              '</div>'
            : '<p class="muted">当月只有低于 3BV 下限的录像，没有有效成绩。</p>') +
          '</td></tr>'

        return (
          '<tr class="month-row" data-month-row="1">' +
          `<td class="date"><span class="month-arrow">▸</span>${month.key}</td>` +
          `<td class="num">${month.days}</td>` +
          `<td class="num">${month.count}</td>` +
          statsCells +
          copyCell +
          '</tr>' +
          detail
        )
      })
      .join('')

    const yearTables = LEVELS.map((level) => {
      const years = trendYears[level]
      const rows = years
        .map((year) => {
          const stats = year.hasScores
            ? `<td class="num"${colorAttr(level, 'time', year.avgTime)}>${year.avgTime.toFixed(3)}</td>` +
              `<td class="num">${year.avgBv.toFixed(1)}</td>` +
              `<td class="num"${colorAttr(level, 'bvs', year.avgBvs)}>${year.avgBvs.toFixed(3)}</td>` +
              `<td class="num"${colorAttr(level, 'stnb', year.avgStnb)}>${year.avgStnb.toFixed(1)}</td>` +
              `<td class="num"${year.hasCl ? colorAttr(level, 'bvs', year.avgCls) : ''}>${year.hasCl ? year.avgCls.toFixed(2) : '—'}</td>` +
              `<td class="num"${year.hasCe ? colorAttr(level, 'bvs', year.avgCes) : ''}>${year.hasCe ? year.avgCes.toFixed(2) : '—'}</td>` +
              `<td class="num">${year.hasPath ? year.avgMov.toFixed(1) : '—'}</td>` +
              `<td class="num">${year.pbCount}</td>`
            : '<td class="num" colspan="8">—</td>'
          return (
            '<tr>' +
            `<td class="date">${year.year}</td>` +
            `<td class="num">${year.count}</td>` +
            stats +
            trendCopyCell('year', year.year, level) +
            '</tr>'
          )
        })
        .join('')
      return (
        '<div class="card year-block">' +
        '<div class="card-head">' +
        `<h3 class="card-title">年汇总 · ${LEVEL_LABELS[level]}</h3>` +
        '<div class="month-tools">' +
        '<span class="muted">按年份聚合</span>' +
        `<button type="button" class="button" data-copy-panel="year" aria-expanded="${state.yearCopyOpen[level]}" aria-controls="year-copy-settings-${level}">复制设置</button>` +
        '</div></div>' +
        copySettingsHtml('year', level) +
        '<table class="data-table year-table">' +
        '<thead><tr><th>年份</th><th class="num">局数</th><th class="num">平均用时</th><th class="num">平均 3BV</th><th class="num">平均 3BVS</th><th class="num">平均 STNB</th><th class="num">cl/s</th><th class="num">ce/s</th><th class="num">移速</th><th class="num">新 PB</th><th class="copy-cell"></th></tr></thead>' +
        `<tbody>${rows || '<tr><td colspan="11" class="muted">没有数据</td></tr>'}</tbody>` +
        '</table></div>'
      )
    }).join('')

    const levelTabs =
      '<div class="tabs">' +
      LEVELS.map(
        (level) =>
          `<button type="button" class="tab${state.trendLevel === level ? ' active' : ''}" data-trend-level="${level}">${LEVEL_LABELS[level]}</button>`,
      ).join('') +
      '</div>'
    const monthTools =
      '<div class="month-tools">' +
      `<label class="check"><input type="checkbox" id="analysis-hide-empty"${state.hideEmptyMonths ? ' checked' : ''}> 隐藏无数据月份</label>` +
      levelTabs +
      `<button type="button" class="button" data-copy-panel="month" aria-expanded="${state.monthCopyOpen}" aria-controls="month-copy-settings">复制设置</button>` +
      '</div>'

    return (
      '<div class="card">' +
      '<div class="card-head"><h2 class="card-title">周 T37</h2><span class="muted">按参数槽位取用时 / 3BVS / STNB · T37 越小越好 · 点周行展开三级明细</span></div>' +
      '<div class="table-scroll">' +
      '<table class="data-table week-table">' +
      '<thead><tr><th>周起始</th><th class="num">局数</th><th class="num">T37</th><th class="num">B37</th><th class="num">S37</th><th class="num">ppp</th><th class="num">ΔT37</th><th class="copy-cell"></th></tr></thead>' +
      `<tbody>${weekRows || '<tr><td colspan="8" class="muted">没有数据</td></tr>'}</tbody>` +
      '</table>' +
      '</div>' +
      '</div>' +

      '<div class="card">' +
      `<div class="card-head"><h2 class="card-title">月均明细 · ${LEVEL_LABELS[state.trendLevel]}</h2>${monthTools}</div>` +
      copySettingsHtml('month') +
      '<div class="table-scroll">' +
      '<table class="data-table month-table">' +
      '<thead><tr>' +
      '<th rowspan="2">月份</th><th rowspan="2" class="num">活跃天数</th><th rowspan="2" class="num">局数</th><th rowspan="2" class="num">日均</th>' +
      '<th colspan="5" class="group">平均</th>' +
      '<th colspan="2" class="group">每局</th>' +
      '<th colspan="2" class="group">点击效率</th>' +
      '<th colspan="2" class="group">转化</th>' +
      '<th colspan="2" class="group">路径</th>' +
      '<th colspan="3" class="group">头部</th>' +
      '<th class="copy-cell"></th>' +
      '</tr><tr>' +
      '<th class="num">用时</th><th class="num">中位</th><th class="num">3BV</th><th class="num">3BVS</th><th class="num">STNB</th>' +
      '<th class="num">op</th><th class="num">is</th>' +
      '<th class="num">cl/s</th><th class="num">ce/s</th>' +
      '<th class="num">corr</th><th class="num">thrp</th>' +
      '<th class="num">格</th><th class="num">移速</th>' +
      '<th class="num">1/破率</th><th class="num">头部</th><th class="num">新 PB</th>' +
      '<th class="copy-cell"></th>' +
      '</tr></thead>' +
      `<tbody>${monthRows || '<tr><td colspan="21" class="muted">没有数据</td></tr>'}</tbody>` +
      '</table>' +
      '</div>' +
      '</div>' +

      '<div class="year-stack">' +
      yearTables +
      '</div>'
    )
  }

  function periodHtml(): string {
    const groups = periodGroups(games, state.periodLevel, state.periodMode, rangeGames)
    if (groups.length === 0) {
      return '<div class="card"><div class="card-body"><p class="muted">这个难度还没有数据</p></div></div>'
    }
    const selected = groups.find((group) => group.key === state.periodKey) ?? groups[0]!
    const limit = state.periodMode === 'month' ? settings.monthTop : settings.yearTop
    const rows = rankGames(selected.rows, state.periodStat).slice(0, limit)
    const dates = rows.map((game) => game.date)

    const modeTabs =
      '<div class="tabs">' +
      ([
        ['month', '月 Top'],
        ['year', '年 Top'],
      ] as Array<[PeriodMode, string]>)
        .map(
          ([mode, label]) =>
            `<button type="button" class="tab${state.periodMode === mode ? ' active' : ''}" data-period-mode="${mode}">${label}</button>`,
        )
        .join('') +
      '</div>'
    const levelTabs =
      '<div class="tabs">' +
      LEVELS.map(
        (level) =>
          `<button type="button" class="tab${state.periodLevel === level ? ' active' : ''}" data-period-level="${level}">${LEVEL_LABELS[level]}</button>`,
      ).join('') +
      '</div>'
    const statTabs =
      '<div class="tabs">' +
      (['time', 'bvs', 'stnb'] as RankStat[])
        .map(
          (stat) =>
            `<button type="button" class="tab${state.periodStat === stat ? ' active' : ''}" data-period-stat="${stat}">${STAT_LABELS[stat]}</button>`,
        )
        .join('') +
      '</div>'
    const select =
      `<select class="select" id="period-select">` +
      groups
        .map(
          (group) =>
            `<option value="${group.key}"${group.key === selected.key ? ' selected' : ''}>${group.key}</option>`,
        )
        .join('') +
      '</select>'

    const body = rows
      .map((game, index) => {
        return (
          `<tr${rowClass(index)}>` +
          `<td class="rank">${index + 1}</td>` +
          `<td class="num">${game.bv}</td>` +
          `<td class="num"${colorAttr(state.periodLevel, 'time', game.time)}>${videoLink(game, formatTime(game.time), 'pb-link')}</td>` +
          `<td class="num"${colorAttr(state.periodLevel, 'bvs', game.bvs)}>${game.bvs.toFixed(3)}</td>` +
          `<td class="num"${colorAttr(state.periodLevel, 'stnb', game.stnb)}>${game.stnb.toFixed(1)}</td>` +
          `<td class="num">${game.hasCe ? game.ce : '—'}</td>` +
          `<td class="num">${game.hasCl ? (game.cl / game.time).toFixed(2) : '—'}</td>` +
          `<td class="date"${dateAttr(game.date, dates)}>${formatShortDate(game.date)}</td>` +
          '</tr>'
        )
      })
      .join('')

    return (
      '<div class="toolbar">' +
      modeTabs +
      levelTabs +
      statTabs +
      select +
      `<span class="note">每期前 ${limit} · ${LEVEL_LABELS[state.periodLevel]}</span>` +
      '</div>' +
      '<div class="card">' +
      `<div class="card-head"><h2 class="card-title">${state.periodMode === 'month' ? '月' : '年'} Top · ${selected.key}</h2><span class="muted">${STAT_LABELS[state.periodStat]} 排序 · ${formatCount(selected.count)} 局（含低于下限的局）</span></div>` +
      '<table class="data-table rank-table">' +
      '<thead><tr><th class="num">名次</th><th class="num">3BV</th><th class="num">用时</th><th class="num">3BVS</th><th class="num">STNB</th><th class="num">有效点击</th><th class="num">点击/秒</th><th>日期</th></tr></thead>' +
      `<tbody>${body || '<tr><td colspan="8" class="muted">没有数据</td></tr>'}</tbody>` +
      '</table>' +
      '</div>'
    )
  }

  function distHtml(): string {
    const buckets = bucketStats(games, state.distLevel)
    const subs = subStats(games, state.distLevel, settings.subTiers)
    const ranges = rangeStats(rangeGames, state.distLevel)

    const levelTabs =
      '<div class="tabs">' +
      LEVELS.map(
        (level) =>
          `<button type="button" class="tab${state.distLevel === level ? ' active' : ''}" data-dist-level="${level}">${LEVEL_LABELS[level]}</button>`,
      ).join('') +
      '</div>'

    const bucketRows = buckets
      .map(
        (bucket) =>
          '<tr>' +
          `<td class="num">${bucket.start}–${bucket.end}</td>` +
          `<td class="num">${bucket.count}</td>` +
          `<td class="num">${(bucket.share * 100).toFixed(1)}%</td>` +
          `<td class="num"${colorAttr(state.distLevel, 'time', bucket.avgTime)}>${bucket.avgTime.toFixed(3)}</td>` +
          `<td class="num"${colorAttr(state.distLevel, 'bvs', bucket.avgBvs)}>${bucket.avgBvs.toFixed(3)}</td>` +
          `<td class="num"${colorAttr(state.distLevel, 'stnb', bucket.avgStnb)}>${bucket.avgStnb.toFixed(1)}</td>` +
          `<td class="num"${colorAttr(state.distLevel, 'time', bucket.best.time)}>${videoLink(bucket.best, bucket.best.time.toFixed(3), 'pb-link')}</td>` +
          '</tr>',
      )
      .join('')

    const subRows = subs
      .map((tier) => {
        const limit = Number.isInteger(tier.limit) ? String(tier.limit) : tier.limit.toFixed(1)
        return (
          '<tr>' +
          `<td class="num">${limit}s</td>` +
          `<td class="num">${tier.count}</td>` +
          `<td class="num">${(tier.share * 100).toFixed(2)}%</td>` +
          `<td class="num">${Number.isFinite(tier.every) ? `1 / ${Math.round(tier.every)}` : '—'}</td>` +
          `<td class="tier">${tier.label}</td>` +
          '</tr>'
        )
      })
      .join('')

    const rangeRows = ranges
      .map(
        (range) =>
          '<tr>' +
          `<td class="num">${range.start}–${range.end}</td>` +
          `<td class="num">${range.count}</td>` +
          `<td class="num">${(range.share * 100).toFixed(1)}%</td>` +
          `<td class="num">${range.theoryShare === null ? '—' : `${(range.theoryShare * 100).toFixed(1)}%`}</td>` +
          `<td class="num"${range.count ? colorAttr(state.distLevel, 'time', range.avgTime) : ''}>${range.count ? range.avgTime.toFixed(3) : '—'}</td>` +
          `<td class="num"${range.count ? colorAttr(state.distLevel, 'bvs', range.avgBvs) : ''}>${range.count ? range.avgBvs.toFixed(3) : '—'}</td>` +
          `<td class="num"${range.count ? colorAttr(state.distLevel, 'stnb', range.avgStnb) : ''}>${range.count ? range.avgStnb.toFixed(1) : '—'}</td>` +
          '</tr>',
      )
      .join('')

    return (
      '<div class="toolbar">' +
      levelTabs +
      `<span class="note">分析口径 3BV ≥ ${floorLabel()} · rAvg 含初级 2–9</span>` +
      '</div>' +
      '<div class="dist-grid">' +
      '<div class="card">' +
      '<div class="card-head"><h2 class="card-title">3BV 分档</h2><span class="muted">局数 / 平均 / 该档最好</span></div>' +
      '<table class="data-table">' +
      '<thead><tr><th class="num">区间</th><th class="num">局数</th><th class="num">占比</th><th class="num">平均用时</th><th class="num">平均 3BVS</th><th class="num">平均 STNB</th><th class="num">最好</th></tr></thead>' +
      `<tbody>${bucketRows || '<tr><td colspan="7" class="muted">没有数据</td></tr>'}</tbody>` +
      '</table>' +
      '</div>' +
      '<div class="card">' +
      '<div class="card-head"><h2 class="card-title">Sub 率</h2><span class="muted">用时 &lt; 档位 · 累计</span></div>' +
      '<table class="data-table ladder-table">' +
      '<thead><tr><th class="num">用时</th><th class="num">局数</th><th class="num">占比</th><th class="num">频率</th><th>话术</th></tr></thead>' +
      `<tbody>${subRows || '<tr><td colspan="5" class="muted">没有数据</td></tr>'}</tbody>` +
      '</table>' +
      '</div>' +
      '</div>' +
      '<div class="card">' +
      '<div class="card-head"><h2 class="card-title">3BV 区间（rAvg）</h2><span class="muted">局数 / 实际占比 / 理论占比 / 平均</span></div>' +
      '<table class="data-table">' +
      '<thead><tr><th class="num">区间</th><th class="num">局数</th><th class="num">实际</th><th class="num">理论</th><th class="num">平均用时</th><th class="num">平均 3BVS</th><th class="num">平均 STNB</th></tr></thead>' +
      `<tbody>${rangeRows || '<tr><td colspan="7" class="muted">没有数据</td></tr>'}</tbody>` +
      '</table>' +
      '</div>'
    )
  }

  function effHtml(): string {
    const cards: Array<[EfficiencyMetric, string, string, (value: number) => string]> = [
      ['cls', '点击 / 秒', 'cl/s', (value) => value.toFixed(2)],
      ['ces', '有效 / 秒', 'ce/s', (value) => value.toFixed(2)],
      ['mov', '移速', '格/秒', (value) => value.toFixed(1)],
      ['ioe', 'IOE', 'bv/cl', (value) => value.toFixed(3)],
    ]

    const levelTabs =
      '<div class="tabs">' +
      LEVELS.map(
        (level) =>
          `<button type="button" class="tab${state.effLevel === level ? ' active' : ''}" data-eff-level="${level}">${LEVEL_LABELS[level]}</button>`,
      ).join('') +
      '</div>'

    const body = cards
      .map(([metric, label, unit, format]) => {
        const rows = efficiencyTop(games, state.effLevel, metric, settings.smallTop)
        const dates = rows.map((row) => row.game.date)
        const tableRows = rows
          .map((row, index) => {
            const color =
              metric === 'cls' || metric === 'ces'
                ? colorAttr(state.effLevel, 'bvs', row.value)
                : ''
            return (
              '<tr>' +
              `<td class="num">${index + 1}</td>` +
              `<td class="num metric"${color}>${format(row.value)}</td>` +
              `<td class="num">${row.game.bv}</td>` +
              `<td class="num">${row.game.time.toFixed(3)}</td>` +
              `<td class="num">${row.game.stnb.toFixed(1)}</td>` +
              `<td class="date"${dateAttr(row.game.date, dates)}>${formatShortDate(row.game.date)}</td>` +
              '</tr>'
            )
          })
          .join('')
        return (
          '<div class="card">' +
          `<div class="card-head"><h2 class="card-title">${label}</h2><span class="muted">${unit}</span></div>` +
          '<table class="data-table eff-table">' +
          '<thead><tr><th class="num">#</th><th class="num">值</th><th class="num">3BV</th><th class="num">用时</th><th class="num">STNB</th><th>日期</th></tr></thead>' +
          `<tbody>${tableRows || '<tr><td colspan="6" class="muted">没有数据</td></tr>'}</tbody>` +
          '</table>' +
          '</div>'
        )
      })
      .join('')

    const othCards: Array<[OthMetric, string, string, (value: number) => string]> = [
      ['invCe', '最少有效点击', '次', (value) => String(Math.round(value))],
      ['ce', '最多有效点击', '次', (value) => String(Math.round(value))],
      ['invPath', '最小路径', '1/16 格', (value) => String(Math.round(value))],
      ['invIs', '最少岛屿', '', (value) => String(Math.round(value))],
      ['invOp', '最少开空', '', (value) => String(Math.round(value))],
      ['is', '最多岛屿', '', (value) => String(Math.round(value))],
      ['op', '最多开空', '', (value) => String(Math.round(value))],
    ]

    const othBody = othCards
      .map(([metric, label, unit, format]) => {
        const rows = othTop(games, state.effLevel, metric, settings.smallTop)
        const dates = rows.map((row) => row.game.date)
        const tableRows = rows
          .map(
            (row, index) =>
              '<tr>' +
              `<td class="num">${index + 1}</td>` +
              `<td class="num metric">${format(row.value)}</td>` +
              `<td class="num">${row.game.bv}</td>` +
              `<td class="num">${row.game.time.toFixed(3)}</td>` +
              `<td class="date"${dateAttr(row.game.date, dates)}>${formatShortDate(row.game.date)}</td>` +
              '</tr>',
          )
          .join('')
        return (
          '<div class="card">' +
          `<div class="card-head"><h2 class="card-title">${label}</h2><span class="muted">${unit}</span></div>` +
          '<table class="data-table eff-table">' +
          '<thead><tr><th class="num">#</th><th class="num">值</th><th class="num">3BV</th><th class="num">用时</th><th>日期</th></tr></thead>' +
          `<tbody>${tableRows || '<tr><td colspan="5" class="muted">没有数据</td></tr>'}</tbody>` +
          '</table>' +
          '</div>'
        )
      })
      .join('')

    return (
      '<div class="toolbar">' +
      levelTabs +
      `<span class="note">每项前 ${settings.smallTop} · ${LEVEL_LABELS[state.effLevel]}</span>` +
      '</div>' +
      `<div class="eff-grid">${body}</div>` +
      '<h3 class="section-title">杂项 7 项</h3>' +
      `<div class="oth-grid">${othBody}</div>`
    )
  }

  function mapHtml(): string {
    const level = state.mapLevel
    const map = heatmapStats(games, level)
    const points = frontier(games, level)
    const W = 760
    const H = 400
    const padL = 48
    const padB = 34
    const padT = 10
    const padR = 10
    const cellW = (W - padL - padR) / map.cols
    const cellH = (H - padT - padB) / map.rows
    const coefficient = STNB_COEFFICIENT[level]
    const minBv = settings.bvFloors[level]
    const maxBv = level === 'e' ? 278 : 134

    let cells = ''
    for (let row = 0; row < map.rows; row += 1) {
      for (let col = 0; col < map.cols; col += 1) {
        const count = map.cells[row]?.[col] ?? 0
        const time = ((col + 0.5) / map.cols) * map.maxTime
        const bvs = (1 - (row + 0.5) / map.rows) * map.maxBvs
        let fill = 'transparent'
        if (count > 0) {
          fill = 'var(--surface)'
        } else {
          const bv = time * bvs
          if (bv >= minBv && bv <= maxBv) {
            const stnb = (coefficient * bv) / time ** 1.7
            fill = pbColorStyle(level, 'stnb', stnb)?.backgroundColor ?? 'transparent'
          }
        }
        const x = padL + col * cellW
        const y = padT + row * cellH
        cells +=
          `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(cellW - 0.5).toFixed(1)}" height="${(cellH - 0.5).toFixed(1)}" fill="${fill}" stroke="var(--border)" stroke-width="0.4"/>`
        if (count > 0) {
          cells += `<text x="${(x + cellW / 2).toFixed(1)}" y="${(y + cellH / 2 + 2.5).toFixed(1)}" text-anchor="middle" fill="var(--muted)" font-size="7">${count}</text>`
        }
      }
    }

    const polyline = points
      .filter((point) => point.time <= map.maxTime && point.bvs <= map.maxBvs)
      .map((point) => {
        const x = padL + (point.time / map.maxTime) * (W - padL - padR)
        const y = padT + (1 - point.bvs / map.maxBvs) * (H - padT - padB)
        return `${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(' ')

    let axes = ''
    for (let index = 0; index <= 6; index += 1) {
      const x = padL + (index / 6) * (W - padL - padR)
      const value = (index / 6) * map.maxTime
      axes += `<text x="${x.toFixed(1)}" y="${H - 10}" text-anchor="middle" fill="var(--muted)" font-size="10">${Math.round(value)}</text>`
    }
    for (let index = 0; index <= 5; index += 1) {
      const y = padT + (1 - index / 5) * (H - padT - padB)
      const value = (index / 5) * map.maxBvs
      axes += `<text x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" fill="var(--muted)" font-size="10">${value.toFixed(1)}</text>`
    }
    axes += `<text x="${W / 2}" y="${H - 0.5}" text-anchor="middle" fill="var(--muted)" font-size="10">时间（秒）</text>`
    axes += `<text x="12" y="${H / 2}" text-anchor="middle" fill="var(--muted)" font-size="10" transform="rotate(-90 12 ${H / 2})">3BVS</text>`

    const dogTargets = parseDogTargets(
      level === 'e' ? settings.dogTargetsE : settings.dogTargetsI,
    )
    const dog = dogPredictions(games, dogTargets, level).slice(-4)
    const dogHeader = dog.map((item) => `<th class="num">${item.year}</th>`).join('')
    const dogPrefix = level === 'e' ? 'et' : level === 'i' ? 'it' : 'bt'
    const dogBody =
      dog.length === 0
        ? '<tr><td colspan="1" class="muted">暂无足够数据</td></tr>'
        : dogTargets
            .map((target) => {
              const cells = dog
                .map((item) => {
                  const cell = item.cells.find((entry) => entry.target === target)
                  return `<td class="num">${cell ? (cell.probability * 100).toFixed(2) : '—'}</td>`
                })
                .join('')
              return `<tr><td>${dogPrefix}&lt;${target}</td>${cells}</tr>`
            })
            .join('')
    const dogTable =
      '<table class="dog-table"><thead><tr><th>目标</th>' +
      dogHeader +
      '</tr></thead><tbody>' +
      dogBody +
      '</tbody></table>'

    const levelTabs =
      '<div class="tabs">' +
      (['e', 'i'] as Level[])
        .map(
          (item) =>
            `<button type="button" class="tab${level === item ? ' active' : ''}" data-map-level="${item}">${LEVEL_LABELS[item]}</button>`,
        )
        .join('') +
      '</div>'

    return (
      '<div class="toolbar">' +
      levelTabs +
      '<span class="note">空格 = 按理论 STNB 回填 · 数字 = 局数 · 折线 = 效率前沿</span>' +
      '</div>' +
      '<div class="map-grid">' +
      '<div class="card">' +
      `<div class="card-head"><h2 class="card-title">狗图 · ${LEVEL_LABELS[level]}</h2><span class="muted">时间 × 3BVS</span></div>` +
      `<svg class="map-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="时间与 3BVS 分布热图">${cells}${polyline ? `<polyline points="${polyline}" fill="none" stroke="var(--fg)" stroke-width="1.2" opacity="0.55"/>` : ''}${axes}</svg>` +
      '<div class="map-legend"><span>理论 STNB 低</span><span class="map-gradient"></span><span>高</span></div>' +
      '</div>' +
      '<div>' +
      '<div class="side-card"><h3>狗预测</h3><p>按年度达标概率外推（' +
      `${LEVEL_LABELS[level]}）</p>` +
      dogTable +
      '</div>' +
      `<div class="side-card"><h3>线</h3><p>当前效率边界 <b>#${points.length}</b></p>` +
      `<p>${points.length > 0 ? `最后一点 ${points[points.length - 1]!.time.toFixed(2)}s / ${points[points.length - 1]!.bvs.toFixed(2)}` : '暂无数据'}</p></div>` +
      '</div>' +
      '</div>'
    )
  }

  nav.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-nav]')
    if (!button) return
    const key = button.dataset.nav as NavKey
    if (key === state.nav) return
    // 页内面板随梁山分页签消失时丢弃草稿，顶部选项恢复为已应用的时段。
    if (state.rangeEditor?.owner === 'lsf') state.rangeEditor = null
    state.nav = key
    render()
  })

  viewHost.addEventListener('click', (event) => {
    const target = event.target as HTMLElement
    // 梁山分：展开明细、显示更多、图表定位都要在通用行展开之前处理。
    const lsfToggle = target.closest<HTMLElement>('[data-lsf-toggle]')
    if (lsfToggle) {
      toggleLsfDetail(lsfToggle.dataset.lsfToggle ?? '')
      return
    }
    const lsfMore = target.closest<HTMLElement>('[data-lsf-more]')
    if (lsfMore) {
      state.lsfLimit += LSF_LEDGER_STEP
      render()
      return
    }
    const lsfPoint = target.closest<HTMLElement>('[data-lsf-event]')
    if (lsfPoint) {
      focusLsfEvent(lsfPoint.dataset.lsfEvent ?? '')
      return
    }
    const lsfDay = target.closest<HTMLElement>('[data-lsf-day]')
    if (lsfDay) {
      focusLsfDay(Number(lsfDay.dataset.lsfDay))
      return
    }
    const copyPanel = target.closest<HTMLElement>('[data-copy-panel]')
    if (copyPanel) {
      toggleCopySettings(copyPanel)
      return
    }
    const copyReset = target.closest<HTMLElement>('[data-copy-reset]')
    if (copyReset) {
      const scope = copyReset.dataset.copyReset
      if (isCopySettingsScope(scope)) setCopyFields(scope, [])
      return
    }
    // 复制必须在周 / 月行展开之前处理，否则点击复制会顺带展开明细。
    const copyButton = target.closest<HTMLButtonElement>('button[data-copy-kind]')
    if (copyButton) {
      const text = copyButtonText(copyButton)
      if (text === null) return
      void copyText(text).then((ok) => copyFeedback(copyButton, ok))
      return
    }
    const weekRow = target.closest<HTMLElement>('[data-week-row]')
    if (weekRow) {
      const detail = weekRow.nextElementSibling
      if (detail?.classList.contains('week-detail')) {
        detail.classList.toggle('hidden')
        weekRow.classList.toggle('open')
        const arrow = weekRow.querySelector<HTMLElement>('.week-arrow')
        if (arrow) arrow.textContent = detail.classList.contains('hidden') ? '▸' : '▾'
      }
      return
    }
    const monthRow = target.closest<HTMLElement>('[data-month-row]')
    if (monthRow) {
      const detail = monthRow.nextElementSibling
      if (detail?.classList.contains('month-detail')) {
        detail.classList.toggle('hidden')
        monthRow.classList.toggle('open')
        const arrow = monthRow.querySelector<HTMLElement>('.month-arrow')
        if (arrow) arrow.textContent = detail.classList.contains('hidden') ? '▸' : '▾'
      }
      return
    }
    const stat = target.closest<HTMLElement>('[data-rank-stat]')
    if (stat) {
      state.rankStat = stat.dataset.rankStat as RankStat
      render()
      return
    }
    const view = target.closest<HTMLElement>('[data-rank-view]')
    if (view) {
      const value = view.dataset.rankView
      if (value === 'triple') {
        state.rankLayout = 'triple'
      } else {
        state.rankLayout = 'single'
        state.rankLevel = value as Level
      }
      render()
      return
    }
    const trendLevel = target.closest<HTMLElement>('[data-trend-level]')
    if (trendLevel) {
      state.trendLevel = trendLevel.dataset.trendLevel as Level
      render()
      return
    }
    const distLevel = target.closest<HTMLElement>('[data-dist-level]')
    if (distLevel) {
      state.distLevel = distLevel.dataset.distLevel as Level
      render()
      return
    }
    const periodMode = target.closest<HTMLElement>('[data-period-mode]')
    if (periodMode) {
      state.periodMode = periodMode.dataset.periodMode as PeriodMode
      state.periodKey = ''
      render()
      return
    }
    const periodLevel = target.closest<HTMLElement>('[data-period-level]')
    if (periodLevel) {
      state.periodLevel = periodLevel.dataset.periodLevel as Level
      state.periodKey = ''
      render()
      return
    }
    const periodStat = target.closest<HTMLElement>('[data-period-stat]')
    if (periodStat) {
      state.periodStat = periodStat.dataset.periodStat as RankStat
      render()
      return
    }
    const effLevel = target.closest<HTMLElement>('[data-eff-level]')
    if (effLevel) {
      state.effLevel = effLevel.dataset.effLevel as Level
      render()
      return
    }
    const mapLevel = target.closest<HTMLElement>('[data-map-level]')
    if (mapLevel) {
      state.mapLevel = mapLevel.dataset.mapLevel as Level
      render()
    }
  })

  // 阶梯图台阶点与统计卡上的定位按钮都不是原生 div：回车 / 空格与点击等价。
  viewHost.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    const point = (event.target as HTMLElement).closest<HTMLElement>('[data-lsf-event]')
    if (!point) return
    event.preventDefault()
    focusLsfEvent(point.dataset.lsfEvent ?? '')
  })

  // 自定义日期的「编辑 / 应用 / 取消」在顶部筛选条和梁山分卡片里共用；面板由自己所在容器确定入口。
  root.addEventListener('click', (event) => {
    const target = event.target as HTMLElement
    const edit = target.closest<HTMLElement>('[data-range-edit]')
    if (edit) {
      pickRange('custom', edit.getAttribute('data-range-edit') === 'lsf' ? 'lsf' : 'global')
      return
    }
    if (target.closest('[data-range-apply]')) {
      const panel = target.closest<HTMLElement>('[data-range-panel]')
      if (panel) applyCustomRange(panel)
      return
    }
    if (target.closest('[data-range-cancel]')) cancelCustomRange()
  })

  // 日期输入实时写入草稿，重绘时不会丢掉还没应用的编辑。
  root.addEventListener('input', (event) => {
    const input = (event.target as HTMLElement).closest<HTMLInputElement>('input[data-range-date]')
    if (input) syncRangeDraft(input)
  })

  root.addEventListener('change', (event) => {
    const select = (event.target as HTMLElement).closest<HTMLSelectElement>(
      'select[data-range-select]',
    )
    if (select) {
      const owner = select.getAttribute('data-range-select') === 'lsf' ? 'lsf' : 'global'
      pickRange(select.value as RangeKey, owner)
      return
    }
    const input = event.target as HTMLInputElement
    const copyField = input.dataset.copyField
    if (copyField) {
      const scope = input.dataset.copyScope
      if (!isCopySettingsScope(scope)) return
      const next = new Set<string>(
        scope === 'month' ? settings.monthCopyFields : settings.yearCopyFields,
      )
      if (input.checked) next.add(copyField)
      else next.delete(copyField)
      setCopyFields(scope, [...next])
      return
    }
    if (input.id === 'analysis-hide-empty') {
      state.hideEmptyMonths = input.checked
      render()
      return
    }
    if (input.id === 'period-select') {
      state.periodKey = input.value
      render()
      return
    }
    if (input.id === 'analysis-nf-global') {
      state.nfOnly = input.checked
      applyFilters()
      render()
    }
  })

  softwareSelect.addEventListener('change', () => {
    state.software = softwareSelect.value
    applyFilters()
    render()
  })

  function update(next: Video[], options: { csv?: boolean } = {}): void {
    videos = next
    csvMode = options.csv === true
    if (csvMode) {
      softwareSelect.value = 'all'
    } else {
      softwareSelect.value = state.software
    }
    softwareField.classList.toggle('hidden', csvMode)
    now = Date.now()
    ratingGames = analyzeGames(videos, {}, 1)
    // 换数据源 / 玩家：旧历史与展开定位状态一起作废。
    videosToken += 1
    lsfCache = null
    lsfEvents = []
    state.lsfExpanded.clear()
    state.lsfLimit = LSF_LEDGER_STEP
    state.lsfFocus = ''
    state.lsfFocusDay = null
    // 换数据源 / 玩家：未应用的自定义草稿与错误一并作废，已应用的时段保留。
    state.rangeEditor = null
    applyFilters()
    render()
  }

  applyFilters()
  render()

  async function loadSiteAnchors(force = false): Promise<boolean> {
    const request = ++anchorRequest
    try {
      const fetched = await fetchLsfAnchors(force)
      if (request !== anchorRequest) return false
      Object.assign(settings.anchors, fetched.anchors)
      settings.anchorMode = 'site'
      anchorError = fetched.stale
      refreshAnchorInputs()
      const hours = Math.max(1, Math.round((Date.now() - fetched.fetchedAt) / (60 * 60 * 1000)))
      anchorStatus.textContent = fetched.stale
        ? `站点请求失败，沿用 ${hours} 小时前的网站锚点`
        : '已读取网站锚点'
      saveAnalysisSettings(settings)
      render()
      return true
    } catch {
      if (request !== anchorRequest) return false
      anchorError = true
      anchorStatus.textContent =
        settings.anchorMode === 'site'
          ? '网站锚点刷新失败，继续用已保存的网站锚点'
          : '网站锚点读取失败，继续用大表锚点'
      render()
      return false
    }
  }

  if (options.autoSiteAnchors !== false && settings.anchorMode === 'site') {
    void loadSiteAnchors()
  }

  function destroy(): void {
    // 让晚到的锚点响应失效，避免销毁后的视图继续改设置或重绘。
    anchorRequest += 1
    videos = []
    games = []
    rangeGames = []
    ratingGames = []
    videosToken += 1
    lsfCache = null
    lsfEvents = []
    state.lsfExpanded.clear()
    state.lsfFocus = ''
    state.lsfFocusDay = null
    state.rangeEditor = null
    root.replaceChildren()
    root.remove()
  }

  return { root, update, destroy }
}
