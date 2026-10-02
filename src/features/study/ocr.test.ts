import { describe, expect, it } from 'vitest'
import { looksScanned, recognisedText } from './ocr'

describe('text recognition for scanned pages', () => {
  it('treats a page with almost no text as a scan', () => {
    expect(looksScanned('')).toBe(true)
    expect(looksScanned('12 · Figure 3')).toBe(true)
    expect(looksScanned('The chain rule gives the derivative of a composition.')).toBe(false)
    expect(looksScanned('Производная сложной функции')).toBe(false)
  })

  it('keeps the words recognition is sure of, a line at a time', () => {
    const word = (text: string, confidence: number) => ({ text, confidence })
    expect(recognisedText([
      { words: [word('The', 92), word('chain', 88), word('rule', 90)] },
      { words: [word('~', 12)] },
      { words: [word('f(g(x))', 71), word('#', 20)] },
    ])).toBe('The chain rule\nf(g(x))')
  })
})
