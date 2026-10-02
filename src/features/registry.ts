import { ai } from './ai'
import { browser } from './browser'
import { calendar } from './calendar'
import { devices } from './devices'
import type { FeatureManifest } from './features'
import { files } from './files'
import { home } from './home'
import { messages } from './messages'
import { manga } from './manga'
import { mimir } from './mimir'
import { notes } from './notes'
import { projects } from './projects'
import { remote } from './remote'
import { study } from './study'
import { sync } from './sync'

/** Every feature, in tab order. The shell builds the tab bar, Settings and background work from this list. */
export const features: FeatureManifest[] = [home, devices, remote, messages, notes, calendar, study, projects, manga, browser, ai, mimir, files, sync]
