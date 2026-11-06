import {
  formatCount,
  formatDateTime,
} from '../../../shared/format'
import { el } from '../../../shared/ui'
import type { CsvSession } from '../csv-session'
import { formatValidDelta } from '../csv-sources'
import type { PlayerSnapshot, PlayerSource } from '../player-state'

const CSV_FORMAT_HINT =
  '首行表头为 Arbiter / 元扫雷 的 31 列格式（Day、Month、Year、Hour、Min、Sec、mode、Time、BBBV、BBBVs、style 等），单文件不超过 20 MB。'

export interface CsvPanelOptions {
  onSelectSource(source: PlayerSource): void
  onEnterCsv(): void
  onAddFiles(): void
  onRelink(sourceId: string): void
  onRemoveSource(sourceId: string): void
  onRemoveAll(): void
  onRefresh(): void
  onCancel(): void
  onGrant(sourceId: string): void
}

export interface CsvPanel {
  sourceBar: HTMLElement
  empty: HTMLElement
  panel: HTMLElement
  feedback: HTMLElement
  /** 浏览器没有文件句柄 API 时，由点击隐藏 input 取得本次文件。 */
  requestFiles(multiple: boolean): Promise<File[]>
  render(snapshot: PlayerSnapshot, session: CsvSession): void
}

/** 本地 CSV：来源选择、空态、关联清单、读取进度与解析反馈。 */
export function createCsvPanel(options: CsvPanelOptions): CsvPanel {
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

  const feedback = el('div', 'source-files hidden')
  const csvStatus = el('p')
  csvStatus.setAttribute('role', 'status')
  csvStatus.setAttribute('aria-live', 'polite')
  csvStatus.setAttribute('aria-atomic', 'true')
  const csvErrorDetails = el('details', 'hidden')
  feedback.append(csvStatus, csvErrorDetails)

  const empty = el('section', 'csv-empty hidden')
  const emptyTitle = el('h2', 'card-title', '本地 CSV 分析')
  const emptyText = el(
    'p',
    'csv-empty-text',
    '首次使用选择一个或多个本地 CSV：扩展会记住这些文件，之后重新打开本页，点击「刷新」就能读取最新内容，不用每次重新选择。支持 Arbiter / 元扫雷 CSV 文件，多文件直接合并、不去重。',
  )
  const emptyButton = el('button', 'button primary', '选择 CSV 文件')
  emptyButton.type = 'button'
  const emptyCancel = el('button', 'button hidden', '取消读取')
  emptyCancel.type = 'button'
  const emptyActions = el('div', 'csv-empty-actions')
  emptyActions.append(emptyButton, emptyCancel)
  const emptyNote = el('p', 'csv-empty-note hidden')
  const emptyRemember = el(
    'p',
    'csv-empty-note csv-empty-remember hidden',
    '当前浏览器不支持记住文件，重新打开后需要再次选择。',
  )
  const emptyFormat = el('details', 'csv-empty-format')
  emptyFormat.append(
    el('summary', undefined, 'CSV 格式说明'),
    el('p', undefined, CSV_FORMAT_HINT),
  )
  empty.append(emptyTitle, emptyText, emptyActions, emptyNote, emptyRemember, emptyFormat)

  const panel = el('section', 'csv-sources hidden')
  const panelHead = el('div', 'csv-sources-head')
  const panelTitle = el('h2', 'card-title', '本地 CSV 文件')
  const panelActions = el('div', 'csv-source-actions')
  const addButton = el('button', 'button', '添加 CSV')
  const refreshButton = el('button', 'button primary', '刷新')
  const cancelButton = el('button', 'button hidden', '取消读取')
  const clearButton = el('button', 'button', '移除全部')
  for (const node of [addButton, refreshButton, cancelButton, clearButton]) {
    node.type = 'button'
  }
  panelActions.append(addButton, refreshButton, cancelButton, clearButton)
  panelHead.append(panelTitle, panelActions)
  const panelNote = el('p', 'csv-sources-note')
  const list = el('ul', 'csv-source-list')
  panel.append(panelHead, panelNote, list)

  let pendingInput: ((files: File[]) => void) | null = null

  function requestFiles(multiple: boolean): Promise<File[]> {
    return new Promise((resolve) => {
      // 上一次选择还没返回时先放弃它，避免两个点击共用同一个输入。
      pendingInput?.([])
      pendingInput = resolve
      csvInput.multiple = multiple
      csvInput.click()
    })
  }

  siteSource.addEventListener('click', () => options.onSelectSource('site'))
  csvSource.addEventListener('click', () => options.onEnterCsv())
  emptyButton.addEventListener('click', () => options.onAddFiles())
  emptyCancel.addEventListener('click', () => options.onCancel())
  addButton.addEventListener('click', () => options.onAddFiles())
  refreshButton.addEventListener('click', () => options.onRefresh())
  cancelButton.addEventListener('click', () => options.onCancel())
  clearButton.addEventListener('click', () => options.onRemoveAll())
  csvInput.addEventListener('change', () => {
    const files = csvInput.files ? [...csvInput.files] : []
    csvInput.value = ''
    const resolve = pendingInput
    pendingInput = null
    resolve?.(files)
  })

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

  function renderList(session: CsvSession): void {
    list.replaceChildren()
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
            options.onGrant(record.sourceId),
          ),
        )
      }
      actions.append(
        sourceButton('重新关联', `重新关联 ${label}`, current.loading, () =>
          options.onRelink(record.sourceId),
        ),
        sourceButton('移除', `移除 ${label}`, current.loading, () =>
          options.onRemoveSource(record.sourceId),
        ),
      )
      item.append(main, actions)
      list.append(item)
    })
  }

  function renderFeedback(session: CsvSession): void {
    const current = session.state
    feedback.classList.toggle('hidden', current.message === '')
    csvStatus.textContent = current.message
    csvErrorDetails.replaceChildren()
    csvErrorDetails.classList.toggle('hidden', current.errors.length === 0)
    if (current.errors.length === 0) return
    csvErrorDetails.append(
      el('summary', undefined, `查看 ${current.errors.length} 项解析问题`),
    )
    const errors = el('ul')
    for (const error of current.errors.slice(0, 50)) errors.append(el('li', undefined, error))
    csvErrorDetails.append(errors)
    if (current.errors.length > 50) {
      csvErrorDetails.append(el('p', undefined, '仅显示前 50 项问题'))
    }
  }

  function render(snapshot: PlayerSnapshot, session: CsvSession): void {
    const current = session.state
    const emptyState =
      snapshot.standaloneCsv && current.ready && current.sources.length === 0
    sourceBar.classList.toggle('hidden', snapshot.embedded || emptyState)
    empty.classList.toggle('hidden', !emptyState)
    panel.classList.toggle(
      'hidden',
      snapshot.embedded || !(snapshot.source === 'csv' && current.sources.length > 0),
    )
    addButton.disabled = current.loading
    refreshButton.disabled = current.loading || current.sources.length === 0
    refreshButton.classList.toggle('hidden', current.loading)
    cancelButton.classList.toggle('hidden', !current.loading)
    clearButton.disabled = current.sources.length === 0
    emptyButton.disabled = current.loading
    emptyCancel.classList.toggle('hidden', !current.loading)
    emptyNote.classList.toggle('hidden', !current.loading)
    emptyNote.textContent = '正在读取选中的文件…'
    emptyRemember.classList.toggle('hidden', snapshot.csvPersistent)

    siteSource.classList.toggle('active', snapshot.source === 'site')
    csvSource.classList.toggle('active', snapshot.source === 'csv')
    siteSource.classList.toggle('hidden', snapshot.standaloneCsv)
    csvSource.classList.toggle('hidden', snapshot.standaloneCsv)

    if (current.loading && current.progress) {
      panelNote.textContent = `正在读取 ${current.progress.done}/${current.progress.total} 个文件…`
    } else if (snapshot.source === 'csv' && current.sources.length > 0 && !session.hasSnapshot()) {
      panelNote.textContent = `已关联 ${current.sources.length} 个文件，点击「刷新」加载成绩。`
    } else if (snapshot.source === 'csv' && session.hasSnapshot()) {
      const last = Math.max(
        0,
        ...current.sources.map(
          (record) => session.sourceSummary(record.sourceId)?.readAt ?? 0,
        ),
      )
      panelNote.textContent =
        `已加载 ${current.sources.length} 个文件、${formatCount(session.loadedCount())} 局` +
        (last > 0 ? ` · 上次读取 ${formatDateTime(last)}` : '')
    } else {
      panelNote.textContent = ''
    }

    renderList(session)
    renderFeedback(session)
  }

  return { sourceBar, empty, panel, feedback, requestFiles, render }
}
