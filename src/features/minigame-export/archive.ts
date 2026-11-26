import type { SevenZipModule } from '7z-wasm'
import { base64ToBytes } from '../upload-watch/bytes'
import { MAX_REPLAY_BYTES, jsonObject, type JsonObject, type Minigame } from './model'

/** Validate the payload envelope, preserving v0/v1 data and their original event order. */
export function validateReplay(game: Minigame, value: unknown): JsonObject {
  const replay = jsonObject(value)
  const version = Object.hasOwn(replay, 'version') ? replay.version : 0
  if (version !== 0 && version !== 1) throw new Error('尚不支持此录像载荷版本，未改写或导出')
  if (game === 'missing-cell') {
    if (!Array.isArray(replay.rounds) || replay.rounds.length === 0) throw new Error('漏雷录像缺少各局数据')
  } else if (game === 'reaction') {
    if (version !== 1 || !Array.isArray(replay.draws) || !Array.isArray(replay.sides) || !Array.isArray(replay.clicks)) {
      throw new Error('反应录像缺少抽样或点击数据')
    }
  } else {
    if (!Array.isArray(replay.events) || (typeof replay.initialBoard !== 'string' && !Array.isArray(replay.initialBoard))) {
      throw new Error('录像缺少棋盘或事件数据')
    }
    if (version === 1 && game !== 'multi-touch' && !Array.isArray(replay.specialEvents)) {
      throw new Error('录像缺少特殊事件数组')
    }
    if (game === 'multi-touch' && version !== 1) throw new Error('不支持此多指录像版本')
  }
  return replay
}

/** Extract only the known archive member. The WASM filesystem is cleared after every record. */
export function unpackReplayArchive(data: string, zip: SevenZipModule): unknown {
  const directory = '/minigame-export'
  zip.FS.mkdir(directory)
  const archivePath = `${directory}/replay.7z`
  const jsonPath = `${directory}/replay.json`
  try {
    zip.FS.writeFile(archivePath, base64ToBytes(data))
    const status: unknown = Reflect.apply(zip.callMain, zip, [['e', '-y', `-o${directory}`, archivePath, 'replay.json']])
    if (status !== 0) throw new Error('7z 录像解压失败')
    const content = zip.FS.readFile(jsonPath)
    if (content.byteLength > MAX_REPLAY_BYTES) throw new Error('解压后的录像超过 64 MiB，未导出')
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content))
  } finally {
    for (const file of zip.FS.readdir(directory)) {
      if (file !== '.' && file !== '..') zip.FS.unlink(`${directory}/${file}`)
    }
    zip.FS.rmdir(directory)
  }
}
