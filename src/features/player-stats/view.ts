import { SITE_ORIGIN } from '../../shared/constants'
import { onDbBlocked } from '../../shared/db'
import type { PlayerVideoRow } from '../../shared/db'
import { formatCount, formatDateTime, formatShortDate } from '../../shared/format'
import { askSelfId, resolveSelfId } from '../../shared/self-id'
import { el, errorMessage, externalLink, isAbortError } from '../../shared/ui'
import { fetchUserInfo } from './api'
import { createAnalysisView } from './analysis-view'
import { loadAnalysisSettings } from './analysis-settings'
import { computePb, computeTop5, eligible, bvsOf, joinVideos, stnbOf } from './compute'
import { configureColors, dateColorStyle, medianOf, pbColorStyle } from './colors'
import { createCsvSession } from './csv-session'
import type { CsvSession } from './csv-session'
import {
  canRememberCsvFiles,
  createCsvStore,
  formatValidDelta,
  pickCsvFiles,
} from './csv-sources'
import type { CsvFileHandle } from './csv-sources'
import { parsePlayerLaunch } from './launch'
import { softwareIcon } from './software-icon'
import type { Level, Top5Group, TopStat, Video } from './model'
import { LEVELS, MAX_BV, softwareLabel } from './model'
import { ensureDetails, loadPlayer } from './service'

const LEVEL_LABELS: Record<Level, string> = { b: '初级', i: '中级', e: '高级' }
const STAT_LABELS: Record<TopStat, string> = { time: '用时', bvs: '3BVS', stnb: 'STNB' }

/** PB 表除了三个指标，还能切到「日期」看每条 PB 的结束日期。 */
type PbStat = TopStat | 'date'
const PB_STATS: PbStat[] = ['time', 'bvs', 'stnb', 'date']
const PB_STAT_LABELS: Record<PbStat, string> = { ...STAT_LABELS, date: '日期' }

const SOFTWARE_OPTIONS: { value: string; label: string }[] = [
  { value: 'all', label: '全部软件' },
  { value: 'a', label: 'avf' },
  { value: 'e', label: 'evf' },
  { value: 'm', label: 'mvf' },
  { value: 'r', label: 'rmv' },
]

const CSV_FORMAT_HINT =
  '首行表头为 Arbiter / 元扫雷 的 31 列格式（Day、Month、Year、Hour、Min、Sec、mode、Time、BBBV、BBBVs、style 等），单文件不超过 20 MB。'

interface UiState {
  rows: PlayerVideoRow[]
  videos: Video[]
  software: string
  nfOnly: boolean
  includeUnapproved: boolean
  pbStat: PbStat
  updatedAt: number
  fromCache: boolean
  loading: boolean
  message: string
}

export interface PlayerStatsMountOptions {
  /** 页面是否运行在外部 iframe 中；外部 iframe 只允许 embed 模式启动。 */
  framed?: boolean
}

export interface PlayerStatsHandle {
  /** 销毁页面：使进行中的请求失效并清理大表内部状态。 */
  destroy(): void
}

function formatSeconds(timems: number): string {
  return (timems / 1000).toFixed(3)
}

function formatEndTime(value: string | null): string {
  if (!value) return '—'
  const time = Date.parse(value)
  return Number.isNaN(time) ? '—' : formatDateTime(time)
}

function videoLink(id: number): HTMLElement {
  if (id <= 0) return el('span')
  return externalLink(`#${id}`, `${SITE_ORIGIN}/#/video/${id}`)
}

export async function mountPlayerStats(
  root: HTMLElement,
  mountOptions: PlayerStatsMountOptions = {},
): Promise<PlayerStatsHandle | null> {
  const parsed = parsePlayerLaunch(location.search, { framed: mountOptions.framed === true })
  if (!parsed.ok) {
    root.append(el('div', 'player-error', parsed.message))
    return null
  }

  const launch = parsed.launch
  const standaloneCsv = launch.kind === 'csv'
  const embedded = launch.kind === 'site' && launch.embedded
  const siteUserId = launch.kind === 'site' ? launch.userId : null

  configureColors(loadAnalysisSettings().colorThresholds)

  const state: UiState = {
    rows: [],
    videos: [],
    software: 'all',
    nfOnly: false,
    includeUnapproved: false,
    pbStat: 'time',
    updatedAt: 0,
    fromCache: false,
    loading: false,
    message: '',
  }

  let controller: AbortController | null = null
  let requestVersion = 0
  let pendingUnapproved = false
  let source: 'site' | 'csv' = 'site'
  let page: 'score' | 'analysis' = launch.initialPage
  let siteName = siteUserId === null ? '本地 CSV' : `#${siteUserId}`
  let appliedSnapshot = -1
  /** 覆盖「恢复清单 → 选择文件 → 读取 → 自动切源」的视图操作标记。 */
  let csvFlow = 0
  /** 降级模式的文件输入在 change 事件返回前必须仍属于同一次操作。 */
  type CsvSelection =
    | { kind: 'add'; flow: number }
    | { kind: 'relink'; flow: number; sourceId: string }
  let pendingFileInput: CsvSelection | null = null

  // ---- 头部 ----
  const nameNode = el('h1', 'player-name', siteUserId === null ? '本地 CSV' : `#${siteUserId}`)
  const idNode = el(
    'span',
    'player-id',
    siteUserId === null ? '0 个文件' : `ID ${siteUserId}`,
  )
  const metaNode = el(
    'p',
    'player-meta',
    siteUserId === null ? '还没有导入 CSV 文件' : '准备中…',
  )

  const refreshButton = el('button', 'button primary', '刷新')
  refreshButton.type = 'button'
  const cancelButton = el('button', 'button', '取消')
  cancelButton.type = 'button'
  cancelButton.classList.add('hidden')

  const header = el('header', 'player-header')
  const headerText = el('div', 'player-header-text')
  const titleRow = el('div', 'player-title')
  titleRow.append(nameNode, idNode)
  headerText.append(titleRow, metaNode)

  // 独立 CSV 不绑定网站玩家，所以连「站点主页 / 我的成绩」都不创建。
  const homeLink =
    siteUserId === null
      ? null
      : externalLink('站点主页', `${SITE_ORIGIN}/#/player/${siteUserId}`)

  const selfButton = siteUserId === null ? null : el('button', 'button', '我的成绩')
  if (selfButton) {
    selfButton.type = 'button'
    selfButton.title = '打开你自己账号的成绩页'
    selfButton.addEventListener('click', () => void openMyStats())
  }

  const headerActions = el('div', 'player-actions')
  if (homeLink) headerActions.append(homeLink)
  if (selfButton) headerActions.append(selfButton)
  headerActions.append(refreshButton, cancelButton)
  header.append(headerText, headerActions)

  // ---- 筛选 ----
  const softwareSelect = el('select', 'select')
  for (const option of SOFTWARE_OPTIONS) {
    const node = el('option', undefined, option.label)
    node.value = option.value
    softwareSelect.append(node)
  }

  function checkbox(label: string, title: string): { node: HTMLLabelElement; input: HTMLInputElement } {
    const wrapper = el('label', 'check')
    const input = el('input')
    input.type = 'checkbox'
    input.title = title
    wrapper.append(input, el('span', undefined, label))
    return { node: wrapper, input }
  }

  const nfCheck = checkbox('NF', '只看盲扫（网站按 right_ce = 0，CSV 按 style=NF）')
  const unapprovedCheck = checkbox('含未过审', '把未审核 / 冻结 / 标识不符 / 外部审核的录像也算进来')

  const filters = el('section', 'player-filters')
  const softwareField = el('label', 'filter')
  softwareField.append(el('span', 'filter-label', '软件'), softwareSelect)
  const nfLabel = nfCheck.node
  nfLabel.classList.add('filter')
  const unapprovedLabel = unapprovedCheck.node
  unapprovedLabel.classList.add('filter')
  filters.append(softwareField, nfLabel, unapprovedLabel)

  const notice = el('p', 'player-notice hidden')

  const status = el('p', 'player-status')
  status.setAttribute('role', 'status')
  const pbCount = el('span', 'source-note pb-count')
  pbCount.title = '仅用于成绩概况的 PB 筛选，不代表赛博大表的统计样本。'
  filters.append(pbCount)

  // ---- PB ----
  const pbTitle = el('h2', 'card-title', 'PB 表')
  const pbTabs = el('div', 'tabs')
  const pbTabButtons = new Map<PbStat, HTMLButtonElement>()
  for (const stat of PB_STATS) {
    const button = el('button', 'tab', PB_STAT_LABELS[stat])
    button.type = 'button'
    button.addEventListener('click', () => {
      state.pbStat = stat
      render()
    })
    pbTabButtons.set(stat, button)
    pbTabs.append(button)
  }

  const pbGrids = el('div', 'pb-grids')
  const pbLevels = new Map<Level, { grid: HTMLElement; empty: HTMLElement }>()
  for (const level of LEVELS) {
    const box = el('section', 'pb-level')
    box.append(el('h3', 'pb-level-title', LEVEL_LABELS[level]))
    const grid = el('div', 'pb-grid')
    const empty = el('p', 'pb-empty', '这个级别没有符合条件的录像')
    box.append(grid, empty)
    pbGrids.append(box)
    pbLevels.set(level, { grid, empty })
  }

  const pbCard = el('section', 'card')
  const pbCardHead = el('div', 'card-head')
  pbCardHead.append(pbTitle, pbTabs)
  pbCard.append(pbCardHead, pbGrids)

  // ---- 前端成绩 ----
  const topCard = el('section', 'card')
  const topHead = el('div', 'card-head')
  topHead.append(el('h2', 'card-title', '前端成绩（Top5）'))
  const topGrid = el('div', 'top5-grid')
  topCard.append(topHead, topGrid)

  const topTables: { nf: boolean; body: HTMLElement }[] = []
  for (const nf of [false, true]) {
    const box = el('div', 'top5-box')
    box.append(el('h3', 'top5-title', nf ? 'NF前端成绩' : '前端成绩'))
    const table = el('table', 'data-table top5-table')
    const head = el('thead')
    const headRow = el('tr')
    headRow.append(el('th', undefined, '等级'))
    for (const stat of ['time', 'bvs', 'stnb'] as TopStat[]) {
      headRow.append(el('th', undefined, STAT_LABELS[stat]))
    }
    head.append(headRow)
    const body = el('tbody')
    table.append(head, body)
    box.append(table)
    topGrid.append(box)
    topTables.push({ nf, body })
  }

  // ---- 页面骨架 ----
  const scoreTab = el('button', 'page-tab active', '成绩概况')
  scoreTab.type = 'button'
  const analysisTab = el('button', 'page-tab', '赛博大表')
  analysisTab.type = 'button'
  const pageTabs = el('div', 'page-tabs')
  pageTabs.append(scoreTab, analysisTab)

  const sourceBar = el('div', 'source-bar')
  const siteSource = el('button', 'source-tab active', '网站数据')
  const csvSource = el('button', 'source-tab', '本地 CSV')
  siteSource.type = 'button'
  csvSource.type = 'button'
  const csvInput = el('input', 'hidden')
  csvInput.type = 'file'
  csvInput.accept = '.csv,text/csv'
  csvInput.multiple = true
  sourceBar.append(siteSource, csvSource, csvInput)

  const csvFeedback = el('div', 'source-files hidden')
  const csvStatus = el('p')
  csvStatus.setAttribute('role', 'status')
  csvStatus.setAttribute('aria-live', 'polite')
  csvStatus.setAttribute('aria-atomic', 'true')
  const csvErrorDetails = el('details', 'hidden')
  csvFeedback.append(csvStatus, csvErrorDetails)

  // 独立 CSV 的空态：只有用户点击才打开文件选择器，不自动联网、不自动导入。
  const csvEmpty = el('section', 'csv-empty hidden')
  const csvEmptyTitle = el('h2', 'card-title', '本地 CSV 分析')
  const csvEmptyText = el(
    'p',
    'csv-empty-text',
    '首次使用选择一个或多个本地 CSV：扩展会记住这些文件，之后重新打开本页，点击「刷新」就能读取最新内容，不用每次重新选择。支持 Arbiter / 元扫雷 CSV 文件，多文件直接合并、不去重。',
  )
  const csvEmptyButton = el('button', 'button primary', '选择 CSV 文件')
  csvEmptyButton.type = 'button'
  const csvEmptyCancelButton = el('button', 'button hidden', '取消读取')
  csvEmptyCancelButton.type = 'button'
  const csvEmptyActions = el('div', 'csv-empty-actions')
  csvEmptyActions.append(csvEmptyButton, csvEmptyCancelButton)
  const csvEmptyNote = el('p', 'csv-empty-note hidden')
  const csvEmptyRemember = el(
    'p',
    'csv-empty-note csv-empty-remember hidden',
    '当前浏览器不支持记住文件，重新打开后需要再次选择。',
  )
  const csvEmptyFormat = el('details', 'csv-empty-format')
  csvEmptyFormat.append(
    el('summary', undefined, 'CSV 格式说明'),
    el('p', undefined, CSV_FORMAT_HINT),
  )
  csvEmpty.append(
    csvEmptyTitle,
    csvEmptyText,
    csvEmptyActions,
    csvEmptyNote,
    csvEmptyRemember,
    csvEmptyFormat,
  )

  // 关联清单：独立 CSV 页与普通玩家页的本地 CSV 模式共用。
  const csvPanel = el('section', 'csv-sources hidden')
  const csvPanelHead = el('div', 'csv-sources-head')
  const csvPanelTitle = el('h2', 'card-title', '本地 CSV 文件')
  const csvPanelActions = el('div', 'csv-source-actions')
  const csvAddButton = el('button', 'button', '添加 CSV')
  const csvRefreshButton = el('button', 'button primary', '刷新')
  const csvCancelButton = el('button', 'button hidden', '取消读取')
  const csvClearButton = el('button', 'button', '移除全部')
  for (const node of [csvAddButton, csvRefreshButton, csvCancelButton, csvClearButton]) {
    node.type = 'button'
  }
  csvPanelActions.append(csvAddButton, csvRefreshButton, csvCancelButton, csvClearButton)
  csvPanelHead.append(csvPanelTitle, csvPanelActions)
  const csvPanelNote = el('p', 'csv-sources-note')
  const csvList = el('ul', 'csv-source-list')
  csvPanel.append(csvPanelHead, csvPanelNote, csvList)

  const scorePane = el('div', 'player-pane')
  scorePane.append(filters, notice, pbCard, topCard)

  const analysisPane = el('div', 'player-pane hidden')
  const analysis = createAnalysisView({
    autoSiteAnchors: !standaloneCsv,
  })
  analysisPane.append(analysis.root)

  const wrap = el('main', 'player-page')
  if (embedded) wrap.classList.add('player-page-embedded')
  wrap.append(
    header,
    sourceBar,
    csvEmpty,
    csvPanel,
    csvFeedback,
    // 加载进度、失败原因和缺失明细提示由成绩概况与赛博大表共用，
    // 否则嵌入模式（只有大表）看不到任何加载状态。
    status,
    pageTabs,
    scorePane,
    analysisPane,
  )
  root.replaceChildren(wrap)

  const persistentCsv = canRememberCsvFiles()
  const session: CsvSession = createCsvSession({
    store: createCsvStore(persistentCsv),
    onChange: () => {
      if (source === 'csv') syncCsvSnapshot()
      renderHeaderIdentity()
      renderCsv()
      render()
    },
  })
  const offDbBlocked = onDbBlocked(() => {
    session.setMessage(
      '本地数据库需要升级但被其他页面占用：请关闭或刷新其他元神助手页面后重试。',
    )
  })

  // 清单恢复后、成绩尚未加载时，主区域只提示刷新，不把上次局数当作当前成绩。
  function csvWaiting(): boolean {
    return (
      source === 'csv' &&
      session.state.ready &&
      session.state.sources.length > 0 &&
      !session.hasSnapshot()
    )
  }

  function renderPage(): void {
    const empty =
      standaloneCsv && session.state.ready && session.state.sources.length === 0
    const waiting = csvWaiting()
    const hasSnapshot = source === 'site' ? state.updatedAt > 0 : session.hasSnapshot()
    sourceBar.classList.toggle('hidden', embedded || empty)
    pageTabs.classList.toggle('hidden', embedded || empty || waiting)
    csvEmpty.classList.toggle('hidden', !empty)
    csvPanel.classList.toggle(
      'hidden',
      embedded || !(source === 'csv' && session.state.sources.length > 0),
    )
    status.classList.toggle('hidden', source === 'csv' || (!state.loading && !status.textContent))
    scorePane.classList.toggle('hidden', !hasSnapshot || page !== 'score')
    analysisPane.classList.toggle('hidden', !hasSnapshot || page !== 'analysis')
    scoreTab.classList.toggle('active', page === 'score')
    analysisTab.classList.toggle('active', page === 'analysis')
    scoreTab.setAttribute('aria-pressed', String(page === 'score'))
    analysisTab.setAttribute('aria-pressed', String(page === 'analysis'))
  }

  function showPage(next: 'score' | 'analysis'): void {
    if (embedded && next === 'score') return
    page = next
    renderPage()
  }

  scoreTab.addEventListener('click', () => showPage('score'))
  analysisTab.addEventListener('click', () => showPage('analysis'))

  siteSource.addEventListener('click', () => {
    session.cancel()
    session.clearMessage()
    setSource('site')
  })
  csvSource.addEventListener('click', () => {
    void enterCsvSource()
  })
  csvEmptyButton.addEventListener('click', () => {
    const flow = invalidateCsvFlow()
    void selectCsvFiles({ kind: 'add', flow })
  })
  csvEmptyCancelButton.addEventListener('click', () => session.cancel())
  csvAddButton.addEventListener('click', () => {
    const flow = invalidateCsvFlow()
    void selectCsvFiles({ kind: 'add', flow })
  })
  csvRefreshButton.addEventListener('click', () => void session.refreshAll())
  csvCancelButton.addEventListener('click', () => session.cancel())
  csvClearButton.addEventListener('click', () => void removeAllCsv())
  csvInput.addEventListener('change', () => {
    const files = csvInput.files ? [...csvInput.files] : []
    csvInput.value = ''
    const context = pendingFileInput
    pendingFileInput = null
    // 没有有效的待处理上下文（例如切源后清掉标记）时直接丢弃晚到事件。
    if (!context || context.flow !== csvFlow) return
    void applyCsvSelection(context, files.map(fileHandle))
  })

  /** 降级模式：浏览器没有文件句柄 API，只能临时读取本次选择的 File。 */
  function fileHandle(file: File): CsvFileHandle {
    const handle = {
      name: file.name,
      file,
      getFile: async (): Promise<File> => file,
      queryPermission: async (): Promise<PermissionState> => 'granted',
      requestPermission: async (): Promise<PermissionState> => 'granted',
      isSameEntry: async (other: CsvFileHandle): Promise<boolean> =>
        (other as CsvFileHandle & { file?: File }).file === file,
    }
    return handle
  }

  function invalidateCsvFlow(): number {
    csvFlow += 1
    pendingFileInput = null
    return csvFlow
  }

  async function enterCsvSource(): Promise<void> {
    if (source === 'csv') return
    const flow = invalidateCsvFlow()
    if (!session.state.ready) await session.restore()
    if (flow !== csvFlow || source !== 'site') return
    if (session.state.sources.length === 0) {
      await selectCsvFiles({ kind: 'add', flow })
      return
    }
    setSource('csv')
  }

  /** 两种选择器与添加 / 重新关联共用同一上下文，晚到结果不能变成新操作。 */
  async function selectCsvFiles(selection: CsvSelection): Promise<void> {
    if (selection.flow !== csvFlow || session.state.loading) return
    if (!persistentCsv) {
      pendingFileInput = selection
      csvInput.multiple = selection.kind === 'add'
      csvInput.click()
      return
    }
    try {
      const handles = await pickCsvFiles(selection.kind === 'add')
      await applyCsvSelection(selection, handles)
    } catch (error) {
      if (selection.flow !== csvFlow || isAbortError(error)) return
      session.setMessage(`选择文件失败：${errorMessage(error)}`)
    }
  }

  async function applyCsvSelection(
    selection: CsvSelection,
    handles: CsvFileHandle[],
  ): Promise<void> {
    if (selection.flow !== csvFlow || handles.length === 0) return
    const result = selection.kind === 'add'
      ? await session.addFiles(handles)
      : await session.relink(selection.sourceId, handles[0]!)
    if (selection.flow !== csvFlow) return
    if (selection.kind === 'add' && result === 'success' && source === 'site') {
      setSource('csv')
    }
  }

  async function removeCsvSource(sourceId: string): Promise<void> {
    await session.removeSource(sourceId)
    if (session.state.sources.length === 0 && !standaloneCsv) setSource('site')
  }

  async function removeAllCsv(): Promise<void> {
    invalidateCsvFlow()
    await session.removeAll()
    if (!standaloneCsv) setSource('site')
  }

  function options() {
    return {
      software: source === 'csv' ? 'all' : state.software,
      nfOnly: state.nfOnly,
      includeUnapproved: source === 'site' && state.includeUnapproved,
    }
  }

  /** 只有快照内容变化时才重建分析，进度提示和按钮状态不触发重算。 */
  function syncCsvSnapshot(): void {
    if (source !== 'csv') return
    if (session.state.snapshotVersion === appliedSnapshot) return
    appliedSnapshot = session.state.snapshotVersion
    state.videos = session.videos()
    analysis.update(state.videos, { csv: true })
  }

  function rebuild(): void {
    if (source === 'csv') {
      syncCsvSnapshot()
      render()
      return
    }
    const metas = state.rows.map((row) => ({
      id: row.id,
      upload_time: row.uploadTime,
      state: row.state,
      ongoing_tournament: row.ongoing,
    }))
    const details = new Map(
      state.rows.filter((row) => row.detail !== null).map((row) => [row.id, row.detail!]),
    )
    const { videos } = joinVideos(metas, details)
    state.videos = videos
    analysis.update(videos, { csv: false })
    render()
  }

  function renderCsvList(): void {
    csvList.replaceChildren()
    const current = session.state
    const nameCount = new Map<string, number>()
    for (const record of current.sources) {
      nameCount.set(record.name, (nameCount.get(record.name) ?? 0) + 1)
    }
    current.sources.forEach((record, index) => {
      const item = el('li', 'csv-source')
      const main = el('div', 'csv-source-main')
      const duplicated = (nameCount.get(record.name) ?? 0) > 1
      const label = duplicated ? `${record.name}（来源 ${index + 1}）` : record.name
      main.append(el('span', 'csv-source-name', label))
      const summary = session.sourceSummary(record.sourceId)
      const loaded = current.loaded.has(record.sourceId)
      main.append(
        el(
          'span',
          'csv-source-meta',
          summary
            ? `${loaded ? '已读取' : '上次读取'} ${formatDateTime(summary.readAt)} · ${formatCount(summary.validCount)} 局 · ${formatCount(summary.invalidRows)} 行无效`
            : '尚未读取',
        ),
      )
      const delta = current.deltas.get(record.sourceId)
      if (delta) {
        main.append(el('span', 'csv-source-delta', formatValidDelta(delta.before, delta.after)))
      }
      if (current.needsPermission.includes(record.sourceId)) {
        main.append(el('span', 'csv-source-flag', '需要授权'))
      }
      const actions = el('div', 'csv-source-actions')
      if (current.needsPermission.includes(record.sourceId)) {
        actions.append(
          sourceButton('授权读取', `授权读取 ${label}`, current.loading, () =>
            void session.grant(record.sourceId),
          ),
        )
      }
      actions.append(
        sourceButton('重新关联', `重新关联 ${label}`, current.loading, () =>
          void selectCsvFiles({
            kind: 'relink', flow: invalidateCsvFlow(), sourceId: record.sourceId,
          }),
        ),
        sourceButton('移除', `移除 ${label}`, current.loading, () =>
          void removeCsvSource(record.sourceId),
        ),
      )
      item.append(main, actions)
      csvList.append(item)
    })
  }

  function sourceButton(
    text: string,
    title: string,
    disabled: boolean,
    onClick: () => void,
  ): HTMLButtonElement {
    const node = el('button', 'button small', text)
    node.type = 'button'
    node.title = title
    node.disabled = disabled
    node.addEventListener('click', onClick)
    return node
  }

  function renderCsvFeedback(): void {
    const current = session.state
    csvFeedback.classList.toggle('hidden', current.message === '')
    csvStatus.textContent = current.message
    csvErrorDetails.replaceChildren()
    csvErrorDetails.classList.toggle('hidden', current.errors.length === 0)
    if (current.errors.length === 0) return
    csvErrorDetails.append(
      el('summary', undefined, `查看 ${current.errors.length} 项解析问题`),
    )
    const list = el('ul')
    for (const error of current.errors.slice(0, 50)) list.append(el('li', undefined, error))
    csvErrorDetails.append(list)
    if (current.errors.length > 50) {
      csvErrorDetails.append(el('p', undefined, '仅显示前 50 项问题'))
    }
  }

  function renderCsv(): void {
    const current = session.state
    const csv = source === 'csv'
    csvAddButton.disabled = current.loading
    csvRefreshButton.disabled = current.loading || current.sources.length === 0
    csvRefreshButton.classList.toggle('hidden', current.loading)
    csvCancelButton.classList.toggle('hidden', !current.loading)
    csvClearButton.disabled = current.sources.length === 0
    csvEmptyButton.disabled = current.loading
    csvEmptyCancelButton.classList.toggle('hidden', !current.loading)
    csvEmptyNote.classList.toggle('hidden', !current.loading)
    csvEmptyNote.textContent = '正在读取选中的文件…'
    csvEmptyRemember.classList.toggle('hidden', persistentCsv)

    if (current.loading && current.progress) {
      csvPanelNote.textContent = `正在读取 ${current.progress.done}/${current.progress.total} 个文件…`
    } else if (csv && current.sources.length > 0 && !session.hasSnapshot()) {
      csvPanelNote.textContent = `已关联 ${current.sources.length} 个文件，点击「刷新」加载成绩。`
    } else if (csv && session.hasSnapshot()) {
      const last = Math.max(
        0,
        ...current.sources.map(
          (record) => session.sourceSummary(record.sourceId)?.readAt ?? 0,
        ),
      )
      csvPanelNote.textContent =
        `已加载 ${current.sources.length} 个文件、${formatCount(session.loadedCount())} 局` +
        (last > 0 ? ` · 上次读取 ${formatDateTime(last)}` : '')
    } else {
      csvPanelNote.textContent = ''
    }

    renderCsvList()
    renderCsvFeedback()
  }

  function renderHeaderIdentity(): void {
    const csv = source === 'csv'
    nameNode.textContent = csv ? '本地 CSV' : siteName
    idNode.textContent = csv ? `${session.state.sources.length} 个文件` : `ID ${siteUserId ?? ''}`
    document.title = standaloneCsv
      ? '本地 CSV · 元神助手'
      : `${nameNode.textContent} · 玩家数据 · 元神助手`
  }

  /** 数据源切换只控制同一页面里的控件显隐；启动模式决定的数据源固定为 CSV 时不再切回网站。 */
  function renderSourceUi(): void {
    const csv = source === 'csv'
    siteSource.classList.toggle('active', !csv)
    csvSource.classList.toggle('active', csv)
    siteSource.classList.toggle('hidden', standaloneCsv)
    csvSource.classList.toggle('hidden', standaloneCsv)
    softwareField.classList.toggle('hidden', csv)
    unapprovedLabel.classList.toggle('hidden', csv)
    refreshButton.classList.toggle('hidden', standaloneCsv || csv)
    homeLink?.classList.toggle('hidden', embedded)
    selfButton?.classList.toggle('hidden', embedded)
  }

  function setSource(next: 'site' | 'csv'): void {
    // 独立 CSV 启动固定本地数据源：即使内部误调用也不允许切回网站。
    if (standaloneCsv && next === 'site') return
    // 切源会让「恢复清单 → 选择文件 → 读取」整条视图流程失效。
    invalidateCsvFlow()
    if (source === next) {
      renderSourceUi()
      renderHeaderIdentity()
      renderCsv()
      renderPage()
      return
    }
    source = next
    const csv = next === 'csv'
    if (csv) {
      requestVersion += 1
      const previousController = controller
      controller = null
      pendingUnapproved = false
      previousController?.abort()
      state.loading = false
      appliedSnapshot = -1
    }
    renderSourceUi()
    renderHeaderIdentity()
    state.message = ''
    // 网站记录为空时也重建，避免在等待请求期间残留 CSV。
    rebuild()
    if (!csv) {
      if (state.rows.length === 0) void runLoad(false)
      else if (state.includeUnapproved) void loadUnapproved()
    }
  }

  function render(): void {
    const current = options()
    const counted = state.videos.filter((video) => eligible(video, current)).length
    if (standaloneCsv && source === 'csv' && session.state.sources.length === 0) {
      metaNode.textContent = '选择 CSV 文件开始本地分析'
    } else if (source === 'csv') {
      const records = session.state.sources
      const parts = session.hasSnapshot()
        ? [
            `CSV ${records.length} 个文件`,
            `录像 ${formatCount(state.videos.length)}`,
            `上次读取 ${formatDateTime(Math.max(0, ...records.map((record) => session.sourceSummary(record.sourceId)?.readAt ?? 0)))}`,
          ]
        : [`已关联 ${records.length} 个文件`, '尚未加载成绩']
      metaNode.textContent = parts.join(' · ')
    } else {
      const parts = [`录像 ${formatCount(state.rows.length)}`]
      if (state.updatedAt > 0) parts.push(`更新于 ${formatDateTime(state.updatedAt)}`)
      if (state.fromCache) parts.push('（缓存）')
      metaNode.textContent = parts.join(' · ')
    }
    pbCount.textContent = `PB 筛选计入 ${formatCount(counted)} 局`

    notice.classList.toggle('hidden', source !== 'site' || !state.includeUnapproved)
    notice.textContent =
      source === 'site' && state.includeUnapproved
        ? '含未过审：a 未审核 / b 冻结 / d 标识不符 / e 外部审核 都算进来了，成绩仅自用，和站点 PB 不再一致。'
        : ''

    refreshButton.disabled = state.loading || source === 'csv'
    cancelButton.classList.toggle('hidden', !state.loading || source === 'csv')
    status.textContent = state.message

    for (const stat of PB_STATS) {
      const button = pbTabButtons.get(stat)!
      button.classList.toggle('active', state.pbStat === stat)
      button.setAttribute('aria-pressed', String(state.pbStat === stat))
    }

    renderPb(current)
    renderTop(current)
    renderCsv()
    renderPage()
  }

  function pbMetric(video: Video, stat: TopStat): number {
    if (stat === 'time') return video.timems / 1000
    if (stat === 'bvs') return bvsOf(video)
    return stnbOf(video)
  }

  function pbCell(
    row: ReturnType<typeof computePb>[number] | undefined,
    dateRange?: { min: number; mid: number; max: number },
  ): HTMLElement {
    const cell = el('span', 'pb-cell')
    if (!row) return cell

    let text: string
    if (state.pbStat === 'date') {
      text = formatShortDate(row.video.end_time)
      const date = Date.parse(row.video.end_time ?? '')
      const style =
        dateRange && !Number.isNaN(date)
          ? dateColorStyle(date, dateRange.min, dateRange.mid, dateRange.max)
          : null
      if (style) {
        cell.classList.add('colored')
        cell.style.backgroundColor = style.backgroundColor
        cell.style.color = style.color
      }
    } else {
      const metric = pbMetric(row.video, state.pbStat)
      text = metric.toFixed(3)
      const style = pbColorStyle(row.level, state.pbStat, metric)
      if (style) {
        cell.classList.add('colored')
        cell.style.backgroundColor = style.backgroundColor
        cell.style.color = style.color
      }
    }

    const link = videoLink(row.video.id)
    link.textContent = text
    link.className = 'pb-link'

    const icon = softwareIcon(row.video.software)
    if (icon) cell.append(icon)
    cell.append(link)

    cell.title = [
      `3BV ${row.bv} · ${softwareLabel(row.video.software)}`,
      `用时 ${formatSeconds(row.video.timems)}`,
      `3BVS ${bvsOf(row.video).toFixed(3)} · STNB ${stnbOf(row.video).toFixed(3)}`,
      `结束 ${formatEndTime(row.video.end_time)}`,
      `录像 #${row.video.id}`,
    ].join('\n')
    return cell
  }

  /**
   * 每个等级一张网格：一行十个 3BV，行首标 0–9 / 10–19。
   * 只画有成绩的 3BV 覆盖到的行，不把 0 到 381 全铺开。
   */
  function renderPb(current: ReturnType<typeof options>): void {
    const rows = computePb(state.videos, current)
    const byLevel = new Map<Level, ReturnType<typeof computePb>>()
    for (const row of rows) {
      const bucket = byLevel.get(row.level)
      if (bucket) bucket.push(row)
      else byLevel.set(row.level, [row])
    }

    for (const level of LEVELS) {
      const list = (byLevel.get(level) ?? []).filter(
        (row) => Number.isSafeInteger(row.bv) && row.bv >= 1 && row.bv <= MAX_BV[level],
      )
      const view = pbLevels.get(level)!
      view.grid.replaceChildren()
      view.empty.classList.toggle('hidden', list.length > 0)
      view.grid.classList.toggle('hidden', list.length === 0)
      if (list.length === 0) continue

      const byBv = new Map(list.map((row) => [row.bv, row]))
      const dates = list
        .map((row) => Date.parse(row.video.end_time ?? ''))
        .filter((date) => !Number.isNaN(date) && date > 0)
        .sort((a, b) => a - b)
      const dateRange =
        dates.length < 2
          ? undefined
          : {
              min: dates[0] as number,
              mid: medianOf(dates),
              max: dates[dates.length - 1] as number,
            }
      const starts = [...new Set(list.map((row) => Math.floor(row.bv / 10) * 10))]

      view.grid.append(el('span', 'pb-corner'))
      for (let digit = 0; digit < 10; digit += 1) {
        view.grid.append(el('span', 'pb-head', String(digit)))
      }

      for (const start of starts) {
        view.grid.append(el('span', 'pb-rowlabel', `${start}–${start + 9}`))
        for (let bv = start; bv < start + 10; bv += 1) {
          view.grid.append(pbCell(byBv.get(bv), dateRange))
        }
      }
    }
  }

  function renderTop(current: ReturnType<typeof options>): void {
    const groups = computeTop5(
      state.videos,
      {
        includeUnapproved: current.includeUnapproved,
      },
      loadAnalysisSettings().bvFloors,
    )
    const index = new Map<string, Top5Group>()
    for (const group of groups) {
      index.set(`${group.nf ? 'nf' : 'std'}:${group.level}:${group.stat}`, group)
    }

    for (const { nf, body } of topTables) {
      body.replaceChildren()
      for (const level of LEVELS) {
        const tr = el('tr')
        tr.append(el('th', 'row-head', LEVEL_LABELS[level]))
        for (const stat of ['time', 'bvs', 'stnb'] as TopStat[]) {
          tr.append(top5Cell(index.get(`${nf ? 'nf' : 'std'}:${level}:${stat}`), stat))
        }
        body.append(tr)
      }
    }
  }

  function top5Cell(group: Top5Group | undefined, stat: TopStat): HTMLElement {
    const td = el('td', 'top5-cell')
    if (!group || group.rows.length === 0) {
      td.append(el('span', 'muted', '—'))
      return td
    }
    const list = el('ol', 'top5-list')
    for (const row of group.rows) {
      const li = el('li', 'top5-item')
      const label = stat === 'time' ? formatSeconds(row.video.timems) : row.value.toFixed(3)
      const link = videoLink(row.video.id)
      link.textContent = label
      link.classList.add('top5-value')
      link.title = `${label} · ${row.video.bv} 3BV`
      const meta = el('span', 'top5-meta', `${row.video.bv} 3BV · ${formatShortDate(row.video.end_time)}`)
      const icon = softwareIcon(row.video.software)
      if (icon) li.append(icon)
      li.append(link, meta)
      list.append(li)
    }
    td.append(list)
    return td
  }

  function setLoading(loading: boolean, text = ''): void {
    state.loading = loading
    status.textContent = text || state.message
    renderPage()
    refreshButton.disabled = loading
    cancelButton.classList.toggle('hidden', !loading)
    if (loading) cancelButton.textContent = '取消'
  }

  async function runLoad(force: boolean): Promise<void> {
    if (siteUserId === null || source === 'csv' || state.loading) return
    const localController = new AbortController()
    controller = localController
    const request = ++requestVersion
    const current = (): boolean => source === 'site' && request === requestVersion
    const messageAtStart = state.message
    state.message = ''
    setLoading(true, '正在获取录像列表…')
    try {
      const loaded = await loadPlayer(siteUserId, {
        force,
        signal: localController.signal,
        onProgress: ({ done, total }) => {
          if (current()) setLoading(true, `正在拉取明细：${done}/${total} 批`)
        },
      })
      if (!current()) return
      state.rows = loaded.rows
      state.updatedAt = loaded.fetchedAt
      state.fromCache = loaded.fromCache
      // 加载期间用户点了别的（比如「我的成绩」）就别把提示覆盖掉。
      if (state.message === '' || state.message === messageAtStart) {
        state.message =
          loaded.missing.length > 0 ? `${loaded.missing.length} 条录像的解析字段没取到` : ''
      }
      rebuild()
      setLoading(false)
    } catch (error) {
      if (!current()) return
      state.message = isAbortError(error) ? '已取消' : errorMessage(error)
      setLoading(false)
    } finally {
      if (current()) {
        controller = null
        if (pendingUnapproved && unapprovedCheck.input.checked) {
          pendingUnapproved = false
          void loadUnapproved()
        }
      }
    }
  }

  /** 读站点登录态（或手动填的 ID），跳到自己的成绩页。 */
  async function openMyStats(): Promise<void> {
    if (siteUserId === null || !selfButton) return
    selfButton.disabled = true
    try {
      let id = await resolveSelfId()
      if (id === null) id = await askSelfId(siteUserId)
      if (id === null) {
        state.message = '已取消'
        return
      }
      if (id === siteUserId) {
        state.message = '当前就是你的成绩页'
        return
      }
      location.href = `${location.pathname}?id=${id}`
      return
    } catch {
      state.message = '读取登录状态失败，请稍后重试'
    } finally {
      selfButton.disabled = false
      render()
    }
  }

  async function loadUnapproved(): Promise<void> {
    if (siteUserId === null || source === 'csv') return
    if (state.loading) {
      pendingUnapproved = true
      return
    }
    const ids = state.rows
      .filter((row) => row.state !== 'c' && !row.ongoing && row.detail === null)
      .map((row) => row.id)
    if (ids.length === 0) {
      pendingUnapproved = false
      return
    }

    const localController = new AbortController()
    controller = localController
    const request = ++requestVersion
    const current = (): boolean => source === 'site' && request === requestVersion
    const previous = state.message
    setLoading(true, `正在补抓未过审录像：0/${Math.ceil(ids.length / 100)} 批`)
    try {
      const result = await ensureDetails(siteUserId, state.rows, ids, {
        signal: localController.signal,
        onProgress: ({ done, total }) => {
          if (current()) setLoading(true, `正在补抓未过审录像：${done}/${total} 批`)
        },
      })
      if (!current()) return
      state.rows = result.rows
      state.message = previous
      rebuild()
      setLoading(false)
    } catch (error) {
      if (!current()) return
      state.message = isAbortError(error) ? '已取消' : errorMessage(error)
      setLoading(false)
    } finally {
      if (current()) {
        controller = null
        if (pendingUnapproved && unapprovedCheck.input.checked) {
          pendingUnapproved = false
          void loadUnapproved()
        }
      }
    }
  }

  softwareSelect.addEventListener('change', () => {
    state.software = softwareSelect.value
    render()
  })
  nfCheck.input.addEventListener('change', () => {
    state.nfOnly = nfCheck.input.checked
    render()
  })
  unapprovedCheck.input.addEventListener('change', () => {
    state.includeUnapproved = unapprovedCheck.input.checked
    render()
    if (state.includeUnapproved) void loadUnapproved()
  })
  refreshButton.addEventListener('click', () => void runLoad(true))
  cancelButton.addEventListener('click', () => {
    controller?.abort()
    cancelButton.textContent = '取消中…'
    cancelButton.disabled = true
    setTimeout(() => {
      cancelButton.disabled = false
      cancelButton.textContent = '取消'
    }, 1_000)
  })

  // 独立 CSV 先恢复关联清单（只读数据库，不读文件、不请求授权），再摆控件。
  if (standaloneCsv) await session.restore()

  const checkRegistryOnFocus = (): void => {
    if (source === 'csv' && session.state.ready) void session.checkRegistry()
  }
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('focus', checkRegistryOnFocus)
  }

  // 先按启动模式摆好控件与空态，再决定是否发起网站请求。
  setSource(launch.kind === 'csv' ? 'csv' : 'site')
  renderHeaderIdentity()
  // 网站模式等第一次加载结果再渲染，避免出现「更新于 1970」这类假状态。
  if (siteUserId !== null) {
    void runLoad(false)
    void loadSiteName()
  }

  // 嵌入页只向父页面报告“已就绪”，不带成绩、CSV、缓存或设置。
  if (embedded && siteUserId !== null && typeof window !== 'undefined') {
    window.parent.postMessage(
      { type: 'YUANSHEN_ANALYSIS_READY', v: 1, userId: siteUserId },
      '*',
    )
  }

  async function loadSiteName(): Promise<void> {
    if (siteUserId === null) return
    try {
      const info = await fetchUserInfo(siteUserId)
      if (!info) return
      siteName = info.username || info.realname || `#${siteUserId}`
      if (source === 'site') renderHeaderIdentity()
    } catch {
      // 名字拿不到不影响主流程。
    }
  }

  return {
    destroy(): void {
      requestVersion += 1
      controller?.abort()
      controller = null
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('focus', checkRegistryOnFocus)
      }
      offDbBlocked()
      invalidateCsvFlow()
      session.destroy()
      analysis.destroy()
    },
  }
}
