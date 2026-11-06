import { formatCount, formatShortDate } from '../../../../shared/format'
import type { AnalysisGame } from '../../analysis'
import type { RankTabData } from '../../analysis-tab-data'
import { LEVELS, LEVEL_LABELS } from '../../model'
import {
  colorAttr,
  dateAttr,
  formatTime,
  rowClass,
  STAT_LABELS,
  videoLink,
} from './common'

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

/** 榜单：单难度或三难度纵向排行。 */
export function renderRankTab(data: RankTabData): string {
  const triple = data.rankLayout === 'triple'
  const viewTabs =
    '<div class="tabs">' +
    LEVELS.map(
      (level) =>
        `<button type="button" class="tab${!triple && data.rankLevel === level ? ' active' : ''}" data-rank-view="${level}">${LEVEL_LABELS[level]}</button>`,
    ).join('') +
    `<button type="button" class="tab${triple ? ' active' : ''}" data-rank-view="triple">三难度</button>` +
    '</div>'
  const statTabs =
    '<div class="tabs">' +
    (['time', 'bvs', 'stnb'] as RankTabData['rankStat'][])
      .map(
        (stat) =>
          `<button type="button" class="tab${data.rankStat === stat ? ' active' : ''}" data-rank-stat="${stat}">${STAT_LABELS[stat]}</button>`,
      )
      .join('') +
    '</div>'

  const blocks = triple && data.tripleRows
    ? LEVELS.map((level) => {
        const rows = data.tripleRows![level]
        return (
          '<div class="level-block">' +
          `<div class="level-head"><span class="lv"><i></i>${LEVEL_LABELS[level]}</span><span>${formatCount(rows.length)} 局 · 前 10</span></div>` +
          rankTableHtml(rows, 10) +
          '</div>'
        )
      }).join('')
    : rankTableHtml(data.singleRows ?? [], data.limit)

  // 未限制 NF 的榜单不加「普通 / 全部」范围标注；只在真的筛了 NF 时说明「仅 NF」。
  const scope = data.nfOnly ? '仅 NF' : ''
  const subtitle = triple
    ? `三难度纵向 · 各前 10${scope ? ` · ${scope}` : ''}`
    : scope
  const subtitleHtml = subtitle ? `<span class="muted">${subtitle}</span>` : ''
  const title = triple
    ? `${STAT_LABELS[data.rankStat]} · 三难度`
    : `${STAT_LABELS[data.rankStat]} Top ${data.limit} · ${LEVEL_LABELS[data.rankLevel]}`

  return (
    '<div class="toolbar">' +
    statTabs +
    viewTabs +
    '<span class="spacer"></span>' +
    `<span class="note">3BV ≥ ${data.floorLabel} · 右键 = 0 记 NF</span>` +
    '</div>' +
    '<div class="card">' +
    `<div class="card-head"><h2 class="card-title">${title}</h2>${subtitleHtml}</div>` +
    blocks +
    '</div>'
  )
}
