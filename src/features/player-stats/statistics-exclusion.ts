/**
 * 录像统计排除的纯逻辑：记录身份、CSV 指纹、规则与当前快照的匹配。
 *
 * 这里不访问 DOM、数据库或文件句柄；网站与 CSV 的原始记录由调用方传入，
 * 返回的条目和候选索引供页面控制器生成统计候选数据。
 */

import type { PlayerVideoRow } from '../../shared/db'
import type { CsvRecord } from './csv'
import type { CsvFileHandle, CsvLoadedSource } from './csv-sources'
import type { Video } from './model'

/** 指纹输入格式版本；规范化内容或序列化方式变化时必须提升。 */
export const CSV_FINGERPRINT_VERSION = 1

export interface SiteExclusionTarget {
  kind: 'site'
  videoId: number
}

export interface CsvExclusionAnchor {
  /** 确认规则时的有效记录数。 */
  recordCount: number
  /** 确认规则时整份有效记录序列的摘要，用于判断旧序列是否仍为前缀。 */
  prefixDigest: string
  /** 确认规则时同内容记录条数。 */
  sameContentCount: number
}

export interface CsvExclusionTarget {
  kind: 'csv'
  fingerprintVersion: number
  fingerprint: string
  /** 同一文件内相同内容的第几个出现项，从 1 开始。 */
  occurrence: number
  /** 规范化的 31 列，用于核对散列相同但内容不同的记录。 */
  canonicalRow: string[]
  anchor: CsvExclusionAnchor
}

export type ExclusionTarget = SiteExclusionTarget | CsvExclusionTarget

/** 规则摘要：当前记录缺失时仍可在管理列表中识别。 */
export interface ExclusionRecordSummary {
  date: string | null
  level: string | null
  timems: number | null
  bv: number | null
  nf: boolean | null
  state: string | null
  videoId: number | null
  sourceName: string
}

export interface ExclusionRule {
  ruleId: string
  target: ExclusionTarget
  excludedAt: number
  summary: ExclusionRecordSummary
}

export interface SiteExclusionOwner {
  kind: 'site'
  /** 规范化后的数据站点命名空间。 */
  namespace: string
  userId: number
}

export interface CsvExclusionOwner {
  kind: 'csv'
  name: string
  /** 真实文件身份；仅用于识别，不用于后台读取。 */
  handle?: CsvFileHandle
  /** 最近一次绑定到的关联来源；移除后仍可保留。 */
  sourceId?: string
}

export type ExclusionScopeOwner = SiteExclusionOwner | CsvExclusionOwner
export type ExclusionScopeKind = 'site' | 'csv'

export interface ExclusionScopeRecord {
  scopeId: string
  kind: ExclusionScopeKind
  revision: number
  owner: ExclusionScopeOwner
  rules: ExclusionRule[]
}

export type ExclusionUnmatchedReason = 'missing' | 'ambiguous'

export interface UnmatchedExclusion {
  scopeId: string
  sourceId: string | null
  sourceName: string
  rule: ExclusionRule
  reason: ExclusionUnmatchedReason
  message: string
}

/** 管理列表中的一条当前记录；已排除时附带命中的规则。 */
export interface ExclusionEntry {
  key: string
  source: 'site' | 'csv'
  scopeId: string | null
  sourceId: string | null
  sourceName: string
  /** 文件内有效记录序号（从 0 开始）或网站行序号。 */
  recordIndex: number
  /** 对应完整 CSV 快照中的下标；网站为空。 */
  globalIndex: number | null
  videoId: number | null
  importOrder: number | null
  summary: ExclusionRecordSummary
  canonicalRow?: string[]
  fingerprint?: string
  occurrence?: number
  /** bv / (left + right + double)；明细不足或零点击时为 null。 */
  ioe: number | null
  excluded: boolean
  ruleId: string | null
}

export interface ExclusionEvaluation {
  entries: ExclusionEntry[]
  unmatched: UnmatchedExclusion[]
  excludedCount: number
  matchedTargets: string[]
  excludedVideoIds: Set<number>
  excludedCsvIndices: Set<number>
}

/** 把 API 地址收敛成站点命名空间；无法解析时保留去空白后的文本。 */
export function normalizeSiteNamespace(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  try {
    const url = new URL(trimmed)
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin
  } catch {
    // 测试或降级模式可能传入非 URL 的稳定标识。
  }
  return trimmed.replace(/\/+$/, '')
}

export function siteScopeId(namespace: string, userId: number): string {
  return `site|${encodeURIComponent(normalizeSiteNamespace(namespace))}|${userId}`
}

/**
 * 新建 CSV 作用域时同时使用来源 ID 与来源修订号。
 * 重新关联会保留 sourceId 但提升来源修订号，因此不同文件不会复用旧作用域；
 * 同一清单关联在多页面之间仍得到同一个候选 ID，可依靠修订号做原子冲突检查。
 */
export function csvScopeIdForSource(sourceId: string, sourceRevision: number): string {
  return `csv|${sourceId}|${sourceRevision}`
}

function updateHash(hash: number, code: number): number {
  return Math.imul(hash ^ code, 16_777_619) >>> 0
}

function updateHash2(hash: number, code: number): number {
  return Math.imul(hash ^ code, 2_246_822_519) >>> 0
}

function hex(value: number): string {
  return value.toString(16).padStart(8, '0')
}

function hashParts(parts: readonly string[]): string {
  let first = 2_166_136_261
  let second = 3_266_489_917
  for (const part of parts) {
    for (let index = 0; index < part.length; index += 1) {
      const code = part.charCodeAt(index)
      first = updateHash(first, code)
      second = updateHash2(second, code)
    }
    // 字段边界和长度一起参与，避免相邻字段拼接后得到同一输入。
    first = updateHash(first, 0x1f)
    second = updateHash2(second, part.length)
  }
  return `${hex(first)}${hex(second)}`
}

/** 版本化内容指纹；只由规范化列值和固定列顺序决定。 */
export function csvFingerprint(canonicalRow: readonly string[]): string {
  return `v${CSV_FINGERPRINT_VERSION}-${hashParts([
    `csv:${CSV_FINGERPRINT_VERSION}`,
    ...canonicalRow,
  ])}`
}

/**
 * 有效记录序列摘要，用于确认旧序列完整保留为当前文件的前缀。
 * 直接流式更新散列，避免 20 MB 文件在内存里再展开一份巨大的字符串数组。
 */
export function csvSequenceDigest(canonicalRows: readonly (readonly string[])[]): string {
  let first = 2_166_136_261
  let second = 3_266_489_917
  const updatePart = (part: string): void => {
    for (let index = 0; index < part.length; index += 1) {
      const code = part.charCodeAt(index)
      first = updateHash(first, code)
      second = updateHash2(second, code)
    }
    first = updateHash(first, 0x1f)
    second = updateHash2(second, part.length)
  }
  updatePart(`csv-sequence:${CSV_FINGERPRINT_VERSION}`)
  for (const row of canonicalRows) {
    updatePart(String(row.length))
    for (const field of row) updatePart(field)
  }
  return `${CSV_FINGERPRINT_VERSION}-${hex(first)}${hex(second)}`
}

export function canonicalRowsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false
  }
  return true
}

export function exclusionTargetKey(target: ExclusionTarget): string {
  if (target.kind === 'site') return `site|${target.videoId}`
  return `csv|${target.fingerprintVersion}|${target.fingerprint}|${target.occurrence}`
}

export function ruleIdFor(scopeId: string, target: ExclusionTarget): string {
  return `rule-${hashParts([scopeId, exclusionTargetKey(target)])}`
}

function nfOf(video: Video | null): boolean | null {
  if (!video) return null
  if (video.csvNf !== undefined) return video.csvNf
  if (video.right_ce === null || video.right_ce === undefined) return null
  return video.right_ce === 0
}

/** IOE 沿用效率页口径：bv / (left + right + double)，缺失或零点击返回 null。 */
function ioeOfVideo(video: Video | null): number | null {
  if (!video) return null
  const values = [video.bv, video.left, video.right, video.double]
  if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    return null
  }
  const clicks = (video.left as number) + (video.right as number) + (video.double as number)
  if (!(clicks > 0)) return null
  return (video.bv as number) / clicks
}

function summaryOfVideo(video: Video, sourceName: string): ExclusionRecordSummary {
  return {
    date: video.end_time ?? video.upload_time ?? null,
    level: video.level || null,
    timems: Number.isFinite(video.timems) && video.timems > 0 ? video.timems : null,
    bv: video.bv ?? null,
    nf: nfOf(video),
    state: video.state ?? null,
    videoId: video.id > 0 ? video.id : null,
    sourceName,
  }
}

function siteEntryKey(scopeId: string, videoId: number): string {
  return `site|${scopeId}|${videoId}`
}

function csvEntryKey(
  scopeId: string | null,
  sourceId: string,
  fingerprint: string | undefined,
  occurrence: number,
  recordIndex: number,
): string {
  return fingerprint
    ? `csv|${scopeId ?? 'unbound'}|${sourceId}|${fingerprint}|${occurrence}`
    : `csv|unbound|${sourceId}|row-${recordIndex}`
}

/**
 * 网站管理列表来自原始 `PlayerVideoRow`，缺少明细的记录也保留，
 * 只按稳定录像 ID 和已经取到的字段展示。
 */
export function buildSiteExclusionEntries(
  rows: readonly PlayerVideoRow[],
  namespace: string,
  userId: number,
): ExclusionEntry[] {
  const scope = siteScopeId(namespace, userId)
  return rows.map((row, index) => {
    const detail = row.detail
    const video: Video | null = detail
      ? {
          upload_time: row.uploadTime,
          state: row.state,
          ongoing_tournament: row.ongoing,
          ...detail,
          id: row.id,
        }
      : null
    const summary: ExclusionRecordSummary = video
      ? summaryOfVideo(video, '网站数据')
      : {
          date: row.uploadTime || null,
          level: null,
          timems: null,
          bv: null,
          nf: null,
          state: row.state || null,
          videoId: row.id,
          sourceName: '网站数据',
        }
    return {
      key: siteEntryKey(scope, row.id),
      source: 'site',
      scopeId: scope,
      sourceId: null,
      sourceName: '网站数据',
      recordIndex: index,
      globalIndex: null,
      videoId: row.id,
      importOrder: null,
      summary,
      ioe: ioeOfVideo(video),
      excluded: false,
      ruleId: null,
    }
  })
}

/**
 * CSV 条目按成功读取的文件顺序生成。出现序号只在同一文件、同一内容内计数；
 * 原始规范化列保留下来，供匹配时核对散列，也用于生成新的排除规则。
 */
export function buildCsvExclusionEntries(
  sources: readonly CsvLoadedSource[],
  fullVideos: readonly Video[],
  scopeBySource: ReadonlyMap<string, string>,
): ExclusionEntry[] {
  const entries: ExclusionEntry[] = []
  const nameCount = new Map<string, number>()
  for (const source of sources) {
    nameCount.set(source.name, (nameCount.get(source.name) ?? 0) + 1)
  }
  let globalIndex = 0
  for (const [sourceIndex, source] of sources.entries()) {
    const scopeId = scopeBySource.get(source.sourceId) ?? null
    const sourceName =
      (nameCount.get(source.name) ?? 0) > 1
        ? `${source.name}（来源 ${sourceIndex + 1}）`
        : source.name
    const records: CsvRecord[] | undefined = source.records
    const count = records?.length ?? source.videos.length
    const occurrences = new Map<string, number>()
    for (let recordIndex = 0; recordIndex < count; recordIndex += 1) {
      const video = fullVideos[globalIndex]
      const record = records?.[recordIndex]
      if (!video) {
        globalIndex += 1
        continue
      }
      // parseStatsCsv 已经按同一规则规范化并去引号，这里不再复制整行。
      const canonicalRow = record ? record.canonicalRow : undefined
      const fingerprint = canonicalRow ? csvFingerprint(canonicalRow) : undefined
      const occurrence = fingerprint
        ? (occurrences.get(fingerprint) ?? 0) + 1
        : recordIndex + 1
      if (fingerprint) occurrences.set(fingerprint, occurrence)
      entries.push({
        key: csvEntryKey(
          scopeId,
          source.sourceId,
          fingerprint,
          occurrence,
          recordIndex,
        ),
        source: 'csv',
        scopeId,
        sourceId: source.sourceId,
        sourceName,
        recordIndex,
        globalIndex,
        videoId: video.id,
        importOrder: video.importOrder ?? null,
        summary: summaryOfVideo(video, sourceName),
        canonicalRow,
        fingerprint,
        occurrence,
        ioe: ioeOfVideo(video),
        excluded: false,
        ruleId: null,
      })
      globalIndex += 1
    }
  }
  return entries
}

function unmatched(
  scopeId: string,
  sourceName: string,
  rule: ExclusionRule,
  reason: ExclusionUnmatchedReason,
  sourceId: string | null = null,
): UnmatchedExclusion {
  return {
    scopeId,
    sourceId,
    sourceName,
    rule,
    reason,
    message:
      reason === 'ambiguous'
        ? '文件内容变化后重复条目无法确认，未排除任何猜测出的记录；清除规则后可重新选择具体条目。'
        : '当前记录中找不到这条录像，规则仍保留。',
  }
}

export function evaluateSiteExclusions(
  sourceEntries: readonly ExclusionEntry[],
  rules: readonly ExclusionRule[],
): ExclusionEvaluation {
  const entries = sourceEntries.map((entry) => ({ ...entry }))
  const byId = new Map<number, ExclusionEntry>()
  for (const entry of entries) {
    if (entry.videoId !== null) byId.set(entry.videoId, entry)
  }
  const unmatchedRules: UnmatchedExclusion[] = []
  const matchedTargets: string[] = []
  const excludedVideoIds = new Set<number>()
  const usedRuleIds = new Set<string>()
  for (const rule of rules) {
    if (rule.target.kind !== 'site') continue
    const entry = byId.get(rule.target.videoId)
    if (!entry || entry.ruleId !== null || usedRuleIds.has(rule.ruleId)) {
      unmatchedRules.push(unmatched(entry?.scopeId ?? '', '网站数据', rule, 'missing'))
      continue
    }
    usedRuleIds.add(rule.ruleId)
    entry.excluded = true
    entry.ruleId = rule.ruleId
    excludedVideoIds.add(rule.target.videoId)
    matchedTargets.push(`site|${rule.target.videoId}`)
  }
  return {
    entries,
    unmatched: unmatchedRules,
    excludedCount: matchedTargets.length,
    matchedTargets,
    excludedVideoIds,
    excludedCsvIndices: new Set(),
  }
}

interface ScopeCsvIndex {
  entries: ExclusionEntry[]
  byFingerprint: Map<string, ExclusionEntry[]>
  prefixDigest: string
  prefixCache: Map<number, string>
}

function indexCsvScope(entries: ExclusionEntry[]): ScopeCsvIndex {
  const byFingerprint = new Map<string, ExclusionEntry[]>()
  const canonicalRows: string[][] = []
  for (const entry of entries) {
    if (!entry.fingerprint || !entry.canonicalRow) continue
    const list = byFingerprint.get(entry.fingerprint)
    if (list) list.push(entry)
    else byFingerprint.set(entry.fingerprint, [entry])
    canonicalRows.push(entry.canonicalRow)
  }
  const prefixDigest = csvSequenceDigest(canonicalRows)
  return {
    entries,
    byFingerprint,
    prefixDigest,
    prefixCache: new Map([[canonicalRows.length, prefixDigest]]),
  }
}

function csvPrefixDigest(index: ScopeCsvIndex, recordCount: number): string {
  const cached = index.prefixCache.get(recordCount)
  if (cached !== undefined) return cached
  const digest = csvSequenceDigest(
    index.entries
      .slice(0, recordCount)
      .map((entry) => entry.canonicalRow ?? []),
  )
  index.prefixCache.set(recordCount, digest)
  return digest
}

function matchCsvRule(
  index: ScopeCsvIndex,
  rule: ExclusionRule,
): { entry: ExclusionEntry | null; reason: ExclusionUnmatchedReason | null } {
  const target = rule.target
  if (target.kind !== 'csv') return { entry: null, reason: 'missing' }
  const candidates = (index.byFingerprint.get(target.fingerprint) ?? []).filter(
    (entry) => entry.canonicalRow && canonicalRowsEqual(entry.canonicalRow, target.canonicalRow),
  )
  if (candidates.length === 0) return { entry: null, reason: 'missing' }

  const prefixKept =
    target.anchor.recordCount <= index.entries.length &&
    csvPrefixDigest(index, target.anchor.recordCount) === target.anchor.prefixDigest

  if (prefixKept) {
    const entry = candidates.find((item) => item.occurrence === target.occurrence)
    return entry ? { entry, reason: null } : { entry: null, reason: 'missing' }
  }

  // 内容前后关系已变化：只有确认时和当前都恰好一条时，才能按内容重新定位。
  if (candidates.length === 1 && target.anchor.sameContentCount === 1) {
    return { entry: candidates[0]!, reason: null }
  }
  if (candidates.length > 1 || target.anchor.sameContentCount > 1) {
    return { entry: null, reason: 'ambiguous' }
  }
  return { entry: null, reason: 'missing' }
}

export function evaluateCsvExclusions(
  sourceEntries: readonly ExclusionEntry[],
  scopes: readonly ExclusionScopeRecord[],
): ExclusionEvaluation {
  const entries = sourceEntries.map((entry) => ({ ...entry }))
  const byScope = new Map<string, ExclusionEntry[]>()
  for (const entry of entries) {
    if (entry.source !== 'csv' || entry.scopeId === null) continue
    const list = byScope.get(entry.scopeId)
    if (list) list.push(entry)
    else byScope.set(entry.scopeId, [entry])
  }

  const unmatchedRules: UnmatchedExclusion[] = []
  const matchedTargets: string[] = []
  const excludedCsvIndices = new Set<number>()
  const scopeIndex = new Map<string, ScopeCsvIndex>()
  for (const [scopeId, scopeEntries] of byScope) {
    scopeIndex.set(scopeId, indexCsvScope(scopeEntries))
  }

  for (const scope of scopes) {
    if (scope.kind !== 'csv') continue
    const index = scopeIndex.get(scope.scopeId)
    // 重新关联并沿用规则后，当前文件名可能已变化；优先展示本次快照的来源名。
    const sourceName =
      index?.entries[0]?.sourceName ||
      (scope.owner.kind === 'csv' ? scope.owner.name : '') ||
      'CSV 文件'
    const sourceId = scope.owner.kind === 'csv' ? (scope.owner.sourceId ?? null) : null
    for (const rule of scope.rules) {
      if (rule.target.kind !== 'csv') continue
      if (!index) {
        unmatchedRules.push(
          unmatched(scope.scopeId, sourceName, rule, 'missing', sourceId),
        )
        continue
      }
      const result = matchCsvRule(index, rule)
      if (!result.entry) {
        unmatchedRules.push(
          unmatched(scope.scopeId, sourceName, rule, result.reason ?? 'missing', sourceId),
        )
        continue
      }
      if (result.entry.ruleId !== null) {
        unmatchedRules.push(
          unmatched(scope.scopeId, sourceName, rule, 'ambiguous', sourceId),
        )
        continue
      }
      result.entry.excluded = true
      result.entry.ruleId = rule.ruleId
      if (result.entry.globalIndex !== null) excludedCsvIndices.add(result.entry.globalIndex)
      matchedTargets.push(`csv|${scope.scopeId}|${rule.ruleId}`)
    }
  }

  return {
    entries,
    unmatched: unmatchedRules,
    excludedCount: matchedTargets.length,
    matchedTargets,
    excludedVideoIds: new Set(),
    excludedCsvIndices,
  }
}

/**
 * 新规则必须基于该作用域当前完整的有效记录序列；调用方传入同作用域全部条目。
 * 未绑定作用域的新来源由调用方按 sourceId 过滤后传入。
 */
export function createCsvRuleFromEntries(
  scopeId: string,
  scopeEntries: readonly ExclusionEntry[],
  entry: ExclusionEntry,
  now: number,
): ExclusionRule {
  if (!entry.canonicalRow || !entry.fingerprint || !entry.occurrence) {
    throw new Error('CSV 条目缺少身份信息，不能排除')
  }
  const ordered = scopeEntries
    .filter((item) => item.canonicalRow !== undefined)
    .sort((a, b) => a.recordIndex - b.recordIndex)
  const sameContent = ordered.filter(
    (item) =>
      item.fingerprint === entry.fingerprint &&
      item.canonicalRow !== undefined &&
      canonicalRowsEqual(item.canonicalRow, entry.canonicalRow!),
  ).length
  const target: CsvExclusionTarget = {
    kind: 'csv',
    fingerprintVersion: CSV_FINGERPRINT_VERSION,
    fingerprint: entry.fingerprint,
    occurrence: entry.occurrence,
    canonicalRow: [...entry.canonicalRow],
    anchor: {
      recordCount: ordered.length,
      prefixDigest: csvSequenceDigest(ordered.map((item) => item.canonicalRow!)),
      sameContentCount: sameContent,
    },
  }
  return {
    ruleId: ruleIdFor(scopeId, target),
    target,
    excludedAt: now,
    summary: { ...entry.summary },
  }
}

/**
 * 成功读取完整 CSV 快照后，把已匹配规则推进到当前序列。
 * 只更新本次确实匹配到的规则；未匹配 / 歧义规则保留旧依据，避免错误激活。
 */
export function advanceCsvRuleAnchors(
  scopes: readonly ExclusionScopeRecord[],
  entries: readonly ExclusionEntry[],
): ExclusionRule[] {
  const updates: ExclusionRule[] = []
  const byScope = new Map<string, ExclusionEntry[]>()
  for (const entry of entries) {
    if (entry.source !== 'csv' || entry.scopeId === null) continue
    const list = byScope.get(entry.scopeId)
    if (list) list.push(entry)
    else byScope.set(entry.scopeId, [entry])
  }

  for (const scope of scopes) {
    if (scope.kind !== 'csv') continue
    const scopeEntries = byScope.get(scope.scopeId) ?? []
    if (scopeEntries.length === 0) continue
    const ordered = scopeEntries
      .filter((entry) => entry.canonicalRow !== undefined)
      .sort((a, b) => a.recordIndex - b.recordIndex)
    const prefixDigest = csvSequenceDigest(ordered.map((entry) => entry.canonicalRow!))
    for (const rule of scope.rules) {
      if (rule.target.kind !== 'csv') continue
      const previous = rule.target
      const matched = scopeEntries.find((entry) => entry.ruleId === rule.ruleId)
      if (!matched || !matched.canonicalRow || !matched.occurrence) continue
      const sameContentCount = ordered.filter(
        (entry) =>
          entry.fingerprint === previous.fingerprint &&
          entry.canonicalRow !== undefined &&
          canonicalRowsEqual(entry.canonicalRow, previous.canonicalRow),
      ).length
      if (sameContentCount === 0) continue
      const anchor: CsvExclusionAnchor = {
        recordCount: ordered.length,
        prefixDigest,
        sameContentCount,
      }
      const target: CsvExclusionTarget = {
        ...previous,
        occurrence: matched.occurrence,
        canonicalRow: [...matched.canonicalRow],
        anchor,
      }
      if (
        target.occurrence === previous.occurrence &&
        target.anchor.recordCount === previous.anchor.recordCount &&
        target.anchor.prefixDigest === previous.anchor.prefixDigest &&
        target.anchor.sameContentCount === previous.anchor.sameContentCount &&
        canonicalRowsEqual(target.canonicalRow, previous.canonicalRow)
      ) {
        continue
      }
      updates.push({ ...rule, target })
    }
  }
  return updates
}

export function createSiteExclusionRule(entry: ExclusionEntry, now: number): ExclusionRule {
  if (entry.videoId === null) throw new Error('网站条目缺少录像 ID，不能排除')
  const target: SiteExclusionTarget = { kind: 'site', videoId: entry.videoId }
  return {
    ruleId: ruleIdFor(entry.scopeId ?? '', target),
    target,
    excludedAt: now,
    summary: { ...entry.summary },
  }
}

/** 恢复时只清除明确规则的 ruleId，不按摘要或内容批量恢复。 */
export function ruleIdsForEntries(entries: readonly ExclusionEntry[]): string[] {
  return [
    ...new Set(
      entries
        .map((entry) => entry.ruleId)
        .filter((ruleId): ruleId is string => ruleId !== null),
    ),
  ]
}
