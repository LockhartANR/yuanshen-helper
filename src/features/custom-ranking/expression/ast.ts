export type Expr =
  | { type: 'number'; value: number; pos: number }
  | { type: 'string'; value: string; pos: number }
  | { type: 'boolean'; value: boolean; pos: number }
  | { type: 'null'; pos: number }
  | { type: 'field'; name: string; pos: number }
  | { type: 'unary'; op: '+' | '-' | '!'; arg: Expr; pos: number }
  | {
      type: 'binary'
      op: '+' | '-' | '*' | '/' | '%' | '^' | '==' | '!=' | '<' | '<=' | '>' | '>=' | '&&' | '||'
      left: Expr
      right: Expr
      pos: number
    }
  | { type: 'call'; name: string; args: Expr[]; pos: number }

export type RuntimeValue = number | string | boolean | null

export class FormulaError extends Error {
  readonly position: number

  constructor(message: string, position = 0) {
    super(message)
    this.name = 'FormulaError'
    this.position = position
  }
}

export function isAggregateName(name: string): boolean {
  return (
    name === 'count' ||
    name === 'countValid' ||
    name === 'sum' ||
    name === 'avg' ||
    name === 'min' ||
    name === 'max'
  )
}

export function isScalarFunction(name: string): boolean {
  return (
    name === 'if' ||
    name === 'isNull' ||
    name === 'abs' ||
    name === 'sqrt' ||
    name === 'pow' ||
    name === 'log' ||
    name === 'exp' ||
    name === 'floor' ||
    name === 'ceil' ||
    name === 'round'
  )
}

export const MAX_FORMULA_LENGTH = 2000
export const MAX_FORMULA_NODES = 256
export const MAX_FORMULA_DEPTH = 32
