import { lazy } from 'react'
import { Music } from 'lucide-react'
import type { FeatureManifest } from '../features'
const SpotifyPage = lazy(() => import('./SpotifyPage'))

/** Spotify: its web player inside BridgeDeck, or the Spotify app on this computer (now playing,
 *  play/pause/skip). Kept mounted so music keeps playing while another tab is open. */
export const spotify: FeatureManifest = { id: 'spotify', title: 'Spotify', icon: Music, Page: SpotifyPage, keepAlive: true }
