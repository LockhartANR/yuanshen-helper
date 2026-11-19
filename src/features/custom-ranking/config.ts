import {
  DEFAULT_RANK_CONFIG,
  RANK_CONFIG_FORMAT,
  RANK_CONFIG_LEGACY_VERSION,
  RANK_CONFIG_VERSION,
  RANK_LANGUAGE_VERSION,
  RANK_SCHEMA_VERSION,
  type RankConfig,
  type RankFilter,
  type RankMetric,
} from './model'
import { compileFormula, type CompiledFormula } from './expression/validate'
import { normalizeFilter, parseLocalDate } from './filter'

export interface CompiledMetric extends RankMetric {
  compiled: CompiledFormula
}

export interface CompiledConfig {
  config: RankConfig
  metrics: CompiledMetric[]
  filter: RankFilter
  cacheKey: string
}

export class ConfigError extends Error {
  readonly index: number | null

  constructor(message: string, index: number | null = null) {
    super(message)
    this.name = 'ConfigError'
    this.index = index
  }
}

const MAX_METRICS = 10
const MAX_DIGITS = 6
let metricIdSequence = 0

function nextMetricIdSuffix(): string {
  metricIdSequence += 1
  // 时间戳 + 会话内序号 + 随机段：删除后不再按长度生成同名 ID，避免命中旧结果向量。
  const random = Math.random().toString(36).slice(2, 8).padEnd(6, '0')
  return `${Date.now().toString(36)}-${metricIdSequence.toString(36)}-${random.slice(0, 6)}`
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 默认指标只按稳定 ID 引用；缺失或失效时回退到第一项。 */
function normalizeDefaultSortMetricId(value: unknown, metrics: RankMetric[]): string | null {
  const id = asText(value)
  if (id && metrics.some((metric) => metric.id === id)) return id
  return metrics[0]?.id ?? null
}

function validateMetric(raw: unknown, index: number): RankMetric {
  if (!raw || typeof raw !== 'object') throw new ConfigError(`第 ${index + 1} 项指标格式不正确`, index)
  const item = raw as Record<string, unknown>
  const id = asText(item.id)
  const name = asText(item.name)
  const formula = asText(item.formula)
  if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    throw new ConfigError(`第 ${index + 1} 项指标 ID 不合法`, index)
  }
  if (!name) throw new ConfigError(`第 ${index + 1} 项指标缺少名称`, index)
  if (!formula) throw new ConfigError(`第 ${index + 1} 项指标缺少公式`, index)
  try {
    compileFormula(formula)
  } catch (error) {
    throw new ConfigError(
      `第 ${index + 1} 项指标「${name}」公式错误：${error instanceof Error ? error.message : String(error)}`,
      index,
    )
  }
  const direction = item.direction === 'asc' ? 'asc' : item.direction === 'desc' ? 'desc' : null
  if (!direction) throw new ConfigError(`第 ${index + 1} 项指标方向必须是升序或降序`, index)
  const digits = item.digits === undefined ? 2 : Number(item.digits)
  if (!Number.isInteger(digits) || digits < 0 || digits > MAX_DIGITS) {
    throw new ConfigError(`第 ${index + 1} 项指标精度必须是 0–${MAX_DIGITS} 的整数`, index)
  }
  return { id, name, formula, direction, digits }
}

function validateFilter(raw: unknown): RankFilter {
  const filter = normalizeFilter((raw ?? {}) as Partial<RankFilter>)
  if (filter.levels.length === 0) throw new ConfigError('至少选择一个难度')
  if (filter.states.length === 0) throw new ConfigError('至少选择一个审核状态')
  if (filter.modes.length === 0) throw new ConfigError('至少填写一个模式')
  if (filter.from && parseLocalDate(filter.from) === null) {
    throw new ConfigError('开始日期格式应为有效的 YYYY-MM-DD')
  }
  if (filter.to && parseLocalDate(filter.to) === null) {
    throw new ConfigError('结束日期格式应为有效的 YYYY-MM-DD')
  }
  const from = filter.from ? parseLocalDate(filter.from) : null
  const to = filter.to ? parseLocalDate(filter.to) : null
  if (from !== null && to !== null && from > to) {
    throw new ConfigError('开始日期不能晚于结束日期')
  }
  return filter
}

export function validateConfig(raw: unknown): RankConfig {
  if (!raw || typeof raw !== 'object') throw new ConfigError('配置格式不正确')
  const item = raw as Record<string, unknown>
  const metricsRaw = item.metrics
  if (!Array.isArray(metricsRaw)) throw new ConfigError('配置缺少指标列表')
  if (metricsRaw.length === 0) throw new ConfigError('至少保留一项指标')
  if (metricsRaw.length > MAX_METRICS) throw new ConfigError(`首版最多 ${MAX_METRICS} 项指标`)
  const metrics = metricsRaw.map(validateMetric)
  const ids = new Set<string>()
  for (const metric of metrics) {
    if (ids.has(metric.id)) throw new ConfigError(`指标 ID 重复：${metric.id}`)
    ids.add(metric.id)
  }
  const name = asText(item.name) || '未命名排行'
  const id = asText(item.id) || `config-${Date.now()}`
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new ConfigError('配置 ID 不合法')
  return {
    id,
    name,
    configVersion: RANK_CONFIG_VERSION,
    languageVersion: Number(item.languageVersion) || RANK_LANGUAGE_VERSION,
    fieldSchemaVersion: Number(item.fieldSchemaVersion) || RANK_SCHEMA_VERSION,
    metrics,
    defaultSortMetricId: normalizeDefaultSortMetricId(item.defaultSortMetricId, metrics),
    filter: validateFilter(item.filter),
    updatedAt: Date.now(),
  }
}

/**
 * 读取本机旧配置时只做迁移：不校验公式草稿，也不因缺字段丢掉用户数据。
 * 保存前仍由 validateConfig 严格校验。
 */
export function normalizeStoredConfig(raw: unknown): RankConfig {
  if (!raw || typeof raw !== 'object') return createDefaultConfig()
  const item = raw as Record<string, unknown>
  const metrics: RankMetric[] = []
  if (Array.isArray(item.metrics)) {
    for (const value of item.metrics) {
      if (!value || typeof value !== 'object') continue
      const metric = value as Record<string, unknown>
      const id = asText(metric.id)
      const name = asText(metric.name)
      const formula = asText(metric.formula)
      if (!id || !name || !formula) continue
      const digits = Number(metric.digits)
      metrics.push({
        id,
        name,
        formula,
        direction: metric.direction === 'asc' ? 'asc' : 'desc',
        digits: Number.isInteger(digits) ? Math.max(0, Math.min(MAX_DIGITS, digits)) : 2,
      })
    }
  }
  return {
    id: asText(item.id) || `config-${Date.now()}`,
    name: asText(item.name) || '未命名排行',
    configVersion: RANK_CONFIG_VERSION,
    languageVersion: Number(item.languageVersion) || RANK_LANGUAGE_VERSION,
    fieldSchemaVersion: Number(item.fieldSchemaVersion) || RANK_SCHEMA_VERSION,
    metrics,
    defaultSortMetricId: normalizeDefaultSortMetricId(item.defaultSortMetricId, metrics),
    filter: normalizeFilter((item.filter ?? {}) as Partial<RankFilter>),
    updatedAt: Number(item.updatedAt) || Date.now(),
  }
}

export function compileConfig(raw: RankConfig): CompiledConfig {
  const config = validateConfig(raw)
  const metrics: CompiledMetric[] = config.metrics.map((metric) => ({
    ...metric,
    compiled: compileFormula(metric.formula),
  }))
  // 聚合签名只含公式、指标集合与筛选；列顺序、默认排序、方向、精度和名称不改变聚合值。
  const key = JSON.stringify({
    metrics: config.metrics
      .map((metric) => [metric.id, metric.formula])
      .sort((left, right) => left[0]!.localeCompare(right[0]!)),
    filter: config.filter,
  })
  return { config, metrics, filter: config.filter, cacheKey: key }
}

export function createDefaultConfig(): RankConfig {
  return JSON.parse(JSON.stringify(DEFAULT_RANK_CONFIG)) as RankConfig
}

export interface ImportedConfigDraft {
  config: RankConfig
  warnings: string[]
}

/** 导入只解析和校验，不保存、不联网；返回的配置作为页面草稿。 */
export function importConfig(text: string): ImportedConfigDraft {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ConfigError('文件不是有效 JSON')
  }
  if (!parsed || typeof parsed !== 'object') throw new ConfigError('配置格式不正确')
  const item = parsed as Record<string, unknown>
  if (item.format !== RANK_CONFIG_FORMAT) {
    throw new ConfigError('不是元神助手排行榜配置文件')
  }
  const version = Number(item.version)
  if (version !== RANK_CONFIG_VERSION && version !== RANK_CONFIG_LEGACY_VERSION) {
    throw new ConfigError(`不支持的配置文件版本：${String(item.version)}`)
  }
  const config = validateConfig(item.config)
  const warnings: string[] = []
  if (version === RANK_CONFIG_LEGACY_VERSION) {
    warnings.push('旧版多指标优先级配置已迁移：默认按原第一项指标排序，列顺序不再破同分')
  }
  if (config.languageVersion !== RANK_LANGUAGE_VERSION) warnings.push('公式语言版本与当前版本不同，请核对公式')
  if (config.fieldSchemaVersion !== 1) warnings.push('字段 Schema 版本与当前版本不同，请核对字段含义')
  return { config, warnings }
}

export function exportConfig(config: RankConfig): string {
  return JSON.stringify(
    {
      format: RANK_CONFIG_FORMAT,
      version: RANK_CONFIG_VERSION,
      config,
    },
    null,
    2,
  )
}

/**
 * 生成不会再被复用的指标 ID。reservedIds 用于避开当前已计算结果中的旧指标，
 * 即使该指标已从配置删除，新建列也不能命中它的旧数值。
 */
export function newMetricId(
  existing: RankMetric[],
  reservedIds: readonly string[] = [],
): string {
  const used = new Set([...existing.map((metric) => metric.id), ...reservedIds])
  let id = ''
  do {
    id = `metric-${nextMetricIdSuffix()}`
  } while (used.has(id))
  return id
}
