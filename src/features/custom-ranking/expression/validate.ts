import { lookupRankField } from '../fields'
import {
  FormulaError,
  isAggregateName,
  isScalarFunction,
  MAX_FORMULA_DEPTH,
  MAX_FORMULA_LENGTH,
  MAX_FORMULA_NODES,
  type Expr,
} from './ast'
import { parseFormula } from './parser'

export interface AggregateCall {
  node: Extract<Expr, { type: 'call' }>
  name: string
  inner: Expr | null
}

export interface CompiledFormula {
  source: string
  ast: Expr
  fields: Set<string>
  aggregates: AggregateCall[]
}

const ARITY: Record<string, number | [number, number]> = {
  if: 3,
  isNull: 1,
  abs: 1,
  sqrt: 1,
  pow: 2,
  log: 1,
  exp: 1,
  floor: 1,
  ceil: 1,
  round: [1, 2],
  count: 0,
  countValid: 1,
  sum: 1,
  avg: 1,
  min: 1,
  max: 1,
}

function arityMatches(name: string, count: number): boolean {
  const expected = ARITY[name]
  if (expected === undefined) return false
  if (typeof expected === 'number') return count === expected
  return count >= expected[0] && count <= expected[1]
}

function validateArity(name: string, args: Expr[], position: number): void {
  if (!arityMatches(name, args.length)) {
    const expected = ARITY[name]
    const text = Array.isArray(expected) ? `${expected[0]}–${expected[1]}` : String(expected)
    throw new FormulaError(`函数 ${name} 需要 ${text} 个参数`, position)
  }
}

function validateNode(
  node: Expr,
  insideAggregate: boolean,
  depth: number,
  state: { nodes: number; fields: Set<string>; aggregates: AggregateCall[] },
): void {
  if (depth > MAX_FORMULA_DEPTH) {
    throw new FormulaError(`公式嵌套层级不能超过 ${MAX_FORMULA_DEPTH} 层`, node.pos)
  }
  state.nodes += 1
  if (state.nodes > MAX_FORMULA_NODES) {
    throw new FormulaError(`公式节点不能超过 ${MAX_FORMULA_NODES} 个`, node.pos)
  }

  switch (node.type) {
    case 'number':
    case 'string':
    case 'boolean':
    case 'null':
      return
    case 'field':
      if (!insideAggregate) {
        throw new FormulaError(
          `字段 ${node.name} 只能出现在聚合函数参数里，例如 max(${node.name})`,
          node.pos,
        )
      }
      if (!lookupRankField(node.name)) {
        throw new FormulaError(`未知字段 ${node.name}`, node.pos)
      }
      state.fields.add(node.name)
      return
    case 'unary':
      validateNode(node.arg, insideAggregate, depth + 1, state)
      return
    case 'binary':
      validateNode(node.left, insideAggregate, depth + 1, state)
      validateNode(node.right, insideAggregate, depth + 1, state)
      return
    case 'call': {
      const name = node.name
      if (isAggregateName(name)) {
        if (insideAggregate) {
          throw new FormulaError('聚合函数不能嵌套，例如不能写 avg(max(bv))', node.pos)
        }
        validateArity(name, node.args, node.pos)
        for (const arg of node.args) {
          validateNode(arg, true, depth + 1, state)
        }
        state.aggregates.push({
          node,
          name,
          inner: node.args[0] ?? null,
        })
        return
      }
      if (!isScalarFunction(name)) {
        throw new FormulaError(`未知函数 ${name}`, node.pos)
      }
      validateArity(name, node.args, node.pos)
      for (const arg of node.args) {
        validateNode(arg, insideAggregate, depth + 1, state)
      }
      return
    }
  }
}

interface FormulaType {
  kind: 'number' | 'string' | 'boolean' | 'null' | 'any'
  nullable: boolean
  pos: number
}

function typeName(type: FormulaType): string {
  if (type.kind === 'null') return 'null'
  if (type.kind === 'any') return '混合类型'
  return type.kind === 'number' ? '数值' : type.kind === 'string' ? '字符串' : '布尔'
}

function requireNumeric(type: FormulaType, node: Expr, context: string): FormulaType {
  if (type.kind === 'any' || (type.kind !== 'number' && type.kind !== 'null')) {
    throw new FormulaError(`${context} 需要数值参数，收到${typeName(type)}`, node.pos)
  }
  return { kind: 'number', nullable: true, pos: node.pos }
}

function mergeBranchTypes(left: FormulaType, right: FormulaType, pos: number): FormulaType {
  if (left.kind === 'null') return { ...right, pos, nullable: true }
  if (right.kind === 'null') return { ...left, pos, nullable: true }
  if (left.kind === right.kind) {
    return { ...left, pos, nullable: left.nullable || right.nullable }
  }
  return { kind: 'any', nullable: true, pos }
}

function compatible(left: FormulaType, right: FormulaType): boolean {
  if (left.kind === 'any' || right.kind === 'any') return true
  if (left.kind === 'null' || right.kind === 'null') return true
  return left.kind === right.kind
}

/**
 * 静态类型推导。只拒绝能确定错误的组合；可空数值仍属于数值类型，
 * 运行时仍可能因除零、定义域等返回 null。
 */
function inferType(node: Expr, insideAggregate: boolean): FormulaType {
  switch (node.type) {
    case 'number':
      return { kind: 'number', nullable: false, pos: node.pos }
    case 'string':
      return { kind: 'string', nullable: false, pos: node.pos }
    case 'boolean':
      return { kind: 'boolean', nullable: false, pos: node.pos }
    case 'null':
      return { kind: 'null', nullable: true, pos: node.pos }
    case 'field': {
      if (!insideAggregate) {
        throw new FormulaError(`字段 ${node.name} 只能出现在聚合函数参数里`, node.pos)
      }
      const field = lookupRankField(node.name)
      if (!field) throw new FormulaError(`未知字段 ${node.name}`, node.pos)
      return {
        kind: field.type,
        nullable: field.nullable,
        pos: node.pos,
      }
    }
    case 'unary': {
      if (node.op === '!') {
        inferType(node.arg, insideAggregate)
        return { kind: 'boolean', nullable: true, pos: node.pos }
      }
      const arg = inferType(node.arg, insideAggregate)
      requireNumeric(arg, node.arg, node.op === '-' ? '负号' : '正号')
      return { kind: 'number', nullable: true, pos: node.pos }
    }
    case 'binary': {
      const left = inferType(node.left, insideAggregate)
      const right = inferType(node.right, insideAggregate)
      if (node.op === '&&' || node.op === '||') {
        return { kind: 'boolean', nullable: true, pos: node.pos }
      }
      if (node.op === '+' || node.op === '-' || node.op === '*' || node.op === '/' || node.op === '%' || node.op === '^') {
        requireNumeric(left, node.left, `运算符 ${node.op}`)
        requireNumeric(right, node.right, `运算符 ${node.op}`)
        return { kind: 'number', nullable: true, pos: node.pos }
      }
      if (!compatible(left, right)) {
        throw new FormulaError(
          `运算符 ${node.op} 两侧类型不一致：${typeName(left)} / ${typeName(right)}`,
          node.pos,
        )
      }
      if (
        (node.op === '<' || node.op === '<=' || node.op === '>' || node.op === '>=') &&
        left.kind !== 'number' &&
        left.kind !== 'string' &&
        left.kind !== 'null' &&
        left.kind !== 'any'
      ) {
        throw new FormulaError(`运算符 ${node.op} 只支持数值或字符串比较`, node.pos)
      }
      return {
        kind: 'boolean',
        nullable: left.kind === 'null' || right.kind === 'null' || left.nullable || right.nullable,
        pos: node.pos,
      }
    }
    case 'call': {
      if (isAggregateName(node.name)) {
        if (node.name === 'count') return { kind: 'number', nullable: false, pos: node.pos }
        const inner = inferType(node.args[0]!, true)
        if (node.name === 'countValid') {
          return { kind: 'number', nullable: false, pos: node.pos }
        }
        requireNumeric(inner, node.args[0]!, `聚合函数 ${node.name}`)
        return { kind: 'number', nullable: true, pos: node.pos }
      }
      if (node.name === 'if') {
        inferType(node.args[0]!, insideAggregate)
        const left = inferType(node.args[1]!, insideAggregate)
        const right = inferType(node.args[2]!, insideAggregate)
        return mergeBranchTypes(left, right, node.pos)
      }
      if (node.name === 'isNull') {
        inferType(node.args[0]!, insideAggregate)
        return { kind: 'boolean', nullable: false, pos: node.pos }
      }
      const argTypes = node.args.map((arg) => inferType(arg, insideAggregate))
      if (node.name === 'round') {
        requireNumeric(argTypes[0]!, node.args[0]!, 'round 数值')
        if (argTypes[1]) requireNumeric(argTypes[1], node.args[1]!, 'round 精度')
        return { kind: 'number', nullable: true, pos: node.pos }
      }
      for (let index = 0; index < argTypes.length; index += 1) {
        requireNumeric(argTypes[index]!, node.args[index]!, `函数 ${node.name}`)
      }
      return { kind: 'number', nullable: true, pos: node.pos }
    }
  }
}

/** 解析并做静态结构与类型校验；错误定位到公式字符位置。 */
export function compileFormula(source: string): CompiledFormula {
  if (source.length > MAX_FORMULA_LENGTH) {
    throw new FormulaError(`公式不能超过 ${MAX_FORMULA_LENGTH} 个字符`, MAX_FORMULA_LENGTH)
  }
  if (!source.trim()) throw new FormulaError('公式不能为空', 0)
  const ast = parseFormula(source)
  const state = {
    nodes: 0,
    fields: new Set<string>(),
    aggregates: [] as AggregateCall[],
  }
  validateNode(ast, false, 0, state)
  const result = inferType(ast, false)
  if (result.kind !== 'number' && result.kind !== 'null') {
    throw new FormulaError(
      `指标最终结果必须是数值或 null，当前是${typeName(result)}`,
      result.pos,
    )
  }
  return { source, ast, fields: state.fields, aggregates: state.aggregates }
}
