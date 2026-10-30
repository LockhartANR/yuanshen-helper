import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { countStatuses, loadLedger, putLedger, requeueFailed, resetLedger } from '../src/features/upload-watch/store'
import { createEntry } from '../src/features/upload-watch/scan'
import type { WatchFile } from '../src/features/upload-watch/types'

beforeEach(async () => {
  await resetLedger()
})

describe('ledger', () => {
  it('stores and counts entries by status', async () => {
    const rows: WatchFile[] = [
      createEntry('a.evf', 10, 1, 'queued', 1),
      createEntry('b.evf', 20, 2, 'done', 1),
      createEntry('c.evf', 30, 3, 'failed', 1),
      createEntry('d.evf', 40, 4, 'ignored', 1),
      createEntry('e.evf', 50, 5, 'seen', 1),
    ]
    await putLedger(rows)

    const ledger = await loadLedger()
    expect(ledger.size).toBe(5)
    expect(countStatuses(ledger)).toEqual({ pending: 2, uploaded: 1, skipped: 0, failed: 1 })
  })

  it('requeues failed entries with a reset backoff', async () => {
    await putLedger([
      { ...createEntry('a.evf', 10, 1, 'failed', 1), attempts: 5, nextAttemptAt: 999 },
      createEntry('b.evf', 10, 1, 'done', 1),
    ])

    const count = await requeueFailed()
    expect(count).toBe(1)

    const ledger = await loadLedger()
    expect(ledger.get('a.evf')).toMatchObject({
      status: 'queued',
      attempts: 0,
      nextAttemptAt: 0,
    })
    expect(ledger.get('b.evf')?.status).toBe('done')
  })
})
