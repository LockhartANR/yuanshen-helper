import { SITE_ORIGIN } from '../../shared/constants'
import { formatCount, formatDateTime } from '../../shared/format'
import { askSelfId, resolveSelfId } from '../../shared/self-id'
import { el, externalLink } from '../../shared/ui'
import { configureColors } from './colors'
import { loadAnalysisSettings } from './analysis-settings'
import { createAnalysisView } from './analysis-view'
import { parsePlayerLaunch } from './launch'
import { createPlayerController } from './player-controller'
import { launchMode } from './player-state'
import type { PlayerSnapshot } from './player-state'
import { createCsvPanel } from './ui/csv-panel'
import { createExclusionPanel } from './ui/exclusion-panel'
import { createScoreView } from './ui/score-view'
import type { ExclusionCandidateScope } from './statistics-exclusion-candidates'

export interface PlayerStatsMountOptions {
  /** 页面是否运行在外部 iframe 中；外部 iframe 只允许 embed 模式启动。 */
  framed?: boolean
}

export interface PlayerStatsHandle {
  /** 销毁页面：使进行中的请求失效并清理大表内部状态。 */
  destroy(): void
}

/** 挂载玩家数据页：入口、布局、订阅与销毁；数据编排在 player-controller。 */
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
  const { standaloneCsv, embedded, siteUserId } = launchMode(launch)
  configureColors(loadAnalysisSettings().colorThresholds)

  let openRecordings: (scope: ExclusionCandidateScope) => void = () => {}
  const analysis = createAnalysisView({
    autoSiteAnchors: !standaloneCsv,
    onViewRecordings: (scope) => openRecordings(scope),
  })
  const analysisPane = el('div', 'player-pane hidden')
  analysisPane.append(analysis.root)

  let controller: ReturnType<typeof createPlayerController>
  const scoreView = createScoreView({
    onFiltersChange: (patch) => controller.setFilters(patch),
  })
  const csvPanel = createCsvPanel({
    onSelectSource: (source) => controller.setSource(source),
    onEnterCsv: () => void controller.enterCsvSource(),
    onAddFiles: () => void controller.addCsvFiles(),
    onRelink: (sourceId) => void controller.relinkCsvSource(sourceId),
    onRemoveSource: (sourceId) => void controller.removeCsvSource(sourceId),
    onRemoveAll: () => void controller.removeAllCsv(),
    onRefresh: () => void controller.refreshCsv(),
    onCancel: () => controller.cancelCsv(),
    onGrant: (sourceId) => void controller.grantCsv(sourceId),
  })
  controller = createPlayerController({
    launch,
    requestFiles: csvPanel.requestFiles,
    confirmRelink: (choice) => csvPanel.confirmRelink(choice),
  })
  const exclusionPanel = createExclusionPanel({
    onExclude: (keys, snapshotKey) => controller.excludeEntries(keys, snapshotKey),
    onRestore: (keys, snapshotKey) => controller.restoreEntries(keys, snapshotKey),
    onClearRules: (ruleIds, snapshotKey) =>
      controller.clearExclusionRules(ruleIds, snapshotKey),
    onLinkHistory: (sourceId, scopeId, snapshotKey) =>
      controller.linkCsvHistory(sourceId, scopeId, snapshotKey),
    onRetry: () => controller.retryExclusions(),
    getDefaultFloors: () =>
      typeof analysis.getBvFloors === 'function'
        ? analysis.getBvFloors()
        : { b: 10, i: 30, e: 100 },
    getAppliedScope: () =>
      typeof analysis.getAppliedScope === 'function'
        ? analysis.getAppliedScope()
        : null,
  })
  openRecordings = (scope) => exclusionPanel.open(scope)

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
  const cancelButton = el('button', 'button hidden', '取消')
  cancelButton.type = 'button'
  const header = el('header', 'player-header')
  const headerText = el('div', 'player-header-text')
  const titleRow = el('div', 'player-title')
  titleRow.append(nameNode, idNode)
  headerText.append(titleRow, metaNode)

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
  headerActions.append(exclusionPanel.trigger, refreshButton, cancelButton)
  header.append(headerText, headerActions)

  const status = el('p', 'player-status')
  status.setAttribute('role', 'status')
  const scoreTab = el('button', 'page-tab active', '成绩概况')
  scoreTab.type = 'button'
  const analysisTab = el('button', 'page-tab', '赛博大表')
  analysisTab.type = 'button'
  const pageTabs = el('div', 'page-tabs')
  pageTabs.append(scoreTab, analysisTab)

  const scorePane = el('div', 'player-pane')
  scorePane.append(
    scoreView.filters,
    scoreView.notice,
    scoreView.pbCard,
    scoreView.topCard,
  )

  const wrap = el('main', 'player-page')
  if (embedded) wrap.classList.add('player-page-embedded')
  wrap.append(
    header,
    csvPanel.sourceBar,
    csvPanel.empty,
    csvPanel.panel,
    csvPanel.feedback,
    status,
    pageTabs,
    exclusionPanel.root,
    scorePane,
    analysisPane,
  )
  root.replaceChildren(wrap)

  let lastDatasetKey = ''

  function render(snapshot: PlayerSnapshot = controller.getSnapshot()): void {
    const dataset = snapshot.dataset
    const key = `${dataset.source}|${dataset.identity}|${dataset.contentVersion}`
    // 规则读取失败时不向大表发布空规则统计；重试成功后再建立数据快照。
    if (key !== lastDatasetKey && snapshot.exclusion.ready) {
      lastDatasetKey = key
      analysis.update(dataset.videos, {
        csv: dataset.source === 'csv',
        identity: dataset.identity,
      })
    }
    const session = controller.getCsvSession()
    const csv = snapshot.source === 'csv'
    const ready = session.state.ready
    const sources = session.state.sources.length
    const empty = standaloneCsv && ready && sources === 0
    const waiting = csv && ready && sources > 0 && !session.hasSnapshot()
    const hasSnapshot = csv ? session.hasSnapshot() : snapshot.updatedAt > 0

    // 头部身份与数据概况
    nameNode.textContent = csv ? '本地 CSV' : snapshot.siteName
    idNode.textContent = csv ? `${sources} 个文件` : `ID ${siteUserId ?? ''}`
    document.title = standaloneCsv
      ? '本地 CSV · 元神助手'
      : `${nameNode.textContent} · 玩家数据 · 元神助手`
    if (standaloneCsv && csv && sources === 0) {
      metaNode.textContent = '选择 CSV 文件开始本地分析'
    } else if (csv) {
      const records = session.state.sources
      const parts = session.hasSnapshot()
        ? [
            `CSV ${records.length} 个文件`,
            `统计 ${formatCount(snapshot.videos.length)} 局`,
            ...(snapshot.exclusion.excludedCount > 0
              ? [`已排除 ${formatCount(snapshot.exclusion.excludedCount)} 局`]
              : []),
            `上次读取 ${formatDateTime(Math.max(0, ...records.map((record) => session.sourceSummary(record.sourceId)?.readAt ?? 0)))}`,
          ]
        : [`已关联 ${records.length} 个文件`, '尚未加载成绩']
      metaNode.textContent = parts.join(' · ')
    } else {
      const parts = [`录像 ${formatCount(snapshot.rows.length)}`]
      if (snapshot.exclusion.excludedCount > 0) {
        parts.push(
          `统计 ${formatCount(snapshot.videos.length)} 局`,
          `已排除 ${formatCount(snapshot.exclusion.excludedCount)} 局`,
        )
      }
      if (snapshot.updatedAt > 0) parts.push(`更新于 ${formatDateTime(snapshot.updatedAt)}`)
      if (snapshot.fromCache) parts.push('（缓存）')
      metaNode.textContent = parts.join(' · ')
    }

    refreshButton.disabled = snapshot.loading || csv
    refreshButton.classList.toggle('hidden', standaloneCsv || csv)
    cancelButton.classList.toggle('hidden', !snapshot.loading || csv)
    const exclusionError = snapshot.exclusion.error
    status.textContent = exclusionError || snapshot.message
    status.classList.toggle(
      'hidden',
      (csv && !exclusionError) ||
        (!exclusionError && !snapshot.loading && !snapshot.message),
    )
    homeLink?.classList.toggle('hidden', embedded)
    selfButton?.classList.toggle('hidden', embedded)

    scoreTab.classList.toggle('active', snapshot.page === 'score')
    analysisTab.classList.toggle('active', snapshot.page === 'analysis')
    scoreTab.setAttribute('aria-pressed', String(snapshot.page === 'score'))
    analysisTab.setAttribute('aria-pressed', String(snapshot.page === 'analysis'))
    const exclusionReady = snapshot.exclusion.ready
    pageTabs.classList.toggle('hidden', embedded || empty || waiting || !exclusionReady)
    scorePane.classList.toggle(
      'hidden',
      !hasSnapshot || !exclusionReady || snapshot.page !== 'score',
    )
    analysisPane.classList.toggle(
      'hidden',
      !hasSnapshot || !exclusionReady || snapshot.page !== 'analysis',
    )

    scoreView.render(snapshot)
    csvPanel.render(snapshot, session)
    exclusionPanel.render(snapshot)
  }

  scoreTab.addEventListener('click', () => controller.setPage('score'))
  analysisTab.addEventListener('click', () => controller.setPage('analysis'))
  refreshButton.addEventListener('click', () => void controller.refresh())
  cancelButton.addEventListener('click', () => {
    controller.cancel()
    cancelButton.textContent = '取消中…'
    cancelButton.disabled = true
    setTimeout(() => {
      cancelButton.disabled = false
      cancelButton.textContent = '取消'
    }, 1_000)
  })

  /** 读站点登录态（或手动填的 ID），跳到自己的成绩页。 */
  async function openMyStats(): Promise<void> {
    if (siteUserId === null || !selfButton) return
    selfButton.disabled = true
    try {
      let id = await resolveSelfId()
      if (id === null) id = await askSelfId(siteUserId)
      if (id === null) {
        controller.setMessage('已取消')
        return
      }
      if (id === siteUserId) {
        controller.setMessage('当前就是你的成绩页')
        return
      }
      location.href = `${location.pathname}?id=${id}`
      return
    } catch {
      controller.setMessage('读取登录状态失败，请稍后重试')
    } finally {
      selfButton.disabled = false
      render()
    }
  }

  const unsubscribe = controller.subscribe(render)

  // 控制器按启动模式恢复 CSV 清单或加载网站数据。
  const checkRegistryOnFocus = (): void => {
    void controller.checkCsvRegistry()
    void controller.refreshExclusions()
  }
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('focus', checkRegistryOnFocus)
  }

  await controller.start()
  render()

  // 嵌入页只向父页面报告“已就绪”，不带成绩、CSV、缓存或设置。
  if (embedded && siteUserId !== null && typeof window !== 'undefined') {
    window.parent.postMessage(
      { type: 'YUANSHEN_ANALYSIS_READY', v: 1, userId: siteUserId },
      '*',
    )
  }

  return {
    destroy(): void {
      // 先撤销订阅，避免销毁过程中产生新的渲染。
      unsubscribe()
      controller.destroy()
      exclusionPanel.destroy()
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('focus', checkRegistryOnFocus)
      }
      analysis.destroy()
    },
  }
}
