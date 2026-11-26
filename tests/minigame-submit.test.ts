import { describe, expect, it } from 'vitest'

import { minigameRankingKey, minigameSubmissionBody, parseMinigameSubmissionResult } from '../src/features/minigame-export/submit'
import type { JsonObject } from '../src/features/minigame-export/model'

describe('minigame history submission', () => {
  it.each([
    ['left-click', { key: 'b', density: 50 }, 'left-click-b-50-v1'],
    ['multi-touch', { key: 'e', density: 87.5 }, 'multi-touch-e-87.5-v1'],
    ['flag-chord', { key: 'i', total: 15 }, 'flag-chord-i-v1'],
    ['missing-cell', { key: 'e', mines: 99 }, 'missing-cell-e-v1'],
    ['reaction', { key: 'b', probability: 25 }, 'reaction-b-25-v1'],
  ] as const)('maps %s metadata to its ranking', (game, mode, expected) => {
    expect(minigameRankingKey(game, mode)).toBe(expected)
  })

  it('rejects unsupported ranking modes instead of constructing an unknown endpoint', () => {
    expect(() => minigameRankingKey('left-click', { key: 'b' })).toThrow('密度')
    expect(() => minigameRankingKey('flag-chord', { key: 'e' })).toThrow('高级标双')
    expect(() => minigameRankingKey('reaction', { key: 'i', probability: 87.5 })).toThrow('概率')
  })

  it('encodes the score and replay as the form fields accepted by the site', () => {
    const replay: JsonObject = { version: 1, initialBoard: 'AAAAAP////8', events: [] }
    const body = minigameSubmissionBody(500, replay)
    expect(body.get('score')).toBe('500')
    expect(JSON.parse(body.get('replay') ?? 'null')).toEqual(replay)
    expect(() => minigameSubmissionBody(0, replay)).toThrow('成绩无效')
  })

  it('accepts only a response for the submitted ranking', () => {
    expect(parseMinigameSubmissionResult({
      improved: true,
      record: { ranking_key: 'left-click-b-50-v1', score: 500 },
    }, 'left-click-b-50-v1')).toEqual({ improved: true })
    expect(() => parseMinigameSubmissionResult({
      improved: true,
      record: { ranking_key: 'left-click-i-50-v1', score: 500 },
    }, 'left-click-b-50-v1')).toThrow('提交结果无效')
  })
})
