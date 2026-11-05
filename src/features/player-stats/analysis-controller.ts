import { fetchLsfAnchors } from './lsf-anchors'
import type { LsfAnchorsResult } from './lsf-anchors'
import { createAnalysisDataProvider, lsfViewData } from './analysis-data'
import type { AnalysisDataProvider } from './analysis-data'
import {
  customDraftFor,
  resolveRange,
  startOfLocalDay,
  validateCustomRange,
} from './analysis-range'
import type { CustomRange, CustomValidation, RangeKey } from './analysis-range'
import { DEFAULT_ANALYSIS_SETTINGS, loadAnalysisSettings, saveAnalysisSettings } from './analysis-settings'
import type { AnalysisSettings } from './analysis-settings'
import type {
  AnalysisAppliedRange,
  AnalysisFilterState,
  AnalysisRangeEditorState,
  AnalysisSettingsPatch,
  AnalysisSnapshot,
  AnalysisTab,
  AnalysisTabState,
  RankLayout,
  RankStat,
  RangeControlOwner,
} from './analysis-state'
import {
  createInitialAnalysisTabState,
  LSF_LEDGER_STEP,
} from './analysis-state'
import { normalizeMonthCopyFields, normalizeYearCopyFields } from './trend-copy'
import { LEVELS } from './model'
import type { DatasetSnapshot, Level } from './model'
import { WORKBOOK_ANCHORS } from './ratings'

type MutableTabState = Omit<AnalysisTabState, 'lsfExpanded'> & { lsfExpanded: Set<string> }

export interface AnalysisTabPatch {
  rankStat?: RankStat
  rankLevel?: Level
  rankLayout?: RankLayout
  trendLevel?: Level
  hideEmptyMonths?: boolean
  distLevel?: Level
  effLevel?: Level
  periodMode?: AnalysisTabState['periodMode']
  periodLevel?: Level
  periodStat?: RankStat
  periodKey?: string
  mapLevel?: Level
}

export interface AnalysisControllerOptions {
  /** 启动时若保存的是网站锚点，是否自动读取网站；独立 CSV 传 false 以免联网。 */
  autoSiteAnchors?: boolean
  clock?: () => number
  loadSettings?: () => AnalysisSettings
  saveSettings?: (settings: AnalysisSettings) => void
  loadSiteAnchors?: (force: boolean) => Promise<LsfAnchorsResult>
  /** 测试可注入共享派生层；默认每个控制器独立持有。 */
  data?: AnalysisDataProvider
}

export interface AnalysisController {
  getSnapshot(): AnalysisSnapshot
  getSettings(): Readonly<AnalysisSettings>
  subscribe(listener: (snapshot: AnalysisSnapshot) => void): () => void
  setDataset(dataset: DatasetSnapshot): void
  selectTab(tab: AnalysisTab): void
  updateTab(patch: AnalysisTabPatch): void
  setFilters(patch: Partial<AnalysisFilterState>): void
  selectRangeKey(key: RangeKey, owner: RangeControlOwner): void
  beginRangeEdit(owner: RangeControlOwner): void
  setRangeDraft(draft: Partial<CustomRange>): void
  applyRange(): CustomValidation
  cancelRangeEdit(): void
  updateSettings(patch: AnalysisSettingsPatch): void
  useWorkbookAnchors(): void
  resetSettings(): void
  refreshSiteAnchors(force?: boolean): Promise<boolean>
  toggleLsfDetail(id: string): boolean
  showMoreLsfEvents(): void
  focusLsfEvent(id: string, day?: number | null): boolean
  focusLsfDay(day: number): boolean
  setCopyPanel(scope: 'month' | 'year', open: boolean, level?: Level): void
  setCopyFields(scope: 'month' | 'year', fields: unknown): void
  destroy(): void
}

const BASIC_LIMITS = {
  rankLimit: [10, 200],
  monthTop: [1, 50],
  yearTop: [1, 50],
  smallTop: [1, 20],
  subTiers: [5, 20],
} as const

const SCORE_LIMITS = {
  levelWeights: [0, 100],
  t37Slots: [1, 50],
  t37Pads: [1, 999],
  bvFloors: [1, 300],
} as const

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

function cloneSettings(settings: AnalysisSettings): AnalysisSettings {
  return JSON.parse(JSON.stringify(settings)) as AnalysisSettings
}

/**
 * 大表状态与编排的唯一持有者。只通过明确动作改状态，对外发布只读快照；
 * 不依赖 DOM，锚点读取、设置读写与时钟都可以注入，便于直接测试状态转换。
 */
export function createAnalysisController(
  options: AnalysisControllerOptions = {},
): AnalysisController {
  const clock = options.clock ?? Date.now
  const loadSettings = options.loadSettings ?? loadAnalysisSettings
  const saveSettings = options.saveSettings ?? saveAnalysisSettings
  const loadSiteAnchors = options.loadSiteAnchors ?? fetchLsfAnchors
  const data = options.data ?? createAnalysisDataProvider()

  let settings = loadSettings()
  let settingsRevision = 0
  let anchors: AnalysisSnapshot['anchors'] = { error: false, status: '', revision: 0 }
  let anchorRequest = 0
  let destroyed = false
  const listeners = new Set<(snapshot: AnalysisSnapshot) => void>()

  const state: {
    dataset: DatasetSnapshot
    tab: MutableTabState
    filters: AnalysisFilterState
    range: AnalysisAppliedRange
    rangeEditor: AnalysisRangeEditorState | null
    dataNow: number
  } = {
    dataset: { source: 'site', identity: '', contentVersion: 0, videos: [] },
    tab: createInitialAnalysisTabState() as MutableTabState,
    filters: { software: 'all', nfOnly: false },
    range: { key: 'all', custom: { start: '', end: '' } },
    rangeEditor: null,
    dataNow: clock(),
  }

  function emit(): void {
    if (destroyed) return
    const snapshot = getSnapshot()
    for (const listener of [...listeners]) listener(snapshot)
  }

  function getSnapshot(): AnalysisSnapshot {
    const currentClock = clock()
    const bounds = resolveRange(state.range.key, state.range.custom, currentClock)
    const rangeEditor = state.rangeEditor
    return {
      dataset: state.dataset,
      tab: state.tab,
      filters: { ...state.filters },
      range: { key: state.range.key, custom: { ...state.range.custom } },
      rangeEditor: rangeEditor
        ? { owner: rangeEditor.owner, draft: { ...rangeEditor.draft }, error: rangeEditor.error }
        : null,
      rangeControl: {
        uiKey: rangeEditor ? 'custom' : state.range.key,
        panel: rangeEditor?.owner ?? null,
        draft: rangeEditor?.draft ?? state.range.custom,
        error: rangeEditor?.error ?? '',
        now: currentClock,
        editable: state.range.key === 'custom',
      },
      settings,
      settingsRevision,
      anchors: { ...anchors },
      data: data.get({
        dataset: state.dataset,
        filters: state.filters,
        settings,
        bounds,
        dataNow: state.dataNow,
      }),
      bounds,
      dataNow: state.dataNow,
      clock: currentClock,
    }
  }

  function currentLsfEvents() {
    const snapshot = getSnapshot()
    return lsfViewData(snapshot.data.history, snapshot.bounds, snapshot.clock).events
  }

  function clearLsfFocus(): void {
    state.tab.lsfFocus = ''
    state.tab.lsfFocusDay = null
  }

  function setDataset(dataset: DatasetSnapshot): void {
    state.dataset = {
      source: dataset.source,
      identity: dataset.identity,
      contentVersion: dataset.contentVersion,
      videos: dataset.videos,
    }
    state.dataNow = clock()
    // 换数据源 / 玩家：旧定位、展开与未应用草稿一起作废，已应用时段与页签选项保留。
    state.tab.lsfExpanded.clear()
    state.tab.lsfLimit = LSF_LEDGER_STEP
    clearLsfFocus()
    state.rangeEditor = null
    emit()
  }

  function selectTab(tab: AnalysisTab): void {
    if (state.tab.nav === tab) return
    // 页内面板随梁山分页签消失时丢弃草稿，顶部选项恢复为已应用的时段。
    if (state.rangeEditor?.owner === 'lsf') state.rangeEditor = null
    state.tab.nav = tab
    emit()
  }

  function updateTab(patch: AnalysisTabPatch): void {
    if (patch.rankStat !== undefined) state.tab.rankStat = patch.rankStat
    if (patch.rankLevel !== undefined) state.tab.rankLevel = patch.rankLevel
    if (patch.rankLayout !== undefined) state.tab.rankLayout = patch.rankLayout
    if (patch.trendLevel !== undefined) state.tab.trendLevel = patch.trendLevel
    if (patch.hideEmptyMonths !== undefined) state.tab.hideEmptyMonths = patch.hideEmptyMonths
    if (patch.distLevel !== undefined) state.tab.distLevel = patch.distLevel
    if (patch.effLevel !== undefined) state.tab.effLevel = patch.effLevel
    if (patch.periodMode !== undefined) {
      state.tab.periodMode = patch.periodMode
      state.tab.periodKey = ''
    }
    if (patch.periodLevel !== undefined) {
      state.tab.periodLevel = patch.periodLevel
      state.tab.periodKey = ''
    }
    if (patch.periodStat !== undefined) state.tab.periodStat = patch.periodStat
    if (patch.periodKey !== undefined) state.tab.periodKey = patch.periodKey
    if (patch.mapLevel !== undefined) state.tab.mapLevel = patch.mapLevel
    emit()
  }

  function setFilters(patch: Partial<AnalysisFilterState>): void {
    if (patch.software !== undefined) state.filters.software = patch.software
    if (patch.nfOnly !== undefined) state.filters.nfOnly = patch.nfOnly
    emit()
  }

  function selectRangeKey(key: RangeKey, owner: RangeControlOwner): void {
    if (key === 'custom') {
      beginRangeEdit(owner)
      return
    }
    state.range = { key, custom: state.range.custom }
    state.rangeEditor = null
    clearLsfFocus()
    emit()
  }

  function beginRangeEdit(owner: RangeControlOwner): void {
    state.rangeEditor = {
      owner,
      draft: customDraftFor(state.range.custom, clock()),
      error: '',
    }
    emit()
  }

  /** 合并本次输入字段；输入期间不发布快照，避免整页重绘。 */
  function setRangeDraft(draft: Partial<CustomRange>): void {
    if (!state.rangeEditor) return
    state.rangeEditor = {
      owner: state.rangeEditor.owner,
      draft: { ...state.rangeEditor.draft, ...draft },
      error: state.rangeEditor.error,
    }
  }

  /** 应用自定义日期；校验失败只显示错误，不改变已应用范围。 */
  function applyRange(): CustomValidation {
    const editor = state.rangeEditor
    if (!editor) return { ok: false, message: '' }
    const check = validateCustomRange(editor.draft, clock())
    if (!check.ok) {
      state.rangeEditor = { ...editor, error: check.message }
      emit()
      return check
    }
    state.range = { key: 'custom', custom: { ...editor.draft } }
    state.rangeEditor = null
    clearLsfFocus()
    emit()
    return check
  }

  function cancelRangeEdit(): void {
    state.rangeEditor = null
    emit()
  }

  function updateSettings(patch: AnalysisSettingsPatch): void {
    const next = cloneSettings(settings)
    /** 只改锚点时不动设置修订号，避免异步 / 锚点输入回填覆盖其他正在编辑的字段。 */
    let contentChanged = false
    for (const key of Object.keys(BASIC_LIMITS) as Array<keyof typeof BASIC_LIMITS>) {
      if (patch[key] !== undefined) {
        const [min, max] = BASIC_LIMITS[key]
        next[key] = clampInt(patch[key], min, max, next[key])
        contentChanged = true
      }
    }
    if (patch.anchors) {
      let anchored = false
      for (const [key, value] of Object.entries(patch.anchors)) {
        if (!(key in WORKBOOK_ANCHORS)) continue
        if (!Number.isFinite(value) || (value as number) <= 0) continue
        next.anchors[key] = value as number
        anchored = true
      }
      if (anchored) {
        // 手动改锚点后让进行中的网站锚点请求失效，避免晚到的结果覆盖。
        anchorRequest += 1
        anchors = { ...anchors, error: false, revision: anchors.revision + 1 }
      }
    }
    if (patch.softWeights) {
      for (const level of LEVELS) {
        const metrics = patch.softWeights[level]
        if (!metrics) continue
        for (const metric of ['t', 'b', 's'] as const) {
          const value = metrics[metric]
          if (value === undefined) continue
          // 与参数面板一致：越界值不写回，保留原值。
          if (!Number.isFinite(value) || value < 0 || value > 100) continue
          next.softWeights[level][metric] = Math.round(value)
          contentChanged = true
        }
      }
    }
    for (const key of Object.keys(SCORE_LIMITS) as Array<keyof typeof SCORE_LIMITS>) {
      const values = patch[key]
      if (!values) continue
      for (const level of LEVELS) {
        const value = values[level]
        if (value === undefined) continue
        const [min, max] = SCORE_LIMITS[key]
        if (!Number.isFinite(value) || value < min || value > max) continue
        next[key][level] = Math.round(value)
        contentChanged = true
      }
    }
    if (patch.pppConsts) {
      for (const level of LEVELS) {
        const value = patch.pppConsts[level]
        if (value === undefined) continue
        if (!Number.isFinite(value) || value <= 0) continue
        next.pppConsts[level] = value
        contentChanged = true
      }
    }
    if (patch.colorThresholds) {
      const values = patch.colorThresholds
      if (
        values.length === DEFAULT_ANALYSIS_SETTINGS.colorThresholds.length &&
        values.every((value) => Number.isFinite(value) && value > 0)
      ) {
        next.colorThresholds = [...values]
        contentChanged = true
      }
    }
    if (patch.dogTargetsE !== undefined) {
      next.dogTargetsE = patch.dogTargetsE
      contentChanged = true
    }
    if (patch.dogTargetsI !== undefined) {
      next.dogTargetsI = patch.dogTargetsI
      contentChanged = true
    }
    if (patch.monthCopyFields !== undefined) {
      next.monthCopyFields = normalizeMonthCopyFields(patch.monthCopyFields)
      contentChanged = true
    }
    if (patch.yearCopyFields !== undefined) {
      next.yearCopyFields = normalizeYearCopyFields(patch.yearCopyFields)
      contentChanged = true
    }
    if (patch.anchorMode !== undefined) {
      next.anchorMode = patch.anchorMode === 'site' ? 'site' : 'workbook'
      anchors = { ...anchors, error: false, revision: anchors.revision + 1 }
    }
    settings = next
    if (contentChanged) settingsRevision += 1
    saveSettings(settings)
    emit()
  }

  function useWorkbookAnchors(): void {
    anchorRequest += 1
    const next = cloneSettings(settings)
    next.anchors = { ...WORKBOOK_ANCHORS }
    next.anchorMode = 'workbook'
    settings = next
    settingsRevision += 1
    anchors = { ...anchors, error: false, status: '已使用大表锚点', revision: anchors.revision + 1 }
    saveSettings(settings)
    emit()
  }

  function resetSettings(): void {
    anchorRequest += 1
    settings = cloneSettings(DEFAULT_ANALYSIS_SETTINGS)
    settingsRevision += 1
    anchors = { ...anchors, error: false, status: '已使用大表锚点', revision: anchors.revision + 1 }
    saveSettings(settings)
    emit()
  }

  async function refreshSiteAnchors(force = false): Promise<boolean> {
    const request = ++anchorRequest
    try {
      const fetched = await loadSiteAnchors(force)
      if (request !== anchorRequest || destroyed) return false
      const next = cloneSettings(settings)
      Object.assign(next.anchors, fetched.anchors)
      next.anchorMode = 'site'
      settings = next
      const hours = Math.max(1, Math.round((clock() - fetched.fetchedAt) / (60 * 60 * 1000)))
      anchors = {
        error: fetched.stale,
        status: fetched.stale
          ? `站点请求失败，沿用 ${hours} 小时前的网站锚点`
          : '已读取网站锚点',
        revision: anchors.revision + 1,
      }
      saveSettings(settings)
      emit()
      return true
    } catch {
      if (request !== anchorRequest || destroyed) return false
      anchors = {
        ...anchors,
        error: true,
        status:
          settings.anchorMode === 'site'
            ? '网站锚点刷新失败，继续用已保存的网站锚点'
            : '网站锚点读取失败，继续用大表锚点',
      }
      emit()
      return false
    }
  }

  function toggleLsfDetail(id: string): boolean {
    if (!id) return false
    const open = !state.tab.lsfExpanded.has(id)
    if (open) state.tab.lsfExpanded.add(id)
    else state.tab.lsfExpanded.delete(id)
    return open
  }

  function showMoreLsfEvents(): void {
    state.tab.lsfLimit += LSF_LEDGER_STEP
    emit()
  }

  /** 必要时扩大流水显示范围；焦点交给视图，状态变化后由视图重新查询对应按钮。 */
  function focusLsfEvent(id: string, day: number | null = null): boolean {
    if (!id) return false
    const index = currentLsfEvents().findIndex((event) => event.id === id)
    if (index < 0) return false
    state.tab.lsfFocus = id
    state.tab.lsfFocusDay = day
    state.tab.lsfExpanded.add(id)
    if (index >= state.tab.lsfLimit) {
      state.tab.lsfLimit = Math.ceil((index + 1) / LSF_LEDGER_STEP) * LSF_LEDGER_STEP
    }
    emit()
    return true
  }

  function focusLsfDay(day: number): boolean {
    const target = currentLsfEvents().find(
      (event) => !event.undated && startOfLocalDay(event.date) === day,
    )
    return target ? focusLsfEvent(target.id, day) : false
  }

  function setCopyPanel(scope: 'month' | 'year', open: boolean, level?: Level): void {
    if (scope === 'month') {
      state.tab.monthCopyOpen = open
      return
    }
    if (level) state.tab.yearCopyOpen[level] = open
  }

  function setCopyFields(scope: 'month' | 'year', fields: unknown): void {
    const next = cloneSettings(settings)
    if (scope === 'month') next.monthCopyFields = normalizeMonthCopyFields(fields)
    else next.yearCopyFields = normalizeYearCopyFields(fields)
    settings = next
    settingsRevision += 1
    saveSettings(settings)
    // 当前交互刻意不整页重绘，展开状态和键盘焦点由视图保持不变。
  }

  function destroy(): void {
    destroyed = true
    anchorRequest += 1
    listeners.clear()
  }

  function subscribe(listener: (snapshot: AnalysisSnapshot) => void): () => void {
    if (destroyed) return () => {}
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  if (options.autoSiteAnchors !== false && settings.anchorMode === 'site') {
    void refreshSiteAnchors()
  }

  return {
    getSnapshot,
    getSettings: () => settings,
    subscribe,
    setDataset,
    selectTab,
    updateTab,
    setFilters,
    selectRangeKey,
    beginRangeEdit,
    setRangeDraft,
    applyRange,
    cancelRangeEdit,
    updateSettings,
    useWorkbookAnchors,
    resetSettings,
    refreshSiteAnchors,
    toggleLsfDetail,
    showMoreLsfEvents,
    focusLsfEvent,
    focusLsfDay,
    setCopyPanel,
    setCopyFields,
    destroy,
  }
}
