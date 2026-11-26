import { isObject, jsonObject, safeInteger, type JsonObject, type Minigame } from './model'

function modeKey(mode: JsonObject): 'b' | 'i' | 'e' {
  if (mode.key === 'b' || mode.key === 'i' || mode.key === 'e') return mode.key
  throw new Error('本地录像的难度不受支持，无法提交')
}

/** Build only ranking keys that the site currently publishes for minigame results. */
export function minigameRankingKey(game: Minigame, mode: JsonObject): string {
  const level = modeKey(mode)
  if (game === 'left-click' || game === 'multi-touch') {
    const density = mode.density
    if (typeof density !== 'number' || ![50, 75, 87.5].includes(density)) {
      throw new Error('本地录像的密度不受支持，无法提交')
    }
    return `${game}-${level}-${density}-v1`
  }
  if (game === 'reaction') {
    const probability = mode.probability
    if (typeof probability !== 'number' || ![25, 50].includes(probability)) {
      throw new Error('本地录像的概率模式不受支持，无法提交')
    }
    return `${game}-${level}-${probability}-v1`
  }
  if (game === 'flag-chord' && level === 'e') {
    throw new Error('网站没有对应的高级标双榜单')
  }
  return `${game}-${level}-v1`
}

export function minigameSubmissionBody(scoreMs: number, replay: JsonObject): URLSearchParams {
  if (!safeInteger(scoreMs, 1)) throw new Error('本地录像的成绩无效，无法提交')
  const data = jsonObject(replay)
  return new URLSearchParams({ score: String(scoreMs), replay: JSON.stringify(data) })
}

export function parseMinigameSubmissionResult(value: unknown, rankingKey: string): { improved: boolean } {
  if (!isObject(value) || typeof value.improved !== 'boolean' || !isObject(value.record)
    || value.record.ranking_key !== rankingKey || !safeInteger(value.record.score, 1)) {
    throw new Error('网站返回的小游戏提交结果无效')
  }
  return { improved: value.improved }
}
