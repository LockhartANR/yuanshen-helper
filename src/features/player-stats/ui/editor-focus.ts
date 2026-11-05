export interface EditorFocusOptions {
  /** 视图根节点：编辑定位只处理根内的控件。 */
  root: HTMLElement
  /** 吸顶工具栏：高度用于滚动留白，焦点避让以它的下边缘为界。 */
  toolbar: HTMLElement
  /**
   * 面板是否正在编辑。参数面板或日期面板打开时工具栏不再吸顶，
   * 避免展开后的编辑区留在浮层里。
   */
  isEditing(): boolean
}

export interface EditorFocus {
  /** 按真实高度更新吸顶高度与留白；布局变化后由外部主动调用。 */
  updateToolbar(): void
  /** 面板脱离吸顶层后先滚到编辑区；收起时恢复入口焦点和可见位置。 */
  reveal(control: HTMLElement | null, panel?: HTMLElement): void
  /** 释放观察器、窗口监听与待执行动画帧。 */
  destroy(): void
}

/** 吸顶测量、编辑区定位、焦点避让与资源清理；不持有页面状态。 */
export function createEditorFocus(options: EditorFocusOptions): EditorFocus {
  const { root, toolbar } = options
  let revealFrame: number | null = null

  // 浮层只包含短筛选与页签；按真实高度设置滚动留白，窄矮窗口和长面板暂停吸顶。
  function updateToolbar(): void {
    const height = toolbar.getBoundingClientRect().height
    const floating = !options.isEditing() && height <= window.innerHeight * 0.4
    toolbar.classList.toggle('is-static', !floating)
    root.style.setProperty('--analysis-toolbar-height', floating ? `${height}px` : '0px')
  }

  function reveal(control: HTMLElement | null, panel?: HTMLElement): void {
    updateToolbar()
    if (revealFrame !== null) window.cancelAnimationFrame(revealFrame)
    // 等展开与取消吸顶的布局完成，避免浏览器滚动锚定抵消本次定位。
    revealFrame = window.requestAnimationFrame(() => {
      revealFrame = null
      const target = panel ?? control
      if (!target?.isConnected || !root.contains(target)) return
      control?.focus({ preventScroll: true })
      target.scrollIntoView({ block: panel ? 'start' : 'nearest', behavior: 'instant' })
    })
  }

  function keepFocusVisible(event: FocusEvent): void {
    const target = event.target as HTMLElement | null
    if (!target || toolbar.contains(target) || toolbar.classList.contains('is-static')) return
    if (target.getBoundingClientRect().top < toolbar.getBoundingClientRect().bottom) {
      target.scrollIntoView({ block: 'center' })
    }
  }

  const toolbarObserver = new ResizeObserver(updateToolbar)
  toolbarObserver.observe(toolbar)
  window.addEventListener('resize', updateToolbar)
  root.addEventListener('focusin', keepFocusVisible)

  function destroy(): void {
    if (revealFrame !== null) {
      window.cancelAnimationFrame(revealFrame)
      revealFrame = null
    }
    toolbarObserver.disconnect()
    window.removeEventListener('resize', updateToolbar)
    root.removeEventListener('focusin', keepFocusVisible)
  }

  return { updateToolbar, reveal, destroy }
}
