import { ai } from './ai'
import { devices } from './devices'
import type { FeatureManifest } from './features'
import { files } from './files'
import { home } from './home'
import { messages } from './messages'
import { mimir } from './mimir'
import { remote } from './remote'
import { sync } from './sync'

/** Every feature, in tab order. The shell builds the tab bar, Settings and background work from this list. */
export const features: FeatureManifest[] = [home, devices, remote, messages, ai, mimir, files, sync]
