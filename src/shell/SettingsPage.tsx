import { CheckCircle2, Settings2 } from 'lucide-react'
import { defaultConfig } from '../lib/config'
import { setConfig } from '../core/config'
import { refreshAll } from '../core/refresh'
import { Card, SectionTitle } from '../ui'
import { features } from '../features/registry'
import { version } from '../../package.json'
import NotificationSettings from './NotificationSettings'

/** Each feature contributes its own section; the shell adds the app-wide controls at the end. */
export default function SettingsPage() {
  const sections = features.filter(feature => feature.Settings).sort((a, b) => (a.settingsOrder ?? 100) - (b.settingsOrder ?? 100))
  return <div className="settings-stack">
    {sections.map(({ id, Settings }) => Settings && <Settings key={id} />)}
    <NotificationSettings />
    <Card><SectionTitle title={`BridgeDeck ${version}`} subtitle="Settings are saved in the BridgeDeck app-config folder; passwords, tokens and API keys are kept in the system keychain (macOS Keychain or Windows Credential Manager)." /><div className="actions"><button className="secondary" onClick={() => setConfig(structuredClone(defaultConfig))}><Settings2 size={17}/>Reset defaults</button><button className="secondary" onClick={() => void refreshAll()}><CheckCircle2 size={17}/>Recheck integrations</button></div></Card>
  </div>
}
