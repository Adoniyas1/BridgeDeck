import { lazy } from 'react'
import { Code2 } from 'lucide-react'
import type { FeatureManifest } from '../features'
const CodePage = lazy(() => import('./CodePage'))

/** Write programs (C, C++, Python, MATLAB, Java…) and run them with the compilers on this computer
 *  (src-tauri/src/code.rs); programs are saved in the shared folder's Code folder. */
export const code: FeatureManifest = { id: 'code', title: 'Code', icon: Code2, Page: CodePage, keepAlive: true }
