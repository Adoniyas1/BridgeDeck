import { describe, expect, it } from 'vitest'
import { isLockPayload, lockText, unlockText } from './lock'

describe('locked notes', () => {
  it('encrypts with the password and only opens with it', async () => {
    const sealed = await lockText('Bank PIN 1234\n- [ ] renew passport', 'correct horse')
    expect(isLockPayload(sealed)).toBe(true)
    expect(sealed).not.toContain('1234')
    expect(await unlockText(sealed, 'correct horse')).toBe('Bank PIN 1234\n- [ ] renew passport')
    await expect(unlockText(sealed, 'wrong')).rejects.toThrow('Wrong password')
    // A fresh salt and nonce each time.
    expect(await lockText('same', 'pw')).not.toBe(await lockText('same', 'pw'))
    await expect(unlockText('v9.a.b.c', 'pw')).rejects.toThrow('version')
  }, 20_000)
})
