import { saveWatchSettings } from './settings'
import { getWatchHandle } from './store'

export type StartFailure = 'no-dir' | 'permission' | 'login' | 'error'

export interface StartResult {
  ok: boolean
  reason?: StartFailure
  message?: string
  /** 后台文档建好了但没响应，通常是脚本加载失败 */
  responsive?: boolean
}

export async function send<T>(message: Record<string, unknown>): Promise<T | undefined> {
  try {
    return (await chrome.runtime.sendMessage(message)) as T
  } catch {
    // 后台没起来时消息会失败，状态由下一次看门狗纠正
    return undefined
  }
}

/**
 * 开始监视：目录句柄 → 读取权限 → 站点登录态 → 拉起后台。
 * 页面和 popup 共用这一份，避免两边对"什么算开始成功"的判断出现分歧。
 */
export async function startWatch(): Promise<StartResult> {
  const handle = await getWatchHandle()
  if (!handle) return { ok: false, reason: 'no-dir' }

  let permission: PermissionState = 'granted'
  try {
    if (handle.queryPermission) {
      permission = await handle.queryPermission({ mode: 'read' })
      if (permission !== 'granted' && handle.requestPermission) {
        permission = await handle.requestPermission({ mode: 'read' })
      }
    }
  } catch {
    return { ok: false, reason: 'permission' }
  }
  if (permission !== 'granted') return { ok: false, reason: 'permission' }

  const precheck = await send<{ ok?: boolean; loggedIn?: boolean | null }>({
    type: 'WATCH_PRECHECK',
  })
  if (precheck?.ok && precheck.loggedIn === false) return { ok: false, reason: 'login' }

  await saveWatchSettings({ state: 'watching', dirName: handle.name, lastError: '' })
  const response = await send<{ ok?: boolean; responsive?: boolean; error?: string }>({
    type: 'WATCH_START',
  })
  if (response && response.ok === false) {
    await saveWatchSettings({ state: 'paused' })
    return { ok: false, reason: 'error', message: response.error }
  }
  return { ok: true, responsive: response?.responsive }
}

export async function pauseWatch(): Promise<void> {
  await saveWatchSettings({ state: 'paused' })
  await send({ type: 'WATCH_STOP' })
}
