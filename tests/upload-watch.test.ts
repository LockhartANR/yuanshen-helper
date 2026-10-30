import { describe, expect, it } from 'vitest'
import { drainQueue, MAX_ATTEMPTS, type UploadFn } from '../src/features/upload-watch/engine'
import {
  baselineDirectory,
  createEntry,
  scanDirectory,
  type DirectoryLike,
} from '../src/features/upload-watch/scan'
import type { UploadOutcome, WatchFile } from '../src/features/upload-watch/types'
import { normalizeUploadResult } from '../src/features/upload-watch/upload'

const NOW = 1_700_000_000_000

interface FakeFile {
  size: number
  mtime: number
}

function makeDir(files: Record<string, FakeFile>) {
  const reads: string[] = []
  const dir: DirectoryLike = {
    async *values() {
      for (const name of Object.keys(files)) {
        yield { kind: 'file' as const, name }
      }
    },
    async getFileHandle(name: string) {
      const file = files[name]
      if (!file) throw new Error(`missing ${name}`)
      return {
        async getFile() {
          reads.push(name)
          return {
            size: file.size,
            lastModified: file.mtime,
            async arrayBuffer() {
              return new ArrayBuffer(file.size)
            },
          }
        },
      }
    },
  }
  return { dir, reads }
}

function options(overrides: Partial<Parameters<typeof scanDirectory>[2]> = {}) {
  return {
    recursive: false,
    exts: ['.evf'],
    skipFail: true,
    stabilityMs: 3000,
    maxEntries: 100,
    now: NOW,
    ...overrides,
  }
}

describe('scanDirectory', () => {
  it('records a new file as seen without queueing it yet', async () => {
    const { dir } = makeDir({ 'a.evf': { size: 100, mtime: NOW - 60_000 } })
    const result = await scanDirectory(dir, new Map(), options())

    expect(result.updates).toHaveLength(1)
    expect(result.updates[0]).toMatchObject({ relPath: 'a.evf', size: 100, status: 'seen' })
  })

  it('queues a seen file once its size and mtime stop changing', async () => {
    const { dir } = makeDir({ 'a.evf': { size: 100, mtime: NOW - 60_000 } })
    const known = new Map<string, WatchFile>([
      ['a.evf', createEntry('a.evf', 100, NOW - 60_000, 'seen', NOW - 10_000)],
    ])

    const result = await scanDirectory(dir, known, options())
    expect(result.updates[0]?.status).toBe('queued')
  })

  it('waits while the file mtime is too fresh', async () => {
    const { dir } = makeDir({ 'a.evf': { size: 100, mtime: NOW - 1000 } })
    const known = new Map<string, WatchFile>([
      ['a.evf', createEntry('a.evf', 100, NOW - 1000, 'seen', NOW - 10_000)],
    ])

    const result = await scanDirectory(dir, known, options())
    expect(result.updates).toHaveLength(0)
  })

  it('resets a seen file when its size changes', async () => {
    const { dir } = makeDir({ 'a.evf': { size: 200, mtime: NOW - 60_000 } })
    const known = new Map<string, WatchFile>([
      ['a.evf', createEntry('a.evf', 100, NOW - 60_000, 'seen', NOW - 10_000)],
    ])

    const result = await scanDirectory(dir, known, options())
    expect(result.updates[0]).toMatchObject({ size: 200, status: 'seen' })
  })

  it('does not read files that are already handled', async () => {
    const { dir, reads } = makeDir({ 'a.evf': { size: 100, mtime: NOW - 60_000 } })
    const known = new Map<string, WatchFile>([
      ['a.evf', createEntry('a.evf', 100, NOW - 60_000, 'done', NOW - 10_000)],
    ])

    const result = await scanDirectory(dir, known, options())
    expect(result.updates).toHaveLength(0)
    expect(reads).toHaveLength(0)
  })

  it('ignores other extensions and failed replays', async () => {
    const { dir } = makeDir({
      'a.evf': { size: 100, mtime: NOW - 60_000 },
      'b.txt': { size: 10, mtime: NOW - 60_000 },
      'c_fail.evf': { size: 10, mtime: NOW - 60_000 },
    })

    const result = await scanDirectory(dir, new Map(), options())
    expect(result.updates.map((row) => row.relPath)).toEqual(['a.evf'])
  })
})

describe('baselineDirectory', () => {
  it('marks existing files as ignored in new-only mode', async () => {
    const { dir, reads } = makeDir({
      'a.evf': { size: 100, mtime: NOW - 60_000 },
      'b.evf': { size: 200, mtime: NOW - 60_000 },
    })

    const rows = await baselineDirectory(dir, options(), 'new-only')
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.status === 'ignored')).toBe(true)
    expect(reads).toHaveLength(0)
  })

  it('queues existing files in backfill mode', async () => {
    const { dir } = makeDir({ 'a.evf': { size: 100, mtime: NOW - 60_000 } })
    const rows = await baselineDirectory(dir, options(), 'backfill')
    expect(rows[0]).toMatchObject({ status: 'queued', size: 100 })
  })
})

describe('normalizeUploadResult', () => {
  it('parses a successful upload', () => {
    const outcome = normalizeUploadResult(
      200,
      JSON.stringify({ type: 'success', data: { id: 42, state: 'c' } }),
    )
    expect(outcome).toEqual({ kind: 'done', id: 42, state: 'c' })
  })

  it('treats collision as a duplicate success', () => {
    const outcome = normalizeUploadResult(
      200,
      JSON.stringify({ type: 'error', object: 'file', category: 'collision' }),
    )
    expect(outcome.kind).toBe('duplicate')
  })

  it('treats incomplete replays as skipped', () => {
    const outcome = normalizeUploadResult(
      200,
      JSON.stringify({ type: 'error', object: 'file', category: 'incomplete' }),
    )
    expect(outcome).toEqual({ kind: 'skipped', reason: '未完成局' })
  })

  it('reads realname from the obj key', () => {
    const outcome = normalizeUploadResult(
      200,
      JSON.stringify({ type: 'error', obj: 'userprofile', category: 'realname_required' }),
    )
    expect(outcome).toMatchObject({ kind: 'fatal', fatal: 'realname' })
  })

  it('maps auth, quota and rate limiting', () => {
    expect(normalizeUploadResult(403, '')).toMatchObject({ kind: 'fatal', fatal: 'auth' })
    expect(normalizeUploadResult(402, '')).toMatchObject({ kind: 'fatal', fatal: 'quota' })
    expect(normalizeUploadResult(429, '', '2')).toEqual({
      kind: 'retry',
      reason: expect.any(String),
      retryAfterMs: 2000,
    })
  })

  it('keeps file-level failures distinguishable', () => {
    const outcome = normalizeUploadResult(
      200,
      JSON.stringify({ type: 'error', object: 'file', category: 'level' }),
    )
    expect(outcome).toEqual({ kind: 'failed', reason: 'file/level' })
  })
})

describe('drainQueue', () => {
  function queued(relPath: string, attempts = 0): WatchFile {
    return { ...createEntry(relPath, 10, NOW, 'queued', NOW), attempts }
  }

  it('marks a successful upload as done', async () => {
    const { dir } = makeDir({ 'a.evf': { size: 10, mtime: NOW } })
    const files = new Map([['a.evf', queued('a.evf')]])
    const upload: UploadFn = async () => ({ kind: 'done', id: 7, state: 'c' })

    const result = await drainQueue({
      dir,
      files,
      upload,
      now: NOW,
      limit: 5,
      onPersist: async () => undefined,
    })

    expect(result.done).toBe(1)
    expect(files.get('a.evf')).toMatchObject({ status: 'done', siteId: 7, state: 'c' })
  })

  it('backs off and eventually fails after max attempts', async () => {
    const { dir } = makeDir({ 'a.evf': { size: 10, mtime: NOW } })
    const files = new Map([['a.evf', queued('a.evf')]])
    const upload: UploadFn = async () => ({ kind: 'retry', reason: '网络错误', retryAfterMs: 0 })

    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      const now = NOW + attempt * 60_000
      await drainQueue({ dir, files, upload, now, limit: 1, onPersist: async () => undefined })
      expect(files.get('a.evf')?.status).toBe('queued')
      expect(files.get('a.evf')?.attempts).toBe(attempt)
      expect(files.get('a.evf')?.nextAttemptAt).toBeGreaterThan(now)
    }

    const last = NOW + MAX_ATTEMPTS * 60_000
    await drainQueue({ dir, files, upload, now: last, limit: 1, onPersist: async () => undefined })
    expect(files.get('a.evf')).toMatchObject({ status: 'failed', reason: '网络错误' })
  })

  it('skips files whose retry time has not arrived', async () => {
    const { dir } = makeDir({ 'a.evf': { size: 10, mtime: NOW } })
    const files = new Map([
      ['a.evf', { ...queued('a.evf', 1), nextAttemptAt: NOW + 10_000 }],
    ])
    const upload: UploadFn = async () => ({ kind: 'done', id: 1, state: 'c' })

    const result = await drainQueue({
      dir,
      files,
      upload,
      now: NOW,
      limit: 5,
      onPersist: async () => undefined,
    })
    expect(result.attempted).toBe(0)
  })

  it('stops the batch on an account-level error', async () => {
    const { dir } = makeDir({
      'a.evf': { size: 10, mtime: NOW },
      'b.evf': { size: 10, mtime: NOW },
    })
    const files = new Map([
      ['a.evf', queued('a.evf')],
      ['b.evf', queued('b.evf')],
    ])
    let calls = 0
    const upload: UploadFn = async (): Promise<UploadOutcome> => {
      calls += 1
      return { kind: 'fatal', fatal: 'auth', reason: '登录已失效' }
    }

    const result = await drainQueue({
      dir,
      files,
      upload,
      now: NOW,
      limit: 5,
      onPersist: async () => undefined,
    })

    expect(calls).toBe(1)
    expect(result.fatal).toEqual({ kind: 'auth', reason: '登录已失效' })
    expect(files.get('b.evf')?.status).toBe('queued')
  })
})
