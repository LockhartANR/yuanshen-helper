import '../styles/base.css'
import '../styles/options.css'
import '../styles/upload.css'
import { mountUploadWatch } from '../features/upload-watch/view'

const root = document.getElementById('app')
if (!root) throw new Error('Missing #app')

void mountUploadWatch(root)
