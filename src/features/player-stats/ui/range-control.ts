import { formatDateInput, RANGE_OPTIONS } from '../analysis-range'
import type { CustomRange, RangeKey } from '../analysis-range'
import type { RangeControlOwner } from '../analysis-state'
import { escapeHtml } from '../../../shared/ui'

export function rangeSelectHtml(
  owner: RangeControlOwner,
  uiKey: RangeKey,
  editable = false,
): string {
  const options = RANGE_OPTIONS.map(
    (option) =>
      `<option value="${option.key}"${option.key === uiKey ? ' selected' : ''}>${option.label}</option>`,
  ).join('')
  const select = `<select class="select range-select" data-range-select="${owner}" aria-label="时段">${options}</select>`
  if (!editable) return select
  return (
    select +
    `<button type="button" class="button range-edit" data-range-edit="${owner}" aria-label="编辑自定义日期范围">编辑日期</button>`
  )
}

export function rangePanelHtml(
  owner: RangeControlOwner,
  draft: CustomRange,
  error: string,
  now: number,
): string {
  const max = formatDateInput(now)
  return (
    `<div class="range-panel" data-range-panel="${owner}">` +
    '<label class="range-field"><span>开始日期</span>' +
    `<input class="range-input" type="date" data-range-date="start" value="${draft.start}" max="${max}" required></label>` +
    '<label class="range-field"><span>结束日期</span>' +
    `<input class="range-input" type="date" data-range-date="end" value="${draft.end}" max="${max}" required></label>` +
    '<button type="button" class="button" data-range-apply>应用</button>' +
    '<button type="button" class="button" data-range-cancel>取消</button>' +
    `<span class="range-error" data-range-error role="alert">${escapeHtml(error)}</span>` +
    '</div>'
  )
}
