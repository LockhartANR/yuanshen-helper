/**
 * 侧栏焦点边界只统计实际可见、可聚焦的控件。
 * `<details>` 折叠时内部按钮虽然 hidden=false，但仍不可见；summary 本身可聚焦。
 */
export function isFocusableControl(node: HTMLElement): boolean {
  if (node.hidden) return false
  if (node.getAttribute('aria-hidden') === 'true') return false
  if (node.tabIndex < 0) return false
  if ((node as HTMLButtonElement).disabled) return false

  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    if (parent.hidden || parent.getAttribute('aria-hidden') === 'true') return false
  }

  const closedDetails = node.closest('details:not([open])')
  if (closedDetails && node.tagName.toLowerCase() !== 'summary') return false

  if (typeof node.getClientRects === 'function' && node.getClientRects().length === 0) {
    return false
  }
  return true
}
