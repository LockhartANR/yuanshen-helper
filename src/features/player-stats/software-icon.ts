import { softwareLabel } from './model'

/** 四个软件对应的图标，放在 public/icons/software/ 下。 */
const ICON_PATHS: Record<string, string> = {
  a: 'icons/software/a.png',
  e: 'icons/software/e.png',
  m: 'icons/software/m.png',
  r: 'icons/software/r.png',
}

export function softwareIconPath(code: string): string | null {
  return ICON_PATHS[code] ?? null
}

/** 成绩前面的小图标；未知软件返回 null，由调用方决定要不要留空。 */
export function softwareIcon(code: string): HTMLImageElement | null {
  const path = softwareIconPath(code)
  if (!path) return null
  const img = document.createElement('img')
  img.className = 'software-icon'
  img.src = chrome.runtime.getURL(path)
  img.alt = softwareLabel(code)
  img.title = softwareLabel(code)
  img.width = 14
  img.height = 14
  img.decoding = 'async'
  return img
}
