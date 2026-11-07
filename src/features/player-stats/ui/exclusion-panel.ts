/**
 * 统计排除管理面板：基于控制器快照中的原始记录做筛选、选择、批量排除与恢复。
 *
 * 面板只在打开时重建列表；筛选、翻页和选择不会让页面控制器重建统计。
 */

import { SITE_ORIGIN } from '../../../shared/constants'
import { formatCount, formatDateTime, formatShortDate } from '../../../shared/format'
import { el, externalLink } from '../../../shared/ui'
import { addLocalDays, startOfLocalDay } from '../analysis-range'
import { LEVEL_LABELS, LEVELS, MIN_BV, softwareLabel } from '../model'
import type { Level } from '../model'
import type {
  ExclusionActionResult,
  PlayerSnapshot,
} from '../player-state'
import {
  buildExclusionCandidates,
  directCandidateScope,
  meanImpact,
  sortCandidateRows,
} from '../statistics-exclusion-candidates'
import type {
  CandidateBaseline,
  CandidateRow,
  CandidateResult,
  ExclusionCandidateScope,
  MeanImpact,
} from '../statistics-exclusion-candidates'
import type {
  ExclusionEntry,
  ExclusionRecordSummary,
  UnmatchedExclusion,
} from '../statistics-exclusion'

const PAGE_SIZE = 100
const CANDIDATE_PAGE_SIZE = 200

type StatusFilter = 'all' | 'included' | 'excluded' | 'unmatched'
type SortMode = 'date-desc' | 'time-desc' | 'time-asc' | 'bv-desc' | 'mean-desc'
type ViewMode = 'list' | 'candidates'
type CandidateRange = 'all' | 'last30' | 'applied' | 'jump' | 'manual'

interface PanelFilters {
  status: StatusFilter
  level: string
  source: string
  from: string
  to: string
  min: string
  max: string
  query: string
  sort: SortMode
}

interface Row {
  kind: 'entry'
  entry: ExclusionEntry
  date: number | null
  time: number | null
  bv: number | null
  candidate: CandidateRow | null
}

interface UnmatchedRow {
  kind: 'unmatched'
  item: UnmatchedExclusion
  date: number | null
  time: number | null
  bv: number | null
}

interface GroupRow {
  kind: 'group'
  level: Level
  baseline: CandidateBaseline
  count: number
}

type TableRow = Row | UnmatchedRow | GroupRow

export interface ExclusionPanelOptions {
  onExclude(keys: readonly string[], snapshotKey: string): Promise<ExclusionActionResult>
  onRestore(keys: readonly string[], snapshotKey: string): Promise<ExclusionActionResult>
  onClearRules(ruleIds: readonly string[], snapshotKey: string): Promise<ExclusionActionResult>
  onLinkHistory(
    sourceId: string,
    scopeId: string,
    snapshotKey: string,
  ): Promise<ExclusionActionResult>
  onRetry(): Promise<void>
  /** 直接打开慢局候选时使用的各级 3BV 下限；缺省使用站点默认值。 */
  getDefaultFloors?(): Record<Level, number>
  /** 大表当前已应用时段与筛选；供「已应用时段」使用，不能与跳转范围混用。 */
  getAppliedScope?(): ExclusionCandidateScope | null
}

export interface ExclusionPanel {
  trigger: HTMLElement
  root: HTMLElement
  /** 打开普通管理列表；可带入统计结果的实际范围。 */
  open(context?: ExclusionCandidateScope): void
  close(): void
  render(snapshot: PlayerSnapshot): void
  destroy(): void
}

function timeOf(summary: ExclusionRecordSummary): number | null {
  if (!summary.date) return null
  const value = Date.parse(summary.date)
  return Number.isNaN(value) ? null : value
}

function displayDate(value: number | null): string {
  return value === null ? '—' : formatDateTime(value)
}

function displayTime(value: number | null): string {
  return value === null ? '—' : (value / 1000).toFixed(3)
}

function displayLevel(level: string | null): string {
  return level && (LEVELS as readonly string[]).includes(level)
    ? LEVEL_LABELS[level as keyof typeof LEVEL_LABELS]
    : '—'
}

function displayNf(nf: boolean | null): string {
  return nf === null ? '—' : nf ? 'NF' : 'FL'
}

function displayMean(value: number): string {
  return value.toFixed(3)
}

function displayIoe(value: number | null): string {
  return value === null ? '—' : value.toFixed(3)
}

function levelsLabel(levels: readonly Level[]): string {
  return levels.length === 1 ? LEVEL_LABELS[levels[0]!] : '全部难度'
}

function rangeLabel(start: number | null, endExclusive: number | null): string {
  if (start === null && endExclusive === null) return '全部时段'
  if (start === null) return `截至 ${formatShortDate(addLocalDays(endExclusive!, -1))}`
  if (endExclusive === null) return `${formatShortDate(start)} 起`
  const end = addLocalDays(endExclusive, -1)
  if (start === end) return formatShortDate(start)
  return `${formatShortDate(start)}–${formatShortDate(end)}`
}

/** 单行预览只描述“单独再排除这一局”，不累计其他候选。 */
function previewText(
  { preview, before, after }: MeanImpact,
  level: string,
): string {
  if (preview === 'empty' || after === null) {
    return `${level}排除后无有效记录`
  }
  if (preview === 'decrease') {
    return `排除此局后，${level}平均用时：${displayMean(before)} → ${displayMean(after)} 秒`
  }
  if (preview === 'increase') {
    return `排除此局后，${level}平均用时升高：${displayMean(before)} → ${displayMean(after)} 秒`
  }
  return `排除此局后，${level}平均用时不变（${displayMean(before)} 秒）`
}

function parseLocalDay(value: string, end: boolean): number | null {
  if (!value) return null
  const date = new Date(`${value}T${end ? '23:59:59.999' : '00:00:00.000'}`)
  const time = date.getTime()
  return Number.isNaN(time) ? null : time
}

function numeric(value: string): number | null {
  if (value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function selectOption(label: string, value: string): HTMLOptionElement {
  const option = el('option', undefined, label)
  option.value = value
  return option
}

function input(type: string, className: string): HTMLInputElement {
  const node = el('input', className)
  node.type = type
  return node
}

/** 列表选择只作用于当前页明确勾选的条目。 */
export function createExclusionPanel(options: ExclusionPanelOptions): ExclusionPanel {
  const trigger = el('button', 'button exclusion-trigger', '统计排除')
  trigger.type = 'button'
  trigger.setAttribute('aria-expanded', 'false')
  trigger.setAttribute('aria-controls', 'stat-exclusion-panel')
  trigger.setAttribute('aria-haspopup', 'dialog')

  const root = el('section', 'exclusion-panel hidden')
  root.id = 'stat-exclusion-panel'
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-labelledby', 'stat-exclusion-title')
  root.tabIndex = -1

  const header = el('div', 'exclusion-head')
  const title = el('h2', 'card-title', '统计排除')
  title.id = 'stat-exclusion-title'
  title.tabIndex = -1
  const summary = el('p', 'exclusion-summary')
  const closeButton = el('button', 'button small', '关闭')
  closeButton.type = 'button'
  const headerText = el('div', 'exclusion-head-text')
  headerText.append(title, summary)
  header.append(headerText, closeButton)

  const errorBox = el('div', 'exclusion-error hidden')
  const errorText = el('p')
  const retryButton = el('button', 'button small', '重试读取')
  retryButton.type = 'button'
  errorBox.append(errorText, retryButton)

  const filters = el('div', 'exclusion-filters')
  const viewSelect = el('select', 'select')
  viewSelect.append(
    selectOption('全部记录', 'list'),
    selectOption('慢局候选', 'candidates'),
  )
  const statusSelect = el('select', 'select')
  statusSelect.append(
    selectOption('全部记录', 'all'),
    selectOption('仅计入', 'included'),
    selectOption('仅已排除', 'excluded'),
    selectOption('仅未匹配规则', 'unmatched'),
  )
  const levelSelect = el('select', 'select')
  levelSelect.append(selectOption('全部难度', 'all'))
  for (const level of LEVELS) levelSelect.append(selectOption(LEVEL_LABELS[level], level))
  const sourceSelect = el('select', 'select')
  const sortSelect = el('select', 'select')
  sortSelect.append(
    selectOption('日期（新→旧）', 'date-desc'),
    selectOption('用时（慢→快）', 'time-desc'),
    selectOption('用时（快→慢）', 'time-asc'),
    selectOption('3BV（高→低）', 'bv-desc'),
  )
  const fromInput = input('date', 'select')
  const toInput = input('date', 'select')
  const minInput = input('number', 'select exclusion-number')
  minInput.placeholder = '用时≥秒'
  minInput.min = '0'
  minInput.step = '0.001'
  const maxInput = input('number', 'select exclusion-number')
  maxInput.placeholder = '用时≤秒'
  maxInput.min = '0'
  maxInput.step = '0.001'
  const queryInput = input('search', 'select exclusion-search')
  queryInput.placeholder = '录像 ID / 文件名'

  const filterField = (label: string, node: HTMLElement): HTMLElement => {
    const field = el('label', 'exclusion-filter')
    field.append(el('span', 'filter-label', label), node)
    return field
  }
  const fromField = filterField('起始日期', fromInput)
  const toField = filterField('结束日期', toInput)
  filters.append(
    filterField('视图', viewSelect),
    filterField('状态', statusSelect),
    filterField('难度', levelSelect),
    filterField('来源', sourceSelect),
    fromField,
    toField,
    filterField('用时范围', (() => {
      const wrap = el('span', 'exclusion-range')
      wrap.append(minInput, el('span', 'exclusion-range-sep', '–'), maxInput)
      return wrap
    })()),
    filterField('排序', sortSelect),
    filterField('查找', queryInput),
  )

  const candidateBar = el('div', 'exclusion-candidate-bar hidden')
  const rangeSelect = el('select', 'select')
  rangeSelect.append(
    selectOption('全部时段', 'all'),
    selectOption('近30天', 'last30'),
    selectOption('已应用时段', 'applied'),
  )
  const countSelect = el('select', 'select')
  countSelect.append(selectOption('每级前 20 局', '20'), selectOption('每级前 50 局', '50'))
  const candidateScopeNote = el('p', 'exclusion-candidate-scope')
  const candidateFilterNote = el(
    'span',
    'exclusion-candidate-hint',
    '来源 / 用时 / 查找只定位列表，不改变预览基准；难度会同步缩窄预览范围。',
  )
  const rangeField = el('label', 'exclusion-filter')
  rangeField.append(el('span', 'filter-label', '候选范围'), rangeSelect)
  const countField = el('label', 'exclusion-filter')
  countField.append(el('span', 'filter-label', '候选数量'), countSelect)
  candidateBar.append(rangeField, countField, candidateScopeNote, candidateFilterNote)

  const historyBox = el('div', 'exclusion-history hidden')
  const listWrap = el('div', 'exclusion-table-wrap')
  const table = el('table', 'data-table exclusion-table')
  const thead = el('thead')
  const headRow = el('tr')
  const selectAllCell = el('th', 'exclusion-check-head')
  const selectAll = input('checkbox', 'exclusion-check')
  selectAll.title = '选择本页所有可操作记录'
  selectAll.setAttribute('aria-label', '选择本页所有记录')
  selectAllCell.append(selectAll)
  headRow.append(
    selectAllCell,
    el('th', undefined, '日期时间'),
    el('th', undefined, '难度'),
    el('th', undefined, '用时'),
    el('th', undefined, '3BV'),
    el('th', 'exclusion-ioe-head', 'IOE'),
    el('th', undefined, 'NF'),
    el('th', undefined, '来源'),
    el('th', undefined, '计入状态'),
    el('th', 'exclusion-preview-head', '均值影响'),
    el('th', undefined, '操作'),
  )
  thead.append(headRow)
  const tbody = el('tbody')
  table.append(thead, tbody)
  listWrap.append(table)

  const empty = el('p', 'exclusion-empty hidden')
  const footer = el('div', 'exclusion-footer')
  const pageInfo = el('span', 'exclusion-page-info')
  const prevButton = el('button', 'button small', '上一页')
  const nextButton = el('button', 'button small', '下一页')
  prevButton.type = 'button'
  nextButton.type = 'button'
  const pager = el('div', 'exclusion-pager')
  pager.append(prevButton, pageInfo, nextButton)
  const batch = el('div', 'exclusion-batch')
  const excludeButton = el('button', 'button primary small', '排除选中')
  const restoreButton = el('button', 'button small', '恢复选中')
  excludeButton.type = 'button'
  restoreButton.type = 'button'
  batch.append(excludeButton, restoreButton)
  footer.append(batch, pager)

  const feedback = el('p', 'exclusion-feedback')
  feedback.setAttribute('role', 'status')
  feedback.setAttribute('aria-live', 'polite')

  const body = el('div', 'exclusion-body')
  body.append(historyBox, filters, candidateBar, listWrap, empty, footer)
  root.append(header, errorBox, body, feedback)

  let sourceOptionValues: string[] = []
  const filterState: PanelFilters = {
    status: 'all',
    level: 'all',
    source: 'all',
    from: '',
    to: '',
    min: '',
    max: '',
    query: '',
    sort: 'date-desc',
  }
  let current: PlayerSnapshot | null = null
  let pageIndex = 0
  let selection = new Set<string>()
  let busy = false
  let actionFeedback = ''
  let actionError = false
  let previousFocus: HTMLElement | null = null
  let open = false
  let lastRenderKey = ''
  let lastSnapshotKey = ''
  let viewMode: ViewMode = 'list'
  let candidateRange: CandidateRange = 'all'
  let candidateLimit = 20
  let jumpScope: ExclusionCandidateScope | null = null
  /** 打开面板时从大表读取的当前应用范围；跳转范围单独保存在 jumpScope。 */
  let analysisScope: ExclusionCandidateScope | null = null
  let candidateCache: {
    key: string
    result: CandidateResult
  } | null = null
  let sortSignature = ''
  let rangeSignature = ''
  const dismissedHistory = new Set<string>()

  function snapshotKey(): string {
    return current?.exclusion.snapshotKey ?? ''
  }

  function entryRows(): ExclusionEntry[] {
    return current?.exclusion.entries ?? []
  }

  function defaultFloors(): Record<Level, number> {
    const floors = options.getDefaultFloors?.()
    return floors ? { ...floors } : { ...MIN_BV }
  }

  /** 当前慢局候选的统计基准：范围与口径不随列表筛选、分页或候选条数变化。 */
  function currentCandidateScope(): ExclusionCandidateScope {
    const source = current?.source ?? 'site'
    const jump = jumpScope && jumpScope.source === source ? jumpScope : null
    const analysis = analysisScope && analysisScope.source === source ? analysisScope : null
    // 「全部 / 近30天」默认普通全软件口径；从结果跳入时保留结果限制。
    const sourceId = filterState.source === 'all' ? null : filterState.source
    const levels =
      filterState.level === 'all' ? [...(jump?.levels ?? LEVELS)] : [filterState.level as Level]

    if (candidateRange === 'jump' && jump) {
      return { ...jump, sourceId, levels }
    }
    if (candidateRange === 'applied' && analysis) {
      return { ...analysis, sourceId, levels }
    }
    const base = jump
      ? { ...jump, start: null, endExclusive: null, label: '全部时段' }
      : directCandidateScope(source, defaultFloors())
    if (candidateRange === 'manual') {
      const start = parseLocalDay(filterState.from, false)
      const endStart = parseLocalDay(filterState.to, false)
      const endExclusive = endStart === null ? null : addLocalDays(endStart, 1)
      const label =
        start === null && endExclusive === null
          ? '自定义日期'
          : rangeLabel(start, endExclusive)
      return {
        ...base,
        sourceId,
        start,
        endExclusive,
        levels,
        label,
      }
    }
    if (candidateRange === 'last30') {
      const today = startOfLocalDay(Date.now())
      return {
        ...base,
        sourceId,
        start: addLocalDays(today, -29),
        endExclusive: addLocalDays(today, 1),
        levels,
        label: '近30天',
      }
    }
    return { ...base, sourceId, levels }
  }

  function candidateResult(): CandidateResult {
    const scope = currentCandidateScope()
    const key = JSON.stringify({
      snapshot: snapshotKey(),
      scope,
      limit: candidateLimit,
      entries: entryRows().length,
      videos: current?.videos.length ?? 0,
    })
    if (!candidateCache || candidateCache.key !== key) {
      candidateCache = {
        key,
        result: buildExclusionCandidates(
          entryRows(),
          current?.videos ?? [],
          scope,
          candidateLimit,
        ),
      }
    }
    return candidateCache.result
  }

  function candidateScopeText(scope: ExclusionCandidateScope): string {
    const software =
      scope.source === 'csv' || scope.software === 'all'
        ? '全部软件'
        : `软件 ${softwareLabel(scope.software)}`
    const sourceName = scope.sourceId
      ? (entryRows().find((entry) => entry.sourceId === scope.sourceId)?.sourceName ??
        '所选文件')
      : scope.source === 'csv'
        ? '全部 CSV 文件'
        : '网站数据'
    return (
      `预览范围：${rangeLabel(scope.start, scope.endExclusive)} · ` +
      `${levelsLabel(scope.levels)} · ${software} · ${scope.nfOnly ? '仅 NF' : '含 NF'} · ` +
      `3BV 下限 ${scope.floors.b}/${scope.floors.i}/${scope.floors.e} · ` +
      `${sourceName} · 已应用排除规则`
    )
  }

  function currentPageSize(): number {
    return viewMode === 'candidates' ? CANDIDATE_PAGE_SIZE : PAGE_SIZE
  }

  function syncSourceOptions(): void {
    const sources = new Map<string, string>()
    for (const entry of entryRows()) {
      if (entry.sourceId) sources.set(entry.sourceId, entry.sourceName)
    }
    for (const item of current?.exclusion.unmatched ?? []) {
      if (item.sourceId && !sources.has(item.sourceId)) {
        sources.set(item.sourceId, item.sourceName)
      }
    }
    const wanted = [...sources].map(([id, name]) => ({ id, name }))
    const next = ['all', ...wanted.map((item) => item.id)]
    if (
      sourceOptionValues.length === next.length &&
      sourceOptionValues.every((value, index) => value === next[index])
    ) {
      return
    }
    // 重建选项时保留仍存在的筛选值，避免刷新后误切到其他文件。
    if (!next.includes(filterState.source)) filterState.source = 'all'
    sourceOptionValues = next
    sourceSelect.replaceChildren(selectOption('全部来源', 'all'))
    for (const item of wanted) sourceSelect.append(selectOption(item.name, item.id))
    sourceSelect.value = filterState.source
  }

  function syncSortOptions(): void {
    const optionsList: Array<[string, string]> =
      viewMode === 'candidates'
        ? [
            ['time-desc', '用时（慢→快）'],
            ['mean-desc', '均值下降（大→小）'],
          ]
        : [
            ['date-desc', '日期（新→旧）'],
            ['time-desc', '用时（慢→快）'],
            ['time-asc', '用时（快→慢）'],
            ['bv-desc', '3BV（高→低）'],
          ]
    const signature = optionsList.map(([value]) => value).join('|')
    if (sortSignature !== signature) {
      sortSelect.replaceChildren(...optionsList.map(([value, label]) => selectOption(label, value)))
      sortSignature = signature
    }
    if (!optionsList.some(([value]) => value === filterState.sort)) {
      filterState.sort = viewMode === 'candidates' ? 'time-desc' : 'date-desc'
    }
    sortSelect.value = filterState.sort
  }

  function syncRangeOptions(): void {
    const source = current?.source ?? 'site'
    const analysis = analysisScope && analysisScope.source === source ? analysisScope : null
    const jump = jumpScope && jumpScope.source === source ? jumpScope : null
    const signature = `${analysis ? analysis.label : ''}|${jump ? jump.label : ''}`
    if (rangeSignature !== signature) {
      const optionsList = [
        selectOption('全部时段', 'all'),
        selectOption('近30天', 'last30'),
        selectOption('已应用时段', 'applied'),
        selectOption('自定义日期', 'manual'),
      ]
      if (!analysis) optionsList[2]!.disabled = true
      if (jump) optionsList.push(selectOption('进入时的结果范围', 'jump'))
      rangeSelect.replaceChildren(...optionsList)
      rangeSignature = signature
    }
    if (!analysis && candidateRange === 'applied') candidateRange = 'all'
    if (!jump && candidateRange === 'jump') candidateRange = 'all'
    rangeSelect.value = candidateRange
  }

  function renderCandidateBar(): void {
    const candidates = viewMode === 'candidates'
    const hasJump = jumpScope !== null
    const hasRange = candidates || hasJump || candidateRange !== 'all'
    const showDates =
      candidateRange === 'manual' ||
      (!candidates && !hasJump && candidateRange === 'all')
    candidateBar.classList.toggle('hidden', !hasRange)
    fromField.classList.toggle('hidden', !showDates)
    toField.classList.toggle('hidden', !showDates)
    countField.classList.toggle('hidden', !candidates)
    statusSelect.disabled = candidates
    if (candidates) {
      filterState.status = 'included'
      statusSelect.value = 'included'
    }
    if (!hasRange) return
    syncRangeOptions()
    countSelect.value = String(candidateLimit)
    const scope = currentCandidateScope()
    candidateScopeNote.textContent = candidateScopeText(scope)
  }

  function inScopeDates(date: number | null, scope: ExclusionCandidateScope): boolean {
    if (scope.start !== null && (date === null || date < scope.start)) return false
    if (scope.endExclusive !== null && (date === null || date >= scope.endExclusive)) {
      return false
    }
    return true
  }

  function matches(
    summary: ExclusionRecordSummary,
    sourceId: string | null,
    videoId: number | null,
    date: number | null,
  ): boolean {
    if (filterState.level !== 'all' && summary.level !== filterState.level) return false
    if (filterState.source !== 'all' && sourceId !== filterState.source) return false
    // 尚未切换到自定义范围的日期条件仍按普通列表过滤。
    if (viewMode === 'list' && jumpScope === null && candidateRange === 'all' && filterState.from) {
      const from = parseLocalDay(filterState.from, false)
      if (from !== null && (date === null || date < from)) return false
    }
    if (viewMode === 'list' && jumpScope === null && candidateRange === 'all' && filterState.to) {
      const to = parseLocalDay(filterState.to, true)
      if (to !== null && (date === null || date > to)) return false
    }
    const min = numeric(filterState.min)
    const max = numeric(filterState.max)
    if (min !== null || max !== null) {
      if (summary.timems === null) return false
      const seconds = summary.timems / 1000
      if (min !== null && seconds < min) return false
      if (max !== null && seconds > max) return false
    }
    const query = filterState.query.trim()
    if (query) {
      const inId = videoId !== null && String(videoId).includes(query)
      const inSource = summary.sourceName.toLowerCase().includes(query.toLowerCase())
      if (!inId && !inSource) return false
    }
    return true
  }

  function candidateTableRows(): TableRow[] {
    const result = candidateResult()
    const rows: TableRow[] = []
    for (const level of LEVELS) {
      const baseline = result.baselines[level]
      if (!baseline) continue
      let levelRows = result.candidates.filter(
        (row) =>
          row.level === level &&
          !row.entry.excluded &&
          matches(
            row.entry.summary,
            row.entry.sourceId,
            row.entry.videoId,
            timeOf(row.entry.summary),
          ),
      )
      if (filterState.sort === 'mean-desc') levelRows = sortCandidateRows(levelRows)
      if (levelRows.length === 0) continue
      rows.push({
        kind: 'group',
        level,
        baseline,
        count: levelRows.length,
      })
      for (const candidate of levelRows) {
        rows.push({
          kind: 'entry',
          entry: candidate.entry,
          date: timeOf(candidate.entry.summary),
          time: candidate.entry.summary.timems,
          bv: candidate.entry.summary.bv,
          candidate,
        })
      }
    }
    return rows
  }

  function visibleRows(): TableRow[] {
    if (viewMode === 'candidates') return candidateTableRows()
    const entries = entryRows()
    const unmatched = current?.exclusion.unmatched ?? []
    const scope = currentCandidateScope()
    const scopedRange = jumpScope !== null || candidateRange !== 'all'
    const rows: TableRow[] = []
    if (filterState.status !== 'unmatched') {
      for (const entry of entries) {
        if (filterState.status === 'included' && entry.excluded) continue
        if (filterState.status === 'excluded' && !entry.excluded) continue
        const date = timeOf(entry.summary)
        if (scopedRange && !inScopeDates(date, scope)) continue
        if (
          scopedRange &&
          !(entry.summary.level !== null &&
            scope.levels.includes(entry.summary.level as Level))
        ) {
          continue
        }
        if (!matches(entry.summary, entry.sourceId, entry.videoId, date)) continue
        rows.push({
          kind: 'entry',
          entry,
          date,
          time: entry.summary.timems,
          bv: entry.summary.bv,
          candidate: null,
        })
      }
    }
    if (filterState.status === 'all' || filterState.status === 'unmatched') {
      for (const item of unmatched) {
        const date = timeOf(item.rule.summary)
        if (scopedRange && !inScopeDates(date, scope)) continue
        if (
          scopedRange &&
          !(
            item.rule.summary.level !== null &&
            scope.levels.includes(item.rule.summary.level as Level)
          )
        ) {
          continue
        }
        if (!matches(item.rule.summary, item.sourceId, item.rule.summary.videoId, date)) {
          continue
        }
        rows.push({
          kind: 'unmatched',
          item,
          date,
          time: item.rule.summary.timems,
          bv: item.rule.summary.bv,
        })
      }
    }
    const sort = filterState.sort
    rows.sort((a, b) => {
      if (a.kind === 'group' || b.kind === 'group') return 0
      if (sort === 'date-desc') return (b.date ?? -1) - (a.date ?? -1)
      if (sort === 'time-desc') return (b.time ?? -1) - (a.time ?? -1)
      if (sort === 'time-asc') {
        if (a.time === null) return 1
        if (b.time === null) return -1
        return a.time - b.time
      }
      return (b.bv ?? -1) - (a.bv ?? -1)
    })
    return rows
  }

  function pageRows(rows: readonly TableRow[]): TableRow[] {
    const size = currentPageSize()
    return rows.slice(pageIndex * size, (pageIndex + 1) * size)
  }

  function selectedEntries(): ExclusionEntry[] {
    const byKey = new Map(entryRows().map((entry) => [entry.key, entry]))
    return [...selection]
      .map((key) => byKey.get(key))
      .filter((entry): entry is ExclusionEntry => entry !== undefined)
  }

  function rowCell(text: string, className?: string): HTMLElement {
    const cell = el('td', className, text)
    return cell
  }

  function blocked(): boolean {
    if (!current) return true
    if (busy || !current.exclusion.ready || current.exclusion.saving) return true
    if (current.exclusion.error !== '') return true
    if (current.loading) return true
    return current.source === 'csv' && current.csv.loading
  }

  function actionButton(text: string, title: string, onClick: () => void): HTMLElement {
    const button = el('button', 'button small exclusion-row-action', text)
    button.type = 'button'
    button.title = title
    button.disabled = blocked()
    button.addEventListener('click', onClick)
    return button
  }

  async function runAction(
    action: () => Promise<ExclusionActionResult>,
  ): Promise<void> {
    if (blocked()) return
    busy = true
    actionFeedback = ''
    actionError = false
    renderPanel(true)
    try {
      const result = await action()
      actionFeedback = result.message
      actionError = !result.ok
      if (result.ok) selection.clear()
    } catch {
      actionFeedback = '操作失败，请重试。'
      actionError = true
    } finally {
      busy = false
      renderPanel(true)
    }
  }

  function renderHistory(): void {
    const state = current?.exclusion
    if (!current || !state) {
      historyBox.classList.add('hidden')
      return
    }
    const unbound = state.unboundSources.filter(
      (source) => !dismissedHistory.has(source.sourceId),
    )
    const historical = state.historicalScopes
    if (unbound.length === 0 || historical.length === 0) {
      historyBox.classList.add('hidden')
      historyBox.replaceChildren()
      return
    }
    historyBox.classList.remove('hidden')
    historyBox.replaceChildren(
      el(
        'p',
        'exclusion-history-title',
        '当前文件没有可自动确认的文件身份，请明确选择是否沿用历史排除规则：',
      ),
    )
    for (const source of unbound) {
      const row = el('div', 'exclusion-history-row')
      row.append(el('span', 'exclusion-history-name', source.name))
      const choice = el('select', 'select')
      historical.forEach((scope, index) => {
        const label =
          `${scope.name}（${scope.ruleCount} 条规则` +
          (historical.filter((item) => item.name === scope.name).length > 1
            ? `，来源 ${index + 1}`
            : '') +
          '）'
        choice.append(selectOption(label, scope.scopeId))
      })
      const link = el('button', 'button small primary', '关联历史来源')
      link.type = 'button'
      link.disabled = blocked()
      link.addEventListener('click', () => {
        const key = snapshotKey()
        void runAction(() => options.onLinkHistory(source.sourceId, choice.value, key))
      })
      const fresh = el('button', 'button small', '作为新来源')
      fresh.type = 'button'
      fresh.disabled = blocked()
      fresh.title = '不沿用任何历史排除规则，当前条目全部计入统计'
      fresh.addEventListener('click', () => {
        dismissedHistory.add(source.sourceId)
        actionFeedback = `已将 ${source.name} 作为新来源，未沿用历史规则。`
        actionError = false
        lastRenderKey = ''
        renderPanel(true)
      })
      row.append(choice, link, fresh)
      historyBox.append(row)
    }
  }

  function renderTable(): void {
    syncSourceOptions()
    syncSortOptions()
    const rows = visibleRows()
    const pages = Math.max(1, Math.ceil(rows.length / currentPageSize()))
    if (pageIndex >= pages) pageIndex = pages - 1
    if (pageIndex < 0) pageIndex = 0
    const visible = pageRows(rows)
    const pageEntries = visible
      .filter((row): row is Row => row.kind === 'entry')
      .map((row) => row.entry)
    const availableKeys = new Set(entryRows().map((entry) => entry.key))
    selection = new Set([...selection].filter((key) => availableKeys.has(key)))

    const currentKeys = pageEntries.map((entry) => entry.key)
    const allSelected =
      currentKeys.length > 0 && currentKeys.every((key) => selection.has(key))
    selectAll.checked = allSelected
    selectAll.disabled = blocked() || currentKeys.length === 0

    const previewResult = viewMode === 'list' ? candidateResult() : null
    const eligibleKeys = previewResult?.eligibleKeys ?? null
    tbody.replaceChildren()
    for (const row of visible) {
      const tr = el('tr')
      if (row.kind === 'group') {
        tr.className = 'exclusion-group-row'
        const cell = el('td', 'exclusion-group-cell')
        cell.colSpan = 11
        cell.textContent =
          `${LEVEL_LABELS[row.level]} · 候选 ${formatCount(row.count)} 条 · ` +
          `本范围 ${formatCount(row.baseline.count)} 局 · ` +
          `中位用时 ${displayMean(row.baseline.median)} 秒`
        tr.append(cell)
        tbody.append(tr)
        continue
      }
      if (row.kind === 'entry') {
        const entry = row.entry
        const checkCell = el('td', 'exclusion-check-cell')
        const check = input('checkbox', 'exclusion-check')
        check.checked = selection.has(entry.key)
        check.disabled = blocked()
        check.setAttribute(
          'aria-label',
          `选择 ${entry.sourceName} ${displayDate(row.date)} ${displayTime(row.time)} 秒`,
        )
        check.addEventListener('change', () => {
          if (check.checked) selection.add(entry.key)
          else selection.delete(entry.key)
          renderPanel(true)
        })
        checkCell.append(check)
        tr.append(checkCell)
        tr.append(rowCell(displayDate(row.date), 'exclusion-date'))
        tr.append(rowCell(displayLevel(entry.summary.level)))
        tr.append(rowCell(displayTime(row.time), 'exclusion-number-cell'))
        tr.append(rowCell(row.bv === null ? '—' : String(row.bv), 'exclusion-number-cell'))
        tr.append(rowCell(displayIoe(entry.ioe), 'exclusion-number-cell exclusion-ioe'))
        tr.append(rowCell(displayNf(entry.summary.nf)))
        const sourceCell = el('td', 'exclusion-source')
        sourceCell.append(el('span', undefined, entry.sourceName))
        if (entry.source === 'site' && entry.videoId !== null && entry.videoId > 0) {
          sourceCell.append(
            el('span', 'exclusion-source-id', ` #${entry.videoId}`),
            externalLink('原页', `${SITE_ORIGIN}/#/video/${entry.videoId}`),
          )
        } else if (entry.source === 'csv') {
          sourceCell.append(
            el('span', 'exclusion-source-id', ` · 条目 ${entry.recordIndex + 1}`),
          )
        }
        if (entry.summary.state && entry.summary.state !== 'c') {
          sourceCell.append(el('span', 'exclusion-state', `状态 ${entry.summary.state}`))
        }
        tr.append(sourceCell)
        const statusCell = el('td', 'exclusion-status')
        statusCell.append(
          el(
            'span',
            entry.excluded ? 'exclusion-badge excluded' : 'exclusion-badge',
            entry.excluded ? '已排除' : '计入',
          ),
        )
        tr.append(statusCell)
        const previewCell = el('td', 'exclusion-preview')
        if (row.candidate) {
          previewCell.textContent = previewText(
            row.candidate,
            LEVEL_LABELS[row.candidate.level],
          )
          previewCell.classList.add(row.candidate.preview)
          previewCell.title =
            '预览只表示在当前基准上单独再排除这一局；提交排除后会影响全部统计。'
        } else if (entry.excluded) {
          previewCell.textContent = '已排除（不重复扣除）'
        } else if (eligibleKeys && !eligibleKeys.has(entry.key)) {
          previewCell.textContent = '不参与本预览范围'
        } else if (
          previewResult &&
          entry.summary.timems !== null &&
          entry.summary.level !== null
        ) {
          const baseline =
            previewResult.baselines[entry.summary.level as Level] ?? null
          if (baseline) {
            const impact = meanImpact(baseline, entry.summary.timems / 1000)
            previewCell.textContent = previewText(
              impact,
              LEVEL_LABELS[entry.summary.level as Level] ?? '该难度',
            )
            previewCell.classList.add(impact.preview)
          } else {
            previewCell.textContent = '不参与本预览范围'
          }
        } else {
          previewCell.textContent = '不参与本预览范围'
        }
        tr.append(previewCell)
        const action = el('td', 'exclusion-action')
        action.append(
          actionButton(
            entry.excluded ? '恢复计入' : '排除',
            entry.excluded ? '恢复这条记录的统计' : '把这条记录排除出统计',
            () => {
              const key = snapshotKey()
              void runAction(() =>
                entry.excluded
                  ? options.onRestore([entry.key], key)
                  : options.onExclude([entry.key], key),
              )
            },
          ),
        )
        tr.append(action)
      } else {
        const item = row.item
        tr.classList.add('exclusion-unmatched-row')
        tr.append(rowCell(''))
        tr.append(rowCell(displayDate(row.date), 'exclusion-date'))
        tr.append(rowCell(displayLevel(item.rule.summary.level)))
        tr.append(rowCell(displayTime(row.time), 'exclusion-number-cell'))
        tr.append(rowCell(row.bv === null ? '—' : String(row.bv), 'exclusion-number-cell'))
        tr.append(rowCell('—', 'exclusion-number-cell exclusion-ioe'))
        tr.append(rowCell(displayNf(item.rule.summary.nf)))
        tr.append(rowCell(item.sourceName, 'exclusion-source'))
        const statusCell = el('td', 'exclusion-status')
        statusCell.append(
          el(
            'span',
            'exclusion-badge unmatched',
            item.reason === 'ambiguous' ? '重复条目无法确认' : '当前未匹配',
          ),
        )
        const note = el('span', 'exclusion-note', item.message)
        statusCell.append(note)
        tr.append(statusCell)
        tr.append(rowCell('当前未匹配', 'exclusion-preview'))
        const action = el('td', 'exclusion-action')
        action.append(
          actionButton('清除规则', '删除这条未匹配的排除规则', () => {
            const key = snapshotKey()
            void runAction(() => options.onClearRules([item.rule.ruleId], key))
          }),
        )
        tr.append(action)
      }
      tbody.append(tr)
    }

    listWrap.classList.toggle('hidden', rows.length === 0)
    empty.classList.toggle('hidden', rows.length !== 0)
    empty.textContent =
      viewMode === 'candidates'
        ? '当前预览范围内没有符合统计口径的慢局候选。'
        : filterState.status === 'unmatched'
          ? '当前没有未匹配的排除规则。'
          : '没有符合筛选条件的记录。'

    pageInfo.textContent = rows.length === 0
      ? ''
      : `第 ${pageIndex + 1}/${pages} 页 · ${formatCount(rows.length)} 条`
    prevButton.disabled = busy || pageIndex <= 0
    nextButton.disabled = busy || pageIndex >= pages - 1

    const selected = selectedEntries()
    const excludable = selected.filter((entry) => !entry.excluded).length
    const restorable = selected.filter((entry) => entry.excluded).length
    excludeButton.disabled = blocked() || excludable === 0
    restoreButton.disabled = blocked() || restorable === 0
    excludeButton.textContent = excludable > 0 ? `排除选中（${excludable}）` : '排除选中'
    restoreButton.textContent = restorable > 0 ? `恢复选中（${restorable}）` : '恢复选中'
  }

  function renderPanel(force = false): void {
    if (!current) return
    viewSelect.value = viewMode
    const state = current.exclusion
    const key = snapshotKey()
    if (lastSnapshotKey !== '' && lastSnapshotKey !== key) selection.clear()
    lastSnapshotKey = key
    trigger.textContent =
      state.excludedCount > 0 ? `统计排除（已排除 ${formatCount(state.excludedCount)}）` : '统计排除'
    trigger.setAttribute('aria-expanded', String(open))
    trigger.classList.toggle('has-exclusions', state.excludedCount > 0)
    summary.textContent = state.ready
      ? `读取 ${formatCount(state.entries.length)} 局 · 当前已排除 ${formatCount(state.excludedCount)} 局 · 当前未匹配 ${formatCount(state.unmatchedCount)} 条 · PB / 大表均按排除后统计`
      : '统计排除规则尚未就绪，统计暂不发布。'
    errorBox.classList.toggle('hidden', !state.error)
    errorText.textContent = state.error
    retryButton.disabled = state.saving
    body.classList.toggle('hidden', !state.ready)
    feedback.textContent = actionFeedback
    feedback.classList.toggle('hidden', actionFeedback === '')
    feedback.classList.toggle('error', actionError)
    closeButton.disabled = state.saving

    if (!open) return
    const selectionKey = [...selection].sort().join(',')
    const renderKey = JSON.stringify({
      identity: current.dataset.identity,
      version: current.dataset.contentVersion,
      source: current.source,
      ready: state.ready,
      saving: state.saving,
      error: state.error,
      entries: state.entries.length,
      excluded: state.excludedCount,
      unmatched: state.unmatched.map((item) => `${item.rule.ruleId}:${item.reason}`),
      unbound: state.unboundSources.map((source) => source.sourceId),
      historical: state.historicalScopes.map((scope) => `${scope.scopeId}:${scope.ruleCount}`),
      dismissed: [...dismissedHistory].sort(),
      filters: filterState,
      viewMode,
      candidateRange,
      candidateLimit,
      jump: jumpScope
        ? `${jumpScope.source}|${jumpScope.sourceId}|${jumpScope.start}|${jumpScope.endExclusive}|${jumpScope.levels.join(',')}|${jumpScope.software}|${jumpScope.nfOnly}|${jumpScope.label}`
        : '',
      analysis: analysisScope
        ? `${analysisScope.start}|${analysisScope.endExclusive}|${analysisScope.label}`
        : '',
      page: pageIndex,
      selection: selectionKey,
      busy,
      feedback: actionFeedback,
    })
    if (!force && renderKey === lastRenderKey) return
    lastRenderKey = renderKey
    renderHistory()
    renderCandidateBar()
    renderTable()
  }

  function openPanel(context?: ExclusionCandidateScope): void {
    if (!current) return
    if (!open) {
      const active =
        typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null
      previousFocus = active && typeof active.focus === 'function' ? active : null
    }
    open = true
    analysisScope = options.getAppliedScope?.() ?? null
    if (context) {
      jumpScope = context
      // 从统计结果进入先展示该范围的完整列表；慢局候选只负责截取前 N 条。
      viewMode = 'list'
      candidateRange = 'jump'
      filterState.level =
        context.levels.length === 1 ? context.levels[0]! : 'all'
      filterState.status = 'all'
    } else {
      const previousRange = candidateRange
      if (jumpScope) {
        // 上一次是从统计结果跳入时，直接重新打开按默认全部难度展示。
        filterState.level = 'all'
      }
      jumpScope = null
      viewMode = 'list'
      // 关闭再打开保留用户已选范围；自定义日期从仍保留的输入恢复。
      if (filterState.from !== '' || filterState.to !== '') candidateRange = 'manual'
      else if (previousRange === 'applied' || previousRange === 'last30') {
        candidateRange = previousRange
      } else candidateRange = 'all'
    }
    pageIndex = 0
    candidateCache = null
    root.classList.remove('hidden')
    trigger.setAttribute('aria-expanded', 'true')
    lastRenderKey = ''
    renderPanel(true)
    if (context) rangeSelect.focus()
    else title.focus()
  }

  function closePanel(): void {
    if (!open) return
    open = false
    root.classList.add('hidden')
    trigger.setAttribute('aria-expanded', 'false')
    selection.clear()
    actionFeedback = ''
    actionError = false
    const target = previousFocus
    previousFocus = null
    // 提交排除后原关注节点可能已被重绘删除，回到仍存在的页面级入口。
    if (target?.isConnected) target.focus()
    else trigger.focus()
  }

  trigger.addEventListener('click', () => {
    if (open) closePanel()
    else openPanel()
  })
  closeButton.addEventListener('click', closePanel)
  root.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closePanel()
    }
  })
  retryButton.addEventListener('click', () => {
    void options.onRetry()
  })
  viewSelect.addEventListener('change', () => {
    const wasCandidates = viewMode === 'candidates'
    viewMode = viewSelect.value === 'candidates' ? 'candidates' : 'list'
    if (viewMode === 'candidates') {
      filterState.status = 'included'
      if (filterState.sort !== 'mean-desc') filterState.sort = 'time-desc'
    } else {
      if (wasCandidates && filterState.status === 'included') filterState.status = 'all'
      if (filterState.sort === 'mean-desc') filterState.sort = 'date-desc'
    }
    selection.clear()
    candidateCache = null
    pageIndex = 0
    lastRenderKey = ''
    renderPanel(true)
  })
  rangeSelect.addEventListener('change', () => {
    candidateRange = rangeSelect.value as CandidateRange
    if (candidateRange !== 'manual') {
      filterState.from = ''
      filterState.to = ''
      fromInput.value = ''
      toInput.value = ''
    }
    selection.clear()
    candidateCache = null
    pageIndex = 0
    lastRenderKey = ''
    renderPanel(true)
  })
  countSelect.addEventListener('change', () => {
    candidateLimit = countSelect.value === '50' ? 50 : 20
    selection.clear()
    candidateCache = null
    pageIndex = 0
    lastRenderKey = ''
    renderPanel(true)
  })
  statusSelect.addEventListener('change', () => {
    filterState.status = statusSelect.value as StatusFilter
    pageIndex = 0
    lastRenderKey = ''
    renderPanel(true)
  })
  levelSelect.addEventListener('change', () => {
    filterState.level = levelSelect.value
    selection.clear()
    candidateCache = null
    pageIndex = 0
    lastRenderKey = ''
    renderPanel(true)
  })
  sourceSelect.addEventListener('change', () => {
    filterState.source = sourceSelect.value
    selection.clear()
    candidateCache = null
    pageIndex = 0
    lastRenderKey = ''
    renderPanel(true)
  })
  sortSelect.addEventListener('change', () => {
    filterState.sort = sortSelect.value as SortMode
    pageIndex = 0
    lastRenderKey = ''
    renderPanel(true)
  })
  // 只有起止日期属于统计范围；用时和关键词只是列表定位条件。
  for (const node of [fromInput, toInput]) {
    node.addEventListener('input', () => {
      filterState.from = fromInput.value
      filterState.to = toInput.value
      if (filterState.from !== '' || filterState.to !== '') {
        candidateRange = 'manual'
      } else if (candidateRange === 'manual') {
        candidateRange = 'all'
      }
      selection.clear()
      candidateCache = null
      pageIndex = 0
      lastRenderKey = ''
      renderPanel(true)
    })
  }
  for (const node of [minInput, maxInput, queryInput]) {
    node.addEventListener('input', () => {
      filterState.min = minInput.value
      filterState.max = maxInput.value
      filterState.query = queryInput.value
      selection.clear()
      pageIndex = 0
      lastRenderKey = ''
      renderPanel(true)
    })
  }
  selectAll.addEventListener('change', () => {
    const rows = pageRows(visibleRows())
    for (const row of rows) {
      if (row.kind !== 'entry') continue
      if (selectAll.checked) selection.add(row.entry.key)
      else selection.delete(row.entry.key)
    }
    lastRenderKey = ''
    renderPanel(true)
  })
  prevButton.addEventListener('click', () => {
    pageIndex = Math.max(0, pageIndex - 1)
    lastRenderKey = ''
    renderPanel(true)
  })
  nextButton.addEventListener('click', () => {
    pageIndex += 1
    lastRenderKey = ''
    renderPanel(true)
  })
  excludeButton.addEventListener('click', () => {
    const entries = selectedEntries().filter((entry) => !entry.excluded)
    if (entries.length === 0) return
    const key = snapshotKey()
    void runAction(() => options.onExclude(entries.map((entry) => entry.key), key))
  })
  restoreButton.addEventListener('click', () => {
    const entries = selectedEntries().filter((entry) => entry.excluded)
    if (entries.length === 0) return
    const key = snapshotKey()
    void runAction(() => options.onRestore(entries.map((entry) => entry.key), key))
  })

  return {
    trigger,
    root,
    open: openPanel,
    close: closePanel,
    render(snapshot: PlayerSnapshot) {
      current = snapshot
      if (jumpScope && jumpScope.source !== snapshot.source) {
        jumpScope = null
        viewMode = 'list'
        candidateRange = 'all'
        selection.clear()
        candidateCache = null
      }
      viewSelect.value = viewMode
      renderPanel()
    },
    destroy() {
      open = false
      previousFocus = null
      selection.clear()
    },
  }
}
