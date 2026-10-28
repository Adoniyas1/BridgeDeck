import { describe, expect, it } from 'vitest'
import { ScrollMemory } from './scrollMemory'

/** A scroll area: scrollTop is clamped to the content, as a browser does. */
function area(height: number) {
  let top = 0
  const el = {
    scrollHeight: height,
    clientHeight: 500,
    get scrollTop() { return top },
    set scrollTop(v: number) { top = Math.max(0, Math.min(v, el.scrollHeight - el.clientHeight)) },
  }
  return el
}

describe('each tab keeps its scroll place', () => {
  it('goes back to where a tab was left, and the top for a new one', () => {
    const el = area(4000)
    const m = new ScrollMemory(el)
    m.show('study')
    el.scrollTop = 1800; m.scrolled()
    m.show('calendar')
    expect(el.scrollTop).toBe(0)
    el.scrollTop = 300; m.scrolled()
    m.show('study')
    expect(el.scrollTop).toBe(1800)
    m.show('calendar')
    expect(el.scrollTop).toBe(300)
  })

  it('catches up as a loading tab grows, without the short page overwriting its place', () => {
    const el = area(4000)
    const m = new ScrollMemory(el)
    m.show('study')
    el.scrollTop = 2500; m.scrolled()
    m.show('home')
    el.scrollHeight = 900 // Study unloaded and loading again: short at first
    m.show('study')
    expect(el.scrollTop).toBe(400)
    m.scrolled() // the clamped scroll event isn't taken as the new place
    expect(m.placeOf('study')).toBe(2500)
    el.scrollHeight = 4000
    expect(m.retry()).toBe(true)
    expect(el.scrollTop).toBe(2500)
  })

  it('lets the person scroll away while a place is still being restored', () => {
    const el = area(900)
    const m = new ScrollMemory(el)
    m.show('study'); el.scrollHeight = 4000; el.scrollTop = 2500; m.scrolled()
    m.show('home'); el.scrollHeight = 900
    m.show('study')
    el.scrollTop = 100; m.userScrolled()
    el.scrollHeight = 4000
    expect(m.retry()).toBe(true)
    expect(el.scrollTop).toBe(100)
    expect(m.placeOf('study')).toBe(100)
  })
})
