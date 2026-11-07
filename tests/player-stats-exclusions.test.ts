import { describe, expect, it } from 'vitest'
import type { PlayerVideoRow } from '../src/shared/db'
import { parseStatsCsv } from '../src/features/player-stats/csv'
import {
  buildCsvSnapshot,
} from '../src/features/player-stats/csv-sources'
import type { CsvLoadedSource } from '../src/features/player-stats/csv-sources'
import type { ExclusionScopeRecord } from '../src/features/player-stats/statistics-exclusion'
import {
  advanceCsvRuleAnchors,
  buildCsvExclusionEntries,
  buildSiteExclusionEntries,
  createCsvRuleFromEntries,
  createSiteExclusionRule,
  csvFingerprint,
  evaluateCsvExclusions,
  evaluateSiteExclusions,
  normalizeSiteNamespace,
  siteScopeId,
} from '../src/features/player-stats/statistics-exclusion'
import { CSV, HEADER, csv } from './helpers/stats-csv'

function source(
  name: string,
  text: string,
  sourceId = 'source-1',
): CsvLoadedSource {
  const parsed = parseStatsCsv(text)
  return {
    sourceId,
    sourceRevision: 1,
    name,
    videos: parsed.videos,
    records: parsed.records,
    summary: {
      readAt: 1,
      validCount: parsed.videos.length,
      totalRows: parsed.total,
      invalidRows: parsed.errors.length,
      size: text.length,
      lastModified: 1,
    },
  }
}

function csvEntries(sources: readonly CsvLoadedSource[]): {
  entries: ReturnType<typeof buildCsvExclusionEntries>
  videos: ReturnType<typeof buildCsvSnapshot>
  scopeMap: Map<string, string>
} {
  const scopeMap = new Map(sources.map((item) => [item.sourceId, `csv|${item.sourceId}`]))
  const videos = buildCsvSnapshot([...sources])
  return {
    entries: buildCsvExclusionEntries(sources, videos, scopeMap),
    videos,
    scopeMap,
  }
}

function csvScope(scopeId: string, rules: ExclusionScopeRecord['rules'] = []): ExclusionScopeRecord {
  return {
    scopeId,
    kind: 'csv',
    revision: 1,
    owner: { kind: 'csv', name: 'a.csv', sourceId: 'source-1' },
    rules,
  }
}

function siteRow(id: number, time: number): PlayerVideoRow {
  const base = parseStatsCsv(CSV).videos[0]!
  return {
    userId: 16,
    id,
    state: 'c',
    uploadTime: '2026-11-03T00:00:00.000Z',
    ongoing: false,
    detail: { ...base, id, timems: time },
  }
}

describe('统计排除：网站身份', () => {
  it('按站点命名空间与玩家 ID 区分作用域，并规范化等价地址', () => {
    expect(normalizeSiteNamespace('https://OPENMS.top/path/')).toBe('https://openms.top')
    expect(siteScopeId('https://openms.top', 16)).not.toBe(
      siteScopeId('https://openms.top', 17),
    )
    expect(siteScopeId('https://openms.top', 16)).not.toBe(
      siteScopeId('https://other.example', 16),
    )
  })

  it('录像明细、审核状态或上传时间变化后仍按 ID 排除', () => {
    const first = buildSiteExclusionEntries([siteRow(100, 5000)], 'https://openms.top', 16)
    const rule = createSiteExclusionRule(first[0]!, 1)
    expect(rule.target).toEqual({ kind: 'site', videoId: 100 })

    const changed = siteRow(100, 6500)
    changed.state = 'a'
    changed.uploadTime = '2026-11-04T00:00:00.000Z'
    const next = buildSiteExclusionEntries([changed], 'https://openms.top', 16)
    const result = evaluateSiteExclusions(next, [rule])
    expect(result.excludedCount).toBe(1)
    expect(result.excludedVideoIds.has(100)).toBe(true)
    expect(result.unmatched).toHaveLength(0)
  })

  it('缺失明细的网站记录仍可按稳定 ID 排除，不会从管理列表消失', () => {
    const row: PlayerVideoRow = {
      userId: 16,
      id: 9,
      state: 'a',
      uploadTime: '2026-11-03T00:00:00.000Z',
      ongoing: false,
      detail: null,
    }
    const entries = buildSiteExclusionEntries([row], 'https://openms.top', 16)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.summary.level).toBeNull()
    const rule = createSiteExclusionRule(entries[0]!, 1)
    const result = evaluateSiteExclusions(entries, [rule])
    expect(result.excludedCount).toBe(1)
    expect(result.entries[0]!.excluded).toBe(true)
  })
})

describe('统计排除：CSV 身份与匹配', () => {
  it('同文件完全相同的行只排除指定出现项，追加相同内容不继承', () => {
    const before = csvEntries([source('a.csv', csv(5000, 5000))])
    const rule = createCsvRuleFromEntries(
      before.entries[1]!.scopeId!,
      before.entries,
      before.entries[1]!,
      1,
    )
    expect(rule.target.kind).toBe('csv')
    if (rule.target.kind !== 'csv') throw new Error('target')
    expect(rule.target.occurrence).toBe(2)
    expect(rule.target.anchor).toMatchObject({ recordCount: 2, sameContentCount: 2 })

    const after = csvEntries([source('a.csv', csv(5000, 5000, 5000))])
    const result = evaluateCsvExclusions(after.entries, [csvScope('csv|source-1', [rule])])
    expect([...result.excludedCsvIndices]).toEqual([1])
    expect(result.entries[2]!.excluded).toBe(false)
  })

  it('成功刷新后推进锚点：唯一记录追加重复再删减时转为未匹配', () => {
    const initial = csvEntries([source('a.csv', csv(5000))])
    const rule = createCsvRuleFromEntries(
      initial.entries[0]!.scopeId!,
      initial.entries,
      initial.entries[0]!,
      1,
    )
    let scope = csvScope('csv|source-1', [rule])

    const appended = csvEntries([source('a.csv', csv(5000, 5000))])
    const afterAppend = evaluateCsvExclusions(appended.entries, [scope])
    expect([...afterAppend.excludedCsvIndices]).toEqual([0])
    const updates = advanceCsvRuleAnchors([scope], afterAppend.entries)
    expect(updates).toHaveLength(1)
    if (updates[0]!.target.kind !== 'csv') throw new Error('target')
    expect(updates[0]!.target.anchor).toMatchObject({
      recordCount: 2,
      sameContentCount: 2,
    })
    scope = { ...scope, revision: 2, rules: [updates[0]!] }

    const trimmed = csvEntries([source('a.csv', csv(5000))])
    const afterDelete = evaluateCsvExclusions(trimmed.entries, [scope])
    expect(afterDelete.excludedCsvIndices.size).toBe(0)
    expect(afterDelete.unmatched[0]!.reason).toBe('ambiguous')
    // 歧义快照不能反过来覆盖已有的匹配依据。
    expect(advanceCsvRuleAnchors([scope], afterDelete.entries)).toEqual([])
  })

  it('原记录序列只在末尾追加时沿用出现序号', () => {
    const before = csvEntries([source('a.csv', csv(5000, 6000))])
    const rule = createCsvRuleFromEntries(
      before.entries[0]!.scopeId!,
      before.entries,
      before.entries[0]!,
      1,
    )
    const after = csvEntries([source('a.csv', csv(5000, 6000, 7000))])
    const result = evaluateCsvExclusions(after.entries, [csvScope('csv|source-1', [rule])])
    expect([...result.excludedCsvIndices]).toEqual([0])
  })

  it('在唯一目标前插入其他记录时按内容重新定位，不依赖行号', () => {
    const before = csvEntries([source('a.csv', csv(5000, 6000))])
    const target = before.entries[1]!
    const rule = createCsvRuleFromEntries(target.scopeId!, before.entries, target, 1)
    const after = csvEntries([source('a.csv', csv(7000, 5000, 6000))])
    const result = evaluateCsvExclusions(after.entries, [csvScope('csv|source-1', [rule])])
    expect([...result.excludedCsvIndices]).toEqual([2])
    expect(result.unmatched).toHaveLength(0)
  })

  it('重复目标内容无法确认时转未匹配，不猜测排除任何一条', () => {
    const before = csvEntries([source('a.csv', csv(5000, 5000, 5000))])
    const rule = createCsvRuleFromEntries(
      before.entries[1]!.scopeId!,
      before.entries,
      before.entries[1]!,
      1,
    )
    const after = csvEntries([source('a.csv', csv(5000, 5000))])
    const result = evaluateCsvExclusions(after.entries, [csvScope('csv|source-1', [rule])])
    expect(result.excludedCsvIndices.size).toBe(0)
    expect(result.unmatched).toHaveLength(1)
    expect(result.unmatched[0]!.reason).toBe('ambiguous')

    // 同一份有歧义的快照再次刷新也不能错误激活。
    const again = evaluateCsvExclusions(after.entries, [csvScope('csv|source-1', [rule])])
    expect(again.excludedCsvIndices.size).toBe(0)
    expect(again.unmatched[0]!.reason).toBe('ambiguous')
  })

  it('原目标消失时保留规则，重新出现且内容可确认时恢复排除', () => {
    const before = csvEntries([source('a.csv', csv(5000, 6000))])
    const rule = createCsvRuleFromEntries(
      before.entries[0]!.scopeId!,
      before.entries,
      before.entries[0]!,
      1,
    )
    const missing = csvEntries([source('a.csv', csv(6000))])
    const missingResult = evaluateCsvExclusions(
      missing.entries,
      [csvScope('csv|source-1', [rule])],
    )
    expect(missingResult.excludedCsvIndices.size).toBe(0)
    expect(missingResult.unmatched[0]!.reason).toBe('missing')

    const empty = csvEntries([source('a.csv', `${HEADER}\n`)])
    const emptyResult = evaluateCsvExclusions(empty.entries, [csvScope('csv|source-1', [rule])])
    expect(emptyResult.unmatched[0]!.reason).toBe('missing')

    const restored = csvEntries([source('a.csv', csv(5000, 6000))])
    const restoredResult = evaluateCsvExclusions(
      restored.entries,
      [csvScope('csv|source-1', [rule])],
    )
    expect([...restoredResult.excludedCsvIndices]).toEqual([0])
  })

  it('BOM、换行和引号写法不改变身份', () => {
    const plain = source('a.csv', csv(5000, 6000))
    const row = csv(5000).split('\n')[1]!
    const quoted = row.split(',').map((field) => `"${field}"`).join(',')
    const formatted = source('a.csv', `\uFEFF${HEADER}\r\n${quoted}\r\n`)
    expect(formatted.records![0]!.canonicalRow).toEqual(plain.records![0]!.canonicalRow)
    expect(csvFingerprint(formatted.records![0]!.canonicalRow)).toBe(
      csvFingerprint(plain.records![0]!.canonicalRow),
    )
  })

  it('显示精度相同但原始字段不同时不误匹配', () => {
    const a = source('a.csv', csv(5000))
    const b = source('b.csv', csv(5000).replace(',5.000,', ',5.00,'))
    expect(a.videos[0]!.timems).toBe(b.videos[0]!.timems)
    expect(csvFingerprint(a.records![0]!.canonicalRow)).not.toBe(
      csvFingerprint(b.records![0]!.canonicalRow),
    )
  })

  it('不同文件内相同内容始终属于不同作用域', () => {
    const a = source('a.csv', csv(5000), 'a')
    const b = source('b.csv', csv(5000), 'b')
    const built = csvEntries([a, b])
    const rule = createCsvRuleFromEntries(
      built.entries[0]!.scopeId!,
      built.entries.filter((entry) => entry.scopeId === built.entries[0]!.scopeId),
      built.entries[0]!,
      1,
    )
    const result = evaluateCsvExclusions(built.entries, [
      csvScope('csv|a', [rule]),
      csvScope('csv|b'),
    ])
    expect([...result.excludedCsvIndices]).toEqual([0])
    expect(result.entries[1]!.excluded).toBe(false)
  })

  it('增加解析无效行或调整来源顺序不影响目标条目', () => {
    const before = csvEntries([source('a.csv', csv(5000, 6000))])
    const rule = createCsvRuleFromEntries(
      before.entries[0]!.scopeId!,
      before.entries,
      before.entries[0]!,
      1,
    )
    const withInvalid = `${csv(5000, 6000)}\nbad,row\n`
    const after = csvEntries([source('a.csv', withInvalid)])
    const result = evaluateCsvExclusions(after.entries, [csvScope('csv|source-1', [rule])])
    expect([...result.excludedCsvIndices]).toEqual([0])
  })

  it('同名文件在管理列表中沿用来源序号，不混淆来源', () => {
    const built = csvEntries([
      source('stats.csv', csv(5000), 'a'),
      source('stats.csv', csv(6000), 'b'),
    ])
    expect(built.entries.map((entry) => entry.sourceName)).toEqual([
      'stats.csv（来源 1）',
      'stats.csv（来源 2）',
    ])
  })

  it('筛选候选录像时保留完整快照 ID 与相对顺序', () => {
    const built = csvEntries([source('a.csv', csv(5000, 6000, 7000))])
    const target = built.entries[1]!
    const rule = createCsvRuleFromEntries(target.scopeId!, built.entries, target, 1)
    const result = evaluateCsvExclusions(built.entries, [csvScope('csv|source-1', [rule])])
    const kept = built.videos.filter((_, index) => !result.excludedCsvIndices.has(index))
    expect(kept.map((video) => video.id)).toEqual([-1, -3])
    expect(kept.map((video) => video.importOrder)).toEqual([0, 2])
  })
})
