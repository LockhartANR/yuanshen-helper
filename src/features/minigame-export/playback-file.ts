import { replayFilename } from './export'
import { parseMetadata, type JsonObject } from './model'
import type { PlaybackSnapshot } from './playback'

export function playbackFile(snapshot: PlaybackSnapshot, replay: JsonObject): { blob: Blob; filename: string } {
  const { target, record } = snapshot
  const { game, mode, scoreMs } = record.metadata
  const file = target.kind === 'local'
    ? { localId: target.id, game, mode, scoreMs, playedAt: parseMetadata(record.metadata).playedAt, replay }
    : { playerId: target.playerId, rankingKey: `${target.game}-${target.key}`, game, mode, scoreMs, replay }
  const filename = replayFilename({ game, mode, scoreMs, id: target.kind === 'local' ? target.id : `player${target.playerId}` })
  return { filename, blob: new Blob([`${JSON.stringify(file)}\n`],
    { type: 'application/json;charset=utf-8' }) }
}
