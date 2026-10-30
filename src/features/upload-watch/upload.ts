import type { FatalKind, UploadOutcome } from './types'

function fatal(kind: FatalKind, reason: string): UploadOutcome {
  return { kind: 'fatal', fatal: kind, reason }
}

function retry(reason: string, retryAfterMs: number): UploadOutcome {
  return { kind: 'retry', reason, retryAfterMs }
}

function parseRetryAfter(value: string): number {
  if (!value) return 0
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000)
  const date = Date.parse(value)
  if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  return 0
}

interface UploadPayload {
  type?: string
  object?: string
  obj?: string
  category?: string
  data?: { id?: number; state?: string }
}

/**
 * 把站点响应归一化成统一结果。
 *
 * 三个容易漏判的点：`collision` 是 200 里的 error 而不是 409；未实名用的键是
 * `obj` 而不是 `object`；`identifier` 只看 object 分不出是违规词还是别的。
 */
export function normalizeUploadResult(
  status: number,
  bodyText: string,
  retryAfter = '',
): UploadOutcome {
  const retryMs = parseRetryAfter(retryAfter)

  if (status === 401 || status === 403) return fatal('auth', '登录已失效，请在站点重新登录')
  if (status === 402) return fatal('quota', '录像额度已满，请联系站点管理员')
  if (status === 413) return { kind: 'failed', reason: '文件过大（413）' }
  if (status === 429) return retry('请求过快（429）', retryMs || 5000)
  if (status === 503) return retry('站点正在刷新榜单（503）', retryMs || 1000)
  if (status >= 500) return retry(`服务器错误（${status}）`, retryMs || 2000)

  let payload: UploadPayload
  try {
    payload = JSON.parse(bodyText) as UploadPayload
  } catch {
    return { kind: 'failed', reason: `HTTP ${status}，响应无法解析` }
  }

  if (payload.type === 'success') {
    const data = payload.data ?? {}
    return {
      kind: 'done',
      id: Number(data.id) || 0,
      state: String(data.state ?? ''),
    }
  }

  if (status >= 400) return { kind: 'failed', reason: `HTTP ${status}` }

  const object = payload.object ?? payload.obj ?? ''
  const category = payload.category ?? ''

  if (object === 'file' && category === 'collision') return { kind: 'duplicate' }
  if (object === 'file' && category === 'incomplete') {
    return { kind: 'skipped', reason: '未完成局' }
  }
  if (object === 'userprofile' && category === 'realname_required') {
    return fatal('realname', '账号未实名，请先在站点完成实名')
  }
  if (category === 'banned') return fatal('banned', '账号被封禁')
  if (object === 'identifier') {
    return fatal('censorship', '录像标识未通过审查，请修改标识')
  }

  const label = [object, category].filter(Boolean).join('/') || '未知错误'
  return { kind: 'failed', reason: label }
}
