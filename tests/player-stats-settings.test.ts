import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_ANALYSIS_SETTINGS,
  loadAnalysisSettings,
  parseDogTargets,
  saveAnalysisSettings,
} from '../src/features/player-stats/analysis-settings'

const storage = new Map<string, string>()

beforeEach(() => {
  storage.clear()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  })
})

describe('分析参数', () => {
  it('没有存档时用默认值', () => {
    const settings = loadAnalysisSettings()
    expect(settings).toEqual(DEFAULT_ANALYSIS_SETTINGS)
    expect(settings.anchorMode).toBe('workbook')
    expect(settings.anchors['std:bt']).toBe(1.355)
    expect(settings.anchors['nf:es']).toBe(125.7)
  })

  it('保存网站锚点与自定义值后读回', () => {
    saveAnalysisSettings({
      ...DEFAULT_ANALYSIS_SETTINGS,
      anchorMode: 'site',
      anchors: { ...DEFAULT_ANALYSIS_SETTINGS.anchors, 'std:bt': 2 },
    })
    const loaded = loadAnalysisSettings()
    expect(loaded.anchorMode).toBe('site')
    expect(loaded.anchors['std:bt']).toBe(2)
  })

  it('保存后读回，并把越界值夹到范围内', () => {
    saveAnalysisSettings({
      ...DEFAULT_ANALYSIS_SETTINGS,
      rankLimit: 999,
      monthTop: 0,
      yearTop: 20,
      smallTop: 8,
      subTiers: 2,
      softWeights: { ...DEFAULT_ANALYSIS_SETTINGS.softWeights, b: { t: -1, b: 48, s: 20 } },
      levelWeights: { ...DEFAULT_ANALYSIS_SETTINGS.levelWeights, b: 999 },
      t37Slots: { ...DEFAULT_ANALYSIS_SETTINGS.t37Slots, b: 0 },
      t37Pads: { ...DEFAULT_ANALYSIS_SETTINGS.t37Pads, e: 9999 },
      bvFloors: { ...DEFAULT_ANALYSIS_SETTINGS.bvFloors, e: 999 },
    })
    const loaded = loadAnalysisSettings()
    expect(loaded.rankLimit).toBe(200)
    expect(loaded.monthTop).toBe(1)
    expect(loaded.yearTop).toBe(20)
    expect(loaded.smallTop).toBe(8)
    expect(loaded.subTiers).toBe(5)
    expect(loaded.softWeights.b.t).toBe(0)
    expect(loaded.levelWeights.b).toBe(100)
    expect(loaded.t37Slots.b).toBe(1)
    expect(loaded.t37Pads.e).toBe(999)
    expect(loaded.bvFloors.e).toBe(300)
  })

  it('狗预测目标按逗号解析并丢掉非法值', () => {
    expect(parseDogTargets('35, 30,26')).toEqual([35, 30, 26])
    expect(parseDogTargets('30,abc,-1,0,25')).toEqual([30, 25])
  })

  it('色板阈值只接受 29 个值，PPP 常数必须为正', () => {
    saveAnalysisSettings({
      ...DEFAULT_ANALYSIS_SETTINGS,
      colorThresholds: DEFAULT_ANALYSIS_SETTINGS.colorThresholds.map((value, index) =>
        index === 0 ? 1 : value,
      ),
      pppConsts: { ...DEFAULT_ANALYSIS_SETTINGS.pppConsts, e: 0 },
    })
    const loaded = loadAnalysisSettings()
    expect(loaded.colorThresholds).toHaveLength(29)
    expect(loaded.colorThresholds[0]).toBe(1)
    expect(loaded.pppConsts.e).toBe(DEFAULT_ANALYSIS_SETTINGS.pppConsts.e)

    saveAnalysisSettings({ ...DEFAULT_ANALYSIS_SETTINGS, colorThresholds: [1, 2] })
    expect(loadAnalysisSettings().colorThresholds).toHaveLength(29)
  })

  it('旧存档缺少复制字段时补为空数组', () => {
    storage.set('analysisSettings', JSON.stringify({ rankLimit: 77 }))
    const loaded = loadAnalysisSettings()
    expect(loaded.rankLimit).toBe(77)
    expect(loaded.monthCopyFields).toEqual([])
    expect(loaded.yearCopyFields).toEqual([])
  })

  it('月均与年汇总复制选项独立保存', () => {
    saveAnalysisSettings({
      ...DEFAULT_ANALYSIS_SETTINGS,
      monthCopyFields: ['op', 'medianTime'],
      yearCopyFields: ['mov'],
    })
    const loaded = loadAnalysisSettings()
    expect(loaded.monthCopyFields).toEqual(['medianTime', 'op'])
    expect(loaded.yearCopyFields).toEqual(['mov'])

    saveAnalysisSettings({ ...loaded, monthCopyFields: ['cls'], yearCopyFields: [] })
    const next = loadAnalysisSettings()
    expect(next.monthCopyFields).toEqual(['cls'])
    expect(next.yearCopyFields).toEqual([])
  })

  it('复制选项过滤非法值、重复项归一化，显式空数组保留', () => {
    storage.set(
      'analysisSettings',
      JSON.stringify({
        monthCopyFields: ['op', 'op', 'nope', 3, null, 'medianTime', 'cls'],
        yearCopyFields: ['mov', 'mov', 'bad', 'cls'],
      }),
    )
    const loaded = loadAnalysisSettings()
    expect(loaded.monthCopyFields).toEqual(['medianTime', 'op', 'cls'])
    expect(loaded.yearCopyFields).toEqual(['cls', 'mov'])

    saveAnalysisSettings({ ...DEFAULT_ANALYSIS_SETTINGS, monthCopyFields: [], yearCopyFields: [] })
    const empty = loadAnalysisSettings()
    expect(empty.monthCopyFields).toEqual([])
    expect(empty.yearCopyFields).toEqual([])

    storage.set('analysisSettings', JSON.stringify({ monthCopyFields: 'op', yearCopyFields: 1 }))
    const invalid = loadAnalysisSettings()
    expect(invalid.monthCopyFields).toEqual([])
    expect(invalid.yearCopyFields).toEqual([])
  })

})
