import { useSyncExternalStore } from 'react'

export type Store<T> = {
  get: () => T
  set: (next: T | ((current: T) => T)) => void
  subscribe: (listener: () => void) => () => void
}

/** A small observable value shared between features. Components read it with `useStore`; plain
 *  functions (feature actions) read and write it with `get`/`set` without needing React. */
export function createStore<T>(initial: T): Store<T> {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    get: () => state,
    set: next => {
      const value = typeof next === 'function' ? (next as (current: T) => T)(state) : next
      if (Object.is(value, state)) return
      state = value
      listeners.forEach(listener => listener())
    },
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get)
}
