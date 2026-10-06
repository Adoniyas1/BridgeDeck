import { lazy } from 'react'
import { MonitorUp } from 'lucide-react'
import type { FeatureManifest } from '../features'
import { RemoteBackground } from './state'
const RemotePage = lazy(() => import('./RemotePage'))
const RemoteSessionTab = lazy(() => import('./RemoteSessionTab'))

export const remote: FeatureManifest = { id: 'remote', title: 'Remote', icon: MonitorUp, Page: RemotePage, Background: RemoteBackground, tabKinds: { 'remote-session': RemoteSessionTab } }
