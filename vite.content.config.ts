import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))

/**
 * 内容脚本不能是 ES module（content_scripts 不支持 type: module），
 * 必须打成自包含的 IIFE，且不能有动态 import。
 */
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'chrome120',
    sourcemap: false,
    rollupOptions: {
      input: resolve(root, 'src/content/upload.ts'),
      output: {
        format: 'iife',
        entryFileNames: 'content/upload.js',
        inlineDynamicImports: true,
      },
    },
  },
})
