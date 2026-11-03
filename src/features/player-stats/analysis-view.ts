import { SITE_ORIGIN } from '../../shared/constants'
import { formatCount, formatShortDate } from '../../shared/format'
import { el } from '../../shared/ui'
import {
  activeDays,
  activityCalendar,
  analyzeGames,
  applyBvFloors,
  bucketStats,
  dogPredictions,
  efficiencyTop,
  frontier,
  gcStats,
  heatmapStats,
  monthStats,
  MONTH_BVS_TIERS,
  MONTH_TIME_TIERS,
  othTop,
  periodGroups,
  rangeStats,
  rankGames,
  recentPb,
  subStats,
  summarize,
  todayCopyText,
  todayStats,
  weekStats,
  yearStats,
} from './analysis'
import { configureColors, dateColorStyle, medianOf, numColorStyle, pbColorStyle } from './colors'
import {
  DEFAULT_ANALYSIS_SETTINGS,
  loadAnalysisSettings,
  parseDogTargets,
  saveAnalysisSettings,
} from './analysis-settings'
import type { AnalysisGame, EfficiencyMetric, OthMetric, PeriodMode } from './analysis'
import { fetchLsfAnchors } from './lsf-anchors'
import { anchorKey, WORKBOOK_ANCHORS } from './ratings'
import type { LsfMetric, LsfMode } from './ratings'
import type { Level, Video } from './model'
import { LEVELS, STNB_COEFFICIENT } from './model'
import { ratingSnapshot } from './ratings'

const LEVEL_LABELS: Record<Level, string> = { b: '初级', i: '中级', e: '高级' }
const STAT_LABELS = { time: '用时', bvs: '3BVS', stnb: 'STNB' } as const

function authorHomeLink(): HTMLAnchorElement {
  const link = document.createElement('a')
  link.href = 'https://openms.top/#/player/48'
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  link.textContent = '原作者主页'
  return link
}

type NavKey = 'overview' | 'rank' | 'trend' | 'period' | 'dist' | 'eff' | 'map'
type RankStat = keyof typeof STAT_LABELS
type RankLayout = 'single' | 'triple'

const NAV_ITEMS: Array<[NavKey, string]> = [
  ['overview', '概览'],
  ['rank', '榜单'],
  ['trend', '趋势'],
  ['period', '月年'],
  ['dist', '分布'],
  ['eff', '效率'],
  ['map', '地图'],
]

const SOFTWARE_OPTIONS: Array<[string, string]> = [
  ['all', '全部软件'],
  ['e', 'evf'],
  ['a', 'avf'],
  ['m', 'mvf'],
  ['r', 'rmv'],
]

const DAY_MS = 86_400_000

function formatTime(seconds: number): string {
  return seconds.toFixed(3)
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const area = document.createElement('textarea')
    try {
      area.value = text
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.append(area)
      area.select()
      return document.execCommand('copy')
    } catch {
      return false
    } finally {
      area.remove()
    }
  }
}

function videoLink(game: AnalysisGame, text: string, className = ''): string {
  if (game.video.id <= 0) return `<span class="${className}">${text}</span>`
  const href = `${SITE_ORIGIN}/#/video/${game.video.id}`
  return `<a class="${className}" href="${href}" target="_blank" rel="noreferrer">${text}</a>`
}

function rowClass(index: number): string {
  if (index === 0) return ' class="top1"'
  if (index < 3) return ' class="top3"'
  return ''
}

function colorAttr(level: Level, stat: 'time' | 'bvs' | 'stnb', value: number): string {
  const style = pbColorStyle(level, stat, value)
  return style
    ? ` style="background:${style.backgroundColor};color:${style.color}"`
    : ''
}

function numColorAttr(value: number, factor = 1): string {
  const style = numColorStyle(value, factor)
  return style
    ? ` style="background:${style.backgroundColor};color:${style.color}"`
    : ''
}

const dateStatsCache = new WeakMap<number[], { min: number; mid: number; max: number }>()

function dateAttr(value: number, dates: number[]): string {
  let stats = dateStatsCache.get(dates)
  if (!stats) {
    const sorted = dates.filter((item) => item > 0).sort((a, b) => a - b)
    stats =
      sorted.length < 2
        ? { min: 0, mid: 0, max: 0 }
        : {
            min: sorted[0] as number,
            mid: medianOf(sorted),
            max: sorted[sorted.length - 1] as number,
          }
    dateStatsCache.set(dates, stats)
  }
  if (stats.max <= stats.min) return ''
  const style = dateColorStyle(value, stats.min, stats.mid, stats.max)
  return style
    ? ` style="background:${style.backgroundColor};color:${style.color}"`
    : ''
}

export interface AnalysisViewOptions {
  /** 启动时若保存的是网站锚点，是否自动读取网站；独立 CSV 传 false 以免联网。 */
  autoSiteAnchors?: boolean
}

export interface AnalysisView {
  root: HTMLElement
  update(videos: Video[], options?: { csv?: boolean }): void
  /** 销毁视图：使进行中的锚点请求失效并移除节点。 */
  destroy(): void
}

export function createAnalysisView(options: AnalysisViewOptions = {}): AnalysisView {
  const state = {
    nav: 'overview' as NavKey,
    range: 0,
    software: 'all',
    rankStat: 'time' as RankStat,
    rankLevel: 'b' as Level,
    rankLayout: 'single' as RankLayout,
    nfOnly: false,
    trendLevel: 'e' as Level,
    hideEmptyMonths: false,
    distLevel: 'b' as Level,
    effLevel: 'b' as Level,
    periodMode: 'month' as PeriodMode,
    periodLevel: 'e' as Level,
    periodStat: 'time' as RankStat,
    periodKey: '',
    mapLevel: 'e' as Level,
  }

  let videos: Video[] = []
  let games: AnalysisGame[] = []
  let rangeGames: AnalysisGame[] = []
  let ratingGames: AnalysisGame[] = []
  let todaySnapshot: ReturnType<typeof todayStats> = []
  let now = Date.now()
  const settings = loadAnalysisSettings()
  configureColors(settings.colorThresholds)
  let anchorError = false
  let anchorRequest = 0
  let csvMode = false
  const floorLabel = (): string =>
    `${settings.bvFloors.b}/${settings.bvFloors.i}/${settings.bvFloors.e}`

  const root = el('section', 'analysis-pane')

  const filters = el('section', 'player-filters')
  const rangeSelect = el('select', 'select')
  for (const [value, label] of [
    ['0', '全部'],
    ['365', '近一年'],
    ['90', '近 90 天'],
  ] as const) {
    const option = el('option', undefined, label)
    option.value = value
    rangeSelect.append(option)
  }
  const softwareSelect = el('select', 'select')
  for (const [value, label] of SOFTWARE_OPTIONS) {
    const option = el('option', undefined, label)
    option.value = value
    softwareSelect.append(option)
  }

  const rangeField = el('label', 'filter')
  rangeField.append(el('span', 'filter-label', '时间'), rangeSelect)
  const softwareField = el('label', 'filter')
  softwareField.append(el('span', 'filter-label', '软件'), softwareSelect)
  const countNote = el('span', 'source-note')
  const nfField = el('label', 'check')
  const nfInput = el('input')
  nfInput.type = 'checkbox'
  nfInput.id = 'analysis-nf-global'
  nfInput.checked = state.nfOnly
  nfField.append(nfInput, document.createTextNode(' 只看 NF'))
  const settingsButton = el('button', 'button', '参数')
  settingsButton.type = 'button'
  filters.append(rangeField, softwareField, nfField, countNote, settingsButton)

  const settingsPanel = el('section', 'analysis-settings hidden')
  const sourceNote = el('p', 'muted settings-source', '默认参数为大表 57.8 · ')
  sourceNote.append(authorHomeLink())
  settingsPanel.append(sourceNote)
  type BasicKey = 'rankLimit' | 'monthTop' | 'yearTop' | 'smallTop' | 'subTiers'
  const settingFields: Array<[BasicKey, string, number, number]> = [
    ['rankLimit', '榜单 Top', 10, 200],
    ['monthTop', '月 Top', 1, 50],
    ['yearTop', '年 Top', 1, 50],
    ['smallTop', '效率 / 杂项 Top', 1, 20],
    ['subTiers', 'Sub 档数', 5, 20],
  ]
  const settingInputs = new Map<BasicKey, HTMLInputElement>()
  for (const [key, label, min, max] of settingFields) {
    const field = el('label', 'setting-field')
    const input = el('input', 'setting-input')
    input.type = 'number'
    input.min = String(min)
    input.max = String(max)
    input.value = String(settings[key])
    input.addEventListener('change', () => {
      const value = Number(input.value)
      if (!Number.isFinite(value)) {
        input.value = String(settings[key])
        return
      }
      settings[key] = Math.min(max, Math.max(min, Math.round(value)))
      input.value = String(settings[key])
      saveAnalysisSettings(settings)
      render()
    })
    settingInputs.set(key, input)
    field.append(el('span', 'filter-label', label), input)
    settingsPanel.append(field)
  }
  const anchorBlock = el('details', 'settings-advanced')
  anchorBlock.append(el('summary', undefined, '锚点'))
  const anchorActions = el('div', 'setting-fields')
  const anchorStatus = el('span', 'source-note', '')
  const useWorkbook = el('button', 'button', '使用大表锚点')
  useWorkbook.type = 'button'
  useWorkbook.addEventListener('click', () => {
    anchorRequest += 1
    Object.assign(settings.anchors, WORKBOOK_ANCHORS)
    settings.anchorMode = 'workbook'
    anchorError = false
    refreshAnchorInputs()
    anchorStatus.textContent = '已使用大表锚点'
    saveAnalysisSettings(settings)
    render()
  })
  const useSite = el('button', 'button', '读取并使用网站锚点')
  useSite.type = 'button'
  useSite.addEventListener('click', () => {
    void loadSiteAnchors(true).then((ok) => {
      if (!ok) return
      settings.anchorMode = 'site'
      saveAnalysisSettings(settings)
      render()
    })
  })
  anchorActions.append(useWorkbook, useSite, anchorStatus)
  anchorBlock.append(anchorActions)

  const anchorTable = el('table', 'settings-table')
  const anchorHead = el('tr')
  anchorHead.append(
    el('th', undefined, '项目'),
    el('th', undefined, '普通锚点'),
    el('th', undefined, 'NF 锚点'),
  )
  anchorTable.append(anchorHead)
  const anchorInputs: Array<{ mode: LsfMode; level: Level; metric: LsfMetric; input: HTMLInputElement }> = []
  const metricLabels: Array<[LsfMetric, string]> = [
    ['t', '用时'],
    ['b', '3BVS'],
    ['s', 'STNB'],
  ]
  for (const level of LEVELS) {
    for (const [metric, metricLabel] of metricLabels) {
      const row = el('tr')
      row.append(el('th', undefined, `${LEVEL_LABELS[level]} · ${metricLabel}`))
      for (const mode of ['std', 'nf'] as const) {
        const cell = el('td')
        const input = el('input', 'setting-input')
        input.type = 'number'
        input.step = 'any'
        const key = anchorKey(mode, level, metric)
        input.value = String(settings.anchors[key])
        input.addEventListener('change', () => {
          const value = Number(input.value)
          if (!Number.isFinite(value) || value <= 0) {
            input.value = String(settings.anchors[key])
            return
          }
          settings.anchors[key] = value
          settings.anchorMode = 'workbook'
          anchorRequest += 1
          anchorError = false
          saveAnalysisSettings(settings)
          render()
        })
        anchorInputs.push({ mode, level, metric, input })
        cell.append(input)
        row.append(cell)
      }
      anchorTable.append(row)
    }
  }
  anchorBlock.append(anchorTable)

  function refreshAnchorInputs(): void {
    for (const item of anchorInputs) {
      item.input.value = String(settings.anchors[anchorKey(item.mode, item.level, item.metric)])
    }
  }

  const weightInputs: Array<{ input: HTMLInputElement; value: () => number }> = []
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
      input.value = String(settings.softWeights[level][metric])
      input.addEventListener('change', () => {
        const value = Number(input.value)
        if (!Number.isFinite(value) || value < 0 || value > 100) {
          input.value = String(settings.softWeights[level][metric])
          return
        }
        settings.softWeights[level][metric] = Math.round(value)
        saveAnalysisSettings(settings)
        render()
      })
      weightInputs.push({ input, value: () => settings.softWeights[level][metric] })
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
    const fields: Array<{
      get: () => number
      set: (value: number) => void
      min: number
      max: number
      round?: boolean
      affectsGames?: boolean
    }> = [
      {
        get: () => settings.levelWeights[level],
        set: (value) => {
          settings.levelWeights[level] = value
        },
        min: 0,
        max: 100,
      },
      {
        get: () => settings.t37Slots[level],
        set: (value) => {
          settings.t37Slots[level] = value
        },
        min: 1,
        max: 50,
      },
      {
        get: () => settings.t37Pads[level],
        set: (value) => {
          settings.t37Pads[level] = value
        },
        min: 1,
        max: 999,
      },
      {
        get: () => settings.bvFloors[level],
        set: (value) => {
          settings.bvFloors[level] = value
        },
        min: 1,
        max: 300,
        affectsGames: true,
      },
      {
        get: () => settings.pppConsts[level],
        set: (value) => {
          settings.pppConsts[level] = value
        },
        min: 0.000001,
        max: 10000,
        round: false,
      },
    ]
    for (const field of fields) {
      const input = el('input', 'setting-input')
      input.type = 'number'
      input.min = String(field.min)
      input.max = String(field.max)
      if (field.round === false) input.step = 'any'
      input.value = String(field.get())
      input.addEventListener('change', () => {
        const value = Number(input.value)
        if (!Number.isFinite(value) || value < field.min || value > field.max) {
          input.value = String(field.get())
          return
        }
        field.set(field.round === false ? value : Math.round(value))
        saveAnalysisSettings(settings)
        if (field.affectsGames) applyFilters()
        render()
      })
      weightInputs.push({ input, value: field.get })
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
  colorInput.value = settings.colorThresholds.join(', ')
  colorInput.addEventListener('change', () => {
    const values = colorInput.value
      .split(',')
      .map((item) => Number(item.trim()))
      .filter((item) => Number.isFinite(item) && item > 0)
    if (values.length !== DEFAULT_ANALYSIS_SETTINGS.colorThresholds.length) {
      colorInput.value = settings.colorThresholds.join(', ')
      return
    }
    settings.colorThresholds = values
    configureColors(values)
    saveAnalysisSettings(settings)
    render()
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
  dogEInput.value = settings.dogTargetsE
  dogEInput.addEventListener('change', () => {
    settings.dogTargetsE = dogEInput.value
    saveAnalysisSettings(settings)
    render()
  })
  dogEField.append(el('span', 'filter-label', '高级狗预测目标'), dogEInput)

  const dogIField = el('label', 'setting-field')
  const dogIInput = el('input', 'setting-input setting-input-wide')
  dogIInput.value = settings.dogTargetsI
  dogIInput.addEventListener('change', () => {
    settings.dogTargetsI = dogIInput.value
    saveAnalysisSettings(settings)
    render()
  })
  dogIField.append(el('span', 'filter-label', '中级狗预测目标'), dogIInput)
  advanced.append(dogEField, dogIField)

  const resetSettings = el('button', 'button', '恢复默认')
  resetSettings.type = 'button'
  resetSettings.addEventListener('click', () => {
    anchorRequest += 1
    Object.assign(settings, JSON.parse(JSON.stringify(DEFAULT_ANALYSIS_SETTINGS)) as typeof settings)
    configureColors(settings.colorThresholds)
    for (const [key, input] of settingInputs) input.value = String(settings[key])
    for (const item of weightInputs) item.input.value = String(item.value())
    colorInput.value = settings.colorThresholds.join(', ')
    refreshAnchorInputs()
    anchorStatus.textContent = '已使用大表锚点'
    anchorError = false
    dogEInput.value = settings.dogTargetsE
    dogIInput.value = settings.dogTargetsI
    applyFilters()
    saveAnalysisSettings(settings)
    render()
  })
  settingsPanel.append(anchorBlock, weightsBlock, colorBlock, advanced, resetSettings)
  settingsButton.addEventListener('click', () => settingsPanel.classList.toggle('hidden'))

  const nav = el('nav', 'analysis-nav')
  const navButtons = new Map<NavKey, HTMLButtonElement>()
  for (const [key, label] of NAV_ITEMS) {
    const button = el('button', 'analysis-tab', label)
    button.type = 'button'
    button.dataset.nav = key
    navButtons.set(key, button)
    nav.append(button)
  }

  const viewHost = el('div', 'analysis-view')
  viewHost.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return
    const button = event.target.closest<HTMLButtonElement>('[data-copy-level]')
    if (!button) return
    const level = button.dataset.copyLevel
    const row = todaySnapshot.find((item) => item.level === level)
    if (!row) return
    void copyText(todayCopyText(row)).then((ok) => {
      button.textContent = ok ? '已复制' : '复制失败'
      button.classList.toggle('copied', ok)
      window.setTimeout(() => {
        button.textContent = '复制'
        button.classList.remove('copied')
      }, 1200)
    })
  })
  const note = el(
    'p',
    'analysis-note',
    '赛博大表只统计模式 00 的已审核录像，3BV 下限默认 10 / 30 / 100；网站 NF 按右键 = 0，CSV 按 style=NF。',
  )
  const credit = el('p', 'analysis-note', '统计方式来自大表 ArbiterStatsAuto · ')
  credit.append(authorHomeLink())

  root.append(filters, settingsPanel, nav, viewHost, note, credit)

  function applyFilters(): void {
    const filtered = analyzeGames(
      videos,
      { software: csvMode ? 'all' : state.software, nfOnly: state.nfOnly },
      1,
    )
    games = applyBvFloors(filtered, settings.bvFloors)
    // 月年局数与 rAvg 保留 2–9，但不再套用各级 3BV 下限。
    rangeGames = filtered.filter((game) => game.bv >= 2)
    if (state.range > 0) {
      const cutoff = now - state.range * DAY_MS
      games = games.filter((game) => game.date >= cutoff)
      rangeGames = rangeGames.filter((game) => game.date >= cutoff)
    }
    countNote.textContent = `计入 ${formatCount(games.length)} 局${state.nfOnly ? ' · NF' : ''}`
  }

  function renderNav(): void {
    for (const [key, button] of navButtons) {
      button.classList.toggle('active', state.nav === key)
      button.setAttribute('aria-pressed', String(state.nav === key))
    }
  }

  function render(): void {
    renderNav()
    if (state.nav === 'overview') {
      viewHost.innerHTML = overviewHtml()
    } else if (state.nav === 'rank') {
      viewHost.innerHTML = rankHtml()
    } else if (state.nav === 'trend') {
      viewHost.innerHTML = trendHtml()
    } else if (state.nav === 'period') {
      viewHost.innerHTML = periodHtml()
    } else if (state.nav === 'dist') {
      viewHost.innerHTML = distHtml()
    } else if (state.nav === 'eff') {
      viewHost.innerHTML = effHtml()
    } else {
      viewHost.innerHTML = mapHtml()
    }
  }

  function overviewHtml(): string {
    const recent = recentPb(games, now, 30, 8)
    const recentCount = games.filter(
      (game) =>
        game.pb &&
        game.pbPrev !== null &&
        game.date >= now - 30 * DAY_MS &&
        game.date <= now,
    ).length
    const weeks = weekStats(
      games,
      10,
      now,
      true,
      settings.t37Slots,
      settings.t37Pads,
      settings.pppConsts,
    )
    const lastWeek = weeks[weeks.length - 1]
    const days = activeDays(games, now, 30)
    const summary = summarize(games, now)
    const today = todayStats(ratingGames, now)
    todaySnapshot = today
    const rating = ratingSnapshot(
      ratingGames,
      settings.anchors,
      settings.softWeights,
      settings.levelWeights,
      settings.bvFloors,
    )
    const gc = gcStats(rangeGames)
    const gcRows = gc
      .map(
        (item) =>
          '<tr>' +
          `<td>${LEVEL_LABELS[item.level]}</td>` +
          `<td class="num">${item.asb.toFixed(3)}</td>` +
          `<td class="num">${item.power.toFixed(3)}</td>` +
          `<td class="num">${item.typicalTime.toFixed(3)}</td>` +
          '</tr>',
      )
      .join('')
    const gcTotal = gc.reduce(
      (sum, item) => ({
        asb: sum.asb + item.asb,
        power: sum.power + item.power,
        typicalTime: sum.typicalTime + item.typicalTime,
      }),
      { asb: 0, power: 0, typicalTime: 0 },
    )
    const gcTotalRow =
      '<tr class="gc-total">' +
      '<td>合计</td>' +
      `<td class="num">${gcTotal.asb.toFixed(3)}</td>` +
      `<td class="num">${gcTotal.power.toFixed(3)}</td>` +
      `<td class="num">${gcTotal.typicalTime.toFixed(3)}</td>` +
      '</tr>'
    const gcSegmentRows = gc
      .flatMap((item) =>
        item.segments.map(
          (segment) =>
            '<tr>' +
            `<td>${LEVEL_LABELS[item.level]}</td>` +
            `<td class="num">${segment.start}–${segment.end}</td>` +
            `<td class="num">${formatCount(segment.count)}</td>` +
            `<td class="num">${segment.power > 0 ? segment.power.toFixed(4) : '—'}</td>` +
            `<td class="num">${segment.bv > 0 ? segment.bv.toFixed(3) : '—'}</td>` +
            `<td class="num">${segment.time > 0 ? segment.time.toFixed(3) : '—'}</td>` +
            '</tr>',
        ),
      )
      .join('')
    const calendar = activityCalendar(games, now)

    const summaryRows = summary
      .map((row) => {
        const pb = row.pb
        return (
          '<tr>' +
          `<td><span class="lv"><i></i>${LEVEL_LABELS[row.level]}</span></td>` +
          `<td class="num">${formatCount(row.count)}</td>` +
          `<td class="num"${pb ? colorAttr(row.level, 'time', pb.time) : ''}>${pb ? formatTime(pb.time) : '—'}</td>` +
          `<td class="num">${pb ? pb.bv : '—'}</td>` +
          `<td class="num"${pb ? colorAttr(row.level, 'bvs', pb.bvs) : ''}>${pb ? pb.bvs.toFixed(3) : '—'}</td>` +
          `<td class="num"${colorAttr(row.level, 'bvs', row.top5Bvs)}>${row.top5Bvs.toFixed(3)}</td>` +
          `<td class="num">${(row.nfRatio * 100).toFixed(0)}%</td>` +
          `<td class="num">${row.last30}</td>` +
          '</tr>'
        )
      })
      .join('')

    const recentRows = recent
      .map(({ game, prev }) => {
        const delta = prev - game.time
        const hot = now - game.date <= 7 * DAY_MS
        return (
          `<tr${hot ? ' class="hot"' : ''}>` +
          `<td class="date"${dateAttr(game.date, recent.map((item) => item.game.date))}>${formatShortDate(game.date)}</td>` +
          `<td>${LEVEL_LABELS[game.level]}</td>` +
          `<td class="num">${game.bv}</td>` +
          `<td class="num"${colorAttr(game.level, 'time', game.time)}>${formatTime(game.time)}</td>` +
          `<td class="num"${colorAttr(game.level, 'bvs', game.bvs)}>${game.bvs.toFixed(3)}</td>` +
          `<td class="num"${colorAttr(game.level, 'stnb', game.stnb)}>${game.stnb.toFixed(1)}</td>` +
          `<td class="num">${formatTime(prev)}</td>` +
          `<td class="num delta-up">−${delta.toFixed(3)}</td>` +
          `<td>${videoLink(game, '录像')}</td>` +
          '</tr>'
        )
      })
      .join('')

    const todayRows = today
      .map((row) => {
        const bestTime = row.bestTime
          ? `${formatTime(row.bestTime.time)}/${row.bestTime.bv}`
          : '—'
        const bestBvs = row.bestBvs ? `${row.bestBvs.bvs.toFixed(3)}/${row.bestBvs.bv}` : '—'
        const bestStnb = row.bestStnb ? `${row.bestStnb.stnb.toFixed(1)}/${row.bestStnb.bv}` : '—'
        return (
          '<tr>' +
          `<td><span class="lv"><i></i>${LEVEL_LABELS[row.level]}</span></td>` +
          `<td class="num">${row.count}（${row.fl}FL/${row.nf}NF）</td>` +
          `<td class="num"${row.bestTime ? colorAttr(row.level, 'time', row.bestTime.time) : ''}>${bestTime}</td>` +
          `<td class="num"${row.bestBvs ? colorAttr(row.level, 'bvs', row.bestBvs.bvs) : ''}>${bestBvs}</td>` +
          `<td class="num"${row.bestStnb ? colorAttr(row.level, 'stnb', row.bestStnb.stnb) : ''}>${bestStnb}</td>` +
          `<td class="num"${row.count > 0 ? colorAttr(row.level, 'time', row.avgTime) : ''}>${row.count > 0 ? formatTime(row.avgTime) : '—'}</td>` +
          `<td class="num"${row.count > 0 ? colorAttr(row.level, 'bvs', row.avgBvs) : ''}>${row.count > 0 ? row.avgBvs.toFixed(3) : '—'}</td>` +
          `<td class="num"${row.count > 0 ? colorAttr(row.level, 'stnb', row.avgStnb) : ''}>${row.count > 0 ? row.avgStnb.toFixed(1) : '—'}</td>` +
          `<td class="num">${row.count > 0 ? row.avgBv.toFixed(1) : '—'}</td>` +
          `<td class="copy-cell"><button type="button" class="copy-today" data-copy-level="${row.level}" aria-label="复制今日${LEVEL_LABELS[row.level]}数据" title="复制今日${LEVEL_LABELS[row.level]}数据">复制</button></td>` +
          '</tr>'
        )
      })
      .join('')

    return (
      '<div class="kpi-grid">' +
      '<div class="kpi rank-card"><span>定阶</span>' +
      `<b class="rank-title">${rating.title}</b>` +
      `<div class="progress"><i style="width:${Math.max(0, Math.min(100, rating.progress * 10)).toFixed(0)}%"></i></div>` +
      `<small>综合软实力 ${rating.soft.toFixed(1)} · LSF ${rating.lsf.toFixed(2)}</small>` +
      `<small>初 ${rating.levels[0]?.soft.toFixed(1)} · 中 ${rating.levels[1]?.soft.toFixed(1)} · 高 ${rating.levels[2]?.soft.toFixed(1)} · ${settings.anchorMode === 'site' ? '网站' : '大表'}锚点</small>` +
      `${anchorError ? `<small class="anchor-error">锚点刷新失败，继续用已保存的${settings.anchorMode === 'site' ? '网站' : '大表'}锚点</small>` : ''}` +
      `<small>NF 初 ${rating.levels[0]?.nfSoft.toFixed(1)} · 中 ${rating.levels[1]?.nfSoft.toFixed(1)} · 高 ${rating.levels[2]?.nfSoft.toFixed(1)}</small>` +
      `<small>NF 定阶 ${rating.nfTitle}</small>` +
      '</div>' +
      '<div class="kpi"><span>近 30 天新 PB</span>' +
      `<b>${recentCount}</b>` +
      `<small>${recent[0] ? `最近一条 ${formatShortDate(recent[0].game.date)}` : '最近没有新 PB'}</small></div>` +
      '<div class="kpi"><span>本周 T37</span>' +
      `<b>${lastWeek && lastWeek.count > 0 ? lastWeek.t37.toFixed(1) : '—'}</b>` +
      `<small>${lastWeek && lastWeek.count > 0 ? `B37 ${lastWeek.b37.toFixed(1)} · S37 ${lastWeek.s37.toFixed(1)}` : '本周还没有成绩'}</small></div>` +
      '<div class="kpi"><span>近 30 天活跃</span>' +
      `<b>${days} 天</b>` +
      `<small>${games.filter((game) => game.date >= now - 30 * DAY_MS).length} 局</small></div>` +
      '</div>' +

      '<div class="card">' +
      '<div class="card-head"><h2 class="card-title">今日成绩</h2></div>' +
      '<div class="table-scroll"><table class="data-table summary-table today-table">' +
      '<thead><tr><th>难度</th><th class="num">总局数</th><th class="num">Best Time</th><th class="num">Best 3BVS</th><th class="num">Best STNB</th><th class="num">Avg Time</th><th class="num">Avg 3BVS</th><th class="num">Avg STNB</th><th class="num">Avg 3BV</th><th class="copy-cell"></th></tr></thead>' +
      `<tbody>${todayRows}</tbody>` +
      '</table></div>' +
      '</div>' +

      '<div class="card">' +
      '<div class="card-head"><h2 class="card-title">三难度摘要</h2><span class="muted">3BV ≥ ' + floorLabel() + '</span></div>' +
      '<table class="data-table summary-table">' +
      '<thead><tr><th>难度</th><th class="num">局数</th><th class="num">PB</th><th class="num">3BV</th><th class="num">PB 3BVS</th><th class="num">Top5 均速</th><th class="num">NF 占比</th><th class="num">近 30 天</th></tr></thead>' +
      `<tbody>${summaryRows}</tbody>` +
      '</table>' +
      '</div>' +

      '<div class="card">' +
      '<div class="card-head"><h2 class="card-title">GC 指标</h2><span class="muted">ASB / 战力 / 典型时</span></div>' +
      '<table class="data-table">' +
      '<thead><tr><th>难度</th><th class="num">ASB 和</th><th class="num">战力</th><th class="num">典型时</th></tr></thead>' +
      `<tbody>${gcRows}${gcTotalRow}</tbody>` +
      '</table>' +
      '<details class="settings-advanced gc-bins"><summary>GC 分段明细</summary>' +
      '<div class="table-scroll"><table class="data-table">' +
      '<thead><tr><th>难度</th><th class="num">分段</th><th class="num">局数</th><th class="num">分段战力</th><th class="num">分段典型3BV</th><th class="num">分段典型时</th></tr></thead>' +
      `<tbody>${gcSegmentRows || '<tr><td colspan="6" class="muted">没有数据</td></tr>'}</tbody>` +
      '</table></div></details>' +
      '</div>' +

      '<div class="card">' +
      '<div class="card-head"><h2 class="card-title">活跃日历</h2><span class="muted">最近 12 周 · 深色表示局数多</span></div>' +
      '<div class="calendar-layout">' +
      '<div class="calendar-side">' +
      '<div class="calendar-body">' +
      '<div class="calendar-weekdays">' +
      ['一', '二', '三', '四', '五', '六', '日'].map((day) => `<span>${day}</span>`).join('') +
      '</div>' +
      `<div class="calendar">${calendar.cells
        .map((cell) => {
          const alpha =
            cell.count === 0 ? 0 : 15 + Math.round((cell.count / Math.max(1, calendar.max)) * 85)
          const style =
            cell.count === 0
              ? ''
              : ` style="background:color-mix(in srgb, var(--accent) ${alpha}%, transparent)"`
          return `<span class="cal-cell"${style} title="${formatShortDate(cell.start)} · ${cell.count} 局"></span>`
        })
        .join('')}</div>` +
      '</div>' +
      '<div class="cal-legend"><span>少</span>' +
      [15, 40, 65, 90]
        .map(
          (alpha) =>
            `<i class="cal-cell" style="background:color-mix(in srgb, var(--accent) ${alpha}%, transparent)"></i>`,
        )
        .join('') +
      '<span>多</span></div>' +
      '</div>' +
      '<div class="calendar-stats">' +
      `<div class="cal-stat"><span>总对局</span><b>${formatCount(calendar.total)}</b></div>` +
      `<div class="cal-stat"><span>活跃天数</span><b>${calendar.activeDays}</b></div>` +
      `<div class="cal-stat"><span>活跃日均</span><b>${calendar.activeDays > 0 ? (calendar.total / calendar.activeDays).toFixed(1) : '—'}</b></div>` +
      `<div class="cal-stat"><span>最长连续</span><b>${calendar.longestStreak} 天</b></div>` +
      `<div class="cal-stat"><span>最活跃日</span><b>${calendar.best ? `${formatShortDate(calendar.best.start)} · ${calendar.best.count} 局` : '—'}</b></div>` +
      '</div>' +
      '</div>' +
      '</div>' +

      '<div class="card">' +
      `<div class="card-head"><h2 class="card-title">最近 PB</h2><span class="muted">30 天内 · 共 ${recentCount} 条，显示最近 ${recent.length} 条</span></div>` +
      '<table class="data-table">' +
      '<thead><tr><th>日期</th><th>难度</th><th class="num">3BV</th><th class="num">用时</th><th class="num">3BVS</th><th class="num">STNB</th><th class="num">原纪录</th><th class="num">提升</th><th>录像</th></tr></thead>' +
      `<tbody>${recentRows || '<tr><td colspan="9" class="muted">最近 30 天没有新 PB</td></tr>'}</tbody>` +
      '</table>' +
      '</div>'
    )
  }

  function rankTableHtml(rows: AnalysisGame[], limit: number): string {
    const dates = rows.map((game) => game.date)
    const body = rows
      .slice(0, limit)
      .map((game, index) => {
        const mov = game.path > 0 ? (game.path / 16 / game.time).toFixed(1) : '—'
        const path = game.path > 0 ? String(Math.round(game.path / 16)) : '—'
        const opIs =
          game.video.op === null || game.video.isl === null
            ? '—'
            : `${game.op}op ${game.isl}is`
        return (
          `<tr${rowClass(index)}>` +
          `<td class="rank">${index + 1}</td>` +
          `<td class="date">${opIs}</td>` +
          `<td class="num">${game.bv}</td>` +
          `<td class="num">${game.hasCe ? game.ce : '—'}</td>` +
          `<td class="num">${game.hasRight ? `${game.right}${game.nf ? '<span class="nf-tag">NF</span>' : ''}` : '—'}</td>` +
          `<td class="num"${colorAttr(game.level, 'time', game.time)}>${videoLink(game, formatTime(game.time), 'pb-link')}</td>` +
          `<td class="num"${colorAttr(game.level, 'bvs', game.bvs)}>${game.bvs.toFixed(3)}</td>` +
          `<td class="num"${game.hasCe ? colorAttr(game.level, 'bvs', game.ce / game.time) : ''}>${game.hasCe ? (game.ce / game.time).toFixed(2) : '—'}</td>` +
          `<td class="num"${game.hasCl ? colorAttr(game.level, 'bvs', game.cl / game.time) : ''}>${game.hasCl ? (game.cl / game.time).toFixed(2) : '—'}</td>` +
          `<td class="num"${colorAttr(game.level, 'stnb', game.stnb)}>${game.stnb.toFixed(1)}</td>` +
          `<td class="num">${mov}</td>` +
          `<td class="num">${path}</td>` +
          `<td class="date"${dateAttr(game.date, dates)}>${formatShortDate(game.date)}</td>` +
          '</tr>'
        )
      })
      .join('')

    return (
      '<div class="table-scroll">' +
      '<table class="data-table rank-table">' +
      '<thead><tr><th class="num">名次</th><th>op/is</th><th class="num">3BV</th><th class="num">有效点击</th><th class="num">右键</th><th class="num">用时</th><th class="num">3BVS</th><th class="num">有效/秒</th><th class="num">点击/秒</th><th class="num">STNB</th><th class="num">移速</th><th class="num">路径</th><th>日期</th></tr></thead>' +
      `<tbody>${body || '<tr><td colspan="13" class="muted">没有符合条件的成绩</td></tr>'}</tbody>` +
      '</table>' +
      '</div>'
    )
  }

  function rankHtml(): string {
    const triple = state.rankLayout === 'triple'
    const viewTabs =
      '<div class="tabs">' +
      LEVELS.map(
        (level) =>
          `<button type="button" class="tab${!triple && state.rankLevel === level ? ' active' : ''}" data-rank-view="${level}">${LEVEL_LABELS[level]}</button>`,
      ).join('') +
      `<button type="button" class="tab${triple ? ' active' : ''}" data-rank-view="triple">三难度</button>` +
      '</div>'
    const statTabs =
      '<div class="tabs">' +
      (['time', 'bvs', 'stnb'] as RankStat[])
        .map(
          (stat) =>
            `<button type="button" class="tab${state.rankStat === stat ? ' active' : ''}" data-rank-stat="${stat}">${STAT_LABELS[stat]}</button>`,
        )
        .join('') +
      '</div>'

    const blocks = triple
      ? LEVELS.map((level) => {
          const rows = rankGames(games, state.rankStat, level)
          return (
            '<div class="level-block">' +
            `<div class="level-head"><span class="lv"><i></i>${LEVEL_LABELS[level]}</span><span>${formatCount(rows.length)} 局 · 前 10</span></div>` +
            rankTableHtml(rows, 10) +
            '</div>'
          )
        }).join('')
      : rankTableHtml(
          rankGames(games, state.rankStat, state.rankLevel),
          settings.rankLimit,
        )

    const scope = state.nfOnly ? '仅 NF' : '普通 + NF'
    const subtitle = triple ? `三难度纵向 · 各前 10 · ${scope}` : state.nfOnly ? '仅 NF' : '全部录像 · 普通 + NF'
    const title = triple
      ? `${STAT_LABELS[state.rankStat]} · 三难度`
      : `${STAT_LABELS[state.rankStat]} Top ${settings.rankLimit} · ${LEVEL_LABELS[state.rankLevel]}`

    return (
      '<div class="toolbar">' +
      statTabs +
      viewTabs +
      '<span class="spacer"></span>' +
      `<span class="note">3BV ≥ ${floorLabel()} · 右键 = 0 记 NF</span>` +
      '</div>' +
      '<div class="card">' +
      `<div class="card-head"><h2 class="card-title">${title}</h2><span class="muted">${subtitle}</span></div>` +
      blocks +
      '</div>'
    )
  }

  function trendHtml(): string {
    const weeks = weekStats(
      games,
      10,
      now,
      true,
      settings.t37Slots,
      settings.t37Pads,
      settings.pppConsts,
    ).filter((week) => week.count > 0)
    const allMonths = monthStats(games, state.trendLevel, rangeGames)
    const months = state.hideEmptyMonths ? allMonths.filter((month) => month.count > 0) : allMonths

    const weekRows = weeks
      .map((week, index) => {
        const prev = index > 0 ? (weeks[index - 1] as (typeof weeks)[number]) : null
        const diff = prev ? week.t37 - prev.t37 : null
        const levelBlock = (level: Level): string => {
          const data = week.levels[level]
          const prefix = level
          const rows = data.slots
            .map(
              (slot, index) =>
                '<tr>' +
                `<td class="num">${index + 1}</td>` +
                `<td class="num"${colorAttr(level, 'time', slot.time)}>${slot.time.toFixed(3)}</td>` +
                `<td class="num"${colorAttr(level, 'bvs', slot.bvs)}>${slot.bvs.toFixed(3)}</td>` +
                `<td class="num"${colorAttr(level, 'stnb', slot.stnb)}>${slot.stnb.toFixed(2)}</td>` +
                '</tr>',
            )
            .join('')
          return (
            '<div class="week-level-block">' +
            `<div class="week-level-head">${LEVEL_LABELS[level]} · ${data.slot} 条</div>` +
            '<table class="data-table week-slot-table">' +
            `<thead><tr><th class="num">排名</th><th class="num">${prefix}t</th><th class="num">${prefix}b</th><th class="num">${prefix}s</th></tr></thead>` +
            `<tbody>${rows}` +
            `<tr class="week-total"><td>总计</td><td class="num">${data.totals.time.toFixed(3)}</td><td class="num">${data.totals.bvs.toFixed(3)}</td><td class="num">${data.totals.stnb.toFixed(2)}</td></tr>` +
            `<tr class="week-average"><td>平均</td><td class="num"${colorAttr(level, 'time', data.averages.time)}>${data.averages.time.toFixed(3)}</td><td class="num"${colorAttr(level, 'bvs', data.averages.bvs)}>${data.averages.bvs.toFixed(3)}</td><td class="num"${colorAttr(level, 'stnb', data.averages.stnb)}>${data.averages.stnb.toFixed(2)}</td></tr>` +
            '</tbody></table></div>'
          )
        }
        const detail =
          '<tr class="week-detail hidden"><td colspan="7"><div class="week-level-grid">' +
          `<div class="week-level-column">${levelBlock('b')}</div>` +
          `<div class="week-level-column">${levelBlock('i')}${levelBlock('e')}</div>` +
          '</div>' +
          '<div class="week-summary">' +
          `<span>T.37 <b>${week.t37.toFixed(2)}</b></span>` +
          `<span>B.37 <b>${week.b37.toFixed(3)}</b></span>` +
          `<span>S.37 <b>${week.s37.toFixed(1)}</b></span>` +
          `<span>BPP${week.levels.b.slot} <b>${week.levels.b.ppp.toFixed(2)}</b></span>` +
          `<span>IPP${week.levels.i.slot} <b>${week.levels.i.ppp.toFixed(2)}</b></span>` +
          `<span>EPP${week.levels.e.slot} <b>${week.levels.e.ppp.toFixed(2)}</b></span>` +
          `<span>PPP37 <b>${week.ppp.toFixed(2)}</b></span>` +
          '</div></td></tr>'
        return (
          '<tr class="week-row" data-week-row="1">' +
          `<td class="date"><span class="week-arrow">▸</span>${formatShortDate(week.start)}</td>` +
          `<td class="num">${week.count}</td>` +
          `<td class="num">${week.t37.toFixed(1)}</td>` +
          `<td class="num">${week.b37.toFixed(1)}</td>` +
          `<td class="num">${week.s37.toFixed(1)}</td>` +
          `<td class="num">${week.ppp.toFixed(3)}</td>` +
          `<td class="num ${diff === null ? '' : diff < 0 ? 'delta-up' : 'delta-down'}">${diff === null ? '—' : `${diff < 0 ? '−' : '+'}${Math.abs(diff).toFixed(1)}`}</td>` +
          '</tr>' +
          detail
        )
      })
      .join('')

    const monthRows = months
      .map((month) => {
        if (month.count === 0) {
          return (
            '<tr>' +
            `<td class="date">${month.key}</td>` +
            `<td class="num">${month.days}</td>` +
            '<td class="num">0</td>' +
            '<td class="num" colspan="17" style="text-align:left">—</td>' +
            '</tr>'
          )
        }
        const statsCells = month.hasScores
          ? `<td class="num">${month.gamesPerDay.toFixed(1)}</td>` +
            `<td class="num"${colorAttr(state.trendLevel, 'time', month.avgTime)}>${formatTime(month.avgTime)}</td>` +
            `<td class="num">${formatTime(month.medianTime)}</td>` +
            `<td class="num">${month.avgBv.toFixed(1)}</td>` +
            `<td class="num"${colorAttr(state.trendLevel, 'bvs', month.avgBvs)}>${month.avgBvs.toFixed(3)}</td>` +
            `<td class="num"${colorAttr(state.trendLevel, 'stnb', month.avgStnb)}>${month.avgStnb.toFixed(1)}</td>` +
            `<td class="num">${month.hasOp ? month.avgOp.toFixed(1) : '—'}</td>` +
            `<td class="num">${month.hasIs ? month.avgIs.toFixed(1) : '—'}</td>` +
            `<td class="num"${month.hasCl ? colorAttr(state.trendLevel, 'bvs', month.avgCls) : ''}>${month.hasCl ? month.avgCls.toFixed(2) : '—'}</td>` +
            `<td class="num"${month.hasCe ? colorAttr(state.trendLevel, 'bvs', month.avgCes) : ''}>${month.hasCe ? month.avgCes.toFixed(2) : '—'}</td>` +
            `<td class="num"${month.hasCl && month.hasCe ? numColorAttr(month.avgCorr, 1 / 6) : ''}>${month.hasCl && month.hasCe ? month.avgCorr.toFixed(2) : '—'}</td>` +
            `<td class="num"${month.hasCe ? numColorAttr(month.avgThrp, 1 / 6) : ''}>${month.hasCe ? month.avgThrp.toFixed(2) : '—'}</td>` +
            `<td class="num">${month.hasPath ? Math.round(month.avgPath) : '—'}</td>` +
            `<td class="num">${month.hasPath ? month.avgMov.toFixed(1) : '—'}</td>` +
            `<td class="num">${month.breakRate === 0 ? '—' : month.breakRate}</td>` +
            `<td class="num">${month.headScore}</td>` +
            `<td class="num">${month.pbCount}</td>`
          : '<td class="num" colspan="17">—</td>'

        const tierBlock = (title: string, limits: number[], shares: number[]): string =>
          '<div class="month-tier-block">' +
          `<h4>${title}</h4><div class="month-tier-chips">` +
          limits
            .map(
              (limit, index) =>
                `<span class="month-tier-chip"><b>${limit}</b><em>${month.hasScores ? `${(shares[index]! * 100).toFixed(1)}%` : '—'}</em></span>`,
            )
            .join('') +
          '</div></div>'

        const detail =
          '<tr class="month-detail hidden"><td colspan="20">' +
          (month.hasScores
            ? '<div class="month-tier-grid">' +
              tierBlock('用时分档', MONTH_TIME_TIERS[state.trendLevel], month.timeTierShare) +
              tierBlock('3BVS 分档', MONTH_BVS_TIERS[state.trendLevel], month.bvsTierShare) +
              '</div>'
            : '<p class="muted">当月只有低于 3BV 下限的录像，没有有效成绩。</p>') +
          '</td></tr>'

        return (
          '<tr class="month-row" data-month-row="1">' +
          `<td class="date"><span class="month-arrow">▸</span>${month.key}</td>` +
          `<td class="num">${month.days}</td>` +
          `<td class="num">${month.count}</td>` +
          statsCells +
          '</tr>' +
          detail
        )
      })
      .join('')

    const yearTables = LEVELS.map((level) => {
      const years = yearStats(games, level, rangeGames)
      const rows = years
        .map((year) => {
          const stats = year.hasScores
            ? `<td class="num"${colorAttr(level, 'time', year.avgTime)}>${year.avgTime.toFixed(3)}</td>` +
              `<td class="num">${year.avgBv.toFixed(1)}</td>` +
              `<td class="num"${colorAttr(level, 'bvs', year.avgBvs)}>${year.avgBvs.toFixed(3)}</td>` +
              `<td class="num"${colorAttr(level, 'stnb', year.avgStnb)}>${year.avgStnb.toFixed(1)}</td>` +
              `<td class="num"${year.hasCl ? colorAttr(level, 'bvs', year.avgCls) : ''}>${year.hasCl ? year.avgCls.toFixed(2) : '—'}</td>` +
              `<td class="num"${year.hasCe ? colorAttr(level, 'bvs', year.avgCes) : ''}>${year.hasCe ? year.avgCes.toFixed(2) : '—'}</td>` +
              `<td class="num">${year.hasPath ? year.avgMov.toFixed(1) : '—'}</td>` +
              `<td class="num">${year.pbCount}</td>`
            : '<td class="num" colspan="8">—</td>'
          return (
            '<tr>' +
            `<td class="date">${year.year}</td>` +
            `<td class="num">${year.count}</td>` +
            stats +
            '</tr>'
          )
        })
        .join('')
      return (
        '<div class="card year-block">' +
        `<div class="card-head"><h3 class="card-title">年汇总 · ${LEVEL_LABELS[level]}</h3><span class="muted">按年份聚合</span></div>` +
        '<table class="data-table year-table">' +
        '<thead><tr><th>年份</th><th class="num">局数</th><th class="num">平均用时</th><th class="num">平均 3BV</th><th class="num">平均 3BVS</th><th class="num">平均 STNB</th><th class="num">cl/s</th><th class="num">ce/s</th><th class="num">移速</th><th class="num">新 PB</th></tr></thead>' +
        `<tbody>${rows || '<tr><td colspan="10" class="muted">没有数据</td></tr>'}</tbody>` +
        '</table></div>'
      )
    }).join('')

    const levelTabs =
      '<div class="tabs">' +
      LEVELS.map(
        (level) =>
          `<button type="button" class="tab${state.trendLevel === level ? ' active' : ''}" data-trend-level="${level}">${LEVEL_LABELS[level]}</button>`,
      ).join('') +
      '</div>'
    const monthTools =
      '<div class="month-tools">' +
      `<label class="check"><input type="checkbox" id="analysis-hide-empty"${state.hideEmptyMonths ? ' checked' : ''}> 隐藏无数据月份</label>` +
      levelTabs +
      '</div>'

    return (
      '<div class="card">' +
      '<div class="card-head"><h2 class="card-title">周 T37</h2><span class="muted">按参数槽位取用时 / 3BVS / STNB · T37 越小越好 · 点周行展开三级明细</span></div>' +
      '<table class="data-table">' +
      '<thead><tr><th>周起始</th><th class="num">局数</th><th class="num">T37</th><th class="num">B37</th><th class="num">S37</th><th class="num">ppp</th><th class="num">ΔT37</th></tr></thead>' +
      `<tbody>${weekRows || '<tr><td colspan="7" class="muted">没有数据</td></tr>'}</tbody>` +
      '</table>' +
      '</div>' +

      '<div class="card">' +
      `<div class="card-head"><h2 class="card-title">月均明细 · ${LEVEL_LABELS[state.trendLevel]}</h2>${monthTools}</div>` +
      '<div class="table-scroll">' +
      '<table class="data-table month-table">' +
      '<thead><tr>' +
      '<th rowspan="2">月份</th><th rowspan="2" class="num">活跃天数</th><th rowspan="2" class="num">局数</th><th rowspan="2" class="num">日均</th>' +
      '<th colspan="5" class="group">平均</th>' +
      '<th colspan="2" class="group">每局</th>' +
      '<th colspan="2" class="group">点击效率</th>' +
      '<th colspan="2" class="group">转化</th>' +
      '<th colspan="2" class="group">路径</th>' +
      '<th colspan="3" class="group">头部</th>' +
      '</tr><tr>' +
      '<th class="num">用时</th><th class="num">中位</th><th class="num">3BV</th><th class="num">3BVS</th><th class="num">STNB</th>' +
      '<th class="num">op</th><th class="num">is</th>' +
      '<th class="num">cl/s</th><th class="num">ce/s</th>' +
      '<th class="num">corr</th><th class="num">thrp</th>' +
      '<th class="num">格</th><th class="num">移速</th>' +
      '<th class="num">1/破率</th><th class="num">头部</th><th class="num">新 PB</th>' +
      '</tr></thead>' +
      `<tbody>${monthRows || '<tr><td colspan="20" class="muted">没有数据</td></tr>'}</tbody>` +
      '</table>' +
      '</div>' +
      '</div>' +

      '<div class="year-stack">' +
      yearTables +
      '</div>'
    )
  }

  function periodHtml(): string {
    const groups = periodGroups(games, state.periodLevel, state.periodMode, rangeGames)
    if (groups.length === 0) {
      return '<div class="card"><div class="card-body"><p class="muted">这个难度还没有数据</p></div></div>'
    }
    const selected = groups.find((group) => group.key === state.periodKey) ?? groups[0]!
    const limit = state.periodMode === 'month' ? settings.monthTop : settings.yearTop
    const rows = rankGames(selected.rows, state.periodStat).slice(0, limit)
    const dates = rows.map((game) => game.date)

    const modeTabs =
      '<div class="tabs">' +
      ([
        ['month', '月 Top'],
        ['year', '年 Top'],
      ] as Array<[PeriodMode, string]>)
        .map(
          ([mode, label]) =>
            `<button type="button" class="tab${state.periodMode === mode ? ' active' : ''}" data-period-mode="${mode}">${label}</button>`,
        )
        .join('') +
      '</div>'
    const levelTabs =
      '<div class="tabs">' +
      LEVELS.map(
        (level) =>
          `<button type="button" class="tab${state.periodLevel === level ? ' active' : ''}" data-period-level="${level}">${LEVEL_LABELS[level]}</button>`,
      ).join('') +
      '</div>'
    const statTabs =
      '<div class="tabs">' +
      (['time', 'bvs', 'stnb'] as RankStat[])
        .map(
          (stat) =>
            `<button type="button" class="tab${state.periodStat === stat ? ' active' : ''}" data-period-stat="${stat}">${STAT_LABELS[stat]}</button>`,
        )
        .join('') +
      '</div>'
    const select =
      `<select class="select" id="period-select">` +
      groups
        .map(
          (group) =>
            `<option value="${group.key}"${group.key === selected.key ? ' selected' : ''}>${group.key}</option>`,
        )
        .join('') +
      '</select>'

    const body = rows
      .map((game, index) => {
        return (
          `<tr${rowClass(index)}>` +
          `<td class="rank">${index + 1}</td>` +
          `<td class="num">${game.bv}</td>` +
          `<td class="num"${colorAttr(state.periodLevel, 'time', game.time)}>${videoLink(game, formatTime(game.time), 'pb-link')}</td>` +
          `<td class="num"${colorAttr(state.periodLevel, 'bvs', game.bvs)}>${game.bvs.toFixed(3)}</td>` +
          `<td class="num"${colorAttr(state.periodLevel, 'stnb', game.stnb)}>${game.stnb.toFixed(1)}</td>` +
          `<td class="num">${game.hasCe ? game.ce : '—'}</td>` +
          `<td class="num">${game.hasCl ? (game.cl / game.time).toFixed(2) : '—'}</td>` +
          `<td class="date"${dateAttr(game.date, dates)}>${formatShortDate(game.date)}</td>` +
          '</tr>'
        )
      })
      .join('')

    return (
      '<div class="toolbar">' +
      modeTabs +
      levelTabs +
      statTabs +
      select +
      `<span class="note">每期前 ${limit} · ${LEVEL_LABELS[state.periodLevel]}</span>` +
      '</div>' +
      '<div class="card">' +
      `<div class="card-head"><h2 class="card-title">${state.periodMode === 'month' ? '月' : '年'} Top · ${selected.key}</h2><span class="muted">${STAT_LABELS[state.periodStat]} 排序 · ${formatCount(selected.count)} 局（含低于下限的局）</span></div>` +
      '<table class="data-table rank-table">' +
      '<thead><tr><th class="num">名次</th><th class="num">3BV</th><th class="num">用时</th><th class="num">3BVS</th><th class="num">STNB</th><th class="num">有效点击</th><th class="num">点击/秒</th><th>日期</th></tr></thead>' +
      `<tbody>${body || '<tr><td colspan="8" class="muted">没有数据</td></tr>'}</tbody>` +
      '</table>' +
      '</div>'
    )
  }

  function distHtml(): string {
    const buckets = bucketStats(games, state.distLevel)
    const subs = subStats(games, state.distLevel, settings.subTiers)
    const ranges = rangeStats(rangeGames, state.distLevel)

    const levelTabs =
      '<div class="tabs">' +
      LEVELS.map(
        (level) =>
          `<button type="button" class="tab${state.distLevel === level ? ' active' : ''}" data-dist-level="${level}">${LEVEL_LABELS[level]}</button>`,
      ).join('') +
      '</div>'

    const bucketRows = buckets
      .map(
        (bucket) =>
          '<tr>' +
          `<td class="num">${bucket.start}–${bucket.end}</td>` +
          `<td class="num">${bucket.count}</td>` +
          `<td class="num">${(bucket.share * 100).toFixed(1)}%</td>` +
          `<td class="num"${colorAttr(state.distLevel, 'time', bucket.avgTime)}>${bucket.avgTime.toFixed(3)}</td>` +
          `<td class="num"${colorAttr(state.distLevel, 'bvs', bucket.avgBvs)}>${bucket.avgBvs.toFixed(3)}</td>` +
          `<td class="num"${colorAttr(state.distLevel, 'stnb', bucket.avgStnb)}>${bucket.avgStnb.toFixed(1)}</td>` +
          `<td class="num"${colorAttr(state.distLevel, 'time', bucket.best.time)}>${videoLink(bucket.best, bucket.best.time.toFixed(3), 'pb-link')}</td>` +
          '</tr>',
      )
      .join('')

    const subRows = subs
      .map((tier) => {
        const limit = Number.isInteger(tier.limit) ? String(tier.limit) : tier.limit.toFixed(1)
        return (
          '<tr>' +
          `<td class="num">${limit}s</td>` +
          `<td class="num">${tier.count}</td>` +
          `<td class="num">${(tier.share * 100).toFixed(2)}%</td>` +
          `<td class="num">${Number.isFinite(tier.every) ? `1 / ${Math.round(tier.every)}` : '—'}</td>` +
          `<td class="tier">${tier.label}</td>` +
          '</tr>'
        )
      })
      .join('')

    const rangeRows = ranges
      .map(
        (range) =>
          '<tr>' +
          `<td class="num">${range.start}–${range.end}</td>` +
          `<td class="num">${range.count}</td>` +
          `<td class="num">${(range.share * 100).toFixed(1)}%</td>` +
          `<td class="num">${range.theoryShare === null ? '—' : `${(range.theoryShare * 100).toFixed(1)}%`}</td>` +
          `<td class="num"${range.count ? colorAttr(state.distLevel, 'time', range.avgTime) : ''}>${range.count ? range.avgTime.toFixed(3) : '—'}</td>` +
          `<td class="num"${range.count ? colorAttr(state.distLevel, 'bvs', range.avgBvs) : ''}>${range.count ? range.avgBvs.toFixed(3) : '—'}</td>` +
          `<td class="num"${range.count ? colorAttr(state.distLevel, 'stnb', range.avgStnb) : ''}>${range.count ? range.avgStnb.toFixed(1) : '—'}</td>` +
          '</tr>',
      )
      .join('')

    return (
      '<div class="toolbar">' +
      levelTabs +
      `<span class="note">分析口径 3BV ≥ ${floorLabel()} · rAvg 含初级 2–9</span>` +
      '</div>' +
      '<div class="dist-grid">' +
      '<div class="card">' +
      '<div class="card-head"><h2 class="card-title">3BV 分档</h2><span class="muted">局数 / 平均 / 该档最好</span></div>' +
      '<table class="data-table">' +
      '<thead><tr><th class="num">区间</th><th class="num">局数</th><th class="num">占比</th><th class="num">平均用时</th><th class="num">平均 3BVS</th><th class="num">平均 STNB</th><th class="num">最好</th></tr></thead>' +
      `<tbody>${bucketRows || '<tr><td colspan="7" class="muted">没有数据</td></tr>'}</tbody>` +
      '</table>' +
      '</div>' +
      '<div class="card">' +
      '<div class="card-head"><h2 class="card-title">Sub 率</h2><span class="muted">用时 &lt; 档位 · 累计</span></div>' +
      '<table class="data-table ladder-table">' +
      '<thead><tr><th class="num">用时</th><th class="num">局数</th><th class="num">占比</th><th class="num">频率</th><th>话术</th></tr></thead>' +
      `<tbody>${subRows || '<tr><td colspan="5" class="muted">没有数据</td></tr>'}</tbody>` +
      '</table>' +
      '</div>' +
      '</div>' +
      '<div class="card">' +
      '<div class="card-head"><h2 class="card-title">3BV 区间（rAvg）</h2><span class="muted">局数 / 实际占比 / 理论占比 / 平均</span></div>' +
      '<table class="data-table">' +
      '<thead><tr><th class="num">区间</th><th class="num">局数</th><th class="num">实际</th><th class="num">理论</th><th class="num">平均用时</th><th class="num">平均 3BVS</th><th class="num">平均 STNB</th></tr></thead>' +
      `<tbody>${rangeRows || '<tr><td colspan="7" class="muted">没有数据</td></tr>'}</tbody>` +
      '</table>' +
      '</div>'
    )
  }

  function effHtml(): string {
    const cards: Array<[EfficiencyMetric, string, string, (value: number) => string]> = [
      ['cls', '点击 / 秒', 'cl/s', (value) => value.toFixed(2)],
      ['ces', '有效 / 秒', 'ce/s', (value) => value.toFixed(2)],
      ['mov', '移速', '格/秒', (value) => value.toFixed(1)],
      ['ioe', 'IOE', 'bv/cl', (value) => value.toFixed(3)],
    ]

    const levelTabs =
      '<div class="tabs">' +
      LEVELS.map(
        (level) =>
          `<button type="button" class="tab${state.effLevel === level ? ' active' : ''}" data-eff-level="${level}">${LEVEL_LABELS[level]}</button>`,
      ).join('') +
      '</div>'

    const body = cards
      .map(([metric, label, unit, format]) => {
        const rows = efficiencyTop(games, state.effLevel, metric, settings.smallTop)
        const dates = rows.map((row) => row.game.date)
        const tableRows = rows
          .map((row, index) => {
            const color =
              metric === 'cls' || metric === 'ces'
                ? colorAttr(state.effLevel, 'bvs', row.value)
                : ''
            return (
              '<tr>' +
              `<td class="num">${index + 1}</td>` +
              `<td class="num metric"${color}>${format(row.value)}</td>` +
              `<td class="num">${row.game.bv}</td>` +
              `<td class="num">${row.game.time.toFixed(3)}</td>` +
              `<td class="num">${row.game.stnb.toFixed(1)}</td>` +
              `<td class="date"${dateAttr(row.game.date, dates)}>${formatShortDate(row.game.date)}</td>` +
              '</tr>'
            )
          })
          .join('')
        return (
          '<div class="card">' +
          `<div class="card-head"><h2 class="card-title">${label}</h2><span class="muted">${unit}</span></div>` +
          '<table class="data-table eff-table">' +
          '<thead><tr><th class="num">#</th><th class="num">值</th><th class="num">3BV</th><th class="num">用时</th><th class="num">STNB</th><th>日期</th></tr></thead>' +
          `<tbody>${tableRows || '<tr><td colspan="6" class="muted">没有数据</td></tr>'}</tbody>` +
          '</table>' +
          '</div>'
        )
      })
      .join('')

    const othCards: Array<[OthMetric, string, string, (value: number) => string]> = [
      ['invCe', '最少有效点击', '次', (value) => String(Math.round(value))],
      ['ce', '最多有效点击', '次', (value) => String(Math.round(value))],
      ['invPath', '最小路径', '1/16 格', (value) => String(Math.round(value))],
      ['invIs', '最少岛屿', '', (value) => String(Math.round(value))],
      ['invOp', '最少开空', '', (value) => String(Math.round(value))],
      ['is', '最多岛屿', '', (value) => String(Math.round(value))],
      ['op', '最多开空', '', (value) => String(Math.round(value))],
    ]

    const othBody = othCards
      .map(([metric, label, unit, format]) => {
        const rows = othTop(games, state.effLevel, metric, settings.smallTop)
        const dates = rows.map((row) => row.game.date)
        const tableRows = rows
          .map(
            (row, index) =>
              '<tr>' +
              `<td class="num">${index + 1}</td>` +
              `<td class="num metric">${format(row.value)}</td>` +
              `<td class="num">${row.game.bv}</td>` +
              `<td class="num">${row.game.time.toFixed(3)}</td>` +
              `<td class="date"${dateAttr(row.game.date, dates)}>${formatShortDate(row.game.date)}</td>` +
              '</tr>',
          )
          .join('')
        return (
          '<div class="card">' +
          `<div class="card-head"><h2 class="card-title">${label}</h2><span class="muted">${unit}</span></div>` +
          '<table class="data-table eff-table">' +
          '<thead><tr><th class="num">#</th><th class="num">值</th><th class="num">3BV</th><th class="num">用时</th><th>日期</th></tr></thead>' +
          `<tbody>${tableRows || '<tr><td colspan="5" class="muted">没有数据</td></tr>'}</tbody>` +
          '</table>' +
          '</div>'
        )
      })
      .join('')

    return (
      '<div class="toolbar">' +
      levelTabs +
      `<span class="note">每项前 ${settings.smallTop} · ${LEVEL_LABELS[state.effLevel]}</span>` +
      '</div>' +
      `<div class="eff-grid">${body}</div>` +
      '<h3 class="section-title">杂项 7 项</h3>' +
      `<div class="oth-grid">${othBody}</div>`
    )
  }

  function mapHtml(): string {
    const level = state.mapLevel
    const map = heatmapStats(games, level)
    const points = frontier(games, level)
    const W = 760
    const H = 400
    const padL = 48
    const padB = 34
    const padT = 10
    const padR = 10
    const cellW = (W - padL - padR) / map.cols
    const cellH = (H - padT - padB) / map.rows
    const coefficient = STNB_COEFFICIENT[level]
    const minBv = settings.bvFloors[level]
    const maxBv = level === 'e' ? 278 : 134

    let cells = ''
    for (let row = 0; row < map.rows; row += 1) {
      for (let col = 0; col < map.cols; col += 1) {
        const count = map.cells[row]?.[col] ?? 0
        const time = ((col + 0.5) / map.cols) * map.maxTime
        const bvs = (1 - (row + 0.5) / map.rows) * map.maxBvs
        let fill = 'transparent'
        if (count > 0) {
          fill = 'var(--surface)'
        } else {
          const bv = time * bvs
          if (bv >= minBv && bv <= maxBv) {
            const stnb = (coefficient * bv) / time ** 1.7
            fill = pbColorStyle(level, 'stnb', stnb)?.backgroundColor ?? 'transparent'
          }
        }
        const x = padL + col * cellW
        const y = padT + row * cellH
        cells +=
          `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(cellW - 0.5).toFixed(1)}" height="${(cellH - 0.5).toFixed(1)}" fill="${fill}" stroke="var(--border)" stroke-width="0.4"/>`
        if (count > 0) {
          cells += `<text x="${(x + cellW / 2).toFixed(1)}" y="${(y + cellH / 2 + 2.5).toFixed(1)}" text-anchor="middle" fill="var(--muted)" font-size="7">${count}</text>`
        }
      }
    }

    const polyline = points
      .filter((point) => point.time <= map.maxTime && point.bvs <= map.maxBvs)
      .map((point) => {
        const x = padL + (point.time / map.maxTime) * (W - padL - padR)
        const y = padT + (1 - point.bvs / map.maxBvs) * (H - padT - padB)
        return `${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(' ')

    let axes = ''
    for (let index = 0; index <= 6; index += 1) {
      const x = padL + (index / 6) * (W - padL - padR)
      const value = (index / 6) * map.maxTime
      axes += `<text x="${x.toFixed(1)}" y="${H - 10}" text-anchor="middle" fill="var(--muted)" font-size="10">${Math.round(value)}</text>`
    }
    for (let index = 0; index <= 5; index += 1) {
      const y = padT + (1 - index / 5) * (H - padT - padB)
      const value = (index / 5) * map.maxBvs
      axes += `<text x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" fill="var(--muted)" font-size="10">${value.toFixed(1)}</text>`
    }
    axes += `<text x="${W / 2}" y="${H - 0.5}" text-anchor="middle" fill="var(--muted)" font-size="10">时间（秒）</text>`
    axes += `<text x="12" y="${H / 2}" text-anchor="middle" fill="var(--muted)" font-size="10" transform="rotate(-90 12 ${H / 2})">3BVS</text>`

    const dogTargets = parseDogTargets(
      level === 'e' ? settings.dogTargetsE : settings.dogTargetsI,
    )
    const dog = dogPredictions(games, dogTargets, level).slice(-4)
    const dogHeader = dog.map((item) => `<th class="num">${item.year}</th>`).join('')
    const dogPrefix = level === 'e' ? 'et' : level === 'i' ? 'it' : 'bt'
    const dogBody =
      dog.length === 0
        ? '<tr><td colspan="1" class="muted">暂无足够数据</td></tr>'
        : dogTargets
            .map((target) => {
              const cells = dog
                .map((item) => {
                  const cell = item.cells.find((entry) => entry.target === target)
                  return `<td class="num">${cell ? (cell.probability * 100).toFixed(2) : '—'}</td>`
                })
                .join('')
              return `<tr><td>${dogPrefix}&lt;${target}</td>${cells}</tr>`
            })
            .join('')
    const dogTable =
      '<table class="dog-table"><thead><tr><th>目标</th>' +
      dogHeader +
      '</tr></thead><tbody>' +
      dogBody +
      '</tbody></table>'

    const levelTabs =
      '<div class="tabs">' +
      (['e', 'i'] as Level[])
        .map(
          (item) =>
            `<button type="button" class="tab${level === item ? ' active' : ''}" data-map-level="${item}">${LEVEL_LABELS[item]}</button>`,
        )
        .join('') +
      '</div>'

    return (
      '<div class="toolbar">' +
      levelTabs +
      '<span class="note">空格 = 按理论 STNB 回填 · 数字 = 局数 · 折线 = 效率前沿</span>' +
      '</div>' +
      '<div class="map-grid">' +
      '<div class="card">' +
      `<div class="card-head"><h2 class="card-title">狗图 · ${LEVEL_LABELS[level]}</h2><span class="muted">时间 × 3BVS</span></div>` +
      `<svg class="map-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="时间与 3BVS 分布热图">${cells}${polyline ? `<polyline points="${polyline}" fill="none" stroke="var(--fg)" stroke-width="1.2" opacity="0.55"/>` : ''}${axes}</svg>` +
      '<div class="map-legend"><span>理论 STNB 低</span><span class="map-gradient"></span><span>高</span></div>' +
      '</div>' +
      '<div>' +
      '<div class="side-card"><h3>狗预测</h3><p>按年度达标概率外推（' +
      `${LEVEL_LABELS[level]}）</p>` +
      dogTable +
      '</div>' +
      `<div class="side-card"><h3>线</h3><p>当前效率边界 <b>#${points.length}</b></p>` +
      `<p>${points.length > 0 ? `最后一点 ${points[points.length - 1]!.time.toFixed(2)}s / ${points[points.length - 1]!.bvs.toFixed(2)}` : '暂无数据'}</p></div>` +
      '</div>' +
      '</div>'
    )
  }

  nav.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-nav]')
    if (!button) return
    const key = button.dataset.nav as NavKey
    if (key === state.nav) return
    state.nav = key
    render()
  })

  viewHost.addEventListener('click', (event) => {
    const target = event.target as HTMLElement
    const weekRow = target.closest<HTMLElement>('[data-week-row]')
    if (weekRow) {
      const detail = weekRow.nextElementSibling
      if (detail?.classList.contains('week-detail')) {
        detail.classList.toggle('hidden')
        weekRow.classList.toggle('open')
        const arrow = weekRow.querySelector<HTMLElement>('.week-arrow')
        if (arrow) arrow.textContent = detail.classList.contains('hidden') ? '▸' : '▾'
      }
      return
    }
    const monthRow = target.closest<HTMLElement>('[data-month-row]')
    if (monthRow) {
      const detail = monthRow.nextElementSibling
      if (detail?.classList.contains('month-detail')) {
        detail.classList.toggle('hidden')
        monthRow.classList.toggle('open')
        const arrow = monthRow.querySelector<HTMLElement>('.month-arrow')
        if (arrow) arrow.textContent = detail.classList.contains('hidden') ? '▸' : '▾'
      }
      return
    }
    const stat = target.closest<HTMLElement>('[data-rank-stat]')
    if (stat) {
      state.rankStat = stat.dataset.rankStat as RankStat
      render()
      return
    }
    const view = target.closest<HTMLElement>('[data-rank-view]')
    if (view) {
      const value = view.dataset.rankView
      if (value === 'triple') {
        state.rankLayout = 'triple'
      } else {
        state.rankLayout = 'single'
        state.rankLevel = value as Level
      }
      render()
      return
    }
    const trendLevel = target.closest<HTMLElement>('[data-trend-level]')
    if (trendLevel) {
      state.trendLevel = trendLevel.dataset.trendLevel as Level
      render()
      return
    }
    const distLevel = target.closest<HTMLElement>('[data-dist-level]')
    if (distLevel) {
      state.distLevel = distLevel.dataset.distLevel as Level
      render()
      return
    }
    const periodMode = target.closest<HTMLElement>('[data-period-mode]')
    if (periodMode) {
      state.periodMode = periodMode.dataset.periodMode as PeriodMode
      state.periodKey = ''
      render()
      return
    }
    const periodLevel = target.closest<HTMLElement>('[data-period-level]')
    if (periodLevel) {
      state.periodLevel = periodLevel.dataset.periodLevel as Level
      state.periodKey = ''
      render()
      return
    }
    const periodStat = target.closest<HTMLElement>('[data-period-stat]')
    if (periodStat) {
      state.periodStat = periodStat.dataset.periodStat as RankStat
      render()
      return
    }
    const effLevel = target.closest<HTMLElement>('[data-eff-level]')
    if (effLevel) {
      state.effLevel = effLevel.dataset.effLevel as Level
      render()
      return
    }
    const mapLevel = target.closest<HTMLElement>('[data-map-level]')
    if (mapLevel) {
      state.mapLevel = mapLevel.dataset.mapLevel as Level
      render()
    }
  })

  root.addEventListener('change', (event) => {
    const input = event.target as HTMLInputElement
    if (input.id === 'analysis-hide-empty') {
      state.hideEmptyMonths = input.checked
      render()
      return
    }
    if (input.id === 'period-select') {
      state.periodKey = input.value
      render()
      return
    }
    if (input.id === 'analysis-nf-global') {
      state.nfOnly = input.checked
      applyFilters()
      render()
    }
  })

  rangeSelect.addEventListener('change', () => {
    state.range = Number(rangeSelect.value)
    applyFilters()
    render()
  })
  softwareSelect.addEventListener('change', () => {
    state.software = softwareSelect.value
    applyFilters()
    render()
  })

  function update(next: Video[], options: { csv?: boolean } = {}): void {
    videos = next
    csvMode = options.csv === true
    if (csvMode) {
      softwareSelect.value = 'all'
    } else {
      softwareSelect.value = state.software
    }
    softwareField.classList.toggle('hidden', csvMode)
    now = Date.now()
    ratingGames = analyzeGames(videos, {}, 1)
    applyFilters()
    render()
  }

  applyFilters()
  render()

  async function loadSiteAnchors(force = false): Promise<boolean> {
    const request = ++anchorRequest
    try {
      const fetched = await fetchLsfAnchors(force)
      if (request !== anchorRequest) return false
      Object.assign(settings.anchors, fetched.anchors)
      settings.anchorMode = 'site'
      anchorError = fetched.stale
      refreshAnchorInputs()
      const hours = Math.max(1, Math.round((Date.now() - fetched.fetchedAt) / (60 * 60 * 1000)))
      anchorStatus.textContent = fetched.stale
        ? `站点请求失败，沿用 ${hours} 小时前的网站锚点`
        : '已读取网站锚点'
      saveAnalysisSettings(settings)
      render()
      return true
    } catch {
      if (request !== anchorRequest) return false
      anchorError = true
      anchorStatus.textContent =
        settings.anchorMode === 'site'
          ? '网站锚点刷新失败，继续用已保存的网站锚点'
          : '网站锚点读取失败，继续用大表锚点'
      render()
      return false
    }
  }

  if (options.autoSiteAnchors !== false && settings.anchorMode === 'site') {
    void loadSiteAnchors()
  }

  function destroy(): void {
    // 让晚到的锚点响应失效，避免销毁后的视图继续改设置或重绘。
    anchorRequest += 1
    videos = []
    games = []
    rangeGames = []
    ratingGames = []
    root.replaceChildren()
    root.remove()
  }

  return { root, update, destroy }
}
