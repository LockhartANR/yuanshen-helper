import { BlobReader, BlobWriter, ZipWriter } from '@zip.js/zip.js/lib/zip-core-native.js'
import type { HistorySource } from './client'
import type { ReplayDecoder } from './decoder'
import { densityFraction, sameMetadata, type HistoryIssue, type HistoryMetadata } from './model'

const MAX_EXPORT_BYTES = 256 * 1024 * 1024

export interface ExportProgress { completed: number; total: number; exported: number; failed: number }
export interface ExportResult { blob: Blob | null; filename: string; exported: number; issues: HistoryIssue[] }

function localExportTimestamp(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new Error('无法确定导出时间')
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  const offset = -date.getTimezoneOffset()
  const minutes = Math.abs(offset)
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`
    + `${offset >= 0 ? '+' : '-'}${pad(Math.floor(minutes / 60))}${pad(minutes % 60)}`
}

/** Use the same safe, timestamp-free name for a direct download and a member of a ZIP. */
export function replayFilename(entry: Pick<HistoryMetadata, 'game' | 'mode' | 'scoreMs'> & { id: number | `player${number}` }): string {
  const level = entry.mode.key === 'b' ? 'beg' : entry.mode.key === 'i' ? 'int' : entry.mode.key === 'e' ? 'exp' : 'custom'
  const density = densityFraction(entry.mode.density)
  const score = `${Math.floor(entry.scoreMs / 1000)}.${String(entry.scoreMs % 1000).padStart(3, '0')}s`
  // A slash would create a directory in ZIP files and is invalid in a download filename.
  const fraction = density ? [density.length <= 64 ? density.replace('/', '-') : 'custom-density'] : []
  return [entry.game, level, ...fraction, score, entry.id].join('-') + '.json'
}

export async function exportHistory(source: HistorySource, decoder: ReplayDecoder,
  entries: readonly HistoryMetadata[], databaseVersion: number,
  onProgress: (progress: ExportProgress) => void, signal?: AbortSignal, now = new Date()): Promise<ExportResult> {
  if (!entries.length) throw new Error('请先选择要导出的录像')
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) throw new Error('导出列表包含重复的历史编号')
  const single = entries.length === 1
  const output = single ? undefined : new BlobWriter('application/zip')
  const archive = output && new ZipWriter(output, {
    level: 6, useWebWorkers: false,
  })
  let blob: Blob | null = null
  const issues: HistoryIssue[] = []
  let exported = 0
  let byteLength = 0
  try {
    for (const entry of entries) {
      signal?.throwIfAborted()
      let text: string | undefined
      try {
        const record = await source.read(entry, databaseVersion, signal)
        signal?.throwIfAborted()
        if (!sameMetadata(record.metadata, entry)) throw new Error('读取结果与所选录像不一致')
        const replay = await decoder.decode(record, signal)
        signal?.throwIfAborted()
        text = `${JSON.stringify({ localId: entry.id, game: entry.game, mode: entry.mode,
          scoreMs: entry.scoreMs, playedAt: entry.playedAt, replay })}\n`
      } catch (error) {
        signal?.throwIfAborted()
        issues.push({ id: entry.id, error: error instanceof Error ? error.message : '录像读取或解压失败' })
      }
      if (text !== undefined) {
        const file = new Blob([text], { type: 'application/json;charset=utf-8' })
        byteLength += file.size
        if (byteLength > MAX_EXPORT_BYTES) throw new Error('本次导出超过 256 MiB，请缩小日期或勾选范围后重试')
        if (archive) await archive.add(replayFilename(entry), new BlobReader(file), { signal })
        else blob = file
        signal?.throwIfAborted()
        exported++
      }
      onProgress({ completed: exported + issues.length, total: entries.length, exported, failed: issues.length })
    }
    signal?.throwIfAborted()
    if (archive && exported > 0) {
      if (issues.length) {
        const report = `小游戏录像导出：部分失败\n请求：${entries.length} 条\n成功：${exported} 条\n失败：${issues.length} 条\n\n`
          + issues.map((issue) => `#${issue.id ?? '未知编号'}：${issue.error}`).join('\n') + '\n'
        await archive.add('errors.txt', new BlobReader(new Blob([report], { type: 'text/plain;charset=utf-8' })), { signal })
      }
      blob = await archive.close()
      signal?.throwIfAborted()
    }
    const filename = single ? replayFilename(entries[0]) : `openms-minigame-history-${localExportTimestamp(now)}${issues.length ? '-partial' : ''}.zip`
    return { blob, filename, exported, issues }
  } finally {
    decoder.dispose()
    if (output && !blob) await output.writable.abort().catch(() => undefined)
  }
}
