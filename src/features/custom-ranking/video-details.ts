import { getRankingGameFields } from './calculator'
import type { Expr } from './expression/ast'
import { evaluateScalar } from './expression/evaluate'
import type { CompiledFormula } from './expression/validate'
import type { GlobalRankFieldValue, RankFilter } from './model'
import { scanRankingVideos } from './store'

export interface VideoDetailFormula {
  source: string
  aggregate: 'sum' | 'min' | 'max'
  expression: Expr
  fields: string[]
}

export function getVideoDetailFormula(formula: CompiledFormula): VideoDetailFormula | null {
  const { ast, source, fields } = formula
  if (ast.type !== 'call' || (ast.name !== 'sum' && ast.name !== 'min' && ast.name !== 'max')) {
    return null
  }
  return { source, aggregate: ast.name, expression: ast.args[0]!, fields: [...fields] }
}

export interface VideoDetailQuery {
  datasetId: string
  version: string
  playerId: number
  filter: RankFilter
  formula: VideoDetailFormula
  value: number
}

interface VideoDetailRow {
  videoId: number
  value: number
  fields: GlobalRankFieldValue[]
}

export async function loadRankingVideoDetails(query: VideoDetailQuery, signal?: AbortSignal) {
  const { datasetId, version, playerId, filter, formula, value } = query
  const videos: VideoDetailRow[] = []
  let validCount = 0
  await scanRankingVideos(datasetId, (row) => {
    if (signal?.aborted) return false
    const fields = getRankingGameFields(row, filter)
    if (!fields) return
    const input = evaluateScalar(formula.expression, { fields })
    if (typeof input !== 'number' || !Number.isFinite(input)) return
    validCount += 1
    if (formula.aggregate !== 'sum' && input !== value) return
    videos.push({
      videoId: row.videoId,
      value: input,
      fields: formula.fields.map((name) => fields[name] ?? null),
    })
  }, { playerId, version })
  return { validCount, videos }
}
