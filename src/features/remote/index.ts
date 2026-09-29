import { MonitorUp } from 'lucide-react'
import type { FeatureManifest } from '../features'
import RemotePage from './RemotePage'
import { RemoteBackground } from './state'

export const remote: FeatureManifest = { id: 'remote', title: 'Remote', icon: MonitorUp, Page: RemotePage, Background: RemoteBackground }
