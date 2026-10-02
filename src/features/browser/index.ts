import { Globe } from 'lucide-react'
import type { FeatureManifest } from '../features'
import BrowserPage from './BrowserPage'

/** Websites inside BridgeDeck's window (src-tauri/src/browser.rs). Kept mounted so the page keeps its place. */
export const browser: FeatureManifest = { id: 'browser', title: 'Browser', icon: Globe, Page: BrowserPage, keepAlive: true }
