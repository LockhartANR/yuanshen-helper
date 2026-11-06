import { formatShortDate } from '../../../../shared/format'
import type { EffTabData } from '../../analysis-tab-data'
import type { EfficiencyMetric, OthMetric } from '../../analysis'
import { LEVELS, LEVEL_LABELS } from '../../model'
import { colorAttr, dateAttr } from './common'

const EFFICIENCY_CARDS: Array<[EfficiencyMetric, string, string, (value: number) => string]> = [
  ['cls', '点击 / 秒', 'cl/s', (value) => value.toFixed(2)],
  ['ces', '有效 / 秒', 'ce/s', (value) => value.toFixed(2)],
  ['mov', '移速', '格/秒', (value) => value.toFixed(1)],
  ['ioe', 'IOE', 'bv/cl', (value) => value.toFixed(3)],
]

const OTHER_CARDS: Array<[OthMetric, string, string, (value: number) => string]> = [
  ['invCe', '最少有效点击', '次', (value) => String(Math.round(value))],
  ['ce', '最多有效点击', '次', (value) => String(Math.round(value))],
  ['invPath', '最小路径', '1/16 格', (value) => String(Math.round(value))],
  ['invIs', '最少岛屿', '', (value) => String(Math.round(value))],
  ['invOp', '最少开空', '', (value) => String(Math.round(value))],
  ['is', '最多岛屿', '', (value) => String(Math.round(value))],
  ['op', '最多开空', '', (value) => String(Math.round(value))],
]

/** 效率：四项效率榜与七项杂项榜。 */
export function renderEffTab(data: EffTabData): string {
  const levelTabs =
    '<div class="tabs">' +
    LEVELS.map(
      (level) =>
        `<button type="button" class="tab${data.level === level ? ' active' : ''}" data-eff-level="${level}">${LEVEL_LABELS[level]}</button>`,
    ).join('') +
    '</div>'

  const body = EFFICIENCY_CARDS.map(([metric, label, unit, format]) => {
    const rows = data.efficiency[metric]
    const dates = rows.map((row) => row.game.date)
    const tableRows = rows
      .map((row, index) => {
        const color =
          metric === 'cls' || metric === 'ces'
            ? colorAttr(data.level, 'bvs', row.value)
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
  }).join('')

  const othBody = OTHER_CARDS.map(([metric, label, unit, format]) => {
    const rows = data.other[metric]
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
  }).join('')

  return (
    '<div class="toolbar">' +
    levelTabs +
    `<span class="note">每项前 ${data.smallTop} · ${LEVEL_LABELS[data.level]}</span>` +
    '</div>' +
    `<div class="eff-grid">${body}</div>` +
    '<h3 class="section-title">杂项 7 项</h3>' +
    `<div class="oth-grid">${othBody}</div>`
  )
}
