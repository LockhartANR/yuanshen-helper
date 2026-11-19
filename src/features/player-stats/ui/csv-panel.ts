import {
  formatCount,
  formatDateTime,
} from '../../../shared/format'
import { el } from '../../../shared/ui'
import type { CsvSession } from '../csv-session'
import { formatValidDelta } from '../csv-sources'
import type {
  CsvRelinkChoice,
  CsvRelinkMode,
  CsvRepairDecision,
  CsvRepairPick,
  CsvRepairTarget,
} from '../player-controller'
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
  onRepair(): void
}

export interface CsvPanel {
  sourceBar: HTMLElement
  empty: HTMLElement
  panel: HTMLElement
  feedback: HTMLElement
  /** 浏览器没有文件句柄 API 时，由点击隐藏 input 取得本次文件。 */
  requestFiles(multiple: boolean): Promise<File[]>
  /** 重新关联到不同文件时，让用户明确选择是否沿用原排除规则。 */
  confirmRelink(choice: CsvRelinkChoice): Promise<CsvRelinkMode>
  /** 批量修复：逐来源选择文件并决定是否沿用原排除规则。 */
  confirmRepair(
    targets: readonly CsvRepairTarget[],
    pick: (sourceId: string) => Promise<CsvRepairPick | null>,
  ): Promise<CsvRepairDecision[] | 'cancel'>
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
  const repairButton = el('button', 'button hidden', '修复文件关联')
  const clearButton = el('button', 'button', '清空关联清单')
  for (const node of [addButton, refreshButton, cancelButton, repairButton, clearButton]) {
    node.type = 'button'
  }
  panelActions.append(addButton, refreshButton, cancelButton, repairButton, clearButton)
  panelHead.append(panelTitle, panelActions)
  const panelNote = el('p', 'csv-sources-note')
  const list = el('ul', 'csv-source-list')

  const relinkBox = el('section', 'csv-relink-choice hidden')
  relinkBox.setAttribute('role', 'dialog')
  relinkBox.setAttribute('aria-labelledby', 'csv-relink-title')
  const relinkTitle = el('h3', 'csv-relink-title', '重新关联 CSV')
  relinkTitle.id = 'csv-relink-title'
  relinkTitle.tabIndex = -1
  const relinkText = el('p', 'csv-relink-text')
  const relinkActions = el('div', 'csv-relink-actions')
  const inheritButton = el('button', 'button primary', '沿用原排除规则')
  const freshButton = el('button', 'button', '作为新来源')
  const cancelRelinkButton = el('button', 'button', '取消')
  for (const node of [inheritButton, freshButton, cancelRelinkButton]) node.type = 'button'
  relinkActions.append(inheritButton, freshButton, cancelRelinkButton)
  const relinkHint = el(
    'p',
    'csv-relink-hint',
    '沿用只延续规则来源关系，仍会按新文件逐条匹配；无法确认的重复条目保持未匹配，不会猜测排除。',
  )
  relinkBox.append(relinkTitle, relinkText, relinkActions, relinkHint)

  // ---- 批量修复关联 ----
  const repairBox = el('section', 'csv-repair-choice hidden')
  repairBox.setAttribute('role', 'dialog')
  repairBox.setAttribute('aria-labelledby', 'csv-repair-title')
  const repairTitle = el('h3', 'csv-repair-title', '修复文件关联')
  repairTitle.id = 'csv-repair-title'
  repairTitle.tabIndex = -1
  const repairText = el(
    'p',
    'csv-repair-text',
    '为下面每个来源重新选择文件。修复不会清空扩展数据、排行榜配置或其他来源的排除规则。',
  )
  const repairList = el('div', 'csv-repair-list')
  const repairHint = el(
    'p',
    'csv-repair-hint',
    '无法确认文件身份时不会自动沿用排除规则；需要沿用请在对应行明确选择。两个来源不能绑定同一个文件。',
  )
  const repairActions = el('div', 'csv-repair-actions')
  const applyRepairButton = el('button', 'button primary', '开始修复')
  const cancelRepairButton = el('button', 'button', '取消')
  for (const node of [applyRepairButton, cancelRepairButton]) node.type = 'button'
  applyRepairButton.disabled = true
  repairActions.append(applyRepairButton, cancelRepairButton)
  repairBox.append(repairTitle, repairText, repairList, repairHint, repairActions)
  panel.append(panelHead, panelNote, list, relinkBox, repairBox)
  let pendingInput: ((files: File[]) => void) | null = null
  let pendingRelink: ((mode: CsvRelinkMode) => void) | null = null
  let relinkFocus: HTMLElement | null = null

  function finishRelink(mode: CsvRelinkMode): void {
    const resolve = pendingRelink
    pendingRelink = null
    relinkBox.classList.add('hidden')
    resolve?.(mode)
    const target = relinkFocus
    relinkFocus = null
    target?.focus?.()
  }

  function confirmRelink(choice: CsvRelinkChoice): Promise<CsvRelinkMode> {
    // 上一次选择尚未返回时先按取消处理，绝不让两个关联流程共用同一个选择。
    pendingRelink?.('cancel')
    pendingRelink = null
    relinkText.textContent =
      `当前来源「${choice.sourceName}」有 ${choice.ruleCount} 条排除规则。` +
      `是否把「${choice.newName}」视为原成绩来源的后续版本？`
    relinkBox.classList.remove('hidden')
    return new Promise<CsvRelinkMode>((resolve) => {
      pendingRelink = (mode) => resolve(mode)
      const active =
        typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null
      relinkFocus = active && typeof active.focus === 'function' ? active : null
      inheritButton.disabled = choice.ruleCount === 0
      inheritButton.title =
        choice.ruleCount === 0
          ? '当前来源没有可沿用的排除规则'
          : '保留原规则并逐条匹配新文件'
      relinkTitle.focus()
    })
  }

  inheritButton.addEventListener('click', () => finishRelink('inherit'))
  freshButton.addEventListener('click', () => finishRelink('new'))
  cancelRelinkButton.addEventListener('click', () => finishRelink('cancel'))
  relinkBox.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      finishRelink('cancel')
    }
  })

  interface RepairRow {
    target: CsvRepairTarget
    pickButton: HTMLButtonElement
    modeSelect: HTMLSelectElement
    targetName: HTMLElement
    note: HTMLElement
    picked: CsvRepairPick | null
  }

  let pendingRepair:
    | {
        rows: RepairRow[]
        resolve: (value: CsvRepairDecision[] | 'cancel') => void
      }
    | null = null
  let repairFocus: HTMLElement | null = null

  function finishRepair(value: CsvRepairDecision[] | 'cancel'): void {
    const pending = pendingRepair
    pendingRepair = null
    repairBox.classList.add('hidden')
    pending?.resolve(value)
    const target = repairFocus
    repairFocus = null
    target?.focus?.()
  }

  function repairRowsComplete(): boolean {
    return Boolean(pendingRepair) && pendingRepair!.rows.every((row) => row.picked !== null)
  }

  function confirmRepair(
    targets: readonly CsvRepairTarget[],
    pick: (sourceId: string) => Promise<CsvRepairPick | null>,
  ): Promise<CsvRepairDecision[] | 'cancel'> {
    // 上一次修复选择尚未返回时先按取消处理，不让两个批次共用同一份选择。
    if (pendingRepair) finishRepair('cancel')
    repairList.replaceChildren()
    const rows: RepairRow[] = []
    for (const target of targets) {
      const row = el('div', 'csv-repair-row')
      const pair = el('div', 'csv-repair-pair')
      const sourceName = el('span', 'csv-repair-source', target.sourceName)
      const arrow = el('span', 'csv-repair-arrow', '→')
      const targetName = el('span', 'csv-repair-target', '尚未选择文件')
      pair.append(sourceName, arrow, targetName)
      const controls = el('div', 'csv-repair-controls')
      const pickButton = el('button', 'button small', '选择文件')
      pickButton.type = 'button'
      const modeSelect = el('select', 'select') as HTMLSelectElement
      const inheritOption = el('option', undefined, '沿用原排除规则') as HTMLOptionElement
      inheritOption.value = 'inherit'
      inheritOption.disabled = target.ruleCount === 0
      const freshOption = el('option', undefined, '作为新来源') as HTMLOptionElement
      freshOption.value = 'new'
      modeSelect.append(inheritOption, freshOption)
      modeSelect.value = 'new'
      modeSelect.disabled = true
      modeSelect.setAttribute('aria-label', `${target.sourceName} 的排除规则处理方式`)
      const note = el(
        'span',
        'csv-repair-note',
        target.ruleCount > 0 ? `${target.ruleCount} 条排除规则` : '无排除规则',
      )
      controls.append(pickButton, modeSelect, note)
      row.append(pair, controls)
      repairList.append(row)
      const entry: RepairRow = {
        target,
        pickButton,
        modeSelect,
        targetName,
        note,
        picked: null,
      }
      rows.push(entry)
      pickButton.addEventListener('click', () => {
        if (!pendingRepair) return
        pickButton.disabled = true
        void (async () => {
          const picked = await pick(target.sourceId)
          // 对话框可能已取消或重新开始，晚到的选择不能写进新批次。
          if (!pendingRepair || !pendingRepair.rows.includes(entry)) return
          pickButton.disabled = false
          if (!picked) return
          entry.picked = picked
          targetName.textContent = picked.handle.name
          modeSelect.disabled = target.ruleCount === 0
          modeSelect.value =
            picked.identity === 'same' && target.ruleCount > 0 ? 'inherit' : 'new'
          note.textContent =
            picked.identity === 'same'
              ? '与旧句柄相同'
              : picked.identity === 'different'
                ? '与旧文件不同'
                : '无法确认文件身份'
          if (picked.identity !== 'same' && target.ruleCount > 0) {
            note.textContent += '；默认不沿用排除规则'
          }
          applyRepairButton.disabled = !repairRowsComplete()
        })()
      })
    }
    repairBox.classList.remove('hidden')
    applyRepairButton.disabled = true
    return new Promise<CsvRepairDecision[] | 'cancel'>((resolve) => {
      pendingRepair = { rows, resolve }
      const active =
        typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null
      repairFocus = active && typeof active.focus === 'function' ? active : null
      repairTitle.focus()
    })
  }

  applyRepairButton.addEventListener('click', () => {
    if (!pendingRepair || !repairRowsComplete()) return
    const decisions: CsvRepairDecision[] = pendingRepair.rows.map((row) => ({
      sourceId: row.target.sourceId,
      mode: row.modeSelect.value === 'inherit' ? 'inherit' : 'new',
    }))
    finishRepair(decisions)
  })
  cancelRepairButton.addEventListener('click', () => finishRepair('cancel'))
  repairBox.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      finishRepair('cancel')
    }
  })

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
  repairButton.addEventListener('click', () => options.onRepair())
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
      if (current.problemSources.includes(record.sourceId)) {
        main.append(el('span', 'csv-source-flag', '需要修复'))
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
    if (snapshot.source !== 'csv' && pendingRelink) finishRelink('cancel')
    const current = session.state
    if (pendingRepair && current.sources.length === 0) finishRepair('cancel')
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
    repairButton.classList.toggle('hidden', current.problemSources.length === 0)
    repairButton.disabled = current.loading
    repairButton.title =
      current.problemSources.length > 0
        ? `${current.problemSources.length} 个文件需要重新选择`
        : ''
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
    } else if (current.loading) {
      panelNote.textContent = current.message
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
        (snapshot.exclusion.excludedCount > 0
          ? ` · 已排除 ${formatCount(snapshot.exclusion.excludedCount)} 局`
          : '') +
        (last > 0 ? ` · 上次读取 ${formatDateTime(last)}` : '')
    } else {
      panelNote.textContent = ''
    }

    renderList(session)
    renderFeedback(session)
  }

  return { sourceBar, empty, panel, feedback, requestFiles, confirmRelink, confirmRepair, render }
}
