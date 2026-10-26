import { createContext, createElement, useContext, useEffect, useState, type ReactNode } from 'react'

/** How long a tab keeps working after you switch away from it. Its background refreshes then pause
 *  until you come back (and catch up at once). Work you started (recording, transcribing,
 *  downloads) never pauses this way: it runs outside the tab until you stop it. */
export const AWAKE_GRACE_MS = 60_000

const AwakeContext = createContext(true)
const ShownContext = createContext(true)

/** True while `active`, and for `graceMs` after it stops being active. */
export function useAwakeFor(active: boolean, graceMs = AWAKE_GRACE_MS): boolean {
  const [awake, setAwake] = useState(active)
  useEffect(() => {
    if (active) { setAwake(true); return }
    const timer = window.setTimeout(() => setAwake(false), graceMs)
    return () => window.clearTimeout(timer)
  }, [active, graceMs])
  return active || awake
}

/** Around each tab: tells what's inside whether the tab is awake (shown, or hidden under a minute). */
export function TabAwake({ active, children }: { active: boolean; children: ReactNode }) {
  return createElement(ShownContext.Provider, { value: active }, createElement(AwakeContext.Provider, { value: useAwakeFor(active) }, children))
}

/** Whether this tab is awake. Outside any tab (background work, the tab bar): always. */
export const useTabAwake = () => useContext(AwakeContext)

/** Whether this tab is on screen now. Tabs stay loaded when hidden, so keyboard shortcuts check it. */
export const useTabShown = () => useContext(ShownContext)
