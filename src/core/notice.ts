import { createStore } from './store'

/** The one-line banner under the tab bar ("Paired with …", errors from actions). */
export const noticeStore = createStore('')
export const setNotice = (text: string) => noticeStore.set(text)
