import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, getSettings, saveSettings } from '../src/shared/settings'

const store = new Map<string, unknown>()

beforeEach(() => {
  store.clear()
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: store.get(key) }),
        set: async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) store.set(key, value)
        },
      },
    },
  })
})

describe('扩展设置', () => {
  it('没有存档时使用默认值，站内大表入口默认开启', async () => {
    const settings = await getSettings()
    expect(settings).toEqual(DEFAULT_SETTINGS)
    expect(settings.siteAnalysisEnabled).toBe(true)
  })

  it('旧设置缺少 siteAnalysisEnabled 时按开启处理', async () => {
    store.set('settings', {
      apiBase: 'https://openms.top',
      autoIncrementalOnPopup: false,
      identifierLookupEnabled: false,
      selfUserId: 16,
    })
    const settings = await getSettings()
    expect(settings.siteAnalysisEnabled).toBe(true)
    expect(settings.selfUserId).toBe(16)
  })

  it('保存关闭后读回关闭，保存其他字段不会把它改回开启', async () => {
    await saveSettings({ siteAnalysisEnabled: false })
    expect((await getSettings()).siteAnalysisEnabled).toBe(false)

    const next = await saveSettings({ selfUserId: 16 })
    expect(next.siteAnalysisEnabled).toBe(false)
  })

  it('显式传 true 重新开启', async () => {
    await saveSettings({ siteAnalysisEnabled: false })
    const next = await saveSettings({ siteAnalysisEnabled: true })
    expect(next.siteAnalysisEnabled).toBe(true)
  })
})
