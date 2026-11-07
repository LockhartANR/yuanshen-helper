import { AUTHOR_HOME_URL } from '../../../shared/constants'
import { el, externalLink } from '../../../shared/ui'
import { DEFAULT_ANALYSIS_SETTINGS } from '../analysis-settings'
import type { AnalysisSettings } from '../analysis-settings'
import { LEVEL_LABELS, LEVELS } from '../model'
import type { Level } from '../model'
import { anchorKey } from '../ratings'
import type { LsfMetric } from '../ratings'

export type BasicSettingKey = 'rankLimit' | 'monthTop' | 'yearTop' | 'smallTop' | 'subTiers'
export type ScoreFieldKey =
  | 'levelWeights'
  | 't37Slots'
  | 't37Pads'
  | 'bvFloors'
  | 'pppConsts'
export type DogTargetLevel = 'e' | 'i'

/** 参数面板只转发已校验的输入；保存、重绘与锚点请求由调用方处理。 */
export interface SettingsPanelHandlers {
  onBasicChange(key: BasicSettingKey, value: number): void
  onAnchorChange(key: string, value: number): void
  onUseWorkbook(): void
  onUseSite(): void
  onWeightChange(level: Level, metric: LsfMetric, value: number): void
  onScoreFieldChange(field: ScoreFieldKey, level: Level, value: number): void
  onColorThresholdsChange(values: number[]): void
  onDogTargetsChange(level: DogTargetLevel, value: string): void
  onReset(): void
}

export interface SettingsPanel {
  root: HTMLElement
  /** 设置对象被外部整体替换（恢复默认、锚点更新）后回填全部输入。 */
  refresh(): void
  /** 只回填锚点输入，避免异步返回时覆盖其他正在编辑的字段。 */
  refreshAnchors(): void
  setAnchorStatus(text: string): void
  destroy(): void
}

export interface SettingsPanelOptions {
  /** 参数面板只读取当前设置，不直接写 localStorage 或发起请求。 */
  getSettings: () => AnalysisSettings
  handlers: SettingsPanelHandlers
}

const BASIC_FIELDS: Array<[BasicSettingKey, string, number, number]> = [
  ['rankLimit', '榜单 Top', 10, 200],
  ['monthTop', '月 Top', 1, 50],
  ['yearTop', '年 Top', 1, 50],
  ['smallTop', '效率 / 杂项 Top', 1, 20],
  ['subTiers', 'Sub 档数', 5, 20],
]

const METRIC_LABELS: Array<[LsfMetric, string]> = [
  ['t', '用时'],
  ['b', '3BVS'],
  ['s', 'STNB'],
]

interface ScoreFieldSpec {
  key: ScoreFieldKey
  min: number
  max: number
  /** ppp 常数保留小数，其余按整数保存。 */
  round?: boolean
}

const SCORE_FIELDS: readonly ScoreFieldSpec[] = [
  { key: 'levelWeights', min: 0, max: 100 },
  { key: 't37Slots', min: 1, max: 50 },
  { key: 't37Pads', min: 1, max: 999 },
  { key: 'bvFloors', min: 1, max: 300 },
  { key: 'pppConsts', min: 0.000001, max: 10000, round: false },
]

export function createSettingsPanel(options: SettingsPanelOptions): SettingsPanel {
  const { getSettings, handlers } = options
  const root = el('section', 'analysis-settings hidden')

  const sourceNote = el('p', 'muted settings-source', '默认参数为大表 57.8 · ')
  sourceNote.append(externalLink('原作者主页', AUTHOR_HOME_URL))
  root.append(sourceNote)

  const basicInputs = new Map<BasicSettingKey, HTMLInputElement>()
  for (const [key, label, min, max] of BASIC_FIELDS) {
    const field = el('label', 'setting-field')
    const input = el('input', 'setting-input')
    input.type = 'number'
    input.min = String(min)
    input.max = String(max)
    input.value = String(getSettings()[key])
    input.addEventListener('change', () => {
      const value = Number(input.value)
      if (!Number.isFinite(value)) {
        input.value = String(getSettings()[key])
        return
      }
      const normalized = Math.min(max, Math.max(min, Math.round(value)))
      input.value = String(normalized)
      handlers.onBasicChange(key, normalized)
    })
    basicInputs.set(key, input)
    field.append(el('span', 'filter-label', label), input)
    root.append(field)
  }

  const anchorBlock = el('details', 'settings-advanced')
  anchorBlock.append(el('summary', undefined, '锚点'))
  const anchorActions = el('div', 'setting-fields')
  const anchorStatus = el('span', 'source-note', '')
  const useWorkbook = el('button', 'button', '使用大表锚点')
  useWorkbook.type = 'button'
  useWorkbook.addEventListener('click', () => handlers.onUseWorkbook())
  const useSite = el('button', 'button', '读取并使用网站锚点')
  useSite.type = 'button'
  useSite.addEventListener('click', () => handlers.onUseSite())
  anchorActions.append(useWorkbook, useSite, anchorStatus)
  anchorBlock.append(anchorActions)

  const anchorTable = el('table', 'settings-table')
  const anchorHead = el('tr')
  anchorHead.append(
    el('th', undefined, '项目'),
    el('th', undefined, '锚点'),
    el('th', undefined, 'NF锚点'),
  )
  anchorTable.append(anchorHead)
  const anchorInputs: Array<{ key: string; input: HTMLInputElement }> = []
  for (const level of LEVELS) {
    for (const [metric, metricLabel] of METRIC_LABELS) {
      const row = el('tr')
      row.append(el('th', undefined, `${LEVEL_LABELS[level]} · ${metricLabel}`))
      for (const mode of ['std', 'nf'] as const) {
        const cell = el('td')
        const input = el('input', 'setting-input')
        input.type = 'number'
        input.step = 'any'
        const key = anchorKey(mode, level, metric)
        input.value = String(getSettings().anchors[key])
        input.addEventListener('change', () => {
          const value = Number(input.value)
          if (!Number.isFinite(value) || value <= 0) {
            input.value = String(getSettings().anchors[key])
            return
          }
          handlers.onAnchorChange(key, value)
        })
        anchorInputs.push({ key, input })
        cell.append(input)
        row.append(cell)
      }
      anchorTable.append(row)
    }
  }
  anchorBlock.append(anchorTable)

  const weightInputs: Array<{ input: HTMLInputElement; level: Level; metric: LsfMetric }> = []
  const scoreInputs: Array<{
    input: HTMLInputElement
    key: ScoreFieldKey
    level: Level
  }> = []
  const weightsBlock = el('details', 'settings-advanced')
  weightsBlock.append(el('summary', undefined, '权重 / T37 / 3BV'))

  const weightTable = el('table', 'settings-table')
  const weightHead = el('tr')
  weightHead.append(
    el('th', undefined, '项目'),
    el('th', undefined, '用时'),
    el('th', undefined, '3BVS'),
    el('th', undefined, 'STNB'),
  )
  weightTable.append(weightHead)
  for (const level of LEVELS) {
    const row = el('tr')
    row.append(el('th', undefined, LEVEL_LABELS[level]))
    for (const metric of ['t', 'b', 's'] as const) {
      const input = el('input', 'setting-input')
      input.type = 'number'
      input.min = '0'
      input.max = '100'
      input.value = String(getSettings().softWeights[level][metric])
      input.addEventListener('change', () => {
        const value = Number(input.value)
        if (!Number.isFinite(value) || value < 0 || value > 100) {
          input.value = String(getSettings().softWeights[level][metric])
          return
        }
        const normalized = Math.round(value)
        input.value = String(normalized)
        handlers.onWeightChange(level, metric, normalized)
      })
      weightInputs.push({ input, level, metric })
      const cell = el('td')
      cell.append(input)
      row.append(cell)
    }
    weightTable.append(row)
  }

  const t37Table = el('table', 'settings-table')
  const t37Head = el('tr')
  t37Head.append(
    el('th', undefined, '项目'),
    el('th', undefined, '综合权重'),
    el('th', undefined, 'T37 槽位'),
    el('th', undefined, '补位用时'),
    el('th', undefined, '3BV 下限'),
    el('th', undefined, 'PPP 常数'),
  )
  t37Table.append(t37Head)
  for (const level of LEVELS) {
    const row = el('tr')
    row.append(el('th', undefined, LEVEL_LABELS[level]))
    for (const field of SCORE_FIELDS) {
      const input = el('input', 'setting-input')
      input.type = 'number'
      input.min = String(field.min)
      input.max = String(field.max)
      if (field.round === false) input.step = 'any'
      input.value = String(getSettings()[field.key][level])
      input.addEventListener('change', () => {
        const value = Number(input.value)
        if (!Number.isFinite(value) || value < field.min || value > field.max) {
          input.value = String(getSettings()[field.key][level])
          return
        }
        const normalized = field.round === false ? value : Math.round(value)
        input.value = String(normalized)
        handlers.onScoreFieldChange(field.key, level, normalized)
      })
      scoreInputs.push({ input, key: field.key, level })
      const cell = el('td')
      cell.append(input)
      row.append(cell)
    }
    t37Table.append(row)
  }
  weightsBlock.append(weightTable, t37Table)

  const colorBlock = el('details', 'settings-advanced')
  colorBlock.append(el('summary', undefined, '色板阈值'))
  const colorInput = el('textarea', 'setting-input setting-input-wide')
  colorInput.rows = 3
  colorInput.value = getSettings().colorThresholds.join(', ')
  colorInput.addEventListener('change', () => {
    const values = colorInput.value
      .split(',')
      .map((item) => Number(item.trim()))
      .filter((item) => Number.isFinite(item) && item > 0)
    if (values.length !== DEFAULT_ANALYSIS_SETTINGS.colorThresholds.length) {
      colorInput.value = getSettings().colorThresholds.join(', ')
      return
    }
    handlers.onColorThresholdsChange(values)
  })
  colorBlock.append(
    el(
      'p',
      'muted',
      `29 档阈值，逗号分隔；从高到低对应色板，默认 ${DEFAULT_ANALYSIS_SETTINGS.colorThresholds.join(', ')}`,
    ),
    colorInput,
  )

  const advanced = el('details', 'settings-advanced')
  advanced.append(el('summary', undefined, '狗预测'))

  const dogEField = el('label', 'setting-field')
  const dogEInput = el('input', 'setting-input setting-input-wide')
  dogEInput.value = getSettings().dogTargetsE
  dogEInput.addEventListener('change', () => handlers.onDogTargetsChange('e', dogEInput.value))
  dogEField.append(el('span', 'filter-label', '高级狗预测目标'), dogEInput)

  const dogIField = el('label', 'setting-field')
  const dogIInput = el('input', 'setting-input setting-input-wide')
  dogIInput.value = getSettings().dogTargetsI
  dogIInput.addEventListener('change', () => handlers.onDogTargetsChange('i', dogIInput.value))
  dogIField.append(el('span', 'filter-label', '中级狗预测目标'), dogIInput)
  advanced.append(dogEField, dogIField)

  const resetSettings = el('button', 'button', '恢复默认')
  resetSettings.type = 'button'
  resetSettings.addEventListener('click', () => handlers.onReset())
  root.append(anchorBlock, weightsBlock, colorBlock, advanced, resetSettings)

  function refresh(): void {
    const settings = getSettings()
    for (const [key, input] of basicInputs) input.value = String(settings[key])
    for (const item of weightInputs) {
      item.input.value = String(settings.softWeights[item.level][item.metric])
    }
    for (const item of scoreInputs) item.input.value = String(settings[item.key][item.level])
    colorInput.value = settings.colorThresholds.join(', ')
    dogEInput.value = settings.dogTargetsE
    dogIInput.value = settings.dogTargetsI
    refreshAnchors()
  }

  function refreshAnchors(): void {
    const settings = getSettings()
    for (const item of anchorInputs) item.input.value = String(settings.anchors[item.key])
  }

  function setAnchorStatus(text: string): void {
    anchorStatus.textContent = text
  }

  function destroy(): void {
    root.replaceChildren()
    root.remove()
  }

  return { root, refresh, refreshAnchors, setAnchorStatus, destroy }
}
