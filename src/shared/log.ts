export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
  at: number
  level: LogLevel
  message: string
}

const LOG_KEY = 'logs'
const MAX_LOGS = 20

export async function getLogs(): Promise<LogEntry[]> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return []
  const stored = await chrome.storage.local.get(LOG_KEY)
  const value = stored[LOG_KEY]
  return Array.isArray(value) ? (value as LogEntry[]) : []
}

export async function addLog(level: LogLevel, message: string): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return
  const logs = await getLogs()
  const next: LogEntry[] = [{ at: Date.now(), level, message }, ...logs].slice(0, MAX_LOGS)
  await chrome.storage.local.set({ [LOG_KEY]: next })
}

export async function clearLogs(): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return
  await chrome.storage.local.remove(LOG_KEY)
}
