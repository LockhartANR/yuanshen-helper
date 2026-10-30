import type { WatchFile, WatchFileStatus, WatchMode } from './types'

/**
 * 只依赖 File System Access 的最小结构，方便在测试里用假目录替换。
 * 真实的 FileSystemDirectoryHandle 在结构上满足这些接口。
 */
export interface DirEntryLike {
  kind: 'file' | 'directory'
  name: string
}

export interface FileLike {
  size: number
  lastModified: number
  arrayBuffer(): Promise<ArrayBuffer>
}

export interface FileHandleLike {
  getFile(): Promise<FileLike>
}

export interface DirectoryLike {
  values(): AsyncIterableIterator<DirEntryLike>
  getFileHandle(name: string): Promise<FileHandleLike>
  getDirectoryHandle?(name: string): Promise<DirectoryLike>
}

const MAX_DEPTH = 6

export interface ScanOptions {
  recursive: boolean
  exts: string[]
  skipFail: boolean
  /** 文件写入完成后至少静置多久才允许入队 */
  stabilityMs: number
  /** 单轮最多处理多少个候选文件 */
  maxEntries: number
  now: number
}

export interface ScanResult {
  updates: WatchFile[]
  /** 目录里看到的文件总数（未过滤） */
  total: number
  /** 命中的文件数（扩展名、_fail 过滤之后） */
  matched: number
  /** 看到的子目录数 */
  subdirs: number
  /** 前几个文件名，用于诊断「为什么没匹配到」 */
  sample: string[]
  truncated: boolean
}

export function createEntry(
  relPath: string,
  size: number,
  mtime: number,
  status: WatchFileStatus,
  now: number,
): WatchFile {
  return {
    relPath,
    size,
    mtime,
    status,
    firstSeenAt: now,
    attempts: 0,
    nextAttemptAt: 0,
    reason: '',
  }
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot).toLowerCase()
}

function isFailReplay(name: string): boolean {
  return /_fail(\.|$)/i.test(name)
}

function acceptName(relPath: string, opts: Pick<ScanOptions, 'exts' | 'skipFail'>): boolean {
  const name = relPath.slice(relPath.lastIndexOf('/') + 1)
  if (opts.exts.length > 0 && !opts.exts.includes(extensionOf(name))) return false
  if (opts.skipFail && isFailReplay(name)) return false
  return true
}

interface ListedEntry {
  relPath: string
  kind: 'file' | 'directory'
}

async function* listEntries(
  dir: DirectoryLike,
  prefix: string,
  depth: number,
  recursive: boolean,
): AsyncGenerator<ListedEntry> {
  for await (const entry of dir.values()) {
    if (entry.kind === 'file') {
      yield { relPath: prefix + entry.name, kind: 'file' }
      continue
    }
    yield { relPath: prefix + entry.name, kind: 'directory' }
    if (!recursive || depth >= MAX_DEPTH || !dir.getDirectoryHandle) continue
    const child = await dir.getDirectoryHandle(entry.name)
    yield* listEntries(child, `${prefix}${entry.name}/`, depth + 1, recursive)
  }
}

export async function resolveFile(
  dir: DirectoryLike,
  relPath: string,
): Promise<FileHandleLike> {
  const parts = relPath.split('/')
  let current: DirectoryLike = dir
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (!current.getDirectoryHandle) throw new Error('无法进入子目录')
    current = await current.getDirectoryHandle(parts[index])
  }
  return current.getFileHandle(parts[parts.length - 1])
}

/**
 * 扫一轮目录，返回需要写回台账的条目。
 *
 * 新文件名只记 `seen`，下一轮 size/mtime 都没变、且文件已经静置足够久，才转
 * `queued`。这样可以避免把正在写入的录像传上去。
 * 已经在队列 / 已完成的条目直接跳过，连 `getFile()` 都不做。
 */
export async function scanDirectory(
  dir: DirectoryLike,
  known: Map<string, WatchFile>,
  opts: ScanOptions,
): Promise<ScanResult> {
  const updates: WatchFile[] = []
  const sample: string[] = []
  let total = 0
  let matched = 0
  let subdirs = 0
  let processed = 0
  let truncated = false

  for await (const entry of listEntries(dir, '', 0, opts.recursive)) {
    if (entry.kind === 'directory') {
      subdirs += 1
      continue
    }
    total += 1
    if (sample.length < 5) sample.push(entry.relPath)
    const relPath = entry.relPath
    if (!acceptName(relPath, opts)) continue
    matched += 1

    const existing = known.get(relPath)
    if (existing && existing.status !== 'seen') continue

    // 只有真正需要 stat 的文件才计入预算，否则台账一大，
    // 每轮都在前 5000 个已处理文件上打转，后面的新文件永远轮不到。
    processed += 1
    if (processed > opts.maxEntries) {
      truncated = true
      break
    }

    let file: Awaited<ReturnType<FileHandleLike['getFile']>>
    try {
      file = await (await resolveFile(dir, relPath)).getFile()
    } catch (error) {
      // 列目录到读取之间文件被删掉了，下一轮自然不会再出现，跳过即可
      if (error instanceof DOMException && error.name === 'NotFoundError') continue
      throw error
    }

    if (!existing) {
      // 第一次看到时文件已经静置超过 stabilityMs，说明早就写完了，直接入队；
      // 否则先记成 seen，等下一轮确认大小没再变。
      const stable = opts.now - file.lastModified > opts.stabilityMs
      updates.push(
        createEntry(relPath, file.size, file.lastModified, stable ? 'queued' : 'seen', opts.now),
      )
      continue
    }
    if (existing.size !== file.size || existing.mtime !== file.lastModified) {
      updates.push({ ...existing, size: file.size, mtime: file.lastModified, status: 'seen' })
      continue
    }
    if (opts.now - file.lastModified > opts.stabilityMs) {
      updates.push({ ...existing, status: 'queued' })
    }
  }

  return { updates, total, matched, subdirs, sample, truncated }
}

/**
 * 启动时的基线：把目录里当前已有的文件一次性写进台账。
 * `new-only` 标成 ignored（以后不会被当新文件），`backfill` 直接入队。
 */
export async function baselineDirectory(
  dir: DirectoryLike,
  opts: Pick<ScanOptions, 'recursive' | 'exts' | 'skipFail' | 'now'>,
  mode: WatchMode,
): Promise<WatchFile[]> {
  const rows: WatchFile[] = []
  for await (const entry of listEntries(dir, '', 0, opts.recursive)) {
    if (entry.kind !== 'file') continue
    const relPath = entry.relPath
    if (!acceptName(relPath, opts)) continue
    if (mode === 'new-only') {
      rows.push(createEntry(relPath, 0, 0, 'ignored', opts.now))
      continue
    }
    let file: Awaited<ReturnType<FileHandleLike['getFile']>>
    try {
      file = await (await resolveFile(dir, relPath)).getFile()
    } catch (error) {
      // 列目录到读取之间文件被删掉了，下一轮自然不会再出现，跳过即可
      if (error instanceof DOMException && error.name === 'NotFoundError') continue
      throw error
    }
    rows.push(createEntry(relPath, file.size, file.lastModified, 'queued', opts.now))
  }
  return rows
}
