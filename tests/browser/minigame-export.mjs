/** Load the real dist extension into an isolated Chromium profile; every website request is mocked. */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { chromium } from 'playwright'
import SevenZip from '7z-wasm'

const timezone = process.argv[2] ?? process.env.YUANSHEN_TEST_TIMEZONE ?? 'Asia/Shanghai'
const expectedTimestamp = new Map([
  ['Asia/Shanghai', '2026-11-26T02-30-45-123+0800'],
  ['America/Los_Angeles', '2026-11-25T10-30-45-123-0800'],
  ['Asia/Kathmandu', '2026-11-26T00-15-45-123+0545'],
  ['America/Santiago', '2026-11-25T15-30-45-123-0300'],
]).get(timezone)
if (!expectedTimestamp) throw new Error('不支持的浏览器测试时区')
const output = resolve('.tmp/checks', `minigame-browser-${new Date().toISOString().replace(/[:.]/g, '-')}`)
await mkdir(output, { recursive: true })
const zip = await SevenZip({ wasmBinary: Uint8Array.from(await readFile('node_modules/7z-wasm/7zz.wasm')).buffer,
  print: () => undefined, printErr: () => undefined })
const mouse = { version: 1, cellSize: 32, initialBoard: 'AAAAAAAAAAA', events: [[0, 16, 16, 1], [10, -2, 0, 2]], specialEvents: [] }
const flag = { ...mouse, initialBoard: [[1, 1, 0], [1, 5, 7], [5, 1, 2], [5, 5, 6]] }
const missing = { version: 1, rounds: Array.from({ length: 10 }, (_, i) => ({ board: 'AAAAAAAAAAA', target: [0, 0], timeMs: i === 9 ? 334 : 100 })) }
const reaction = { version: 1, draws: [0, 1], sides: [0], clicks: [[0, 30], [100, 40]] }
const touch = { version: 1, cellSize: 32, initialBoard: 'AAAAAAAAAAA', events: [[0, 16, 16, 0, 0], [10, 0, 0, 0, 2]] }
function pack(value) {
  zip.FS.writeFile('replay.json', JSON.stringify(value))
  assert.equal(zip.callMain(['a', '-t7z', '-m0=LZMA2', '-mx=1', '-md=1m', '-mmt=off', 'test.7z', 'replay.json']), 0)
  const bytes = Array.from(zip.FS.readFile('test.7z'))
  zip.FS.unlink('test.7z')
  zip.FS.unlink('replay.json')
  return bytes
}
const packed = { 'left-click': pack(mouse), 'flag-chord': pack(flag), 'missing-cell': pack(missing), reaction: pack(reaction), 'multi-touch': pack(touch) }
const playbackFixture = await readFile('tests/browser/fixtures/minigame-playback.js', 'utf8')
const replayRequests = []
const onlineFixtures = new Map([
  [95, { bytes: packed['left-click'], score: 1234 }],
  [96, { bytes: packed['left-click'], score: 2345 }],
  [97, { bytes: packed['left-click'], score: 3456 }],
  [98, { bytes: packed['left-click'], score: 4567 }],
  [400, { bytes: [1, 2, 3], score: 1234 }],
])
let releaseDelayedReplay
const stamp = new Date('2026-11-25T12:00:00Z').getTime()
function row(id, game = 'left-click') {
  const key = game === 'multi-touch' ? 'e' : game === 'left-click' && id === 590 ? 'i' : 'b'
  const density = [50, 75, 87.5][(id - 1) % 3]
  return { id, game, mode: game === 'reaction' ? { key: 'b', length: 5, probability: 25, target: 10, rankingKey: 'reaction-b-25-v1' }
    : { key, rows: key === 'b' ? 8 : 16, columns: key === 'b' ? 8 : key === 'i' ? 16 : 30,
      ...(game === 'flag-chord' ? { total: 4 } : game === 'left-click' || game === 'multi-touch' ? { density } : {}) },
  scoreMs: 1234, playedAt: stamp + id, bytes: packed[game] }
}
const fixtures = [
  ...Array.from({ length: 106 }, (_, i) => row(i + 1)), row(586, 'flag-chord'),
  { ...row(587, 'flag-chord'), bytes: [1, 2, 3] }, row(588, 'missing-cell'), row(589, 'reaction'),
  row(590), row(591, 'multi-touch'),
]
const browserErrors = []
const externalRequests = []
const context = await chromium.launchPersistentContext(join(output, 'profile'), {
  headless: true,
  channel: 'chromium',
  ignoreDefaultArgs: ['--disable-extensions'],
  executablePath: process.env.YUANSHEN_CHROMIUM || undefined,
  args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`],
  viewport: { width: 1280, height: 900 },
  timezoneId: timezone,
  acceptDownloads: true,
})
const successes = []
function passed(name) { successes.push(name); console.log(`PASS ${name}`) }
try {
  await context.route('https://**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== 'https://openms.top') { externalRequests.push(url.href); await route.abort(); return }
    if (url.pathname === '/api/common/loginauto') {
      await route.fulfill({ contentType: 'application/json', body: '{"user":null}' })
    } else if (url.pathname === '/replay-fixture') {
      await route.fulfill({ contentType: 'text/html;charset=utf-8', body: '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>原生回放测试</title><style>body{font:14px sans-serif;color:var(--ui-text-color-regular,#303133);background:var(--ui-bg-color,#fff);padding:16px}.training-page{display:grid;gap:.75rem;min-width:0;text-align:center}.training-controls,.minigame-replay-controls{display:flex;flex-wrap:wrap;align-items:center;gap:8px}.training-controls{justify-content:center}.minigame-replay-controls{width:100%;max-width:52rem;min-width:0;margin-inline:auto}.minigame-replay-controls input{flex:1 1 10rem;min-width:0;margin:0}.dark{--ui-bg-color:#141414;--ui-text-color-regular:#ddd;--ui-color-primary:#337ecc}</style><script src="/replay-fixture.js"></script></head><body></body></html>' })
    } else if (url.pathname === '/replay-fixture.js') {
      await route.fulfill({ contentType: 'text/javascript', body: playbackFixture })
    } else if (/^\/api\/minigame\/[^/]+\/replay$/.test(url.pathname)) {
      const player = Number(url.searchParams.get('player'))
      replayRequests.push({ player, key: url.searchParams.get('key') })
      const fixture = onlineFixtures.get(player)
      if (player === 97) await new Promise((resolve) => { releaseDelayedReplay = resolve })
      if (!fixture) await route.fulfill({ status: 404, body: 'Replay not found' })
      else await route.fulfill({ contentType: 'application/x-7z-compressed',
        headers: { 'X-Minigame-Score': String(fixture.score) }, body: Buffer.from(fixture.bytes) })
    } else {
      await route.fulfill({ contentType: 'text/html;charset=utf-8', body: '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>小游戏测试站点</title></head><body>仅用于元神助手测试的模拟站点</body></html>' })
    }
  })
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')
  const extensionId = new URL(worker.url()).hostname
  const site = await context.newPage()
  await site.goto('https://openms.top/#/minigame/flag-chord?history=586')
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://openms.top/*' }))[0].id)
  async function seed(rows, version = 3) {
    await site.evaluate(async ({ rows, version }) => {
      await new Promise((resolve, reject) => {
        const deletion = indexedDB.deleteDatabase('saolei-minigame')
        deletion.onsuccess = resolve
        deletion.onerror = () => reject(deletion.error)
      })
      await new Promise((resolve, reject) => {
        const opening = indexedDB.open('saolei-minigame', version)
        opening.onupgradeneeded = () => {
          const store = opening.result.createObjectStore('results', { keyPath: 'id', autoIncrement: true })
          store.createIndex('playedAt', 'playedAt')
          store.createIndex('scoreMs', 'scoreMs')
        }
        opening.onerror = () => reject(opening.error)
        opening.onsuccess = () => {
          const db = opening.result
          const tx = db.transaction('results', 'readwrite')
          for (const row of rows) {
            const { bytes, ...data } = row
            tx.objectStore('results').put(bytes ? { ...data, replay: Uint8Array.from(bytes).buffer } : data)
          }
          tx.oncomplete = () => { db.close(); resolve() }
          tx.onabort = () => { db.close(); reject(tx.error) }
        }
      })
    }, { rows, version })
  }
  await seed(fixtures)
  const app = await context.newPage()
  await app.clock.setFixedTime(new Date('2026-11-25T18:30:45.123Z'))
  app.on('pageerror', (error) => browserErrors.push(error.message))
  app.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()) })
  await app.goto(`chrome-extension://${extensionId}/minigame.html?tab=${tabId}`)
  const playback = app.getByRole('complementary', { name: '录像播放提示' })
  await playback.waitFor({ state: 'visible' })
  assert.match(await playback.innerText(), /左键和标双训练的录像可以在 Anon Player 播放/)
  assert.match(await playback.innerText(), /多局 ZIP 请先解压/)
  const playerLink = playback.getByRole('link', { name: 'Anon Player', exact: true })
  assert.equal(await playerLink.getAttribute('href'), 'https://player.lockhart.ren/')
  assert.equal(await playerLink.getAttribute('target'), '_blank')
  assert.equal(await playerLink.getAttribute('rel'), 'noopener noreferrer')
  assert.equal(await playback.evaluate((node) => getComputedStyle(node).borderLeftWidth), '4px')
  assert.equal(await playerLink.evaluate((node) => getComputedStyle(node).textDecorationLine), 'underline')
  const playbackBounds = await playback.boundingBox()
  assert.ok(playbackBounds && playbackBounds.y >= 0 && playbackBounds.y + playbackBounds.height <= 900)
  passed('prominent replay notice links left-click and flag-chord recordings to Anon Player in a new tab')
  const status = app.getByRole('status')
  assert.equal(await app.locator('button').filter({ hasText: /^取消$/ }).isVisible(), false)
  async function load(expected) {
    await app.getByRole('button', { name: '读取历史', exact: true }).click()
    await status.filter({ hasText: expected }).waitFor({ timeout: 20_000 })
  }
  async function saveDownload(action) {
    const waiting = app.waitForEvent('download', { timeout: 25_000 })
    await action()
    const download = await waiting
    assert.equal(await download.failure(), null)
    const path = join(output, download.suggestedFilename())
    await download.saveAs(path)
    const name = download.suggestedFilename()
    if (!name.endsWith('.zip')) {
      const text = await readFile(path, 'utf8')
      return { json: JSON.parse(text), text, name }
    }
    zip.FS.mkdir('/export-check')
    zip.FS.writeFile('/export.zip', await readFile(path))
    try {
      assert.equal(zip.callMain(['x', '-y', '-o/export-check', '/export.zip']), 0)
      const files = Object.fromEntries(zip.FS.readdir('/export-check').filter((file) => file !== '.' && file !== '..')
        .map((file) => [file, new TextDecoder('utf-8', { fatal: true }).decode(zip.FS.readFile(`/export-check/${file}`))]))
      return { files, name }
    } finally {
      for (const file of zip.FS.readdir('/export-check')) {
        if (file !== '.' && file !== '..') zip.FS.unlink(`/export-check/${file}`)
      }
      zip.FS.rmdir('/export-check')
      zip.FS.unlink('/export.zip')
    }
  }
  await load('读取完成：112 条')
  assert.equal(await app.locator('tbody tr').count(), 50)
  assert.equal(await app.getByRole('button', { name: '导出所选（1）', exact: true }).isEnabled(), true)
  const single = await saveDownload(() => app.getByRole('button', { name: '导出当前回放 #586', exact: true }).click())
  assert.equal(single.name, 'flag-chord-beg-1.234s-586.json')
  assert.deepEqual(single.json, { localId: 586, game: 'flag-chord', mode: row(586, 'flag-chord').mode,
    scoreMs: 1234, playedAt: stamp + 586, replay: flag })
  assert.equal(await app.locator('button').filter({ hasText: /^取消$/ }).isVisible(), false)
  passed('single replay exports as an independent JSON object through the real content script and WASM worker')

  await app.getByRole('button', { name: '下一页', exact: true }).click()
  assert.equal(await app.locator('tbody tr').count(), 50)
  assert.match(await app.locator('.minigame-pagination').innerText(), /2 \/ 3/)
  passed('history paging and selection of the current replay')

  await app.getByLabel('游戏', { exact: true }).selectOption('left-click')
  const modeLabels = await app.getByLabel('模式', { exact: true }).locator('option').allTextContents()
  for (const fraction of ['1/2', '3/4', '7/8']) assert.ok(modeLabels.some((label) => label.includes(`密度 ${fraction}`)))
  assert.match(await app.locator('tr[data-history-id="590"]').innerText(), /中级 · 16×16 · 密度 3\/4/)
  const densitySingle = await saveDownload(() => app.getByRole('button', { name: '导出录像 #590', exact: true }).click())
  assert.equal(densitySingle.name, 'left-click-int-3-4-1.234s-590.json')
  assert.equal(densitySingle.json.mode.density, 75)
  await app.screenshot({ path: join(output, 'density-fractions.png'), fullPage: true })
  passed('density labels use fractions and replay names contain level, fraction and score without export timestamps')

  await app.getByLabel('游戏', { exact: true }).selectOption('flag-chord')
  assert.equal(await app.locator('tbody tr').count(), 2)
  assert.equal(await app.getByRole('button', { name: '导出所选（0）', exact: true }).isDisabled(), true)
  const partial = await saveDownload(() => app.getByRole('button', { name: '导出全部筛选（2）', exact: true }).click())
  assert.deepEqual(Object.keys(partial.files).sort(), ['errors.txt', 'flag-chord-beg-1.234s-586.json'])
  assert.equal(partial.files[single.name], single.text)
  assert.match(partial.files['errors.txt'], /#587：/)
  assert.equal(partial.name, `openms-minigame-history-${expectedTimestamp}-partial.zip`)
  await app.getByText('未能读取或导出的记录（1）', { exact: true }).waitFor()
  passed('corrupt recording is reported and a partial backup is explicitly marked')
  passed(`ZIP filenames use the browser local date, time and UTC offset in ${timezone}`)

  await app.screenshot({ path: join(output, 'light.png'), fullPage: true })
  await app.emulateMedia({ colorScheme: 'dark' })
  await app.screenshot({ path: join(output, 'dark.png'), fullPage: true })
  await app.setViewportSize({ width: 390, height: 844 })
  assert.equal(await app.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await app.screenshot({ path: join(output, 'narrow.png'), fullPage: true })
  await app.setViewportSize({ width: 1280, height: 900 })
  passed('light, dark and narrow layouts render without document overflow')

  await app.getByLabel('游戏', { exact: true }).selectOption('')
  let downloads = 0
  const countDownload = () => { downloads++ }
  app.on('download', countDownload)
  await app.getByRole('button', { name: '导出全部筛选（112）', exact: true }).click()
  await app.getByRole('button', { name: '取消', exact: true }).click()
  await status.filter({ hasText: '已取消导出，未生成文件' }).waitFor()
  assert.equal(downloads, 0)
  app.off('download', countDownload)
  passed('cancel terminates decoding and produces no partial file')

  const all = await saveDownload(() => app.getByRole('button', { name: '导出全部筛选（112）', exact: true }).click())
  assert.equal(all.name, `openms-minigame-history-${expectedTimestamp}-partial.zip`)
  const replays = Object.entries(all.files).filter(([name]) => name.endsWith('.json')).map(([, text]) => JSON.parse(text))
  assert.equal(replays.length, 111)
  assert.equal(Object.keys(all.files).length, 112)
  assert.deepEqual(new Set(replays.map((entry) => entry.game)), new Set(Object.keys(packed)))
  assert.deepEqual(replays.find((entry) => entry.game === 'multi-touch').replay, touch)
  assert.deepEqual(replays.find((entry) => entry.game === 'missing-cell').replay, missing)
  assert.deepEqual(replays.find((entry) => entry.game === 'reaction').replay, reaction)
  assert.equal(all.files[single.name], single.text)
  assert.equal(all.files[densitySingle.name], densitySingle.text)
  assert.ok(all.files['left-click-beg-1-2-1.234s-1.json'])
  assert.ok(all.files['multi-touch-exp-7-8-1.234s-591.json'])
  assert.equal(Object.keys(all.files).some((name) => /[/\\]/.test(name)), false)
  assert.match(all.files['errors.txt'], /请求：112 条\n成功：111 条\n失败：1 条/)
  passed('standard ZIP contains independent JSON replays for all five games')

  await app.getByLabel('游戏', { exact: true }).selectOption('missing-cell')
  const filteredSingle = await saveDownload(() => app.getByRole('button', { name: '导出全部筛选（1）', exact: true }).click())
  assert.equal(filteredSingle.name, 'missing-cell-beg-1.234s-588.json')
  assert.deepEqual(filteredSingle.json.replay, missing)
  await app.getByLabel('游戏', { exact: true }).selectOption('')
  passed('a bulk export action selecting one record still downloads an independent JSON file')

  const state = await site.evaluate(async () => {
    const db = await new Promise((resolve, reject) => { const opening = indexedDB.open('saolei-minigame'); opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error) })
    const row = await new Promise((resolve) => { const request = db.transaction('results').objectStore('results').get(586); request.onsuccess = () => resolve(request.result) })
    const count = await new Promise((resolve) => { const request = db.transaction('results').objectStore('results').count(); request.onsuccess = () => resolve(request.result) })
    const version = db.version
    db.close()
    return { version, count, bytes: Array.from(new Uint8Array(row.replay)) }
  })
  assert.deepEqual(state, { version: 3, count: 112, bytes: packed['flag-chord'] })
  assert.deepEqual(externalRequests, [])
  passed('website data is unchanged and no external service is contacted')

  const old = { initialBoard: [[1, 16]], events: [{ timeMs: 0, row: 1, column: 1, action: 'rc' }] }
  const { bytes: _bytes, ...meta } = row(586, 'flag-chord')
  await seed([{ ...meta, replay: old }], 2)
  await load('读取完成：1 条')
  const legacy = await saveDownload(() => app.getByRole('button', { name: '导出当前回放 #586', exact: true }).click())
  assert.equal(legacy.json.game, 'flag-chord')
  assert.deepEqual(legacy.json.replay, old)
  assert.equal(await site.evaluate(async () => (await indexedDB.databases()).find((db) => db.name === 'saolei-minigame')?.version), 2)
  passed('legacy JSON history exports without upgrading the database or rewriting replay data')

  const from = app.getByLabel('开始日期', { exact: true })
  const to = app.getByLabel('结束日期', { exact: true })
  async function assertDateError() {
    assert.equal(await app.locator('tbody tr').count(), 0)
    assert.match(await status.innerText(), /请选择有效的日期/)
    for (const name of ['导出当前回放 #586', '导出所选（0）', '导出全部筛选（0）', '勾选筛选结果']) {
      assert.equal(await app.getByRole('button', { name, exact: true }).isDisabled(), true)
    }
  }
  for (const input of [from, to]) {
    await input.fill('2026-11-25')
    await input.press('Tab')
    await app.getByRole('button', { name: '勾选筛选结果', exact: true }).click()
    assert.equal(await app.getByRole('button', { name: '导出所选（1）', exact: true }).isEnabled(), true)
    await input.press('Home')
    await input.press('Backspace')
    assert.deepEqual(await input.evaluate((node) => ({ value: node.value, badInput: node.validity.badInput })), { value: '', badInput: true })
    await assertDateError()
    await input.press('Tab')
    await assertDateError()
    if (input === from) await app.screenshot({ path: join(output, 'invalid-date.png'), fullPage: true })
    await app.getByLabel('游戏', { exact: true }).selectOption('flag-chord')
    await app.getByLabel('模式', { exact: true }).selectOption({ index: 1 })
    await assertDateError()
    await app.getByRole('button', { name: '读取历史', exact: true }).click()
    await app.waitForFunction(() => !document.querySelector('input[aria-label="开始日期"]').disabled)
    await assertDateError()
    await input.fill('2026-11-25')
    assert.equal(await app.locator('tbody tr').count(), 1)
    assert.equal(await app.getByRole('button', { name: '导出全部筛选（1）', exact: true }).isEnabled(), true)
    assert.equal(await app.getByRole('button', { name: '导出所选（0）', exact: true }).isDisabled(), true)
    await input.press('Home')
    await input.press('Backspace')
    await assertDateError()
    await input.fill('')
    assert.deepEqual(await input.evaluate((node) => ({ value: node.value, valid: node.validity.valid })), { value: '', valid: true })
    assert.equal(await app.locator('tbody tr').count(), 1)
    assert.equal(await app.getByRole('button', { name: '导出全部筛选（1）', exact: true }).isEnabled(), true)
  }
  passed('partial dates immediately block every export entry, survive filter changes and reloads, and recover when completed or cleared')

  await app.getByLabel('开始日期', { exact: true }).fill('2026-11-26')
  await app.getByLabel('开始日期', { exact: true }).press('Tab')
  await app.getByLabel('结束日期', { exact: true }).fill('2026-11-25')
  await app.getByLabel('结束日期', { exact: true }).press('Tab')
  await status.filter({ hasText: '开始日期不能晚于结束日期' }).waitFor()
  assert.equal(await app.getByRole('button', { name: '导出全部筛选（0）', exact: true }).isDisabled(), true)
  passed('invalid date ranges disable export')

  await from.fill('')
  await to.fill('')
  await app.getByLabel('游戏', { exact: true }).selectOption('')
  const dayBounds = await app.evaluate(() => ({
    start: new Date('2026-09-06T00:00:00').getTime(),
    end: new Date('2026-09-07T00:00:00').getTime(),
  }))
  if (timezone === 'America/Santiago') assert.equal(dayBounds.end - dayBounds.start, 23 * 60 * 60 * 1000)
  const boundaryTimes = [dayBounds.start - 1, dayBounds.start, dayBounds.end - 1, dayBounds.end, dayBounds.end + 30 * 60 * 1000]
  await seed(boundaryTimes.map((playedAt, index) => ({ ...row(600 + index), playedAt })))
  await load('读取完成：5 条')
  await from.fill('2026-09-06')
  await to.fill('2026-09-06')
  assert.deepEqual(await app.locator('tbody tr').evaluateAll((rows) => rows.map((row) => Number(row.dataset.historyId))), [602, 601])
  const dayExport = await saveDownload(() => app.getByRole('button', { name: '导出全部筛选（2）', exact: true }).click())
  assert.deepEqual(Object.values(dayExport.files).map((text) => JSON.parse(text).localId).sort((left, right) => left - right), [601, 602])
  await from.fill('')
  assert.deepEqual(await app.locator('tbody tr').evaluateAll((rows) => rows.map((row) => Number(row.dataset.historyId))), [602, 601, 600])
  passed('local-day filters and exported ZIP exclude the following day, including midnight daylight-saving transitions')

  const denied = await worker.evaluate(async (tabId) => chrome.tabs.sendMessage(tabId,
    { type: 'YUANSHEN_MINIGAME_HISTORY', action: 'list', afterId: 0 }), tabId)
  assert.equal(denied.ok, false)
  assert.match(denied.error, /导出页/)
  passed('content script rejects history requests from other extension contexts')

  const popup = await context.newPage()
  await popup.setViewportSize({ width: 360, height: 480 })
  await popup.goto(`chrome-extension://${extensionId}/popup.html`)
  await popup.getByRole('button', { name: /小游戏录像/ }).waitFor()
  const bounds = await popup.getByRole('button', { name: /小游戏录像/ }).boundingBox()
  assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= 480)
  await popup.screenshot({ path: join(output, 'popup.png') })
  const options = await context.newPage()
  await options.goto(`chrome-extension://${extensionId}/options.html`)
  assert.equal(await options.getByRole('link', { name: '小游戏录像 ↗', exact: true }).getAttribute('href'), `chrome-extension://${extensionId}/minigame.html`)
  passed('popup and settings expose the new export entry')

  // Exercise the native-page entry through its actual MAIN/ISOLATED scripts and embedded decoder.
  await seed(fixtures)
  const native = await context.newPage()
  native.on('pageerror', (error) => browserErrors.push(error.message))
  const nativeButton = native.getByRole('button', { name: '导出录像', exact: true })
  async function assertNativeExportLayout() {
    const layout = await native.evaluate(() => {
      const host = document.getElementById('ysh-minigame-export')
      const button = host?.querySelector('button')
      const page = document.querySelector('.training-page')
      const timeline = page?.querySelector('.minigame-replay-controls')
      const anchor = timeline ?? page?.querySelector('.training-controls')
      if (!host || !button || !anchor) throw new Error('Missing native export layout')
      const row = host.getBoundingClientRect()
      const action = button.getBoundingClientRect()
      const reference = anchor.getBoundingClientRect()
      const status = host.querySelector('[role="status"]')
      return {
        adjacent: timeline ? host.nextElementSibling === anchor : host.previousElementSibling === anchor,
        separate: timeline ? row.bottom <= reference.top : row.top >= reference.bottom,
        rowOffset: Math.abs(row.x + row.width / 2 - reference.x - reference.width / 2),
        buttonOffset: Math.abs(action.x + action.width / 2 - reference.x - reference.width / 2),
        statusBelow: !status || status.hidden || status.getBoundingClientRect().top >= action.bottom,
      }
    })
    assert.equal(layout.adjacent, true)
    assert.equal(layout.separate, true)
    assert.ok(layout.rowOffset < 1, 'export row should be centered with the native controls')
    assert.ok(layout.buttonOffset < 1, 'export button should stay centered when status is shown')
    assert.equal(layout.statusBelow, true)
  }
  async function injectedDownload() {
    const pages = context.pages().length
    const url = native.url()
    const waiting = native.waitForEvent('download', { timeout: 25_000 })
    await nativeButton.click()
    const download = await waiting
    assert.equal(await download.failure(), null)
    const path = join(output, `injected-${download.suggestedFilename()}`)
    await download.saveAs(path)
    const text = await readFile(path, 'utf8')
    await native.getByRole('status').filter({ hasText: '已生成单局录像' }).waitFor()
    assert.equal(context.pages().length, pages)
    assert.equal(native.url(), url)
    assert.equal(await native.locator('#ysh-minigame-decoder').count(), 0)
    assert.equal(await native.getByRole('button', { name: '取消导出', exact: true }).isVisible(), false)
    await assertNativeExportLayout()
    return { json: JSON.parse(text), text, name: download.suggestedFilename() }
  }
  await native.goto('https://openms.top/replay-fixture#/minigame/left-click?history=590')
  await nativeButton.waitFor()
  const nativeLocal = await injectedDownload()
  assert.equal(nativeLocal.name, densitySingle.name)
  assert.deepEqual(nativeLocal.json, densitySingle.json)
  assert.equal(nativeLocal.text, densitySingle.text)
  assert.equal(await native.locator('#ysh-minigame-export a').count(), 0)
  assert.equal((await injectedDownload()).text, nativeLocal.text)
  await native.getByRole('button', { name: '播放', exact: true }).click()
  assert.equal(await native.getByRole('button', { name: '暂停', exact: true }).count(), 1)
  await native.evaluate(() => { window.renderFixturePlayback(); window.renderFixturePlayback() })
  await nativeButton.waitFor()
  assert.equal(await native.locator('#ysh-minigame-export').count(), 1)
  await assertNativeExportLayout()
  passed('native local-playback downloads and repeated downloads stay on the same tab, clean up the decoder and preserve playback controls')

  await native.screenshot({ path: join(output, 'native-light.png'), fullPage: true })
  await native.evaluate(() => document.documentElement.classList.add('dark'))
  await native.screenshot({ path: join(output, 'native-dark.png'), fullPage: true })
  await native.setViewportSize({ width: 390, height: 844 })
  assert.equal(await native.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await assertNativeExportLayout()
  await native.screenshot({ path: join(output, 'native-narrow.png'), fullPage: true })
  await native.setViewportSize({ width: 1280, height: 900 })
  await native.evaluate(() => document.documentElement.classList.remove('dark'))
  passed('export has its own centered row above the timeline in light, dark and narrow native playback layouts')

  await native.evaluate(() => window.switchFixturePlayback('#/minigame/missing-cell?history=588'))
  await nativeButton.waitFor()
  const nativeMissing = await injectedDownload()
  assert.equal(nativeMissing.name, 'missing-cell-beg-1.234s-588.json')
  assert.deepEqual(nativeMissing.json.replay, missing)
  passed('missing-cell playback exports in a centered row below its level controls without a timeline')

  // Full navigation makes the request begin in the head, before the idle content script starts.
  await native.goto('https://openms.top/replay-fixture?early=1#/minigame/left-click?player=95&key=b-50-v1')
  await nativeButton.waitFor()
  assert.deepEqual(await native.evaluate(() => window.fixtureBytes), packed['left-click'])
  onlineFixtures.set(95, { bytes: pack({ ...mouse, fixture: 'new-pb' }), score: 999 })
  const nativeOnline = await injectedDownload()
  assert.equal(nativeOnline.name, 'left-click-beg-1-2-1.234s-player95.json')
  assert.deepEqual(nativeOnline.json, { playerId: 95, rankingKey: 'left-click-b-50-v1', game: 'left-click',
    mode: { key: 'b', rows: 8, columns: 8, density: 50 }, scoreMs: 1234, replay: mouse })
  assert.equal(replayRequests.filter((request) => request.player === 95).length, 1)
  passed('early native XHR capture exports the playing recording even after the server PB changes, without refetching')

  await native.evaluate(() => window.switchFixturePlayback('#/minigame/left-click?player=96&key=i-75-v1', 'fetch'))
  await nativeButton.waitFor()
  const nativeFetch = await injectedDownload()
  assert.equal(nativeFetch.name, 'left-click-int-3-4-2.345s-player96.json')
  assert.equal(nativeFetch.json.playerId, 96)
  assert.deepEqual(await native.evaluate(() => window.fixtureBytes), packed['left-click'])
  assert.deepEqual(await native.evaluate(async () => (await fetch('/api/common/loginauto')).json()), { user: null })
  passed('SPA fetch playback uses the new mode and player, preserving the website response and unrelated fetch calls')

  await native.evaluate(() => { void window.switchFixturePlayback('#/minigame/left-click?player=97&key=e-87.5-v1') })
  await native.waitForFunction(() => !document.querySelector('.training-page'))
  for (let attempt = 0; !releaseDelayedReplay && attempt < 200; attempt++) await new Promise((resolve) => setTimeout(resolve, 20))
  assert.ok(releaseDelayedReplay, 'the delayed native request should have started')
  await native.evaluate(() => window.switchFixturePlayback('#/minigame/left-click?player=98&key=b-50-v1'))
  await nativeButton.waitFor()
  releaseDelayedReplay()
  const latest = await injectedDownload()
  assert.equal(latest.name, 'left-click-beg-1-2-4.567s-player98.json')
  assert.equal(latest.json.playerId, 98)
  passed('late responses from a previous playback cannot overwrite the current recording')

  await native.evaluate(() => history.replaceState({}, '', '#/minigame/left-click'))
  await nativeButton.waitFor({ state: 'detached' })
  passed('export button is removed when leaving the replay route')

  await native.goto('https://openms.top/replay-fixture?no-load=1#/minigame/left-click?player=95&key=b-50-v1')
  await nativeButton.waitFor()
  const pageCount = context.pages().length
  await nativeButton.click()
  await native.getByRole('status').filter({ hasText: '请刷新页面后重试' }).waitFor()
  assert.equal(context.pages().length, pageCount)
  assert.equal(replayRequests.filter((request) => request.player === 95).length, 1)
  passed('missing current response reports a refresh instruction instead of downloading a different server replay')

  const invalidFrame = await native.evaluate(async (extensionId) => {
    const frame = document.createElement('iframe')
    frame.hidden = true
    frame.src = `chrome-extension://${extensionId}/minigame-frame.html`
    const loaded = new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }))
    document.body.append(frame)
    await loaded
    const channel = new MessageChannel()
    const result = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Decoder validation timed out')), 5000)
      channel.port1.onmessage = (event) => { clearTimeout(timeout); resolve(event.data) }
    })
    frame.contentWindow.postMessage({ type: 'YUANSHEN_MINIGAME_DECODE', url: location.href,
      record: { metadata: { game: 'reaction' } } }, `chrome-extension://${extensionId}`, [channel.port2])
    try { return await result } finally { channel.port1.close(); frame.remove() }
  }, extensionId)
  assert.equal(invalidFrame.ok, false)
  assert.match(invalidFrame.error, /格式无效/)
  passed('embedded decoder validates incoming replay data before starting a worker')

  await native.evaluate(() => window.switchFixturePlayback('#/minigame/left-click?player=400&key=b-50-v1'))
  await nativeButton.waitFor()
  const failedDownloads = []
  native.on('download', (download) => failedDownloads.push(download.suggestedFilename()))
  for (let attempt = 0; attempt < 2; attempt++) {
    await nativeButton.click()
    await native.getByRole('status').filter({ hasText: '7z 录像解压失败' }).waitFor()
    assert.equal(await native.locator('#ysh-minigame-decoder').count(), 0)
    assert.equal(await nativeButton.isEnabled(), true)
    assert.equal(context.pages().length, pageCount)
  }
  assert.equal(replayRequests.filter((request) => request.player === 400).length, 1)
  assert.deepEqual(failedDownloads, [])
  native.removeAllListeners('download')
  passed('corrupt native replay reports failure and retries on the same tab using the captured data without downloading')

  // Delay worker startup in new decoder frames so cancellation and route changes are deterministic.
  await context.addInitScript(() => {
    if (location.protocol !== 'chrome-extension:' || location.pathname !== '/minigame-frame.html') return
    const NativeWorker = window.Worker
    window.Worker = class extends NativeWorker {
      postMessage(...args) { setTimeout(() => super.postMessage(...args), 1200) }
    }
  })
  await native.evaluate(() => window.switchFixturePlayback('#/minigame/left-click?history=590'))
  const canceledDownloads = []
  const trackCanceled = (download) => canceledDownloads.push(download.suggestedFilename())
  native.on('download', trackCanceled)
  await nativeButton.click()
  await native.locator('#ysh-minigame-decoder').waitFor({ state: 'attached' })
  await native.getByRole('button', { name: '取消导出', exact: true }).click()
  await native.getByRole('status').filter({ hasText: '已取消导出，未生成文件' }).waitFor()
  assert.equal(await native.locator('#ysh-minigame-decoder').count(), 0)
  assert.equal(await nativeButton.isEnabled(), true)
  native.off('download', trackCanceled)
  assert.equal((await injectedDownload()).text, nativeLocal.text)
  assert.deepEqual(canceledDownloads, [])
  passed('cancel removes the active decoder, produces no file and allows an immediate retry on the same tab')

  // Exercise cached-page lifecycle events explicitly: Chromium disables BFCache in this test profile.
  const restoredDownloads = []
  const trackRestored = (download) => restoredDownloads.push(download.suggestedFilename())
  native.on('download', trackRestored)
  await nativeButton.click()
  await native.locator('#ysh-minigame-decoder').waitFor({ state: 'attached' })
  await native.getByRole('status').filter({ hasText: '正在解压当前录像' }).waitFor()
  await native.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
  })
  await nativeButton.waitFor()
  assert.equal(await native.locator('#ysh-minigame-decoder').count(), 0)
  assert.equal(await nativeButton.isEnabled(), true)
  assert.equal(await native.getByRole('button', { name: '取消导出', exact: true }).isVisible(), false)
  assert.equal(await native.locator('#ysh-minigame-export [role="status"]').textContent(), '')
  assert.equal(await native.locator('#ysh-minigame-export [role="status"]').isHidden(), true)
  assert.deepEqual(restoredDownloads, [])
  await assertNativeExportLayout()
  await native.screenshot({ path: join(output, 'native-restored.png'), fullPage: true })
  assert.equal((await injectedDownload()).text, nativeLocal.text)
  assert.deepEqual(restoredDownloads, [nativeLocal.name])
  native.off('download', trackRestored)
  passed('cached-page lifecycle restoration clears the stopped export status and allows a fresh download')

  native.on('download', trackCanceled)
  await nativeButton.click()
  await native.locator('#ysh-minigame-decoder').waitFor({ state: 'attached' })
  await native.evaluate(() => window.switchFixturePlayback('#/minigame/missing-cell?history=588'))
  await native.locator('#ysh-minigame-decoder').waitFor({ state: 'detached' })
  assert.equal(await nativeButton.isEnabled(), true)
  assert.equal(await native.locator('#ysh-minigame-export [role="status"]').textContent(), '')
  native.off('download', trackCanceled)
  const afterSwitch = await injectedDownload()
  assert.equal(afterSwitch.name, nativeMissing.name)
  assert.deepEqual(canceledDownloads, [])
  passed('switching playback aborts the old export and a fresh click downloads only the new recording')

  assert.deepEqual(browserErrors, [])
  await writeFile(join(output, 'result.json'), JSON.stringify({ timezone, passed: successes, browserErrors, externalRequests }, null, 2))
  console.log(`Browser verification passed: ${successes.length} checks. Artifacts: ${output}`)
} catch (error) {
  await writeFile(join(output, 'failure.json'), JSON.stringify({ passed: successes, browserErrors, error: String(error) }, null, 2))
  for (const page of context.pages()) {
    if (page.url().includes('/minigame.html') || page.url().includes('/replay-fixture')) {
      await page.screenshot({ path: join(output, page.url().includes('/replay-fixture') ? 'failure-native.png' : 'failure.png'), fullPage: true }).catch(() => undefined)
    }
  }
  throw error
} finally { await context.close() }
