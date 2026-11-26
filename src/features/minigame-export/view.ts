import { createAboutCard } from '../../shared/about-card'
import { SITE_ORIGIN } from '../../shared/constants'
import { formatDateTime } from '../../shared/format'
import { brandLogo, el, errorMessage, isAbortError } from '../../shared/ui'
import { SiteHistoryClient, loadHistory, type HistorySnapshot, type HistorySource } from './client'
import { WorkerReplayDecoder } from './decoder'
import { downloadReplay } from './download'
import { exportHistory } from './export'
import { filterHistory } from './filter'
import { GAME_LABELS, localHistoryTarget, modeIdentity, modeLabel, type HistoryIssue, type HistoryMetadata } from './model'

interface SourceTab { id: number; title: string; url: string }
const PAGE_SIZE = 50

function button(label: string, primary = false): HTMLButtonElement {
  const node = el('button', primary ? 'button primary' : 'button', label)
  node.type = 'button'
  return node
}

function option(value: string, label: string): HTMLOptionElement {
  const node = el('option', undefined, label)
  node.value = value
  return node
}

function field(label: string, control: HTMLElement): HTMLLabelElement {
  const node = el('label', 'minigame-field')
  control.setAttribute('aria-label', label)
  node.append(el('span', undefined, label), control)
  return node
}

export async function mountMinigameExport(root: HTMLElement): Promise<void> {
  document.title = '小游戏录像导出 · 元神助手'
  let tabs: SourceTab[] = []
  let source: HistorySource | null = null
  let snapshot: HistorySnapshot | null = null
  let rows: HistoryMetadata[] = []
  let selected = new Set<number>()
  let pageIndex = 0
  let controller: AbortController | null = null
  let busy = false
  let refreshingTabs = false
  let filterError = false
  let issues: HistoryIssue[] = []
  let current: ReturnType<typeof localHistoryTarget> = null
  const preferred = new URLSearchParams(location.search).get('tab')

  const page = el('main', 'page minigame-page')
  const header = el('header', 'page-header')
  const brand = el('div', 'page-brand')
  const titles = el('div')
  titles.append(el('h1', undefined, '小游戏录像导出'), el('p', undefined, '元神助手 · 本地历史'))
  brand.append(brandLogo(), titles)
  const settings = el('a', 'site-link', '设置 ↗')
  settings.href = chrome.runtime.getURL('options.html')
  settings.target = '_blank'
  settings.rel = 'noreferrer'
  header.append(brand, settings)

  const playback = el('aside', 'card minigame-playback')
  playback.setAttribute('aria-label', '录像播放提示')
  const playbackText = el('p')
  const playerLink = el('a', undefined, 'Anon Player')
  playerLink.href = 'https://player.lockhart.ren/'
  playerLink.target = '_blank'
  playerLink.rel = 'noopener noreferrer'
  playbackText.append(el('strong', undefined, '左键和标双训练'), '的录像可以在 ', playerLink, ' 播放。')
  playback.append(playbackText, el('p', undefined, '导出 JSON 后导入播放器；多局 ZIP 请先解压。'))

  const connection = el('section', 'card')
  connection.append(el('h2', undefined, '读取本机历史'), el('p', 'desc',
    '从当前浏览器配置中的 openms.top 标签页只读提取。仅包含已保存的成功局；不会上传，也不会修改原始历史。'))
  const sourceSelect = el('select', 'text-input minigame-source')
  const refreshTabs = button('刷新标签页')
  const openSite = button('打开小游戏')
  const readButton = button('读取历史', true)
  const currentButton = button('导出当前回放')
  const cancelButton = button('取消')
  cancelButton.hidden = true
  const sourceActions = el('div', 'actions')
  sourceActions.append(field('站点标签页', sourceSelect), refreshTabs, openSite, readButton, currentButton, cancelButton)
  const status = el('p', 'notice', '请打开保存历史的 openms.top 标签页，然后点击“读取历史”。')
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  const progress = el('progress', 'minigame-progress')
  progress.hidden = true
  connection.append(sourceActions, status, progress)

  const history = el('section', 'card')
  history.append(el('h2', undefined, '本地录像'), el('p', 'desc',
    '导出一条时生成独立的单局 JSON；多条打包为 ZIP，每局一个 JSON。均包含游戏、模式、成绩、完成时间及完整录像。日期按本地时区筛选；更改筛选会清空勾选。'))
  const gameSelect = el('select', 'text-input')
  gameSelect.append(option('', '全部游戏'))
  for (const [key, label] of Object.entries(GAME_LABELS)) gameSelect.append(option(key, label))
  const modeSelect = el('select', 'text-input')
  modeSelect.append(option('', '全部模式'))
  const from = el('input', 'text-input')
  from.type = 'date'
  const to = el('input', 'text-input')
  to.type = 'date'
  const filters = el('div', 'minigame-filters')
  filters.append(field('游戏', gameSelect), field('模式', modeSelect), field('开始日期', from), field('结束日期', to))
  const summary = el('p', 'minigame-summary')
  const selectFiltered = button('勾选筛选结果')
  const clearSelection = button('清空勾选')
  const exportSelected = button('导出所选', true)
  const exportFiltered = button('导出全部筛选')
  const exportActions = el('div', 'actions')
  exportActions.append(selectFiltered, clearSelection, exportSelected, exportFiltered)

  const tableWrap = el('div', 'minigame-table-wrap')
  const table = el('table', 'minigame-table')
  const caption = el('caption', 'minigame-table-caption', '小游戏本地历史')
  const thead = el('thead')
  const headerRow = el('tr')
  const checkHead = el('th')
  const checkPage = el('input')
  checkPage.type = 'checkbox'
  checkPage.setAttribute('aria-label', '勾选当前页录像')
  checkHead.append(checkPage)
  headerRow.append(checkHead)
  for (const label of ['本地编号', '游戏 / 模式', '完成时间', '成绩', '操作']) {
    const th = el('th', undefined, label)
    th.scope = 'col'
    headerRow.append(th)
  }
  thead.append(headerRow)
  const tbody = el('tbody')
  table.append(caption, thead, tbody)
  tableWrap.append(table)
  const empty = el('p', 'minigame-empty', '尚未读取历史')
  const pagination = el('div', 'actions minigame-pagination')
  const previous = button('上一页')
  const next = button('下一页')
  const pageLabel = el('span', 'muted')
  pagination.append(previous, pageLabel, next)
  history.append(filters, summary, exportActions, tableWrap, empty, pagination)

  const issueBox = el('details', 'card minigame-issues')
  issueBox.hidden = true
  const issueTitle = el('summary')
  const issueList = el('ul')
  issueBox.append(issueTitle, issueList)
  const note = el('p', 'minigame-note',
    '单局文件名包含难度、密度、成绩及本地编号；密度 1/2 写作 1-2，无密度时省略。本地编号仅在当前浏览器配置中有效。单条压缩录像上限 16 MiB，单次导出上限 256 MiB。')
  page.append(header, playback, connection, history, issueBox, note, createAboutCard())
  root.replaceChildren(page)

  function setStatus(text: string, error = false): void {
    status.textContent = text
    status.classList.toggle('error', error)
  }

  function renderIssues(): void {
    issueBox.hidden = issues.length === 0
    issueTitle.textContent = `未能读取或导出的记录（${issues.length}）`
    issueList.replaceChildren()
    for (const issue of issues.slice(0, 100)) {
      issueList.append(el('li', undefined, `${issue.id === null ? '未知编号' : `#${issue.id}`}：${issue.error}`))
    }
    if (issues.length > 100) issueList.append(el('li', undefined, `另有 ${issues.length - 100} 条；批量导出的失败信息也会保存在 ZIP 的 errors.txt 中。`))
  }

  function currentEntry(): HistoryMetadata | undefined {
    return snapshot?.entries.find((entry) => entry.id === current?.id && entry.game === current.game)
  }

  function visibleRows(): HistoryMetadata[] { return rows.slice(pageIndex * PAGE_SIZE, (pageIndex + 1) * PAGE_SIZE) }

  function syncControls(): void {
    sourceSelect.disabled = busy || refreshingTabs || tabs.length === 0
    refreshTabs.disabled = busy || refreshingTabs
    openSite.disabled = busy
    readButton.disabled = busy || refreshingTabs || !sourceSelect.value
    currentButton.disabled = busy || !currentEntry() || filterError
    currentButton.textContent = current ? `导出当前回放 #${current.id}` : '导出当前回放'
    currentButton.hidden = current === null
    cancelButton.hidden = !busy
    progress.hidden = !busy
    for (const control of [gameSelect, modeSelect, from, to]) control.disabled = busy || snapshot === null
    selectFiltered.disabled = busy || filterError || rows.length === 0
    clearSelection.disabled = busy || selected.size === 0
    exportSelected.disabled = busy || filterError || selected.size === 0
    exportFiltered.disabled = busy || filterError || rows.length === 0
    exportSelected.textContent = `导出所选（${selected.size}）`
    exportFiltered.textContent = `导出全部筛选（${rows.length}）`
    checkPage.disabled = busy || filterError || rows.length === 0
    const visible = visibleRows()
    const checked = visible.filter((entry) => selected.has(entry.id)).length
    checkPage.checked = visible.length > 0 && checked === visible.length
    checkPage.indeterminate = checked > 0 && checked < visible.length
    previous.disabled = busy || pageIndex === 0
    next.disabled = busy || (pageIndex + 1) * PAGE_SIZE >= rows.length
    summary.textContent = snapshot === null ? '尚未读取' : `已读取 ${snapshot.entries.length} 条 · 筛选 ${rows.length} 条 · 已勾选 ${selected.size} 条`
    pageLabel.textContent = `${pageIndex + 1} / ${Math.max(1, Math.ceil(rows.length / PAGE_SIZE))} 页 · 每页 ${PAGE_SIZE} 条`
  }

  function renderTable(): void {
    tbody.replaceChildren()
    for (const entry of visibleRows()) {
      const row = el('tr', entry.id === current?.id && entry.game === current.game ? 'is-current' : undefined)
      row.dataset.historyId = String(entry.id)
      const checkCell = el('td')
      const check = el('input')
      check.type = 'checkbox'
      check.checked = selected.has(entry.id)
      check.disabled = busy
      check.setAttribute('aria-label', `选择录像 #${entry.id}`)
      check.addEventListener('change', () => {
        if (check.checked) selected.add(entry.id)
        else selected.delete(entry.id)
        syncControls()
      })
      checkCell.append(check)
      const idCell = el('td')
      const link = el('a', undefined, `#${entry.id}`)
      link.href = `${SITE_ORIGIN}/#/minigame/${entry.game}?history=${entry.id}`
      link.target = '_blank'
      link.rel = 'noreferrer'
      link.title = '在当前浏览器中打开本地回放'
      idCell.append(link)
      const gameCell = el('td')
      gameCell.append(el('div', undefined, GAME_LABELS[entry.game]), el('small', 'muted', modeLabel(entry.mode)))
      const actionsCell = el('td')
      const single = button('导出')
      single.disabled = busy
      single.setAttribute('aria-label', `导出录像 #${entry.id}`)
      single.addEventListener('click', () => void runExport([entry]))
      actionsCell.append(single)
      row.append(checkCell, idCell, gameCell, el('td', undefined, formatDateTime(entry.playedAt)),
        el('td', 'minigame-score', `${(entry.scoreMs / 1000).toFixed(3)} 秒`), actionsCell)
      tbody.append(row)
    }
    empty.hidden = rows.length > 0
    tableWrap.hidden = rows.length === 0
    empty.textContent = snapshot === null ? '尚未读取历史' : filterError ? '请修正日期范围' : '此范围内没有已保存的录像'
    syncControls()
  }

  function applyFilters(): void {
    selected.clear()
    pageIndex = 0
    try {
      if (!from.validity.valid || !to.validity.valid) throw new Error('请选择有效的日期')
      rows = filterHistory(snapshot?.entries ?? [], { game: gameSelect.value, mode: modeSelect.value, from: from.value, to: to.value })
      if (filterError) setStatus('日期范围已更新')
      filterError = false
    } catch (error) { rows = []; filterError = true; setStatus(errorMessage(error), true) }
    renderTable()
  }

  function updateModes(): void {
    const previousMode = modeSelect.value
    modeSelect.replaceChildren(option('', '全部模式'))
    const modes = new Map<string, string>()
    for (const entry of snapshot?.entries ?? []) {
      if (!gameSelect.value || entry.game === gameSelect.value) {
        modes.set(modeIdentity(entry), `${GAME_LABELS[entry.game]} · ${modeLabel(entry.mode)}`)
      }
    }
    for (const [key, label] of modes) modeSelect.append(option(key, label))
    if (modes.has(previousMode)) modeSelect.value = previousMode
  }

  function resetSnapshot(): void {
    snapshot = null
    source = null
    selected = new Set()
    rows = []
    issues = []
    pageIndex = 0
    filterError = false
    current = localHistoryTarget(tabs.find((tab) => String(tab.id) === sourceSelect.value)?.url ?? '')
    updateModes()
    renderIssues()
    renderTable()
  }

  async function listTabs(): Promise<void> {
    if (busy || refreshingTabs) return
    refreshingTabs = true
    syncControls()
    try {
      const previousTab = sourceSelect.value || preferred
      const found = await chrome.tabs.query({ url: `${SITE_ORIGIN}/*`, currentWindow: true })
      const otherWindows = await chrome.tabs.query({ url: `${SITE_ORIGIN}/*` })
      const ordered = [...found.filter((tab) => tab.active), ...found, ...otherWindows]
      const seen = new Set<number>()
      tabs = []
      for (const tab of ordered) {
        if (typeof tab.id !== 'number' || !tab.url || seen.has(tab.id)) continue
        if (new URL(tab.url).origin !== SITE_ORIGIN) continue
        seen.add(tab.id)
        tabs.push({ id: tab.id, url: tab.url, title: `${tab.title || 'openms.top'} · 标签页 ${tab.id}` })
      }
      sourceSelect.replaceChildren(...(tabs.length ? tabs.map((tab) => option(String(tab.id), tab.title)) : [option('', '未找到 openms.top 标签页')]))
      if (tabs.some((tab) => String(tab.id) === previousTab)) sourceSelect.value = String(previousTab)
      resetSnapshot()
      setStatus(tabs.length ? '已找到站点标签页，点击“读取历史”开始。更新扩展后请先刷新站点。' : '请先打开保存历史的 openms.top 标签页，再刷新标签页列表。')
    } catch (error) { setStatus(errorMessage(error), true) }
    finally { refreshingTabs = false; syncControls() }
  }

  async function readHistory(): Promise<void> {
    if (busy || !sourceSelect.value) return
    const tabId = Number(sourceSelect.value)
    resetSnapshot()
    busy = true
    controller = new AbortController()
    progress.removeAttribute('value')
    syncControls()
    try {
      const tab = await chrome.tabs.get(tabId)
      if (!tab.url || new URL(tab.url).origin !== SITE_ORIGIN) throw new Error('所选标签页已离开 openms.top，请刷新标签页列表')
      current = localHistoryTarget(tab.url)
      const client = new SiteHistoryClient(tabId)
      const loaded = await loadHistory(client, (count) => setStatus(`正在读取历史…已读取 ${count} 条`), controller.signal)
      controller.signal.throwIfAborted()
      snapshot = loaded
      source = client
      issues = [...loaded.issues]
      updateModes()
      applyFilters()
      const target = currentEntry()
      if (target && rows.some((entry) => entry.id === target.id)) selected.add(target.id)
      if (!filterError) setStatus(`读取完成：${loaded.entries.length} 条${loaded.issues.length ? `，${loaded.issues.length} 条无法读取，见下方详情` : ''}。`
        + (current && !target ? ` 当前回放 #${current.id} 不在可读取的本地历史中。` : ''), loaded.issues.length > 0)
    } catch (error) {
      setStatus(isAbortError(error) ? '已取消读取，没有保留不完整的列表。' : errorMessage(error), !isAbortError(error))
    } finally {
      busy = false
      controller = null
      renderIssues()
      renderTable()
    }
  }

  async function runExport(entries: HistoryMetadata[]): Promise<void> {
    if (busy || filterError || !source || !snapshot?.databaseVersion || !entries.length) return
    if (!from.validity.valid || !to.validity.valid) { applyFilters(); return }
    busy = true
    controller = new AbortController()
    issues = [...snapshot.issues]
    progress.max = entries.length
    progress.value = 0
    renderTable()
    renderIssues()
    setStatus(`正在导出 ${entries.length} 条录像…`)
    try {
      const result = await exportHistory(source, new WorkerReplayDecoder(), entries, snapshot.databaseVersion, (state) => {
        progress.value = state.completed
        setStatus(`正在导出 ${state.completed} / ${state.total} · 成功 ${state.exported} · 失败 ${state.failed}`)
      }, controller.signal)
      controller.signal.throwIfAborted()
      issues.push(...result.issues)
      if (result.blob) {
        downloadReplay(result.blob, result.filename)
        const description = entries.length === 1 ? '单局录像 JSON 文件' : `包含 ${result.exported} 个独立 JSON 的 ZIP 文件`
        setStatus(`已生成${description}${result.issues.length ? `；${result.issues.length} 条失败，文件名已标记 partial，详见下方及 ZIP 中的 errors.txt` : ''}。`, result.issues.length > 0)
      } else setStatus('没有可导出的有效录像，未生成空文件。请查看下方详情。', true)
    } catch (error) { setStatus(isAbortError(error) ? '已取消导出，未生成文件。' : errorMessage(error), !isAbortError(error)) }
    finally {
      busy = false
      controller = null
      renderIssues()
      renderTable()
    }
  }

  sourceSelect.addEventListener('change', () => { resetSnapshot(); setStatus('标签页已切换，请重新读取历史。') })
  refreshTabs.addEventListener('click', () => void listTabs())
  openSite.addEventListener('click', () => {
    void chrome.tabs.create({ url: `${SITE_ORIGIN}/#/minigame/flag-chord` }).catch((error: unknown) => setStatus(errorMessage(error), true))
  })
  readButton.addEventListener('click', () => void readHistory())
  currentButton.addEventListener('click', () => { const entry = currentEntry(); if (entry) void runExport([entry]) })
  cancelButton.addEventListener('click', () => controller?.abort())
  gameSelect.addEventListener('change', () => { modeSelect.value = ''; updateModes(); applyFilters() })
  for (const control of [modeSelect, from, to]) control.addEventListener('change', applyFilters)
  for (const control of [from, to]) control.addEventListener('input', applyFilters)
  selectFiltered.addEventListener('click', () => { selected = new Set(rows.map((entry) => entry.id)); renderTable() })
  clearSelection.addEventListener('click', () => { selected.clear(); renderTable() })
  checkPage.addEventListener('change', () => {
    for (const entry of visibleRows()) {
      if (checkPage.checked) selected.add(entry.id)
      else selected.delete(entry.id)
    }
    renderTable()
  })
  exportSelected.addEventListener('click', () => void runExport(rows.filter((entry) => selected.has(entry.id))))
  exportFiltered.addEventListener('click', () => void runExport([...rows]))
  previous.addEventListener('click', () => { pageIndex--; renderTable() })
  next.addEventListener('click', () => { pageIndex++; renderTable() })
  window.addEventListener('beforeunload', () => controller?.abort())
  renderTable()
  await listTabs()
}
