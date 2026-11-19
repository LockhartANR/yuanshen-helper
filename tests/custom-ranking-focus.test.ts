import { describe, expect, it } from 'vitest'
import { isFocusableControl } from '../src/features/custom-ranking/focus'

function fake(overrides: Partial<Record<string, unknown>> = {}): HTMLElement {
  return {
    hidden: false,
    tabIndex: 0,
    disabled: false,
    parentElement: null,
    tagName: 'BUTTON',
    getAttribute: () => null,
    closest: () => null,
    getClientRects: () => [{}],
    ...overrides,
  } as unknown as HTMLElement
}

describe('侧栏焦点边界', () => {
  it('折叠 details 内按钮不可聚焦，但 summary 可以', () => {
    const closed = {}
    expect(isFocusableControl(fake({ closest: () => closed }))).toBe(false)
    expect(isFocusableControl(fake({ closest: () => closed, tagName: 'SUMMARY' }))).toBe(true)
    expect(isFocusableControl(fake({ closest: () => null }))).toBe(true)
  })

  it('排除 hidden、隐藏祖先、禁用和不可见元素', () => {
    expect(isFocusableControl(fake({ hidden: true }))).toBe(false)
    expect(
      isFocusableControl(fake({ parentElement: fake({ hidden: true }) })),
    ).toBe(false)
    expect(isFocusableControl(fake({ disabled: true }))).toBe(false)
    expect(isFocusableControl(fake({ tabIndex: -1 }))).toBe(false)
    expect(isFocusableControl(fake({ getClientRects: () => [] }))).toBe(false)
  })
})
