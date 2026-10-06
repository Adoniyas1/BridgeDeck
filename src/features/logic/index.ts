import { lazy } from 'react'
import { CircuitBoard } from 'lucide-react'
import type { FeatureManifest } from '../features'
const LogicPage = lazy(() => import('./LogicPage'))

/** Logic gates and 74-series chips: design and simulate circuits, truth tables both ways, chip plans
 *  for building them (circuits saved in the shared folder, src-tauri/src/circuits.rs). */
export const logic: FeatureManifest = { id: 'logic', title: 'Logic', icon: CircuitBoard, Page: LogicPage, keepAlive: true }
