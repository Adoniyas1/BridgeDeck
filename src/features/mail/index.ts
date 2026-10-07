import { lazy } from 'react'
import { Mail } from 'lucide-react'
import type { FeatureManifest } from '../features'
import { mailBadgeStore, MailBackground } from './state'
const MailPage = lazy(() => import('./MailPage'))

/** Mail: Outlook, Gmail and other web mail in BridgeDeck, with an unread badge and new-mail
 *  notifications. Kept mounted so the pages stay signed in and placed. */
export const mail: FeatureManifest = { id: 'mail', title: 'Mail', icon: Mail, Page: MailPage, keepAlive: true, Background: MailBackground, badge: mailBadgeStore }
