import { SITE_ORIGIN } from '../../shared/constants'
import type { PlayerVideoRow } from '../../shared/db'
import { formatCount, formatDateStamp, formatDateTime } from '../../shared/format'
import { askSelfId, resolveSelfId } from '../../shared/self-id'
import { el, errorMessage, externalLink, isAbortError } from '../../shared/ui'
import { fetchUserInfo } from './api'
import { computePb, computeTop5, eligible, bvsOf, joinVideos, markDuplicates, stnbOf } from './compute'
import { pbColorStyle } from './colors'
import { softwareIcon } from './software-icon'
import type { Level, Top5Group, TopStat, Video } from './model'
import { LEVELS, softwareLabel } from './model'
import { ensureDetails, loadPlayer } from './service'

const LEVEL_LABELS: Record<Level, string> = { b: '初级', i: '中级', e: '高级' }
const STAT_LABELS: Record<TopStat, string> = { time: '用时', bvs: '3BVS', stnb: 'STNB' }

/** PB 表除了三个指标，还能切到「日期」看每条 PB 的结束日期。 */
type PbStat = TopStat | 'date'
const PB_STATS: PbStat[] = ['time', 'bvs', 'stnb', 'date']
const PB_STAT_LABELS: Record<PbStat, string> = { ...STAT_LABELS, date: '日期' }

const SOFTWARE_OPTIONS: { value: string; label: string }[] = [
  { value: 'all', label: '全部软件' },
  { value: 'a', label: 'avf' },
  { value: 'e', label: 'evf' },
  { value: 'm', label: 'mvf' },
  { value: 'r', label: 'rmv' },
]

interface UiState {
  userId: number
  rows: PlayerVideoRow[]
  videos: Video[]
  software: string
  nfOnly: boolean
  includeUnapproved: boolean
  showDuplicates: boolean
  pbStat: PbStat
  updatedAt: number
  fromCache: boolean
  loading: boolean
  message: string
}

function readUserId(): number | null {
  const value = Number(new URLSearchParams(location.search).get('id') ?? '')
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

function formatSeconds(timems: number): string {
  return (timems / 1000).toFixed(3)
}

function formatEndTime(value: string | null): string {
  if (!value) return '—'
  const time = Date.parse(value)
  return Number.isNaN(time) ? '—' : formatDateTime(time)
}

function shortDate(value: string | null): string {
  if (!value) return '—'
  const time = Date.parse(value)
  if (Number.isNaN(time)) return '—'
  const date = new Date(time)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function videoLink(id: number): HTMLAnchorElement {
  return externalLink(`#${id}`, `${SITE_ORIGIN}/#/video/${id}`)
}

function duplicateDot(video: Video): HTMLElement | null {
  if (!video.duplicate && !video.suspectDuplicate) return null
  const dot = el('span', 'pb-dot')
  dot.title = video.suspectDuplicate ? '疑似重复' : '重复'
  return dot
}

export async function mountPlayerStats(root: HTMLElement): Promise<void> {
  const userId = readUserId()
  if (userId === null) {
    root.append(el('div', 'player-error', '链接里缺少合法的用户 ID，例如 player.html?id=16。'))
    return
  }

  const state: UiState = {
    userId,
    rows: [],
    videos: [],
    software: 'all',
    nfOnly: false,
    includeUnapproved: false,
    showDuplicates: false,
    pbStat: 'time',
    updatedAt: 0,
    fromCache: false,
    loading: false,
    message: '',
  }

  let controller: AbortController | null = null

  // ---- 头部 ----
  const nameNode = el('h1', 'player-name', `#${userId}`)
  const idNode = el('span', 'player-id', `ID ${userId}`)
  const metaNode = el('p', 'player-meta', '准备中…')

  const refreshButton = el('button', 'button primary', '刷新')
  refreshButton.type = 'button'
  const cancelButton = el('button', 'button', '取消')
  cancelButton.type = 'button'
  cancelButton.classList.add('hidden')

  const header = el('header', 'player-header')
  const headerText = el('div', 'player-header-text')
  const titleRow = el('div', 'player-title')
  titleRow.append(nameNode, idNode)
  headerText.append(titleRow, metaNode)
  const selfButton = el('button', 'button', '我的成绩')
  selfButton.type = 'button'
  selfButton.title = '打开你自己账号的成绩页'
  selfButton.addEventListener('click', () => void openMyStats())

  const headerActions = el('div', 'player-actions')
  headerActions.append(
    externalLink('站点主页', `${SITE_ORIGIN}/#/player/${userId}`),
    selfButton,
    refreshButton,
    cancelButton,
  )
  header.append(headerText, headerActions)

  // ---- 筛选 ----
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

  const nfCheck = checkbox('NF', '只看盲扫（right_ce = 0）')
  const unapprovedCheck = checkbox('含未过审', '把未审核 / 冻结 / 标识不符 / 外部审核的录像也算进来')
  const duplicatesCheck = checkbox('显示重复', '显示被判定为重复或疑似重复的录像')

  const filters = el('section', 'player-filters')
  const softwareField = el('label', 'filter')
  softwareField.append(el('span', 'filter-label', '软件'), softwareSelect)
  const nfLabel = nfCheck.node
  nfLabel.classList.add('filter')
  const unapprovedLabel = unapprovedCheck.node
  unapprovedLabel.classList.add('filter')
  const duplicatesLabel = duplicatesCheck.node
  duplicatesLabel.classList.add('filter')
  filters.append(softwareField, nfLabel, unapprovedLabel, duplicatesLabel)

  const notice = el('p', 'player-notice hidden')

  const status = el('p', 'player-status')

  // ---- PB ----
  const pbTitle = el('h2', 'card-title', 'PB 表')
  const pbTabs = el('div', 'tabs')
  const pbTabButtons = new Map<PbStat, HTMLButtonElement>()
  for (const stat of PB_STATS) {
    const button = el('button', 'tab', PB_STAT_LABELS[stat])
    button.type = 'button'
    button.addEventListener('click', () => {
      state.pbStat = stat
      render()
    })
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

  // ---- 前端成绩 ----
  const topCard = el('section', 'card')
  const topHead = el('div', 'card-head')
  topHead.append(el('h2', 'card-title', '前端成绩（Top5）'))
  const topGrid = el('div', 'top5-grid')
  topCard.append(topHead, topGrid)

  const topTables: { nf: boolean; body: HTMLElement }[] = []
  for (const nf of [false, true]) {
    const box = el('div', 'top5-box')
    box.append(el('h3', 'top5-title', nf ? '仅 NF' : '全部录像'))
    const table = el('table', 'data-table top5-table')
    const head = el('thead')
    const headRow = el('tr')
    headRow.append(el('th', undefined, '等级'))
    for (const stat of ['time', 'bvs', 'stnb'] as TopStat[]) {
      headRow.append(el('th', undefined, STAT_LABELS[stat]))
    }
    head.append(headRow)
    const body = el('tbody')
    table.append(head, body)
    box.append(table)
    topGrid.append(box)
    topTables.push({ nf, body })
  }

  // ---- 挂载 ----
  const wrap = el('main', 'player-page')
  wrap.append(header, filters, notice, status, pbCard, topCard)
  root.replaceChildren(wrap)

  function options() {
    return {
      software: state.software,
      nfOnly: state.nfOnly,
      includeUnapproved: state.includeUnapproved,
      hideDuplicates: !state.showDuplicates,
    }
  }

  function rebuild(): void {
    const metas = state.rows.map((row) => ({
      id: row.id,
      upload_time: row.uploadTime,
      state: row.state,
      ongoing_tournament: row.ongoing,
    }))
    const details = new Map(
      state.rows.filter((row) => row.detail !== null).map((row) => [row.id, row.detail!]),
    )
    const { videos } = joinVideos(metas, details)
    markDuplicates(videos)
    state.videos = videos
    render()
  }

  function render(): void {
    const current = options()
    const counted = state.videos.filter((video) => eligible(video, current)).length
    const duplicates = state.videos.filter(
      (video) => video.duplicate || video.suspectDuplicate,
    ).length
    const parts = [
      `录像 ${formatCount(state.rows.length)}`,
      `计入 ${formatCount(counted)}`,
    ]
    if (duplicates > 0) parts.push(`重复 ${formatCount(duplicates)}`)
    parts.push(`更新于 ${formatDateTime(state.updatedAt)}`)
    if (state.fromCache) parts.push('（缓存）')
    metaNode.textContent = parts.join(' · ')

    notice.classList.toggle('hidden', !state.includeUnapproved)
    notice.textContent = state.includeUnapproved
      ? '含未过审：a 未审核 / b 冻结 / d 标识不符 / e 外部审核 都算进来了，成绩仅自用，和站点 PB 不再一致。'
      : ''

    refreshButton.disabled = state.loading
    cancelButton.classList.toggle('hidden', !state.loading)
    status.textContent = state.message

    for (const stat of PB_STATS) {
      const button = pbTabButtons.get(stat)!
      button.classList.toggle('active', state.pbStat === stat)
      button.setAttribute('aria-pressed', String(state.pbStat === stat))
    }

    renderPb(current)
    renderTop(current)
  }

  function pbMetric(video: Video, stat: TopStat): number {
    if (stat === 'time') return video.timems / 1000
    if (stat === 'bvs') return bvsOf(video)
    return stnbOf(video)
  }

  function pbCell(row: ReturnType<typeof computePb>[number] | undefined): HTMLElement {
    const cell = el('span', 'pb-cell')
    if (!row) return cell

    let text: string
    if (state.pbStat === 'date') {
      text = formatDateStamp(row.video.end_time)
    } else {
      const metric = pbMetric(row.video, state.pbStat)
      text = metric.toFixed(3)
      const style = pbColorStyle(row.level, state.pbStat, metric)
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

    const tag = duplicateDot(row.video)
    if (tag) cell.append(tag)

    cell.title = [
      `3BV ${row.bv} · ${softwareLabel(row.video.software)}`,
      `用时 ${formatSeconds(row.video.timems)}`,
      `3BVS ${bvsOf(row.video).toFixed(3)} · STNB ${stnbOf(row.video).toFixed(3)}`,
      `结束 ${formatEndTime(row.video.end_time)}`,
      `录像 #${row.video.id}`,
    ].join('\n')
    return cell
  }

  /**
   * 每个等级一张网格：一行十个 3BV，行首标 0–9 / 10–19。
   * 只画有成绩的 3BV 覆盖到的行，不把 0 到 381 全铺开。
   */
  function renderPb(current: ReturnType<typeof options>): void {
    const rows = computePb(state.videos, current)
    const byLevel = new Map<Level, ReturnType<typeof computePb>>()
    for (const row of rows) {
      const bucket = byLevel.get(row.level)
      if (bucket) bucket.push(row)
      else byLevel.set(row.level, [row])
    }

    for (const level of LEVELS) {
      const list = byLevel.get(level) ?? []
      const view = pbLevels.get(level)!
      view.grid.replaceChildren()
      view.empty.classList.toggle('hidden', list.length > 0)
      view.grid.classList.toggle('hidden', list.length === 0)
      if (list.length === 0) continue

      const byBv = new Map(list.map((row) => [row.bv, row]))
      const firstRow = Math.floor(list[0]!.bv / 10) * 10
      const lastRow = Math.floor(list[list.length - 1]!.bv / 10) * 10

      view.grid.append(el('span', 'pb-corner'))
      for (let digit = 0; digit < 10; digit += 1) {
        view.grid.append(el('span', 'pb-head', String(digit)))
      }

      for (let start = firstRow; start <= lastRow; start += 10) {
        view.grid.append(el('span', 'pb-rowlabel', `${start}–${start + 9}`))
        for (let bv = start; bv < start + 10; bv += 1) {
          view.grid.append(pbCell(byBv.get(bv)))
        }
      }
    }
  }

  function renderTop(current: ReturnType<typeof options>): void {
    const groups = computeTop5(state.videos, {
      includeUnapproved: current.includeUnapproved,
      hideDuplicates: current.hideDuplicates,
    })
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
      const meta = el('span', 'top5-meta', `${row.video.bv} 3BV · ${shortDate(row.video.end_time)}`)
      const icon = softwareIcon(row.video.software)
      if (icon) li.append(icon)
      li.append(link, meta)
      list.append(li)
    }
    td.append(list)
    return td
  }

  function setLoading(loading: boolean, text = ''): void {
    state.loading = loading
    status.textContent = text || state.message
    refreshButton.disabled = loading
    cancelButton.classList.toggle('hidden', !loading)
    if (loading) cancelButton.textContent = '取消'
  }

  async function runLoad(force: boolean): Promise<void> {
    if (state.loading) return
    controller = new AbortController()
    const messageAtStart = state.message
    state.message = ''
    setLoading(true, '正在获取录像列表…')
    try {
      const loaded = await loadPlayer(state.userId, {
        force,
        signal: controller.signal,
        onProgress: ({ done, total }) => setLoading(true, `正在拉取明细：${done}/${total} 批`),
      })
      state.rows = loaded.rows
      state.updatedAt = loaded.fetchedAt
      state.fromCache = loaded.fromCache
      // 加载期间用户点了别的（比如「我的成绩」）就别把提示覆盖掉。
      if (state.message === '' || state.message === messageAtStart) {
        state.message =
          loaded.missing.length > 0 ? `${loaded.missing.length} 条录像的解析字段没取到` : ''
      }
      rebuild()
      setLoading(false)
    } catch (error) {
      state.message = isAbortError(error) ? '已取消' : errorMessage(error)
      setLoading(false)
    } finally {
      controller = null
    }
  }

  /** 读站点登录态（或手动填的 ID），跳到自己的成绩页。 */
  async function openMyStats(): Promise<void> {
    selfButton.disabled = true
    try {
      let id = await resolveSelfId()
      if (id === null) id = await askSelfId(state.userId)
      if (id === null) {
        state.message = '已取消'
        return
      }
      if (id === state.userId) {
        state.message = '当前就是你的成绩页'
        return
      }
      location.href = `${location.pathname}?id=${id}`
      return
    } catch {
      state.message = '读取登录状态失败，请稍后重试'
    } finally {
      selfButton.disabled = false
      render()
    }
  }

  async function loadUnapproved(): Promise<void> {
    const ids = state.rows
      .filter((row) => row.state !== 'c' && !row.ongoing && row.detail === null)
      .map((row) => row.id)
    if (ids.length === 0) return

    controller = new AbortController()
    const previous = state.message
    setLoading(true, `正在补抓未过审录像：0/${Math.ceil(ids.length / 100)} 批`)
    try {
      const result = await ensureDetails(state.userId, state.rows, ids, {
        signal: controller.signal,
        onProgress: ({ done, total }) => setLoading(true, `正在补抓未过审录像：${done}/${total} 批`),
      })
      state.rows = result.rows
      state.message = previous
      rebuild()
      setLoading(false)
    } catch (error) {
      state.message = isAbortError(error) ? '已取消' : errorMessage(error)
      setLoading(false)
    } finally {
      controller = null
    }
  }

  softwareSelect.addEventListener('change', () => {
    state.software = softwareSelect.value
    render()
  })
  nfCheck.input.addEventListener('change', () => {
    state.nfOnly = nfCheck.input.checked
    render()
  })
  duplicatesCheck.input.addEventListener('change', () => {
    state.showDuplicates = duplicatesCheck.input.checked
    render()
  })
  unapprovedCheck.input.addEventListener('change', () => {
    state.includeUnapproved = unapprovedCheck.input.checked
    render()
    if (state.includeUnapproved) void loadUnapproved()
  })
  refreshButton.addEventListener('click', () => void runLoad(true))
  cancelButton.addEventListener('click', () => {
    controller?.abort()
    cancelButton.textContent = '取消中…'
    cancelButton.disabled = true
    setTimeout(() => {
      cancelButton.disabled = false
      cancelButton.textContent = '取消'
    }, 1_000)
  })

  void runLoad(false)

  try {
    const info = await fetchUserInfo(userId)
    if (info) {
      const name = info.username || info.realname || `#${userId}`
      nameNode.textContent = name
      idNode.textContent = `ID ${userId}`
      document.title = `${name} · 玩家数据 · 元神助手`
    }
  } catch {
    // 名字拿不到不影响主流程。
  }
}
