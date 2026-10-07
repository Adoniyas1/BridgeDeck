import { createStore } from '../../core/store'
import type { Announcement, Assignment, CanvasCourse } from './canvas'

/** What Canvas sent last: from the feed and from the API kept apart (a source that fails keeps its
 *  last good copy), cached so the list shows at once after a restart. */
export type CanvasData = { feed: Assignment[]; api: Assignment[]; courses: CanvasCourse[]; announcements: Announcement[]; at: number; errors: string[]; loading: boolean }

export const CACHE = 'bridgedeck.canvas'
export const emptyCanvas: CanvasData = { feed: [], api: [], courses: [], announcements: [], at: 0, errors: [], loading: false }

function cached(): CanvasData {
  try {
    const data = JSON.parse(localStorage.getItem(CACHE) ?? 'null') as CanvasData | null
    return data && Array.isArray(data.feed) && Array.isArray(data.api) ? { ...emptyCanvas, ...data, errors: [], loading: false } : emptyCanvas
  } catch { return emptyCanvas }
}

export const canvasStore = createStore<CanvasData>(cached())

