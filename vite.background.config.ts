import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))

/**
 * MV3 service worker 必须是单一 ESM 文件：不能依赖页面构建拆出来的 chunk，
 * 否则 `import './assets/xxx.js'` 会在 worker 里解析失败。
 */
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'chrome120',
    sourcemap: false,
    rollupOptions: {
      input: resolve(root, 'src/background/index.ts'),
      output: {
        format: 'es',
        entryFileNames: 'background.js',
        inlineDynamicImports: true,
      },
    },
  },
})
