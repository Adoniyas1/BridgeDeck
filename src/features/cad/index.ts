import { lazy } from 'react'
import { Box } from 'lucide-react'
import type { FeatureManifest } from '../features'
const CadPage = lazy(() => import('./CadPage'))

/** CAD: SolidCraft, open-source CAD laid out like Fusion 360, downloaded once and served from this
 *  computer (src-tauri/src/solidcraft.rs); or "Code parts", replicad scripts on OpenCascade
 *  (WebAssembly) with sliders, a 3D view and STL/STEP export, saved in the shared CAD folder (cad.rs). */
export const cad: FeatureManifest = { id: 'cad', title: 'CAD', icon: Box, Page: CadPage, keepAlive: true }
