import { DEFAULT_API_BASE } from '../../shared/constants'
import type { PlayerVideoRow } from '../../shared/db'
import { onDbBlocked } from '../../shared/db'
import { getSettings } from '../../shared/settings'
import { errorMessage, isAbortError } from '../../shared/ui'
import { fetchUserInfo } from './api'
import { joinVideos } from './compute'
import {
  canRememberCsvFiles,
  createCsvStore,
  isSameCsvHandle,
  pickCsvFiles,
} from './csv-sources'
import type {
  CsvFileHandle,
  CsvLoadedSource,
  CsvScopeGuard,
} from './csv-sources'
import { createCsvSession } from './csv-session'
import type { CsvRelinkBasis, CsvSession } from './csv-session'
import type { PlayerLaunch, PlayerPage } from './launch'
import type { DatasetSnapshot, Video } from './model'
import { launchMode } from './player-state'
import type {
  ExclusionActionResult,
  PlayerFilters,
  PlayerSnapshot,
  PlayerSource,
} from './player-state'
import { ensureDetails, loadPlayer } from './service'
import {
  advanceCsvRuleAnchors,
  buildCsvExclusionEntries,
  buildSiteExclusionEntries,
  createCsvRuleFromEntries,
  createSiteExclusionRule,
  csvScopeIdForSource,
  evaluateCsvExclusions,
  evaluateSiteExclusions,
  normalizeSiteNamespace,
  siteScopeId,
} from './statistics-exclusion'
import type {
  ExclusionEntry,
  ExclusionRule,
  ExclusionScopeOwner,
  ExclusionScopeRecord,
  UnmatchedExclusion,
} from './statistics-exclusion'
import {
  createExclusionStore,
} from './statistics-exclusion-store'
import type {
  ExclusionMutation,
  StatisticsExclusionStore,
} from './statistics-exclusion-store'

const CSV_DB_BLOCKED_MESSAGE =
  '本地数据库需要升级但被其他页面占用：请关闭或刷新其他元神助手页面后重试。'

const EXCLUSION_CHANNEL = 'yuanshen-helper:stat-exclusions'

type CsvSelectionContext =
  | { kind: 'add'; flow: number }
  | { kind: 'relink'; flow: number; sourceId: string }

export type CsvRelinkMode = 'inherit' | 'new' | 'cancel'

export interface CsvRelinkChoice {
  sourceId: string
  sourceName: string
  newName: string
  /** 原来源当前保存的排除规则数量。 */
  ruleCount: number
}

interface CsvRelinkCapture {
  scopeId: string | null
  basis: CsvRelinkBasis
  scopeRevision: number | null
  /** 是否经过“沿用 / 作为新来源”的明确确认；同一文件自动沿用不需要作用域守卫。 */
  confirmed: boolean
}

export interface PlayerControllerOptions {
  launch: PlayerLaunch
  /** 浏览器不支持文件句柄 API 时，由视图点击隐藏 input 并返回本次选择的文件。 */
  requestFiles?: (multiple: boolean) => Promise<File[]>
  loadPlayer?: typeof loadPlayer
  ensureDetails?: typeof ensureDetails
  fetchUserInfo?: typeof fetchUserInfo
  pickCsvFiles?: typeof pickCsvFiles
  createCsvStore?: typeof createCsvStore
  createCsvSession?: typeof createCsvSession
  canRememberCsvFiles?: typeof canRememberCsvFiles
  /** 测试注入内存实现；默认使用扩展本地 IndexedDB。 */
  createExclusionStore?: () => StatisticsExclusionStore
  /** 当前数据站点命名空间；默认读设置里的 apiBase，读取失败回退官方站点。 */
  loadSiteNamespace?: () => Promise<string>
  enableCrossPage?: boolean
  now?: () => number
  /** 重新关联到不同文件时，由视图让用户选择沿用原规则或作为新来源。 */
  confirmRelink?: (choice: CsvRelinkChoice) => Promise<CsvRelinkMode>
}

export interface PlayerController {
  getSnapshot(): PlayerSnapshot
  getCsvSession(): CsvSession
  subscribe(listener: (snapshot: PlayerSnapshot) => void): () => void
  start(): Promise<void>
  setSource(source: PlayerSource): void
  setPage(page: PlayerPage): void
  setFilters(patch: Partial<PlayerFilters>): void
  refresh(): Promise<void>
  cancel(): void
  enterCsvSource(): Promise<void>
  addCsvFiles(): Promise<void>
  relinkCsvSource(sourceId: string): Promise<void>
  removeCsvSource(sourceId: string): Promise<void>
  removeAllCsv(): Promise<void>
  refreshCsv(): Promise<void>
  cancelCsv(): void
  grantCsv(sourceId: string): Promise<void>
  checkCsvRegistry(): Promise<void>
  /** 排除选中的原始记录；一次批量提交。`snapshotKey` 用于拒绝过期勾选。 */
  excludeEntries(
    keys: readonly string[],
    snapshotKey?: string,
  ): Promise<ExclusionActionResult>
  /** 恢复选中记录对应的规则。 */
  restoreEntries(
    keys: readonly string[],
    snapshotKey?: string,
  ): Promise<ExclusionActionResult>
  /** 清除当前未匹配规则；不重建未变化的统计。 */
  clearExclusionRules(
    ruleIds: readonly string[],
    snapshotKey?: string,
  ): Promise<ExclusionActionResult>
  /** 降级模式下由用户显式把当前文件绑定到某个历史 CSV 来源。 */
  linkCsvHistory(
    sourceId: string,
    scopeId: string,
    snapshotKey?: string,
  ): Promise<ExclusionActionResult>
  /** 首次读取规则失败后的重试入口。 */
  retryExclusions(): Promise<void>
  /** 重获焦点或收到其他页面通知时核对规则修订号。 */
  refreshExclusions(): Promise<void>
  /** 页面级提示（例如「我的成绩」跳转失败），与 CSV 解析消息分开。 */
  setMessage(message: string): void
  destroy(): void
}

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

async function defaultSiteNamespace(): Promise<string> {
  try {
    const settings = await getSettings()
    return normalizeSiteNamespace(settings.apiBase)
  } catch {
    return normalizeSiteNamespace(DEFAULT_API_BASE)
  }
}

/**
 * 玩家页面数据源控制器：网站请求、取消、未过审补抓、来源切换、
 * 当前快照选择、CSV session 与统计排除编排都集中在这里；不接触 DOM。
 */
export function createPlayerController(options: PlayerControllerOptions): PlayerController {
  const { launch } = options
  const { standaloneCsv, embedded, siteUserId } = launchMode(launch)
  const load = options.loadPlayer ?? loadPlayer
  const ensure = options.ensureDetails ?? ensureDetails
  const fetchInfo = options.fetchUserInfo ?? fetchUserInfo
  const pickFiles = options.pickCsvFiles ?? pickCsvFiles
  const createStore = options.createCsvStore ?? createCsvStore
  const createSession = options.createCsvSession ?? createCsvSession
  const canRemember = options.canRememberCsvFiles ?? canRememberCsvFiles
  const exclusionStoreFactory = options.createExclusionStore ?? (() => createExclusionStore())
  const namespaceLoader = options.loadSiteNamespace ?? defaultSiteNamespace
  const now = options.now ?? (() => Date.now())
  const persistentCsv = canRemember()

  let source: PlayerSource = standaloneCsv ? 'csv' : 'site'
  let page: PlayerPage = launch.initialPage
  const filters: PlayerFilters = {
    software: 'all',
    nfOnly: false,
    includeUnapproved: false,
    pbStat: 'time',
  }
  let rows: PlayerVideoRow[] = []
  let rawVideos: Video[] = []
  let videos: Video[] = []
  let loading = false
  let loadingText = ''
  let message = ''
  let updatedAt = 0
  let fromCache = false
  let siteName = siteUserId === null ? '本地 CSV' : `#${siteUserId}`
  let datasetVersion = 0
  let dataset: DatasetSnapshot = {
    source,
    identity: source === 'csv' ? 'csv' : `site:${siteUserId}`,
    contentVersion: 0,
    videos: [],
  }

  let siteController: AbortController | null = null
  let requestVersion = 0
  let pendingUnapproved = false
  let csvFlow = 0
  let appliedCsvSnapshot = -1
  let sourceFlow = 0
  let destroyed = false
  const listeners = new Set<(snapshot: PlayerSnapshot) => void>()

  let siteNamespace = normalizeSiteNamespace(DEFAULT_API_BASE)
  let siteScope = siteScopeId(siteNamespace, siteUserId ?? 0)
  let exclusionStore: StatisticsExclusionStore | null = null
  /** 当前页面相关的规则：本玩家网站作用域 + 全部 CSV 作用域。 */
  let exclusionScopes = new Map<string, ExclusionScopeRecord>()
  let exclusionReady = false
  let exclusionError = ''
  let exclusionSaving = false
  let exclusionLoadVersion = 0
  let exclusionRefreshVersion = 0
  let csvBindVersion = 0
  let lastCsvSourceKey = ''
  let csvBindings = new Map<string, string>()
  /** 降级模式没有可靠文件身份，只能按用户明确选择记住本次绑定。 */
  const manualCsvBindings = new Map<
    string,
    { scopeId: string; sourceRevision: number }
  >()
  let csvSources: CsvLoadedSource[] = []
  let exclusionEntries: ExclusionEntry[] = []
  let exclusionUnmatched: UnmatchedExclusion[] = []
  let excludedCount = 0
  let lastExcludedSignature = ''
  let excludedVideoIds = new Set<number>()
  let excludedCsvIndices = new Set<number>()
  let anchorUpdateVersion = 0
  let pendingAnchorVersion: number | null = null
  interface PendingAnchorRule {
    /** 待写入依据所基于的已持久化规则。 */
    base: ExclusionRule
    /** 本页已确认、等待写库的规则（主要是新锚点）。 */
    advanced: ExclusionRule
  }

  /** 已确认但尚未写库的锚点；按作用域和规则保存，基于该作用域的持久化修订号。 */
  const pendingAnchors = new Map<
    string,
    { baseRevision: number; rules: Map<string, PendingAnchorRule> }
  >()
  /** 当前会话快照等待锚点写库成功后才能发布。 */
  let pendingSnapshotVersion: number | null = null
  /** 原始内容或规则上下文变化时递增；异步操作据此拒绝写入新上下文。 */
  let dataVersion = 0
  let channel: BroadcastChannel | null = null

  const session: CsvSession = createSession({
    store: createStore(persistentCsv),
    onChange: () => {
      if (destroyed) return
      void handleCsvSessionChange()
    },
  })
  const offDbBlocked = onDbBlocked(() => {
    session.setMessage(CSV_DB_BLOCKED_MESSAGE)
    // 统计排除首次加载也依赖同一个数据库；网站模式同样需要可见的提示。
    if (!exclusionReady) {
      exclusionError = CSV_DB_BLOCKED_MESSAGE
      emit()
    }
  })

  if (
    options.enableCrossPage !== false &&
    typeof window !== 'undefined' &&
    typeof window.BroadcastChannel === 'function'
  ) {
    channel = new window.BroadcastChannel(EXCLUSION_CHANNEL)
    channel.onmessage = (event: MessageEvent) => {
      if (destroyed || !event.data) return
      if (event.data.type === 'changed') {
        void refreshExclusions()
        return
      }
      if (event.data.type === 'csv-changed') {
        // 另一页面重新关联或改绑来源后，重读清单并按最新来源关系重新匹配。
        void session.checkRegistry().then(() => refreshExclusions())
      }
    }
  }

  function store(): StatisticsExclusionStore {
    exclusionStore ??= exclusionStoreFactory()
    return exclusionStore
  }

  function currentScopeRules(): ExclusionScopeRecord[] {
    if (siteUserId !== null && source === 'site') {
      const scope = exclusionScopes.get(siteScope)
      return scope ? [scope] : []
    }
    return [...exclusionScopes.values()]
  }

  function exclusionState(): PlayerSnapshot['exclusion'] {
    const boundScopeIds = new Set(csvBindings.values())
    // 有真实文件句柄时身份已可靠；显式历史来源只用于无法判断真实文件身份的降级模式。
    const showHistory = source === 'csv' && !persistentCsv
    const historicalScopes = showHistory
      ? [...exclusionScopes.values()]
          .filter(
            (scope) =>
              scope.kind === 'csv' &&
              scope.rules.length > 0 &&
              !boundScopeIds.has(scope.scopeId),
          )
          .map((scope) => ({
            scopeId: scope.scopeId,
            name: scope.owner.kind === 'csv' ? scope.owner.name : 'CSV 文件',
            ruleCount: scope.rules.length,
          }))
      : []
    const unboundSources = showHistory
      ? session.state.sources
          .filter((item) => !csvBindings.has(item.sourceId))
          .map((item) => ({ sourceId: item.sourceId, name: item.name }))
      : []
    return {
      ready: exclusionReady,
      saving: exclusionSaving,
      error: exclusionError,
      entries: exclusionEntries,
      unmatched: exclusionUnmatched,
      excludedCount,
      unmatchedCount: exclusionUnmatched.length,
      ruleCount: currentScopeRules().reduce((sum, scope) => sum + scope.rules.length, 0),
      snapshotKey: exclusionSnapshotKey(),
      unboundSources,
      historicalScopes,
    }
  }

  function emit(): void {
    if (destroyed) return
    const snapshot = getSnapshot()
    for (const listener of [...listeners]) listener(snapshot)
  }

  function touchDataset(force: boolean, baseChanged: boolean, signature: string): void {
    const identity =
      source === 'csv' ? `csv:${session.state.revision}` : `site:${siteUserId ?? 0}`
    if (
      force ||
      baseChanged ||
      signature !== lastExcludedSignature ||
      dataset.source !== source ||
      dataset.identity !== identity
    ) {
      datasetVersion += 1
      dataset = {
        source,
        identity,
        contentVersion: datasetVersion,
        videos,
      }
      lastExcludedSignature = signature
    }
  }

  function hasCurrentSnapshot(): boolean {
    return source === 'csv' ? session.hasSnapshot() : updatedAt > 0 || rows.length > 0
  }

  function sameTargetState(a: ExclusionRule, b: ExclusionRule): boolean {
    const left = a.target
    const right = b.target
    if (left.kind !== right.kind) return false
    if (left.kind === 'site' && right.kind === 'site') {
      return left.videoId === right.videoId
    }
    if (left.kind !== 'csv' || right.kind !== 'csv') return false
    return (
      left.fingerprintVersion === right.fingerprintVersion &&
      left.fingerprint === right.fingerprint &&
      left.occurrence === right.occurrence &&
      left.canonicalRow.length === right.canonicalRow.length &&
      left.canonicalRow.every((value, index) => value === right.canonicalRow[index]) &&
      left.anchor.recordCount === right.anchor.recordCount &&
      left.anchor.prefixDigest === right.anchor.prefixDigest &&
      left.anchor.sameContentCount === right.anchor.sameContentCount
    )
  }

  function effectiveScope(scope: ExclusionScopeRecord): ExclusionScopeRecord {
    const pending = pendingAnchors.get(scope.scopeId)
    if (!pending) return scope
    if (pending.baseRevision !== scope.revision) {
      pendingAnchors.delete(scope.scopeId)
      return scope
    }
    return {
      ...scope,
      rules: scope.rules.map(
        (rule) => pending.rules.get(rule.ruleId)?.advanced ?? rule,
      ),
    }
  }

  function effectiveScopes(): ExclusionScopeRecord[] {
    return [...exclusionScopes.values()].map(effectiveScope)
  }

  interface TrialRuleContext {
    revisions: Map<string, number>
    bindings: string
  }

  function bindingsSignature(): string {
    return [...csvBindings]
      .map(([sourceId, scopeId]) => `${sourceId}=${scopeId}`)
      .sort()
      .join('|')
  }

  /** 记录 trial 计算时实际参与匹配的作用域修订和来源绑定。 */
  function captureTrialRuleContext(): TrialRuleContext {
    const revisions = new Map<string, number>()
    for (const scopeId of new Set(csvBindings.values())) {
      const scope = exclusionScopes.get(scopeId)
      if (scope) revisions.set(scopeId, scope.revision)
    }
    return { revisions, bindings: bindingsSignature() }
  }

  function trialContextChanged(
    context: TrialRuleContext,
    ownRevisions: ReadonlyMap<string, number>,
  ): boolean {
    if (bindingsSignature() !== context.bindings) return true
    for (const [scopeId, revision] of context.revisions) {
      const current = exclusionScopes.get(scopeId)
      if (!current) return true
      if (current.revision === revision) continue
      if (ownRevisions.get(scopeId) === current.revision) continue
      return true
    }
    return false
  }

  interface CsvTrial {
    rawVideos: Video[]
    sources: CsvLoadedSource[]
    entries: ExclusionEntry[]
    unmatched: UnmatchedExclusion[]
    excludedCount: number
    videos: Video[]
    excludedVideoIds: Set<number>
    excludedCsvIndices: Set<number>
    matchedTargets: string[]
  }

  /** 在独立对象中计算待发布快照，不触碰当前已提交的页面状态。 */
  function buildCsvTrial(): CsvTrial {
    const empty: CsvTrial = {
      rawVideos: [],
      sources: [],
      entries: [],
      unmatched: [],
      excludedCount: 0,
      videos: [],
      excludedVideoIds: new Set(),
      excludedCsvIndices: new Set(),
      matchedTargets: [],
    }
    if (!session.hasSnapshot()) return empty
    const sources = session.loadedSources()
    const rawVideosValue = session.videos()
    const entries = buildCsvExclusionEntries(sources, rawVideosValue, csvBindings)
    const evaluation = evaluateCsvExclusions(entries, effectiveScopes())
    return {
      rawVideos: rawVideosValue,
      sources,
      entries: evaluation.entries,
      unmatched: evaluation.unmatched,
      excludedCount: evaluation.excludedCount,
      videos: rawVideosValue.filter((_, index) => !evaluation.excludedCsvIndices.has(index)),
      excludedVideoIds: evaluation.excludedVideoIds,
      excludedCsvIndices: evaluation.excludedCsvIndices,
      matchedTargets: evaluation.matchedTargets,
    }
  }

  function publishCsvTrial(
    trial: CsvTrial,
    snapshotVersion: number,
    changed: boolean,
  ): void {
    rawVideos = trial.rawVideos
    csvSources = trial.sources
    appliedCsvSnapshot = snapshotVersion
    dataVersion += 1
    videos = trial.videos
    exclusionEntries = trial.entries
    exclusionUnmatched = trial.unmatched
    excludedCount = trial.excludedCount
    excludedVideoIds = trial.excludedVideoIds
    excludedCsvIndices = trial.excludedCsvIndices
    const signature = [...trial.matchedTargets].sort().join('\u001e')
    touchDataset(false, changed, signature)
  }

  function applyExclusions(baseChanged: boolean): void {
    if (!exclusionReady) {
      videos = []
      exclusionEntries = []
      exclusionUnmatched = []
      excludedCount = 0
      excludedVideoIds = new Set()
      excludedCsvIndices = new Set()
      return
    }
    if (!hasCurrentSnapshot()) {
      videos = []
      exclusionEntries = []
      exclusionUnmatched = []
      excludedCount = 0
      excludedVideoIds = new Set()
      excludedCsvIndices = new Set()
      // CSV 切源 / 移除全部与网站成功读取空列表都要发布真实空态；
      // 尚未读取时只清空候选，不把规则标成未匹配。
      if (source === 'csv' || updatedAt > 0) {
        touchDataset(false, baseChanged, '')
      }
      return
    }

    let evaluation: ReturnType<typeof evaluateSiteExclusions>
    if (source === 'csv') {
      const entries = buildCsvExclusionEntries(csvSources, rawVideos, csvBindings)
      evaluation = evaluateCsvExclusions(entries, effectiveScopes())
      excludedVideoIds = evaluation.excludedVideoIds
      excludedCsvIndices = evaluation.excludedCsvIndices
      videos = rawVideos.filter((_, index) => !excludedCsvIndices.has(index))
    } else {
      const entries = buildSiteExclusionEntries(rows, siteNamespace, siteUserId ?? 0)
      const scope = exclusionScopes.get(siteScope)
      evaluation = evaluateSiteExclusions(entries, scope?.rules ?? [])
      excludedCsvIndices = evaluation.excludedCsvIndices
      excludedVideoIds = evaluation.excludedVideoIds
      videos = rawVideos.filter((video) => !excludedVideoIds.has(video.id))
    }
    exclusionEntries = evaluation.entries
    exclusionUnmatched = evaluation.unmatched
    excludedCount = evaluation.excludedCount
    const signature = [...evaluation.matchedTargets].sort().join('\u001e')
    touchDataset(false, baseChanged, signature)
  }

  type AnchorOutcome = 'none' | 'success' | 'failed' | 'conflict' | 'deferred' | 'stale'

  interface AnchorCommitResult {
    outcome: AnchorOutcome
    /** 本次由本页提交的作用域修订；用于区分外部更新和自身推进。 */
    revisions: Map<string, number>
  }

  function anchorResult(
    outcome: AnchorOutcome,
    scopes: readonly ExclusionScopeRecord[] = [],
  ): AnchorCommitResult {
    return {
      outcome,
      revisions: new Map(scopes.map((scope) => [scope.scopeId, scope.revision])),
    }
  }

  function storePendingAnchors(
    plans: ReadonlyArray<{ scope: ExclusionScopeRecord; rules: ExclusionRule[] }>,
  ): void {
    for (const plan of plans) {
      const existing = pendingAnchors.get(plan.scope.scopeId)
      const rules =
        existing && existing.baseRevision === plan.scope.revision
          ? new Map(existing.rules)
          : new Map<string, PendingAnchorRule>()
      const present = new Set(plan.rules.map((rule) => rule.ruleId))
      for (const ruleId of [...rules.keys()]) {
        if (!present.has(ruleId)) rules.delete(ruleId)
      }
      for (const rule of plan.rules) {
        const persisted = plan.scope.rules.find((item) => item.ruleId === rule.ruleId)
        if (!persisted) continue
        const base = rules.get(rule.ruleId)?.base ?? persisted
        if (sameTargetState(rule, base)) rules.delete(rule.ruleId)
        else rules.set(rule.ruleId, { base, advanced: rule })
      }
      if (rules.size === 0) pendingAnchors.delete(plan.scope.scopeId)
      else {
        pendingAnchors.set(plan.scope.scopeId, {
          baseRevision: plan.scope.revision,
          rules,
        })
      }
    }
  }

  /**
   * 将已确认的新锚点与上一份未写成功的锚点一起提交。
   * 未匹配或本次没有推进时，也会继续尝试提交已有的待写入依据。
   */
  async function persistCsvMatchAnchors(
    snapshotVersion: number,
    entries: readonly ExclusionEntry[],
    sourceFlowAtStart: number,
  ): Promise<AnchorCommitResult> {
    if (
      destroyed ||
      !exclusionReady ||
      source !== 'csv' ||
      sourceFlow !== sourceFlowAtStart ||
      session.state.snapshotVersion !== snapshotVersion
    ) {
      return anchorResult('stale')
    }
    const updates = advanceCsvRuleAnchors(effectiveScopes(), entries)
    const updateById = new Map(updates.map((rule) => [rule.ruleId, rule]))
    const plans: Array<{ scope: ExclusionScopeRecord; rules: ExclusionRule[] }> = []
    for (const scope of effectiveScopes()) {
      const persisted = exclusionScopes.get(scope.scopeId)
      if (!persisted) continue
      const pending = pendingAnchors.get(scope.scopeId)
      const pendingValid = pending !== undefined && pending.baseRevision === persisted.revision
      const relevant = scope.rules.filter((rule) => updateById.has(rule.ruleId))
      if (!pendingValid && relevant.length === 0) continue
      const rules = [...scope.rules]
      for (const rule of relevant) {
        const index = rules.findIndex((item) => item.ruleId === rule.ruleId)
        if (index >= 0) rules[index] = updateById.get(rule.ruleId)!
      }
      plans.push({ scope: persisted, rules })
    }
    if (plans.length === 0) return anchorResult('none')
    if (exclusionSaving) {
      storePendingAnchors(plans)
      pendingAnchorVersion = snapshotVersion
      return anchorResult('deferred')
    }
    const mutations: ExclusionMutation[] = plans.map((plan) => ({
      scopeId: plan.scope.scopeId,
      kind: plan.scope.kind,
      owner: plan.scope.owner,
      expectedRevision: plan.scope.revision,
      add: [],
      remove: [],
      update: plan.rules,
    }))
    const token = ++anchorUpdateVersion
    try {
      const result = await store().commit(
        mutations,
        () =>
          !destroyed &&
          source === 'csv' &&
          sourceFlow === sourceFlowAtStart &&
          session.state.snapshotVersion === snapshotVersion,
      )
      if (destroyed) return anchorResult('stale')
      if (!result) {
        if (
          source !== 'csv' ||
          sourceFlow !== sourceFlowAtStart ||
          token !== anchorUpdateVersion
        ) {
          return anchorResult('stale')
        }
        storePendingAnchors(plans)
        return anchorResult('conflict')
      }
      // 事务已经成功：即使页面随后切源，也应接纳落库后的规则修订供再次进入时使用。
      acceptScopes(result.scopes)
      for (const scope of result.scopes) pendingAnchors.delete(scope.scopeId)
      exclusionRefreshVersion += 1
      if (result.changed) {
        channel?.postMessage({
          type: 'changed',
          scopes: result.scopes.map((scope) => ({
            scopeId: scope.scopeId,
            revision: scope.revision,
          })),
        })
      }
      if (
        source !== 'csv' ||
        sourceFlow !== sourceFlowAtStart ||
        token !== anchorUpdateVersion
      ) {
        return anchorResult('stale')
      }
      return anchorResult('success', result.scopes)
    } catch {
      if (source !== 'csv' || sourceFlow !== sourceFlowAtStart) {
        return anchorResult('stale')
      }
      storePendingAnchors(plans)
      return anchorResult('failed')
    }
  }

  function rebuildSite(baseChanged = true): void {
    const metas = rows.map((row) => ({
      id: row.id,
      upload_time: row.uploadTime,
      state: row.state,
      ongoing_tournament: row.ongoing,
    }))
    const details = new Map(
      rows.filter((row) => row.detail !== null).map((row) => [row.id, row.detail!]),
    )
    rawVideos = joinVideos(metas, details).videos
    if (baseChanged) dataVersion += 1
    applyExclusions(baseChanged)
  }

  function syncCsvSnapshot(): void {
    // 所有 CSV 快照统一走“先确认锚点、再发布统计”的路径。
    void handleCsvSessionChange(true)
  }

  function getSnapshot(): PlayerSnapshot {
    return {
      launch,
      standaloneCsv,
      embedded,
      source,
      page,
      filters: { ...filters },
      rows,
      videos,
      loading,
      message: loading ? loadingText || message : message,
      updatedAt,
      fromCache,
      siteName,
      dataset,
      csv: session.state,
      csvPersistent: persistentCsv,
      exclusion: exclusionState(),
    }
  }

  function setLoading(next: boolean, text = ''): void {
    loading = next
    loadingText = next ? text : ''
    emit()
  }

  function setSource(next: PlayerSource): void {
    if (destroyed) return
    // 独立 CSV 启动固定本地数据源：内部误调用也不允许切回网站。
    if (standaloneCsv && next === 'site') return
    // 切源让「恢复清单 → 选择文件 → 读取」整条流程失效。
    invalidateCsvFlow()
    if (source === next) {
      emit()
      return
    }
    const previous = source
    sourceFlow += 1
    // 切源统一使进行中的 CSV 发布、锚点提交和后台规则读取失效。
    csvBindVersion += 1
    anchorUpdateVersion += 1
    exclusionRefreshVersion += 1
    source = next
    if (previous === 'csv' && next === 'site' && exclusionReady) {
      pendingSnapshotVersion = null
      exclusionError = ''
    }
    const csv = next === 'csv'
    if (csv) {
      requestVersion += 1
      siteController?.abort()
      siteController = null
      pendingUnapproved = false
      loading = false
      appliedCsvSnapshot = -1
    }
    message = ''
    // 网站记录为空时也重建，避免等待请求期间残留 CSV。
    if (csv) syncCsvSnapshot()
    else rebuildSite(true)
    emit()
    if (!csv) {
      if (rows.length === 0) void runLoad(false)
      else if (filters.includeUnapproved) void loadUnapproved()
    }
  }

  function setPage(next: PlayerPage): void {
    if (embedded && next === 'score') return
    page = next
    emit()
  }

  function setFilters(patch: Partial<PlayerFilters>): void {
    Object.assign(filters, patch)
    emit()
    if (patch.includeUnapproved === true) void loadUnapproved()
  }

  async function runLoad(force: boolean): Promise<void> {
    if (destroyed || siteUserId === null || source === 'csv' || loading) return
    const localController = new AbortController()
    siteController = localController
    const request = ++requestVersion
    const current = (): boolean =>
      !destroyed && source === 'site' && request === requestVersion
    const messageAtStart = message
    message = ''
    setLoading(true, '正在获取录像列表…')
    try {
      const loaded = await load(siteUserId, {
        force,
        signal: localController.signal,
        onProgress: ({ done, total }) => {
          if (current()) setLoading(true, `正在拉取明细：${done}/${total} 批`)
        },
      })
      if (!current()) return
      rows = loaded.rows
      updatedAt = loaded.fetchedAt
      fromCache = loaded.fromCache
      // 加载期间用户点了别处（比如「我的成绩」）就别覆盖提示。
      if (message === '' || message === messageAtStart) {
        message = loaded.missing.length > 0 ? `${loaded.missing.length} 条录像的解析字段没取到` : ''
      }
      rebuildSite(true)
      setLoading(false)
    } catch (error) {
      if (!current()) return
      message = isAbortError(error) ? '已取消' : errorMessage(error)
      setLoading(false)
    } finally {
      if (current()) {
        siteController = null
        if (pendingUnapproved && filters.includeUnapproved) {
          pendingUnapproved = false
          void loadUnapproved()
        }
      }
    }
  }

  async function loadUnapproved(): Promise<void> {
    if (destroyed || siteUserId === null || source === 'csv') return
    if (loading) {
      pendingUnapproved = true
      return
    }
    const ids = rows
      .filter((row) => row.state !== 'c' && !row.ongoing && row.detail === null)
      .map((row) => row.id)
    if (ids.length === 0) {
      pendingUnapproved = false
      return
    }
    const localController = new AbortController()
    siteController = localController
    const request = ++requestVersion
    const current = (): boolean => source === 'site' && request === requestVersion
    const previous = message
    setLoading(true, `正在补抓未过审录像：0/${Math.ceil(ids.length / 100)} 批`)
    try {
      const result = await ensure(siteUserId, rows, ids, {
        signal: localController.signal,
        onProgress: ({ done, total }) => {
          if (current()) setLoading(true, `正在补抓未过审录像：${done}/${total} 批`)
        },
      })
      if (!current()) return
      rows = result.rows
      message = previous
      rebuildSite(true)
      setLoading(false)
    } catch (error) {
      if (!current()) return
      message = isAbortError(error) ? '已取消' : errorMessage(error)
      setLoading(false)
    } finally {
      if (current()) {
        siteController = null
        if (pendingUnapproved && filters.includeUnapproved) {
          pendingUnapproved = false
          void loadUnapproved()
        }
      }
    }
  }

  async function loadSiteName(): Promise<void> {
    if (destroyed || siteUserId === null) return
    try {
      const info = await fetchInfo(siteUserId)
      if (!info || destroyed) return
      siteName = info.username || info.realname || `#${siteUserId}`
      emit()
    } catch {
      // 名字拿不到不影响主流程。
    }
  }

  function relevantScopes(all: readonly ExclusionScopeRecord[]): Map<string, ExclusionScopeRecord> {
    const next = new Map<string, ExclusionScopeRecord>()
    for (const scope of all) {
      if (scope.kind === 'csv' || scope.scopeId === siteScope) next.set(scope.scopeId, scope)
    }
    return next
  }

  /**
   * 只接纳不倒退的作用域修订。晚到的后台读取不能覆盖本地已提交的规则，
   * 更高修订到来时丢弃基于旧修订的待写入锚点。
   */
  function acceptScopes(next: readonly ExclusionScopeRecord[]): boolean {
    let changed = false
    for (const scope of next) {
      const current = exclusionScopes.get(scope.scopeId)
      if (current && current.revision >= scope.revision) continue
      exclusionScopes.set(scope.scopeId, scope)
      const pending = pendingAnchors.get(scope.scopeId)
      if (pending) {
        // 只合并“原规则未被外部改动”的待写入锚点；删除或改绑时尊重外部操作。
        const rebased = new Map<string, PendingAnchorRule>()
        for (const [ruleId, item] of pending.rules) {
          const incoming = scope.rules.find((rule) => rule.ruleId === ruleId)
          if (!incoming || !sameTargetState(incoming, item.base)) continue
          rebased.set(ruleId, {
            base: incoming,
            advanced: { ...incoming, target: item.advanced.target },
          })
        }
        if (rebased.size > 0) {
          pendingAnchors.set(scope.scopeId, {
            baseRevision: scope.revision,
            rules: rebased,
          })
        } else {
          pendingAnchors.delete(scope.scopeId)
        }
      }
      changed = true
    }
    return changed
  }

  function scopesSignature(): string {
    return [...exclusionScopes.values()]
      .map((scope) => `${scope.scopeId}:${scope.revision}`)
      .sort()
      .join('|')
  }

  async function loadExclusions(): Promise<boolean> {
    const generation = ++exclusionLoadVersion
    exclusionRefreshVersion += 1
    try {
      let namespace = siteNamespace
      if (siteUserId !== null) {
        namespace = normalizeSiteNamespace(await namespaceLoader())
        if (!namespace) namespace = normalizeSiteNamespace(DEFAULT_API_BASE)
      }
      if (destroyed || generation !== exclusionLoadVersion) return false
      siteNamespace = namespace
      siteScope = siteScopeId(siteNamespace, siteUserId ?? 0)
      const all = await store().list()
      if (destroyed || generation !== exclusionLoadVersion) return false
      acceptScopes([...relevantScopes(all).values()])
      await bindCsvScopes()
      if (destroyed || generation !== exclusionLoadVersion) return false
      exclusionReady = true
      exclusionError = ''
      return true
    } catch (error) {
      if (destroyed || generation !== exclusionLoadVersion) return false
      exclusionReady = false
      exclusionError = `读取统计排除规则失败：${errorMessage(error)}`
      return false
    }
  }

  async function bindCsvScopes(): Promise<boolean> {
    const sources = session.state.sources
    const scopes = [...exclusionScopes.values()]
      .filter((scope) => scope.kind === 'csv')
      .sort((a, b) => b.rules.length - a.rules.length || b.revision - a.revision)
    const next = new Map<string, string>()
    const used = new Set<string>()
    const currentIds = new Set(sources.map((source) => source.sourceId))
    for (const sourceId of [...manualCsvBindings.keys()]) {
      if (!currentIds.has(sourceId)) manualCsvBindings.delete(sourceId)
    }
    // 用户明确选择“沿用原规则”后，来源清单持久保存目标作用域；优先于文件句柄比较。
    for (const source of sources) {
      if (!source.exclusionScopeId) continue
      const scope = exclusionScopes.get(source.exclusionScopeId)
      if (!scope || scope.kind !== 'csv' || used.has(scope.scopeId)) continue
      next.set(source.sourceId, scope.scopeId)
      used.add(scope.scopeId)
    }
    for (const source of sources) {
      if (next.has(source.sourceId)) continue
      const manual = manualCsvBindings.get(source.sourceId)
      if (!manual || manual.sourceRevision !== source.revision) {
        if (manual) manualCsvBindings.delete(source.sourceId)
        continue
      }
      const scope = exclusionScopes.get(manual.scopeId)
      if (!scope || scope.kind !== 'csv' || used.has(scope.scopeId)) {
        manualCsvBindings.delete(source.sourceId)
        continue
      }
      next.set(source.sourceId, scope.scopeId)
      used.add(scope.scopeId)
    }
    for (const source of sources) {
      if (next.has(source.sourceId)) continue
      for (const scope of scopes) {
        if (used.has(scope.scopeId)) continue
        const owner = scope.owner
        if (owner.kind !== 'csv' || !owner.handle) continue
        try {
          if (await isSameCsvHandle(source.handle, owner.handle)) {
            next.set(source.sourceId, scope.scopeId)
            used.add(scope.scopeId)
            break
          }
        } catch {
          // 身份比较失败时不退回同名匹配；该文件暂时不应用规则。
        }
      }
    }
    const changed =
      next.size !== csvBindings.size ||
      [...next].some(([sourceId, scopeId]) => csvBindings.get(sourceId) !== scopeId)
    csvBindings = next
    return changed
  }

  function csvSourceKey(): string {
    return session.state.sources
      .map((source) => `${source.sourceId}:${source.revision}`)
      .join('|')
  }

  async function handleCsvSessionChange(force = false): Promise<boolean> {
    if (destroyed) return false
    if (source !== 'csv') {
      emit()
      return true
    }
    const token = ++csvBindVersion
    const flow = sourceFlow
    const sourceKey = csvSourceKey()
    const needsBind = sourceKey !== lastCsvSourceKey
    const version = session.state.snapshotVersion
    const baseChanged = version !== appliedCsvSnapshot
    if (baseChanged && pendingSnapshotVersion === version && !force) {
      emit()
      return true
    }
    if (needsBind) {
      await bindCsvScopes()
      if (destroyed || token !== csvBindVersion || source !== 'csv') return false
      lastCsvSourceKey = sourceKey
    }
    if (!baseChanged && !needsBind && !force) {
      emit()
      return true
    }
    let trial = buildCsvTrial()
    let context = captureTrialRuleContext()
    let result = await persistCsvMatchAnchors(version, trial.entries, flow)
    let recalculated = 0
    while (true) {
      if (
        destroyed ||
        source !== 'csv' ||
        sourceFlow !== flow ||
        token !== csvBindVersion ||
        session.state.snapshotVersion !== version
      ) {
        return false
      }
      if (result.outcome === 'stale') return false
      if (
        result.outcome === 'failed' ||
        result.outcome === 'deferred' ||
        result.outcome === 'conflict'
      ) {
        pendingSnapshotVersion = version
        if (result.outcome === 'conflict') {
          // 规则已被其他页面推进：先接纳最新修订，下一次重试按新规则重新计算。
          await reloadAfterConflict()
          if (
            destroyed ||
            source !== 'csv' ||
            sourceFlow !== flow ||
            token !== csvBindVersion
          ) {
            return false
          }
        }
        exclusionError =
          result.outcome === 'deferred'
            ? '正在保存统计排除操作，锚点提交后会自动刷新。'
            : result.outcome === 'conflict'
              ? '排除规则已在其他页面变化，匹配依据未能保存；统计保留上一次成功结果。'
              : '匹配依据保存失败，已保留上一次成功统计；请重试或重新刷新。'
        emit()
        return false
      }
      if (!trialContextChanged(context, result.revisions)) break
      recalculated += 1
      if (recalculated > 2) {
        pendingSnapshotVersion = version
        exclusionError = '排除规则在提交期间发生变化，当前统计暂不发布；请重试。'
        emit()
        return false
      }
      // 旧 trial 依赖的规则已变化：按最新规则重算，并重新完成锚点提交后再发布。
      trial = buildCsvTrial()
      context = captureTrialRuleContext()
      result = await persistCsvMatchAnchors(version, trial.entries, flow)
    }
    if (source !== 'csv' || sourceFlow !== flow) return false
    publishCsvTrial(trial, version, baseChanged || needsBind || force)
    pendingSnapshotVersion = null
    exclusionError = ''
    emit()
    return true
  }

  function invalidateCsvFlow(): number {
    csvFlow += 1
    return csvFlow
  }

  function boundScopeForSource(sourceId: string): string | null {
    return (
      csvBindings.get(sourceId) ??
      session.state.sources.find((source) => source.sourceId === sourceId)
        ?.exclusionScopeId ??
      null
    )
  }

  /** 不同文件必须由用户明确选择；同一真实文件继续自动沿用。 */
  async function relinkContinuation(
    sourceId: string,
    handle: CsvFileHandle,
  ): Promise<CsvRelinkCapture | 'cancel'> {
    const record = session.state.sources.find((source) => source.sourceId === sourceId)
    const scopeId = boundScopeForSource(sourceId)
    const scope = scopeId ? exclusionScopes.get(scopeId) : null
    const capture: CsvRelinkCapture = {
      scopeId,
      basis: {
        registryRevision: session.state.revision,
        sourceRevision: record?.revision,
      },
      scopeRevision: scope?.revision ?? null,
      confirmed: false,
    }
    if (!record) return capture
    let same = false
    try {
      same = await isSameCsvHandle(handle, record.handle)
    } catch {
      // 无法确认身份时也按不同文件处理，交给用户明确选择。
    }
    if (same) return capture
    // 没有可沿用的规则时不存在歧义，直接作为新来源；不额外打断用户。
    if (!options.confirmRelink || (scope?.rules.length ?? 0) === 0) {
      return { ...capture, scopeId: null }
    }
    const mode = await options.confirmRelink({
      sourceId,
      sourceName: record.name,
      newName: handle.name,
      ruleCount: scope?.rules.length ?? 0,
    })
    if (mode === 'cancel') return 'cancel'
    return mode === 'inherit'
      ? { ...capture, confirmed: true }
      : { ...capture, scopeId: null, confirmed: true }
  }

  /** 确认对话框等待期间，清单、来源或规则作用域变化都让旧选择作废。 */
  async function relinkCaptureStillValid(
    sourceId: string,
    capture: CsvRelinkCapture,
  ): Promise<boolean> {
    await session.checkRegistry()
    if (session.state.revision !== capture.basis.registryRevision) return false
    const source = session.state.sources.find((item) => item.sourceId === sourceId)
    if (!source || source.revision !== capture.basis.sourceRevision) return false
    if (capture.confirmed && capture.scopeId && capture.scopeRevision !== null) {
      const stored = await store().get(capture.scopeId)
      if (!stored || stored.revision !== capture.scopeRevision) return false
    }
    return true
  }

  async function selectCsvFiles(selection: CsvSelectionContext): Promise<void> {
    if (destroyed || selection.flow !== csvFlow || session.state.loading) return
    const multiple = selection.kind === 'add'
    try {
      const handles = persistentCsv
        ? await pickFiles(multiple)
        : (await options.requestFiles?.(multiple) ?? []).map(fileHandle)
      if (destroyed || selection.flow !== csvFlow) return
      let exclusionScopeId: string | null = null
      let basis: CsvRelinkBasis | null = null
      let scopeGuard: CsvScopeGuard | undefined
      if (selection.kind === 'relink' && handles[0]) {
        const continuation = await relinkContinuation(selection.sourceId, handles[0])
        if (
          destroyed ||
          selection.flow !== csvFlow ||
          continuation === 'cancel'
        ) {
          return
        }
        if (!(await relinkCaptureStillValid(selection.sourceId, continuation))) {
          if (!destroyed && selection.flow === csvFlow) {
            session.setMessage(
              '关联清单或排除规则已在其他页面变化，请重新关联并确认；原来源未改变。',
            )
          }
          return
        }
        if (destroyed || selection.flow !== csvFlow) return
        exclusionScopeId = continuation.scopeId
        basis = continuation.basis
        if (
          continuation.confirmed &&
          continuation.scopeId &&
          continuation.scopeRevision !== null
        ) {
          const scopeId = continuation.scopeId
          const revision = continuation.scopeRevision
          scopeGuard = {
            scopeId,
            revision,
            verify: async () =>
              !destroyed &&
              selection.flow === csvFlow &&
              (await store().get(scopeId))?.revision === revision,
          }
        }
      }
      await applyCsvSelection(selection, handles, exclusionScopeId, basis, scopeGuard)
    } catch (error) {
      if (destroyed || selection.flow !== csvFlow || isAbortError(error)) return
      session.setMessage(`选择文件失败：${errorMessage(error)}`)
    }
  }

  async function applyCsvSelection(
    selection: CsvSelectionContext,
    handles: CsvFileHandle[],
    exclusionScopeId: string | null = null,
    basis: CsvRelinkBasis | null = null,
    scopeGuard?: CsvScopeGuard,
  ): Promise<void> {
    if (destroyed || selection.flow !== csvFlow || handles.length === 0) return
    const result = selection.kind === 'add'
      ? await session.addFiles(handles)
      : await session.relink(
          selection.sourceId,
          handles[0]!,
          exclusionScopeId,
          basis ?? undefined,
          scopeGuard,
        )
    if (destroyed || selection.flow !== csvFlow || result !== 'success') return
    if (selection.kind === 'relink') {
      channel?.postMessage({ type: 'csv-changed' })
      if (source === 'csv') {
        await bindCsvScopes()
        if (destroyed || selection.flow !== csvFlow) return
      }
    }
    if (selection.kind === 'add' && source === 'site') {
      await bindCsvScopes()
      if (destroyed || selection.flow !== csvFlow || source !== 'site') return
      setSource('csv')
    }
  }

  async function enterCsvSource(): Promise<void> {
    if (destroyed || source === 'csv') return
    const flow = invalidateCsvFlow()
    if (!session.state.ready) await session.restore()
    if (flow !== csvFlow || source !== 'site' || destroyed) return
    if (session.state.sources.length === 0) {
      await selectCsvFiles({ kind: 'add', flow })
      return
    }
    await bindCsvScopes()
    if (flow !== csvFlow || source !== 'site' || destroyed) return
    setSource('csv')
  }

  async function addCsvFiles(): Promise<void> {
    if (destroyed) return
    const flow = invalidateCsvFlow()
    await selectCsvFiles({ kind: 'add', flow })
  }

  async function relinkCsvSource(sourceId: string): Promise<void> {
    if (destroyed) return
    const flow = invalidateCsvFlow()
    await selectCsvFiles({ kind: 'relink', flow, sourceId })
  }

  async function removeCsvSource(sourceId: string): Promise<void> {
    if (destroyed) return
    const flow = sourceFlow
    await session.removeSource(sourceId)
    if (destroyed || flow !== sourceFlow) return
    if (session.state.sources.length === 0 && !standaloneCsv) setSource('site')
    else emit()
  }

  async function removeAllCsv(): Promise<void> {
    if (destroyed) return
    const flow = sourceFlow
    invalidateCsvFlow()
    await session.removeAll()
    if (destroyed || flow !== sourceFlow) return
    if (!standaloneCsv) setSource('site')
    else emit()
  }

  async function refreshCsv(): Promise<void> {
    if (destroyed) return
    await session.refreshAll()
  }

  async function grantCsv(sourceId: string): Promise<void> {
    if (destroyed) return
    await session.grant(sourceId)
  }

  async function checkCsvRegistry(): Promise<void> {
    if (destroyed) return
    if (source === 'csv' && session.state.ready) await session.checkRegistry()
  }

  async function start(): Promise<void> {
    if (destroyed) return
    if (standaloneCsv) await session.restore()
    if (destroyed) return
    const ready = await loadExclusions()
    if (destroyed) return
    if (!ready) {
      emit()
      return
    }
    if (source === 'csv') {
      lastCsvSourceKey = csvSourceKey()
      syncCsvSnapshot()
      emit()
      return
    }
    emit()
    if (siteUserId !== null) {
      void runLoad(false)
      void loadSiteName()
    }
  }

  async function retryExclusions(): Promise<void> {
    if (destroyed) return
    if (pendingSnapshotVersion !== null && source === 'csv') {
      await handleCsvSessionChange(true)
      return
    }
    exclusionError = ''
    const ready = await loadExclusions()
    if (destroyed) return
    if (!ready) {
      emit()
      return
    }
    if (source === 'csv') {
      if (!session.state.ready) await session.restore()
      if (destroyed) return
      await bindCsvScopes()
      if (destroyed) return
      lastCsvSourceKey = csvSourceKey()
      syncCsvSnapshot()
      emit()
      return
    }
    rebuildSite(false)
    emit()
    if (siteUserId !== null && rows.length === 0 && updatedAt === 0) {
      void runLoad(false)
      void loadSiteName()
    }
  }

  async function refreshExclusions(): Promise<void> {
    if (destroyed || !exclusionReady || exclusionSaving) return
    const generation = exclusionLoadVersion
    const token = ++exclusionRefreshVersion
    try {
      const all = await store().list()
      if (
        destroyed ||
        generation !== exclusionLoadVersion ||
        token !== exclusionRefreshVersion
      ) {
        return
      }
      const next = relevantScopes(all)
      if (!acceptScopes([...next.values()])) return
      if (source === 'csv') {
        await bindCsvScopes()
        if (
          destroyed ||
          generation !== exclusionLoadVersion ||
          token !== exclusionRefreshVersion
        ) {
          return
        }
      }
      if (pendingSnapshotVersion !== null) {
        // 有待提交的新快照时只更新规则，不把规则变化套到上一份统计上。
        return
      }
      applyExclusions(false)
      emit()
    } catch {
      // 后台核对失败时保留上一份规则与统计结果，等待下一次焦点核对。
    }
  }

  function contextKey(): string {
    return [
      sourceFlow,
      source,
      dataVersion,
      scopesSignature(),
    ].join('|')
  }

  /** 与面板展示使用同一份键：来源、数据身份和内容版本。 */
  function exclusionSnapshotKey(): string {
    return `${source}|${dataset.identity}|${dataset.contentVersion}`
  }

  function isStaleSnapshot(expected: string | undefined): boolean {
    return expected !== undefined && expected !== exclusionSnapshotKey()
  }

  interface MutationDraft {
    scopeId: string
    kind: 'site' | 'csv'
    owner: ExclusionScopeOwner
    expectedRevision: number
    add: ReturnType<typeof createSiteExclusionRule>[]
    remove: string[]
  }

  function siteOwner(): ExclusionScopeOwner {
    return { kind: 'site', namespace: siteNamespace, userId: siteUserId ?? 0 }
  }

  function csvOwner(
    sourceId: string,
    displayName?: string,
  ): ExclusionScopeOwner | null {
    const record = session.state.sources.find((item) => item.sourceId === sourceId)
    if (!record) return null
    return {
      kind: 'csv',
      name: displayName ?? record.name,
      // 降级模式的文件对象带方法，不能写进 IndexedDB；规则仍按展示名和来源保留。
      handle: persistentCsv ? record.handle : undefined,
      sourceId,
    }
  }

  function draftFor(
    drafts: Map<string, MutationDraft>,
    scopeId: string,
    kind: 'site' | 'csv',
    owner: ExclusionScopeOwner,
  ): MutationDraft {
    const existing = drafts.get(scopeId)
    if (existing) return existing
    const draft: MutationDraft = {
      scopeId,
      kind,
      owner,
      expectedRevision: exclusionScopes.get(scopeId)?.revision ?? 0,
      add: [],
      remove: [],
    }
    drafts.set(scopeId, draft)
    return draft
  }

  async function commitExclusionDrafts(
    drafts: Map<string, MutationDraft>,
    successMessage: string,
  ): Promise<ExclusionActionResult> {
    if (drafts.size === 0) return { ok: true, message: '没有需要保存的变化。' }
    const mutations: ExclusionMutation[] = [...drafts.values()].map((draft) => ({
      scopeId: draft.scopeId,
      kind: draft.kind,
      owner: draft.owner,
      expectedRevision: draft.expectedRevision,
      add: draft.add,
      remove: draft.remove,
    }))
    const context = contextKey()
    exclusionSaving = true
    emit()
    try {
      const result = await store().commit(
        mutations,
        () => !destroyed && contextKey() === context,
      )
      if (destroyed) return { ok: false, message: '页面已关闭，操作未应用。' }
      if (!result) {
        await reloadAfterConflict()
        return { ok: false, message: '规则已在其他页面变化或数据已更新，请重试。' }
      }
      if (contextKey() !== context) {
        // 事务写入后又发生切源 / 刷新：规则已落库，但不要把它套到新上下文。
        await reloadAfterConflict()
        return {
          ok: false,
          message: '数据在保存期间已更新，规则已保存；请确认当前列表后重试。',
        }
      }
      acceptScopes(result.scopes)
      for (const scope of result.scopes) pendingAnchors.delete(scope.scopeId)
      exclusionRefreshVersion += 1
      for (const draft of drafts.values()) {
        if (draft.kind !== 'csv') continue
        const sourceId = session.state.sources.find(
          (item) => csvScopeIdForSource(item.sourceId, item.revision) === draft.scopeId,
        )?.sourceId
        if (sourceId) csvBindings.set(sourceId, draft.scopeId)
      }
      exclusionError = ''
      applyExclusions(false)
      emit()
      if (result.changed) {
        channel?.postMessage({
          type: 'changed',
          scopes: result.scopes.map((scope) => ({
            scopeId: scope.scopeId,
            revision: scope.revision,
          })),
        })
      }
      return { ok: true, message: successMessage }
    } catch (error) {
      return { ok: false, message: `保存失败：${errorMessage(error)}。原结果和规则保持不变。` }
    } finally {
      exclusionSaving = false
      emit()
      // 保存期间可能错过了其他页面的通知，主动核对一次修订号。
      void refreshExclusions()
      if (pendingAnchorVersion !== null) {
        pendingAnchorVersion = null
        void handleCsvSessionChange(true)
      }
    }
  }

  async function reloadAfterConflict(): Promise<void> {
    const token = ++exclusionRefreshVersion
    try {
      const all = await store().list()
      if (destroyed || token !== exclusionRefreshVersion) return
      acceptScopes([...relevantScopes(all).values()])
      if (source === 'csv') await bindCsvScopes()
      if (destroyed || token !== exclusionRefreshVersion) return
      applyExclusions(false)
      emit()
    } catch {
      // 读取失败时保留当前显示；下次聚焦或重试时再核对。
    }
  }

  async function excludeEntries(
    keys: readonly string[],
    snapshotKey?: string,
  ): Promise<ExclusionActionResult> {
    if (destroyed || !exclusionReady) {
      return { ok: false, message: exclusionError || '统计排除规则尚未就绪。' }
    }
    if (pendingSnapshotVersion !== null && source === 'csv') {
      return { ok: false, message: '匹配依据尚未保存，请先重试同步当前刷新结果。' }
    }
    if (isStaleSnapshot(snapshotKey)) {
      return { ok: false, message: '数据已刷新，请重新选择要排除的记录。' }
    }
    if (exclusionSaving) return { ok: false, message: '正在保存上一条操作，请稍候。' }
    const selected = new Set(keys)
    const byKey = new Map(exclusionEntries.map((entry) => [entry.key, entry]))
    const drafts = new Map<string, MutationDraft>()
    let count = 0
    const nowValue = now()
    for (const key of selected) {
      const entry = byKey.get(key)
      if (!entry || entry.excluded) continue
      let scopeId: string
      let owner: ExclusionScopeOwner
      let rule: ReturnType<typeof createSiteExclusionRule>
      if (entry.source === 'site') {
        scopeId = entry.scopeId ?? siteScope
        owner = siteOwner()
        rule = createSiteExclusionRule(entry, nowValue)
      } else {
        const sourceId = entry.sourceId
        if (!sourceId) continue
        const sourceRecord = session.state.sources.find((item) => item.sourceId === sourceId)
        if (!sourceRecord) continue
        scopeId = entry.scopeId ?? csvScopeIdForSource(sourceId, sourceRecord.revision)
        const csvOwnerValue = csvOwner(sourceId, entry.sourceName)
        if (!csvOwnerValue) continue
        owner = csvOwnerValue
        const scopeEntries = exclusionEntries.filter((item) =>
          entry.scopeId === null
            ? item.sourceId === sourceId
            : item.scopeId === scopeId,
        )
        rule = createCsvRuleFromEntries(scopeId, scopeEntries, entry, nowValue)
      }
      const draft = draftFor(drafts, scopeId, entry.source, owner)
      if (!draft.add.some((item) => item.ruleId === rule.ruleId)) {
        draft.add.push(rule)
        count += 1
      }
    }
    if (count === 0) return { ok: true, message: '选中的记录已经排除过了。' }
    return commitExclusionDrafts(drafts, `已排除 ${count} 局，统计正在更新。`)
  }

  async function restoreEntries(
    keys: readonly string[],
    snapshotKey?: string,
  ): Promise<ExclusionActionResult> {
    if (destroyed || !exclusionReady) {
      return { ok: false, message: exclusionError || '统计排除规则尚未就绪。' }
    }
    if (pendingSnapshotVersion !== null && source === 'csv') {
      return { ok: false, message: '匹配依据尚未保存，请先重试同步当前刷新结果。' }
    }
    if (isStaleSnapshot(snapshotKey)) {
      return { ok: false, message: '数据已刷新，请重新选择要恢复的记录。' }
    }
    if (exclusionSaving) return { ok: false, message: '正在保存上一条操作，请稍候。' }
    const selected = new Set(keys)
    const entries = exclusionEntries.filter((entry) => selected.has(entry.key) && entry.excluded)
    const drafts = new Map<string, MutationDraft>()
    let count = 0
    for (const entry of entries) {
      if (!entry.scopeId || !entry.ruleId) continue
      const scope = exclusionScopes.get(entry.scopeId)
      if (!scope) continue
      const draft = draftFor(drafts, scope.scopeId, scope.kind, scope.owner)
      if (!draft.remove.includes(entry.ruleId)) {
        draft.remove.push(entry.ruleId)
        count += 1
      }
    }
    if (count === 0) return { ok: true, message: '选中的记录没有可恢复的排除规则。' }
    return commitExclusionDrafts(drafts, `已恢复 ${count} 局，统计正在更新。`)
  }

  async function linkCsvHistory(
    sourceId: string,
    scopeId: string,
    snapshotKey?: string,
  ): Promise<ExclusionActionResult> {
    if (destroyed || !exclusionReady) {
      return { ok: false, message: exclusionError || '统计排除规则尚未就绪。' }
    }
    if (pendingSnapshotVersion !== null && source === 'csv') {
      return { ok: false, message: '匹配依据尚未保存，请先重试同步当前刷新结果。' }
    }
    if (isStaleSnapshot(snapshotKey)) {
      return { ok: false, message: '数据已刷新，请重新查看当前文件和历史来源。' }
    }
    if (exclusionSaving) return { ok: false, message: '正在保存上一条操作，请稍候。' }
    const sourceRecord = session.state.sources.find((item) => item.sourceId === sourceId)
    if (!sourceRecord) return { ok: false, message: '当前文件已不在关联清单中。' }
    const scope = exclusionScopes.get(scopeId)
    if (!scope || scope.kind !== 'csv') {
      return { ok: false, message: '找不到这个历史 CSV 来源。' }
    }
    if (scope.rules.length === 0) {
      return { ok: false, message: '这个历史来源没有可恢复的排除规则。' }
    }
    const occupied = [...csvBindings].find(
      ([boundSourceId, boundScopeId]) =>
        boundScopeId === scopeId && boundSourceId !== sourceId,
    )
    if (occupied) {
      return { ok: false, message: '这个历史来源已经关联到另一个当前文件。' }
    }
    manualCsvBindings.set(sourceId, {
      scopeId,
      sourceRevision: sourceRecord.revision,
    })
    await bindCsvScopes()
    if (destroyed) return { ok: false, message: '页面已关闭，操作未应用。' }
    const applied = await handleCsvSessionChange(true)
    if (destroyed) return { ok: false, message: '页面已关闭，操作未应用。' }
    if (!applied) {
      return {
        ok: false,
        message: exclusionError || '关联历史来源后匹配依据保存失败，请重试。',
      }
    }
    return {
      ok: true,
      message: `已关联历史来源「${scope.owner.kind === 'csv' ? scope.owner.name : 'CSV 文件'}」，当前 ${exclusionEntries.length} 条记录中匹配排除 ${excludedCount} 条。`,
    }
  }

  async function clearExclusionRules(
    ruleIds: readonly string[],
    snapshotKey?: string,
  ): Promise<ExclusionActionResult> {
    if (destroyed || !exclusionReady) {
      return { ok: false, message: exclusionError || '统计排除规则尚未就绪。' }
    }
    if (pendingSnapshotVersion !== null && source === 'csv') {
      return { ok: false, message: '匹配依据尚未保存，请先重试同步当前刷新结果。' }
    }
    if (isStaleSnapshot(snapshotKey)) {
      return { ok: false, message: '数据已刷新，请重新查看未匹配规则。' }
    }
    if (exclusionSaving) return { ok: false, message: '正在保存上一条操作，请稍候。' }
    const wanted = new Set(ruleIds)
    const drafts = new Map<string, MutationDraft>()
    let count = 0
    for (const scope of exclusionScopes.values()) {
      for (const rule of scope.rules) {
        if (!wanted.has(rule.ruleId)) continue
        const draft = draftFor(drafts, scope.scopeId, scope.kind, scope.owner)
        if (!draft.remove.includes(rule.ruleId)) {
          draft.remove.push(rule.ruleId)
          count += 1
        }
      }
    }
    if (count === 0) return { ok: true, message: '这些规则已经不存在了。' }
    return commitExclusionDrafts(drafts, `已清除 ${count} 条未匹配规则。`)
  }

  function subscribe(listener: (snapshot: PlayerSnapshot) => void): () => void {
    if (destroyed) return () => {}
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  function destroy(): void {
    destroyed = true
    sourceFlow += 1
    dataVersion += 1
    requestVersion += 1
    exclusionLoadVersion += 1
    exclusionRefreshVersion += 1
    exclusionSaving = false
    pendingAnchorVersion = null
    pendingSnapshotVersion = null
    pendingAnchors.clear()
    siteController?.abort()
    siteController = null
    invalidateCsvFlow()
    channel?.close()
    channel = null
    offDbBlocked()
    session.destroy()
    listeners.clear()
  }

  return {
    getSnapshot,
    getCsvSession: () => session,
    subscribe,
    start,
    setSource(next) {
      if (destroyed) return
      session.cancel()
      session.clearMessage()
      setSource(next)
    },
    setPage,
    setFilters,
    refresh: () => runLoad(true),
    cancel: () => siteController?.abort(),
    enterCsvSource,
    addCsvFiles,
    relinkCsvSource,
    removeCsvSource,
    removeAllCsv,
    refreshCsv,
    cancelCsv: () => session.cancel(),
    grantCsv,
    checkCsvRegistry,
    excludeEntries,
    restoreEntries,
    clearExclusionRules,
    linkCsvHistory,
    retryExclusions,
    refreshExclusions,
    setMessage: (text: string) => {
      message = text
      emit()
    },
    destroy,
  }
}
