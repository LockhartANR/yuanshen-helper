import { describe, expect, it } from 'vitest'
import {
  compileConfig,
  ConfigError,
  createDefaultConfig,
  exportConfig,
  importConfig,
  newMetricId,
  normalizeStoredConfig,
  validateConfig,
} from '../src/features/custom-ranking/config'
import { RANK_CONFIG_VERSION } from '../src/features/custom-ranking/model'
import { normalizeFilter, parseLocalDate } from '../src/features/custom-ranking/filter'

describe('排行榜配置', () => {
  it('新增指标 ID 不会复用当前或旧结果中的 ID', () => {
    const config = createDefaultConfig()
    const first = newMetricId(config.metrics)
    expect(first).toMatch(/^metric-/)
    const second = newMetricId([...config.metrics, { ...config.metrics[0]!, id: first }])
    expect(second).not.toBe(first)
    expect(newMetricId(config.metrics, [first])).not.toBe(first)
  })

  it('默认配置可编译并导出后再导入', () => {
    const config = createDefaultConfig()
    const compiled = compileConfig(config)
    expect(compiled.metrics).toHaveLength(3)
    expect(compiled.cacheKey).toContain('max(bv / time)')
    const imported = importConfig(exportConfig(config))
    expect(imported.config.name).toBe(config.name)
    expect(imported.config.metrics.map((metric) => metric.formula)).toEqual(
      config.metrics.map((metric) => metric.formula),
    )
    expect(imported.warnings).toEqual([])
    expect(imported.config.defaultSortMetricId).toBe(config.metrics[0]!.id)
    expect(exportConfig(config)).not.toContain('rankingPageSize')
  })

  it('迁移旧版多优先级配置为单一默认指标，并保留原指标数据', () => {
    const config = createDefaultConfig()
    const legacy = {
      ...config,
      configVersion: 1,
      defaultSortMetricId: undefined,
      metrics: config.metrics.map((metric) => ({ ...metric, direction: 'asc' as const })),
    }
    const imported = importConfig(JSON.stringify({ format: 'yuanshen-ranking-config', version: 1, config: legacy }))
    expect(imported.warnings.join()).toContain('旧版多指标优先级')
    expect(imported.config.configVersion).toBe(RANK_CONFIG_VERSION)
    expect(imported.config.defaultSortMetricId).toBe(legacy.metrics[0]!.id)
    expect(imported.config.metrics.map((metric) => metric.direction)).toEqual(['asc', 'asc', 'asc'])
    expect(imported.config.metrics.map((metric) => metric.formula)).toEqual(
      legacy.metrics.map((metric) => metric.formula),
    )
  })

  it('无效默认指标回退首项，空指标为空', () => {
    const config = createDefaultConfig()
    expect(validateConfig({ ...config, defaultSortMetricId: 'missing' }).defaultSortMetricId).toBe(
      config.metrics[0]!.id,
    )
    const empty = normalizeStoredConfig({ ...config, metrics: [] })
    expect(empty.defaultSortMetricId).toBeNull()
    expect(normalizeStoredConfig({ ...config, defaultSortMetricId: 'ioe' }).defaultSortMetricId).toBe('ioe')
  })

  it('拒绝未知格式、版本、公式、重复 ID 和空指标', () => {
    const config = createDefaultConfig()
    expect(() => importConfig('not json')).toThrow(ConfigError)
    expect(() => importConfig(JSON.stringify({ format: 'other', version: 1, config }))).toThrow(/配置文件/)
    expect(() => importConfig(JSON.stringify({ format: 'yuanshen-ranking-config', version: 99, config }))).toThrow(/版本/)
    expect(() =>
      validateConfig({
        ...config,
        metrics: [{ ...config.metrics[0], formula: 'max(nope)' }],
      }),
    ).toThrow(/未知字段/)
    expect(() =>
      validateConfig({
        ...config,
        metrics: [config.metrics[0], { ...config.metrics[1], id: config.metrics[0]!.id }],
      }),
    ).toThrow(/重复/)
    expect(() => validateConfig({ ...config, metrics: [] })).toThrow(/至少/)
  })

  it('拒绝空难度/状态/模式、非法日期和非法精度', () => {
    const config = createDefaultConfig()
    expect(() =>
      validateConfig({ ...config, filter: { ...config.filter, levels: [] } }),
    ).toThrow(/难度/)
    expect(() =>
      validateConfig({ ...config, filter: { ...config.filter, states: [] } }),
    ).toThrow(/状态/)
    expect(() =>
      validateConfig({ ...config, filter: { ...config.filter, modes: [] } }),
    ).toThrow(/模式/)
    expect(() =>
      validateConfig({ ...config, filter: { ...config.filter, from: '2026-02-30' } }),
    ).toThrow(/日期/)
    expect(() =>
      validateConfig({
        ...config,
        filter: { ...config.filter, from: '2026-11-18', to: '2026-11-17' },
      }),
    ).toThrow(/开始日期/)
    expect(() =>
      validateConfig({
        ...config,
        metrics: [{ ...config.metrics[0], digits: 9 }],
      }),
    ).toThrow(/精度/)
  })
})

describe('筛选日期', () => {
  it('严格解析本地日期并返回左闭右开区间', () => {
    expect(parseLocalDate('2026-11-17')).toBe(new Date(2026, 10, 17).getTime())
    expect(parseLocalDate('2026-02-29')).toBeNull()
    expect(parseLocalDate('2026-13-01')).toBeNull()
    const filter = normalizeFilter({ from: '2026-11-17', to: '2026-11-18' })
    expect(filter.from).toBe('2026-11-17')
  })
})
