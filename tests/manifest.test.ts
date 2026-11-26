import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

interface Manifest {
  permissions: string[]
  host_permissions: string[]
  content_security_policy?: { extension_pages: string }
  content_scripts: Array<{ matches: string[]; js: string[]; run_at: string }>
  web_accessible_resources?: Array<{ resources: string[]; matches: string[] }>
}

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../public/manifest.json', import.meta.url)), 'utf8'),
) as Manifest

describe('manifest 资源范围', () => {
  it('小游戏解压只允许扩展内置 WASM，不增加权限或远程脚本来源', () => {
    expect(manifest.permissions).toEqual(['storage', 'alarms', 'offscreen'])
    expect(manifest.host_permissions).toEqual(['https://openms.top/*'])
    expect(manifest.content_security_policy?.extension_pages).toBe("script-src 'self' 'wasm-unsafe-eval'; object-src 'self'")
  })
  it('内容脚本仍输出到 content/upload.js 并只在 openms.top 运行', () => {
    expect(manifest.content_scripts).toHaveLength(1)
    expect(manifest.content_scripts[0]).toMatchObject({
      matches: ['https://openms.top/*'],
      js: ['content/upload.js'],
    })
  })

  it('只向 openms.top 开放嵌入所需的 player.html', () => {
    expect(manifest.web_accessible_resources).toEqual([
      { resources: ['player.html'], matches: ['https://openms.top/*'] },
    ])
  })
})
