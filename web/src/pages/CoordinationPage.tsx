import type { CoordinationView } from '@shared/types'
import { AlertTriangle, RefreshCw, Send } from 'lucide-react'
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { useToast } from '../components/Toast'
import { relativeTime, repoLabel, sessionLabel } from '../lib/format'
import { useLive } from '../lib/live'

function sessionName(view: CoordinationView, id: string): string {
  const session = view.sessions.find((candidate) => candidate.id === id)
  return session ? sessionLabel(session) : id.slice(0, 8)
}

export function CoordinationPage() {
  const { config, refresh, messageTick, connection } = useLive()
  const { notify } = useToast()
  const [view, setView] = useState<CoordinationView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [target, setTarget] = useState('')
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const tickRef = useRef(messageTick)

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
    try {
      setView(await api.coordination())
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load coordination state.')
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load(true)
    }, 15_000)
    return () => window.clearInterval(timer)
  }, [load])

  useEffect(() => {
    if (tickRef.current === messageTick) return
    tickRef.current = messageTick
    void load(true)
  }, [messageTick, load])

  const readOnly = Boolean(config?.readOnly)

  async function send(event: FormEvent) {
    event.preventDefault()
    const value = body.trim()
    if (!value || sending || readOnly) return
    setSending(true)
    setSendError(null)
    try {
      await api.sendMessage({
        body: value,
        toSessionId: target || null,
        kind: 'note',
      })
      notify(
        target
          ? `Message sent to ${view ? sessionName(view, target) : 'the session'}.`
          : 'Message broadcast to every session.',
        'success',
      )
      setBody('')
      await load()
      await refresh()
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : 'Could not send the message.')
    } finally {
      setSending(false)
    }
  }

  const messages = view ? view.messages.slice().reverse() : []
  const sessions = view
    ? view.sessions
        .filter((session) => !session.archived)
        .slice()
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.title.localeCompare(b.title))
    : []
  const touches = view ? view.fileTouches.slice().reverse().slice(0, 8) : []

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Coordination</h1>
          <p className="page-sub">
            What the sessions have told each other, and where their edits are about to collide.
            Messages are delivered with the next prompt or when a session checks its inbox.
          </p>
        </div>
        <div className="page-head-actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void load()}
            disabled={loading}
          >
            <RefreshCw size={12} aria-hidden="true" />
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error ? (
        <div className="banner banner-offline" role="status">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>
            <strong>Coordination state is stale.</strong> {error}
          </span>
          <span className="banner-spacer" />
          <button type="button" className="btn btn-sm" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : null}

      {!view && loading ? (
        <div className="detail-loading" aria-busy="true">
          <span className="skeleton" style={{ width: '64%', height: 18 }} />
          <span className="skeleton" style={{ width: '42%', height: 13 }} />
          <span className="skeleton" style={{ width: '74%', height: 13 }} />
        </div>
      ) : !view ? (
        <div className="empty">
          <h3>Coordination is not available.</h3>
          <p>{error || 'The daemon did not return the shared state.'}</p>
          <div className="empty-actions">
            <button type="button" className="btn" onClick={() => void load()}>
              Try again
            </button>
          </div>
        </div>
      ) : (
        <div className="coord-grid">
          <div className="coord-main">
            <section className="composer" aria-labelledby="composer-heading">
              <div className="panel-head">
                <h2 id="composer-heading">Send a message</h2>
                <span className="count">
                  {connection === 'live' ? 'live daemon' : 'last known state'}
                </span>
              </div>
              <form onSubmit={send}>
                <div className="field">
                  <label htmlFor="message-target">Recipient</label>
                  <select
                    id="message-target"
                    className="select"
                    value={target}
                    onChange={(event) => setTarget(event.target.value)}
                    disabled={readOnly || sending}
                  >
                    <option value="">Every session</option>
                    {sessions.map((session) => (
                      <option value={session.id} key={session.id}>
                        {sessionLabel(session)} · {repoLabel(session)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="message-body">Message</label>
                  <textarea
                    id="message-body"
                    className="textarea"
                    value={body}
                    onChange={(event) => setBody(event.target.value)}
                    placeholder="Ask a peer to review a change, share a finding, or flag a file you are editing."
                    rows={4}
                    maxLength={8000}
                    disabled={readOnly || sending}
                  />
                </div>
                {sendError ? <p className="form-error">{sendError}</p> : null}
                <div className="composer-foot">
                  <span className="composer-note">
                    {readOnly
                      ? 'Read-only mode. Messages cannot be sent.'
                      : 'Delivered on the next prompt, or when the session checks its inbox.'}
                  </span>
                  <button
                    type="submit"
                    className="btn btn-primary btn-sm"
                    disabled={readOnly || sending || !body.trim()}
                  >
                    <Send size={11} aria-hidden="true" />
                    {sending ? 'Sending…' : 'Send'}
                  </button>
                </div>
              </form>
            </section>

            <section aria-labelledby="stream-heading">
              <div className="panel-head" style={{ marginTop: 30 }}>
                <h2 id="stream-heading">Message stream</h2>
                <span className="count">{messages.length}</span>
              </div>
              {messages.length > 0 ? (
                <ol className="message-stream">
                  {messages.map((message) => (
                    <li className="stream-item" key={message.id}>
                      <div className="stream-head">
                        {message.fromSessionId ? (
                          <Link className="stream-from" to={`/sessions/${message.fromSessionId}`}>
                            {message.fromName}
                          </Link>
                        ) : (
                          <span className="stream-from">{message.fromName}</span>
                        )}
                        <span className="stream-arrow" aria-hidden="true">
                          →
                        </span>
                        {message.toSessionId ? (
                          <Link className="stream-to" to={`/sessions/${message.toSessionId}`}>
                            {message.toName || message.toSessionId.slice(0, 8)}
                          </Link>
                        ) : (
                          <span className="stream-to">All sessions</span>
                        )}
                        {message.kind !== 'note' ? (
                          <span className="chip stream-kind">{message.kind}</span>
                        ) : null}
                        <span className="stream-time">{relativeTime(message.createdAt)}</span>
                      </div>
                      <p className="stream-body">{message.body}</p>
                    </li>
                  ))}
                </ol>
              ) : (
                <div className="empty empty-inline">
                  <h3>No messages yet.</h3>
                  <p>
                    Sessions can use the <code>send_message</code> tool to reach each other. Write
                    the first note above, or ask a session to review another session's change.
                  </p>
                </div>
              )}
            </section>
          </div>

          <aside className="coord-side">
            <section className="side-section">
              <h2>
                Shared files
                <span className="count">{view.overlaps.length}</span>
              </h2>
              {view.overlaps.length > 0 ? (
                view.overlaps.map((overlap) => (
                  <div className="overlap" key={overlap.path}>
                    <div className="overlap-path">{overlap.path}</div>
                    <div className="overlap-meta">
                      {overlap.sessionIds.map((sessionId) => (
                        <Link className="chip" to={`/sessions/${sessionId}`} key={sessionId}>
                          {sessionName(view, sessionId)}
                        </Link>
                      ))}
                      {overlap.claimedBy.length > 0 ? (
                        <span className="overlap-claim">
                          claimed by{' '}
                          {overlap.claimedBy
                            .map((sessionId) => sessionName(view, sessionId))
                            .join(', ')}
                        </span>
                      ) : null}
                      <span className="stream-time">{relativeTime(overlap.lastAt)}</span>
                    </div>
                  </div>
                ))
              ) : (
                <p className="side-note">
                  No two sessions touched the same file in the last six hours. Changes can still
                  overlap in a branch; a claim makes that visible before the edit.
                </p>
              )}
            </section>

            <section className="side-section">
              <h2>
                Active claims
                <span className="count">{view.claims.length}</span>
              </h2>
              {view.claims.length > 0 ? (
                view.claims.map((claim) => (
                  <div className="claim-block" key={claim.id}>
                    {claim.paths.map((path) => (
                      <div className="claim-block-path" key={path}>
                        {path}
                      </div>
                    ))}
                    <div className="claim-block-meta">
                      <Link to={`/sessions/${claim.sessionId}`}>
                        {sessionName(view, claim.sessionId)}
                      </Link>
                      <span>expires {relativeTime(claim.expiresAt)}</span>
                    </div>
                    {claim.note ? <div className="claim-note">{claim.note}</div> : null}
                  </div>
                ))
              ) : (
                <p className="side-note">
                  No active file claims. Claims are how a session says “I am editing this” before
                  another session starts on the same path.
                </p>
              )}
            </section>

            <section className="side-section">
              <h2>
                Recently touched
                <span className="count">{touches.length}</span>
              </h2>
              {touches.length > 0 ? (
                touches.map((touch) => (
                  <div className="touch-row" key={`${touch.sessionId}-${touch.path}-${touch.at}`}>
                    <div className="overlap-path">{touch.path}</div>
                    <div className="claim-block-meta">
                      <Link to={`/sessions/${touch.sessionId}`}>
                        {sessionName(view, touch.sessionId)}
                      </Link>
                      <span>{touch.tool}</span>
                      <span>{relativeTime(touch.at)}</span>
                    </div>
                  </div>
                ))
              ) : (
                <p className="side-note">No file edits recorded in the last six hours.</p>
              )}
            </section>

            <section className="side-section">
              <h2>
                Sessions
                <span className="count">{sessions.length}</span>
              </h2>
              <div className="peer-list">
                {sessions.map((session) => (
                  <Link className="peer" to={`/sessions/${session.id}`} key={session.id}>
                    <span className={`dot dot-${session.status}`} aria-hidden="true" />
                    <span className="peer-name">{sessionLabel(session)}</span>
                    <span className="peer-repo">{repoLabel(session)}</span>
                  </Link>
                ))}
                {sessions.length === 0 ? (
                  <p className="side-note">No active sessions on the board.</p>
                ) : null}
              </div>
            </section>
          </aside>
        </div>
      )}
    </>
  )
}
