import type { GlobalRankDetail, GlobalRankFieldValue } from './model'

export type RankFieldGroup = '成绩' | '点击' | '局面' | '时间' | '身份' | '来源'

export interface RankField {
  key: string
  label: string
  group: RankFieldGroup
  type: 'number' | 'boolean' | 'string'
  unit: string
  nullable: boolean
  source: 'detailbulk' | '派生'
  description: string
}

function field(
  key: string,
  label: string,
  group: RankFieldGroup,
  type: RankField['type'],
  unit: string,
  nullable: boolean,
  source: RankField['source'],
  description: string,
): RankField {
  return { key, label, group, type, unit, nullable, source, description }
}

export const RANK_FIELDS: readonly RankField[] = [
  field('id', '录像 ID', '身份', 'number', '', false, 'detailbulk', '站点录像 ID'),
  field('player', '玩家 ID', '身份', 'number', '', false, 'detailbulk', '站点玩家 ID'),
  field('software', '软件', '身份', 'string', '', false, 'detailbulk', '录像软件代码'),
  field('level', '难度', '身份', 'string', '', false, 'detailbulk', 'b / i / e 或自定义难度'),
  field('mode', '模式', '身份', 'string', '', false, 'detailbulk', '标准模式为 00'),
  field('state', '审核状态', '身份', 'string', '', false, 'detailbulk', 'c 为已审核'),
  field('timems', '用时（毫秒）', '成绩', 'number', 'ms', false, 'detailbulk', '原始毫秒用时'),
  field('time', '用时', '成绩', 'number', 's', false, '派生', 'timems / 1000'),
  field('bv', '3BV', '成绩', 'number', '', true, 'detailbulk', '局面 3BV'),
  field('bvs', '3BVS', '成绩', 'number', '3BV/s', true, '派生', 'bv / time'),
  field('cl', '总点击', '点击', 'number', '', true, 'detailbulk', '接口总点击；缺失时由 left + right + double 派生（兼容别名 clicks）'),
  field('left', '左键', '点击', 'number', '', true, 'detailbulk', '左键原始点击'),
  field('right', '右键', '点击', 'number', '', true, 'detailbulk', '右键原始点击'),
  field('double', '双击', '点击', 'number', '', true, 'detailbulk', '双击原始点击'),
  field('ce', '有效点击', '点击', 'number', '', true, 'detailbulk', '接口有效点击；缺失时由 left_ce + right_ce + double_ce 派生（兼容别名 effectiveClicks）'),
  field('left_ce', '左键有效', '点击', 'number', '', true, 'detailbulk', '左键有效点击'),
  field('right_ce', '右键有效', '点击', 'number', '', true, 'detailbulk', '右键有效点击'),
  field('double_ce', '双击有效', '点击', 'number', '', true, 'detailbulk', '双击有效点击'),
  field('ioe', 'IOE', '点击', 'number', '', true, '派生', 'bv / cl；cl 缺失时由 left + right + double 派生'),
  field('nf', 'NF', '点击', 'boolean', '', true, '派生', 'right_ce === 0'),
  field('path', '路径原值', '局面', 'number', '', true, 'detailbulk', '接口原始路径'),
  field('pathCells', '路径格数', '局面', 'number', '格', true, '派生', 'path / 16'),
  field('flag', '旗子', '局面', 'number', '', true, 'detailbulk', '插旗数'),
  field('op', '开空', '局面', 'number', '', true, 'detailbulk', '开空数'),
  field('isl', '岛屿', '局面', 'number', '', true, 'detailbulk', '岛屿数'),
  field('file_size', '文件大小', '来源', 'number', 'B', true, 'detailbulk', '录像文件字节数'),
  field('upload_time', '上传时间', '时间', 'string', '', true, 'detailbulk', '原始上传时间'),
  field('end_time', '结束时间', '时间', 'string', '', true, 'detailbulk', '原始录像结束时间'),
  field('identifier', '标识', '来源', 'string', '', true, 'detailbulk', '录像内标识文本'),
  field('cell0', 'cell0', '局面', 'number', '', true, 'detailbulk', '局面分段 0'),
  field('cell1', 'cell1', '局面', 'number', '', true, 'detailbulk', '局面分段 1'),
  field('cell2', 'cell2', '局面', 'number', '', true, 'detailbulk', '局面分段 2'),
  field('cell3', 'cell3', '局面', 'number', '', true, 'detailbulk', '局面分段 3'),
  field('cell4', 'cell4', '局面', 'number', '', true, 'detailbulk', '局面分段 4'),
  field('cell5', 'cell5', '局面', 'number', '', true, 'detailbulk', '局面分段 5'),
  field('cell6', 'cell6', '局面', 'number', '', true, 'detailbulk', '局面分段 6'),
  field('cell7', 'cell7', '局面', 'number', '', true, 'detailbulk', '局面分段 7'),
  field('cell8', 'cell8', '局面', 'number', '', true, 'detailbulk', '局面分段 8'),
]

export const RANK_FIELD_MAP = new Map(RANK_FIELDS.map((item) => [item.key, item]))
export const RANK_FIELD_ALIASES: Readonly<Record<string, string>> = {
  clicks: 'cl',
  effectiveClicks: 'ce',
}

/** 公式可识别字段包含兼容别名，字段帮助只展示标准名。 */
export function lookupRankField(name: string): RankField | undefined {
  return RANK_FIELD_MAP.get(RANK_FIELD_ALIASES[name] ?? name)
}
export const RANK_FIELD_GROUPS: ReadonlyArray<RankFieldGroup> = [
  '成绩',
  '点击',
  '局面',
  '时间',
  '身份',
  '来源',
]

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function sum(...values: Array<number | null>): number | null {
  if (values.some((value) => value === null)) return null
  return (values as number[]).reduce((total, value) => total + value, 0)
}

/** 把 detailbulk / staticdetailbatch 的原始响应规范化为公式字段。 */
export function normalizeDetail(raw: Record<string, unknown>): GlobalRankDetail {
  const timems = asNumber(raw.timems)
  const time = timems !== null && timems > 0 ? timems / 1000 : null
  const bv = asNumber(raw.bv)
  const left = asNumber(raw.left)
  const right = asNumber(raw.right)
  const double = asNumber(raw.double)
  const leftCe = asNumber(raw.left_ce)
  const rightCe = asNumber(raw.right_ce)
  const doubleCe = asNumber(raw.double_ce)
  const clickSum = sum(left, right, double)
  const effectiveSum = sum(leftCe, rightCe, doubleCe)
  const cl = asNumber(raw.cl) ?? clickSum
  const ce = asNumber(raw.ce) ?? effectiveSum
  const clicks = cl
  const effectiveClicks = ce
  const path = asNumber(raw.path)

  const fields: Record<string, GlobalRankFieldValue> = {
    id: asNumber(raw.id),
    player: asNumber(raw.player),
    software: asText(raw.software),
    level: asText(raw.level),
    mode: asText(raw.mode),
    state: asText(raw.state),
    timems,
    time,
    bv,
    bvs: bv !== null && time !== null ? bv / time : null,
    clicks,
    cl,
    left,
    right,
    double,
    effectiveClicks,
    ce,
    left_ce: leftCe,
    right_ce: rightCe,
    double_ce: doubleCe,
    ioe: bv !== null && cl !== null && cl > 0 ? bv / cl : null,
    nf: rightCe === null ? null : rightCe === 0,
    path,
    pathCells: path === null ? null : path / 16,
    flag: asNumber(raw.flag),
    op: asNumber(raw.op),
    isl: asNumber(raw.isl),
    file_size: asNumber(raw.file_size),
    upload_time: asText(raw.upload_time),
    end_time: asText(raw.end_time),
    identifier: asText(raw.video__identifier) ?? asText(raw.identifier),
  }
  for (let index = 0; index < 9; index += 1) {
    fields[`cell${index}`] = asNumber(raw[`cell${index}`])
  }

  return { raw, fields }
}

/**
 * 计算前统一规范化旧快照字段：标准字段和别名得到同一优先结果。
 * 旧配置或旧快照可能只有 clicks / effectiveClicks，不能只修下一次采集。
 */
export function normalizeStoredFields(
  fields: Record<string, GlobalRankFieldValue>,
): Record<string, GlobalRankFieldValue> {
  const value = (key: string): number | null => {
    const item = fields[key]
    return typeof item === 'number' && Number.isFinite(item) ? item : null
  }
  const cl =
    value('cl') ??
    value('clicks') ??
    sum(value('left'), value('right'), value('double'))
  const ce =
    value('ce') ??
    value('effectiveClicks') ??
    sum(value('left_ce'), value('right_ce'), value('double_ce'))
  const bv = value('bv')
  return {
    ...fields,
    cl,
    clicks: cl,
    ce,
    effectiveClicks: ce,
    ioe: bv !== null && cl !== null && cl > 0 ? bv / cl : null,
  }
}

/**
 * abstractbulk 只提供可变元信息；复用基础快照的解析字段时必须覆盖这些字段，
 * 不能把旧 player / state / upload_time 当成最新值。
 */
export function withDetailMetadata(
  detail: GlobalRankDetail,
  meta: { player: number; state: string; uploadTime: string },
): GlobalRankDetail {
  const raw = {
    ...detail.raw,
    player: meta.player,
    state: meta.state,
    upload_time: meta.uploadTime,
  }
  const fields = {
    ...detail.fields,
    player: meta.player,
    state: meta.state,
    upload_time: meta.uploadTime || null,
  }
  return { raw, fields }
}

