import { lazy } from 'react'
import { Globe } from 'lucide-react'
import type { FeatureManifest } from '../features'
import { AdblockBackground, WebSettings } from './WebSettings'
const BrowserPage = lazy(() => import('./BrowserPage'))

/** Websites inside BridgeDeck's window (src-tauri/src/browser.rs). Kept mounted so the page keeps its
 *  place. Its settings cover all web pages in BridgeDeck: the ad blocker and (Windows) extensions. */
export const browser: FeatureManifest = { id: 'browser', title: 'Browser', icon: Globe, Page: BrowserPage, keepAlive: true, Background: AdblockBackground, Settings: WebSettings, settingsOrder: 60 }
