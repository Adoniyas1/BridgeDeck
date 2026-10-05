import { Tv } from 'lucide-react'
import type { FeatureManifest } from '../features'
import TvPage from './TvPage'

/** Shows and films from streaming sites, inside BridgeDeck's window (like the Browser tab). Kept
 *  mounted so a show keeps playing its place while another tab is open. */
export const tv: FeatureManifest = { id: 'tv', title: 'TV', icon: Tv, Page: TvPage, keepAlive: true }
