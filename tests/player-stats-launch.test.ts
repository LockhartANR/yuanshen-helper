import { describe, expect, it } from 'vitest'
import {
  parsePlayerId,
  parsePlayerLaunch,
  parseSitePlayerRoute,
} from '../src/features/player-stats/launch'

function launchOf(search: string, framed = false) {
  const result = parsePlayerLaunch(search, { framed })
  if (!result.ok) throw new Error(result.message)
  return result.launch
}

function messageOf(search: string, framed = false): string {
  const result = parsePlayerLaunch(search, { framed })
  if (result.ok) throw new Error('预期参数错误，实际解析成功')
  return result.message
}

describe('玩家页启动参数', () => {
  it('合法玩家 ID 进入网站模式，默认成绩概况', () => {
    expect(launchOf('?id=16')).toEqual({
      kind: 'site',
      userId: 16,
      initialPage: 'score',
      embedded: false,
    })
    expect(launchOf('?id=16&view=analysis')).toEqual({
      kind: 'site',
      userId: 16,
      initialPage: 'analysis',
      embedded: false,
    })
  })

  it('独立 CSV 不需要 ID，默认赛博大表，附带 ID 也不绑定玩家', () => {
    expect(launchOf('?source=csv')).toEqual({ kind: 'csv', initialPage: 'analysis' })
    expect(launchOf('?source=csv&id=16')).toEqual({ kind: 'csv', initialPage: 'analysis' })
    expect(launchOf('?source=csv&view=score')).toEqual({ kind: 'csv', initialPage: 'score' })
  })

  it.each(['?', '?id=', '?id=0', '?id=-1', '?id=1.5', '?id=abc', '?id=1e3'])(
    '缺少合法 ID 时保留原有错误提示：%s',
    (search) => {
      expect(messageOf(search)).toContain('缺少合法的用户 ID')
    },
  )

  it('超出安全整数范围的 ID 被拒绝', () => {
    expect(messageOf('?id=9007199254740992')).toContain('缺少合法的用户 ID')
    expect(parsePlayerId('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('未知 source / embed / view 取值报参数错误', () => {
    expect(messageOf('?id=16&source=foo')).toContain('未知的 source 参数')
    expect(messageOf('?id=16&embed=foo')).toContain('未知的 embed 参数')
    expect(messageOf('?id=16&view=foo')).toContain('未知的 view 参数')
  })

  it('embed 与 CSV 冲突、嵌入模式缺 ID 或指定成绩页都报错', () => {
    expect(messageOf('?source=csv&embed=analysis')).toContain('不能和')
    expect(messageOf('?embed=analysis')).toContain('嵌入模式需要合法的玩家 ID')
    expect(messageOf('?id=0&embed=analysis')).toContain('嵌入模式需要合法的玩家 ID')
    expect(messageOf('?id=16&embed=analysis&view=score')).toContain('嵌入模式只显示赛博大表')
  })

  it('嵌入模式固定赛博大表并标记 embedded', () => {
    expect(launchOf('?id=16&embed=analysis')).toEqual({
      kind: 'site',
      userId: 16,
      initialPage: 'analysis',
      embedded: true,
    })
  })

  it('外部 iframe 只允许嵌入模式', () => {
    expect(messageOf('?id=16', true)).toContain('只能在站内嵌入模式')
    expect(messageOf('?source=csv', true)).toContain('只能在站内嵌入模式')
    expect(launchOf('?id=16&embed=analysis', true)).toMatchObject({
      kind: 'site',
      embedded: true,
    })
  })
})

describe('站点玩家路由', () => {
  it.each([
    ['#/player/16', 16],
    ['#/player/16/', 16],
    ['#/player/16?from=search', 16],
    ['/player/16', 16],
    // 站点会把 #/player/<ID> 重定向到带页签的 #/player/<ID>/top。
    ['#/player/16/top', 16],
    ['#/player/16/top/', 16],
    ['#/player/16/top?from=search', 16],
    ['#/player/16/recent', 16],
  ])('%s -> %s', (hash, id) => {
    expect(parseSitePlayerRoute(hash)).toBe(id)
  })

  it.each([
    '',
    '#',
    '#/',
    '#/player',
    '#/player/',
    '#/player/0',
    '#/player/0/top',
    '#/video/16',
    '#/player/16/videos/1',
    '#/player/16/top/1',
  ])('非玩家页、非法 ID 或过深路由返回 null：%s', (hash) => {
    expect(parseSitePlayerRoute(hash)).toBeNull()
  })
})
