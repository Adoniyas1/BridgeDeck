import { MonitorUp } from 'lucide-react'
import type { FeatureManifest } from '../features'
import RemotePage from './RemotePage'
import RemoteSessionTab from './RemoteSessionTab'
import { RemoteBackground } from './state'

export const remote: FeatureManifest = { id: 'remote', title: 'Remote', icon: MonitorUp, Page: RemotePage, Background: RemoteBackground, tabKinds: { 'remote-session': RemoteSessionTab } }
