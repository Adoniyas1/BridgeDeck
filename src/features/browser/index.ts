import { lazy } from 'react'
import { Globe } from 'lucide-react'
import type { FeatureManifest } from '../features'
import { WebSettings } from './WebSettings'
import { BrowserBackground } from './state'
const BrowserPage = lazy(() => import('./BrowserPage'))
const WebTab = lazy(() => import('./WebTab'))

/** Websites inside BridgeDeck's window (src-tauri/src/browser.rs). Kept mounted so the page keeps its
 *  place; downloads and pages sent from the other computer are watched in the background. Its settings cover all web pages in BridgeDeck: the ad blocker and (Windows) extensions. */
export const browser: FeatureManifest = { id: 'browser', title: 'Browser', icon: Globe, Page: BrowserPage, keepAlive: true, tabKinds: { web: WebTab }, Background: BrowserBackground, Settings: WebSettings, settingsOrder: 60 }
