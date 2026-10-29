import { LayoutGrid, MessagesSquare, Settings2, WifiOff } from 'lucide-react'
import { useEffect } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { activeCount, boardBuckets } from '../lib/board'
import { relativeTime } from '../lib/format'
import { type ConnectionState, useLive } from '../lib/live'
import { BrandLockup } from './Brand'
import { ThemeToggle } from './ThemeToggle'

function navClass({ isActive }: { isActive: boolean }): string {
  return isActive ? 'nav-link active' : 'nav-link'
}

function connectionLabel(state: ConnectionState): string {
  if (state === 'live') return 'Live'
  if (state === 'polling') return 'Polling'
  if (state === 'offline') return 'Daemon offline'
  return 'Connecting'
}

function connectionDot(state: ConnectionState): string {
  if (state === 'live' || state === 'polling') return 'dot-live'
  if (state === 'offline') return 'dot-offline'
  return 'dot-idle'
}

export function AppShell() {
  const { sessions, config, connection, lastEventAt, reconnect, ready } = useLive()
  const location = useLocation()

  // biome-ignore lint/correctness/useExhaustiveDependencies: navigating to another route is the whole point of this effect.
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' })
  }, [location.pathname])

  const buckets = boardBuckets(sessions)
  const needs = buckets.needs.length
  const active = activeCount(buckets)
  const boardBadge = needs > 0 ? needs : active
  const unread = sessions.reduce((sum, session) => sum + session.unreadMessages, 0)
  const offline = ready && connection === 'offline'

  const nav = (
    <nav aria-label="Main">
      <ul className="nav-list">
        <li>
          <NavLink to="/" end className={navClass}>
            <LayoutGrid className="nav-icon" size={15} aria-hidden="true" />
            <span>Board</span>
            <span
              className={needs > 0 ? 'nav-count needs' : 'nav-count'}
              title={
                needs > 0
                  ? `${needs} session${needs === 1 ? '' : 's'} need you`
                  : `${active} active`
              }
            >
              {boardBadge > 0 ? boardBadge : ''}
            </span>
          </NavLink>
        </li>
        <li>
          <NavLink to="/coordination" className={navClass}>
            <MessagesSquare className="nav-icon" size={15} aria-hidden="true" />
            <span>Coordination</span>
            <span className={unread > 0 ? 'nav-count needs' : 'nav-count'}>
              {unread > 0 ? unread : ''}
            </span>
          </NavLink>
        </li>
        <li>
          <NavLink to="/settings" className={navClass}>
            <Settings2 className="nav-icon" size={15} aria-hidden="true" />
            <span>Settings</span>
            <span className="nav-count" />
          </NavLink>
        </li>
      </ul>
    </nav>
  )

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className="shell">
        <aside className="rail">
          <BrandLockup needs={needs > 0} />
          {nav}
          <div className="rail-foot">
            <div className="rail-status">
              <span className={`dot ${connectionDot(connection)}`} aria-hidden="true" />
              <span>{connectionLabel(connection)}</span>
              {lastEventAt > 0 ? (
                <span className="rail-meta" style={{ marginLeft: 'auto' }}>
                  {relativeTime(lastEventAt)}
                </span>
              ) : null}
            </div>
            <div className={config?.pluginConnected ? 'rail-plugin connected' : 'rail-plugin'}>
              <span
                className={`dot ${config?.pluginConnected ? 'dot-working' : 'dot-idle'}`}
                aria-hidden="true"
              />
              <span>{config?.pluginConnected ? 'Plugin connected' : 'No plugin signal yet'}</span>
            </div>
            <div className="rail-meta">
              <span>v{config?.version ?? '0.0.0'}</span>
              <a
                href="https://github.com/fabioudev/claude-session-manager"
                target="_blank"
                rel="noreferrer"
              >
                GitHub
              </a>
              <ThemeToggle />
            </div>
          </div>
        </aside>

        <header className="mobile-bar">
          <div className="mobile-bar-top">
            <BrandLockup needs={needs > 0} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span className={`dot ${connectionDot(connection)}`} aria-hidden="true" />
              <ThemeToggle />
            </div>
          </div>
          <div className="mobile-nav">{nav}</div>
        </header>

        <main className="main" id="main">
          <div className="page">
            {offline ? (
              <div className="banner banner-offline" role="status">
                <WifiOff size={14} aria-hidden="true" />
                <span>
                  <strong>Reconnecting to the daemon.</strong> The board shows the last known state.
                </span>
                <span className="banner-spacer" />
                <button type="button" className="btn btn-sm" onClick={reconnect}>
                  Retry now
                </button>
              </div>
            ) : null}
            {config?.readOnly && !offline ? (
              <div className="banner banner-readonly" role="status">
                <span>
                  <strong>Read-only mode.</strong> Answers, messages, claims and new sessions are
                  disabled.
                </span>
              </div>
            ) : null}
            <Outlet />
          </div>
        </main>
      </div>
    </>
  )
}
