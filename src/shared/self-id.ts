import { getSettings, saveSettings } from './settings'
import { el } from './ui'

/**
 * 「我的成绩」用哪个 ID：优先站点页面缓存下来的登录账号，其次用户手动填的。
 * 站点 cookie 是 SameSite=Lax，扩展页读不到登录态，所以只读缓存。
 */
export async function resolveSelfId(): Promise<number | null> {
  try {
    const response = (await chrome.runtime.sendMessage({ type: 'SELF_ID' })) as
      | { ok?: boolean; userId?: number | null; loggedIn?: boolean | null }
      | undefined
    if (response?.ok && response.loggedIn !== false && typeof response.userId === 'number') {
      return response.userId
    }
  } catch {
    // 后台暂时问不到就退回手动 ID
  }
  const settings = await getSettings()
  return settings.selfUserId
}

/** 弹一个小框让用户填站内 ID，返回 null 表示取消。 */
export function askSelfId(initial: number | null): Promise<number | null> {
  return new Promise((resolve) => {
    const overlay = el('div', 'self-id-overlay')
    const box = el('form', 'self-id-box')
    box.noValidate = true

    box.append(
      el('h2', 'self-id-title', '你的站内 ID'),
      el(
        'p',
        'self-id-desc',
        '用于「我的成绩」。打开 openms.top 的任意个人页，地址里的数字就是 ID，例如 /#/player/16。',
      ),
    )

    const input = el('input', 'self-id-input') as HTMLInputElement
    input.type = 'text'
    input.inputMode = 'numeric'
    input.autocomplete = 'off'
    input.placeholder = '例如 16'
    input.value = initial === null ? '' : String(initial)
    input.setAttribute('aria-label', '站内用户 ID')

    const error = el('p', 'self-id-error')
    error.hidden = true

    const actions = el('div', 'self-id-actions')
    const cancelButton = el('button', 'button', '取消')
    cancelButton.type = 'button'
    const saveButton = el('button', 'button primary', '保存并打开')
    saveButton.type = 'submit'
    actions.append(cancelButton, saveButton)

    box.append(input, error, actions)
    overlay.append(box)
    document.body.append(overlay)
    input.focus()
    input.select()

    const close = (value: number | null): void => {
      document.removeEventListener('keydown', onKey)
      overlay.remove()
      resolve(value)
    }

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close(null)
      }
    }

    document.addEventListener('keydown', onKey)
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close(null)
    })
    cancelButton.addEventListener('click', () => close(null))

    box.addEventListener('submit', (event) => {
      event.preventDefault()
      const value = Number(input.value.trim())
      if (!Number.isSafeInteger(value) || value <= 0) {
        error.textContent = '请输入正整数 ID'
        error.hidden = false
        input.focus()
        return
      }
      void saveSettings({ selfUserId: value }).then(
        () => close(value),
        () => {
          error.textContent = '保存失败，请重试'
          error.hidden = false
        },
      )
    })
  })
}
