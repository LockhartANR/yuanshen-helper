import { describe, expect, it } from 'vitest'
import {
  displayName,
  secondaryName,
  toRecord,
} from '../src/features/user-search/model'

describe('toRecord', () => {
  it('keeps a visible name and builds search fields', () => {
    const record = toRecord({
      id: 1,
      username: 'zhangsan',
      realname: '张三',
      firstname: 'San',
      lastname: 'Zhang',
    })

    expect(record).not.toBeNull()
    expect(record?.nameState).toBe('visible')
    expect(record?.realname).toBe('张三')
    expect(record?.text).toContain('zhangsan')
    expect(record?.text).toContain('张三')
    expect(record?.pyFull).toBe('zhangsan')
    expect(record?.pyInitials).toBe('zs')
    expect(displayName(record!)).toBe('zhangsan')
    expect(secondaryName(record!)).toBe('张三 · San Zhang')
  })

  it('treats the hidden sentinel in any name field as hidden', () => {
    const record = toRecord({
      id: 2,
      username: 'ghost',
      realname: 'hidden',
      firstname: 'hidden',
      lastname: 'hidden',
    })

    expect(record?.nameState).toBe('hidden')
    expect(record?.realname).toBe('')
    expect(record?.firstname).toBe('')
    expect(record?.lastname).toBe('')
    expect(record?.text).toBe('ghost')
    expect(record?.pyFull).toBe('')
    expect(secondaryName(record!)).toBe('实名已隐藏')
  })

  it('treats 匿名 as anonymous, not hidden', () => {
    const record = toRecord({
      id: 3,
      username: 'someuser',
      realname: '匿名',
      firstname: 'Xiao',
      lastname: 'Lin',
    })

    expect(record?.nameState).toBe('anonymous')
    expect(record?.realname).toBe('')
    expect(record?.text).toContain('xiao')
    expect(record?.text).toContain('lin')
    expect(secondaryName(record!)).toBe('匿名 · Xiao Lin')
  })

  it('builds pinyin from a Chinese username even when the real name is anonymous', () => {
    const record = toRecord({
      id: 4,
      username: '林晓',
      realname: '匿名',
      firstname: '',
      lastname: '',
    })

    expect(record?.nameState).toBe('anonymous')
    expect(record?.pyFull).toBe('linxiao')
    expect(record?.pyInitials).toBe('lx')
  })

  it('tolerates missing fields', () => {
    const record = toRecord({ id: 5 })
    expect(record?.username).toBe('')
    expect(record?.realname).toBe('')
    expect(record?.nameState).toBe('anonymous')
    expect(displayName(record!)).toBe('#5')
    expect(secondaryName(record!)).toBe('匿名')
  })

  it('rejects invalid ids', () => {
    expect(toRecord({ id: 0 })).toBeNull()
    expect(toRecord({ id: 'x' })).toBeNull()
    expect(toRecord({})).toBeNull()
  })

  it('normalizes full-width characters and case', () => {
    const record = toRecord({ id: 6, username: 'ＺＨＡＮＧ' })
    expect(record?.usernameLower).toBe('zhang')
  })
})
