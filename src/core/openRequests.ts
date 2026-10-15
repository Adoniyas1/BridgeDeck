import { createStore } from './store'
import type { CircuitFile, CodeFile } from '../lib/bridge'

/** A saved circuit or program to open (from search); the Logic or Code tab opens it and clears it. */
export const openCircuitRequest = createStore<CircuitFile | null>(null)
export const openCodeRequest = createStore<CodeFile | null>(null)
