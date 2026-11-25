import { SITE_ORIGIN } from '../../shared/constants'
import { formatCount } from '../../shared/format'
import { el, errorMessage, externalLink } from '../../shared/ui'
import { loadRankingVideoDetails, type VideoDetailQuery } from './video-details'
import { pageCount, pageRows } from './ranking'

const PAGE_SIZE = 50

export async function showRankingVideoDetails(
  root: HTMLElement,
  query: VideoDetailQuery,
  titleText: string,
  onClose: () => void,
): Promise<void> {
  const dialog = el('dialog', 'ranking-video-dialog')
  dialog.setAttribute('aria-label', titleText)
  const title = el('h2', undefined, titleText)
  const close = el('button', 'button', '关闭')
  close.type = 'button'
  close.autofocus = true
  const header = el('div', 'ranking-video-header')
  header.append(title, close)
  const formula = el('code', 'ranking-video-formula', query.formula.source)
  const status = el('p', undefined, '正在读取录像…')
  status.setAttribute('role', 'status')
  dialog.append(header, formula, status)

  const controller = new AbortController()
  close.addEventListener('click', () => dialog.close())
  dialog.addEventListener('keydown', (event) => {
    // 保留原生对话框的 Escape 和 Tab 行为，避免页面侧栏也处理这些键。
    if (event.key === 'Escape' || event.key === 'Tab') event.stopPropagation()
  })
  dialog.addEventListener('close', () => {
    controller.abort()
    dialog.remove()
    onClose()
  }, { once: true })
  root.append(dialog)
  dialog.showModal()

  try {
    const { videos, validCount } = await loadRankingVideoDetails(query, controller.signal)
    if (!dialog.open) return
    const summary = query.formula.aggregate === 'sum'
      ? `${formatCount(videos.length)} 局计入求和`
      : `${formatCount(validCount)} 局参与比较 · ${formatCount(videos.length)} 局取到${query.formula.aggregate === 'min' ? '最小值' : '最大值'}`
    status.textContent = `指标值 ${query.value} · ${summary}`
    if (videos.length === 0) return

    const table = el('table', 'ranking-table ranking-video-table')
    const head = el('thead')
    const headRow = el('tr')
    headRow.append(el('th', undefined, '录像'), el('th', 'num', '逐局值'))
    for (const field of query.formula.fields) headRow.append(el('th', undefined, field))
    head.append(headRow)
    const body = el('tbody')
    table.append(head, body)
    const tableWrap = el('div', 'ranking-video-table-wrap')
    tableWrap.append(table)
    dialog.append(tableWrap)

    const pages = pageCount(videos, PAGE_SIZE)
    let page = 0
    const pager = el('div', 'ranking-pager')
    const previous = el('button', 'button', '上一页')
    const next = el('button', 'button', '下一页')
    previous.type = next.type = 'button'
    const pageLabel = el('span')
    pageLabel.setAttribute('role', 'status')
    function renderPage(): void {
      const rows = pageRows(videos, page, PAGE_SIZE).map((video) => {
        const row = el('tr')
        const link = el('td')
        link.append(externalLink(`#${video.videoId}`, `${SITE_ORIGIN}/#/video/${video.videoId}`))
        row.append(link, el('td', 'num', String(video.value)))
        for (const value of video.fields) row.append(el('td', undefined, value === null ? '—' : String(value)))
        return row
      })
      body.replaceChildren(...rows)
      previous.disabled = page === 0
      next.disabled = page + 1 === pages
      pageLabel.textContent = `第 ${page + 1} / ${pages} 页`
      tableWrap.scrollTop = 0
    }
    if (pages > 1) {
      previous.addEventListener('click', () => {
        page -= 1
        renderPage()
      })
      next.addEventListener('click', () => {
        page += 1
        renderPage()
      })
      pager.append(previous, pageLabel, next)
      dialog.append(pager)
    }
    renderPage()
  } catch (error) {
    if (dialog.open) status.textContent = `读取录像明细失败：${errorMessage(error)}`
  }
}
