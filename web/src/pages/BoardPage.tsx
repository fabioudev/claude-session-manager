import type { SessionSummary } from '@shared/types'
import { ArrowUpRight, GitBranch, GitMerge, MessageSquare, Pin, Plus, Search } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { LaunchDialog } from '../components/LaunchDialog'
import { QuestionCard } from '../components/QuestionCard'
import { SignalTrace } from '../components/SignalTrace'
import { StatusBadge, StatusDot } from '../components/StatusBadge'
import { clockTime, relativeTime, repoLabel, sessionLabel, taskPreview } from '../lib/format'
import { useLive } from '../lib/live'
import { useNow } from '../lib/theme'

type Filter = 'active' | 'waiting' | 'working' | 'idle' | 'ended' | 'archived'

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'active', label: 'Active' },
  { key: 'waiting', label: 'Waiting' },
  { key: 'working', label: 'Working' },
  { key: 'idle', label: 'Idle' },
  { key: 'ended', label: 'Ended' },
  { key: 'archived', label: 'Archived' },
]

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']

function word(count: number): string {
  return WORDS[count] ?? String(count)
}

function LiveClock() {
  const now = useNow()
  return <span className="hero-clock">{clockTime(now, true)}</span>
}

function SessionRow({ session, index }: { session: SessionSummary; index: number }) {
  const question = session.question
  const waiting = session.status === 'waiting' || Boolean(question)
  const title = session.title || sessionLabel(session)
  const task = taskPreview(session)
  const showTask = task && task !== title
  const metaState = session.jobId ? 'background job' : session.live ? 'local session' : 'history'

  return (
    <Link
      to={`/sessions/${session.id}`}
      className={['session-row', waiting ? 'is-waiting' : '', session.archived ? 'is-archived' : '']
        .filter(Boolean)
        .join(' ')}
      style={{ animationDelay: `${Math.min(index, 12) * 22}ms` }}
    >
      <span className="session-signal">
        <StatusDot status={session.status} />
      </span>
      <span className="session-main">
        <span className="session-title-row">
          <span className="session-title">{title}</span>
          <span className="session-id">{session.shortId}</span>
          {session.pinned ? <Pin className="pin-mark" size={11} aria-label="Pinned" /> : null}
        </span>
        <span className={showTask ? 'session-task' : 'session-task placeholder'}>
          {showTask ? task : session.statusDetail}
        </span>
        <span className="session-meta">
          <span className="meta-item">
            <GitBranch size={10} aria-hidden="true" />
            {repoLabel(session)}
            {session.gitBranch ? ` / ${session.gitBranch}` : ''}
          </span>
          {session.unreadMessages > 0 ? (
            <span className="session-flag">
              <MessageSquare size={10} aria-hidden="true" />
              {session.unreadMessages} unread
            </span>
          ) : null}
          {session.overlapCount > 0 ? (
            <span className="session-flag accent">
              <GitMerge size={10} aria-hidden="true" />
              {session.overlapCount} overlap{session.overlapCount === 1 ? '' : 's'}
            </span>
          ) : null}
          {question ? <span className="session-flag accent">question waiting</span> : null}
        </span>
      </span>
      <span className="session-signal-trace">
        <SignalTrace timeline={session.timeline} status={session.status} />
        <span className="trace-caption">last 30m</span>
      </span>
      <span className="session-side">
        <StatusBadge status={session.status} />
        <span className="session-age">
          {relativeTime(session.endedAt ?? session.lastActivityAt)}
        </span>
        <span className="session-source">{metaState}</span>
      </span>
    </Link>
  )
}

function EmptyBoard({
  filter,
  search,
  hasSessions,
  onLaunch,
}: {
  filter: Filter
  search: string
  hasSessions: boolean
  onLaunch: () => void
}) {
  if (search) {
    return (
      <div className="empty">
        <h3>No session matches “{search}”.</h3>
        <p>Try a repository, branch, session id or a word from the task.</p>
      </div>
    )
  }
  if (filter === 'archived') {
    return (
      <div className="empty">
        <h3>Nothing archived.</h3>
        <p>Archive a finished session from its detail page to keep the board focused.</p>
      </div>
    )
  }
  if (filter === 'ended') {
    return (
      <div className="empty">
        <h3>No ended sessions yet.</h3>
        <p>History from local transcripts appears here after a session closes.</p>
      </div>
    )
  }
  if (!hasSessions) {
    return (
      <div className="empty">
        <h3>The board is waiting for its first session.</h3>
        <p>
          Install the <code>csm</code> plugin in Claude Code, or start a background session with the
          button above. Transcripts already on this machine appear even without the plugin.
        </p>
        <div className="empty-actions">
          <button type="button" className="btn" onClick={onLaunch}>
            <Plus size={14} aria-hidden="true" />
            Start a session
          </button>
          <a
            className="btn btn-ghost"
            href="https://github.com/fabioudev/claude-session-manager#install-the-plugin"
            target="_blank"
            rel="noreferrer"
          >
            Plugin setup
            <ArrowUpRight size={13} aria-hidden="true" />
          </a>
        </div>
      </div>
    )
  }
  return (
    <div className="empty">
      <h3>No sessions in this view.</h3>
      <p>The other filters may still have something for you.</p>
    </div>
  )
}

export function BoardPage() {
  const { sessions, questions, config } = useLive()
  const [filter, setFilter] = useState<Filter>('active')
  const [search, setSearch] = useState('')
  const [launchOpen, setLaunchOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  const archivedIds = useMemo(
    () => new Set(sessions.filter((session) => session.archived).map((session) => session.id)),
    [sessions],
  )
  const activeSessions = sessions.filter((session) => !session.archived)
  const active = activeSessions.filter((session) => session.status !== 'ended')
  const waiting = activeSessions.filter(
    (session) => session.status === 'waiting' || Boolean(session.question),
  )
  const working = activeSessions.filter((session) => session.status === 'working')
  const idle = activeSessions.filter((session) => session.status === 'idle')
  const ended = activeSessions.filter((session) => session.status === 'ended')
  const archived = sessions.filter((session) => session.archived)

  const visibleQuestions = questions
    .filter((question) => !archivedIds.has(question.sessionId))
    .sort((a, b) => Number(b.answerable) - Number(a.answerable) || a.createdAt - b.createdAt)

  const counts: Record<Filter, number> = {
    active: active.length,
    waiting: waiting.length,
    working: working.length,
    idle: idle.length,
    ended: ended.length,
    archived: archived.length,
  }

  const query = search.trim().toLowerCase()
  const filtered = useMemo(() => {
    const base = sessions.filter((session) => {
      if (filter === 'archived') return session.archived
      if (session.archived) return false
      if (filter === 'active') return session.status !== 'ended'
      if (filter === 'waiting') return session.status === 'waiting' || Boolean(session.question)
      if (filter === 'working') return session.status === 'working'
      if (filter === 'idle') return session.status === 'idle'
      if (filter === 'ended') return session.status === 'ended'
      return true
    })
    const searched = query
      ? base.filter((session) =>
          [
            session.id,
            session.shortId,
            session.title,
            session.name,
            session.projectName,
            session.projectPath,
            session.repoName,
            session.gitBranch,
            session.task,
            session.statusDetail,
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
            .includes(query),
        )
      : base
    const priority = (session: SessionSummary): number => {
      if (session.question) return 0
      if (session.status === 'waiting') return 1
      if (session.status === 'working') return 2
      if (session.status === 'idle') return 3
      if (session.status === 'unknown') return 4
      return 5
    }
    return searched.slice().sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      const order = priority(a) - priority(b)
      if (order !== 0) return order
      return b.lastActivityAt - a.lastActivityAt
    })
  }, [sessions, filter, query])

  const attentionSessions = new Set(visibleQuestions.map((question) => question.sessionId))
  const attention = attentionSessions.size
  const unread = sessions.reduce((sum, session) => sum + session.unreadMessages, 0)
  const launchEnabled = Boolean(config?.launchEnabled && !config.readOnly)
  const defaultCwd =
    active.find((session) => session.repoRoot)?.repoRoot ?? active[0]?.projectPath ?? ''

  let headline: string
  let supporting: string
  if (attention > 0) {
    headline = attention === 1 ? 'One session needs you.' : `${word(attention)} sessions need you.`
    supporting =
      'A tool call is holding. Answer it here and the session continues; the terminal does not need focus.'
  } else if (working.length > 0) {
    headline =
      working.length === 1
        ? 'One session is working.'
        : `${word(working.length)} sessions are working.`
    supporting =
      idle.length > 0
        ? `${word(idle.length)} more ${idle.length === 1 ? 'is' : 'are'} idle. The board updates as they move.`
        : 'Live activity from this machine, ordered by what needs attention first.'
  } else if (active.length > 0) {
    headline = 'The board is quiet.'
    supporting = `${word(active.length)} ${active.length === 1 ? 'session is' : 'sessions are'} connected but idle. Updates arrive the moment one starts.`
  } else if (ended.length > 0) {
    headline = 'Nothing is running.'
    supporting =
      'Recent sessions have ended. Their transcripts are still here if you need the history.'
  } else {
    headline = 'Nothing is running.'
    supporting =
      'Start Claude Code with the plugin, or launch a background session from this board.'
  }

  return (
    <>
      <section className="hero">
        <div>
          <h1>{headline}</h1>
          <p className="hero-sub">{supporting}</p>
        </div>
        <div className="hero-aside">
          <span className="live-line">
            <span className="dot dot-live" aria-hidden="true" />
            local board
          </span>
          <LiveClock />
          {unread > 0 ? <span>{unread} unread messages</span> : null}
        </div>
      </section>

      {visibleQuestions.length > 0 ? (
        <section className="needs-block" aria-labelledby="needs-heading">
          <div className="section-head">
            <h2 id="needs-heading">Needs your answer</h2>
            <span className="count">{visibleQuestions.length}</span>
          </div>
          {visibleQuestions.map((question) => (
            <QuestionCard key={question.id} question={question} />
          ))}
        </section>
      ) : null}

      <div className="toolbar">
        <div className="toolbar-left">
          <h2>Sessions</h2>
          <span className="count">
            {filtered.length} of {sessions.length}
          </span>
        </div>
        <div className="toolbar-right">
          {launchEnabled ? (
            <button type="button" className="btn btn-sm" onClick={() => setLaunchOpen(true)}>
              <Plus size={13} aria-hidden="true" />
              New session
            </button>
          ) : null}
          <div className="search">
            <Search size={13} aria-hidden="true" />
            <input
              ref={searchRef}
              className="input"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Filter sessions"
              aria-label="Filter sessions"
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setSearch('')
                  event.currentTarget.blur()
                }
              }}
            />
          </div>
        </div>
      </div>

      <fieldset className="tabs" aria-label="Session filters">
        {FILTERS.map((item) => (
          <button
            key={item.key}
            type="button"
            className="tab"
            aria-pressed={filter === item.key}
            onClick={() => setFilter(item.key)}
          >
            {item.label}
            <span className="tab-count">{counts[item.key]}</span>
          </button>
        ))}
      </fieldset>

      {filtered.length > 0 ? (
        <div className="session-list">
          {filtered.map((session, index) => (
            <SessionRow key={session.id} session={session} index={index} />
          ))}
        </div>
      ) : (
        <EmptyBoard
          filter={filter}
          search={search.trim()}
          hasSessions={sessions.length > 0}
          onLaunch={() => setLaunchOpen(true)}
        />
      )}

      {launchOpen ? (
        <LaunchDialog defaultCwd={defaultCwd} onClose={() => setLaunchOpen(false)} />
      ) : null}
    </>
  )
}
