import { formatDateTime } from '../../shared/format'
import { brandLogo, el, errorMessage } from '../../shared/ui'
import {
  clearWatchLogs,
  getWatchLogs,
  getWatchSettings,
  getWatchStatus,
  saveWatchSettings,
} from './settings'
import {
  getWatchHandle,
  loadLedger,
  requeueFailed,
  resetLedger,
  setWatchHandle,
} from './store'
import { scanDirectory, type DirectoryLike } from './scan'
import {
  INTERVAL_MAX,
  INTERVAL_MIN,
  type WatchLogEntry,
  type WatchSettings,
  type WatchState,
  type WatchStatus,
} from './types'

const STATE_LABEL: Record<WatchState, string> = {
  idle: '未开始',
  watching: '监视中',
  paused: '已暂停',
  'needs-permission': '需要重新授权',
  stopped: '已停止',
}

async function post(
  message: Record<string, unknown>,
): Promise<{ ok?: boolean; error?: string } | undefined> {
  try {
    return (await chrome.runtime.sendMessage(message)) as
      | { ok?: boolean; error?: string }
      | undefined
  } catch {
    // 后台没起来时消息会失败，状态由下一次 watchdog 纠正
    return undefined
  }
}

function clampInterval(value: number): number {
  if (!Number.isFinite(value)) return 10
  return Math.min(INTERVAL_MAX, Math.max(INTERVAL_MIN, Math.round(value)))
}

export async function mountUploadWatch(root: HTMLElement): Promise<void> {
  document.title = '元神助手 · 自动上传'
  root.replaceChildren()

  let settings: WatchSettings = await getWatchSettings()
  let status: WatchStatus = await getWatchStatus()
  let handle: FileSystemDirectoryHandle | null = await getWatchHandle()
  let logs: WatchLogEntry[] = await getWatchLogs()
  let permission: PermissionState = handle ? await queryPermission(handle) : 'prompt'
  let flash = ''
  let flashTimer: ReturnType<typeof setTimeout> | undefined

  function notice(text: string): void {
    flash = text
    if (flashTimer !== undefined) clearTimeout(flashTimer)
    flashTimer = setTimeout(() => {
      flash = ''
      render()
    }, 4000)
    render()
  }

  const page = el('div', 'page')

  const header = el('header', 'page-header')
  const brand = el('div', 'page-brand')
  brand.append(
    brandLogo(),
    (() => {
      const titles = el('div')
      titles.append(
        el('h1', undefined, '自动上传'),
        el('p', undefined, '监视录像目录，按周期把新录像传到 openms.top'),
      )
      return titles
    })(),
  )
  if (permission !== 'granted') {
    const grant = el('button', 'button primary', '重新授权') as HTMLButtonElement
    grant.type = 'button'
    grant.addEventListener('click', () => void resumeAfterGrant())
    header.append(brand, grant)
  } else {
    header.append(brand)
  }

  // ---------------- 目录 ----------------
  const dirCard = el('section', 'card')
  dirCard.append(
    el('h2', undefined, '监视目录'),
    el('p', 'desc', '只读取目录里的录像文件，不上传任何其他内容。'),
  )

  const dirRow = el('div', 'setting-row')
  dirRow.append(el('span', 'setting-label', '目录'))
  const dirValue = el('span', 'mono', settings.dirName || '未选择')
  const pickButton = el('button', 'button primary', '选择目录') as HTMLButtonElement
  pickButton.type = 'button'
  pickButton.addEventListener('click', () => void pickDirectory())
  dirRow.append(dirValue, pickButton)
  dirCard.append(dirRow)

  const permNote = el('p', 'hint-text')
  dirCard.append(permNote)

  // ---------------- 设置 ----------------
  const settingsCard = el('section', 'card')
  settingsCard.append(el('h2', undefined, '上传设置'))

  const modeRow = el('div', 'setting-row')
  modeRow.append(el('span', 'setting-label', '启动方式'))
  const modeGroup = el('div', 'radio-row')
  const modeInputs: Record<string, HTMLInputElement> = {}
  const modes: Array<[WatchSettings['mode'], string, string]> = [
    ['new-only', '只上传新录像', '启动时已存在的录像不传，只传之后出现的'],
    ['backfill', '补传已有录像', '先把目录里已有的全部传一遍，再继续监视'],
  ]
  for (const [value, label, hint] of modes) {
    const labelNode = el('label', 'radio')
    const input = el('input') as HTMLInputElement
    input.type = 'radio'
    input.name = 'watch-mode'
    input.value = value
    input.checked = settings.mode === value
    input.addEventListener('change', () => {
      if (!input.checked) return
      void updateSettings({ mode: value, baselinePending: true })
    })
    modeInputs[value] = input
    labelNode.title = hint
    labelNode.append(input, el('span', undefined, label))
    modeGroup.append(labelNode)
  }
  modeRow.append(modeGroup)

  const intervalRow = el('div', 'setting-row')
  intervalRow.append(el('span', 'setting-label', '扫描间隔'))
  const intervalInput = el('input', 'text-input') as HTMLInputElement
  intervalInput.type = 'number'
  intervalInput.min = String(INTERVAL_MIN)
  intervalInput.max = String(INTERVAL_MAX)
  intervalInput.step = '1'
  intervalInput.value = String(settings.intervalSec)
  intervalInput.style.width = '5rem'
  intervalInput.addEventListener('change', () => {
    const next = clampInterval(Number(intervalInput.value))
    intervalInput.value = String(next)
    void updateSettings({ intervalSec: next })
  })
  const intervalUnit = el('span', 'muted', '秒（5–300）')
  intervalRow.append(intervalInput, intervalUnit)

  const optionRow = el('div', 'setting-row')
  optionRow.append(el('span', 'setting-label', '选项'))
  const optionGroup = el('div', 'checkbox-row')
  const recursiveInput = el('input') as HTMLInputElement
  recursiveInput.type = 'checkbox'
  recursiveInput.checked = settings.recursive
  recursiveInput.addEventListener('change', () =>
    void updateSettings({ recursive: recursiveInput.checked }),
  )
  const failInput = el('input') as HTMLInputElement
  failInput.type = 'checkbox'
  failInput.checked = settings.skipFail
  failInput.addEventListener('change', () =>
    void updateSettings({ skipFail: failInput.checked }),
  )
  optionGroup.append(
    (() => {
      const label = el('label')
      label.append(recursiveInput, el('span', undefined, '包含子目录'))
      return label
    })(),
    (() => {
      const label = el('label')
      label.append(failInput, el('span', undefined, '跳过未完成局（*_fail）'))
      return label
    })(),
  )
  optionRow.append(optionGroup)

  settingsCard.append(modeRow, intervalRow, optionRow)

  // ---------------- 运行 ----------------
  const runCard = el('section', 'card')
  runCard.append(el('h2', undefined, '运行状态'))
  const stateLine = el('p', 'desc')
  const counterLine = el('p', 'muted')
  const statusNote = el('p', 'hint-text')

  const actions = el('div', 'actions')
  const startButton = el('button', 'button primary', '开始监视') as HTMLButtonElement
  const pauseButton = el('button', 'button', '暂停') as HTMLButtonElement
  const scanButton = el('button', 'button', '立即扫描') as HTMLButtonElement
  const retryButton = el('button', 'button', '重试失败') as HTMLButtonElement
  const clearButton = el('button', 'button danger', '清空台账') as HTMLButtonElement
  for (const button of [startButton, pauseButton, scanButton, retryButton, clearButton]) {
    button.type = 'button'
  }
  startButton.addEventListener('click', () => void startWatching())
  pauseButton.addEventListener('click', () => void pauseWatching())
  scanButton.addEventListener('click', () => void post({ type: 'WATCH_TICK' }))
  retryButton.addEventListener('click', () => void retryFailed())
  clearButton.addEventListener('click', () => void clearLedger())

  actions.append(startButton, pauseButton, scanButton, retryButton, clearButton)
  runCard.append(stateLine, counterLine, statusNote, actions)

  // ---------------- 诊断 ----------------
  const diagCard = el('section', 'card')
  diagCard.append(
    el('h2', undefined, '诊断'),
    el('p', 'desc', '监视没反应时先看这里：后台有没有起来、目录里到底看见什么。'),
  )
  const diagBackend = el('p', 'muted', '后台：检测中…')
  const diagText = el('p', 'hint-text')
  const diagButton = el('button', 'button', '在本页扫描一次') as HTMLButtonElement
  diagButton.type = 'button'
  diagButton.addEventListener('click', () => void previewScan())
  diagCard.append(diagBackend, diagText, diagButton)

  // ---------------- 日志 ----------------
  const logCard = el('section', 'card')
  const logHead = el('div', 'section-head')
  logHead.append(el('h3', undefined, '最近记录'))
  const clearLogsButton = el('button', 'button', '清空') as HTMLButtonElement
  clearLogsButton.type = 'button'
  clearLogsButton.addEventListener('click', async () => {
    await clearWatchLogs()
    logs = []
    render()
  })
  logHead.append(clearLogsButton)
  const logList = el('div', 'logs')
  logCard.append(logHead, logList)

  page.append(header, dirCard, settingsCard, runCard, diagCard, logCard)
  root.append(page)

  render()
  void refreshDiag()

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return
    void (async () => {
      if (changes.uploadWatch) settings = await getWatchSettings()
      if (changes.uploadWatchStatus) {
        status = await getWatchStatus()
        void refreshDiag()
      }
      if (changes.uploadWatchLog) logs = await getWatchLogs()
      render()
    })()
  })

  // ---------------- 行为 ----------------

  async function refreshPermission(): Promise<void> {
    if (!handle) {
      permission = 'prompt'
      return
    }
    permission = await queryPermission(handle)
  }

  async function pickDirectory(): Promise<void> {
    const picker = window.showDirectoryPicker
    if (!picker) {
      notice('当前浏览器不支持选择文件夹，请使用 Chrome 120+。')
      return
    }
    try {
      const picked = await picker.call(window, { id: 'yuanshen-replay', mode: 'read' })
      handle = picked
      await setWatchHandle(picked, picked.name)
      await refreshPermission()
      settings = await saveWatchSettings({
        dirName: picked.name,
        baselinePending: true,
        state: 'paused',
        lastError: '',
      })
      render()
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      notice(`无法读取该文件夹：${errorMessage(error)}`)
    }
  }

  async function grantAccess(): Promise<boolean> {
    if (!handle) {
      notice('请先选择录像目录。')
      return false
    }
    const request = handle.requestPermission
    if (!request) {
      permission = 'granted'
      render()
      return true
    }
    try {
      permission = await request.call(handle, { mode: 'read' })
    } catch (error) {
      notice(`授权失败：${errorMessage(error)}`)
      permission = 'denied'
    }
    render()
    return permission === 'granted'
  }

  async function resumeAfterGrant(): Promise<void> {
    const granted = await grantAccess()
    if (granted && settings.state === 'needs-permission') await startWatching()
  }

  async function startWatching(): Promise<void> {
    if (!handle) {
      notice('请先选择录像目录。')
      return
    }
    if (permission !== 'granted') {
      const granted = await grantAccess()
      if (!granted) return
    }
    settings = await saveWatchSettings({ state: 'watching', dirName: handle.name, lastError: '' })
    const response = (await post({ type: 'WATCH_START' })) as
      | { ok?: boolean; responsive?: boolean; error?: string }
      | undefined
    if (response && response.ok === false) {
      settings = await saveWatchSettings({ state: 'paused' })
      notice(`启动失败：${response.error ?? '后台拒绝创建任务'}`)
      return
    }
    if (response && response.responsive === false) {
      notice('后台文档没有响应，请看诊断和日志')
    }
    render()
  }

  async function pauseWatching(): Promise<void> {
    settings = await saveWatchSettings({ state: 'paused' })
    await post({ type: 'WATCH_STOP' })
    render()
  }

  async function retryFailed(): Promise<void> {
    const count = await requeueFailed()
    notice(count > 0 ? `已把 ${count} 条失败录像放回队列` : '没有失败的录像')
    await post({ type: 'WATCH_RELOAD' })
    await post({ type: 'WATCH_TICK' })
  }

  async function clearLedger(): Promise<void> {
    const ok = window.confirm(
      '清空台账后，目录里已有的录像会被当成新文件重新上传一次。确定要清空吗？',
    )
    if (!ok) return
    await resetLedger()
    settings = await saveWatchSettings({ baselinePending: true, state: 'paused' })
    await post({ type: 'WATCH_STOP' })
    render()
  }

  async function updateSettings(patch: Partial<WatchSettings>): Promise<void> {
    settings = await saveWatchSettings(patch)
    render()
  }

  async function refreshDiag(): Promise<void> {
    try {
      const response = (await chrome.runtime.sendMessage({ type: 'WATCH_DIAG' })) as
        | { ok?: boolean; offscreen?: boolean; alarm?: boolean; responsive?: boolean; error?: string }
        | undefined
      if (!response?.ok) {
        diagBackend.textContent = `后台无响应：${response?.error ?? '未知原因'}`
        return
      }
      const backend = response.offscreen
        ? response.responsive
          ? '运行中（脚本已响应）'
          : '运行中（脚本无响应）'
        : '未运行'
      diagBackend.textContent = `后台：${backend} · 看门狗：${response.alarm ? '已注册' : '未注册'}`
    } catch (error) {
      diagBackend.textContent = `后台无响应：${errorMessage(error)}`
    }
  }

  async function previewScan(): Promise<void> {
    if (!handle) {
      notice('请先选择录像目录。')
      return
    }
    diagButton.disabled = true
    diagText.textContent = '扫描中…'
    try {
      const ledger = await loadLedger()
      const result = await scanDirectory(handle as unknown as DirectoryLike, ledger, {
        recursive: settings.recursive,
        exts: settings.exts,
        skipFail: settings.skipFail,
        stabilityMs: 3000,
        maxEntries: 5000,
        now: Date.now(),
      })
      const head = `目录文件 ${result.total} 个 · 子目录 ${result.subdirs} 个 · 命中 ${result.matched} 个`
      if (result.matched > 0) {
        const names = result.updates.slice(0, 3).map((row) => row.relPath)
        diagText.textContent = `${head}。${names.length ? `待处理示例：${names.join('、')}` : '都已处理过。'}`
      } else if (result.total > 0) {
        diagText.textContent = `${head}。目录里的文件：${result.sample.join('、')}（扩展名需为 ${settings.exts.join(' / ')}）`
      } else if (result.subdirs > 0) {
        diagText.textContent = `${head}。文件都在子目录里，勾选「包含子目录」再试。`
      } else {
        diagText.textContent = `${head}。这个目录看起来是空的。`
      }
    } catch (error) {
      diagText.textContent = `扫描失败：${errorMessage(error)}`
    } finally {
      diagButton.disabled = false
      void refreshDiag()
    }
  }

  function render(): void {
    dirValue.textContent = settings.dirName || '未选择'
    pickButton.disabled = settings.state === 'watching'

    if (!handle) permNote.textContent = '还没有选择目录。选择后浏览器会询问一次读取权限。'
    else if (permission === 'granted') permNote.textContent = '目录读取权限已授予。'
    else if (permission === 'denied')
      permNote.textContent = '目录读取权限被拒绝，请在浏览器设置里恢复，或重新选择目录。'
    else permNote.textContent = '浏览器重启后需要点一次「重新授权」，这是浏览器的限制。'

    for (const [value, input] of Object.entries(modeInputs)) {
      input.checked = settings.mode === value
      input.disabled = settings.state === 'watching'
    }
    intervalInput.disabled = settings.state === 'watching'
    recursiveInput.disabled = settings.state === 'watching'
    failInput.disabled = settings.state === 'watching'

    const scanTime = status.lastScanAt
      ? new Date(status.lastScanAt).toLocaleTimeString('zh-CN', { hour12: false })
      : ''
    stateLine.textContent = `状态：${STATE_LABEL[settings.state]}${settings.dirName ? ` · ${settings.dirName}` : ''}${scanTime ? ` · 上次扫描 ${scanTime}` : ''}`
    const scanInfo = status.lastScanAt
      ? `目录 ${status.totalFiles} 个文件 · 命中 ${status.matchedFiles}`
      : '尚未扫描'
    counterLine.textContent = `${scanInfo} · 待传 ${status.pending} · 已传 ${status.uploaded} · 跳过 ${status.skipped} · 失败 ${status.failed}`
    if (flash) statusNote.textContent = flash
    else if (settings.lastError) statusNote.textContent = settings.lastError
    else if (status.message) statusNote.textContent = status.message
    else if (status.lastScanAt && status.matchedFiles === 0 && status.totalFiles > 0)
      statusNote.textContent = `目录里有 ${status.totalFiles} 个文件，但没有扩展名匹配（当前 ${settings.exts.join(' / ')}）。`
    else if (status.lastScanAt && status.matchedFiles === 0 && status.subdirs > 0)
      statusNote.textContent = `文件都在子目录里，勾选「包含子目录」。`
    else statusNote.textContent = status.lastScanAt
      ? `上次扫描：${formatDateTime(status.lastScanAt)}`
      : '还没有扫描过。'

    startButton.disabled = settings.state === 'watching' || !handle
    pauseButton.disabled = settings.state !== 'watching'
    scanButton.disabled = settings.state !== 'watching'
    retryButton.disabled = status.failed === 0
    clearButton.disabled = settings.state === 'watching'

    renderLogs()
  }

  function renderLogs(): void {
    logList.replaceChildren()
    if (logs.length === 0) {
      logList.append(el('p', 'empty-logs', '暂无记录'))
      return
    }
    for (const entry of logs.slice(0, 40)) {
      const row = el('div', 'log-entry')
      row.append(el('span', 'log-time', new Date(entry.at).toLocaleTimeString('zh-CN', { hour12: false })))
      const level =
        entry.kind === 'err' ? 'log-level error' : entry.kind === 'warn' ? 'log-level warn' : 'log-level info'
      row.append(el('span', level, entry.kind === 'err' ? '失败' : entry.kind === 'warn' ? '重试' : '记录'))
      row.append(el('span', 'log-message', entry.text))
      logList.append(row)
    }
  }
}

async function queryPermission(handle: FileSystemDirectoryHandle): Promise<PermissionState> {
  const query = handle.queryPermission
  if (!query) return 'granted'
  try {
    return await query.call(handle, { mode: 'read' })
  } catch {
    return 'prompt'
  }
}
