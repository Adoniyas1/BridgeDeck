import { describe, expect, it } from 'vitest'
import { cardSource, symbols } from './CardText'

describe('card text', () => {
  it('shows units as symbols', () => {
    expect(symbols('R = 4.7 kohm, C = 10 uF, 50 ohms, 90 deg')).toBe('R = 4.7 kΩ, C = 10 µF, 50 Ω, 90 °')
    expect(symbols('the ohmic region')).toBe('the ohmic region')
  })
  it('finds the page a card came from', () => {
    expect(cardSource('Gain? :: 20 dB ([Sedra, p. 214](book:EE%20330/Sedra.pdf#214))')).toEqual({ label: 'Sedra, p. 214', href: 'book:EE%20330/Sedra.pdf#214', page: 214 })
    expect(cardSource('Gain? :: 20 dB')).toBeNull()
  })
})
