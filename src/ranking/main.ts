import '../styles/base.css'
import '../styles/options.css'
import '../styles/ranking.css'
import { mountGlobalRanking } from '../features/custom-ranking/view'

const root = document.getElementById('app')
if (!root) throw new Error('Missing #app')

void mountGlobalRanking(root)
