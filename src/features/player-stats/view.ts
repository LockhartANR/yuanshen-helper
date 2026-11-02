import { SITE_ORIGIN } from '../../shared/constants'
import type { PlayerVideoRow } from '../../shared/db'
import { formatCount, formatDateTime, formatShortDate } from '../../shared/format'
import { askSelfId, resolveSelfId } from '../../shared/self-id'
import { el, errorMessage, externalLink, isAbortError } from '../../shared/ui'
import { fetchUserInfo } from './api'
import { createAnalysisView } from './analysis-view'
import { loadAnalysisSettings } from './analysis-settings'
import { computePb, computeTop5, eligible, bvsOf, joinVideos, stnbOf } from './compute'
import { configureColors, dateColorStyle, medianOf, pbColorStyle } from './colors'
import { softwareIcon } from './software-icon'
import type { Level, Top5Group, TopStat, Video } from './model'
import { LEVELS, MAX_BV, softwareLabel } from './model'
import { ensureDetails, loadPlayer } from './service'
import { parseStatsCsv } from './csv'

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

interface UiState {
  userId: number
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

interface CsvImport {
  name: string
  total: number
  videos: Video[]
  invalidRows: number
}

function readUserId(): number | null {
  const value = Number(new URLSearchParams(location.search).get('id') ?? '')
  return Number.isSafeInteger(value) && value > 0 ? value : null
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

export async function mountPlayerStats(root: HTMLElement): Promise<void> {
  const userId = readUserId()
  if (userId === null) {
    root.append(el('div', 'player-error', '链接里缺少合法的用户 ID，例如 player.html?id=16。'))
    return
  }
  configureColors(loadAnalysisSettings().colorThresholds)

  const state: UiState = {
    userId,
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
  let csvImportVersion = 0
  let pendingUnapproved = false
  let source: 'site' | 'csv' = 'site'
  const csvImports: CsvImport[] = []
  let csvIdBase = 0
  let siteName = `#${userId}`

  // ---- 头部 ----
  const nameNode = el('h1', 'player-name', `#${userId}`)
  const idNode = el('span', 'player-id', `ID ${userId}`)
  const metaNode = el('p', 'player-meta', '准备中…')

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
  const selfButton = el('button', 'button', '我的成绩')
  selfButton.type = 'button'
  selfButton.title = '打开你自己账号的成绩页'
  selfButton.addEventListener('click', () => void openMyStats())

  const headerActions = el('div', 'player-actions')
  headerActions.append(
    externalLink('站点主页', `${SITE_ORIGIN}/#/player/${userId}`),
    selfButton,
    refreshButton,
    cancelButton,
  )
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
    box.append(el('h3', 'top5-title', nf ? '仅 NF' : '全部录像'))
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

  // ---- 挂载 ----
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
  const importCsvButton = el('button', 'button hidden', '导入 CSV')
  importCsvButton.type = 'button'
  const clearCsvButton = el('button', 'button hidden', '清除 CSV')
  clearCsvButton.type = 'button'
  const csvInput = el('input', 'hidden')
  csvInput.type = 'file'
  csvInput.accept = '.csv,text/csv'
  csvInput.multiple = true
  const csvFilesNote = el('p', 'source-files hidden')
  const csvFeedback = el('div', 'source-files hidden')
  const csvStatus = el('p')
  csvStatus.setAttribute('role', 'status')
  csvStatus.setAttribute('aria-live', 'polite')
  csvStatus.setAttribute('aria-atomic', 'true')
  const csvErrorDetails = el('details', 'hidden')
  csvFeedback.append(csvStatus, csvErrorDetails)
  sourceBar.append(siteSource, csvSource, importCsvButton, clearCsvButton, csvInput)

  const scorePane = el('div', 'player-pane')
  scorePane.append(filters, notice, status, pbCard, topCard)

  const analysisPane = el('div', 'player-pane hidden')
  const analysis = createAnalysisView()
  analysisPane.append(analysis.root)

  const wrap = el('main', 'player-page')
  wrap.append(header, sourceBar, csvFilesNote, csvFeedback, pageTabs, scorePane, analysisPane)
  root.replaceChildren(wrap)

  function showPage(page: 'score' | 'analysis'): void {
    const analysisActive = page === 'analysis'
    scorePane.classList.toggle('hidden', analysisActive)
    analysisPane.classList.toggle('hidden', !analysisActive)
    scoreTab.classList.toggle('active', !analysisActive)
    analysisTab.classList.toggle('active', analysisActive)
    scoreTab.setAttribute('aria-pressed', String(!analysisActive))
    analysisTab.setAttribute('aria-pressed', String(analysisActive))
  }

  scoreTab.addEventListener('click', () => showPage('score'))
  analysisTab.addEventListener('click', () => showPage('analysis'))

  siteSource.addEventListener('click', () => {
    csvImportVersion += 1
    setSource('site')
  })
  csvSource.addEventListener('click', () => {
    csvImportVersion += 1
    if (csvImports.length === 0) csvInput.click()
    else setSource('csv')
  })
  importCsvButton.addEventListener('click', () => csvInput.click())
  clearCsvButton.addEventListener('click', () => {
    csvImportVersion += 1
    csvImports.length = 0
    renderCsvResult('')
    setSource('site')
  })
  csvInput.addEventListener('change', () => {
    const files = csvInput.files ? [...csvInput.files] : []
    csvInput.value = ''
    void importCsvFiles(files)
  })

  function options() {
    return {
      software: source === 'csv' ? 'all' : state.software,
      nfOnly: state.nfOnly,
      includeUnapproved: source === 'site' && state.includeUnapproved,
    }
  }

  function rebuild(): void {
    if (source === 'csv') {
      state.videos = csvImports.flatMap((item) => item.videos)
      analysis.update(state.videos, { csv: true })
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

  function renderCsvFiles(): void {
    csvFilesNote.classList.toggle('hidden', source !== 'csv' || csvImports.length === 0)
    csvFilesNote.textContent =
      source === 'csv'
        ? csvImports
            .map(
              (item) =>
                `${item.name}：${item.videos.length}/${item.total} 局${item.invalidRows > 0 ? `（${item.invalidRows} 行无效）` : ''}`,
            )
            .join(' · ')
        : ''
  }

  function renderCsvResult(message: string, errors: string[] = []): void {
    csvFeedback.classList.toggle('hidden', message === '')
    csvStatus.textContent = message
    csvErrorDetails.replaceChildren()
    csvErrorDetails.classList.toggle('hidden', errors.length === 0)
    if (errors.length === 0) return
    csvErrorDetails.append(el('summary', undefined, `查看 ${errors.length} 项导入问题`))
    const list = el('ul')
    for (const error of errors.slice(0, 50)) list.append(el('li', undefined, error))
    csvErrorDetails.append(list)
    if (errors.length > 50) csvErrorDetails.append(el('p', undefined, '仅显示前 50 项问题'))
  }

  function setSource(next: 'site' | 'csv'): void {
    if (source === next) return
    source = next
    const csv = next === 'csv'
    siteSource.classList.toggle('active', !csv)
    csvSource.classList.toggle('active', csv)
    importCsvButton.classList.toggle('hidden', !csv)
    clearCsvButton.classList.toggle('hidden', !csv)
    softwareField.classList.toggle('hidden', csv)
    unapprovedLabel.classList.toggle('hidden', csv)
    refreshButton.classList.toggle('hidden', csv)
    selfButton.classList.toggle('hidden', csv)
    if (csv) {
      requestVersion += 1
      const previousController = controller
      controller = null
      pendingUnapproved = false
      previousController?.abort()
      state.loading = false
    }
    nameNode.textContent = csv ? '本地 CSV' : siteName
    idNode.textContent = csv ? `${csvImports.length} 个文件` : `ID ${state.userId}`
    document.title = `${nameNode.textContent} · 玩家数据 · 元神助手`
    state.message = ''
    renderCsvFiles()
    // 网站记录为空时也重建，避免在等待请求期间残留 CSV。
    rebuild()
    if (!csv) {
      if (state.rows.length === 0) void runLoad(false)
      else if (state.includeUnapproved) void loadUnapproved()
    }
  }

  async function importCsvFiles(files: File[]): Promise<void> {
    if (files.length === 0) return
    // 后一次导入取代尚未提交的批次；已完成的批次继续保留。
    const request = ++csvImportVersion
    const current = (): boolean => request === csvImportVersion
    const staged: CsvImport[] = []
    let nextIdBase = csvIdBase
    const errors: string[] = []
    const fileErrors: string[] = []
    for (const file of files) {
      if (file.size > 20 * 1024 * 1024) {
        errors.push(`${file.name}：超过 20 MB`)
        continue
      }
      try {
        const text = await file.text()
        if (!current()) return
        const result = parseStatsCsv(text, nextIdBase)
        for (const error of result.errors) {
          errors.push(`${file.name} 第 ${error.line} 行：${error.message}`)
        }
        if (result.videos.length === 0) {
          errors.push(`${file.name}：没有有效数据`)
          continue
        }
        nextIdBase += result.videos.length
        staged.push({
          name: file.name,
          total: result.total,
          videos: result.videos,
          invalidRows: result.errors.length,
        })
      } catch (error) {
        if (!current()) return
        const message = `${file.name}：${errorMessage(error)}`
        errors.push(message)
        fileErrors.push(message)
      }
    }
    if (!current()) return
    // 整批读取完成且仍有效后再提交，清除操作不会留下半批记录。
    const importedGames = nextIdBase - csvIdBase
    csvIdBase = nextIdBase
    csvImports.push(...staged)
    renderCsvResult(
      `本次导入：成功 ${staged.length} 个文件、${formatCount(importedGames)} 局；失败 ${files.length - staged.length} 个文件` +
        (errors.length > 0 ? `；${errors.length} 项问题` : '') +
        (fileErrors.length > 0 ? `。${fileErrors.slice(0, 3).join('；')}` : ''),
      errors,
    )
    if (staged.length === 0) return
    if (source !== 'csv') setSource('csv')
    else {
      idNode.textContent = `${csvImports.length} 个文件`
      renderCsvFiles()
      rebuild()
    }
  }

  function render(): void {
    const current = options()
    const counted = state.videos.filter((video) => eligible(video, current)).length
    const parts =
      source === 'csv'
        ? [`CSV ${csvImports.length} 个文件`, `录像 ${formatCount(state.videos.length)}`]
        : [`录像 ${formatCount(state.rows.length)}`]
    parts.push(`计入 ${formatCount(counted)}`)
    if (source === 'site') {
      parts.push(`更新于 ${formatDateTime(state.updatedAt)}`)
      if (state.fromCache) parts.push('（缓存）')
    }
    metaNode.textContent = parts.join(' · ')

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
    refreshButton.disabled = loading
    cancelButton.classList.toggle('hidden', !loading)
    if (loading) cancelButton.textContent = '取消'
  }

  async function runLoad(force: boolean): Promise<void> {
    if (source === 'csv' || state.loading) return
    const localController = new AbortController()
    controller = localController
    const request = ++requestVersion
    const current = (): boolean => source === 'site' && request === requestVersion
    const messageAtStart = state.message
    state.message = ''
    setLoading(true, '正在获取录像列表…')
    try {
      const loaded = await loadPlayer(state.userId, {
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
    selfButton.disabled = true
    try {
      let id = await resolveSelfId()
      if (id === null) id = await askSelfId(state.userId)
      if (id === null) {
        state.message = '已取消'
        return
      }
      if (id === state.userId) {
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
    if (source === 'csv') return
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
      const result = await ensureDetails(state.userId, state.rows, ids, {
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

  void runLoad(false)

  try {
    const info = await fetchUserInfo(userId)
    if (info) {
      const name = info.username || info.realname || `#${userId}`
      siteName = name
      if (source === 'site') {
        nameNode.textContent = name
        idNode.textContent = `ID ${userId}`
        document.title = `${name} · 玩家数据 · 元神助手`
      }
    }
  } catch {
    // 名字拿不到不影响主流程。
  }
}
