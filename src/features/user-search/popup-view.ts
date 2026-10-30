import { MAX_RESULTS } from '../../shared/constants'
import { formatCount, formatRelativeTime } from '../../shared/format'
import { icon } from '../../shared/icons'
import { addLog } from '../../shared/log'
import { getSettings, saveSettings, type Settings } from '../../shared/settings'
import { onDataChanged } from '../../shared/bus'
import { getWatchSettings } from '../upload-watch/settings'
import {
  debounce,
  el,
  errorMessage,
  openOptionsPage,
  openPlayerTab,
} from '../../shared/ui'
import {
  DEFAULT_SYNC_META,
  getAllUsers,
  getSyncMeta,
  type SyncMeta,
} from './db'
import { lookupIdentifiers, type IdentifierLookup } from './identifier'
import {
  displayName,
  normalize,
  secondaryName,
  type UserRecord,
} from './model'
import {
  mergeIdentifierItems,
  searchRecords,
  type IdentifierOnlyHit,
  type UserHit,
} from './search'
import {
  runSync,
  SyncAbortError,
  SyncBusyError,
  type SyncProgress,
} from './sync'

interface RenderedRow {
  element: HTMLButtonElement
}

export async function mountUserSearchPopup(root: HTMLElement): Promise<void> {
  document.title = '元神助手'

  let records: UserRecord[] = []
  let recordsById = new Map<number, UserRecord>()
  let meta: SyncMeta = { ...DEFAULT_SYNC_META }
  let settings: Settings | null = null
  let identifierEnabled = false

  let hits: UserHit[] = []
  let identifierOnly: IdentifierOnlyHit[] = []
  let selectedIndex = -1
  let renderedRows: RenderedRow[] = []

  let syncing = false
  let syncProgress: SyncProgress | null = null
  let statusOverride: string | null = null
  let statusTimer: ReturnType<typeof setTimeout> | undefined

  let remoteSeq = 0
  let remoteTimer: ReturnType<typeof setTimeout> | undefined
  let remoteLoading = false
  let remoteMessage = ''

  root.replaceChildren()

  const header = el('header', 'popup-header')
  const brand = el('div', 'brand')
  brand.append(el('span', 'brand-name', '元神助手'), el('span', 'brand-sub', '用户搜索'))
  const optionsButton = el('button', 'icon-button')
  optionsButton.type = 'button'
  optionsButton.title = '设置'
  optionsButton.setAttribute('aria-label', '打开设置')
  optionsButton.append(icon('settings'))
  optionsButton.addEventListener('click', () => openOptionsPage())

  const uploadButton = el('button', 'icon-button upload-entry')
  uploadButton.type = 'button'
  uploadButton.title = '自动上传'
  uploadButton.setAttribute('aria-label', '打开自动上传')
  uploadButton.append(icon('upload'))
  uploadButton.addEventListener('click', () => {
    void chrome.tabs.create({ url: chrome.runtime.getURL('upload.html') })
  })

  const headerActions = el('div', 'header-actions')
  headerActions.append(uploadButton, optionsButton)
  header.append(brand, headerActions)

  void getWatchSettings()
    .then((watch) => {
      if (watch.state === 'watching') {
        uploadButton.classList.add('is-running')
        uploadButton.title = '自动上传 · 监视中'
        return
      }
      if (watch.state === 'waiting-login') {
        uploadButton.classList.add('needs-attention')
        uploadButton.title = '自动上传 · 等待登录'
        return
      }
      if (watch.state === 'needs-permission') {
        uploadButton.classList.add('needs-attention')
        uploadButton.title = '自动上传 · 需要重新授权'
        return
      }
      if (watch.state === 'stopped') {
        uploadButton.classList.add('is-stopped')
        uploadButton.title = '自动上传 · 已停止'
      }
    })
    .catch(() => undefined)

  const searchBox = el('div', 'search-box')
  searchBox.append(icon('search'))
  const searchInput = el('input', 'search-input') as HTMLInputElement
  searchInput.type = 'search'
  searchInput.placeholder = '用户名 / 实名 / 拼音 / ID'
  searchInput.autocomplete = 'off'
  searchInput.spellcheck = false
  searchInput.setAttribute('aria-label', '搜索用户')
  searchBox.append(searchInput)

  const searchRow = el('div', 'search-row')
  const identifierToggle = el('button', 'identifier-toggle')
  identifierToggle.type = 'button'
  identifierToggle.append(el('span', 'toggle-glyph', '标'), el('span', 'toggle-slash'))
  searchRow.append(searchBox, identifierToggle)

  const results = el('main', 'results')
  results.id = 'search-results'
  results.setAttribute('role', 'listbox')
  results.setAttribute('aria-label', '搜索结果')

  const hint = el('div', 'hint')
  hint.hidden = true

  const statusbar = el('footer', 'statusbar')
  const statusText = el('span', 'status-text', '尚未同步')
  const syncButton = el('button', 'sync-button')
  syncButton.type = 'button'
  syncButton.title = '同步用户数据'
  const syncIcon = icon('refresh')
  const syncLabel = el('span', undefined, '同步')
  syncButton.append(syncIcon, syncLabel)
  statusbar.append(statusText, syncButton)

  root.append(header, searchRow, results, hint, statusbar)
  renderIdentifierToggle()
  identifierToggle.addEventListener('click', () => void toggleIdentifierLookup())

  function renderIdentifierToggle(): void {
    identifierToggle.classList.toggle('is-on', identifierEnabled)
    identifierToggle.classList.toggle('is-off', !identifierEnabled)
    identifierToggle.setAttribute('aria-pressed', String(identifierEnabled))
    const label = identifierEnabled
      ? '标识反查：已开启，点击关闭'
      : '标识反查：已关闭，点击开启'
    identifierToggle.title = label
    identifierToggle.setAttribute('aria-label', label)
  }

  async function toggleIdentifierLookup(): Promise<void> {
    identifierEnabled = !identifierEnabled
    renderIdentifierToggle()

    if (!identifierEnabled) {
      remoteSeq += 1
      if (remoteTimer !== undefined) {
        clearTimeout(remoteTimer)
        remoteTimer = undefined
      }
      remoteLoading = false
      remoteMessage = ''

      const raw = searchInput.value
      hits = normalize(raw) ? searchRecords(records, raw) : []
      identifierOnly = []
      renderResults()
    } else {
      if (remoteTimer !== undefined) {
        clearTimeout(remoteTimer)
        remoteTimer = undefined
      }
      if (shouldQueryRemote(searchInput.value)) {
        void queryRemote()
      }
    }

    try {
      settings = await saveSettings({ identifierLookupEnabled: identifierEnabled })
    } catch {
      setStatusOverride('设置保存失败', 4_000)
    }
  }

  function setStatusOverride(text: string, timeoutMs = 4_000): void {
    statusOverride = text
    renderStatus()
    if (statusTimer !== undefined) clearTimeout(statusTimer)
    statusTimer = setTimeout(() => {
      statusOverride = null
      renderStatus()
    }, timeoutMs)
  }

  function renderStatus(): void {
    let text: string

    if (syncing) {
      if (syncProgress?.phase === 'listing') {
        text = '正在获取用户列表…'
      } else if (syncProgress && syncProgress.totalBatches > 0) {
        text = `同步中… 第 ${syncProgress.batch}/${syncProgress.totalBatches} 批`
      } else {
        text = '同步中…'
      }
    } else if (statusOverride) {
      text = statusOverride
    } else if (records.length === 0) {
      text = '尚未同步'
    } else {
      const when = meta.lastSyncAt
        ? `${formatRelativeTime(meta.lastSyncAt)}同步`
        : '尚未同步'
      const unfinished = meta.phase !== 'idle' ? ' · 上次未完成' : ''
      text = `本地 ${formatCount(records.length)} 人 · ${when}${unfinished}`
    }

    statusText.textContent = text
    statusText.title = text
    syncButton.disabled = syncing
    syncButton.setAttribute('aria-busy', String(syncing))
    syncIcon.classList.toggle('spin', syncing)
  }

  function setHint(text: string | null): void {
    hint.hidden = !text
    hint.textContent = text ?? ''
  }

  function renderEmpty(): HTMLElement {
    const box = el('div', 'empty')

    if (records.length === 0) {
      box.append(el('div', undefined, '尚未同步本地用户数据'))
      const actions = el('div', 'empty-actions')
      const syncNow = el('button', 'button primary', '立即同步')
      syncNow.type = 'button'
      syncNow.addEventListener('click', () => void quickSync())
      const openOptions = el('button', 'button', '打开设置')
      openOptions.type = 'button'
      openOptions.addEventListener('click', () => openOptionsPage())
      actions.append(syncNow, openOptions)
      box.append(actions)
      return box
    }

    if (remoteLoading) {
      box.append(el('div', undefined, '正在远程查询标识…'))
      return box
    }

    if (remoteMessage) {
      box.append(el('div', undefined, remoteMessage))
      return box
    }

    if (!normalize(searchInput.value)) {
      box.append(el('div', undefined, '输入用户名、实名、拼音或 ID'))
      return box
    }

    box.append(el('div', undefined, '没有匹配的用户'))
    return box
  }

  function userRow(hit: UserHit): HTMLButtonElement {
    const button = el('button', 'result')
    button.type = 'button'
    button.setAttribute('role', 'option')
    button.dataset.id = String(hit.record.id)

    const top = el('div', 'result-top')
    const name = el('span', 'result-name', displayName(hit.record))
    const id = el('span', 'result-id', `ID ${hit.record.id}`)
    top.append(name, id)

    const sub = el('div', 'result-sub')
    if (hit.record.nameState === 'hidden') {
      sub.append(el('span', 'badge', '实名已隐藏'))
    } else {
      sub.append(el('span', 'result-sub-text', secondaryName(hit.record)))
    }
    if (hit.source === 'id') sub.append(el('span', 'tag', 'ID'))
    if (hit.identifiers.length > 0) {
      sub.append(
        el(
          'span',
          'tag tag-kind',
          hit.identifiers.length > 1 ? `标识 ×${hit.identifiers.length}` : '标识',
        ),
      )
    }

    button.append(top, sub)
    button.title = `${displayName(hit.record)} · ID ${hit.record.id}`
    button.addEventListener('click', () => void openUser(hit.record.id))
    return button
  }

  function identifierRow(item: IdentifierOnlyHit): HTMLElement {
    const canOpen = item.userId !== null
    const node = el(canOpen ? 'button' : 'div', 'result result-identifier')
    if (canOpen) {
      ;(node as HTMLButtonElement).type = 'button'
      node.setAttribute('role', 'option')
    } else {
      node.classList.add('unbound')
      node.setAttribute('aria-disabled', 'true')
    }

    const top = el('div', 'result-top')
    top.append(el('span', 'tag tag-kind', '标识'))
    top.append(el('span', 'result-name', item.identifier))
    if (item.userId !== null) {
      top.append(el('span', 'result-id', `ID ${item.userId}`))
    } else {
      top.append(el('span', 'tag tag-warn', '未绑定'))
    }

    const sub = el('div', 'result-sub')
    sub.append(
      el(
        'span',
        'result-sub-text',
        item.userId !== null
          ? '站内命中，但本地用户表没有该 ID；点击打开主页'
          : '该标识存在，但没有关联站内账号，无法打开主页',
      ),
    )

    node.append(top, sub)
    node.title = canOpen
      ? `标识 ${item.identifier} · 绑定到 ID ${item.userId}`
      : `标识 ${item.identifier} · 未绑定站内账号`
    if (canOpen) {
      node.addEventListener('click', () => void openUser(item.userId as number))
    }
    return node
  }

  function updateSelection(): void {
    renderedRows.forEach((row, index) => {
      const selected = index === selectedIndex
      row.element.classList.toggle('selected', selected)
      row.element.setAttribute('aria-selected', String(selected))
    })
  }

  function renderResults(): void {
    results.replaceChildren()
    renderedRows = []
    selectedIndex = -1

    const query = normalize(searchInput.value)
    if (!query) {
      results.append(renderEmpty())
      setHint(null)
      return
    }

    const visibleUsers = hits.slice(0, MAX_RESULTS)
    const remainingSlots = Math.max(0, MAX_RESULTS - visibleUsers.length)
    const visibleIdentifiers = identifierOnly.slice(0, Math.min(10, remainingSlots))

    for (const hit of visibleUsers) {
      const button = userRow(hit)
      results.append(button)
      renderedRows.push({ element: button })
    }

    if (visibleIdentifiers.length > 0) {
      const divider = el('div', 'results-divider')
      divider.append(
        el('span', 'results-divider-title', '标识结果'),
        el('span', undefined, `${visibleIdentifiers.length} 条`),
      )
      results.append(divider)
    }

    for (const item of visibleIdentifiers) {
      const node = identifierRow(item)
      results.append(node)
      if (node instanceof HTMLButtonElement) {
        renderedRows.push({ element: node })
      }
    }

    if (visibleUsers.length + visibleIdentifiers.length === 0) {
      results.append(renderEmpty())
      setHint(null)
      return
    }

    const total = hits.length + identifierOnly.length
    const shown = visibleUsers.length + visibleIdentifiers.length
    if (total > shown) {
      setHint(`还有 ${total - shown} 条，请继续输入`)
    } else if (remoteLoading) {
      setHint('正在远程查询标识…')
    } else if (remoteMessage) {
      setHint(remoteMessage)
    } else {
      setHint(null)
    }

    updateSelection()
  }

  async function openUser(id: number): Promise<void> {
    try {
      await openPlayerTab(id)
      window.close()
    } catch (error) {
      setStatusOverride(`打开失败：${errorMessage(error)}`, 5_000)
    }
  }

  function localSearch(): void {
    const raw = searchInput.value
    if (!normalize(raw)) {
      hits = []
      identifierOnly = []
      remoteLoading = false
      remoteMessage = ''
      renderResults()
      return
    }

    hits = searchRecords(records, raw)
    identifierOnly = []
    renderResults()
  }

  function shouldQueryRemote(raw: string): boolean {
    return identifierEnabled && normalize(raw).length >= 3 && hits.length < 5
  }

  function scheduleRemote(): void {
    if (remoteTimer !== undefined) clearTimeout(remoteTimer)
    if (!identifierEnabled) return
    if (!shouldQueryRemote(searchInput.value)) return

    remoteTimer = setTimeout(() => {
      void queryRemote()
    }, 400)
  }

  async function queryRemote(): Promise<void> {
    if (!identifierEnabled) return
    if (remoteLoading) return
    const raw = searchInput.value
    if (!shouldQueryRemote(raw)) return

    remoteSeq += 1
    const seq = remoteSeq
    remoteLoading = true
    remoteMessage = ''
    renderResults()

    let result: IdentifierLookup
    try {
      result = await lookupIdentifiers(raw)
    } catch {
      remoteLoading = false
      remoteMessage = '远程查询失败，仅显示本地结果'
      renderResults()
      return
    }
    if (seq !== remoteSeq || raw !== searchInput.value) return

    remoteLoading = false

    if (result.kind === 'ok') {
      const merged = mergeIdentifierItems(hits, result.items, recordsById)
      hits = merged.users
      identifierOnly = merged.identifierOnly
      if (result.items.length === 0) {
        remoteMessage = '没有找到匹配的标识'
      }
      renderResults()
      return
    }

    if (result.kind === 'skip') {
      remoteMessage =
        result.reason === 'budget' ? '远程查询已达上限，仅显示本地结果' : ''
      renderResults()
      return
    }

    if (result.reason === 'aborted') {
      renderResults()
      return
    }

    if (result.reason === 'toomany') {
      remoteMessage = '匹配过多，请输入更完整的标识'
    } else if (result.reason === 'rate') {
      remoteMessage = '远程查询已达上限，仅显示本地结果'
    } else {
      remoteMessage = '远程查询失败，仅显示本地结果'
    }
    renderResults()
  }

  async function quickSync(): Promise<void> {
    if (syncing) return

    syncing = true
    syncProgress = null
    statusOverride = null
    renderStatus()

    const controller = new AbortController()
    try {
      const result = await runSync(
        records.length > 0 && meta.phase === 'idle' ? 'incremental' : 'full',
        {
          signal: controller.signal,
          resume: true,
          onProgress: (progress) => {
            syncProgress = progress
            renderStatus()
          },
        },
      )

      await reload()
      setStatusOverride(
        result.updated > 0 ? `已更新 ${result.updated} 人` : '已是最新',
      )
      await addLog(
        'info',
        `快捷同步完成：${result.mode}，${result.requests} 个请求`,
      ).catch(() => {})
    } catch (error) {
      if (error instanceof SyncBusyError) {
        setStatusOverride('正在同步中')
      } else if (error instanceof SyncAbortError) {
        setStatusOverride('已取消')
      } else {
        setStatusOverride(`同步失败：${errorMessage(error)}`, 6_000)
        await addLog('error', `快捷同步失败：${errorMessage(error)}`).catch(() => {})
      }
    } finally {
      syncing = false
      syncProgress = null
      renderStatus()
    }
  }

  async function reload(): Promise<void> {
    records = await getAllUsers()
    recordsById = new Map(records.map((record) => [record.id, record]))
    meta = await getSyncMeta()

    const raw = searchInput.value
    if (normalize(raw)) {
      hits = searchRecords(records, raw)
      identifierOnly = []
    } else {
      hits = []
      identifierOnly = []
    }

    renderResults()
    renderStatus()
  }

  function selectedRow(): RenderedRow | undefined {
    if (selectedIndex < 0) return undefined
    return renderedRows[selectedIndex]
  }

  function activeOrFirstRow(): RenderedRow | undefined {
    return selectedRow() ?? renderedRows[0]
  }

  function moveSelection(delta: number): void {
    if (renderedRows.length === 0) return
    if (selectedIndex < 0) {
      selectedIndex = delta > 0 ? 0 : renderedRows.length - 1
    } else {
      selectedIndex =
        (selectedIndex + delta + renderedRows.length) % renderedRows.length
    }
    updateSelection()
    renderedRows[selectedIndex]?.element.scrollIntoView({ block: 'nearest' })
  }

  const debouncedSearch = debounce(localSearch, 120)

  searchInput.addEventListener('input', () => {
    remoteSeq += 1
    remoteLoading = false
    remoteMessage = ''
    selectedIndex = -1
    debouncedSearch()
    scheduleRemote()
  })

  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveSelection(1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveSelection(-1)
    }
  })

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      window.close()
      return
    }

    if (event.key !== 'Enter') return
    if (
      document.activeElement === syncButton ||
      document.activeElement === optionsButton ||
      document.activeElement === identifierToggle
    ) {
      return
    }

    event.preventDefault()

    if (renderedRows.length === 0 && shouldQueryRemote(searchInput.value)) {
      if (remoteTimer !== undefined) clearTimeout(remoteTimer)
      void queryRemote()
      return
    }

    activeOrFirstRow()?.element.click()
  })

  syncButton.addEventListener('click', () => void quickSync())

  window.addEventListener('focus', () => {
    void reload()
  })

  onDataChanged(() => {
    void reload()
  })

  settings = await getSettings()
  identifierEnabled = settings.identifierLookupEnabled
  renderIdentifierToggle()
  await reload()
  if (identifierEnabled) scheduleRemote()
  searchInput.focus()

  if (
    settings.autoIncrementalOnPopup &&
    records.length > 0 &&
    Date.now() - meta.lastSyncAt > 60_000
  ) {
    void quickSync()
  }
}
