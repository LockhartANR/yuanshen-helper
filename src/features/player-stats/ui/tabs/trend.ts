import { formatShortDate } from '../../../../shared/format'
import { escapeHtml } from '../../../../shared/ui'
import {
  MONTH_BVS_TIERS,
  MONTH_TIME_TIERS,
} from '../../analysis'
import type { CopyPreview, TrendTabData } from '../../analysis-tab-data'
import {
  formatCopyMonth,
  formatCopyWeek,
  formatWeekDelta,
  MONTH_COPY_FIELDS,
  MONTH_COPY_GROUPS,
  weekDeltaClass,
  YEAR_COPY_FIELDS,
} from '../../trend-copy'
import { LEVELS, LEVEL_LABELS } from '../../model'
import { colorAttr, formatTime, numColorAttr } from './common'

type CopySettingsScope = 'month' | 'year'

function trendCopyCell(
  kind: 'month' | 'year',
  key: string | number,
  level: TrendTabData['monthLevel'],
  disabled = false,
): string {
  // 按钮上展示的日期也走复制格式；回查仍用 data-copy-key 里的内部键。
  const shown = kind === 'month' ? formatCopyMonth(String(key)) : String(key)
  const label = `复制 ${shown} ${LEVEL_LABELS[level]}${kind === 'month' ? '月均' : '年汇总'}数据`
  return '<td class="copy-cell">' +
    `<button type="button" class="copy-button" data-copy-kind="${kind}" data-copy-key="${key}" data-copy-level="${level}" aria-label="${label}" title="${disabled ? '当月没有局数' : label}"${disabled ? ' disabled' : ''}>复制</button>` +
    '</td>'
}

/** 周复制按钮的可访问名称带完整周一至周日日期；没有成绩的周不渲染按钮。 */
function weekCopyCell(start: number): string {
  const label = `复制 ${formatCopyWeek(start).replace('–', ' 至 ')} 周成绩`
  return '<td class="copy-cell">' +
    `<button type="button" class="copy-button" data-copy-kind="week" data-copy-week="${start}" aria-label="${label}" title="${label}">复制</button>` +
    '</td>'
}

function copyFieldRows(data: TrendTabData, scope: CopySettingsScope, level?: TrendTabData['monthLevel']): string {
  const selected: readonly string[] =
    scope === 'month' ? data.monthCopyFields : data.yearCopyFields
  const checkbox = (field: string, label: string, id: string): string =>
    `<label class="check copy-field"><input type="checkbox" id="${id}" data-copy-scope="${scope}" data-copy-field="${field}"${selected.includes(field) ? ' checked' : ''}> ${label}</label>`
  if (scope === 'year') {
    return (
      '<div class="copy-field-row"><span class="copy-group">可选指标</span>' +
      YEAR_COPY_FIELDS.map((spec) =>
        checkbox(spec.field, spec.label, `copy-year-${spec.field}-${level}`),
      ).join('') +
      '</div>'
    )
  }
  return MONTH_COPY_GROUPS.map((group) => {
    const specs = MONTH_COPY_FIELDS.filter((spec) => spec.group === group.key)
    return (
      '<div class="copy-field-row">' +
      `<span class="copy-group">${group.label}</span>` +
      specs.map((spec) => checkbox(spec.field, spec.label, `copy-month-${spec.field}`)).join('') +
      '</div>'
    )
  }).join('')
}

/** 月均与年汇总卡片共用的设置区；数据里已带好预览与可选字段。 */
function copySettingsHtml(
  data: TrendTabData,
  scope: CopySettingsScope,
  level?: TrendTabData['monthLevel'],
): string {
  const month = scope === 'month'
  const id = month ? 'month-copy-settings' : `year-copy-settings-${level}`
  const open = month ? data.monthCopyOpen : level !== undefined && data.yearCopyOpen[level]
  const preview: CopyPreview = month
    ? data.monthPreview
    : level !== undefined
      ? data.yearPreviews[level]
      : { title: '复制预览', text: '暂无数据可预览' }
  return (
    `<section class="copy-settings${open ? '' : ' hidden'}" id="${id}"${month ? '' : ` data-level="${level}"`}>` +
    '<div class="copy-settings-head"><h3>复制设置</h3>' +
    (month ? '' : '<span class="copy-shared">适用于三个难度</span>') +
    '</div>' +
    `<p class="copy-fixed">固定内容：${month ? '月份' : '年份'}与难度、局数概况、平均成绩（始终保留）</p>` +
    `<div class="copy-field-groups">${copyFieldRows(data, scope, level)}</div>` +
    `<div class="copy-preview" data-copy-preview="${scope}"${month ? '' : ` data-level="${level}"`}>` +
    `<p class="copy-preview-title">${escapeHtml(preview.title)}</p>` +
    `<pre class="copy-preview-text">${escapeHtml(preview.text)}</pre>` +
    '</div>' +
    '<div class="copy-settings-foot">' +
    `<button type="button" class="button" data-copy-reset="${scope}">恢复默认</button>` +
    '<span class="muted">修改后自动保存</span>' +
    '</div>' +
    '</section>'
  )
}

function weekRows(data: TrendTabData): string {
  return data.weeks
    .map(({ week, delta }) => {
      const levelBlock = (level: TrendTabData['monthLevel']): string => {
        const levelData = week.levels[level]
        const prefix = level
        const rows = levelData.slots
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
          `<div class="week-level-head">${LEVEL_LABELS[level]} · ${levelData.slot} 条</div>` +
          '<table class="data-table week-slot-table">' +
          `<thead><tr><th class="num">排名</th><th class="num"><abbr title="${LEVEL_LABELS[level]}用时">${prefix}t</abbr></th><th class="num"><abbr title="${LEVEL_LABELS[level]} 3BVS">${prefix}b</abbr></th><th class="num"><abbr title="${LEVEL_LABELS[level]} STNB">${prefix}s</abbr></th></tr></thead>` +
          `<tbody>${rows}` +
          `<tr class="week-total"><td>总计</td><td class="num">${levelData.totals.time.toFixed(3)}</td><td class="num">${levelData.totals.bvs.toFixed(3)}</td><td class="num">${levelData.totals.stnb.toFixed(2)}</td></tr>` +
          `<tr class="week-average"><td>平均</td><td class="num"${colorAttr(level, 'time', levelData.averages.time)}>${levelData.averages.time.toFixed(3)}</td><td class="num"${colorAttr(level, 'bvs', levelData.averages.bvs)}>${levelData.averages.bvs.toFixed(3)}</td><td class="num"${colorAttr(level, 'stnb', levelData.averages.stnb)}>${levelData.averages.stnb.toFixed(2)}</td></tr>` +
          '</tbody></table></div>'
        )
      }
      const detail =
        `<tr id="week-detail-${week.start}" class="week-detail hidden"><td colspan="8"><h3 class="week-detail-title">${formatShortDate(week.start)} 当周明细</h3><div class="week-level-grid">` +
        `<div class="week-level-column">${levelBlock('b')}</div>` +
        `<div class="week-level-column">${levelBlock('i')}${levelBlock('e')}</div>` +
        '</div>' +
        '<div class="week-summary">' +
        `<span><abbr title="三难度槽位的用时总和">T.37</abbr> <b>${week.t37.toFixed(2)}</b></span>` +
        `<span><abbr title="三难度槽位的 3BVS 总和">B.37</abbr> <b>${week.b37.toFixed(3)}</b></span>` +
        `<span><abbr title="三难度槽位的 STNB 总和">S.37</abbr> <b>${week.s37.toFixed(1)}</b></span>` +
        `<span><abbr title="初级 ${week.levels.b.slot} 个槽位的 PPP 评分">BPP${week.levels.b.slot}</abbr> <b>${week.levels.b.ppp.toFixed(2)}</b></span>` +
        `<span><abbr title="中级 ${week.levels.i.slot} 个槽位的 PPP 评分">IPP${week.levels.i.slot}</abbr> <b>${week.levels.i.ppp.toFixed(2)}</b></span>` +
        `<span><abbr title="高级 ${week.levels.e.slot} 个槽位的 PPP 评分">EPP${week.levels.e.slot}</abbr> <b>${week.levels.e.ppp.toFixed(2)}</b></span>` +
        `<span><abbr title="三难度 37 个槽位的 PPP 综合成绩">PPP37</abbr> <b>${week.ppp.toFixed(2)}</b></span>` +
        '</div></td></tr>'
      return (
        '<tr class="week-row" data-week-row="1">' +
        `<td class="date"><button type="button" class="week-toggle" data-week-toggle aria-expanded="false" aria-controls="week-detail-${week.start}" aria-label="展开 ${formatShortDate(week.start)} 当周明细"><span class="week-arrow" aria-hidden="true">▸</span>${formatShortDate(week.start)}</button></td>` +
        `<td class="num">${week.count}</td>` +
        `<td class="num">${week.t37.toFixed(1)}</td>` +
        `<td class="num">${week.b37.toFixed(1)}</td>` +
        `<td class="num">${week.s37.toFixed(1)}</td>` +
        `<td class="num">${week.ppp.toFixed(3)}</td>` +
        `<td class="num ${weekDeltaClass(delta)}">${formatWeekDelta(delta)}</td>` +
        weekCopyCell(week.start) +
        '</tr>' +
        detail
      )
    })
    .join('')
}

function monthRows(data: TrendTabData): string {
  const level = data.monthLevel
  return data.months
    .map((month) => {
      const copyCell = trendCopyCell('month', month.key, level, month.count === 0)
      if (month.count === 0) {
        return (
          '<tr>' +
          `<td class="date">${month.key}</td>` +
          `<td class="num">${month.days}</td>` +
          '<td class="num">0</td>' +
          '<td class="num" colspan="17" style="text-align:left">—</td>' +
          copyCell +
          '</tr>'
        )
      }
      const statsCells = month.hasScores
        ? `<td class="num">${month.gamesPerDay.toFixed(1)}</td>` +
          `<td class="num"${colorAttr(level, 'time', month.avgTime)}>${formatTime(month.avgTime)}</td>` +
          `<td class="num">${formatTime(month.medianTime)}</td>` +
          `<td class="num">${month.avgBv.toFixed(1)}</td>` +
          `<td class="num"${colorAttr(level, 'bvs', month.avgBvs)}>${month.avgBvs.toFixed(3)}</td>` +
          `<td class="num"${colorAttr(level, 'stnb', month.avgStnb)}>${month.avgStnb.toFixed(1)}</td>` +
          `<td class="num">${month.hasOp ? month.avgOp.toFixed(1) : '—'}</td>` +
          `<td class="num">${month.hasIs ? month.avgIs.toFixed(1) : '—'}</td>` +
          `<td class="num"${month.hasCl ? colorAttr(level, 'bvs', month.avgCls) : ''}>${month.hasCl ? month.avgCls.toFixed(2) : '—'}</td>` +
          `<td class="num"${month.hasCe ? colorAttr(level, 'bvs', month.avgCes) : ''}>${month.hasCe ? month.avgCes.toFixed(2) : '—'}</td>` +
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
        '<tr class="month-detail hidden"><td colspan="21">' +
        (month.hasScores
          ? '<div class="month-tier-grid">' +
            tierBlock('用时分档', MONTH_TIME_TIERS[level], month.timeTierShare) +
            tierBlock('3BVS 分档', MONTH_BVS_TIERS[level], month.bvsTierShare) +
            '</div>'
          : '<p class="muted">当月只有低于 3BV 下限的录像，没有有效成绩。</p>') +
        '</td></tr>'

      return (
        '<tr class="month-row" data-month-row="1">' +
        `<td class="date"><span class="month-arrow">▸</span>${month.key}</td>` +
        `<td class="num">${month.days}</td>` +
        `<td class="num">${month.count}</td>` +
        statsCells +
        copyCell +
        '</tr>' +
        detail
      )
    })
    .join('')
}

function yearTables(data: TrendTabData): string {
  return LEVELS.map((level) => {
    const years = data.years[level]
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
          trendCopyCell('year', year.year, level) +
          '</tr>'
        )
      })
      .join('')
    return (
      '<div class="card year-block">' +
      '<div class="card-head">' +
      `<h3 class="card-title">年汇总 · ${LEVEL_LABELS[level]}</h3>` +
      '<div class="month-tools">' +
      '<span class="muted">按年份聚合</span>' +
      `<button type="button" class="button" data-copy-panel="year" aria-expanded="${data.yearCopyOpen[level]}" aria-controls="year-copy-settings-${level}">复制设置</button>` +
      '</div></div>' +
      copySettingsHtml(data, 'year', level) +
      '<table class="data-table year-table">' +
      '<thead><tr><th>年份</th><th class="num">局数</th><th class="num">平均用时</th><th class="num">平均 3BV</th><th class="num">平均 3BVS</th><th class="num">平均 STNB</th><th class="num">cl/s</th><th class="num">ce/s</th><th class="num">移速</th><th class="num">新 PB</th><th class="copy-cell"></th></tr></thead>' +
      `<tbody>${rows || '<tr><td colspan="11" class="muted">没有数据</td></tr>'}</tbody>` +
      '</table></div>'
    )
  }).join('')
}

/** 趋势：周 T37、月均明细与年汇总，复制文本与设置预览都来自展示数据。 */
export function renderTrendTab(data: TrendTabData): string {
  const levelTabs =
    '<div class="tabs">' +
    LEVELS.map(
      (level) =>
        `<button type="button" class="tab${data.monthLevel === level ? ' active' : ''}" data-trend-level="${level}">${LEVEL_LABELS[level]}</button>`,
    ).join('') +
    '</div>'
  const monthTools =
    '<div class="month-tools">' +
    `<label class="check"><input type="checkbox" id="analysis-hide-empty"${data.hideEmptyMonths ? ' checked' : ''}> 隐藏无数据月份</label>` +
    levelTabs +
    `<button type="button" class="button" data-copy-panel="month" aria-expanded="${data.monthCopyOpen}" aria-controls="month-copy-settings">复制设置</button>` +
    '</div>'
  const weeks = weekRows(data)

  return (
    '<div class="card">' +
    '<div class="card-head"><h2 class="card-title">周 T37</h2><span class="muted">按参数槽位取用时 / 3BVS / STNB · T37 越小越好 · 点周行展开三级明细</span></div>' +
    '<div class="table-scroll">' +
    '<table class="data-table week-table">' +
    '<thead><tr><th>周起始</th><th class="num">局数</th><th class="num">T37</th><th class="num">B37</th><th class="num">S37</th><th class="num">ppp</th><th class="num">ΔT37</th><th class="copy-cell"></th></tr></thead>' +
    `<tbody>${weeks || '<tr><td colspan="8" class="muted">没有数据</td></tr>'}</tbody>` +
    '</table>' +
    '</div>' +
    '</div>' +

    '<div class="card">' +
    `<div class="card-head"><h2 class="card-title">月均明细 · ${LEVEL_LABELS[data.monthLevel]}</h2>${monthTools}</div>` +
    copySettingsHtml(data, 'month') +
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
    '<th class="copy-cell"></th>' +
    '</tr><tr>' +
    '<th class="num">用时</th><th class="num">中位</th><th class="num">3BV</th><th class="num">3BVS</th><th class="num">STNB</th>' +
    '<th class="num">op</th><th class="num">is</th>' +
    '<th class="num">cl/s</th><th class="num">ce/s</th>' +
    '<th class="num">corr</th><th class="num">thrp</th>' +
    '<th class="num">格</th><th class="num">移速</th>' +
    '<th class="num">1/破率</th><th class="num">头部</th><th class="num">新 PB</th>' +
    '<th class="copy-cell"></th>' +
    '</tr></thead>' +
    `<tbody>${monthRows(data) || '<tr><td colspan="21" class="muted">没有数据</td></tr>'}</tbody>` +
    '</table>' +
    '</div>' +
    '</div>' +

    '<div class="year-stack">' +
    yearTables(data) +
    '</div>'
  )
}
