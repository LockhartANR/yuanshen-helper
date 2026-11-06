import { formatCount, formatShortDate } from '../../../../shared/format'
import type { PeriodTabData } from '../../analysis-tab-data'
import type { PeriodMode } from '../../analysis'
import { LEVELS, LEVEL_LABELS } from '../../model'
import { colorAttr, dateAttr, formatTime, rowClass, STAT_LABELS, videoLink } from './common'

/** 月年：按月或年分组后，展示所选周期的 Top 排行。 */
export function renderPeriodTab(data: PeriodTabData): string {
  const selected = data.selected
  if (!selected) {
    return '<div class="card"><div class="card-body"><p class="muted">这个难度还没有数据</p></div></div>'
  }
  const modeTabs =
    '<div class="tabs">' +
    ([
      ['month', '月 Top'],
      ['year', '年 Top'],
    ] as Array<[PeriodMode, string]>)
      .map(
        ([mode, label]) =>
          `<button type="button" class="tab${data.mode === mode ? ' active' : ''}" data-period-mode="${mode}">${label}</button>`,
      )
      .join('') +
    '</div>'
  const levelTabs =
    '<div class="tabs">' +
    LEVELS.map(
      (level) =>
        `<button type="button" class="tab${data.level === level ? ' active' : ''}" data-period-level="${level}">${LEVEL_LABELS[level]}</button>`,
    ).join('') +
    '</div>'
  const statTabs =
    '<div class="tabs">' +
    (['time', 'bvs', 'stnb'] as PeriodTabData['stat'][])
      .map(
        (stat) =>
          `<button type="button" class="tab${data.stat === stat ? ' active' : ''}" data-period-stat="${stat}">${STAT_LABELS[stat]}</button>`,
      )
      .join('') +
    '</div>'
  const select =
    `<select class="select" id="period-select">` +
    data.groups
      .map(
        (group) =>
          `<option value="${group.key}"${group.key === selected.key ? ' selected' : ''}>${group.key}</option>`,
      )
      .join('') +
    '</select>'

  const dates = data.rows.map((game) => game.date)
  const body = data.rows
    .map(
      (game, index) =>
        `<tr${rowClass(index)}>` +
        `<td class="rank">${index + 1}</td>` +
        `<td class="num">${game.bv}</td>` +
        `<td class="num"${colorAttr(data.level, 'time', game.time)}>${videoLink(game, formatTime(game.time), 'pb-link')}</td>` +
        `<td class="num"${colorAttr(data.level, 'bvs', game.bvs)}>${game.bvs.toFixed(3)}</td>` +
        `<td class="num"${colorAttr(data.level, 'stnb', game.stnb)}>${game.stnb.toFixed(1)}</td>` +
        `<td class="num">${game.hasCe ? game.ce : '—'}</td>` +
        `<td class="num">${game.hasCl ? (game.cl / game.time).toFixed(2) : '—'}</td>` +
        `<td class="date"${dateAttr(game.date, dates)}>${formatShortDate(game.date)}</td>` +
        '</tr>',
    )
    .join('')

  return (
    '<div class="toolbar">' +
    modeTabs +
    levelTabs +
    statTabs +
    select +
    `<span class="note">每期前 ${data.limit} · ${LEVEL_LABELS[data.level]}</span>` +
    '</div>' +
    '<div class="card">' +
    `<div class="card-head"><h2 class="card-title">${data.mode === 'month' ? '月' : '年'} Top · ${selected.key}</h2><span class="muted">${STAT_LABELS[data.stat]} 排序 · ${formatCount(selected.count)} 局（含低于下限的局）</span></div>` +
    '<table class="data-table rank-table">' +
    '<thead><tr><th class="num">名次</th><th class="num">3BV</th><th class="num">用时</th><th class="num">3BVS</th><th class="num">STNB</th><th class="num">有效点击</th><th class="num">点击/秒</th><th>日期</th></tr></thead>' +
    `<tbody>${body || '<tr><td colspan="8" class="muted">没有数据</td></tr>'}</tbody>` +
    '</table>' +
    '</div>'
  )
}
