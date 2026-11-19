import { createAboutCard } from '../../shared/about-card'
import { SITE_ORIGIN } from '../../shared/constants'
import { formatCount, formatDateTime } from '../../shared/format'
import { getSettings, saveSettings } from '../../shared/settings'
import { brandLogo, el, errorMessage } from '../../shared/ui'
import { displayName } from '../user-search/model'
import type { UserRecord } from '../user-search/model'
import { getAllUsers } from '../user-search/db'
import { calculateRanking } from './calculation'
import {
  compileConfig,
  ConfigError,
  createDefaultConfig,
  exportConfig,
  importConfig,
  newMetricId,
  validateConfig,
} from './config'
import { compileFormula } from './expression/validate'
import { isFocusableControl } from './focus'
import {
  getRankingOverview,
  normalizeScanRange,
  RankingAbortError,
  RankingBusyError,
  RankingRangeError,
  startCollection,
  type CollectionMode,
  type CollectionProgress,
} from './collector'
import {
  RANK_FIELD_GROUPS,
  RANK_FIELDS,
} from './fields'
import {
  DEFAULT_RANK_PAGE_SIZE,
  RANK_LEVEL_LABELS,
  RANK_LEVELS,
  RANK_PAGE_SIZES,
  RANK_SOFTWARE_OPTIONS,
  RANK_STATE_LABELS,
  RANK_STRATEGY_VERSION,
  type GlobalRankDataset,
  type GlobalRankMeta,
  type GlobalRankTask,
  type RankConfig,
  type RankDirection,
  type RankFilter,
  type RankMetric,
  type RankingResult,
} from './model'
import {
  clearRankingCache,
  deleteConfig,
  deleteDataset,
  getRankingMeta,
  listConfigs,
  putConfig,
  putRankingMeta,
  restoreLatestToReady,
} from './store'
import {
  clearRankingSort,
  formatMetricValue,
  metricIndex,
  pageCount,
  pageRows,
  sortRankingResult,
} from './ranking'
import {
  buildRankSearchIndex,
  searchRankingEntries,
  type RankSearchEntry,
} from './ranking-search'
const PHASE_LABEL: Record<GlobalRankTask['phase'], string> = {
  initial: 'detailbulk 区间建库',
  sync: 'abstractbulk 区间同步',
  profiles: '玩家名称补全',
  supplement: '解析详情补齐',
  publish: '发布',
  discovery: '旧策略：玩家发现',
  indexing: '旧策略：录像索引',
  details: '旧策略：详情补齐',
}

/** 候选生成时的快照身份；点击晚到候选前必须复核，避免跳到旧页。 */
interface SearchContext {
  result: RankingResult
  pageSize: number
  namesRevision: number
}

function metricById(config: RankConfig, id: string): RankMetric | undefined {
  return config.metrics.find((metric) => metric.id === id)
}

function filterSummary(filter: RankFilter): string {
  const levels = filter.levels.map((level) => RANK_LEVEL_LABELS[level]).join(' / ')
  const states = filter.states.map((state) => RANK_STATE_LABELS[state] ?? state).join(' / ')
  const parts = [
    levels || '未选难度',
    `状态 ${states || '未选'}`,
    `模式 ${filter.modes.join(',') || '未填'}`,
    filter.software === 'all' ? '全部软件' : filter.software,
    filter.nf === 'all' ? 'NF 不限' : filter.nf === 'only' ? '只看 NF' : '排除 NF',
    `至少 ${filter.minGames} 局`,
  ]
  if (filter.from || filter.to) parts.push(`${filter.from || '起点不限'} ～ ${filter.to || '终点不限'}`)
  return parts.join(' · ')
}

function formatWait(ms: number): string {
  if (ms < 60_000) return `${Math.ceil(ms / 1000)} 秒`
  return `${(ms / 60_000).toFixed(1)} 分钟`
}

export async function mountGlobalRanking(root: HTMLElement): Promise<void> {
  document.title = '全站自定义排行榜 · 元神助手'
  root.replaceChildren()

  const baseSettings = await getSettings()
  let baseUrl = baseSettings.apiBase
  let pageSize = RANK_PAGE_SIZES.includes(baseSettings.rankingPageSize)
    ? baseSettings.rankingPageSize
    : DEFAULT_RANK_PAGE_SIZE
  let meta: GlobalRankMeta = await getRankingMeta(baseUrl)
  let configs: RankConfig[] = await listConfigs()
  let config: RankConfig =
    (meta.configId ? configs.find((item) => item.id === meta.configId) : undefined) ??
    configs[0] ??
    createDefaultConfig()
  let latest: GlobalRankDataset | null = null
  let ready: GlobalRankDataset | null = null
  let task: GlobalRankTask | null = null
  let result: RankingResult | null = null
  let resultConfig: {
    name: string
    filterText: string
    signature: string
  } | null = null
  let names = new Map<number, UserRecord>()
  let namesRevision = 0
  let page = 0
  let locatedPlayerId: number | null = null
  /** 删除当前排序列后临时改用可用列时显示提示；重新计算或显式排序后清空。 */
  let sortFallbackName: string | null = null
  let searchIndex: RankSearchEntry[] | null = null
  let searchIndexKey = ''
  let candidates: RankSearchEntry[] = []
  let candidateIndex = -1
  let candidateContext: SearchContext | null = null
  let collecting = false
  let controller: AbortController | null = null
  let calculating = false
  let notice: { text: string; error: boolean } | null = null
  let activeFormulaId: string | null = null
  let lastEstimate: number | null = null
  let validation = ''
  let settingsOpen = false
  let calculationSeq = 0
  let calculationController: AbortController | null = null
  let storageEstimate: { usage: number; quota: number } | null = null

  const pageNode = el('div', 'page ranking-page')
  const header = el('header', 'page-header')
  const brand = el('div', 'page-brand')
  const titles = el('div')
  titles.append(
    el('h1', undefined, '全站自定义排行榜'),
    el('p', undefined, '公开录像 · 自定义公式 · 本地计算'),
  )
  brand.append(brandLogo(), titles)
  const optionsLink = el('a', 'site-link', '控制台 ↗') as HTMLAnchorElement
  optionsLink.href = chrome.runtime.getURL('options.html')
  optionsLink.target = '_blank'
  optionsLink.rel = 'noreferrer'
  const uploadLink = el('a', 'site-link', '自动上传 ↗') as HTMLAnchorElement
  uploadLink.href = chrome.runtime.getURL('upload.html')
  uploadLink.target = '_blank'
  uploadLink.rel = 'noreferrer'
  const headerLinks = el('div', 'header-links')
  headerLinks.append(uploadLink, optionsLink)
  header.append(brand, headerLinks)

  const intro = el(
    'p',
    'ranking-intro',
    '按你保存的录像 ID 区间加载公开数据并保存到本机，再按自定义公式和排序方向计算玩家排行榜。首次填写结束 ID，之后同步直接复用；“扩大范围”才会覆盖新的结束 ID。采集需要保持本页打开，关闭后下次手动继续。榜单不应用本机“统计排除”。',
  )

  // ---------------- 数据集 ----------------
  const datasetCard = el('section', 'card ranking-dataset')
  const datasetHead = el('div', 'section-head')
  datasetHead.append(el('h2', undefined, '全站数据集'))
  const datasetStatus = el('span', 'ranking-status')
  datasetHead.append(datasetStatus)
  const datasetStage = el('p', 'ranking-stage')
  const datasetTimes = el('p', 'hint-text')
  const rangePanel = el('div', 'ranking-range-panel')
  const rangeStartLabel = el('label', 'ranking-field')
  rangeStartLabel.append(el('span', 'filter-label', '起始 ID'))
  const startIdInput = el('input', 'text-input') as HTMLInputElement
  startIdInput.type = 'number'
  startIdInput.min = '1'
  startIdInput.step = '1'
  startIdInput.placeholder = '1'
  rangeStartLabel.append(startIdInput)
  const rangeEndLabel = el('label', 'ranking-field')
  rangeEndLabel.append(el('span', 'filter-label', '结束 ID'))
  const endIdInput = el('input', 'text-input') as HTMLInputElement
  endIdInput.type = 'number'
  endIdInput.min = '1'
  endIdInput.step = '1'
  endIdInput.placeholder = '例如 900000'
  rangeEndLabel.append(endIdInput)
  const rangeHint = el('p', 'hint-text')
  rangePanel.append(rangeStartLabel, rangeEndLabel, rangeHint)
  const datasetGrid = el('div', 'ranking-stats')
  const statNodes: Record<string, HTMLElement> = {}
  for (const key of ['玩家', '目标录像', '解析完成', '缺失详情', '区间完成']) {
    const block = el('div', 'ranking-stat')
    const value = el('strong', undefined, '0')
    block.append(value, el('span', undefined, key))
    datasetGrid.append(block)
    statNodes[key] = value
  }
  const datasetProgress = el('progress', 'progress') as HTMLProgressElement
  datasetProgress.max = 100
  datasetProgress.value = 0
  const datasetProgressText = el('p', 'hint-text')
  const datasetActions = el('div', 'actions')
  const startButton = el('button', 'button primary', '开始加载') as HTMLButtonElement
  startButton.type = 'button'
  const pauseButton = el('button', 'button', '暂停') as HTMLButtonElement
  pauseButton.type = 'button'
  const restartButton = el('button', 'button', '重新建库') as HTMLButtonElement
  restartButton.type = 'button'
  const expandButton = el('button', 'button', '扩大范围') as HTMLButtonElement
  expandButton.type = 'button'
  const calculateButton = el('button', 'button', '计算排行榜') as HTMLButtonElement
  calculateButton.type = 'button'
  const calculatePartialButton = el('button', 'button', '计算当前部分数据') as HTMLButtonElement
  calculatePartialButton.type = 'button'
  calculatePartialButton.hidden = true
  calculatePartialButton.addEventListener('click', () => void calculate('latest'))
  const cancelCalculationButton = el('button', 'button', '取消计算') as HTMLButtonElement
  cancelCalculationButton.type = 'button'
  cancelCalculationButton.hidden = true
  cancelCalculationButton.addEventListener('click', () => {
    calculationController?.abort()
  })
  const deleteTaskButton = el('button', 'button danger', '删除未完成任务') as HTMLButtonElement
  deleteTaskButton.type = 'button'
  const clearCacheButton = el('button', 'button danger', '清空全站缓存') as HTMLButtonElement
  clearCacheButton.type = 'button'
  datasetActions.append(
    startButton,
    pauseButton,
    expandButton,
    restartButton,
    deleteTaskButton,
    clearCacheButton,
  )
  const noticeEl = el('p', 'notice ranking-notice')
  noticeEl.setAttribute('role', 'status')
  datasetCard.append(
    datasetHead,
    datasetStage,
    datasetTimes,
    rangePanel,
    datasetGrid,
    datasetProgress,
    datasetProgressText,
    datasetActions,
    noticeEl,
  )

  // ---------------- 筛选 ----------------
  const filterCard = el('section', 'card')
  filterCard.append(
    el('h2', undefined, '全局筛选'),
    el('p', 'desc', '先筛选本次公式统计的录像；改变筛选只重算本地数据，不重新采集。'),
  )
  const filterGrid = el('div', 'ranking-filter-grid')
  const levelInputs: Array<[RankFilter['levels'][number], HTMLInputElement]> = []
  const levelBox = el('div', 'ranking-checkbox-group')
  levelBox.append(el('span', 'filter-label', '难度'))
  for (const level of RANK_LEVELS) {
    const label = el('label', 'checkbox-row')
    const input = el('input') as HTMLInputElement
    input.type = 'checkbox'
    input.value = level
    input.addEventListener('change', () => {
      config.filter.levels = levelInputs.filter(([, item]) => item.checked).map(([key]) => key)
    })
    levelInputs.push([level, input])
    label.append(input, el('span', undefined, RANK_LEVEL_LABELS[level]))
    levelBox.append(label)
  }
  filterGrid.append(levelBox)

  const stateInputs: Array<[RankFilter['states'][number], HTMLInputElement]> = []
  const stateBox = el('div', 'ranking-checkbox-group')
  stateBox.append(el('span', 'filter-label', '审核状态'))
  for (const [state, labelText] of Object.entries(RANK_STATE_LABELS)) {
    const label = el('label', 'checkbox-row')
    const input = el('input') as HTMLInputElement
    input.type = 'checkbox'
    input.value = state
    input.addEventListener('change', () => {
      config.filter.states = stateInputs
        .filter(([, item]) => item.checked)
        .map(([key]) => key as RankFilter['states'][number])
    })
    stateInputs.push([state as RankFilter['states'][number], input])
    label.append(input, el('span', undefined, labelText))
    stateBox.append(label)
  }
  filterGrid.append(stateBox)

  const modeRow = el('label', 'ranking-field')
  modeRow.append(el('span', 'filter-label', '模式'))
  const modeInput = el('input', 'text-input') as HTMLInputElement
  modeInput.placeholder = '00，多个用逗号分隔'
  modeInput.addEventListener('input', () => {
    config.filter.modes = modeInput.value
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  })
  modeRow.append(modeInput)
  filterGrid.append(modeRow)

  const softwareRow = el('label', 'ranking-field')
  softwareRow.append(el('span', 'filter-label', '软件'))
  const softwareInput = el('select', 'select') as HTMLSelectElement
  for (const item of RANK_SOFTWARE_OPTIONS) {
    const option = el('option', undefined, item.label) as HTMLOptionElement
    option.value = item.value
    softwareInput.append(option)
  }
  softwareInput.addEventListener('change', () => {
    config.filter.software = softwareInput.value
  })
  softwareRow.append(softwareInput)
  filterGrid.append(softwareRow)

  const nfRow = el('label', 'ranking-field')
  nfRow.append(el('span', 'filter-label', 'NF'))
  const nfInput = el('select', 'select') as HTMLSelectElement
  for (const [value, text] of [
    ['all', '不限'],
    ['only', '只看 NF'],
    ['exclude', '排除 NF'],
  ] as const) {
    const option = el('option', undefined, text) as HTMLOptionElement
    option.value = value
    nfInput.append(option)
  }
  nfInput.addEventListener('change', () => {
    config.filter.nf = nfInput.value as RankFilter['nf']
  })
  nfRow.append(nfInput)
  filterGrid.append(nfRow)

  const fromRow = el('label', 'ranking-field')
  fromRow.append(el('span', 'filter-label', '开始日期'))
  const fromInput = el('input', 'text-input') as HTMLInputElement
  fromInput.type = 'date'
  fromInput.addEventListener('change', () => {
    config.filter.from = fromInput.value
  })
  fromRow.append(fromInput)
  filterGrid.append(fromRow)

  const toRow = el('label', 'ranking-field')
  toRow.append(el('span', 'filter-label', '结束日期'))
  const toInput = el('input', 'text-input') as HTMLInputElement
  toInput.type = 'date'
  toInput.addEventListener('change', () => {
    config.filter.to = toInput.value
  })
  toRow.append(toInput)
  filterGrid.append(toRow)

  const floorBox = el('div', 'ranking-floor-row')
  floorBox.append(el('span', 'filter-label', '3BV 下限'))
  const floorInputs: Record<string, HTMLInputElement> = {}
  for (const level of RANK_LEVELS) {
    const label = el('label', 'ranking-mini-field')
    const input = el('input', 'text-input') as HTMLInputElement
    input.type = 'number'
    input.min = '0'
    input.addEventListener('input', () => {
      const value = Number(input.value)
      config.filter.floors[level] = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
    })
    floorInputs[level] = input
    label.append(el('span', undefined, RANK_LEVEL_LABELS[level]), input)
    floorBox.append(label)
  }
  filterGrid.append(floorBox)

  const minRow = el('label', 'ranking-field')
  minRow.append(el('span', 'filter-label', '最少局数'))
  const minInput = el('input', 'text-input') as HTMLInputElement
  minInput.type = 'number'
  minInput.min = '1'
  minInput.addEventListener('input', () => {
    const value = Number(minInput.value)
    config.filter.minGames = Number.isFinite(value) && value > 0 ? Math.floor(value) : 1
  })
  minRow.append(minInput)
  filterGrid.append(minRow)
  const filterSummaryEl = el('p', 'hint-text')
  const refreshFilterSummary = (): void => {
    filterSummaryEl.textContent = filterSummary(config.filter)
  }
  filterGrid.addEventListener('change', () => {
    refreshFilterSummary()
    invalidateCalculation()
  })
  filterGrid.addEventListener('input', () => {
    refreshFilterSummary()
    invalidateCalculation()
  })
  filterCard.append(filterGrid, filterSummaryEl)

  // ---------------- 指标 ----------------
  const metricsCard = el('section', 'card')
  const metricsHead = el('div', 'section-head')
  metricsHead.append(el('h2', undefined, '指标与排序'))
  const configControls = el('div', 'ranking-config-controls')
  const configSelect = el('select', 'select') as HTMLSelectElement
  configSelect.addEventListener('change', () => {
    const selected = configs.find((item) => item.id === configSelect.value)
    if (selected) {
      config = JSON.parse(JSON.stringify(selected)) as RankConfig
      syncAllInputs()
      renderMetrics()
      invalidateCalculation()
      page = 0
      clearLocated()
      sortFallbackName = null
      closeCandidates()
      searchFeedback.textContent = ''
      renderResults()
    }
  })
  const configName = el('input', 'text-input') as HTMLInputElement
  configName.placeholder = '配置名称'
  configName.addEventListener('input', () => {
    config.name = configName.value
    if (resultConfig) resultConfig.name = config.name
    renderResults()
    if (calculating) {
      resultNotice.hidden = false
      resultNotice.textContent = '正在本地计算…'
    }
  })
  const saveConfigButton = el('button', 'button', '保存配置') as HTMLButtonElement
  saveConfigButton.type = 'button'
  const newConfigButton = el('button', 'button', '新建') as HTMLButtonElement
  newConfigButton.type = 'button'
  const deleteConfigButton = el('button', 'button danger', '删除配置') as HTMLButtonElement
  deleteConfigButton.type = 'button'
  const importButton = el('button', 'button', '导入') as HTMLButtonElement
  importButton.type = 'button'
  const exportButton = el('button', 'button', '导出') as HTMLButtonElement
  exportButton.type = 'button'
  configControls.append(configSelect, configName, saveConfigButton, newConfigButton, deleteConfigButton, importButton, exportButton)
  const defaultSortRow = el('div', 'ranking-field ranking-default-sort')
  defaultSortRow.append(el('span', 'filter-label', '默认排序指标'))
  const defaultSortSelect = el('select', 'select ranking-default-sort-select') as HTMLSelectElement
  defaultSortSelect.addEventListener('change', () => {
    config.defaultSortMetricId = defaultSortSelect.value || null
    applyDefaultSortToResult()
  })
  defaultSortRow.append(defaultSortSelect)
  const metricsList = el('div', 'ranking-metrics')
  const metricFormulaInputs = new Map<string, HTMLInputElement>()
  const metricFormulaErrors = new Map<string, HTMLElement>()
  const metricActions = el('div', 'actions')
  const addMetricButton = el('button', 'button', '添加指标') as HTMLButtonElement
  addMetricButton.type = 'button'
  const templateSelect = el('select', 'select') as HTMLSelectElement
  for (const [value, text] of [
    ['max(bv / time)', '最高 3BVS'],
    ['avg(bv / cl)', '平均 IOE'],
    ['sum(bv) / sum(cl)', '3BV / 点击'],
    ['avg(if(level == "e", time, null))', '高级平均用时'],
    ['count()', '局数'],
  ] as const) {
    const option = el('option', undefined, text) as HTMLOptionElement
    option.value = value
    templateSelect.append(option)
  }
  const addTemplateButton = el('button', 'button', '按模板添加') as HTMLButtonElement
  addTemplateButton.type = 'button'
  metricActions.append(addMetricButton, templateSelect, addTemplateButton)
  filterGrid.addEventListener('input', invalidateCalculation)
  filterGrid.addEventListener('change', invalidateCalculation)
  const metricsHelp = el('p', 'hint-text', '字段只能放在聚合函数参数内，例如 max(bv / time)。指标顺序只决定列顺序；点击表头只切换排序指标，排序方向在该指标的设置中修改。')
  const validationEl = el('p', 'notice error')
  metricsCard.append(metricsHead, configControls, defaultSortRow, metricsList, metricActions, metricsHelp, validationEl)

  const help = el('details', 'card ranking-fields-help')
  help.append(el('summary', undefined, '字段帮助与插入'))
  const helpIntro = el(
    'p',
    'hint-text',
    '点击字段会插入到当前聚焦的公式末尾。null 参与算术仍为 null；用 isNull(expr) 做空值判断。',
  )
  help.append(helpIntro)
  for (const group of RANK_FIELD_GROUPS) {
    const block = el('div', 'ranking-field-group')
    block.append(el('h3', undefined, group))
    const row = el('div', 'ranking-field-buttons')
    for (const field of RANK_FIELDS.filter((item) => item.group === group)) {
      const button = el('button', 'button small', `${field.label} (${field.key})`) as HTMLButtonElement
      button.type = 'button'
      button.title = `${field.key} · ${field.label} · ${field.type}${field.unit ? ` · ${field.unit}` : ''} · ${field.nullable ? '可空' : '非空'} · ${field.description}`
      button.addEventListener('click', () => insertField(field.key))
      row.append(button)
    }
    block.append(row)
    help.append(block)
  }

  // ---------------- 配置侧栏 ----------------
  const settingsToggle = el('button', 'button ranking-settings-toggle', '筛选与指标设置')
  settingsToggle.type = 'button'
  settingsToggle.setAttribute('aria-expanded', 'false')
  settingsToggle.setAttribute('aria-controls', 'ranking-settings')
  const settingsSidebar = el('aside', 'ranking-sidebar')
  settingsSidebar.id = 'ranking-settings'
  settingsSidebar.hidden = true
  settingsSidebar.setAttribute('aria-label', '筛选与指标设置')
  const settingsHead = el('div', 'ranking-sidebar-head')
  settingsHead.append(el('h2', undefined, '筛选与指标设置'))
  const settingsClose = el('button', 'icon-button', '×')
  settingsClose.type = 'button'
  settingsClose.title = '关闭设置'
  settingsClose.setAttribute('aria-label', '关闭筛选与指标设置')
  settingsHead.append(settingsClose)
  settingsSidebar.append(settingsHead, filterCard, metricsCard, help)

  // ---------------- 结果 ----------------
  const resultsCard = el('section', 'card ranking-results')
  const resultsHead = el('div', 'section-head')
  resultsHead.append(el('h2', undefined, '排行榜'))
  const resultActions = el('div', 'ranking-result-actions')
  resultActions.append(
    settingsToggle,
    calculateButton,
    calculatePartialButton,
    cancelCalculationButton,
  )
  const resultSummary = el('span', 'muted ranking-result-summary')
  resultsHead.append(resultSummary, resultActions)
  const resultConfigLine = el('p', 'ranking-result-config')
  const resultScopeLine = el('p', 'ranking-result-scope')
  const resultNotice = el('p', 'hint-text')
  const searchBar = el('div', 'ranking-search')
  const searchRow = el('div', 'ranking-search-row')
  const searchLabel = el('label', 'filter-label', '定位玩家')
  searchLabel.setAttribute('for', 'ranking-search-input')
  const searchInput = el('input', 'text-input ranking-search-input') as HTMLInputElement
  searchInput.id = 'ranking-search-input'
  searchInput.type = 'text'
  searchInput.placeholder = '输入玩家名称或 ID'
  searchInput.setAttribute('role', 'combobox')
  searchInput.setAttribute('aria-autocomplete', 'list')
  searchInput.setAttribute('aria-expanded', 'false')
  searchInput.setAttribute('aria-controls', 'ranking-search-options')
  const clearSearchButton = el('button', 'icon-button ranking-search-clear', '×') as HTMLButtonElement
  clearSearchButton.type = 'button'
  clearSearchButton.title = '清空搜索'
  clearSearchButton.setAttribute('aria-label', '清空搜索')
  searchRow.append(searchLabel, searchInput, clearSearchButton)
  const candidateList = el('ul', 'ranking-search-options')
  candidateList.id = 'ranking-search-options'
  candidateList.setAttribute('role', 'listbox')
  candidateList.setAttribute('aria-label', '玩家候选')
  candidateList.hidden = true
  const searchFeedback = el('p', 'ranking-search-feedback')
  searchFeedback.setAttribute('role', 'status')
  searchFeedback.setAttribute('aria-live', 'polite')
  searchBar.append(searchRow, candidateList, searchFeedback)
  const resultTableWrap = el('div', 'table-scroll')
  const resultTable = el('table', 'data-table ranking-table')
  const resultHeadRow = el('thead')
  const resultBody = el('tbody')
  resultTable.append(resultHeadRow, resultBody)
  resultTableWrap.append(resultTable)
  const pager = el('div', 'ranking-pager')
  const pageSizeLabel = el('label', 'ranking-page-size')
  pageSizeLabel.append(el('span', 'filter-label', '每页'))
  const pageSizeSelect = el('select', 'select ranking-page-size-select') as HTMLSelectElement
  for (const size of RANK_PAGE_SIZES) {
    const option = el('option', undefined, String(size)) as HTMLOptionElement
    option.value = String(size)
    pageSizeSelect.append(option)
  }
  pageSizeSelect.value = String(pageSize)
  pageSizeLabel.append(pageSizeSelect)
  const prevButton = el('button', 'button', '上一页') as HTMLButtonElement
  prevButton.type = 'button'
  const nextButton = el('button', 'button', '下一页') as HTMLButtonElement
  nextButton.type = 'button'
  const pageText = el('span', 'hint-text ranking-pager-text')
  pager.append(pageSizeLabel, prevButton, pageText, nextButton)
  resultsCard.append(
    resultsHead,
    resultConfigLine,
    resultScopeLine,
    resultNotice,
    searchBar,
    resultTableWrap,
    pager,
  )

  const detailsCard = el('details', 'card ranking-diagnostics')
  detailsCard.append(el('summary', undefined, '诊断与完整性'))
  const detailsContent = el('div')
  detailsCard.append(detailsContent)

  const about = createAboutCard()
  const mainColumn = el('div', 'ranking-main')
  mainColumn.append(resultsCard, datasetCard, detailsCard, about)
  const settingsBackdrop = el('div', 'ranking-sidebar-backdrop')
  settingsBackdrop.hidden = true
  settingsBackdrop.addEventListener('click', () => closeSettings())
  const contentLayout = el('div', 'ranking-content')
  contentLayout.append(mainColumn, settingsBackdrop, settingsSidebar)
  pageNode.append(header, intro, contentLayout)
  root.append(pageNode)

  // ---------------- 绑定 ----------------
  startButton.addEventListener('click', () => void start('primary'))
  settingsToggle.addEventListener('click', () => toggleSettings())
  settingsClose.addEventListener('click', () => closeSettings())
  document.addEventListener('keydown', handleSettingsKeydown)
  window.addEventListener('resize', syncSettingsMode)
  startIdInput.addEventListener('input', renderDataset)
  endIdInput.addEventListener('input', renderDataset)
  pauseButton.addEventListener('click', () => pause())
  expandButton.addEventListener('click', () => void start('expand'))
  restartButton.addEventListener('click', () => void start('rebuild'))
  calculateButton.addEventListener('click', () => void calculate('primary'))
  deleteTaskButton.addEventListener('click', () => void removeIncomplete())
  clearCacheButton.addEventListener('click', () => void clearCache())
  saveConfigButton.addEventListener('click', () => void saveConfig())
  newConfigButton.addEventListener('click', () => void createConfig())
  deleteConfigButton.addEventListener('click', () => void removeConfig())
  addMetricButton.addEventListener('click', () => addMetric())
  addTemplateButton.addEventListener('click', () => addMetric(templateSelect.value))
  importButton.addEventListener('click', () => void importFile())
  exportButton.addEventListener('click', () => downloadConfig())
  prevButton.addEventListener('click', () => {
    page = Math.max(0, page - 1)
    clearLocated()
    closeCandidates()
    searchFeedback.textContent = ''
    renderResults()
  })
  nextButton.addEventListener('click', () => {
    if (!result) return
    page = Math.min(Math.max(0, pageCount(result.rows, pageSize) - 1), page + 1)
    clearLocated()
    closeCandidates()
    searchFeedback.textContent = ''
    renderResults()
  })
  pageSizeSelect.addEventListener('change', () => {
    const selected = Number(pageSizeSelect.value)
    pageSize = RANK_PAGE_SIZES.includes(selected) ? selected : DEFAULT_RANK_PAGE_SIZE
    pageSizeSelect.value = String(pageSize)
    page = 0
    clearLocated()
    closeCandidates()
    searchFeedback.textContent = ''
    renderResults()
    void saveSettings({ rankingPageSize: pageSize })
      .then(() => setNotice(`每页显示已设为 ${pageSize} 位玩家`))
      .catch(() => setNotice('每页数量保存失败，当前会话仍按所选数量显示', true))
  })
  searchInput.addEventListener('input', updateCandidates)
  searchInput.addEventListener('keydown', handleSearchKeydown)
  clearSearchButton.addEventListener('click', () => {
    searchInput.value = ''
    closeCandidates()
    searchFeedback.textContent = ''
    searchInput.focus()
  })
  const beforeUnload = (): void => {
    controller?.abort()
    calculationController?.abort()
  }
  window.addEventListener('beforeunload', beforeUnload)

  await loadAll()
  if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
    void navigator.storage
      .estimate()
      .then((value) => {
        storageEstimate = { usage: value.usage ?? 0, quota: value.quota ?? 0 }
        renderDiagnostics()
      })
      .catch(() => {})
  }
  syncAllInputs()
  renderMetrics()
  render()

  async function loadAll(): Promise<void> {
    names = new Map((await getAllUsers()).map((record) => [record.id, record]))
    namesRevision += 1
    closeCandidates()
    configs = await listConfigs()
    meta = await getRankingMeta(baseUrl)
    if (!configs.some((item) => item.id === config.id)) {
      const saved = configs.find((item) => item.id === meta.configId) ?? configs[0]
      if (saved) config = JSON.parse(JSON.stringify(saved)) as RankConfig
    }
    const overview = await getRankingOverview(baseUrl)
    meta = overview.meta
    latest = overview.latest
    ready = overview.ready
    task = overview.task
    startIdInput.value = String(meta.startId || 1)
    if (meta.endId > 0) endIdInput.value = String(meta.endId)
  }

  async function refreshOverview(): Promise<void> {
    const overview = await getRankingOverview(baseUrl)
    meta = overview.meta
    latest = overview.latest
    ready = overview.ready
    task = overview.task
  }

  function setNotice(text: string, isError = false): void {
    notice = { text, error: isError }
    renderNotice()
  }

  function renderNotice(): void {
    noticeEl.textContent = notice?.text ?? ''
    noticeEl.classList.toggle('error', Boolean(notice?.error))
    noticeEl.hidden = !notice
  }

  function narrowSettings(): boolean {
    return typeof window !== 'undefined' && (window.innerWidth ?? 9999) <= 900
  }

  function syncSettingsMode(): void {
    if (!settingsOpen) {
      contentLayout.classList.remove('has-sidebar')
      settingsBackdrop.hidden = true
      return
    }
    contentLayout.classList.add('has-sidebar')
    const narrow = narrowSettings()
    settingsSidebar.classList.toggle('is-modal', narrow)
    settingsSidebar.setAttribute('role', narrow ? 'dialog' : 'region')
    if (narrow) settingsSidebar.setAttribute('aria-modal', 'true')
    else settingsSidebar.removeAttribute('aria-modal')
    settingsBackdrop.hidden = !narrow
    document.body?.classList.toggle('ranking-settings-open', narrow)
  }

  function settingsFocusableControls(): HTMLElement[] {
    return [
      ...settingsSidebar.querySelectorAll<HTMLElement>(
        'summary, button, input, select, textarea, a[href]',
      ),
    ].filter(isFocusableControl)
  }

  function focusFirstSettingsControl(): void {
    const focusable = settingsFocusableControls()
    ;(focusable[0] ?? settingsClose).focus()
  }

  function openSettings(): void {
    if (settingsOpen) return
    settingsOpen = true
    settingsSidebar.hidden = false
    settingsToggle.setAttribute('aria-expanded', 'true')
    syncSettingsMode()
    focusFirstSettingsControl()
  }

  function closeSettings(): void {
    if (!settingsOpen) return
    settingsOpen = false
    settingsSidebar.hidden = true
    contentLayout.classList.remove('has-sidebar')
    settingsSidebar.classList.remove('is-modal')
    settingsSidebar.removeAttribute('aria-modal')
    settingsBackdrop.hidden = true
    document.body?.classList.remove('ranking-settings-open')
    settingsToggle.setAttribute('aria-expanded', 'false')
    settingsToggle.focus()
  }

  function toggleSettings(): void {
    if (settingsOpen) closeSettings()
    else openSettings()
  }

  function handleSettingsKeydown(event: KeyboardEvent): void {
    if (!settingsOpen) return
    if (event.key === 'Escape') {
      event.preventDefault()
      closeSettings()
      return
    }
    if (!narrowSettings() || event.key !== 'Tab') return
    const focusable = settingsFocusableControls()
    if (focusable.length === 0) return
    const first = focusable[0]!
    const last = focusable[focusable.length - 1]!
    const active = document.activeElement
    if (event.shiftKey && (active === first || !settingsSidebar.contains(active))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (active === last || !settingsSidebar.contains(active))) {
      event.preventDefault()
      first.focus()
    }
  }

  function clearLocated(): void {
    locatedPlayerId = null
  }

  function currentSearchContext(): SearchContext | null {
    return result ? { result, pageSize, namesRevision } : null
  }

  function isSearchContextValid(context: SearchContext): boolean {
    const current = currentSearchContext()
    return (
      current !== null &&
      current.result === context.result &&
      current.pageSize === context.pageSize &&
      current.namesRevision === context.namesRevision
    )
  }

  function closeCandidates(): void {
    candidates = []
    candidateIndex = -1
    candidateContext = null
    candidateList.replaceChildren()
    candidateList.hidden = true
    searchInput.setAttribute('aria-expanded', 'false')
    searchInput.removeAttribute('aria-activedescendant')
  }

  function ensureSearchIndex(): RankSearchEntry[] {
    const key = [
      result?.computedAt ?? 0,
      result?.rows.length ?? 0,
      result?.sortMetricId ?? '',
      result?.direction ?? '',
      namesRevision,
    ].join('|')
    if (!searchIndex || searchIndexKey !== key) {
      searchIndex = result ? buildRankSearchIndex(result.rows, names) : []
      searchIndexKey = key
    }
    return searchIndex
  }

  function renderCandidates(): void {
    candidateList.replaceChildren()
    for (let index = 0; index < candidates.length; index += 1) {
      const entry = candidates[index]!
      const item = el('li', 'ranking-search-option')
      item.id = `ranking-search-option-${entry.playerId}`
      item.setAttribute('role', 'option')
      item.setAttribute('aria-selected', index === candidateIndex ? 'true' : 'false')
      item.append(
        el('span', 'ranking-search-name', entry.name || '—'),
        el('span', 'ranking-player-id', `ID ${entry.playerId}`),
        el('span', 'ranking-search-rank', entry.rank === null ? '名次 —' : `第 ${entry.rank} 名`),
      )
      item.addEventListener('click', () => {
        if (candidateContext) selectCandidate(entry, candidateContext)
      })
      candidateList.append(item)
    }
    candidateList.hidden = candidates.length === 0
    searchInput.setAttribute('aria-expanded', candidates.length > 0 ? 'true' : 'false')
    const active = candidates[candidateIndex]
    if (active) {
      searchInput.setAttribute('aria-activedescendant', `ranking-search-option-${active.playerId}`)
    } else {
      searchInput.removeAttribute('aria-activedescendant')
    }
  }

  function updateCandidates(): void {
    const query = searchInput.value
    if (!query.trim()) {
      closeCandidates()
      searchFeedback.textContent = ''
      return
    }
    if (!result || result.rows.length === 0) {
      closeCandidates()
      searchFeedback.textContent = '当前排行榜暂无数据可定位'
      return
    }
    const matches = searchRankingEntries(ensureSearchIndex(), query)
    candidates = matches.candidates
    candidateIndex = candidates.length > 0 ? 0 : -1
    candidateContext = currentSearchContext()
    renderCandidates()
    if (candidates.length === 0) searchFeedback.textContent = '当前排行榜没有匹配玩家'
    else if (matches.truncated) searchFeedback.textContent = '候选较多，请继续输入以缩小范围'
    else searchFeedback.textContent = `找到 ${candidates.length} 位候选玩家`
  }

  function handleSearchKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      closeCandidates()
      searchFeedback.textContent = ''
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (candidates.length === 0) return
      event.preventDefault()
      const delta = event.key === 'ArrowDown' ? 1 : -1
      candidateIndex = (candidateIndex + delta + candidates.length) % candidates.length
      renderCandidates()
      return
    }
    if (event.key === 'Enter' && candidates[candidateIndex] && candidateContext) {
      event.preventDefault()
      selectCandidate(candidates[candidateIndex]!, candidateContext)
    }
  }

  function selectCandidate(entry: RankSearchEntry, context: SearchContext): void {
    if (!isSearchContextValid(context) || !result) {
      closeCandidates()
      searchFeedback.textContent = '结果已变化，请重新搜索'
      return
    }
    const index = result.rowIndexById[entry.playerId]
    if (index === undefined) {
      closeCandidates()
      searchFeedback.textContent = '结果已变化，请重新搜索'
      return
    }
    page = Math.floor(index / pageSize)
    locatedPlayerId = entry.playerId
    searchInput.value = entry.name ? `${entry.name} #${entry.playerId}` : `#${entry.playerId}`
    closeCandidates()
    renderResults()
    searchFeedback.textContent = `已定位玩家 #${entry.playerId}，第 ${page + 1} 页`
    const rowNode = resultBody.querySelector(`tr[data-player-id="${entry.playerId}"]`)
    if (rowNode && typeof rowNode.scrollIntoView === 'function') {
      rowNode.scrollIntoView({ block: 'nearest' })
    }
    rowNode?.querySelector<HTMLAnchorElement>('a.ranking-player-link')?.focus()
  }

  function applyResultSort(metricId: string, direction: RankDirection, refresh = true): void {
    if (!result) return
    sortFallbackName = null
    if (result.sortMetricId !== metricId || result.direction !== direction) {
      result = sortRankingResult(result, metricId, direction)
      page = 0
      clearLocated()
      closeCandidates()
      searchFeedback.textContent = ''
    }
    if (refresh) renderResults()
  }

  function applyDefaultSortToResult(refresh = true): void {
    const preferred = config.defaultSortMetricId
    if (!result || !preferred || metricIndex(result.metricIds, preferred) < 0) return
    const direction = config.metrics.find((metric) => metric.id === preferred)?.direction ?? 'desc'
    applyResultSort(preferred, direction, refresh)
  }

  /** 表头只选择排序指标；方向始终取指标设置，重复点击当前列不反转。 */
  function sortByMetric(metricId: string): void {
    if (!result) return
    if (result.sortMetricId === metricId) return
    if (metricIndex(result.metricIds, metricId) < 0) {
      setNotice('该指标尚未计算，请重新计算排行榜', true)
      return
    }
    const direction: RankDirection =
      config.metrics.find((metric) => metric.id === metricId)?.direction ?? 'desc'
    applyResultSort(metricId, direction)
  }

  /** 修改当前排序列的方向立即重排；非当前列只保存，等待切换后生效。 */
  function applyMetricDirection(metricId: string, direction: RankDirection): void {
    if (!result || result.sortMetricId !== metricId) return
    applyResultSort(metricId, direction)
  }

  function resetResultState(): void {
    result = null
    resultConfig = null
    page = 0
    clearLocated()
    sortFallbackName = null
    closeCandidates()
    searchFeedback.textContent = ''
  }

  function syncDefaultSortOptions(): void {
    defaultSortSelect.replaceChildren()
    if (config.metrics.length === 0) {
      const option = el('option', undefined, '无可用指标') as HTMLOptionElement
      option.value = ''
      defaultSortSelect.append(option)
      config.defaultSortMetricId = null
      return
    }
    for (const metric of config.metrics) {
      const option = el('option', undefined, metric.name) as HTMLOptionElement
      option.value = metric.id
      defaultSortSelect.append(option)
    }
    if (
      !config.defaultSortMetricId ||
      !config.metrics.some((metric) => metric.id === config.defaultSortMetricId)
    ) {
      config.defaultSortMetricId = config.metrics[0]!.id
    }
    defaultSortSelect.value = config.defaultSortMetricId
  }

  /** 只有公式、指标集合和统计筛选改变才使聚合结果失效。 */
  function configSignature(): string {
    return JSON.stringify({
      metrics: config.metrics
        .map((metric) => [metric.id, metric.formula])
        .sort((left, right) => left[0]!.localeCompare(right[0]!)),
      filter: config.filter,
    })
  }

  function cancelCalculation(): void {
    calculationSeq += 1
    calculationController?.abort()
    calculationController = null
    calculating = false
  }

  function invalidateCalculation(): void {
    cancelCalculation()
    if (result !== null) {
      // 结果继续显示，但标记为旧口径；重新计算前不能用新摘要冒充旧结果。
      renderResults()
      setNotice('配置已修改，请重新计算')
    }
  }

  function syncFilterInputs(): void {
    for (const [level, input] of levelInputs) input.checked = config.filter.levels.includes(level)
    for (const [state, input] of stateInputs) input.checked = config.filter.states.includes(state)
    modeInput.value = config.filter.modes.join(',')
    softwareInput.value = config.filter.software
    nfInput.value = config.filter.nf
    fromInput.value = config.filter.from
    toInput.value = config.filter.to
    for (const level of RANK_LEVELS) floorInputs[level]!.value = String(config.filter.floors[level])
    minInput.value = String(config.filter.minGames)
    configName.value = config.name
    filterSummaryEl.textContent = filterSummary(config.filter)
  }

  function syncConfigOptions(): void {
    configSelect.replaceChildren()
    const seen = new Set<string>()
    for (const item of configs) {
      const option = el('option', undefined, item.name || item.id) as HTMLOptionElement
      option.value = item.id
      configSelect.append(option)
      seen.add(item.id)
    }
    if (!seen.has(config.id)) {
      const option = el('option', undefined, `草稿：${config.name}`) as HTMLOptionElement
      option.value = config.id
      configSelect.append(option)
    }
    configSelect.value = config.id
  }

  function syncAllInputs(): void {
    syncFilterInputs()
    syncConfigOptions()
  }

  function render(): void {
    filterSummaryEl.textContent = filterSummary(config.filter)
    renderDataset()
    renderResults()
    renderDiagnostics()
    renderNotice()
    validationEl.textContent = validation
    validationEl.hidden = !validation
  }

  function renderDataset(): void {
    const legacy = latest !== null && latest.strategyVersion !== RANK_STRATEGY_VERSION
    const statusText =
      latest === null
        ? '尚未建立数据集'
        : legacy
          ? '旧策略数据集'
          : latest.status === 'ready'
            ? '完整区间数据集'
            : latest.status === 'partial'
              ? '部分数据'
              : latest.status === 'collecting'
                ? '采集中'
                : '失败'
    datasetStatus.textContent = statusText
    datasetStatus.classList.toggle('ready', !legacy && latest?.status === 'ready')
    datasetStatus.classList.toggle('partial', legacy || latest?.status === 'partial')
    datasetStatus.classList.toggle('collecting', latest?.status === 'collecting')
    datasetStage.textContent = task
      ? `${PHASE_LABEL[task.phase] ?? '旧策略'} · ${task.status === 'paused' ? '已暂停，可继续' : task.status === 'running' ? '进行中' : '已完成'}`
      : latest
        ? `${latest.stage} · ${latest.complete ? '完整' : '部分'}`
        : meta.endId > 0
          ? `已保存范围 ${meta.startId}–${meta.endId}，尚未建库。`
          : '打开页面不会自动联网。首次请填写结束 ID，点击“开始加载”建立区间数据集。'
    datasetTimes.textContent = latest
      ? `开始 ${formatDateTime(latest.startedAt)} · 结束 ${latest.finishedAt ? formatDateTime(latest.finishedAt) : '尚未完成'} · 源站 ${latest.baseUrl}`
      : `源站 ${baseUrl}`
    const savedRangeText =
      meta.endId > 0
        ? `已保存范围：${meta.startId}–${meta.endId}（范围外新录像不会自动纳入）`
        : '尚未保存范围：起始 ID 默认 1，首次必须填写结束 ID。'
    const actualRangeText = latest
      ? legacy
        ? ' · 旧策略快照没有新版区间覆盖依据'
        : ` · 成功快照实际范围：${latest.startId}–${latest.endId}`
      : ''
    const taskRangeText =
      task && (task.startId !== meta.startId || task.endId !== meta.endId)
        ? ` · 当前任务冻结范围：${task.startId}–${task.endId}`
        : ''
    const readyRangeText =
      ready && ready.id !== latest?.id
        ? ` · 上一完整快照范围：${ready.startId}–${ready.endId}`
        : ''
    rangeHint.textContent = `${savedRangeText}${actualRangeText}${taskRangeText}${readyRangeText}`
    const enteredStart = Number(startIdInput.value)
    const enteredEnd = Number(endIdInput.value)
    if (
      Number.isSafeInteger(enteredStart) &&
      Number.isSafeInteger(enteredEnd) &&
      enteredStart > 0 &&
      enteredEnd >= enteredStart
    ) {
      const syncMode = latest?.strategyVersion === RANK_STRATEGY_VERSION && (latest.complete || latest.baseDatasetId !== null)
      const step = syncMode ? 10_000 : 500
      const batches = Math.ceil((enteredEnd - enteredStart + 1) / step)
      const waitMs = batches * (syncMode ? 2_000 : 1_250)
      rangeHint.textContent += ` · 预计 ${formatCount(batches)} 批 · 最低等待约 ${formatWait(waitMs)}`
    }
    startIdInput.disabled = collecting
    endIdInput.disabled = collecting
    statNodes['玩家']!.textContent = formatCount(latest?.playerCount ?? 0)
    statNodes['目标录像']!.textContent = formatCount(latest?.videoCount ?? 0)
    statNodes['解析完成']!.textContent = formatCount(latest?.detailCount ?? 0)
    statNodes['缺失详情']!.textContent = formatCount(latest?.missingDetailCount ?? 0)
    const intervalTotalValue = task?.intervalTotal ?? latest?.intervalTotal ?? 0
    const intervalDoneValue = task?.intervalDone ?? latest?.intervalDone ?? 0
    statNodes['区间完成']!.textContent = intervalTotalValue
      ? `${formatCount(intervalDoneValue)} / ${formatCount(intervalTotalValue)}`
      : '—'
    datasetProgress.hidden = intervalTotalValue === 0
    datasetProgress.value =
      intervalTotalValue === 0
        ? 0
        : Math.min(100, (intervalDoneValue / intervalTotalValue) * 100)
    const progressParts: string[] = []
    if (intervalTotalValue > 0) {
      progressParts.push(
        `区间 ${formatCount(intervalDoneValue)}/${formatCount(intervalTotalValue)}`,
      )
    }
    if (task) {
      progressParts.push(
        `扫描游标 ${formatCount(task.intervalCursor)} / 截止 ${formatCount(task.endExclusive)}`,
      )
      if (task.missingDetailCount > 0) {
        progressParts.push(`待补详情 ${formatCount(task.missingDetailCount)}`)
      }
      if (task.responseAnomalies > 0) {
        progressParts.push(`异常条目 ${formatCount(task.responseAnomalies)}`)
      }
    }
    datasetProgressText.textContent = progressParts.join(' · ')
    lastEstimate = task && intervalTotalValue > 0 ? estimate(task) : null
    if (lastEstimate !== null) {
      datasetProgressText.textContent += ` · 预计请求约 ${formatCount(lastEstimate)} 次`
    }

    const pausedTask =
      latest !== null &&
      task !== null &&
      task.strategyVersion === RANK_STRATEGY_VERSION &&
      task.status !== 'completed' &&
      latest.status !== 'ready'
    const canSync =
      latest?.strategyVersion === RANK_STRATEGY_VERSION &&
      (latest.complete || (latest.baseDatasetId !== null && ready !== null))
    startButton.textContent = collecting
      ? '采集中…'
      : pausedTask
        ? '继续采集'
        : canSync
          ? '同步录像'
          : latest
            ? '重新建库'
            : '开始加载'
    startButton.disabled = collecting
    pauseButton.hidden = !collecting
    expandButton.hidden =
      meta.endId <= 0 ||
      latest === null ||
      latest.strategyVersion !== RANK_STRATEGY_VERSION ||
      (!latest.complete && (latest.baseDatasetId === null || ready === null))
    expandButton.disabled = collecting
    restartButton.disabled = collecting
    const preferredTarget =
      latest?.strategyVersion === RANK_STRATEGY_VERSION && latest.status === 'ready'
        ? latest
        : ready && ready.strategyVersion === RANK_STRATEGY_VERSION
          ? ready
          : latest
    const preferredIsPrevious =
      preferredTarget !== null &&
      latest !== null &&
      preferredTarget.id !== latest.id
    calculateButton.textContent = preferredIsPrevious
      ? '计算上一份完整快照'
      : latest?.strategyVersion === RANK_STRATEGY_VERSION && latest.status === 'partial'
        ? '计算当前部分数据'
        : '计算排行榜'
    calculateButton.disabled =
      calculating ||
      preferredTarget === null ||
      preferredTarget.strategyVersion !== RANK_STRATEGY_VERSION ||
      preferredTarget.videoCount === 0 ||
      (collecting && preferredTarget.id === latest?.id)
    calculatePartialButton.hidden = !(
      latest !== null &&
      latest.strategyVersion === RANK_STRATEGY_VERSION &&
      latest.status === 'partial' &&
      ready !== null &&
      ready.strategyVersion === RANK_STRATEGY_VERSION &&
      ready.id !== latest.id &&
      !collecting
    )
    calculatePartialButton.disabled = calculating
    cancelCalculationButton.hidden = !calculating
    deleteTaskButton.hidden =
      !latest ||
      latest.status === 'ready' ||
      latest.status === 'collecting' ||
      collecting
    deleteTaskButton.disabled = collecting
    clearCacheButton.disabled = collecting
    saveConfigButton.disabled = collecting
    if (task && task.status === 'completed') pauseButton.hidden = true
  }

  function renderResults(): void {
    // 表头重绘会替换按钮；记住当前排序按钮，重绘后恢复到同一指标。
    const focusedMetricId = (() => {
      if (typeof document === 'undefined') return null
      const active = document.activeElement as HTMLElement | null
      if (!active || typeof active.closest !== 'function') return null
      const button = active.closest<HTMLElement>('button.ranking-sort-button')
      return button?.dataset.metricId ?? null
    })()
    if (result && result.datasetId !== latest?.id && result.datasetId !== ready?.id) {
      resetResultState()
    }
    resultConfigLine.textContent = `当前配置：${config.name} · ${filterSummary(config.filter)}`
    resultHeadRow.replaceChildren()
    resultBody.replaceChildren()
    if (!result) {
      resultScopeLine.textContent = ''
      resultScopeLine.hidden = true
      resultSummary.textContent = ''
      resultNotice.textContent = latest?.strategyVersion === RANK_STRATEGY_VERSION
        ? latest.videoCount
          ? `区间 ${latest.startId}–${latest.endId} 已加载，点击“计算排行榜”生成结果。`
          : `区间 ${latest.startId}–${latest.endId} 没有公开录像，可先同步录像。`
        : latest
          ? '这是旧策略快照，没有新版区间覆盖依据；请重新建库后计算。'
          : '尚无本地数据集。先填写范围并开始加载 ID 区间。'
      resultNotice.hidden = false
      closeCandidates()
      searchFeedback.textContent = ''
      pager.hidden = true
      return
    }

    const currentResult = result
    // 列顺序取当前配置，值永远按 metricId 从结果向量取，不能按列下标冒充。
    const displayMetrics = config.metrics.map(({ id, name, digits }) => ({
      id,
      name,
      digits,
      valueIndex: currentResult.metricIds.indexOf(id),
    }))
    const stale = resultConfig !== null && resultConfig.signature !== configSignature()
    const resultDataset = result.datasetId === latest?.id ? latest : ready
    const statusText = resultDataset?.status === 'ready'
      ? '完整'
      : resultDataset?.status === 'partial'
        ? '部分'
        : ''
    resultSummary.textContent = `${formatCount(result.playerCount)} 名玩家 · ${formatCount(result.filteredGames)} 局 · ${formatCount(result.elapsedMs)} ms`
    if (resultDataset) {
      resultSummary.textContent += ` · 范围 ${resultDataset.startId}–${resultDataset.endId}${statusText ? ` · ${statusText}` : ''}`
    }
    resultScopeLine.textContent = resultConfig
      ? `结果口径：${resultConfig.name} · ${resultConfig.filterText}${stale ? ' · 配置已修改，请重新计算' : ''}`
      : ''
    resultScopeLine.hidden = resultScopeLine.textContent === ''

    const messages: string[] = []
    if (stale) messages.push('配置已修改，请重新计算；当前显示的是旧口径结果')
    if (resultDataset?.strategyVersion === RANK_STRATEGY_VERSION && resultDataset.status === 'partial') {
      messages.push(
        `当前结果是部分数据（区间 ${formatCount(resultDataset.intervalDone)}/${formatCount(resultDataset.intervalTotal)} · 缺失详情 ${formatCount(resultDataset.missingDetailCount)}），不能称为完整全站排名`,
      )
    } else if (resultDataset && latest && resultDataset.id !== latest.id) {
      messages.push(
        `当前显示上一份完整快照（${ready?.startId}–${ready?.endId}）；最新任务尚未完整发布，不能覆盖该结果`,
      )
    }
    if (result.rows.length === 0) messages.push('当前筛选和公式没有产生有效排名')
    if (displayMetrics.some((metric) => metric.valueIndex < 0)) {
      messages.push('新加的指标尚未计算，请重新计算排行榜')
    }
    if (sortFallbackName) {
      messages.push(`默认排序指标尚未计算，当前按「${sortFallbackName}」排序；请重新计算排行榜`)
    }
    resultNotice.hidden = messages.length === 0
    resultNotice.textContent = messages.join('。')

    const headRow = el('tr')
    headRow.append(el('th', 'num', '名次'), el('th', undefined, '玩家'), el('th', 'num', '局数'))
    for (const metric of displayMetrics) {
      const th = el('th', 'num ranking-metric-head')
      const active = result.sortMetricId === metric.id
      const button = el('button', 'ranking-sort-button') as HTMLButtonElement
      button.type = 'button'
      button.dataset.metricId = metric.id
      button.textContent = active
        ? `${metric.name} ${result.direction === 'desc' ? '↓' : '↑'}`
        : metric.name
      button.disabled = metric.valueIndex < 0
      button.title = button.disabled
        ? '该指标尚未计算，请重新计算排行榜'
        : active
          ? '当前排序指标，方向在指标设置中修改'
          : '按此指标排序'
      button.addEventListener('click', () => sortByMetric(metric.id))
      if (active) {
        th.setAttribute('aria-sort', result.direction === 'desc' ? 'descending' : 'ascending')
      }
      th.append(button)
      headRow.append(th)
    }
    resultHeadRow.append(headRow)

    const pages = pageCount(result.rows, pageSize)
    page = Math.min(Math.max(0, page), Math.max(0, pages - 1))
    for (const row of pageRows(result.rows, page, pageSize)) {
      const tr = el('tr')
      tr.dataset.playerId = String(row.playerId)
      if (locatedPlayerId === row.playerId) tr.classList.add('is-located')
      tr.append(el('td', 'num', row.rank === null ? '—' : String(row.rank)))
      const playerCell = el('td')
      const record = names.get(row.playerId)
      const playerLink = el('a', 'ranking-player-link', record ? displayName(record) : `#${row.playerId}`) as HTMLAnchorElement
      playerLink.href = `${SITE_ORIGIN}/#/player/${row.playerId}`
      playerLink.target = '_blank'
      playerLink.rel = 'noreferrer'
      playerCell.append(playerLink, el('span', 'ranking-player-id', `ID ${row.playerId}`))
      const statsLink = el('a', 'ranking-mini-link', '数据') as HTMLAnchorElement
      statsLink.href = chrome.runtime.getURL(`player.html?id=${row.playerId}`)
      statsLink.target = '_blank'
      statsLink.rel = 'noreferrer'
      playerCell.append(statsLink)
      tr.append(playerCell, el('td', 'num', formatCount(row.games)))
      for (const metric of displayMetrics) {
        const index = metric.valueIndex
        const value = index >= 0 ? row.values[index] ?? null : null
        const cell = el('td', 'num ranking-metric-value')
        cell.append(el('b', undefined, formatMetricValue(value, metric.digits)))
        cell.append(el('span', 'ranking-sample', `有效 ${formatCount(index >= 0 ? row.samples[index] ?? 0 : 0)}`))
        tr.append(cell)
      }
      resultBody.append(tr)
    }
    pager.hidden = pages === 0
    pageText.textContent = pages === 0
      ? ''
      : `共 ${formatCount(result.rows.length)} 位玩家 · 第 ${page + 1} / ${pages} 页`
    prevButton.disabled = pages === 0 || page <= 0
    nextButton.disabled = pages === 0 || page >= pages - 1
    if (focusedMetricId) {
      const buttons = resultHeadRow.querySelectorAll<HTMLButtonElement>('button.ranking-sort-button')
      for (const button of Array.from(buttons)) {
        if (button.dataset.metricId === focusedMetricId) {
          button.focus()
          break
        }
      }
    }
  }

  function renderDiagnostics(): void {
    detailsContent.replaceChildren()
    if (!latest && !task) {
      detailsContent.append(el('p', 'hint-text', '暂无采集任务。'))
      return
    }
    const lines: string[] = []
    if (latest) {
      lines.push(`数据集：${latest.id}`)
      lines.push(
        `策略：v${latest.strategyVersion ?? 1} · ${latest.scanMode ?? 'legacy'} · 范围 ${latest.startId ?? '—'}–${latest.endId ?? '—'}`,
      )
      lines.push(`基础快照：${latest.baseDatasetId ?? '无'}`)
      lines.push(`Schema：v${latest.schemaVersion} · generation ${latest.generation}`)
      lines.push(
        `区间：${latest.intervalDone ?? 0}/${latest.intervalTotal ?? 0} · 错误 ${latest.errorCount} · 异常条目 ${latest.responseAnomalies ?? 0}`,
      )
      lines.push(
        `完整性：${latest.complete ? '完整' : '部分'} · 开始 ${formatDateTime(latest.startedAt)} · 结束 ${formatDateTime(latest.finishedAt ?? 0)}`,
      )
      for (const warning of latest.warnings) lines.push(`警告：${warning}`)
    }
    if (task) {
      lines.push(
        `任务：${task.id} · ${task.status} · 策略 v${task.strategyVersion ?? 1} · token ${task.runToken}`,
      )
      lines.push(
        `范围 ${task.startId ?? '—'}–${task.endId ?? '—'} · 游标 ${task.intervalCursor ?? '—'} · 区间 ${task.intervalDone ?? 0}/${task.intervalTotal ?? 0}`,
      )
      lines.push(
        `目标 ${task.targetCount} · 详情 ${task.detailCount} · 复用 ${task.detailReusedCount ?? 0} · 缺失 ${task.missingDetailCount} · 异常 ${task.responseAnomalies ?? 0}`,
      )
      for (const error of task.errors) {
        lines.push(`[${formatDateTime(error.at)}] ${error.phase} · ${error.scope} · ${error.message}`)
      }
      for (const warning of task.warnings) lines.push(`警告：${warning}`)
    }
    if (storageEstimate) {
      lines.push(
        `存储占用约 ${formatCount(storageEstimate.usage)} B / 配额约 ${formatCount(storageEstimate.quota)} B`,
      )
    }
    const pre = el('pre', 'ranking-diagnostics-text', lines.join('\n'))
    detailsContent.append(pre)
  }

  function estimate(task: GlobalRankTask): number {
    return (
      task.intervalTotal +
      Math.ceil(task.missingDetailCount / 100) +
      Math.ceil(task.playerCount / 100)
    )
  }

  function renderMetrics(): void {
    syncDefaultSortOptions()
    metricsList.replaceChildren()
    metricFormulaInputs.clear()
    metricFormulaErrors.clear()
    if (config.metrics.length === 0) {
      const empty = el('p', 'hint-text', '还没有指标。至少添加一项后才能计算。')
      metricsList.append(empty)
      return
    }
    config.metrics.forEach((metric, index) => {
      const row = el('div', 'ranking-metric-row')
      row.dataset.metricId = metric.id
      const order = el('span', 'ranking-metric-order', String(index + 1))
      const name = el('input', 'text-input ranking-metric-name') as HTMLInputElement
      name.value = metric.name
      name.placeholder = '指标名称'
      name.addEventListener('input', () => {
        metric.name = name.value
        for (const option of Array.from(defaultSortSelect.children)) {
          if ((option as HTMLOptionElement).value === metric.id) option.textContent = name.value
        }
        if (result !== null) {
          renderResults()
          if (calculating) {
            resultNotice.hidden = false
            resultNotice.textContent = '正在本地计算…'
          }
        }
      })
      const formula = el('input', 'text-input ranking-formula') as HTMLInputElement
      formula.value = metric.formula
      formula.placeholder = '聚合公式，例如 max(bv / time)'
      formula.spellcheck = false
      formula.addEventListener('focus', () => {
        activeFormulaId = metric.id
      })
      const error = el('p', 'ranking-formula-error')
      formula.addEventListener('input', () => {
        metric.formula = formula.value
        const message = formulaError(metric)
        error.textContent = message
        error.hidden = message === ''
        invalidateCalculation()
      })
      const direction = el('select', 'select ranking-direction') as HTMLSelectElement
      for (const [value, label] of [
        ['desc', '降序'],
        ['asc', '升序'],
      ] as const) {
        const option = el('option', undefined, label) as HTMLOptionElement
        option.value = value
        direction.append(option)
      }
      direction.value = metric.direction
      direction.title = '排序方向'
      direction.setAttribute('aria-label', `${metric.name} 排序方向`)
      direction.addEventListener('change', () => {
        // 方向属于指标设置：只影响该指标；当前排序列立即重排，其他列保存待用。
        metric.direction = direction.value as RankMetric['direction']
        applyMetricDirection(metric.id, metric.direction)
      })
      const digits = el('input', 'text-input ranking-digits') as HTMLInputElement
      digits.type = 'number'
      digits.min = '0'
      digits.max = '6'
      digits.value = String(metric.digits)
      digits.addEventListener('input', () => {
        const value = Number(digits.value)
        metric.digits = Number.isFinite(value) ? Math.max(0, Math.min(6, Math.floor(value))) : 0
        // 已有结果直接按新精度重绘，不重新扫描或调用 Worker。
        if (result !== null) {
          renderResults()
          if (calculating) {
            resultNotice.hidden = false
            resultNotice.textContent = '正在本地计算…'
          }
        }
      })
      const controls = el('div', 'ranking-metric-buttons')
      const up = el('button', 'icon-button', '↑') as HTMLButtonElement
      up.type = 'button'
      up.title = '上移'
      up.addEventListener('click', () => moveMetric(index, -1))
      const down = el('button', 'icon-button', '↓') as HTMLButtonElement
      down.type = 'button'
      down.title = '下移'
      down.addEventListener('click', () => moveMetric(index, 1))
      const remove = el('button', 'icon-button danger', '×') as HTMLButtonElement
      remove.type = 'button'
      remove.title = '删除指标'
      remove.addEventListener('click', () => removeMetric(index))
      controls.append(up, down, remove)
      const top = el('div', 'ranking-metric-top')
      top.append(order, name, direction, digits, controls)
      const body = el('div', 'ranking-metric-body')
      body.append(formula)
      row.append(top, body, error)
      const initialError = formulaError(metric)
      error.textContent = initialError
      error.hidden = initialError === ''
      metricFormulaInputs.set(metric.id, formula)
      metricFormulaErrors.set(metric.id, error)
      metricsList.append(row)
    })
  }

  function formulaError(metric: RankMetric): string {
    const hint = fieldHintFromFormula(metric.formula)
    try {
      compileFormula(metric.formula)
      return hint
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  function fieldHintFromFormula(formula: string): string {
    if (/\b(bv)\b/.test(formula) && !/\b(max|min|avg|sum|countValid)\s*\(/.test(formula)) {
      return '提示：字段需要放在聚合函数里，例如 max(bv / time)。'
    }
    return ''
  }

  function moveMetric(index: number, delta: number): void {
    const target = index + delta
    if (target < 0 || target >= config.metrics.length) return
    const [item] = config.metrics.splice(index, 1)
    if (item) config.metrics.splice(target, 0, item)
    // 只移动列顺序，聚合值仍有效；已有结果直接重绘。
    if (result) renderResults()
    renderMetrics()
  }

  /**
   * 删除当前排序列后必须同步结果视图：优先按仍存在且已计算的默认指标重排；
   * 默认指标尚未计算时退到第一个可用列并提示，不能继续按隐藏指标排名。
   */
  function reselectRemovedSortMetric(removed: RankMetric): void {
    const currentResult = result
    if (!currentResult || currentResult.sortMetricId !== removed.id) return
    const available = config.metrics.filter(
      (metric) =>
        metric.id !== removed.id && metricIndex(currentResult.metricIds, metric.id) >= 0,
    )
    const preferred = available.find((metric) => metric.id === config.defaultSortMetricId)
    const chosen = preferred ?? available[0]
    if (chosen) {
      result = sortRankingResult(currentResult, chosen.id, chosen.direction)
      sortFallbackName = preferred ? null : chosen.name
    } else {
      result = clearRankingSort(currentResult)
      sortFallbackName = null
    }
    page = 0
    clearLocated()
    closeCandidates()
    searchFeedback.textContent = ''
  }

  function removeMetric(index: number): void {
    const removed = config.metrics[index]
    if (!removed) return
    config.metrics.splice(index, 1)
    if (config.defaultSortMetricId === removed.id) {
      config.defaultSortMetricId = config.metrics[0]?.id ?? null
    }
    if (activeFormulaId && !metricById(config, activeFormulaId)) activeFormulaId = null
    reselectRemovedSortMetric(removed)
    invalidateCalculation()
    renderMetrics()
  }

  function addMetric(formula = 'max(bv / time)'): void {
    if (config.metrics.length >= 10) {
      setNotice('首版最多 10 项指标', true)
      return
    }
    const metric: RankMetric = {
      id: newMetricId(config.metrics, result?.metricIds ?? []),
      name: `指标 ${config.metrics.length + 1}`,
      formula,
      direction: 'desc',
      digits: 3,
    }
    config.metrics.push(metric)
    if (!config.defaultSortMetricId) config.defaultSortMetricId = metric.id
    invalidateCalculation()
    renderMetrics()
  }

  function insertField(key: string): void {
    const metric =
      (activeFormulaId ? metricById(config, activeFormulaId) : undefined) ?? config.metrics[0]
    if (!metric) {
      setNotice('先添加一项指标，再插入字段', true)
      return
    }
    const input = metricFormulaInputs.get(metric.id)
    const start = input?.selectionStart ?? metric.formula.length
    const end = input?.selectionEnd ?? metric.formula.length
    metric.formula = `${metric.formula.slice(0, start)}${key}${metric.formula.slice(end)}`
    activeFormulaId = metric.id
    if (input) {
      input.value = metric.formula
      input.focus()
      if (typeof input.setSelectionRange === 'function') {
        const cursor = start + key.length
        input.setSelectionRange(cursor, cursor)
      }
    }
    const error = metricFormulaErrors.get(metric.id)
    if (error) {
      const message = formulaError(metric)
      error.textContent = message
      error.hidden = message === ''
    }
    invalidateCalculation()
    setNotice(`已插入 ${key}`, false)
  }

  async function saveConfig(): Promise<void> {
    try {
      config = validateConfig(config)
      await putConfig(config)
      configs = await listConfigs()
      meta = await getRankingMeta(baseUrl)
      meta = { ...meta, configId: config.id, updatedAt: Date.now(), revision: meta.revision + 1 }
      await putRankingMeta(meta)
      syncConfigOptions()
      renderMetrics()
      setNotice('配置已保存到本机')
    } catch (error) {
      setNotice(error instanceof ConfigError ? error.message : errorMessage(error), true)
    }
  }

  async function createConfig(): Promise<void> {
    const draft = createDefaultConfig()
    draft.id = `config-${Date.now().toString(36)}`
    draft.name = '新排行榜配置'
    config = draft
    syncConfigOptions()
    syncFilterInputs()
    renderMetrics()
    invalidateCalculation()
    setNotice('新配置尚未保存，确认后点“保存配置”')
  }

  async function removeConfig(): Promise<void> {
    if (configs.length <= 1) {
      setNotice('至少保留一项配置；可以先新建配置再删除旧配置', true)
      return
    }
    if (typeof window.confirm !== 'function' || !window.confirm(`删除配置「${config.name}」？`)) return
    await deleteConfig(config.id)
    configs = await listConfigs()
    config = configs[0] ?? createDefaultConfig()
    syncAllInputs()
    renderMetrics()
    invalidateCalculation()
    setNotice('配置已删除')
  }

  function getFileInput(): HTMLInputElement {
    let input = document.getElementById('ranking-import-input') as HTMLInputElement | null
    if (!input) {
      input = el('input') as HTMLInputElement
      input.id = 'ranking-import-input'
      input.type = 'file'
      input.accept = 'application/json,.json'
      input.hidden = true
      input.addEventListener('change', () => void handleImportFile(input!))
      pageNode.append(input)
    }
    return input
  }

  async function importFile(): Promise<void> {
    const input = getFileInput()
    input.value = ''
    input.click()
  }

  async function handleImportFile(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0]
    if (!file) return
    try {
      const imported = importConfig(await file.text())
      config = imported.config
      syncConfigOptions()
      syncFilterInputs()
      renderMetrics()
      invalidateCalculation()
      setNotice(
        imported.warnings.length > 0
          ? `已导入草稿：${imported.warnings.join('；')}`
          : '已导入草稿，点击“保存配置”后才会保存',
      )
    } catch (error) {
      setNotice(error instanceof ConfigError ? error.message : errorMessage(error), true)
    }
  }

  function downloadConfig(): void {
    try {
      const text = exportConfig(config)
      const blob = new Blob([text], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = el('a') as HTMLAnchorElement
      link.href = url
      link.download = `${config.name || 'ranking-config'}.json`
      link.click()
      URL.revokeObjectURL(url)
      setNotice('配置已导出')
    } catch (error) {
      setNotice(errorMessage(error), true)
    }
  }

  function readRange(): { startId: number; endId: number } {
    return normalizeScanRange(
      startIdInput.value.trim() ? Number(startIdInput.value) : undefined,
      endIdInput.value.trim() ? Number(endIdInput.value) : undefined,
    )
  }

  async function start(kind: 'primary' | 'rebuild' | 'expand'): Promise<void> {
    if (collecting) return
    let mode: CollectionMode = 'auto'
    let startId: number | undefined
    let endId: number | undefined
    try {
      if (kind === 'expand') {
        if (meta.endId <= 0) throw new RankingRangeError('还没有保存扫描范围，请先建库')
        const entered = Number(endIdInput.value)
        if (!Number.isSafeInteger(entered) || entered <= meta.endId) {
          throw new RankingRangeError('扩大范围的新结束 ID 必须大于已保存的结束 ID')
        }
        if (typeof window.confirm === 'function') {
          const confirmed = window.confirm(
            `当前范围：${meta.startId}–${meta.endId}。扩大到 ${meta.startId}–${entered}？会重新同步整个区间并补齐新增详情。`,
          )
          if (!confirmed) return
        }
        mode = 'expand'
        startId = meta.startId
        endId = entered
      } else if (kind === 'rebuild') {
        const range = readRange()
        if (typeof window.confirm === 'function') {
          const confirmed = window.confirm(
            `重新建库会按 ${range.startId}–${range.endId} 重新抓取详情，旧成功快照仍会保留到新快照发布。继续？`,
          )
          if (!confirmed) return
        }
        mode = 'initial'
        startId = range.startId
        endId = range.endId
      } else {
        const resumable =
          task !== null &&
          task.strategyVersion === RANK_STRATEGY_VERSION &&
          task.status !== 'completed' &&
          latest?.status !== 'ready'
        const canSync =
          latest?.strategyVersion === RANK_STRATEGY_VERSION &&
          (latest.complete || (latest.baseDatasetId !== null && ready !== null))
        if (resumable) {
          mode = 'auto'
        } else if (canSync) {
          mode = 'sync'
        } else {
          const range = readRange()
          mode = 'initial'
          startId = range.startId
          endId = range.endId
        }
      }
    } catch (error) {
      setNotice(error instanceof RankingRangeError ? error.message : errorMessage(error), true)
      return
    }

    cancelCalculation()
    collecting = true
    controller = new AbortController()
    setNotice(
      mode === 'sync'
        ? '正在按保存范围同步录像…'
        : mode === 'expand'
          ? '正在扩大范围并同步历史元信息…'
          : mode === 'initial'
            ? '正在按 ID 区间建库…'
            : '正在继续上次采集…',
    )
    renderDataset()
    const progress = (state: CollectionProgress): void => {
      latest = state.dataset
      task = state.task
      lastEstimate = state.estimatedRequests
      renderDataset()
    }
    try {
      const run = await startCollection(baseUrl, {
        mode,
        startId,
        endId,
        signal: controller.signal,
        onProgress: progress,
      })
      const hadResult = result !== null
      latest = run.dataset
      task = run.task
      names = new Map((await getAllUsers()).map((record) => [record.id, record]))
      namesRevision += 1
      closeCandidates()
      await refreshOverview()
      startIdInput.value = String(meta.startId || 1)
      endIdInput.value = meta.endId > 0 ? String(meta.endId) : ''
      if (run.complete) {
        // 新完整快照已发布，旧结果不再是当前榜单；明确提示重新计算。
        resetResultState()
        renderResults()
        setNotice(hadResult ? '新快照已发布，请重新计算排行榜' : run.message, false)
      } else {
        // 部分发布不覆盖上一份完整结果；保留表格并提示当前是部分数据。
        renderResults()
        setNotice(run.message, true)
      }
    } catch (error) {
      if (error instanceof RankingAbortError) {
        setNotice('采集已暂停，可稍后继续')
      } else if (error instanceof RankingBusyError) {
        setNotice(error.message, true)
      } else if (error instanceof RankingRangeError) {
        setNotice(error.message, true)
      } else {
        setNotice(`采集未完成：${errorMessage(error)}`, true)
      }
      await refreshOverview().catch(() => {})
      startIdInput.value = String(meta.startId || 1)
      endIdInput.value = meta.endId > 0 ? String(meta.endId) : endIdInput.value
    } finally {
      collecting = false
      controller = null
      renderDataset()
    }
  }

  function pause(): void {
    controller?.abort()
  }

  async function removeIncomplete(): Promise<void> {
    if (!latest || collecting) return
    if (typeof window.confirm === 'function' && !window.confirm('删除这份未完成数据集？')) return
    await deleteDataset(latest.id)
    await restoreLatestToReady(baseUrl)
    resetResultState()
    await refreshOverview()
    startIdInput.value = String(meta.startId || 1)
    endIdInput.value = meta.endId > 0 ? String(meta.endId) : ''
    setNotice('未完成任务已删除，上一份成功快照仍可用')
    render()
  }

  async function clearCache(): Promise<void> {
    if (collecting) return
    if (typeof window.confirm === 'function' && !window.confirm('清空全部全站录像缓存？已保存的范围和排行榜配置不会删除。')) return
    await clearRankingCache()
    resetResultState()
    latest = null
    ready = null
    task = null
    meta = await getRankingMeta(baseUrl)
    startIdInput.value = String(meta.startId || 1)
    endIdInput.value = meta.endId > 0 ? String(meta.endId) : ''
    setNotice('全站录像缓存已清空，保存范围仍保留')
    render()
  }

  async function calculate(targetMode: 'primary' | 'latest' = 'primary'): Promise<void> {
    validation = ''
    if (config.metrics.length === 0) {
      validation = '至少添加一项指标才能计算'
      render()
      return
    }
    try {
      compileConfig(config)
      validation = ''
    } catch (error) {
      validation = error instanceof ConfigError ? error.message : errorMessage(error)
      render()
      return
    }
    const target =
      targetMode === 'latest'
        ? latest
        : latest?.strategyVersion === RANK_STRATEGY_VERSION && latest.status === 'ready'
          ? latest
          : ready?.strategyVersion === RANK_STRATEGY_VERSION
            ? ready
            : latest
    if (!target || target.videoCount === 0) {
      setNotice('当前没有可计算的本地数据集', true)
      return
    }
    if (target.strategyVersion !== RANK_STRATEGY_VERSION) {
      setNotice('旧策略快照没有新版区间覆盖依据，请先重新建库', true)
      return
    }
    const signature = configSignature()
    const seq = ++calculationSeq
    const calcController = new AbortController()
    calculationController?.abort()
    calculationController = calcController
    calculating = true
    calculateButton.disabled = true
    calculateButton.textContent = '计算中…'
    resultNotice.hidden = false
    resultNotice.textContent = '正在本地计算…'
    renderDataset()
    try {
      const startedAt = Date.now()
      const calculated = await calculateRanking(target.id, config, {
        signal: calcController.signal,
      })
      if (seq !== calculationSeq || signature !== configSignature()) {
        resultNotice.textContent = '配置已修改，旧计算结果已丢弃'
        setNotice('配置已修改，旧计算结果已丢弃')
        return
      }
      if (calculated.datasetId !== target.id) {
        resultNotice.textContent = '数据集已变化，旧计算结果已丢弃'
        setNotice('数据集已变化，旧计算结果已丢弃')
        return
      }
      result = calculated
      resultConfig = {
        name: config.name,
        filterText: filterSummary(config.filter),
        signature,
      }
      result.elapsedMs = Math.max(result.elapsedMs, Date.now() - startedAt)
      // 计算期间修改的默认排序、方向等展示设置仍生效，不丢弃有效聚合值。
      applyDefaultSortToResult(false)
      page = 0
      clearLocated()
      closeCandidates()
      searchFeedback.textContent = ''
      renderResults()
      setNotice(
        target.id === latest?.id
          ? `计算完成：${result.playerCount} 名玩家`
          : `计算完成：${result.playerCount} 名玩家（上一份完整快照）`,
      )
    } catch (error) {
      if (seq === calculationSeq) {
        const message = errorMessage(error) === '计算已取消'
          ? '计算已取消'
          : `计算失败：${errorMessage(error)}`
        resultNotice.hidden = false
        resultNotice.textContent = message
        setNotice(message, errorMessage(error) !== '计算已取消')
      }
    } finally {
      calculating = false
      if (calculationController === calcController) calculationController = null
      renderDataset()
    }
  }

  // 页面重获焦点时重新读取其他页面的配置和任务状态；不自动联网。
  const onFocus = (): void => {
    if (collecting) return
    void (async () => {
      await refreshOverview()
      configs = await listConfigs()
      syncConfigOptions()
      render()
    })()
  }
  window.addEventListener('focus', onFocus)
}
