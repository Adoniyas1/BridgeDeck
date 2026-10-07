import { describe, expect, it } from 'vitest'
import { mailPage, newAccountId, unreadFromTitle } from './model'

describe('mail', () => {
  it('reads unread counts from page titles', () => {
    expect(unreadFromTitle('Inbox (12) - me@gmail.com - Gmail')).toBe(12)
    expect(unreadFromTitle('Inbox (1,204) - me@gmail.com - Gmail')).toBe(1204)
    expect(unreadFromTitle('(3) Mail - Sam Student - Outlook')).toBe(3)
    expect(unreadFromTitle('Mail - Sam Student - Outlook')).toBe(0)
    expect(unreadFromTitle('Sign in to your account')).toBeNull()
  })
  it('makes page names browser.rs accepts', () => {
    expect(mailPage({ id: newAccountId() })).toMatch(/^mail[a-z0-9]{6}$/)
  })
})
