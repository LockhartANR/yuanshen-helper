import '../styles/base.css'
import '../styles/player.css'
import { mountPlayerStats } from '../features/player-stats/view'

const root = document.getElementById('app')
if (!root) throw new Error('Missing #app')

const framed = window.self !== window.top

void mountPlayerStats(root, { framed }).then((handle) => {
  if (!handle) return
  window.addEventListener('pagehide', () => handle.destroy(), { once: true })
})
