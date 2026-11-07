import { AUTHOR_HOME_URL, DEVELOPER_LINKS, REPO_URL, SITE_ORIGIN } from './constants'
import { el, externalLink } from './ui'

function aboutRow(label: string, content: HTMLElement): HTMLElement {
  const row = el('div', 'about-row')
  row.append(el('span', 'about-label', label), content)
  return row
}

/**
 * 设置、自动上传与玩家页面共用的「关于」卡片。
 * 只创建 DOM，不读写存储或发请求；版本号始终取当前扩展 manifest。
 */
export function createAboutCard(): HTMLElement {
  const card = el('section', 'about-card')
  card.append(
    el('h2', undefined, '关于'),
    el(
      'p',
      'about-desc',
      `元神助手 v${chrome.runtime.getManifest().version} · 开源扫雷网辅助工具`,
    ),
  )

  const developerLinks = el('div', 'about-links')
  for (const item of DEVELOPER_LINKS) {
    developerLinks.append(externalLink(`${item.label} ↗`, item.url))
  }

  card.append(
    aboutRow('仓库', externalLink('github.com/LockhartANR/yuanshen-helper ↗', REPO_URL)),
    aboutRow('开发者', developerLinks),
    aboutRow('站点', externalLink('openms.top ↗', SITE_ORIGIN)),
    aboutRow('大表原作者', externalLink('原作者主页 ↗', AUTHOR_HOME_URL)),
  )
  return card
}
