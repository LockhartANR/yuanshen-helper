import { FormulaError } from './ast'

export type TokenType = 'number' | 'string' | 'identifier' | 'operator' | 'eof'

export interface Token {
  type: TokenType
  value: string
  pos: number
}

const TWO_CHAR = new Set(['<=', '>=', '==', '!=', '&&', '||'])
const ONE_CHAR = new Set(['+', '-', '*', '/', '%', '^', '(', ')', ',', '<', '>', '!'])

export function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let index = 0

  while (index < source.length) {
    const char = source[index]!
    if (/\s/.test(char)) {
      index += 1
      continue
    }

    if (/\d/.test(char) || (char === '.' && /\d/.test(source[index + 1] ?? ''))) {
      const start = index
      let text = ''
      while (/\d/.test(source[index] ?? '')) {
        text += source[index]
        index += 1
      }
      if (source[index] === '.') {
        text += '.'
        index += 1
        while (/\d/.test(source[index] ?? '')) {
          text += source[index]
          index += 1
        }
      }
      if (source[index] === 'e' || source[index] === 'E') {
        const mark = index
        text += source[index]
        index += 1
        if (source[index] === '+' || source[index] === '-') {
          text += source[index]
          index += 1
        }
        let digits = 0
        while (/\d/.test(source[index] ?? '')) {
          text += source[index]
          index += 1
          digits += 1
        }
        if (digits === 0) {
          throw new FormulaError('数字指数部分不完整', mark)
        }
      }
      const value = Number(text)
      if (!Number.isFinite(value)) {
        throw new FormulaError('数字必须有限', start)
      }
      tokens.push({ type: 'number', value: text, pos: start })
      continue
    }

    if (char === '"' || char === "'") {
      const quote = char
      const start = index
      index += 1
      let value = ''
      let closed = false
      while (index < source.length) {
        const current = source[index]!
        index += 1
        if (current === quote) {
          closed = true
          break
        }
        if (current === '\\') {
          const next = source[index]
          if (next === undefined) break
          index += 1
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next
          continue
        }
        value += current
      }
      if (!closed) throw new FormulaError('字符串缺少结束引号', start)
      tokens.push({ type: 'string', value, pos: start })
      continue
    }

    if (/[A-Za-z_]/.test(char)) {
      const start = index
      let value = ''
      while (/[A-Za-z0-9_]/.test(source[index] ?? '')) {
        value += source[index]
        index += 1
      }
      tokens.push({ type: 'identifier', value, pos: start })
      continue
    }

    const two = source.slice(index, index + 2)
    if (TWO_CHAR.has(two)) {
      tokens.push({ type: 'operator', value: two, pos: index })
      index += 2
      continue
    }
    if (ONE_CHAR.has(char)) {
      tokens.push({ type: 'operator', value: char, pos: index })
      index += 1
      continue
    }
    throw new FormulaError(`无法识别的字符「${char}」`, index)
  }

  tokens.push({ type: 'eof', value: '', pos: source.length })
  return tokens
}
