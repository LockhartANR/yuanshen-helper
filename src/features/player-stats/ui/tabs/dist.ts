import type { DistTabData } from '../../analysis-tab-data'
import { LEVELS, LEVEL_LABELS } from '../../model'
import { colorAttr, videoLink } from './common'

/** 分布：3BV 分档、Sub 率阶梯与 3BV 区间（rAvg）。 */
export function renderDistTab(data: DistTabData): string {
  const levelTabs =
    '<div class="tabs">' +
    LEVELS.map(
      (level) =>
        `<button type="button" class="tab${data.level === level ? ' active' : ''}" data-dist-level="${level}">${LEVEL_LABELS[level]}</button>`,
    ).join('') +
    '</div>'

  const bucketRows = data.buckets
    .map(
      (bucket) =>
        '<tr>' +
        `<td class="num">${bucket.start}–${bucket.end}</td>` +
        `<td class="num">${bucket.count}</td>` +
        `<td class="num">${(bucket.share * 100).toFixed(1)}%</td>` +
        `<td class="num"${colorAttr(data.level, 'time', bucket.avgTime)}>${bucket.avgTime.toFixed(3)}</td>` +
        `<td class="num"${colorAttr(data.level, 'bvs', bucket.avgBvs)}>${bucket.avgBvs.toFixed(3)}</td>` +
        `<td class="num"${colorAttr(data.level, 'stnb', bucket.avgStnb)}>${bucket.avgStnb.toFixed(1)}</td>` +
        `<td class="num"${colorAttr(data.level, 'time', bucket.best.time)}>${videoLink(bucket.best, bucket.best.time.toFixed(3), 'pb-link')}</td>` +
        '</tr>',
    )
    .join('')

  const subRows = data.subs
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

  const rangeRows = data.ranges
    .map(
      (range) =>
        '<tr>' +
        `<td class="num">${range.start}–${range.end}</td>` +
        `<td class="num">${range.count}</td>` +
        `<td class="num">${(range.share * 100).toFixed(1)}%</td>` +
        `<td class="num">${range.theoryShare === null ? '—' : `${(range.theoryShare * 100).toFixed(1)}%`}</td>` +
        `<td class="num"${range.count ? colorAttr(data.level, 'time', range.avgTime) : ''}>${range.count ? range.avgTime.toFixed(3) : '—'}</td>` +
        `<td class="num"${range.count ? colorAttr(data.level, 'bvs', range.avgBvs) : ''}>${range.count ? range.avgBvs.toFixed(3) : '—'}</td>` +
        `<td class="num"${range.count ? colorAttr(data.level, 'stnb', range.avgStnb) : ''}>${range.count ? range.avgStnb.toFixed(1) : '—'}</td>` +
        '</tr>',
    )
    .join('')

  return (
    '<div class="toolbar">' +
    levelTabs +
    `<span class="note">分析口径 3BV ≥ ${data.floorLabel} · rAvg 含初级 2–9</span>` +
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
