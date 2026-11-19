import { FormulaError, type Expr } from './ast'
import { tokenize, type Token } from './tokenizer'

class Parser {
  private index = 0

  constructor(private readonly tokens: Token[]) {}

  parse(): Expr {
    const expression = this.parseOr()
    const rest = this.peek()
    if (rest.type !== 'eof') {
      throw new FormulaError(`多余的内容「${rest.value}」`, rest.pos)
    }
    return expression
  }

  private peek(): Token {
    return this.tokens[this.index] ?? this.tokens[this.tokens.length - 1]!
  }

  private next(): Token {
    const token = this.peek()
    if (token.type !== 'eof') this.index += 1
    return token
  }

  private takeOperator(value: string): boolean {
    const token = this.peek()
    if (token.type !== 'operator' || token.value !== value) return false
    this.index += 1
    return true
  }

  private expectOperator(value: string): void {
    const token = this.next()
    if (token.type !== 'operator' || token.value !== value) {
      throw new FormulaError(`这里需要「${value}」`, token.pos)
    }
  }

  private parseOr(): Expr {
    let left = this.parseAnd()
    while (this.takeOperator('||')) {
      left = { type: 'binary', op: '||', left, right: this.parseAnd(), pos: left.pos }
    }
    return left
  }

  private parseAnd(): Expr {
    let left = this.parseComparison()
    while (this.takeOperator('&&')) {
      left = { type: 'binary', op: '&&', left, right: this.parseComparison(), pos: left.pos }
    }
    return left
  }

  private parseComparison(): Expr {
    let left = this.parseAdd()
    while (true) {
      const token = this.peek()
      if (
        token.type !== 'operator' ||
        !['==', '!=', '<', '<=', '>', '>='].includes(token.value)
      ) {
        break
      }
      this.index += 1
      left = {
        type: 'binary',
        op: token.value as '==' | '!=' | '<' | '<=' | '>' | '>=',
        left,
        right: this.parseAdd(),
        pos: left.pos,
      }
    }
    return left
  }

  private parseAdd(): Expr {
    let left = this.parseMul()
    while (true) {
      const token = this.peek()
      if (token.type !== 'operator' || (token.value !== '+' && token.value !== '-')) break
      this.index += 1
      left = {
        type: 'binary',
        op: token.value,
        left,
        right: this.parseMul(),
        pos: left.pos,
      }
    }
    return left
  }

  private parseMul(): Expr {
    let left = this.parseUnary()
    while (true) {
      const token = this.peek()
      if (token.type !== 'operator' || !['*', '/', '%'].includes(token.value)) break
      this.index += 1
      left = {
        type: 'binary',
        op: token.value as '*' | '/' | '%',
        left,
        right: this.parseUnary(),
        pos: left.pos,
      }
    }
    return left
  }

  private parseUnary(): Expr {
    const token = this.peek()
    if (token.type === 'operator' && (token.value === '+' || token.value === '-' || token.value === '!')) {
      this.index += 1
      return {
        type: 'unary',
        op: token.value,
        arg: this.parseUnary(),
        pos: token.pos,
      }
    }
    return this.parsePower()
  }

  private parsePower(): Expr {
    const left = this.parsePrimary()
    if (!this.takeOperator('^')) return left
    // 幂右结合；指数再走一元层，因此 2^-2 与 2^3^2 都符合数学写法。
    return { type: 'binary', op: '^', left, right: this.parseUnary(), pos: left.pos }
  }

  private parsePrimary(): Expr {
    const token = this.next()
    if (token.type === 'number') {
      return { type: 'number', value: Number(token.value), pos: token.pos }
    }
    if (token.type === 'string') {
      return { type: 'string', value: token.value, pos: token.pos }
    }
    if (token.type === 'identifier') {
      if (token.value === 'true' || token.value === 'false') {
        return { type: 'boolean', value: token.value === 'true', pos: token.pos }
      }
      if (token.value === 'null') return { type: 'null', pos: token.pos }
      if (!this.takeOperator('(')) {
        return { type: 'field', name: token.value, pos: token.pos }
      }
      const args: Expr[] = []
      if (!this.takeOperator(')')) {
        do {
          args.push(this.parseOr())
        } while (this.takeOperator(','))
        this.expectOperator(')')
      }
      return { type: 'call', name: token.value, args, pos: token.pos }
    }
    if (token.type === 'operator' && token.value === '(') {
      const expression = this.parseOr()
      this.expectOperator(')')
      return expression
    }
    throw new FormulaError('这里需要一个数值、字段或函数', token.pos)
  }
}

export function parseFormula(source: string): Expr {
  return new Parser(tokenize(source)).parse()
}
