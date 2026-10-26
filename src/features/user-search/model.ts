import { pinyin } from 'pinyin-pro'

export type NameState = 'visible' | 'anonymous' | 'hidden'

export interface RawUser {
  id?: unknown
  username?: unknown
  realname?: unknown
  firstname?: unknown
  lastname?: unknown
  [key: string]: unknown
}

export interface UserRecord {
  id: number
  username: string
  realname: string
  firstname: string
  lastname: string
  nameState: NameState
  usernameLower: string
  realnameLower: string
  firstnameLower: string
  lastnameLower: string
  text: string
  pyFull: string
  pyInitials: string
}

const HIDDEN_NAME = 'hidden'
const ANONYMOUS_NAME = '匿名'

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Lowercase, full-width -> half-width, collapse whitespace. */
export function normalize(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, ' ')
}

function buildPinyin(source: string): { full: string; initials: string } {
  const cleaned = source.replace(/\s+/g, '')
  if (!cleaned) return { full: '', initials: '' }

  const full = pinyin(cleaned, { toneType: 'none', type: 'array' })
    .join('')
    .replace(/\s+/g, '')
    .toLowerCase()
  const initials = pinyin(cleaned, { toneType: 'none', pattern: 'first', type: 'array' })
    .join('')
    .replace(/\s+/g, '')
    .toLowerCase()

  return { full, initials }
}

const CJK_RUN = /[\u3400-\u9FFF]+/g

/** Pinyin is only useful for CJK text; English is covered by the text index. */
function chineseOnly(value: string): string {
  return value.match(CJK_RUN)?.join('') ?? ''
}

export function toRecord(raw: RawUser): UserRecord | null {
  const id = Number(raw.id)
  if (!Number.isInteger(id) || id <= 0) return null

  const username = asText(raw.username)
  const rawRealname = asText(raw.realname)
  const rawFirstname = asText(raw.firstname)
  const rawLastname = asText(raw.lastname)

  const hidden = [rawRealname, rawFirstname, rawLastname].some(
    (value) => value.toLowerCase() === HIDDEN_NAME,
  )
  const anonymous =
    !hidden && (rawRealname === '' || rawRealname === ANONYMOUS_NAME)

  const realname = hidden || anonymous ? '' : rawRealname
  const firstname = hidden ? '' : rawFirstname
  const lastname = hidden ? '' : rawLastname
  const nameState: NameState = hidden ? 'hidden' : anonymous ? 'anonymous' : 'visible'

  const usernameLower = normalize(username)
  const realnameLower = normalize(realname)
  const firstnameLower = normalize(firstname)
  const lastnameLower = normalize(lastname)

  // Keep both name orders (and compact forms) so "San Zhang" / "Zhang San" /
  // "SanZhang" all match the same user.
  const englishParts = [firstname, lastname].filter(Boolean)
  const textParts = [
    username,
    realname,
    firstname,
    lastname,
    englishParts.join(' '),
    [...englishParts].reverse().join(' '),
    englishParts.join(''),
    [...englishParts].reverse().join(''),
  ].filter(Boolean)
  const text = normalize(
    [...new Set(textParts.map((value) => value.toLowerCase()))].join(' '),
  )
  const pinyinParts = [chineseOnly(username), chineseOnly(realname)].filter(
    (value, index, all) => value !== '' && all.indexOf(value) === index,
  )
  const py = buildPinyin(pinyinParts.join(''))

  return {
    id,
    username,
    realname,
    firstname,
    lastname,
    nameState,
    usernameLower,
    realnameLower,
    firstnameLower,
    lastnameLower,
    text,
    pyFull: py.full,
    pyInitials: py.initials,
  }
}

export function displayName(record: UserRecord): string {
  return record.username || record.realname || `#${record.id}`
}

function fullEnglishName(record: UserRecord): string {
  return [record.firstname, record.lastname].filter(Boolean).join(' ')
}

export function secondaryName(record: UserRecord): string {
  if (record.nameState === 'hidden') return '实名已隐藏'

  const parts: string[] = [record.realname || '匿名']
  const english = fullEnglishName(record)
  if (english && english.toLowerCase() !== record.realname.toLowerCase()) {
    parts.push(english)
  }
  return parts.join(' · ')
}
