/**
 * 让 `node --import ./scripts/ts-resolve.mjs xxx.ts` 能解析无扩展名的相对导入。
 * 源码里写的是打包器风格的 `./model`，Node 的 ESM 解析要求带扩展名，
 * 这里补一个解析钩子，避免为了脚本去改源码的导入风格。
 */
import { registerHooks } from 'node:module'

const NEEDS_EXTENSION = /^\.{1,2}\//

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (NEEDS_EXTENSION.test(specifier) && !/\.[cm]?[jt]s$/i.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context)
      } catch {
        // 落到下面的默认解析，让真正的错误照常抛出。
      }
    }
    return nextResolve(specifier, context)
  },
})
