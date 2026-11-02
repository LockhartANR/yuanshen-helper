import { MAX_BV } from './model'
import type { Level, Video } from './model'

/** Arbiter / similar stats exporter header. Both supported CSV files use it. */
const CSV_HEADER = [
  'Day',
  'Month',
  'Year',
  'Hour',
  'Min',
  'Sec',
  'mode',
  'Time',
  'BBBV',
  'BBBVs',
  'style',
  'cell0',
  'cell1',
  'cell2',
  'cell3',
  'cell4',
  'cell5',
  'cell6',
  'cell7',
  'cell8',
  'Lcl',
  'Rcl',
  'Dcl',
  'Leff',
  'Reff',
  'Deff',
  'Openings',
  'Islands',
  'Path',
  'GZiNi',
  'HZiNi',
] as const

const LEVEL_MAP: Record<string, Level> = {
  BEG: 'b',
  INT: 'i',
  EXP: 'e',
}

export interface CsvError {
  line: number
  message: string
}

export interface CsvParseResult {
  videos: Video[]
  errors: CsvError[]
  total: number
}

function parseRows(text: string): Array<{ fields: string[]; line: number }> {
  const rows: Array<{ fields: string[]; line: number }> = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let closed = false
  let index = 0
  let line = 1
  let rowLine = 1

  const pushField = (): void => {
    row.push(field)
    field = ''
    closed = false
  }
  const pushRow = (): void => {
    pushField()
    if (row.some((value) => value.trim() !== '')) rows.push({ fields: row, line: rowLine })
    row = []
  }

  while (index < text.length) {
    const char = text[index]!
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 2
          continue
        }
        quoted = false
        closed = true
      } else {
        field += char
        if (char === '\n' || (char === '\r' && text[index + 1] !== '\n')) line += 1
      }
      index += 1
      continue
    }
    if (char === '"') {
      if (field !== '' || closed) throw new Error(`CSV 第 ${line} 行：字段内的引号无效`)
      quoted = true
      index += 1
      continue
    }
    if (char === ',') {
      pushField()
      index += 1
      continue
    }
    if (char === '\r' || char === '\n') {
      pushRow()
      if (char === '\r' && text[index + 1] === '\n') index += 1
      line += 1
      rowLine = line
      index += 1
      continue
    }
    if (closed) throw new Error(`CSV 第 ${line} 行：闭引号后存在非法字符`)
    field += char
    index += 1
  }
  if (quoted) throw new Error(`CSV 第 ${rowLine} 行：引号未闭合`)
  pushRow()
  return rows
}

function number(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function int(value: string | undefined): number | null {
  const parsed = number(value)
  return parsed !== null && Number.isSafeInteger(parsed) ? parsed : null
}

function localDate(row: string[]): Date | null {
  const [day, month, year, hour, minute, second] = [0, 1, 2, 3, 4, 5].map((index) =>
    int(row[index]),
  )
  if (
    day === null ||
    month === null ||
    year === null ||
    hour === null ||
    minute === null ||
    second === null
  ) {
    return null
  }
  const date = new Date(year, month - 1, day, hour, minute, second)
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute
  ) {
    return null
  }
  return date
}

/** Parse one supported stats CSV. Duplicate rows are intentionally preserved. */
export function parseStatsCsv(text: string, idBase = 0): CsvParseResult {
  const rows = parseRows(text.replace(/^\uFEFF/, ''))
  const header = (rows[0]?.fields ?? []).map((value) => value.trim())
  if (header.length !== CSV_HEADER.length || header.some((value, i) => value !== CSV_HEADER[i])) {
    throw new Error('CSV 表头不匹配：需要 Arbiter / Anthropic stats CSV 的 31 列格式')
  }

  const videos: Video[] = []
  const errors: CsvError[] = []
  for (let index = 1; index < rows.length; index += 1) {
    const { fields: row, line } = rows[index]!
    if (row.length !== CSV_HEADER.length) {
      errors.push({ line, message: `列数应为 ${CSV_HEADER.length}，实际 ${row.length}` })
      continue
    }
    const level = LEVEL_MAP[(row[6] ?? '').trim().toUpperCase()]
    const time = number(row[7])
    const bv = int(row[8])
    const date = localDate(row)
    if (!level) {
      errors.push({ line, message: `未知 mode：${row[6] ?? ''}` })
      continue
    }
    const timems = time === null ? 0 : Math.round(time * 1000)
    if (time === null || time <= 0 || !Number.isSafeInteger(timems) || timems <= 0) {
      errors.push({ line, message: 'Time 不是有效的正毫秒用时' })
      continue
    }
    if (bv === null || bv < 1 || bv > MAX_BV[level]) {
      errors.push({ line, message: `BBBV 必须为 1–${MAX_BV[level]} 的安全整数` })
      continue
    }
    if (!date) {
      errors.push({ line, message: '日期时间无效' })
      continue
    }

    const style = (row[10] ?? '').trim().toUpperCase()
    if (style !== 'NF' && style !== 'FLAG') {
      errors.push({ line, message: `未知 style：${row[10] ?? ''}` })
      continue
    }
    videos.push({
      id: -(idBase + videos.length + 1),
      importOrder: idBase + videos.length,
      csvNf: style === 'NF',
      upload_time: date.toISOString(),
      state: 'c',
      ongoing_tournament: false,
      software: 'csv',
      level,
      mode: '00',
      end_time: date.toISOString(),
      timems,
      bv,
      left: int(row[20]),
      right: int(row[21]),
      double: int(row[22]),
      left_ce: int(row[23]),
      right_ce: int(row[24]),
      double_ce: int(row[25]),
      path: number(row[28]),
      op: int(row[26]),
      isl: int(row[27]),
    })
  }

  return { videos, errors, total: Math.max(0, rows.length - 1) }
}
