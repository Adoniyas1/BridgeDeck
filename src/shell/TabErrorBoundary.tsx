import { Component, type ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'
import { logError } from '../core/errorlog'

/** A tab whose page throws while drawing shows this instead of blanking the whole window; the
 *  error goes to the error log. */
export default class TabErrorBoundary extends Component<{ name: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) { return { error } }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    logError(`tab-${this.props.name}`, `${error.name}: ${error.message}${info.componentStack ? `\n${info.componentStack.trim().split('\n').slice(0, 8).join('\n')}` : ''}`)
  }

  render() {
    if (!this.state.error) return this.props.children
    return <div className="card tab-error">
      <TriangleAlert size={24} />
      <h3>This tab ran into a problem</h3>
      <p className="hint">{this.state.error.message}</p>
      <p className="hint">It’s in Settings → Errors and crashes, ready to copy into a chat. The rest of BridgeDeck still works.</p>
      <div className="actions"><button onClick={() => this.setState({ error: null })}>Try again</button><button className="secondary" onClick={() => window.location.reload()}>Reload BridgeDeck</button></div>
    </div>
  }
}
