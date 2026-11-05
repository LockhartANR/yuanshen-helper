import { SITE_ORIGIN } from '../../shared/constants'
import { formatCount, formatShortDate } from '../../shared/format'
import { el, escapeHtml } from '../../shared/ui'
import {
  activeDays,
  activityCalendar,
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
  weekStats,
  yearStats,
} from './analysis'
import { configureColors, dateColorStyle, medianOf, numColorStyle, pbColorStyle } from './colors'
import { parseDogTargets } from './analysis-settings'
import { startOfLocalDay } from './analysis-range'
import type { DateRange, RangeKey } from './analysis-range'
import type {
  AnalysisGame,
  EfficiencyMetric,
  MonthStat,
  OthMetric,
  PeriodMode,
  YearStat,
} from './analysis'
import type { LsfEvent } from './lsf-history'
import { LEVEL_LABELS, LEVELS, STNB_COEFFICIENT } from './model'
import type { Level, Video } from './model'
import { ratingSnapshot } from './ratings'
import {
  MONTH_COPY_FIELDS,
  MONTH_COPY_GROUPS,
  YEAR_COPY_FIELDS,
  formatCopyMonth,
  formatCopyWeek,
  formatWeekDelta,
  monthCopyText,
  weekCopyText,
  weekCopyEntries,
  weekDeltaClass,
  yearCopyText,
} from './trend-copy'
import { createAnalysisController } from './analysis-controller'
import { lsfViewData } from './analysis-data'
import type {
  AnalysisSettingsPatch,
  AnalysisSnapshot,
  AnalysisTab,
  RankStat,
} from './analysis-state'
import { createEditorFocus } from './ui/editor-focus'
import {
  lsfChartHtml,
  lsfDetailBody,
  lsfLedgerHtml,
  lsfNoticeHtml,
  lsfStatsHtml,
} from './ui/lsf-view'
import { rangePanelHtml, rangeSelectHtml } from './ui/range-control'
import { ratingOverviewHtml } from './ui/rating-view'
import { authorHomeLink, createSettingsPanel } from './ui/settings-panel'

const STAT_LABELS = { time: '用时', bvs: '3BVS', stnb: 'STNB' } as const

const NAV_ITEMS: Array<[AnalysisTab, string]> = [
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

/** 大表数据更新参数：数据源与来源身份。 */
export interface AnalysisUpdateOptions {
  csv?: boolean
  /** 网站玩家或 CSV 快照的稳定身份；缺省按数据源占位。 */
  identity?: string
}

export interface AnalysisView {
  root: HTMLElement
  update(videos: Video[], options?: AnalysisUpdateOptions): void
  /** 销毁视图：使进行中的锚点请求失效并移除节点。 */
  destroy(): void
}

export function createAnalysisView(options: AnalysisViewOptions = {}): AnalysisView {
  const controller = createAnalysisController({
    autoSiteAnchors: options.autoSiteAnchors,
  })
  let snapshot = controller.getSnapshot()
  let state = snapshot.tab
  let filterState = snapshot.filters
  let settings = snapshot.settings
  let games = snapshot.data.games
  let rangeGames = snapshot.data.rangeGames
  let ratingGames = snapshot.data.ratingGames
  let todaySnapshot = snapshot.data.today
  let csvMode = snapshot.dataset.source === 'csv'
  let now = snapshot.dataNow
  let bounds = snapshot.bounds
  let clock = snapshot.clock
  /** 本次渲染的倒序流水，供展开与卡片定位回查。 */
  let lsfEvents: LsfEvent[] = []
  /** 本次渲染的月 / 年统计结果，供复制按钮和预览回查，点击时不再聚合。 */
  let trendMonths: MonthStat[] = []
  let trendMonthLevel: Level = 'e'
  let trendYears: Record<Level, YearStat[]> = { b: [], i: [], e: [] }
  /** 本次渲染的周复制文本，包含已确定的 Δ 和筛选范围，以周起点回查。 */
  const trendWeekCopies = new Map<number, string>()
  configureColors(settings.colorThresholds)
  /** 只在快照修订变化时同步参数面板与色板，避免每次重绘覆盖输入。 */
  let settingsRevisionSeen = snapshot.settingsRevision
  let anchorRevisionSeen = snapshot.anchors.revision
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
  const floorNote = el('span', 'source-note sample-floor')
  const nfField = el('label', 'check')
  const nfInput = el('input')
  nfInput.type = 'checkbox'
  nfInput.id = 'analysis-nf-global'
  nfInput.checked = filterState.nfOnly
  nfField.append(nfInput, document.createTextNode(' 只看 NF'))
  const settingsButton = el('button', 'button', '参数')
  settingsButton.type = 'button'
  filters.append(rangeField, softwareField, nfField, countNote, floorNote, settingsButton)

  const settingsPanel = createSettingsPanel({
    getSettings: () => controller.getSettings(),
    handlers: {
      onBasicChange(key, value) {
        controller.updateSettings({ [key]: value } as AnalysisSettingsPatch)
      },
      onAnchorChange(key, value) {
        controller.updateSettings({ anchors: { [key]: value }, anchorMode: 'workbook' })
      },
      onUseWorkbook() {
        controller.useWorkbookAnchors()
      },
      onUseSite() {
        void controller.refreshSiteAnchors(true)
      },
      onWeightChange(level, metric, value) {
        controller.updateSettings({ softWeights: { [level]: { [metric]: value } } })
      },
      onScoreFieldChange(field, level, value) {
        controller.updateSettings({ [field]: { [level]: value } } as AnalysisSettingsPatch)
      },
      onColorThresholdsChange(values) {
        controller.updateSettings({ colorThresholds: values })
      },
      onDogTargetsChange(level, value) {
        controller.updateSettings(
          level === 'e' ? { dogTargetsE: value } : { dogTargetsI: value },
        )
      },
      onReset() {
        controller.resetSettings()
      },
    },
  })
  settingsButton.setAttribute('aria-expanded', 'false')
  settingsButton.addEventListener('click', () => {
    const open = !settingsPanel.root.classList.toggle('hidden')
    settingsButton.setAttribute('aria-expanded', String(open))
    editorFocus.reveal(
      open ? settingsPanel.root.querySelector<HTMLElement>('input') : settingsButton,
      open ? settingsPanel.root : undefined,
    )
  })

  const nav = el('nav', 'analysis-nav')
  const navButtons = new Map<AnalysisTab, HTMLButtonElement>()
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
      controller.setCopyPanel('month', open)
      return
    }
    const level = panel.dataset.level as Level | undefined
    controller.setCopyPanel('year', open, level)
  }

  /**
   * 勾选、恢复默认后同步所有同名设置区并刷新预览。
   * 不走整页重绘，展开状态和键盘焦点自然保留。
   */
  function setCopyFields(scope: CopySettingsScope, fields: unknown): void {
    controller.setCopyFields(scope, fields)
    settings = controller.getSettings()
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

  const toolbar = el('div', 'analysis-toolbar')
  toolbar.append(filters, nav)
  root.append(toolbar, rangePanel, settingsPanel.root, viewHost, note, credit)

  const editorFocus = createEditorFocus({
    root,
    toolbar,
    isEditing: () =>
      snapshot.rangeEditor !== null || !settingsPanel.root.classList.contains('hidden'),
  })

  /** 控制器快照到位后同步只读镜像、参数面板与色板；输入框只在设置修订变化时回填。 */
  function applySnapshot(next: AnalysisSnapshot): void {
    snapshot = next
    state = next.tab
    filterState = next.filters
    settings = next.settings
    games = next.data.games
    rangeGames = next.data.rangeGames
    ratingGames = next.data.ratingGames
    todaySnapshot = next.data.today
    csvMode = next.dataset.source === 'csv'
    now = next.dataNow
    bounds = next.bounds
    clock = next.clock
    if (next.settingsRevision !== settingsRevisionSeen) {
      settingsRevisionSeen = next.settingsRevision
      configureColors(next.settings.colorThresholds)
      settingsPanel.refresh()
    }
    if (next.anchors.revision !== anchorRevisionSeen) {
      anchorRevisionSeen = next.anchors.revision
      settingsPanel.refreshAnchors()
    }
    settingsPanel.setAnchorStatus(next.anchors.status)
  }

  const unsubscribe = controller.subscribe(render)

  /** 计入局数与筛选提示：梁山分有自己的口径，不沿用其他页签筛选后的计数。 */
  function updateCountNote(): void {
    floorNote.textContent = `3BV 下限：初 ${settings.bvFloors.b} / 中 ${settings.bvFloors.i} / 高 ${settings.bvFloors.e}`
    floorNote.classList.toggle('hidden', state.nav === 'lsf')
    if (state.nav === 'lsf') {
      countNote.title = '全时段有效记录用于梁山分定阶，日期仅截取历史分析时段。'
      countNote.textContent =
        `全时段有效记录 ${formatCount(snapshot.data.history.includedCount)} 局 · 不受软件 / 只看 NF 筛选 · 日期用于历史分析`
      return
    }
    countNote.textContent = `统计样本 ${formatCount(games.length)} 局${filterState.nfOnly ? ' · NF' : ''}`
    countNote.title = '应用公共筛选及各级 3BV 下限；今日成绩、月年局数和全时段定阶使用各自口径。'
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
    softwareField.classList.toggle('hidden', csvMode)
    softwareSelect.value = csvMode ? 'all' : filterState.software
    updateCountNote()
  }

  function renderNav(): void {
    for (const [key, button] of navButtons) {
      button.classList.toggle('active', state.nav === key)
      button.setAttribute('aria-pressed', String(state.nav === key))
    }
  }

  /** 顶部筛选条与页内控件从同一份已应用时段和编辑草稿派生。 */
  function renderRangeControls(): void {
    const controls = snapshot.rangeControl
    rangeSelectSlot.innerHTML = rangeSelectHtml(
      'global',
      controls.uiKey,
      controls.editable,
    )
    const showPanel = controls.panel === 'global'
    rangePanel.classList.toggle('hidden', !showPanel)
    rangePanel.innerHTML = showPanel
      ? rangePanelHtml('global', controls.draft, controls.error, controls.now)
      : ''
  }

  /** 重绘后把焦点交回对应入口的时段控件，键盘操作不被打断。 */
  function focusRangeControl(owner: 'global' | 'lsf', target: 'select' | 'start' = 'select'): void {
    if (target === 'start') {
      const panel = (owner === 'lsf' ? viewHost : rangePanel)
        .querySelector<HTMLElement>(`[data-range-panel="${owner}"]`)
      editorFocus.reveal(panel?.querySelector<HTMLElement>('input[data-range-date="start"]') ?? null, panel ?? undefined)
    } else {
      const host = owner === 'lsf' ? viewHost : rangeSelectSlot
      editorFocus.reveal(host.querySelector<HTMLElement>(`select[data-range-select="${owner}"]`))
    }
  }

  /** 选择快捷时段立即应用；选择「自定义」先进入草稿，应用前不改已应用范围。 */
  function pickRange(key: RangeKey, owner: 'global' | 'lsf'): void {
    if (key === 'custom') {
      controller.beginRangeEdit(owner)
      focusRangeControl(owner, 'start')
      return
    }
    controller.selectRangeKey(key, owner)
    focusRangeControl(owner)
  }

  function syncRangeDraft(input: HTMLInputElement): void {
    const field = input.dataset.rangeDate
    if (field === 'start' || field === 'end') {
      // 只提交本次改动字段，由控制器与当前草稿合并；输入期间不重绘。
      controller.setRangeDraft({ [field]: input.value })
    }
  }

  /** 应用自定义日期；校验失败只显示错误，不改变已应用范围。 */
  function applyCustomRange(panel: HTMLElement): void {
    const owner = panel.getAttribute('data-range-panel') === 'lsf' ? 'lsf' : 'global'
    const start = panel.querySelector<HTMLInputElement>('input[data-range-date="start"]')
    const end = panel.querySelector<HTMLInputElement>('input[data-range-date="end"]')
    controller.setRangeDraft({ start: start?.value ?? '', end: end?.value ?? '' })
    const check = controller.applyRange()
    focusRangeControl(owner, check.ok ? 'select' : 'start')
  }

  function cancelCustomRange(): void {
    const owner = snapshot.rangeEditor?.owner ?? 'global'
    controller.cancelRangeEdit()
    focusRangeControl(owner)
  }

  function render(next: AnalysisSnapshot = controller.getSnapshot()): void {
    applySnapshot(next)
    renderNav()
    renderRangeControls()
    updateFilterAvailability()
    editorFocus.updateToolbar()
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
    const history = snapshot.data.history
    const { range, events } = lsfViewData(history, bounds, clock)
    lsfEvents = events
    const summary =
      ratingOverviewHtml(history.snapshot, {
        anchorMode: settings.anchorMode,
        anchorError: snapshot.anchors.error,
      }) + lsfStatsHtml(range, bounds, snapshot.rangeControl)
    if (history.includedCount === 0) {
      return (
        summary +
        '<div class="card"><div class="card-body"><p class="muted">' +
        `当前各级 3BV 下限是 ${floorLabel()}；计入有效录像后，这里会显示阶梯图与变动流水。` +
        '</p></div></div>' +
        lsfNoticeHtml(history, range)
      )
    }
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
    const open = controller.toggleLsfDetail(id)
    expandLsfDetail(id, open)
  }

  /** 点击或键盘激活台阶点：必要时扩大流水显示范围，再滚动定位并展开明细。 */
  function focusLsfEvent(id: string, day: number | null = null): void {
    if (!controller.focusLsfEvent(id, day)) return
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
    const today = todaySnapshot
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
      ratingOverviewHtml(rating, {
        anchorMode: settings.anchorMode,
        anchorError: snapshot.anchors.error,
      }) +
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
      (today.some((row) => row.count > 0) ?
      '<div class="table-scroll"><table class="data-table summary-table today-table">' +
      '<thead><tr><th>难度</th><th class="num">总局数</th><th class="num">Best Time</th><th class="num">Best 3BVS</th><th class="num">Best STNB</th><th class="num">Avg Time</th><th class="num">Avg 3BVS</th><th class="num">Avg STNB</th><th class="num">Avg 3BV</th><th class="copy-cell"></th></tr></thead>' +
      `<tbody>${todayRows}</tbody>` +
      '</table></div>' : '<p class="today-empty">今日暂无成绩</p>') +
      '<p class="today-scope">按当前数据源的基础有效记录统计，不受公共筛选与统计 3BV 下限影响。</p>' +
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
    const scope = filterState.nfOnly ? '仅 NF' : ''
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
          software: csvMode ? 'all' : filterState.software,
          nfOnly: filterState.nfOnly,
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
            `<thead><tr><th class="num">排名</th><th class="num"><abbr title="${LEVEL_LABELS[level]}用时">${prefix}t</abbr></th><th class="num"><abbr title="${LEVEL_LABELS[level]} 3BVS">${prefix}b</abbr></th><th class="num"><abbr title="${LEVEL_LABELS[level]} STNB">${prefix}s</abbr></th></tr></thead>` +
            `<tbody>${rows}` +
            `<tr class="week-total"><td>总计</td><td class="num">${data.totals.time.toFixed(3)}</td><td class="num">${data.totals.bvs.toFixed(3)}</td><td class="num">${data.totals.stnb.toFixed(2)}</td></tr>` +
            `<tr class="week-average"><td>平均</td><td class="num"${colorAttr(level, 'time', data.averages.time)}>${data.averages.time.toFixed(3)}</td><td class="num"${colorAttr(level, 'bvs', data.averages.bvs)}>${data.averages.bvs.toFixed(3)}</td><td class="num"${colorAttr(level, 'stnb', data.averages.stnb)}>${data.averages.stnb.toFixed(2)}</td></tr>` +
            '</tbody></table></div>'
          )
        }
        const detail =
          `<tr id="week-detail-${week.start}" class="week-detail hidden"><td colspan="8"><h3 class="week-detail-title">${formatShortDate(week.start)} 当周明细</h3><div class="week-level-grid">` +
          `<div class="week-level-column">${levelBlock('b')}</div>` +
          `<div class="week-level-column">${levelBlock('i')}${levelBlock('e')}</div>` +
          '</div>' +
          '<div class="week-summary">' +
          `<span><abbr title="三难度槽位的用时总和">T.37</abbr> <b>${week.t37.toFixed(2)}</b></span>` +
          `<span><abbr title="三难度槽位的 3BVS 总和">B.37</abbr> <b>${week.b37.toFixed(3)}</b></span>` +
          `<span><abbr title="三难度槽位的 STNB 总和">S.37</abbr> <b>${week.s37.toFixed(1)}</b></span>` +
          `<span><abbr title="初级 ${week.levels.b.slot} 个槽位的 PPP 评分">BPP${week.levels.b.slot}</abbr> <b>${week.levels.b.ppp.toFixed(2)}</b></span>` +
          `<span><abbr title="中级 ${week.levels.i.slot} 个槽位的 PPP 评分">IPP${week.levels.i.slot}</abbr> <b>${week.levels.i.ppp.toFixed(2)}</b></span>` +
          `<span><abbr title="高级 ${week.levels.e.slot} 个槽位的 PPP 评分">EPP${week.levels.e.slot}</abbr> <b>${week.levels.e.ppp.toFixed(2)}</b></span>` +
          `<span><abbr title="三难度 37 个槽位的 PPP 综合成绩">PPP37</abbr> <b>${week.ppp.toFixed(2)}</b></span>` +
          '</div></td></tr>'
        return (
          '<tr class="week-row" data-week-row="1">' +
          `<td class="date"><button type="button" class="week-toggle" data-week-toggle aria-expanded="false" aria-controls="week-detail-${week.start}" aria-label="展开 ${formatShortDate(week.start)} 当周明细"><span class="week-arrow" aria-hidden="true">▸</span>${formatShortDate(week.start)}</button></td>` +
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
    controller.selectTab(button.dataset.nav as AnalysisTab)
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
      controller.showMoreLsfEvents()
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
        const open = !detail.classList.contains('hidden')
        weekRow.classList.toggle('open', open)
        const control = weekRow.querySelector<HTMLElement>('[data-week-toggle]')
        control?.setAttribute('aria-expanded', String(open))
        if (control) control.setAttribute('aria-label', `${open ? '收起' : '展开'} ${control.textContent?.replace(/[▸▾]/g, '').trim()} 当周明细`)
        if (!open && document.activeElement && detail.contains(document.activeElement)) control?.focus({ preventScroll: true })
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
      controller.updateTab({ rankStat: stat.dataset.rankStat as RankStat })
      return
    }
    const view = target.closest<HTMLElement>('[data-rank-view]')
    if (view) {
      const value = view.dataset.rankView
      if (value === 'triple') controller.updateTab({ rankLayout: 'triple' })
      else controller.updateTab({ rankLayout: 'single', rankLevel: value as Level })
      return
    }
    const trendLevel = target.closest<HTMLElement>('[data-trend-level]')
    if (trendLevel) {
      controller.updateTab({ trendLevel: trendLevel.dataset.trendLevel as Level })
      return
    }
    const distLevel = target.closest<HTMLElement>('[data-dist-level]')
    if (distLevel) {
      controller.updateTab({ distLevel: distLevel.dataset.distLevel as Level })
      return
    }
    const periodMode = target.closest<HTMLElement>('[data-period-mode]')
    if (periodMode) {
      controller.updateTab({ periodMode: periodMode.dataset.periodMode as PeriodMode })
      return
    }
    const periodLevel = target.closest<HTMLElement>('[data-period-level]')
    if (periodLevel) {
      controller.updateTab({ periodLevel: periodLevel.dataset.periodLevel as Level })
      return
    }
    const periodStat = target.closest<HTMLElement>('[data-period-stat]')
    if (periodStat) {
      controller.updateTab({ periodStat: periodStat.dataset.periodStat as RankStat })
      return
    }
    const effLevel = target.closest<HTMLElement>('[data-eff-level]')
    if (effLevel) {
      controller.updateTab({ effLevel: effLevel.dataset.effLevel as Level })
      return
    }
    const mapLevel = target.closest<HTMLElement>('[data-map-level]')
    if (mapLevel) {
      controller.updateTab({ mapLevel: mapLevel.dataset.mapLevel as Level })
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
      controller.updateTab({ hideEmptyMonths: input.checked })
      return
    }
    if (input.id === 'period-select') {
      controller.updateTab({ periodKey: input.value })
      return
    }
    if (input.id === 'analysis-nf-global') {
      controller.setFilters({ nfOnly: input.checked })
    }
  })

  softwareSelect.addEventListener('change', () => {
    controller.setFilters({ software: softwareSelect.value })
  })

  let datasetVersion = 0

  function update(next: Video[], options: AnalysisUpdateOptions = {}): void {
    datasetVersion += 1
    const csv = options.csv === true
    controller.setDataset({
      source: csv ? 'csv' : 'site',
      // 第四批由页面控制器传入真实玩家 / CSV 快照身份；本批先按数据源区分。
      identity: options.identity ?? (csv ? 'csv' : 'site'),
      contentVersion: datasetVersion,
      videos: next,
    })
  }

  render()

  function destroy(): void {
    unsubscribe()
    controller.destroy()
    editorFocus.destroy()
    settingsPanel.destroy()
    root.replaceChildren()
    root.remove()
  }

  return { root, update, destroy }
}
