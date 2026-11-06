import type { MapTabData } from '../../analysis-tab-data'
import { pbColorStyle } from '../../colors'
import { LEVEL_LABELS } from '../../model'
import type { Level } from '../../model'

/** 地图：时间 × 3BVS 热图、效率前沿与狗预测。 */
export function renderMapTab(data: MapTabData): string {
  const { level, map, points } = data
  const W = 760
  const H = 400
  const padL = 48
  const padB = 34
  const padT = 10
  const padR = 10
  const cellW = (W - padL - padR) / map.cols
  const cellH = (H - padT - padB) / map.rows

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
        if (bv >= data.floorBv && bv <= data.maxBv) {
          const stnb = (data.coefficient * bv) / time ** 1.7
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

  const dogHeader = data.dog.map((item) => `<th class="num">${item.year}</th>`).join('')
  const dogPrefix = level === 'e' ? 'et' : level === 'i' ? 'it' : 'bt'
  const dogBody =
    data.dog.length === 0
      ? '<tr><td colspan="1" class="muted">暂无足够数据</td></tr>'
      : data.dogTargets
          .map((target) => {
            const cellsOfDog = data.dog
              .map((item) => {
                const cell = item.cells.find((entry) => entry.target === target)
                return `<td class="num">${cell ? (cell.probability * 100).toFixed(2) : '—'}</td>`
              })
              .join('')
            return `<tr><td>${dogPrefix}&lt;${target}</td>${cellsOfDog}</tr>`
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
