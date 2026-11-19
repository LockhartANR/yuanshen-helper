import { describe, expect, it } from 'vitest'
import {
  normalizeDetail,
  normalizeStoredFields,
  withDetailMetadata,
} from '../src/features/custom-ranking/fields'

describe('排行榜字段规范化', () => {
  it('detailbulk 与 staticdetailbatch 的 cl / ce 归一为同一派生字段', () => {
    const detail = normalizeDetail({
      id: 1,
      player: 1,
      left: 10,
      right: 5,
      double: 5,
      left_ce: 8,
      right_ce: 3,
      double_ce: 4,
    })
    expect(detail.fields.cl).toBe(20)
    expect(detail.fields.ce).toBe(15)
    expect(detail.fields.clicks).toBe(20)
    expect(detail.fields.effectiveClicks).toBe(15)
  })

  it('接口显式提供的 cl / ce 优先于派生值', () => {
    const detail = normalizeDetail({
      id: 1,
      player: 1,
      cl: 11,
      ce: 9,
      left: 10,
      right: 5,
      double: 5,
      left_ce: 8,
      right_ce: 3,
      double_ce: 4,
    })
    expect(detail.fields.cl).toBe(11)
    expect(detail.fields.ce).toBe(9)
    // 兼容别名与该条录像的标准字段完全一致，即使接口值与分项和不一致。
    expect(detail.fields.clicks).toBe(11)
    expect(detail.fields.effectiveClicks).toBe(9)
  })

  it('旧快照本地字段在计算前统一规范化，标准名和别名同值', () => {
    const old = normalizeStoredFields({
      cl: null,
      clicks: 20,
      ce: null,
      effectiveClicks: 15,
      bv: 10,
      left: 10,
      right: 5,
      double: 5,
      left_ce: 8,
      right_ce: 3,
      double_ce: 4,
    })
    expect(old.cl).toBe(20)
    expect(old.clicks).toBe(20)
    expect(old.ce).toBe(15)
    expect(old.effectiveClicks).toBe(15)
    expect(old.ioe).toBeCloseTo(0.5)

    const explicit = normalizeStoredFields({
      cl: 11,
      clicks: 20,
      ce: 9,
      effectiveClicks: 15,
      bv: 11,
      left: 10,
      right: 5,
      double: 5,
      left_ce: 8,
      right_ce: 3,
      double_ce: 4,
    })
    expect([explicit.cl, explicit.clicks]).toEqual([11, 11])
    expect([explicit.ce, explicit.effectiveClicks]).toEqual([9, 9])

    const zero = normalizeStoredFields({
      cl: 0,
      ce: 0,
      left: 10,
      right: 5,
      double: 5,
      left_ce: 8,
      right_ce: 3,
      double_ce: 4,
    })
    expect([zero.cl, zero.clicks, zero.ce, zero.effectiveClicks]).toEqual([0, 0, 0, 0])

    const missing = normalizeStoredFields({ left: 10, right: null, double: 5 })
    expect(missing.cl).toBeNull()
    expect(missing.clicks).toBeNull()
  })

  it('复用解析字段时覆盖 abstractbulk 的最新元信息', () => {
    const detail = normalizeDetail({ id: 1, player: 1, upload_time: 'old', state: 'c' })
    const merged = withDetailMetadata(detail, {
      player: 2,
      state: 'a',
      uploadTime: '2026-11-17T00:00:00Z',
    })
    expect(merged.fields.player).toBe(2)
    expect(merged.fields.state).toBe('a')
    expect(merged.fields.upload_time).toBe('2026-11-17T00:00:00Z')
    expect(merged.raw.player).toBe(2)
    expect(merged.raw.state).toBe('a')
  })
})
