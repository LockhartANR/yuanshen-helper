import { DEFAULT_API_BASE } from './constants'

export interface Settings {
  apiBase: string
  autoIncrementalOnPopup: boolean
  identifierLookupEnabled: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  apiBase: DEFAULT_API_BASE,
  autoIncrementalOnPopup: false,
  identifierLookupEnabled: false,
}

const SETTINGS_KEY = 'settings'

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY)
  const value = stored[SETTINGS_KEY] as Partial<Settings> | undefined
  let apiBase = DEFAULT_SETTINGS.apiBase
  if (value?.apiBase) {
    try {
      apiBase = normalizeApiBase(value.apiBase)
    } catch {
      apiBase = DEFAULT_SETTINGS.apiBase
    }
  }
  return {
    ...DEFAULT_SETTINGS,
    ...value,
    apiBase,
  }
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings()
  const next: Settings = {
    ...current,
    ...patch,
    apiBase: normalizeApiBase(patch.apiBase ?? current.apiBase),
  }
  await chrome.storage.local.set({ [SETTINGS_KEY]: next })
  return next
}

/** Accepts a full http(s) origin and returns it without trailing slashes. */
function normalizeApiBase(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error('API 地址不能为空')

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error('API 地址格式不正确')
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('API 地址只支持 http/https')
  }
  if (url.username || url.password) {
    throw new Error('API 地址不能包含账号密码')
  }

  return url.origin
}
