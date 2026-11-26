import {
  HISTORY_MESSAGE, isObject, parseHistoryPage, parseHistoryRecord,
  type HistoryMetadata, type HistoryPage, type HistoryRecord, type HistoryRequest, type HistoryIssue,
} from './model'

export interface HistorySource {
  page(afterId: number, upperId?: number, version?: number, signal?: AbortSignal): Promise<HistoryPage>
  read(expected: HistoryMetadata, version: number, signal?: AbortSignal): Promise<HistoryRecord>
}

export interface HistorySnapshot {
  databaseVersion: number | null
  entries: HistoryMetadata[]
  issues: HistoryIssue[]
}

export class SiteHistoryClient implements HistorySource {
  constructor(private readonly tabId: number) {}

  private async send(request: HistoryRequest, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted()
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort: (() => void) | undefined
    try {
      const response: unknown = await Promise.race([
        chrome.tabs.sendMessage(this.tabId, request, { frameId: 0 }).catch(() => {
          throw new Error('无法连接站点。请刷新所选 openms.top 标签页，保持它打开，再重试')
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('读取站点超时，请保持小游戏标签页打开并重试')), 15_000)
          abort = () => reject(new DOMException('已取消', 'AbortError'))
          signal?.addEventListener('abort', abort, { once: true })
        }),
      ])
      signal?.throwIfAborted()
      if (!isObject(response) || typeof response.ok !== 'boolean') throw new Error('站点读取响应无效，请重新加载扩展并刷新站点')
      if (!response.ok) throw new Error(typeof response.error === 'string' ? response.error : '读取小游戏历史失败')
      return response.data
    } finally {
      clearTimeout(timer)
      if (abort) signal?.removeEventListener('abort', abort)
    }
  }

  async page(afterId: number, upperId?: number, version?: number, signal?: AbortSignal): Promise<HistoryPage> {
    return parseHistoryPage(await this.send({ type: HISTORY_MESSAGE, action: 'list', afterId,
      ...(upperId === undefined ? {} : { upperId }),
      ...(version === undefined ? {} : { databaseVersion: version }) }, signal))
  }

  async read(expected: HistoryMetadata, version: number, signal?: AbortSignal): Promise<HistoryRecord> {
    return parseHistoryRecord(await this.send({ type: HISTORY_MESSAGE, action: 'read', databaseVersion: version, expected }, signal))
  }
}

/** Freeze the maximum ID for this scan; new games are included by the next refresh. */
export async function loadHistory(source: HistorySource, onProgress: (count: number) => void,
  signal?: AbortSignal): Promise<HistorySnapshot> {
  const entries: HistoryMetadata[] = []
  const issues: HistoryIssue[] = []
  const seen = new Set<number>()
  let afterId = 0
  let upperId: number | undefined
  let version: number | undefined
  for (;;) {
    signal?.throwIfAborted()
    const page = await source.page(afterId, upperId, version, signal)
    signal?.throwIfAborted()
    if (upperId !== undefined && (page.upperId !== upperId || page.databaseVersion !== version)) {
      throw new Error('历史数据范围或格式已变化，请重新读取')
    }
    upperId = page.upperId
    version = page.databaseVersion ?? undefined
    for (const entry of page.entries) {
      if (entry.id <= afterId || entry.id > upperId || seen.has(entry.id)) throw new Error('历史分页重复或超出读取范围')
      seen.add(entry.id)
      entries.push(entry)
    }
    issues.push(...page.issues)
    onProgress(entries.length)
    if (page.nextAfterId === null) {
      return { databaseVersion: page.databaseVersion, entries: entries.sort((a, b) => b.playedAt - a.playedAt || b.id - a.id), issues }
    }
    if (page.nextAfterId <= afterId || page.nextAfterId > upperId) throw new Error('历史分页没有前进，读取已停止')
    afterId = page.nextAfterId
  }
}
