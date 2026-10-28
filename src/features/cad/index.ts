import { lazy } from 'react'
import { Box } from 'lucide-react'
import type { FeatureManifest } from '../features'
const CadPage = lazy(() => import('./CadPage'))

/** Parametric CAD in the window: replicad scripts on OpenCascade (WebAssembly), sliders, a 3D view,
 *  STL/STEP export; models saved in the shared folder's CAD folder (src-tauri/src/cad.rs). */
export const cad: FeatureManifest = { id: 'cad', title: 'CAD', icon: Box, Page: CadPage, keepAlive: true }
