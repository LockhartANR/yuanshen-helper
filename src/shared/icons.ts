const SVG_NS = 'http://www.w3.org/2000/svg'

function makeSvg(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('class', 'icon')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  return svg
}

function add(svg: SVGSVGElement, tag: string, attrs: Record<string, string>): void {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
  svg.append(node)
}

export type IconName =
  | 'search'
  | 'settings'
  | 'refresh'
  | 'upload'
  | 'play'
  | 'pause'
  | 'chart'

export function icon(name: IconName): SVGSVGElement {
  const svg = makeSvg()

  if (name === 'search') {
    add(svg, 'circle', { cx: '11', cy: '11', r: '7' })
    add(svg, 'path', { d: 'M20 20l-4.4-4.4' })
  } else if (name === 'settings') {
    add(svg, 'path', { d: 'M4 7h16M4 12h16M4 17h16' })
    add(svg, 'circle', { cx: '9', cy: '7', r: '2.3', fill: 'currentColor', stroke: 'none' })
    add(svg, 'circle', { cx: '15', cy: '12', r: '2.3', fill: 'currentColor', stroke: 'none' })
    add(svg, 'circle', { cx: '7', cy: '17', r: '2.3', fill: 'currentColor', stroke: 'none' })
  } else if (name === 'upload') {
    add(svg, 'path', { d: 'M12 16V4' })
    add(svg, 'path', { d: 'M7.5 8.5 12 4l4.5 4.5' })
    add(svg, 'path', { d: 'M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3' })
  } else if (name === 'play') {
    add(svg, 'path', { d: 'M8 5.5 18 12 8 18.5Z', fill: 'currentColor', stroke: 'none' })
  } else if (name === 'pause') {
    add(svg, 'path', { d: 'M9.5 5v14' })
    add(svg, 'path', { d: 'M14.5 5v14' })
  } else if (name === 'chart') {
    add(svg, 'path', { d: 'M4 20v-6' })
    add(svg, 'path', { d: 'M10 20V9' })
    add(svg, 'path', { d: 'M16 20V4' })
    add(svg, 'path', { d: 'M2.5 20h19' })
  } else {
    add(svg, 'path', { d: 'M20 11a8 8 0 1 0-2.3 6.3' })
    add(svg, 'path', { d: 'M20 4v7h-7' })
  }

  return svg
}
