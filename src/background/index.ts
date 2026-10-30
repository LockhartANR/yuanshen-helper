import {
  appendWatchLog,
  getWatchSettings,
  getWatchStatus,
  saveWatchSettings,
  saveWatchStatus,
} from '../features/upload-watch/settings'
import type {
  UploadRawResponse,
  WatchLogKind,
  WatchSettings,
  WatchStatus,
} from '../features/upload-watch/types'

const WATCHDOG_ALARM = 'upload-watch-watchdog'
const OFFSCREEN_URL = 'offscreen.html'
const STATUS_KEY = 'uploadWatchStatus'
const SITE_URL = 'https://openms.top/'
const SITE_MATCH = 'https://openms.top/*'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function ensureWatchdog(): Promise<void> {
  const existing = await chrome.alarms.get(WATCHDOG_ALARM)
  if (!existing) chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1 })
}

async function hasOffscreen(): Promise<boolean> {
  try {
    return await chrome.offscreen.hasDocument()
  } catch {
    return false
  }
}

async function ensureOffscreen(): Promise<void> {
  if (await hasOffscreen()) return
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.DOM_SCRAPING],
      justification: '按周期扫描用户选择的本地录像目录，并把新录像上传到 openms.top',
    })
  } catch (error) {
    // 上一次关闭还没落地时会报「只能有一个 offscreen 文档」，等一下再试一次
    if (String(error).includes('Only a single')) {
      await sleep(300)
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: [chrome.offscreen.Reason.DOM_SCRAPING],
        justification: '按周期扫描用户选择的本地录像目录，并把新录像上传到 openms.top',
      })
      return
    }
    throw error
  }
}

async function closeOffscreen(): Promise<void> {
  if (!(await hasOffscreen())) return
  try {
    await chrome.offscreen.closeDocument()
  } catch {
    // 关不掉就别管，下次 watchdog 会重建
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (!(await hasOffscreen())) return
    await sleep(50)
  }
}

async function ensureSiteTab(): Promise<number> {
  const tabs = await chrome.tabs.query({ url: SITE_MATCH })
  const existing = tabs.find((tab) => typeof tab.id === 'number')
  if (existing?.id !== undefined) return existing.id

  const created = await chrome.tabs.create({ url: SITE_URL, active: false, pinned: true })
  if (created.id === undefined) throw new Error('无法打开 openms.top 标签页')
  await waitForContentScript(created.id)
  return created.id
}

async function pingTab(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'YUANSHEN_PING' })
    return true
  } catch {
    return false
  }
}

async function waitForContentScript(tabId: number): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await pingTab(tabId)) return true
    await sleep(300)
  }
  return false
}

async function tryUpload(
  tabId: number,
  name: string,
  data: string,
): Promise<UploadRawResponse | null> {
  try {
    const response = (await chrome.tabs.sendMessage(tabId, {
      type: 'YUANSHEN_UPLOAD',
      name,
      data,
    })) as UploadRawResponse | undefined
    return response ?? null
  } catch {
    return null
  }
}

async function forwardUpload(name: string, data: string): Promise<UploadRawResponse> {
  let tabId: number
  try {
    tabId = await ensureSiteTab()
  } catch (error) {
    return { status: 0, body: '', retryAfter: '', error: String(error) }
  }

  const first = await tryUpload(tabId, name, data)
  if (first) return first

  // 页面是扩展安装之前打开的，内容脚本还没注入，刷新一次再试
  try {
    await chrome.tabs.reload(tabId)
  } catch {
    // 标签页可能已经关掉，下面的重试会自然失败
  }
  await sleep(1200)
  await waitForContentScript(tabId)
  const second = await tryUpload(tabId, name, data)
  if (second) return second

  return {
    status: 0,
    body: '',
    retryAfter: '',
    error: '站点页面没有响应，请确认已登录 openms.top',
  }
}

async function pingOffscreen(): Promise<boolean> {
  try {
    const response = await Promise.race([
      chrome.runtime.sendMessage({ type: 'WATCH_PING' }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 800)),
    ])
    return Boolean((response as { ok?: boolean } | null)?.ok)
  } catch {
    return false
  }
}

async function refreshBadge(): Promise<void> {
  const status = await getWatchStatus()
  const show = status.state === 'watching' && status.pending > 0
  await chrome.action.setBadgeText({ text: show ? String(Math.min(status.pending, 99)) : '' })
  await chrome.action.setBadgeBackgroundColor({ color: '#c2410c' })
}

async function watchdog(): Promise<void> {
  const settings = await getWatchSettings()
  if (settings.state !== 'watching') return

  if (!(await hasOffscreen())) {
    await ensureOffscreen()
    return
  }

  const status = await getWatchStatus()
  const interval = Math.max(settings.intervalSec, 5) * 1000
  const stale = Date.now() - status.updatedAt > Math.max(interval * 3, 60_000)
  if (stale) {
    await closeOffscreen()
    await ensureOffscreen()
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void ensureWatchdog()
  void watchdog()
})

chrome.runtime.onStartup.addListener(() => {
  void ensureWatchdog()
  void watchdog()
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WATCHDOG_ALARM) void watchdog()
})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[STATUS_KEY]) return
  void refreshBadge()
})

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const request = message as
    | {
        type?: string
        name?: string
        data?: string
        text?: string
        kind?: WatchLogKind
        patch?: unknown
      }
    | undefined

  switch (request?.type) {
    case 'WATCH_START':
      // 先关再建：暂停期间旧文档可能还活着但循环已停，直接复用会一直不扫。
      void closeOffscreen()
        .then(() => ensureOffscreen())
        .then(async () => {
          await sleep(800)
          const responsive = await pingOffscreen()
          if (!responsive) {
            await appendWatchLog('后台文档已创建但没有响应，可能是脚本加载失败', 'err')
          }
          sendResponse({ ok: true, responsive })
        })
        .catch((error: unknown) => sendResponse({ ok: false, error: String(error) }))
      return true
    case 'WATCH_STOP':
      void closeOffscreen()
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: true }))
      return true
    case 'WATCH_TICK':
      void chrome.runtime
        .sendMessage({ type: 'WATCH_TICK' })
        .catch(() => undefined)
        .then(() => sendResponse({ ok: true }))
      return true
    case 'WATCH_DIAG':
      void Promise.all([hasOffscreen(), chrome.alarms.get(WATCHDOG_ALARM), pingOffscreen()])
        .then(([offscreen, alarm, responsive]) =>
          sendResponse({ ok: true, offscreen, alarm: Boolean(alarm), responsive }),
        )
        .catch((error: unknown) => sendResponse({ ok: false, error: String(error) }))
      return true
    case 'WATCH_GET_SETTINGS':
      void getWatchSettings().then((result) => sendResponse({ ok: true, result }))
      return true
    case 'WATCH_SAVE_SETTINGS':
      void saveWatchSettings((request.patch ?? {}) as Partial<WatchSettings>)
        .then((result) => sendResponse({ ok: true, result }))
        .catch(() => sendResponse({ ok: false }))
      return true
    case 'WATCH_STATUS':
      void saveWatchStatus((request.patch ?? {}) as Partial<WatchStatus>)
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }))
      return true
    case 'WATCH_LOG':
      void appendWatchLog(request.text ?? '', request.kind ?? 'dim').then(() =>
        sendResponse({ ok: true }),
      )
      return true
    case 'WATCH_HELLO':
      void appendWatchLog('后台脚本已启动', 'dim')
      void refreshBadge()
      return false
    case 'WATCH_IDLE':
      void closeOffscreen()
      return false
    case 'WATCH_UPLOAD_REQUEST':
      void forwardUpload(request.name ?? 'replay.evf', request.data ?? '').then(sendResponse)
      return true
    default:
      return false
  }
})
