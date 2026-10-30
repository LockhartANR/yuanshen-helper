import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const viteBin = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url))

const targets = [
  { name: 'pages', args: [] },
  { name: 'worker', args: ['--config', 'vite.background.config.ts'] },
  { name: 'content', args: ['--config', 'vite.content.config.ts'] },
]

const children = targets.map((target) => {
  const child = spawn(process.execPath, [viteBin, 'build', '--watch', ...target.args], {
    stdio: 'inherit',
  })
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[watch] ${target.name} exited with ${code}`)
      shutdown(code)
    }
  })
  return child
})

function shutdown(code = 0) {
  for (const child of children) child.kill()
  process.exit(code)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
