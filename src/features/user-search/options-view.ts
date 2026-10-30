import { DEVELOPER_LINKS, REPO_URL, SITE_ORIGIN } from '../../shared/constants'
import { formatCount, formatDateTime } from '../../shared/format'
import { addLog, clearLogs, getLogs, type LogEntry } from '../../shared/log'
import { notifyDataChanged, onDataChanged } from '../../shared/bus'
import {
  DEFAULT_SETTINGS,
  getSettings,
  saveSettings,
  type Settings,
} from '../../shared/settings'
import { brandLogo, el, errorMessage, externalLink } from '../../shared/ui'
import {
  DEFAULT_SYNC_META,
  clearAllData,
  countUsers,
  getSyncMeta,
  type SyncMeta,
} from './db'
import {
  runSync,
  SyncAbortError,
  SyncBusyError,
  type SyncProgress,
} from './sync'

export async function mountUserSearchOptions(root: HTMLElement): Promise<void> {
  document.title = '元神助手 · 控制台'
  root.replaceChildren()

  let meta: SyncMeta = { ...DEFAULT_SYNC_META }
  let userCount = 0
  let settings: Settings = { ...DEFAULT_SETTINGS }
  let logs: LogEntry[] = []
  let syncing = false
  let controller: AbortController | null = null
  let progress: SyncProgress | null = null
  let notice: { text: string; error: boolean } | null = null
  let noticeTimer: ReturnType<typeof setTimeout> | undefined

  const page = el('div', 'page')

  const header = el('header', 'page-header')
  const brand = el('div', 'page-brand')
  const logo = brandLogo()
  const titles = el('div')
  titles.append(el('h1', undefined, '元神助手'), el('p', undefined, '开源扫雷网辅助工具 · 控制台'))
  brand.append(logo, titles)
  const siteLink = el('a', 'site-link', 'openms.top ↗') as HTMLAnchorElement
  siteLink.href = 'https://openms.top'
  siteLink.target = '_blank'
  siteLink.rel = 'noreferrer'
  const uploadLink = el('a', 'site-link', '自动上传 ↗') as HTMLAnchorElement
  uploadLink.href = chrome.runtime.getURL('upload.html')
  uploadLink.target = '_blank'
  uploadLink.rel = 'noreferrer'
  const links = el('div', 'header-links')
  links.append(uploadLink, siteLink)
  header.append(brand, links)

  const featureCard = el('section', 'card')
  featureCard.append(
    el('h2', undefined, '用户搜索'),
    el(
      'p',
      'desc',
      '同步站内用户到本机，支持用户名、实名、拼音、ID 和标识反查。数据只保存在本机。',
    ),
  )

  const stats = el('div', 'stats')
  const localStat = el('div', 'stat')
  const localLabel = el('span', 'stat-label', '本地用户')
  const localValue = el('strong', undefined, '0')
  localStat.append(localLabel, localValue)

  const syncStat = el('div', 'stat')
  const syncLabel = el('span', 'stat-label', '上次同步')
  const syncValue = el('strong', undefined, '从未')
  syncStat.append(syncLabel, syncValue)

  const watermarkStat = el('div', 'stat')
  const watermarkLabel = el('span', 'stat-label', '当前水位')
  const watermarkValue = el('strong', undefined, '0')
  watermarkStat.append(watermarkLabel, watermarkValue)

  const phaseStat = el('div', 'stat')
  const phaseLabelEl = el('span', 'stat-label', '状态')
  const phaseValue = el('strong', undefined, '空闲')
  phaseStat.append(phaseLabelEl, phaseValue)

  stats.append(localStat, syncStat, watermarkStat, phaseStat)

  const actions = el('div', 'actions')
  const fullButton = el('button', 'button primary', '首次全量同步')
  fullButton.type = 'button'
  const incrementalButton = el('button', 'button', '增量同步')
  incrementalButton.type = 'button'
  const cancelButton = el('button', 'button danger', '取消')
  cancelButton.type = 'button'
  const clearButton = el('button', 'button danger', '清空本地数据')
  clearButton.type = 'button'
  actions.append(fullButton, incrementalButton, cancelButton, clearButton)

  const noticeEl = el('div', 'notice')
  noticeEl.setAttribute('role', 'status')

  const progressWrap = el('div', 'progress-wrap')
  progressWrap.hidden = true
  const progressBar = el('progress', 'progress') as HTMLProgressElement
  progressBar.max = 100
  progressBar.value = 0
  const progressText = el('div', 'progress-text')
  progressWrap.append(progressBar, progressText)

  featureCard.append(stats, actions, noticeEl, progressWrap)

  const settingsCard = el('section', 'card')
  settingsCard.append(
    el('h2', undefined, '设置'),
    el('p', 'desc', '修改 API 地址后，点同步会从新地址拉取；本地旧数据会保留。'),
  )

  const apiRow = el('div', 'setting-row')
  const apiLabel = el('label', 'setting-label', 'API 根地址')
  apiLabel.htmlFor = 'api-base'
  const apiInput = el('input', 'text-input') as HTMLInputElement
  apiInput.id = 'api-base'
  apiInput.type = 'url'
  apiInput.placeholder = 'https://openms.top'
  apiInput.spellcheck = false
  const saveApiButton = el('button', 'button', '保存')
  saveApiButton.type = 'button'
  apiRow.append(apiLabel, apiInput, saveApiButton)

  const autoRow = el('div', 'setting-row')
  const autoLabel = el('span', 'setting-label', '打开 popup 时')
  const autoCheckboxLabel = el('label', 'checkbox-row')
  const autoCheckbox = el('input') as HTMLInputElement
  autoCheckbox.type = 'checkbox'
  autoCheckboxLabel.append(autoCheckbox, el('span', undefined, '自动做一次增量同步'))
  autoRow.append(autoLabel, autoCheckboxLabel)

  settingsCard.append(
    apiRow,
    autoRow,
    el(
      'p',
      'hint-text',
      '自动增量默认关闭。开启后，popup 打开时如果距上次同步超过 1 分钟，会静默发 1 个请求检查更新。',
    ),
  )

  const selfCard = el('section', 'card')
  selfCard.append(
    el('h2', undefined, '玩家数据'),
    el(
      'p',
      'desc',
      '「我的成绩」优先用站点登录态；没登录过 openms.top 时可以在这里填一次自己的 ID，之后随时能打开。',
    ),
  )

  const selfRow = el('div', 'setting-row')
  const selfLabel = el('label', 'setting-label', '我的站内 ID')
  selfLabel.htmlFor = 'self-user-id'
  const selfInput = el('input', 'text-input') as HTMLInputElement
  selfInput.id = 'self-user-id'
  selfInput.type = 'text'
  selfInput.inputMode = 'numeric'
  selfInput.autocomplete = 'off'
  selfInput.placeholder = '例如 16，留空表示不填'
  const saveSelfButton = el('button', 'button', '保存')
  saveSelfButton.type = 'button'
  selfRow.append(selfLabel, selfInput, saveSelfButton)
  selfCard.append(selfRow)

  const logsCard = el('section', 'card')
  const logsHead = el('div', 'section-head')
  logsHead.append(el('h3', undefined, '最近日志'))
  const clearLogsButton = el('button', 'button', '清空日志')
  clearLogsButton.type = 'button'
  logsHead.append(clearLogsButton)

  const logsList = el('ul', 'logs')
  const emptyLogs = el('div', 'empty-logs', '还没有日志')
  logsCard.append(logsHead, logsList, emptyLogs)

  const privacyCard = el('section', 'card')
  const privacyTitle = el('h2', undefined, '隐私')
  const privacy = el('p', 'privacy')
  privacy.append(
    el('strong', undefined, '数据只存本机。'),
    document.createTextNode(
      ' 本扩展会把用户资料保存在你本机的浏览器 IndexedDB 中，不会上传到任何服务器；不存国家、签名、头像。请勿将数据导出或公开分享。',
    ),
  )
  privacyCard.append(privacyTitle, privacy)

  const aboutCard = el('section', 'card')
  aboutCard.append(
    el('h2', undefined, '关于'),
    el('p', 'desc', `元神助手 v${chrome.runtime.getManifest().version} · 开源扫雷网辅助工具`),
  )

  const repoRow = el('div', 'setting-row')
  repoRow.append(
    el('span', 'setting-label', '仓库'),
    externalLink('github.com/LockhartANR/yuanshen-helper ↗', REPO_URL),
  )

  const devRow = el('div', 'setting-row')
  const devLinks = el('div', 'about-links')
  for (const item of DEVELOPER_LINKS) {
    devLinks.append(externalLink(`${item.label} ↗`, item.url))
  }
  devRow.append(el('span', 'setting-label', '开发者'), devLinks)

  const siteRow = el('div', 'setting-row')
  siteRow.append(el('span', 'setting-label', '站点'), externalLink('openms.top ↗', SITE_ORIGIN))

  aboutCard.append(repoRow, devRow, siteRow)

  const footer = el('footer', 'page-footer')
  footer.textContent = '问题和建议请提到仓库的 Issues。'

  page.append(header, featureCard, settingsCard, selfCard, logsCard, privacyCard, aboutCard, footer)
  root.append(page)

  function setNotice(text: string, isError = false, timeoutMs = 5_000): void {
    notice = { text, error: isError }
    if (noticeTimer !== undefined) clearTimeout(noticeTimer)
    noticeTimer = setTimeout(() => {
      notice = null
      renderNotice()
    }, timeoutMs)
    renderNotice()
  }

  function renderNotice(): void {
    noticeEl.textContent = notice?.text ?? ''
    noticeEl.classList.toggle('error', Boolean(notice?.error))
  }

  function renderLogs(): void {
    logsList.replaceChildren()
    logsList.hidden = logs.length === 0
    emptyLogs.hidden = logs.length > 0

    for (const log of logs) {
      const item = el('li', 'log-entry')
      item.append(
        el('span', 'log-time', formatDateTime(log.at)),
        el(
          'span',
          `log-level ${log.level}`,
          log.level === 'info' ? '信息' : log.level === 'warn' ? '警告' : '错误',
        ),
        el('span', 'log-message', log.message),
      )
      logsList.append(item)
    }
  }

  function displayPhase(): string {
    if (syncing) {
      if (progress?.phase === 'listing') return '正在获取用户列表'
      if (progress?.phase === 'fetching') return '正在拉取用户资料'
      return '同步中'
    }
    if (meta.phase !== 'idle') return '上次未完成'
    return '空闲'
  }

  function renderProgress(): void {
    if (!syncing) {
      progressWrap.hidden = true
      return
    }

    progressWrap.hidden = false
    if (progress?.phase === 'fetching') {
      progressBar.removeAttribute('value')
      const total = Math.max(1, progress.total)
      progressBar.value = Math.min(progress.processed, total)
      progressBar.max = total
      progressText.textContent = `已处理 ${formatCount(progress.processed)} / ${formatCount(
        progress.total,
      )}（第 ${progress.batch}/${progress.totalBatches} 批）`
    } else {
      progressBar.removeAttribute('value')
      progressBar.removeAttribute('max')
      progressText.textContent = '正在获取用户列表…'
    }
    phaseValue.textContent = displayPhase()
  }

  function render(): void {
    localValue.textContent = formatCount(userCount)
    syncValue.textContent = meta.lastSyncAt ? formatDateTime(meta.lastSyncAt) : '从未'
    watermarkValue.textContent = meta.watermark ? formatDateTime(meta.watermark) : '0'
    phaseValue.textContent = displayPhase()

    fullButton.disabled = syncing
    incrementalButton.disabled = syncing
    cancelButton.disabled = !syncing
    clearButton.disabled = syncing
    clearLogsButton.disabled = logs.length === 0

    renderProgress()

    if (document.activeElement !== apiInput) {
      apiInput.value = settings.apiBase
    }
    autoCheckbox.checked = settings.autoIncrementalOnPopup
    if (document.activeElement !== selfInput) {
      selfInput.value = settings.selfUserId === null ? '' : String(settings.selfUserId)
    }

    renderLogs()
    renderNotice()
  }

  async function refresh(): Promise<void> {
    const [nextMeta, nextCount, nextSettings, nextLogs] = await Promise.all([
      getSyncMeta(),
      countUsers(),
      getSettings(),
      getLogs(),
    ])
    meta = nextMeta
    userCount = nextCount
    settings = nextSettings
    logs = nextLogs
    render()
  }

  async function startSync(mode: 'full' | 'incremental', resume = false): Promise<void> {
    if (syncing) return

    syncing = true
    controller = new AbortController()
    progress = null
    notice = null
    render()

    try {
      const result = await runSync(mode, {
        signal: controller.signal,
        resume,
        onProgress: (next) => {
          progress = next
          renderProgress()
        },
      })
      await refresh()
      setNotice(
        `同步完成：更新 ${result.updated} 人，${result.requests} 个请求，用时 ${(
          result.durationMs / 1000
        ).toFixed(1)} 秒`,
      )
      notifyDataChanged()
    } catch (error) {
      if (error instanceof SyncBusyError) {
        setNotice('正在同步中，请稍后再试', true)
      } else if (error instanceof SyncAbortError) {
        setNotice('已取消，可重新开始续跑')
      } else {
        setNotice(`同步失败：${errorMessage(error)}`, true)
      }
      await refresh()
    } finally {
      syncing = false
      controller = null
      progress = null
      render()
    }
  }

  fullButton.addEventListener('click', () => {
    const canResume = meta.phase !== 'idle' && meta.cursor > 0
    const resume = canResume
      ? window.confirm(
          '检测到上次未完成的同步，是否从上次进度继续？\n\n选择“取消”将从头开始。',
        )
      : false
    void startSync('full', resume)
  })

  incrementalButton.addEventListener('click', () => {
    void startSync('incremental')
  })

  cancelButton.addEventListener('click', () => {
    controller?.abort()
    cancelButton.disabled = true
    setNotice('正在取消…')
  })

  clearButton.addEventListener('click', () => {
    const confirmed = window.confirm(
      '确定清空本地用户数据？\n\n这不会影响站点账号，但需要重新同步才能搜索。',
    )
    if (!confirmed) return

    void (async () => {
      try {
        await clearAllData()
        await addLog('info', '已清空本地用户数据')
        notifyDataChanged()
        await refresh()
        setNotice('本地数据已清空')
      } catch (error) {
        setNotice(`清空失败：${errorMessage(error)}`, true)
      }
    })()
  })

  saveSelfButton.addEventListener('click', () => {
    void (async () => {
      const raw = selfInput.value.trim()
      if (raw === '') {
        settings = await saveSettings({ selfUserId: null })
        setNotice('已清除我的站内 ID')
        await refresh()
        return
      }
      const value = Number(raw)
      if (!Number.isSafeInteger(value) || value <= 0) {
        setNotice('站内 ID 必须是正整数', true)
        return
      }
      settings = await saveSettings({ selfUserId: value })
      setNotice(`我的站内 ID 已保存为 ${value}`)
      await refresh()
    })().catch((error: unknown) => setNotice(errorMessage(error), true))
  })

  saveApiButton.addEventListener('click', () => {    void (async () => {
      try {
        settings = await saveSettings({ apiBase: apiInput.value })
        apiInput.value = settings.apiBase
        setNotice('API 地址已保存')
        await addLog('info', `API 地址已改为 ${settings.apiBase}`)
        await refresh()
      } catch (error) {
        setNotice(errorMessage(error), true)
      }
    })()
  })

  autoCheckbox.addEventListener('change', () => {
    void (async () => {
      try {
        settings = await saveSettings({
          autoIncrementalOnPopup: autoCheckbox.checked,
        })
        setNotice(autoCheckbox.checked ? '已开启自动增量' : '已关闭自动增量')
        await addLog(
          'info',
          autoCheckbox.checked ? '已开启打开 popup 自动增量' : '已关闭打开 popup 自动增量',
        )
        await refresh()
      } catch (error) {
        setNotice(errorMessage(error), true)
      }
    })()
  })

  clearLogsButton.addEventListener('click', () => {
    void (async () => {
      await clearLogs()
      logs = []
      render()
      setNotice('日志已清空')
    })()
  })

  onDataChanged(() => {
    if (!syncing) void refresh()
  })

  window.addEventListener('beforeunload', () => {
    controller?.abort()
  })

  settings = await getSettings()
  render()
  await refresh()
}
