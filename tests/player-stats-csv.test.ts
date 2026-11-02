import { describe, expect, it } from 'vitest'
import { parseStatsCsv } from '../src/features/player-stats/csv'
import { computePb, computeTop5, eligible } from '../src/features/player-stats/compute'
import { analyzeGames, gcStats, rankGames } from '../src/features/player-stats/analysis'

const HEADER =
  'Day,Month,Year,Hour,Min,Sec,mode,Time,BBBV,BBBVs,style,cell0,cell1,cell2,cell3,cell4,cell5,cell6,cell7,cell8,Lcl,Rcl,Dcl,Leff,Reff,Deff,Openings,Islands,Path,GZiNi,HZiNi'
const ROW = '2,8,2024,16,1,12,BEG,5.00,12,2.40,Flag,19,21,10,4,0,0,0,0,0,12,3,3,12,1,3,3,3,992,12,12'

describe('stats CSV', () => {
  it('映射 31 列 stats CSV，保留重复行并分配唯一 ID', () => {
    const result = parseStatsCsv(`${HEADER}\n${ROW}\n${ROW}\n`)
    expect(result.total).toBe(2)
    expect(result.videos).toHaveLength(2)
    expect(result.videos.map((video) => video.id)).toEqual([-1, -2])
    expect(result.errors).toHaveLength(0)
    const video = result.videos[0]!
    expect(video.level).toBe('b')
    expect(video.timems).toBe(5000)
    expect(video.bv).toBe(12)
    expect(video.left).toBe(12)
    expect(video.right).toBe(3)
    expect(video.left_ce).toBe(12)
    expect(video.right_ce).toBe(1)
    expect(video.path).toBe(992)
    const date = new Date(video.end_time!)
    expect([date.getFullYear(), date.getMonth() + 1, date.getDate()]).toEqual([2024, 8, 2])
  })

  it('NF 按 style 分类，保留原始点击字段', () => {
    const nf = ROW.replace(',Flag,', ',NF,')
    const video = parseStatsCsv(`${HEADER}\n${nf}\n`).videos[0]!
    expect(video.right).toBe(3)
    expect(video.right_ce).toBe(1)
    expect(video.csvNf).toBe(true)
    expect(eligible(video, { nfOnly: true })).toBe(true)
    expect(analyzeGames([video], { nfOnly: true }, 1)).toHaveLength(1)
  })

  it('拒绝非 stats CSV 表头', () => {
    expect(() => parseStatsCsv('a,b,c\n1,2,3\n')).toThrow('表头不匹配')
  })

  it.each([['BEG', 54], ['INT', 216], ['EXP', 381]] as const)(
    '%s 接受 1 和上限 %i，拒绝越界及非安全整数', (mode, max) => {
      for (const bv of [1, max, 0, max + 1, 1.5, 1e20]) {
        const fields = ROW.split(',')
        fields[6] = mode
        fields[8] = String(bv)
        const result = parseStatsCsv(`${HEADER}\n${fields.join(',')}`)
        expect(result.videos.length).toBe(bv === 1 || bv === max ? 1 : 0)
        expect(result.errors.length).toBe(bv === 1 || bv === max ? 0 : 1)
      }
    },
  )

  it('Flag 的 Rcl/Reff 不一致或缺失时，两个 NF 入口仍一致', () => {
    for (const [right, effective] of [['3', '0'], ['0', '1'], ['', '0'], ['0', '']]) {
      const fields = ROW.split(',')
      fields[21] = right
      fields[24] = effective
      const { videos } = parseStatsCsv(`${HEADER}\n${fields.join(',')}`)
      expect(videos).toHaveLength(1)
      expect(eligible(videos[0]!, { nfOnly: true })).toBe(false)
      expect(analyzeGames(videos, { nfOnly: true }, 1)).toHaveLength(0)
    }
  })

  it('拒绝未知或空 style', () => {
    for (const style of ['', 'unknown']) {
      const result = parseStatsCsv(`${HEADER}\n${ROW.replace(',Flag,', `,${style},`)}`)
      expect(result.videos).toHaveLength(0)
      expect(result.errors[0]?.message).toContain('style')
    }
  })

  it('保留网站原有的两个 NF 判定口径', () => {
    const video = parseStatsCsv(`${HEADER}\n${ROW}`).videos[0]!
    delete video.csvNf
    video.software = 'a'
    video.right_ce = 0
    expect(eligible(video, { nfOnly: true })).toBe(true)
    expect(analyzeGames([video], { nfOnly: true }, 1)).toHaveLength(0)
  })

  it('跨文件同分时先导入优先，PB、Top5、大表排序一致且不去重', () => {
    const first = parseStatsCsv(`${HEADER}\n${ROW}`).videos
    const second = parseStatsCsv(`${HEADER}\n${ROW}`, first.length).videos
    const videos = [...second, ...first]
    expect(computePb(videos)[0]?.video.id).toBe(-1)
    expect(computeTop5(videos)[0]?.rows.map((row) => row.video.id)).toEqual([-1, -2])
    const games = analyzeGames(videos, {}, 1)
    expect(games.map((game) => game.video.id)).toEqual([-1, -2])
    expect(rankGames(games, 'time').map((game) => game.video.id)).toEqual([-1, -2])
  })

  it('低于 GC 起点的合法记录保留，但不改变 GC 分段', () => {
    const { videos } = parseStatsCsv(`${HEADER}\n${ROW.replace(',12,2.40,', ',1,2.40,')}`)
    expect(videos).toHaveLength(1)
    expect(computePb(videos)).toHaveLength(1)
    const stats = gcStats(analyzeGames(videos, {}, 1))
    expect(stats[0]?.segments[0]?.start).toBe(2)
    expect(stats[0]?.segments.reduce((sum, segment) => sum + segment.count, 0)).toBe(0)
  })

  it.each([
    ROW.replace(/12$/, '"12'),
    ROW.replace(',BEG,', ',B"EG,'),
    ROW.replace(',BEG,', ',"BEG"x,'),
  ])('拒绝非法引号：%s', (row) => {
    expect(() => parseStatsCsv(`${HEADER}\n${row}`)).toThrow(/CSV 第 2 行/)
  })

  it('支持引号内逗号、转义和换行，错误报告保留物理行号', () => {
    const fields = ROW.split(',')
    fields[29] = '"ignored, ""quoted""\nvalue"'
    const bad = ROW.replace(',5.00,', ',0,')
    const result = parseStatsCsv(`\uFEFF${HEADER}\r\n\r\n${fields.join(',')}\r\n${bad}`)
    expect(result.videos).toHaveLength(1)
    expect(result.total).toBe(2)
    expect(result.errors[0]?.line).toBe(5)
  })

  it.each(['1e308', '0.0001'])('拒绝不能表示为正安全毫秒的 Time %s', (time) => {
    const result = parseStatsCsv(`${HEADER}\n${ROW.replace(',5.00,', `,${time},`)}`)
    expect(result.videos).toHaveLength(0)
    expect(result.errors[0]?.message).toContain('Time')
  })
})
