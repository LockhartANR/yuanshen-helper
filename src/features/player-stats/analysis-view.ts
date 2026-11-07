import { formatCount, formatShortDate } from '../../shared/format'
import { el } from '../../shared/ui'
import { configureColors } from './colors'
import { addLocalDays, rangeHint, startOfLocalDay } from './analysis-range'
import type { RangeKey } from './analysis-range'
import type { PeriodMode } from './analysis'
import type { Level, Video } from './model'
import { LEVELS, LEVEL_LABELS } from './model'
import {
  intersectCandidateRange,
} from './statistics-exclusion-candidates'
import type { ExclusionCandidateScope } from './statistics-exclusion-candidates'
import { createAnalysisController } from './analysis-controller'
import { tabDataFor, withTrendCopyFields } from './analysis-tab-data'
import type { AnalysisTabData } from './analysis-tab-data'
import type {
  AnalysisSettingsPatch,
  AnalysisSnapshot,
  AnalysisTab,
  RankStat,
} from './analysis-state'
import { createEditorFocus } from './ui/editor-focus'
import { lsfDetailBody } from './ui/lsf-view'
import { rangePanelHtml, rangeSelectHtml } from './ui/range-control'
import { authorHomeLink, createSettingsPanel } from './ui/settings-panel'
import { renderDistTab } from './ui/tabs/dist'
import { renderEffTab } from './ui/tabs/eff'
import { renderLsfTab } from './ui/tabs/lsf'
import { renderMapTab } from './ui/tabs/map'
import { renderOverviewTab } from './ui/tabs/overview'
import { renderPeriodTab } from './ui/tabs/period'
import { renderRankTab } from './ui/tabs/rank'
import { renderTrendTab } from './ui/tabs/trend'

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

export interface AnalysisViewOptions {
  /** 启动时若保存的是网站锚点，是否自动读取网站；独立 CSV 传 false 以免联网。 */
  autoSiteAnchors?: boolean
  /** 从统计结果打开录像列表；范围由当前结果的实际日期与筛选决定。 */
  onViewRecordings?: (scope: ExclusionCandidateScope) => void
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
  /** 当前统计口径的各级 3BV 下限；直接打开慢局候选时作为默认基准。 */
  getBvFloors(): Record<Level, number>
  /** 当前已应用时段与筛选，用于面板的「已应用时段」而不是跳转范围。 */
  getAppliedScope(): ExclusionCandidateScope
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
  let csvMode = snapshot.dataset.source === 'csv'
  /** 当前已渲染的页签数据，供复制与局部交互回查。 */
  let tabData: AnalysisTabData | null = null
  configureColors(settings.colorThresholds)
  /** 只在快照修订变化时同步参数面板与色板，避免每次重绘覆盖输入。 */
  let settingsRevisionSeen = snapshot.settingsRevision
  let anchorRevisionSeen = snapshot.anchors.revision

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

  /** 按按钮上的周期标识回查当前页签展示数据，避免点击时重新聚合。 */
  function copyButtonText(button: HTMLButtonElement): string | null {
    const kind = button.dataset.copyKind
    const level = button.dataset.copyLevel as Level | undefined
    if (kind === 'today') {
      if (!level || tabData?.kind !== 'overview') return null
      return tabData.todayCopies.get(level) ?? null
    }
    if (tabData?.kind !== 'trend') return null
    if (kind === 'week') {
      const start = Number(button.dataset.copyWeek)
      if (!Number.isFinite(start)) return null
      return tabData.weekCopies.get(start) ?? null
    }
    const key = button.dataset.copyKey
    if (!key || !level) return null
    if (kind === 'month') {
      // 难度切换后旧按钮已被替换，这里再确认一次，避免用别的难度的快照。
      if (level !== tabData.monthLevel) return null
      return tabData.monthCopies.get(key) ?? null
    }
    if (kind === 'year') return tabData.yearCopies[level].get(key) ?? null
    return null
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
    if (tabData?.kind !== 'trend') return
    // 只按新字段重算复制文本与预览，保留当前已展示的表格、时段与展开状态；
    // 不重新取快照，避免跨午夜时把表格换成新一天的统计。
    tabData = withTrendCopyFields(tabData, settings)
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
      const level = (preview.dataset.level as Level | undefined) ?? tabData.monthLevel
      const content = scope === 'month' ? tabData.monthPreview : tabData.yearPreviews[level]
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
    csvMode = next.dataset.source === 'csv'
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
    tabData = tabDataFor(next)
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
    if (!tabData) return
    viewHost.innerHTML =
      tabData.kind === 'overview'
        ? renderOverviewTab(tabData)
        : tabData.kind === 'lsf'
          ? renderLsfTab(tabData)
          : tabData.kind === 'rank'
            ? renderRankTab(tabData)
            : tabData.kind === 'trend'
              ? renderTrendTab(tabData)
              : tabData.kind === 'period'
                ? renderPeriodTab(tabData)
                : tabData.kind === 'dist'
                  ? renderDistTab(tabData)
                  : tabData.kind === 'eff'
                    ? renderEffTab(tabData)
                    : renderMapTab(tabData)
  }

  function expandLsfDetail(id: string, open: boolean): void {
    const button = viewHost.querySelector<HTMLElement>(`[data-lsf-toggle="${id}"]`)
    const detail = viewHost.querySelector<HTMLElement>(`[data-lsf-detail="${id}"]`)
    const row = viewHost.querySelector<HTMLElement>(`[data-lsf-event-row="${id}"]`)
    if (open && detail && detail.dataset.filled !== '1' && tabData?.kind === 'lsf') {
      const event = tabData.events.find((item) => item.id === id)
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
    if (tabData?.kind !== 'lsf') return
    const target = tabData.events.find(
      (event) => !event.undated && startOfLocalDay(event.date) === day,
    )
    if (target) focusLsfEvent(target.id, day)
  }

  /** 从统计结果进入录像管理：只传实际日期交集与当前口径。 */
  function openRecordings(
    start: number,
    endExclusive: number,
    levels: readonly Level[],
    label: string,
  ): void {
    if (!options.onViewRecordings) return
    const clipped = intersectCandidateRange(start, endExclusive, snapshot.bounds)
    options.onViewRecordings({
      source: snapshot.dataset.source === 'csv' ? 'csv' : 'site',
      sourceId: null,
      start: clipped.start,
      endExclusive: clipped.endExclusive,
      levels: [...levels],
      software: snapshot.dataset.source === 'csv' ? 'all' : snapshot.filters.software,
      nfOnly: snapshot.filters.nfOnly,
      floors: { ...snapshot.settings.bvFloors },
      label,
      origin: 'jump',
    })
  }

  function openCalendarDay(value: string): void {
    const day = Number(value)
    if (!Number.isFinite(day)) return
    openRecordings(day, addLocalDays(day, 1), LEVELS, `自然日 ${formatShortDate(day)}`)
  }

  function openWeek(value: string): void {
    const start = Number(value)
    if (!Number.isFinite(start)) return
    openRecordings(
      start,
      addLocalDays(start, 7),
      LEVELS,
      `周 ${formatShortDate(start)}–${formatShortDate(addLocalDays(start, 6))}`,
    )
  }

  function openMonth(value: string, level: Level): void {
    const match = /^(\d{4})-(\d{2})$/.exec(value)
    if (!match) return
    const year = Number(match[1])
    const month = Number(match[2])
    if (month < 1 || month > 12) return
    const start = new Date(year, month - 1, 1).getTime()
    const end = new Date(year, month, 1).getTime()
    openRecordings(
      start,
      end,
      [level],
      `${year}年${month}月 · ${LEVEL_LABELS[level]}`,
    )
  }

  nav.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-nav]')
    if (!button) return
    controller.selectTab(button.dataset.nav as AnalysisTab)
  })

  viewHost.addEventListener('click', (event) => {
    const target = event.target as HTMLElement
    // 「查看录像」必须先于周 / 月行展开处理，不能顺带复制或展开明细。
    const calendarDay = target.closest<HTMLElement>('[data-exclusion-day]')
    if (calendarDay) {
      openCalendarDay(calendarDay.dataset.exclusionDay ?? '')
      return
    }
    const weekJump = target.closest<HTMLElement>('[data-exclusion-week]')
    if (weekJump) {
      openWeek(weekJump.dataset.exclusionWeek ?? '')
      return
    }
    const monthJump = target.closest<HTMLElement>('[data-exclusion-month]')
    if (monthJump) {
      openMonth(
        monthJump.dataset.exclusionMonth ?? '',
        (monthJump.dataset.exclusionLevel as Level | undefined) ?? 'e',
      )
      return
    }
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

  return {
    root,
    update,
    getBvFloors: () => ({ ...settings.bvFloors }),
    getAppliedScope: () => ({
      source: snapshot.dataset.source === 'csv' ? 'csv' : 'site',
      sourceId: null,
      start: snapshot.bounds.start,
      endExclusive: snapshot.bounds.endExclusive,
      levels: [...LEVELS],
      software: snapshot.dataset.source === 'csv' ? 'all' : snapshot.filters.software,
      nfOnly: snapshot.filters.nfOnly,
      floors: { ...snapshot.settings.bvFloors },
      label: rangeHint(snapshot.bounds),
      origin: 'direct',
    }),
    destroy,
  }
}
