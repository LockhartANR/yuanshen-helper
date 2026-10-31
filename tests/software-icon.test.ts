import { describe, expect, it } from 'vitest'
import { softwareIconPath } from '../src/features/player-stats/software-icon'

describe('软件图标', () => {
  it('四个软件各对应一张图', () => {
    expect(softwareIconPath('a')).toBe('icons/software/a.png')
    expect(softwareIconPath('e')).toBe('icons/software/e.png')
    expect(softwareIconPath('m')).toBe('icons/software/m.png')
    expect(softwareIconPath('r')).toBe('icons/software/r.png')
  })

  it('未知软件返回 null', () => {
    expect(softwareIconPath('')).toBeNull()
    expect(softwareIconPath('x')).toBeNull()
  })
})
