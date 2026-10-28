import { RefreshCw } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { setToken } from '../api'
import { useLive } from '../lib/live'
import { BrandLockup } from './Brand'
import { ThemeToggle } from './ThemeToggle'

export function TokenGate() {
  const { connect } = useLive()
  const [token, setTokenValue] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    const value = token.trim()
    if (!value || pending) return
    setPending(true)
    setError(null)
    setToken(value)
    const ok = await connect()
    setPending(false)
    if (!ok) {
      // `connect` fails both for a rejected token and for an unreachable
      // daemon, so do not clear the token until we know it was the former.
      setError('Could not connect. The daemon may be offline, or the token was rejected.')
    }
  }

  return (
    <div className="gate">
      <div className="gate-theme">
        <ThemeToggle />
      </div>
      <div className="gate-inner">
        <div className="gate-brand">
          <BrandLockup />
        </div>
        <h1>Connect to your daemon</h1>
        <p className="gate-sub">
          This board is protected by an access token. The daemon wrote it to{' '}
          <code>client.json</code> in its data directory when it started.
        </p>
        <form className="gate-form" onSubmit={submit}>
          <div className="field">
            <label htmlFor="token">Access token</label>
            <input
              id="token"
              className="input mono"
              type="password"
              value={token}
              onChange={(event) => setTokenValue(event.target.value)}
              placeholder="Paste the token"
              autoComplete="current-password"
              required
            />
          </div>
          {error ? <p className="form-error">{error}</p> : null}
          <div className="form-actions">
            <button className="btn btn-primary" type="submit" disabled={pending || !token.trim()}>
              {pending ? 'Checking…' : 'Connect'}
            </button>
          </div>
        </form>
        <p className="gate-foot">
          You can also open the board with <code>?token=…</code> once; the token is kept in this
          browser and removed from the address bar. See the{' '}
          <a
            href="https://github.com/fabioudev/claude-session-manager#remote-access"
            target="_blank"
            rel="noreferrer"
          >
            remote access notes
          </a>
          .
        </p>
      </div>
    </div>
  )
}

export function BootScreen({ error }: { error: string | null }) {
  const { connect } = useLive()
  const [pending, setPending] = useState(false)

  async function retry() {
    setPending(true)
    await connect()
    setPending(false)
  }

  return (
    <div className="boot">
      <div className="gate-theme">
        <ThemeToggle />
      </div>
      <div className="boot-inner">
        <div className="gate-brand">
          <BrandLockup />
        </div>
        {error ? (
          <>
            <h1>No daemon at this address</h1>
            <p className="gate-sub">
              The page is served, but the API did not answer. Start the session manager on the
              machine that runs Claude Code, then try again.
            </p>
            <div className="boot-code">npx claude-session-manager</div>
            <p className="boot-error">{error}</p>
            <div className="settings-actions">
              <button className="btn btn-primary" type="button" onClick={() => void retry()}>
                <RefreshCw size={14} aria-hidden="true" />
                {pending ? 'Retrying…' : 'Retry'}
              </button>
            </div>
          </>
        ) : (
          <>
            <h1>Opening the board</h1>
            <div className="boot-line">
              <span className="dot dot-working" aria-hidden="true" />
              <span>Connecting to the local daemon</span>
            </div>
            <p className="boot-hint">
              Reading session registries and the latest transcript signals. This usually takes under
              a second.
            </p>
            <div className="boot-skeleton" aria-hidden="true">
              <span className="skeleton" style={{ width: '72%', height: 14 }} />
              <span className="skeleton" style={{ width: '48%', height: 14 }} />
              <span className="skeleton" style={{ width: '63%', height: 14 }} />
            </div>
          </>
        )}
      </div>
    </div>
  )
}
