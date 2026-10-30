import '../styles/base.css'
import '../styles/player.css'
import { mountPlayerStats } from '../features/player-stats/view'

const root = document.getElementById('app')
if (!root) throw new Error('Missing #app')

void mountPlayerStats(root)
