import {
  DEFAULT_WATCH_SETTINGS,
  DEFAULT_WATCH_STATUS,
  type WatchLogEntry,
  type WatchLogKind,
  type WatchSettings,
  type WatchStatus,
} from './types'

const SETTINGS_KEY = 'uploadWatch'
const STATUS_KEY = 'uploadWatchStatus'
const LOG_KEY = 'uploadWatchLog'
const LOG_LIMIT = 60

export async function getWatchSettings(): Promise<WatchSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY)
  const value = stored[SETTINGS_KEY] as Partial<WatchSettings> | undefined
  return { ...DEFAULT_WATCH_SETTINGS, ...value }
}

export async function saveWatchSettings(
  patch: Partial<WatchSettings>,
): Promise<WatchSettings> {
  const current = await getWatchSettings()
  const next: WatchSettings = { ...current, ...patch }
  await chrome.storage.local.set({ [SETTINGS_KEY]: next })
  return next
}

export async function getWatchStatus(): Promise<WatchStatus> {
  const stored = await chrome.storage.local.get(STATUS_KEY)
  const value = stored[STATUS_KEY] as Partial<WatchStatus> | undefined
  return { ...DEFAULT_WATCH_STATUS, ...value }
}

export async function saveWatchStatus(patch: Partial<WatchStatus>): Promise<WatchStatus> {
  const current = await getWatchStatus()
  const next: WatchStatus = { ...current, ...patch, updatedAt: Date.now() }
  await chrome.storage.local.set({ [STATUS_KEY]: next })
  return next
}

export async function getWatchLogs(): Promise<WatchLogEntry[]> {
  const stored = await chrome.storage.local.get(LOG_KEY)
  const value = stored[LOG_KEY] as WatchLogEntry[] | undefined
  return Array.isArray(value) ? value : []
}

export async function appendWatchLog(text: string, kind: WatchLogKind = 'dim'): Promise<void> {
  const logs = await getWatchLogs()
  logs.unshift({ at: Date.now(), text, kind })
  await chrome.storage.local.set({ [LOG_KEY]: logs.slice(0, LOG_LIMIT) })
}

export async function clearWatchLogs(): Promise<void> {
  await chrome.storage.local.set({ [LOG_KEY]: [] })
}
