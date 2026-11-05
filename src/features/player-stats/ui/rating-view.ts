import { formatLsf } from '../lsf-history'
import { LEVEL_LABELS } from '../model'
import type { RatingSnapshot } from '../ratings'

/** 定阶总览的表头；列顺序与数值列在同一个文件里定义。 */
const LSF_TABLE_COLUMNS = ['级别', '软实力', 'NF软实力', 'LSF', '定阶', 'NF定阶'] as const

function rankCell(title: string, progress: number): string {
  return `<td class="rank-cell"><b>${title}</b> <span class="muted">${progress.toFixed(1)}</span></td>`
}

export interface RatingOverviewOptions {
  anchorMode: 'workbook' | 'site'
  anchorError: boolean
}

/** 概览与梁山分页签共用的定阶总览表；行、列与精度只在这里定义一次。 */
export function ratingOverviewHtml(
  rating: RatingSnapshot,
  options: RatingOverviewOptions,
): string {
  const source = options.anchorMode === 'site' ? '网站锚点' : '大表锚点'
  const row = (
    name: string,
    soft: number,
    nfSoft: number,
    lsf: number,
    title: string,
    progress: number,
    nfTitle: string,
    nfProgress: number,
    total = false,
  ): string =>
    `<tr${total ? ' class="total"' : ''}>` +
    `<th scope="row">${name}</th>` +
    `<td class="num">${soft.toFixed(1)}</td>` +
    `<td class="num">${nfSoft.toFixed(1)}</td>` +
    `<td class="num">${formatLsf(lsf)}</td>` +
    rankCell(title, progress) +
    rankCell(nfTitle, nfProgress) +
    '</tr>'

  const levelRows = rating.levels
    .map((item) =>
      row(
        LEVEL_LABELS[item.level],
        item.soft,
        item.nfSoft,
        item.lsf,
        item.title,
        item.progress,
        item.nfTitle,
        item.nfProgress,
      ),
    )
    .join('')

  const numericColumns = new Set([1, 2, 3])
  const head = LSF_TABLE_COLUMNS.map(
    (label, index) => `<th${numericColumns.has(index) ? ' class="num"' : ''}>${label}</th>`,
  ).join('')
  // 综合是合计行，放在三个级别下面，方便先看各级再看汇总。
  const totalRow = row(
    '综合',
    rating.soft,
    rating.nfSoft,
    rating.lsf,
    rating.title,
    rating.progress,
    rating.nfTitle,
    rating.nfProgress,
    true,
  )

  return (
    '<div class="card lsf-overview">' +
    '<div class="card-head"><h2 class="card-title">定阶总览</h2>' +
    `<span class="muted">综合定阶 ${rating.title} ${rating.progress.toFixed(1)} · ${source}</span></div>` +
    '<div class="table-scroll"><table class="data-table lsf-table">' +
    `<thead><tr>${head}</tr></thead>` +
    '<tbody>' +
    levelRows +
    totalRow +
    '</tbody></table></div>' +
    (options.anchorError
      ? `<p class="lsf-tip anchor-error">锚点刷新失败，继续用已保存的${source}</p>`
      : '') +
    '</div>'
  )
}
