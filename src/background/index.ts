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
/** 内容脚本在站点页面里读到的登录态，避免每次点「我的成绩」都去开标签页。 */
const SELF_KEY = 'selfSession'
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

interface OffscreenProbe {
  ok: boolean
  stopped: boolean
}

async function probeOffscreen(timeoutMs = 800): Promise<OffscreenProbe> {
  try {
    const response = (await Promise.race([
      chrome.runtime.sendMessage({ type: 'WATCH_PING' }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ])) as { ok?: boolean; stopped?: boolean } | null
    return { ok: Boolean(response?.ok), stopped: Boolean(response?.stopped) }
  } catch {
    return { ok: false, stopped: false }
  }
}

/** 刚创建的 offscreen 文档要等脚本跑起来才会应答，轮询一小段时间。 */
async function waitForOffscreen(timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await probeOffscreen(500)).ok) return true
    await sleep(200)
  }
  return false
}

/**
 * 开始/暂停/看门狗都会改 offscreen 文档，快速连点时如果不排队，
 * 一边建一边关就会互相踩，日志里出现假的「没有响应」。
 */
let watchQueue: Promise<unknown> = Promise.resolve()

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const next = watchQueue.then(task, task)
  watchQueue = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

async function beginWatching(): Promise<{ ok: boolean; responsive: boolean }> {
  const settings = await getWatchSettings()
  if (settings.state === 'watching') {
    const probe = await probeOffscreen(500)
    if (probe.ok && !probe.stopped) return { ok: true, responsive: true }
  }

  await closeOffscreen()
  await ensureOffscreen()

  const responsive = await waitForOffscreen()
  if (!responsive) {
    await appendWatchLog('后台文档已创建但没有响应，可能是脚本加载失败', 'err')
  }
  return { ok: true, responsive }
}

/** 读站点登录态。null 表示暂时问不到（页面没注入 / 网络问题），不等于未登录。 */
async function probeLogin(): Promise<{
  loggedIn: boolean | null
  username: string
  userId: number | null
}> {
  let tabId: number
  try {
    tabId = await ensureSiteTab()
  } catch {
    return { loggedIn: null, username: '', userId: null }
  }
  try {
    const response = (await chrome.tabs.sendMessage(tabId, { type: 'YUANSHEN_SESSION' })) as
      | { loggedIn?: boolean | null; username?: string; userId?: number | null }
      | undefined
    return {
      loggedIn: response?.loggedIn ?? null,
      username: response?.username ?? '',
      userId: typeof response?.userId === 'number' ? response.userId : null,
    }
  } catch {
    return { loggedIn: null, username: '', userId: null }
  }
}

async function refreshBadge(): Promise<void> {
  const status = await getWatchStatus()
  let text = ''
  let color = '#c2410c'

  if (status.state === 'stopped') {
    text = '!'
    color = '#dc2626'
  } else if (status.state === 'needs-permission' || status.state === 'waiting-login') {
    text = '!'
    color = '#d97706'
  } else if (status.state === 'watching' && status.pending > 0) {
    text = String(Math.min(status.pending, 99))
  }

  await chrome.action.setBadgeText({ text })
  await chrome.action.setBadgeBackgroundColor({ color })

  // 悬停提示，顺便当“监视还开着”的提醒
  let title = '元神助手 · 用户搜索'
  if (status.state === 'watching') {
    title =
      status.pending > 0
        ? `元神助手 · 自动上传监视中（待传 ${status.pending}）`
        : '元神助手 · 自动上传监视中'
  } else if (status.state === 'waiting-login') {
    title = '元神助手 · 自动上传等待登录'
  } else if (status.state === 'needs-permission') {
    title = '元神助手 · 自动上传需要重新授权'
  } else if (status.state === 'stopped') {
    const reason = status.message ? `：${status.message.slice(0, 40)}` : ''
    title = `元神助手 · 自动上传已停止${reason}`
  }
  await chrome.action.setTitle({ title })
}

async function watchdog(): Promise<void> {
  const settings = await getWatchSettings()

  // 登录失效后等用户重新登录：看门狗每分钟探一次，登录上来自动接着传。
  if (settings.state === 'waiting-login') {
    if (await hasOffscreen()) await closeOffscreen()
    const probe = await probeLogin()
    if (probe.loggedIn !== true) return
    await saveWatchSettings({ state: 'watching', lastError: '' })
    await ensureOffscreen()
    await appendWatchLog(`已检测到登录（${probe.username || '当前账号'}），继续监视`, 'ok')
    await refreshBadge()
    return
  }

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
  void serialize(watchdog)
})

/**
 * 关浏览器 / 关掉所有窗口就等于停止监视：下次不能自动接着跑，
 * 否则用户以为早关了，实际一开机就在往上传。
 */
async function stopWatching(message: string, log: string): Promise<void> {
  const settings = await getWatchSettings()
  if (settings.state !== 'watching' && settings.state !== 'waiting-login') return

  await closeOffscreen()
  await saveWatchSettings({ state: 'paused', lastError: '' })
  await saveWatchStatus({ state: 'paused', message })
  await appendWatchLog(log, 'dim')
  await refreshBadge()
}

async function stopIfNoWindows(): Promise<void> {
  const windows = await chrome.windows.getAll({ windowTypes: ['normal'] })
  if (windows.length > 0) return
  await serialize(() =>
    stopWatching('所有窗口已关闭，监视已停止', '所有窗口已关闭，监视已停止'),
  )
}

chrome.runtime.onStartup.addListener(() => {
  void ensureWatchdog()
  void serialize(async () => {
    await stopWatching('浏览器重启后监视已停止，点「开始监视」继续', '浏览器重启，监视已停止')
    await watchdog()
  })
})

chrome.windows.onRemoved.addListener(() => {
  void stopIfNoWindows()
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WATCHDOG_ALARM) void serialize(watchdog)
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
        userId?: number | null
        username?: string
        loggedIn?: boolean | null
      }
    | undefined

  switch (request?.type) {
    case 'WATCH_START':
      void serialize(beginWatching)
        .then((result) => sendResponse(result))
        .catch((error: unknown) => sendResponse({ ok: false, error: String(error) }))
      return true
    case 'WATCH_STOP':
      void serialize(() => closeOffscreen())
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: true }))
      return true
    case 'WATCH_TICK':
      void chrome.runtime
        .sendMessage({ type: 'WATCH_TICK' })
        .catch(() => undefined)
        .then(() => sendResponse({ ok: true }))
      return true
    case 'WATCH_PRECHECK':
      void probeLogin()
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error: unknown) => sendResponse({ ok: false, error: String(error) }))
      return true
    case 'YUANSHEN_SESSION_REPORT':
      void chrome.storage.local
        .set({
          [SELF_KEY]: {
            userId: typeof request.userId === 'number' ? request.userId : null,
            username: typeof request.username === 'string' ? request.username : '',
            loggedIn: request.loggedIn === true,
            at: Date.now(),
          },
        })
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }))
      return true
    case 'SELF_ID':
      void chrome.storage.local
        .get(SELF_KEY)
        .then((stored) => {
          const value = stored[SELF_KEY] as
            | { userId?: number | null; username?: string; loggedIn?: boolean }
            | undefined
          sendResponse({
            ok: true,
            loggedIn: value?.loggedIn ?? null,
            username: value?.username ?? '',
            userId: typeof value?.userId === 'number' ? value.userId : null,
          })
        })
        .catch((error: unknown) => sendResponse({ ok: false, error: String(error) }))
      return true
    case 'WATCH_DIAG':
      void Promise.all([hasOffscreen(), chrome.alarms.get(WATCHDOG_ALARM), probeOffscreen()])
        .then(([offscreen, alarm, probe]) =>
          sendResponse({ ok: true, offscreen, alarm: Boolean(alarm), responsive: probe.ok }),
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
      void serialize(() => closeOffscreen())
      return false
    case 'WATCH_UPLOAD_REQUEST':
      void forwardUpload(request.name ?? 'replay.evf', request.data ?? '').then(sendResponse)
      return true
    default:
      return false
  }
})
