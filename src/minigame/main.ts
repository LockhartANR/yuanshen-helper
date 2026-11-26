import '../styles/base.css'
import '../styles/options.css'
import '../styles/minigame.css'
import { mountMinigameExport } from '../features/minigame-export/view'

const root = document.getElementById('app')
if (!root) throw new Error('Missing #app')
void mountMinigameExport(root)
