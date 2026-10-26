import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  chunkIds,
  identifierQuery,
  infobulk,
  infoupdated,
} from '../src/features/user-search/api'

const baseUrl = 'https://example.test'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('chunkIds', () => {
  it('chunks ids with the requested size', () => {
    expect(chunkIds([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([
      [1, 2, 3],
      [4, 5, 6],
      [7],
    ])
  })
})

describe('API requests', () => {
  it('builds the infobulk URL and sends no credentials', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([{ id: 1 }, { id: 2 }]))
    vi.stubGlobal('fetch', fetchMock)

    const result = await infobulk([1, 2], { baseUrl, minGapMs: 0 })

    expect(result).toEqual([{ id: 1 }, { id: 2 }])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${baseUrl}/api/userprofile/infobulk?ids=1,2`)
    expect(init.credentials).toBe('omit')
  })

  it('retries a 429 and then returns data', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(jsonResponse([1]))
    vi.stubGlobal('fetch', fetchMock)

    const result = await infoupdated(0, {
      baseUrl,
      minGapMs: 0,
      backoffMs: [0],
      maxRetries: 1,
    })

    expect(result).toEqual([1])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('classifies non-JSON responses as format errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))

    await expect(
      infoupdated(0, { baseUrl, minGapMs: 0 }),
    ).rejects.toMatchObject({ kind: 'format' })
  })

  it('classifies 404 as notfound', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))

    await expect(
      infoupdated(0, { baseUrl, minGapMs: 0, maxRetries: 0 }),
    ).rejects.toMatchObject({ kind: 'notfound' })
  })

  it('classifies too_many_matches as toomany', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ code: 'too_many_matches' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    )

    await expect(
      identifierQuery('icontains', 'abc', {
        baseUrl,
        minGapMs: 0,
        maxRetries: 0,
      }),
    ).rejects.toMatchObject({ kind: 'toomany' })
  })

  it('aborts without calling fetch when the signal is already aborted', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    controller.abort()

    await expect(
      infoupdated(0, {
        baseUrl,
        minGapMs: 0,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ kind: 'aborted' })

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('retries network errors and then reports network', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      infoupdated(0, {
        baseUrl,
        minGapMs: 0,
        backoffMs: [0],
        maxRetries: 1,
      }),
    ).rejects.toMatchObject({ kind: 'network' })

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('parses identifier query items and null user ids', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          items: [
            { identifier: 'abc', user_id: 1 },
            { identifier: 'free', user_id: null },
          ],
        }),
      ),
    )

    await expect(
      identifierQuery('icontains', 'ab', { baseUrl, minGapMs: 0 }),
    ).resolves.toEqual([
      { identifier: 'abc', user_id: 1 },
      { identifier: 'free', user_id: null },
    ])
  })
})
