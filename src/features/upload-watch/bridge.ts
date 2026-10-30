import {
  DEFAULT_WATCH_SETTINGS,
  type WatchLogKind,
  type WatchSettings,
  type WatchStatus,
} from './types'

/**
 * offscreen 文档拿不到 chrome.storage（只有 chrome.runtime），
 * 所以所有设置 / 状态 / 日志读写都转给 Service Worker 代做。
 */
async function ask<T>(message: Record<string, unknown>, fallback: T): Promise<T> {
  try {
    const response = (await chrome.runtime.sendMessage(message)) as
      | { ok?: boolean; result?: T }
      | undefined
    if (response?.ok && response.result !== undefined) return response.result
    return fallback
  } catch {
    return fallback
  }
}

export async function getWatchSettings(): Promise<WatchSettings> {
  return ask({ type: 'WATCH_GET_SETTINGS' }, { ...DEFAULT_WATCH_SETTINGS })
}

export async function saveWatchSettings(patch: Partial<WatchSettings>): Promise<WatchSettings> {
  return ask({ type: 'WATCH_SAVE_SETTINGS', patch }, { ...DEFAULT_WATCH_SETTINGS, ...patch })
}

export async function saveWatchStatus(patch: Partial<WatchStatus>): Promise<void> {
  await ask({ type: 'WATCH_STATUS', patch }, undefined)
}

export async function appendWatchLog(text: string, kind: WatchLogKind = 'dim'): Promise<void> {
  await ask({ type: 'WATCH_LOG', text, kind }, undefined)
}
