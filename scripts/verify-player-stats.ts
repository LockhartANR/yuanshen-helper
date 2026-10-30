/**
 * 对拍脚本：用真实接口算一个用户的 PB 和前端成绩，再和站点自己的成绩接口逐条比。
 *
 *   node scripts/verify-player-stats.ts 16
 *   OPENMS_BASE=http://127.0.0.1:8000 node scripts/verify-player-stats.ts 16
 *
 * 退出码：0 全部一致；1 有差异；2 用法错误或接口失败。
 */
import {
  bvsOf,
  computePb,
  computeTop5,
  iqgOf,
  joinVideos,
  markDuplicates,
} from '../src/features/player-stats/compute.ts'
import { LEVELS, TOP_STATS } from '../src/features/player-stats/model.ts'
import type {
  Level,
  TopStat,
  VideoDetail,
  VideoMeta,
} from '../src/features/player-stats/model.ts'

const BASE = (process.env.OPENMS_BASE ?? 'https://openms.top').replace(/\/+$/, '')
const BATCH_SIZE = 100
const BATCH_GAP_MS = 260

interface SitePbRecord {
  video_id: number
  timems: number
  rank: number | null
  level: Level
  bv: number
  nf: boolean
}

interface SiteTopRecord {
  videos: { video_id: number; value: number }[]
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let requestCount = 0

async function fetchJson<T>(path: string): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    requestCount += 1
    const response = await fetch(`${BASE}${path}`, {
      headers: { accept: 'application/json' },
    })
    if (response.ok) return (await response.json()) as T
    if (response.status === 429 || response.status >= 500) {
      await sleep(2_000 * 2 ** attempt)
      continue
    }
    const text = await response.text().catch(() => '')
    throw new Error(`${path} -> HTTP ${response.status} ${text.slice(0, 120)}`)
  }
  throw new Error(`${path} 连续失败`)
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

const STAT_CODE: Record<TopStat, string> = { time: 't', bvs: 'b', stnb: 's' }

function closeEnough(actual: number, expected: number): boolean {
  if (actual === expected) return true
  const scale = Math.max(Math.abs(actual), Math.abs(expected), 1)
  return Math.abs(actual - expected) / scale < 1e-6
}

function formatValue(stat: TopStat, value: number): string {
  if (stat === 'time') return `${value}ms`
  return value.toFixed(6)
}

function metricFor(stat: TopStat, video: { bv: number | null; timems: number }): number {
  if (stat === 'time') return video.timems
  if (stat === 'bvs') return bvsOf(video)
  return iqgOf(video)
}

async function fetchDetails(ids: number[]): Promise<{ details: Map<number, VideoDetail>; missing: number[] }> {
  const details = new Map<number, VideoDetail>()
  const batches = chunk(ids, BATCH_SIZE)
  console.log(`明细：${ids.length} 条，${batches.length} 批（每批 ${BATCH_SIZE}，间隔 ${BATCH_GAP_MS}ms）`)

  for (const [index, batch] of batches.entries()) {
    const rows = await fetchJson<VideoDetail[]>(`/api/video/staticdetailbatch?ids=${batch.join(',')}`)
    for (const row of rows) details.set(row.id, row)
    if (index < batches.length - 1) await sleep(BATCH_GAP_MS)
    if (batches.length > 8 && (index + 1) % 10 === 0) {
      console.log(`  已取 ${index + 1}/${batches.length} 批`)
    }
  }

  const missing = ids.filter((id) => !details.has(id))
  if (missing.length > 0) {
    // 公开状态可能在两次请求之间变化，缺的补一次。
    const retry = await fetchJson<VideoDetail[]>(
      `/api/video/staticdetailbatch?ids=${missing.slice(0, BATCH_SIZE).join(',')}`,
    )
    for (const row of retry) details.set(row.id, row)
  }

  return { details, missing: ids.filter((id) => !details.has(id)) }
}

function comparePb(
  videos: Parameters<typeof computePb>[0],
  site: SitePbRecord[],
): { mismatches: string[]; warnings: string[]; ourCount: number } {
  const ours = new Map<string, { videoId: number; timems: number }>()
  for (const nf of [false, true]) {
    for (const row of computePb(videos, { nfOnly: nf })) {
      ours.set(`${nf ? 'nf' : 'std'}:${row.level}:${row.bv}`, {
        videoId: row.video.id,
        timems: row.video.timems,
      })
    }
  }

  const mismatches: string[] = []
  const warnings: string[] = []
  const seen = new Set<string>()
  for (const record of site) {
    const key = `${record.nf ? 'nf' : 'std'}:${record.level}:${record.bv}`
    seen.add(key)
    const mine = ours.get(key)
    if (!mine) {
      // 站点有 0ms 的脏数据，我们按「无效成绩」过滤掉了，记录成提示而不是差异。
      if (record.timems <= 0) {
        warnings.push(`PB ${key}: 站点 #${record.video_id} 是 ${record.timems}ms，已按无效成绩忽略`)
      } else {
        mismatches.push(`PB ${key}: 站点 #${record.video_id} ${record.timems}ms，我们没算出来`)
      }
      continue
    }
    if (mine.videoId !== record.video_id || mine.timems !== record.timems) {
      const detail = `站点 #${record.video_id} ${record.timems}ms / 我们 #${mine.videoId} ${mine.timems}ms`
      if (mine.timems < record.timems) {
        // 我们算出的成绩更快，通常意味着站点 PB 缓存还没跟上（例如导入的录像没触发重建）。
        warnings.push(`PB ${key}: 我们更快（${detail}），可能是站点缓存滞后`)
      } else {
        mismatches.push(`PB ${key}: ${detail}`)
      }
    }
  }
  for (const [key, mine] of ours) {
    if (!seen.has(key)) mismatches.push(`PB ${key}: 我们多出 #${mine.videoId} ${mine.timems}ms`)
  }

  return { mismatches, warnings, ourCount: ours.size }
}

function compareTop5(
  videos: Parameters<typeof computeTop5>[0],
  site: Record<string, SiteTopRecord>,
): { mismatches: string[]; warnings: string[]; ourGroups: number } {
  const groups = computeTop5(videos)
  const byKey = new Map<string, (typeof groups)[number]>()
  for (const group of groups) {
    byKey.set(`${group.nf ? 'nf' : 'std'}:${group.level}${STAT_CODE[group.stat]}`, group)
  }

  const mismatches: string[] = []
  const warnings: string[] = []
  let compared = 0

  for (const [key, record] of Object.entries(site)) {
    const group = byKey.get(key)
    compared += 1
    if (!group) {
      mismatches.push(`Top5 ${key}: 站点有 ${record.videos.length} 条，我们没有这个分组`)
      continue
    }
    const theirs = record.videos
    const ours = group.rows
    if (ours.length !== theirs.length) {
      mismatches.push(`Top5 ${key}: 条数不同（站点 ${theirs.length} / 我们 ${ours.length}）`)
      continue
    }
    const sameIds = theirs.every((item, index) => item.video_id === ours[index]?.video.id)
    if (!sameIds) {
      const theirIds = [...theirs.map((item) => item.video_id)].sort((a, b) => a - b).join(',')
      const ourIds = [...ours.map((row) => row.video.id)].sort((a, b) => a - b).join(',')
      if (theirIds === ourIds) {
        warnings.push(`Top5 ${key}: 同分项顺序不同（站点 ${theirs.map((i) => i.video_id).join(',')} / 我们 ${ours.map((r) => r.video.id).join(',')}）`)
      } else {
        mismatches.push(`Top5 ${key}: 录像不同（站点 ${theirIds} / 我们 ${ourIds}）`)
      }
      continue
    }
    for (const [index, item] of theirs.entries()) {
      const row = ours[index]!
      const actual = metricFor(group.stat, row.video)
      if (!closeEnough(actual, item.value)) {
        mismatches.push(
          `Top5 ${key} #${index + 1} #${row.video.id}: 站点 ${formatValue(group.stat, item.value)} / 我们 ${formatValue(group.stat, actual)}`,
        )
      }
    }
  }

  return { mismatches, warnings, ourGroups: compared }
}

async function main(): Promise<void> {
  const userId = Number(process.argv[2] ?? '')
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    console.error('用法: node scripts/verify-player-stats.ts <userId>')
    process.exit(2)
  }

  const startedAt = Date.now()
  console.log(`站点 ${BASE} · 用户 #${userId}`)

  const metas = await fetchJson<VideoMeta[]>(`/api/userprofile/videolist?user_id=${userId}`)
  const usable = metas.filter((meta) => meta.state === 'c' && meta.ongoing_tournament !== true)
  console.log(`录像 ${metas.length} 条，已过审且非比赛 ${usable.length} 条`)

  const { details, missing } = await fetchDetails(usable.map((meta) => meta.id))
  const { videos } = joinVideos(usable, details)
  const duplicates = markDuplicates(videos)
  const suspects = videos.filter((video) => video.suspectDuplicate).length
  if (duplicates > 0 || suspects > 0) {
    console.log(`判重：确定重复 ${duplicates} 条，疑似 ${suspects} 条`)
  }

  const sitePb = await fetchJson<SitePbRecord[]>(`/api/speedranking/pb/player/${userId}`)
  const siteTop = await fetchJson<Record<string, SiteTopRecord>>(`/api/speedranking/top/player/${userId}`)

  const pb = comparePb(videos, sitePb)
  const top = compareTop5(videos, siteTop)

  console.log('')
  console.log(`PB：我们 ${pb.ourCount} 条 / 站点 ${sitePb.length} 条，差异 ${pb.mismatches.length}`)
  console.log(
    `Top5：${top.ourGroups} 组，差异 ${top.mismatches.length}，同分顺序差异 ${top.warnings.length}`,
  )
  if (missing.length > 0) console.log(`明细缺失 ${missing.length} 条：${missing.slice(0, 10).join(', ')}`)

  const issues = [...pb.mismatches, ...top.mismatches]
  const warnings = [...pb.warnings, ...top.warnings]
  if (issues.length > 0 || warnings.length > 0) {
    console.log('')
    for (const issue of issues.slice(0, 20)) console.log(`  ! ${issue}`)
    if (issues.length > 20) console.log(`  …还有 ${issues.length - 20} 处差异`)
    for (const warning of warnings.slice(0, 10)) console.log(`  ~ ${warning}`)
    if (warnings.length > 10) console.log(`  …还有 ${warnings.length - 10} 处提示`)
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
  console.log('')
  console.log(`用时 ${elapsed}s，请求 ${requestCount} 次`)
  console.log(issues.length === 0 ? '结果：全部一致' : `结果：有 ${issues.length} 处差异`)
  process.exit(issues.length === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(2)
})
