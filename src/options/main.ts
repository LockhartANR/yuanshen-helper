import '../styles/base.css'
import '../styles/options.css'
import { features } from '../features/registry'

const root = document.getElementById('app')
if (!root) throw new Error('Missing #app')

const feature = features.find((item) => item.id === 'user-search')
if (!feature) throw new Error('User search feature is not registered')

void feature.mountOptions(root)
