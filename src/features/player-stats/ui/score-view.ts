import { SITE_ORIGIN } from '../../../shared/constants'
import {
  formatDateTime,
  formatShortDate,
} from '../../../shared/format'
import { el, externalLink } from '../../../shared/ui'
import {
  bvsOf,
  computePb,
  computeTop5,
  eligible,
  stnbOf,
} from '../compute'
import { dateColorStyle, medianOf, pbColorStyle } from '../colors'
import { loadAnalysisSettings } from '../analysis-settings'
import type { Level, Top5Group, TopStat, Video } from '../model'
import { LEVEL_LABELS, LEVELS, MAX_BV, softwareLabel } from '../model'
import { softwareIcon } from '../software-icon'
import {
  PB_STAT_LABELS,
  PB_STATS,
} from '../player-state'
import type { PbStat, PlayerFilters, PlayerSnapshot } from '../player-state'

const SOFTWARE_OPTIONS = [
  { value: 'all', label: '全部软件' },
  { value: 'a', label: 'avf' },
  { value: 'e', label: 'evf' },
  { value: 'm', label: 'mvf' },
  { value: 'r', label: 'rmv' },
]

function formatSeconds(timems: number): string {
  return (timems / 1000).toFixed(3)
}

function formatEndTime(value: string | null): string {
  if (!value) return '—'
  const time = Date.parse(value)
  return Number.isNaN(time) ? '—' : formatDateTime(time)
}

function videoLink(id: number): HTMLElement {
  if (id <= 0) return el('span')
  return externalLink(`#${id}`, `${SITE_ORIGIN}/#/video/${id}`)
}

export interface ScoreViewOptions {
  onFiltersChange(patch: Partial<PlayerFilters>): void
}

export interface ScoreView {
  filters: HTMLElement
  notice: HTMLElement
  pbCard: HTMLElement
  topCard: HTMLElement
  render(snapshot: PlayerSnapshot): void
}

/** 成绩概况：PB 筛选、PB 表与前端 Top5；大表数据由页面控制器单独提供。 */
export function createScoreView(options: ScoreViewOptions): ScoreView {
  const softwareSelect = el('select', 'select')
  for (const option of SOFTWARE_OPTIONS) {
    const node = el('option', undefined, option.label)
    node.value = option.value
    softwareSelect.append(node)
  }

  function checkbox(label: string, title: string): { node: HTMLLabelElement; input: HTMLInputElement } {
    const wrapper = el('label', 'check')
    const input = el('input')
    input.type = 'checkbox'
    input.title = title
    wrapper.append(input, el('span', undefined, label))
    return { node: wrapper, input }
  }

  const nfCheck = checkbox('NF', '只看盲扫（网站按 right_ce = 0，CSV 按 style=NF）')
  const unapprovedCheck = checkbox('含未过审', '把未审核 / 冻结 / 标识不符 / 外部审核的录像也算进来')
  const notice = el('p', 'player-notice hidden')
  const filters = el('section', 'player-filters')
  const softwareField = el('label', 'filter')
  softwareField.append(el('span', 'filter-label', '软件'), softwareSelect)
  const nfLabel = nfCheck.node
  nfLabel.classList.add('filter')
  const unapprovedLabel = unapprovedCheck.node
  unapprovedLabel.classList.add('filter')
  const pbCount = el('span', 'source-note pb-count')
  pbCount.title = '仅用于成绩概况的 PB 筛选，不代表赛博大表的统计样本。'
  filters.append(softwareField, nfLabel, unapprovedLabel, pbCount)

  const pbTitle = el('h2', 'card-title', 'PB 表')
  const pbTabs = el('div', 'tabs')
  const pbTabButtons = new Map<PbStat, HTMLButtonElement>()
  for (const stat of PB_STATS) {
    const button = el('button', 'tab', PB_STAT_LABELS[stat])
    button.type = 'button'
    button.addEventListener('click', () => options.onFiltersChange({ pbStat: stat }))
    pbTabButtons.set(stat, button)
    pbTabs.append(button)
  }

  const pbGrids = el('div', 'pb-grids')
  const pbLevels = new Map<Level, { grid: HTMLElement; empty: HTMLElement }>()
  for (const level of LEVELS) {
    const box = el('section', 'pb-level')
    box.append(el('h3', 'pb-level-title', LEVEL_LABELS[level]))
    const grid = el('div', 'pb-grid')
    const empty = el('p', 'pb-empty', '这个级别没有符合条件的录像')
    box.append(grid, empty)
    pbGrids.append(box)
    pbLevels.set(level, { grid, empty })
  }
  const pbCard = el('section', 'card')
  const pbCardHead = el('div', 'card-head')
  pbCardHead.append(pbTitle, pbTabs)
  pbCard.append(pbCardHead, pbGrids)

  const topCard = el('section', 'card')
  const topHead = el('div', 'card-head')
  topHead.append(el('h2', 'card-title', '前端成绩（Top5）'))
  const topGrid = el('div', 'top5-grid')
  topCard.append(topHead, topGrid)
  const topTables: { nf: boolean; body: HTMLElement }[] = []
  for (const nf of [false, true]) {
    const box = el('div', 'top5-box')
    box.append(el('h3', 'top5-title', nf ? 'NF前端成绩' : '前端成绩'))
    const table = el('table', 'data-table top5-table')
    const head = el('thead')
    const headRow = el('tr')
    headRow.append(el('th', undefined, '等级'))
    for (const stat of ['time', 'bvs', 'stnb'] as TopStat[]) {
      headRow.append(el('th', undefined, PB_STAT_LABELS[stat]))
    }
    head.append(headRow)
    const body = el('tbody')
    table.append(head, body)
    box.append(table)
    topGrid.append(box)
    topTables.push({ nf, body })
  }

  softwareSelect.addEventListener('change', () => {
    options.onFiltersChange({ software: softwareSelect.value })
  })
  nfCheck.input.addEventListener('change', () => {
    options.onFiltersChange({ nfOnly: nfCheck.input.checked })
  })
  unapprovedCheck.input.addEventListener('change', () => {
    options.onFiltersChange({ includeUnapproved: unapprovedCheck.input.checked })
  })

  let lastBaseKey = ''
  let lastPbKey = ''

  function pbMetric(video: Video, stat: TopStat): number {
    if (stat === 'time') return video.timems / 1000
    if (stat === 'bvs') return bvsOf(video)
    return stnbOf(video)
  }

  function pbCell(
    row: ReturnType<typeof computePb>[number] | undefined,
    stat: PbStat,
    dateRange?: { min: number; mid: number; max: number },
  ): HTMLElement {
    const cell = el('span', 'pb-cell')
    if (!row) return cell
    let text: string
    if (stat === 'date') {
      text = formatShortDate(row.video.end_time)
      const date = Date.parse(row.video.end_time ?? '')
      const style =
        dateRange && !Number.isNaN(date)
          ? dateColorStyle(date, dateRange.min, dateRange.mid, dateRange.max)
          : null
      if (style) {
        cell.classList.add('colored')
        cell.style.backgroundColor = style.backgroundColor
        cell.style.color = style.color
      }
    } else {
      const metric = pbMetric(row.video, stat)
      text = metric.toFixed(3)
      const style = pbColorStyle(row.level, stat, metric)
      if (style) {
        cell.classList.add('colored')
        cell.style.backgroundColor = style.backgroundColor
        cell.style.color = style.color
      }
    }
    const link = videoLink(row.video.id)
    link.textContent = text
    link.className = 'pb-link'
    const icon = softwareIcon(row.video.software)
    if (icon) cell.append(icon)
    cell.append(link)
    cell.title = [
      `3BV ${row.bv} · ${softwareLabel(row.video.software)}`,
      `用时 ${formatSeconds(row.video.timems)}`,
      `3BVS ${bvsOf(row.video).toFixed(3)} · STNB ${stnbOf(row.video).toFixed(3)}`,
      `结束 ${formatEndTime(row.video.end_time)}`,
      `录像 #${row.video.id}`,
    ].join('\n')
    return cell
  }

  function renderPb(snapshot: PlayerSnapshot): void {
    const rows = computePb(snapshot.videos, {
      software: snapshot.source === 'csv' ? 'all' : snapshot.filters.software,
      nfOnly: snapshot.filters.nfOnly,
      includeUnapproved: snapshot.source === 'site' && snapshot.filters.includeUnapproved,
    })
    const byLevel = new Map<Level, ReturnType<typeof computePb>>()
    for (const row of rows) {
      const bucket = byLevel.get(row.level)
      if (bucket) bucket.push(row)
      else byLevel.set(row.level, [row])
    }
    for (const level of LEVELS) {
      const list = (byLevel.get(level) ?? []).filter(
        (row) => Number.isSafeInteger(row.bv) && row.bv >= 1 && row.bv <= MAX_BV[level],
      )
      const view = pbLevels.get(level)!
      view.grid.replaceChildren()
      view.empty.classList.toggle('hidden', list.length > 0)
      view.grid.classList.toggle('hidden', list.length === 0)
      if (list.length === 0) continue
      const byBv = new Map(list.map((row) => [row.bv, row]))
      const dates = list
        .map((row) => Date.parse(row.video.end_time ?? ''))
        .filter((date) => !Number.isNaN(date) && date > 0)
        .sort((a, b) => a - b)
      const dateRange =
        dates.length < 2
          ? undefined
          : {
              min: dates[0] as number,
              mid: medianOf(dates),
              max: dates[dates.length - 1] as number,
            }
      const starts = [...new Set(list.map((row) => Math.floor(row.bv / 10) * 10))]

      view.grid.append(el('span', 'pb-corner'))
      for (let digit = 0; digit < 10; digit += 1) {
        view.grid.append(el('span', 'pb-head', String(digit)))
      }
      for (const start of starts) {
        view.grid.append(el('span', 'pb-rowlabel', `${start}–${start + 9}`))
        for (let bv = start; bv < start + 10; bv += 1) {
          view.grid.append(pbCell(byBv.get(bv), snapshot.filters.pbStat, dateRange))
        }
      }
    }
  }

  function top5Cell(group: Top5Group | undefined, stat: TopStat): HTMLElement {
    const td = el('td', 'top5-cell')
    if (!group || group.rows.length === 0) {
      td.append(el('span', 'muted', '—'))
      return td
    }
    const list = el('ol', 'top5-list')
    for (const row of group.rows) {
      const li = el('li', 'top5-item')
      const label = stat === 'time' ? formatSeconds(row.video.timems) : row.value.toFixed(3)
      const link = videoLink(row.video.id)
      link.textContent = label
      link.classList.add('top5-value')
      link.title = `${label} · ${row.video.bv} 3BV`
      const meta = el('span', 'top5-meta', `${row.video.bv} 3BV · ${formatShortDate(row.video.end_time)}`)
      const icon = softwareIcon(row.video.software)
      if (icon) li.append(icon)
      li.append(link, meta)
      list.append(li)
    }
    td.append(list)
    return td
  }

  function renderTop(
    snapshot: PlayerSnapshot,
    floors: ReturnType<typeof loadAnalysisSettings>['bvFloors'],
  ): void {
    const groups = computeTop5(
      snapshot.videos,
      {
        includeUnapproved:
          snapshot.source === 'site' && snapshot.filters.includeUnapproved,
      },
      floors,
    )
    const index = new Map<string, Top5Group>()
    for (const group of groups) {
      index.set(`${group.nf ? 'nf' : 'std'}:${group.level}:${group.stat}`, group)
    }
    for (const { nf, body } of topTables) {
      body.replaceChildren()
      for (const level of LEVELS) {
        const tr = el('tr')
        tr.append(el('th', 'row-head', LEVEL_LABELS[level]))
        for (const stat of ['time', 'bvs', 'stnb'] as TopStat[]) {
          tr.append(top5Cell(index.get(`${nf ? 'nf' : 'std'}:${level}:${stat}`), stat))
        }
        body.append(tr)
      }
    }
  }

  function render(snapshot: PlayerSnapshot): void {
    const filtersValue = {
      software: snapshot.source === 'csv' ? 'all' : snapshot.filters.software,
      nfOnly: snapshot.filters.nfOnly,
      includeUnapproved: snapshot.filters.includeUnapproved,
    }
    softwareSelect.value = filtersValue.software
    nfCheck.input.checked = filtersValue.nfOnly
    unapprovedCheck.input.checked = filtersValue.includeUnapproved
    softwareField.classList.toggle('hidden', snapshot.source === 'csv')
    unapprovedLabel.classList.toggle('hidden', snapshot.source === 'csv')

    notice.classList.toggle(
      'hidden',
      snapshot.source !== 'site' || !snapshot.filters.includeUnapproved,
    )
    notice.textContent =
      snapshot.source === 'site' && snapshot.filters.includeUnapproved
        ? '含未过审：a 未审核 / b 冻结 / d 标识不符 / e 外部审核 都算进来了，成绩仅自用，和站点 PB 不再一致。'
        : ''

    for (const stat of PB_STATS) {
      const button = pbTabButtons.get(stat)!
      button.classList.toggle('active', snapshot.filters.pbStat === stat)
      button.setAttribute('aria-pressed', String(snapshot.filters.pbStat === stat))
    }

    const settings = loadAnalysisSettings()
    // 成绩区域只依赖数据身份 / 版本、筛选、显示指标和影响排序 / 配色的参数；
    // 进度、消息与按钮状态变化不重新扫描排序，也不替换正在查看的节点。
    const baseKey = JSON.stringify({
      source: snapshot.source,
      identity: snapshot.dataset.identity,
      version: snapshot.dataset.contentVersion,
      videos: snapshot.videos.length,
      software: filtersValue.software,
      nfOnly: filtersValue.nfOnly,
      includeUnapproved: filtersValue.includeUnapproved,
      floors: settings.bvFloors,
      colors: settings.colorThresholds,
    })
    if (baseKey !== lastBaseKey) {
      lastBaseKey = baseKey
      const counted = snapshot.videos.filter((video) => eligible(video, filtersValue)).length
      pbCount.textContent = `PB 筛选计入 ${counted} 局`
      renderTop(snapshot, settings.bvFloors)
    }
    const pbKey = `${baseKey}|${snapshot.filters.pbStat}`
    if (pbKey !== lastPbKey) {
      lastPbKey = pbKey
      renderPb(snapshot)
    }
  }

  return { filters, notice, pbCard, topCard, render }
}
