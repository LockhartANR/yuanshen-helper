import type { GlobalRankFieldValue } from '../model'
import type { Expr, RuntimeValue } from './ast'
import type { AggregateCall, CompiledFormula } from './validate'

export interface ScalarContext {
  fields: Record<string, GlobalRankFieldValue>
}

export interface OuterValue {
  value: RuntimeValue
  samples: number
}

interface AggregateState {
  call: AggregateCall
  count: number
  valid: number
  sum: number
  min: number
  max: number
}

function asFinite(value: RuntimeValue): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function truthy(value: RuntimeValue): boolean {
  if (value === null) return false
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0 && Number.isFinite(value)
  return value !== ''
}

function equal(left: RuntimeValue, right: RuntimeValue): boolean {
  if (left === null || right === null) return false
  return left === right
}

function numericBinary(
  op: string,
  left: number,
  right: number,
): number | null {
  let value: number
  if (op === '+') value = left + right
  else if (op === '-') value = left - right
  else if (op === '*') value = left * right
  else if (op === '/') {
    if (right === 0) return null
    value = left / right
  } else if (op === '%') {
    if (right === 0) return null
    value = left % right
  } else if (op === '^') {
    value = left ** right
  } else {
    return null
  }
  return Number.isFinite(value) ? value : null
}

function compare(op: string, left: RuntimeValue, right: RuntimeValue): RuntimeValue {
  if (left === null || right === null) return null
  if (op === '==') return equal(left, right)
  if (op === '!=') return !equal(left, right)
  if (typeof left === 'number' && typeof right === 'number') {
    if (op === '<') return left < right
    if (op === '<=') return left <= right
    if (op === '>') return left > right
    return left >= right
  }
  if (typeof left === 'string' && typeof right === 'string') {
    if (op === '<') return left < right
    if (op === '<=') return left <= right
    if (op === '>') return left > right
    return left >= right
  }
  return null
}

function applyBinary(
  op: Extract<Expr, { type: 'binary' }>['op'],
  left: RuntimeValue,
  right: RuntimeValue,
): RuntimeValue {
  if (op === '&&') return truthy(left) && truthy(right)
  if (op === '||') return truthy(left) || truthy(right)
  if (op === '==' || op === '!=' || op === '<' || op === '<=' || op === '>' || op === '>=') {
    return compare(op, left, right)
  }
  const a = asFinite(left)
  const b = asFinite(right)
  if (a === null || b === null) return null
  return numericBinary(op, a, b)
}

function applyUnary(op: '+' | '-' | '!', value: RuntimeValue): RuntimeValue {
  if (op === '!') return !truthy(value)
  const number = asFinite(value)
  if (number === null) return null
  return op === '-' ? -number : number
}

function evalScalarCall(name: string, args: Expr[], ctx: ScalarContext): RuntimeValue {
  if (name === 'if') {
    const condition = evaluateScalar(args[0]!, ctx)
    return evaluateScalar(truthy(condition) ? args[1]! : args[2]!, ctx)
  }
  if (name === 'isNull') return evaluateScalar(args[0]!, ctx) === null
  const values = args.map((arg) => evaluateScalar(arg, ctx))
  if (name === 'round') {
    const number = asFinite(values[0] ?? null)
    if (number === null) return null
    const digits = values.length > 1 ? asFinite(values[1] ?? null) : 0
    if (digits === null || !Number.isInteger(digits) || digits < 0 || digits > 6) return null
    const factor = 10 ** digits
    const rounded = Math.round((number + Number.EPSILON) * factor) / factor
    return Number.isFinite(rounded) ? rounded : null
  }
  const value = asFinite(values[0] ?? null)
  if (value === null) return null
  let result: number
  if (name === 'abs') result = Math.abs(value)
  else if (name === 'sqrt') result = Math.sqrt(value)
  else if (name === 'log') result = Math.log(value)
  else if (name === 'exp') result = Math.exp(value)
  else if (name === 'floor') result = Math.floor(value)
  else if (name === 'ceil') result = Math.ceil(value)
  else if (name === 'pow') {
    const exponent = asFinite(values[1] ?? null)
    if (exponent === null) return null
    result = value ** exponent
  } else {
    return null
  }
  return Number.isFinite(result) ? result : null
}

/** 逐局表达式求值：字段、算术、条件与数学函数。 */
export function evaluateScalar(node: Expr, ctx: ScalarContext): RuntimeValue {
  switch (node.type) {
    case 'number':
    case 'string':
    case 'boolean':
      return node.value
    case 'null':
      return null
    case 'field':
      return ctx.fields[node.name] ?? null
    case 'unary':
      return applyUnary(node.op, evaluateScalar(node.arg, ctx))
    case 'binary': {
      const left = evaluateScalar(node.left, ctx)
      if (node.op === '&&' && !truthy(left)) return false
      if (node.op === '||' && truthy(left)) return true
      return applyBinary(node.op, left, evaluateScalar(node.right, ctx))
    }
    case 'call':
      return evalScalarCall(node.name, node.args, ctx)
  }
}

function aggregateResult(state: AggregateState): OuterValue {
  const { call } = state
  if (call.name === 'count') return { value: state.count, samples: state.count }
  if (call.name === 'countValid') return { value: state.valid, samples: state.count }
  if (state.valid === 0) return { value: null, samples: 0 }
  if (call.name === 'sum') return { value: state.sum, samples: state.valid }
  if (call.name === 'avg') {
    const value = state.sum / state.valid
    return { value: Number.isFinite(value) ? value : null, samples: state.valid }
  }
  if (call.name === 'min') return { value: state.min, samples: state.valid }
  if (call.name === 'max') return { value: state.max, samples: state.valid }
  return { value: null, samples: 0 }
}

function combineSamples(left: OuterValue, right: OuterValue): number {
  return Math.min(left.samples, right.samples)
}

function evalOuterCall(
  name: string,
  args: Expr[],
  states: Map<AggregateCall, AggregateState>,
  gameCount: number,
): OuterValue {
  if (name === 'if') {
    const condition = evaluateOuter(args[0]!, states, gameCount)
    return evaluateOuter(truthy(condition.value) ? args[1]! : args[2]!, states, gameCount)
  }
  if (name === 'isNull') {
    const value = evaluateOuter(args[0]!, states, gameCount)
    return { value: value.value === null, samples: value.samples }
  }
  if (name === 'round') {
    const number = evaluateOuter(args[0]!, states, gameCount)
    const digitsValue =
      args.length > 1 ? evaluateOuter(args[1]!, states, gameCount) : { value: 0, samples: gameCount }
    const numeric = asFinite(number.value)
    const digits = asFinite(digitsValue.value)
    if (numeric === null || digits === null || !Number.isInteger(digits) || digits < 0 || digits > 6) {
      return { value: null, samples: number.samples }
    }
    const factor = 10 ** digits
    const rounded = Math.round((numeric + Number.EPSILON) * factor) / factor
    return {
      value: Number.isFinite(rounded) ? rounded : null,
      samples: combineSamples(number, digitsValue),
    }
  }

  const values = args.map((arg) => evaluateOuter(arg, states, gameCount))
  const value = asFinite(values[0]?.value ?? null)
  if (value === null) return { value: null, samples: values[0]?.samples ?? gameCount }
  let result: number
  if (name === 'abs') result = Math.abs(value)
  else if (name === 'sqrt') result = Math.sqrt(value)
  else if (name === 'log') result = Math.log(value)
  else if (name === 'exp') result = Math.exp(value)
  else if (name === 'floor') result = Math.floor(value)
  else if (name === 'ceil') result = Math.ceil(value)
  else if (name === 'pow') {
    const exponent = asFinite(values[1]?.value ?? null)
    if (exponent === null) return { value: null, samples: values[0]?.samples ?? gameCount }
    result = value ** exponent
  } else {
    return { value: null, samples: values[0]?.samples ?? gameCount }
  }
  const samples = values.length === 1 ? values[0]!.samples : Math.min(...values.map((item) => item.samples))
  return { value: Number.isFinite(result) ? result : null, samples }
}

/** 聚合后的外层表达式求值；聚合状态来自逐局累计。 */
export function evaluateOuter(
  node: Expr,
  states: Map<AggregateCall, AggregateState>,
  gameCount: number,
): OuterValue {
  switch (node.type) {
    case 'number':
    case 'string':
    case 'boolean':
      return { value: node.value, samples: gameCount }
    case 'null':
      return { value: null, samples: gameCount }
    case 'field':
      return { value: null, samples: gameCount }
    case 'unary': {
      const arg = evaluateOuter(node.arg, states, gameCount)
      return { value: applyUnary(node.op, arg.value), samples: arg.samples }
    }
    case 'binary': {
      const left = evaluateOuter(node.left, states, gameCount)
      if (node.op === '&&' && !truthy(left.value)) return { value: false, samples: left.samples }
      if (node.op === '||' && truthy(left.value)) return { value: true, samples: left.samples }
      const right = evaluateOuter(node.right, states, gameCount)
      return {
        value: applyBinary(node.op, left.value, right.value),
        samples: combineSamples(left, right),
      }
    }
    case 'call': {
      for (const [call, state] of states) {
        if (call.node === node) return aggregateResult(state)
      }
      return evalOuterCall(node.name, node.args, states, gameCount)
    }
  }
}

interface MetricState {
  formula: CompiledFormula
  aggregates: Array<{ call: AggregateCall; state: AggregateState }>
}

function expressionKey(node: Expr): string {
  switch (node.type) {
    case 'number':
      return `n:${node.value}`
    case 'string':
      return `s:${JSON.stringify(node.value)}`
    case 'boolean':
      return `b:${node.value ? 1 : 0}`
    case 'null':
      return 'null'
    case 'field':
      return `f:${node.name}`
    case 'unary':
      return `u:${node.op}:${expressionKey(node.arg)}`
    case 'binary':
      return `x:${node.op}:${expressionKey(node.left)}:${expressionKey(node.right)}`
    case 'call':
      return `c:${node.name}:${node.args.map(expressionKey).join(',')}`
  }
}

function aggregateKey(call: AggregateCall): string {
  return `${call.name}:${call.inner ? expressionKey(call.inner) : ''}`
}

function createAggregateState(call: AggregateCall): AggregateState {
  return {
    call,
    count: 0,
    valid: 0,
    sum: 0,
    min: Number.POSITIVE_INFINITY,
    max: Number.NEGATIVE_INFINITY,
  }
}

export interface PlayerMetricResult {
  values: Array<number | null>
  samples: number[]
}

export interface PlayerAccumulator {
  readonly gameCount: number
  addGame(fields: Record<string, GlobalRankFieldValue>): void
  finish(): PlayerMetricResult
}

/** 每位玩家一套聚合器；逐局喂入，不保存该玩家的完整录像数组。 */
export function createPlayerAccumulator(formulas: CompiledFormula[]): PlayerAccumulator {
  const sharedStates = new Map<string, AggregateState>()
  const metrics: MetricState[] = formulas.map((formula) => ({
    formula,
    aggregates: formula.aggregates.map((call) => {
      const key = aggregateKey(call)
      let state = sharedStates.get(key)
      if (!state) {
        state = createAggregateState(call)
        sharedStates.set(key, state)
      }
      return { call, state }
    }),
  }))
  // 相同内部表达式的多个指标只累计一次，后续计算共享结果。
  const uniqueStates = [...new Set(metrics.flatMap((metric) => metric.aggregates.map((item) => item.state)))]
  let gameCount = 0

  return {
    get gameCount() {
      return gameCount
    },
    addGame(fields) {
      gameCount += 1
      for (const state of uniqueStates) {
        if (state.call.name === 'count') {
          state.count += 1
          continue
        }
        state.count += 1
        if (!state.call.inner) continue
        const value = evaluateScalar(state.call.inner, { fields })
        if (value === null) continue
        if (state.call.name === 'countValid') {
          state.valid += 1
          continue
        }
        const number = asFinite(value)
        if (number === null) continue
        state.valid += 1
        state.sum += number
        if (number < state.min) state.min = number
        if (number > state.max) state.max = number
      }
    },
    finish() {
      const values: Array<number | null> = []
      const samples: number[] = []
      for (const metric of metrics) {
        const states = new Map(metric.aggregates.map((item) => [item.call, item.state]))
        const result = evaluateOuter(metric.formula.ast, states, gameCount)
        values.push(typeof result.value === 'number' && Number.isFinite(result.value) ? result.value : null)
        samples.push(result.samples)
      }
      return { values, samples }
    },
  }
}

/** 便捷入口：测试和小批量内存数据使用；生产计算走流式聚合器。 */
export function evaluateForGames(
  formula: CompiledFormula,
  games: Array<Record<string, GlobalRankFieldValue>>,
): PlayerMetricResult {
  const accumulator = createPlayerAccumulator([formula])
  for (const game of games) accumulator.addGame(game)
  return accumulator.finish()
}
