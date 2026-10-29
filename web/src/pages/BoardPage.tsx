import type { SessionSummary } from '@shared/types'
import {
  ArrowUpRight,
  Folder,
  GitBranch,
  GitMerge,
  MessageSquare,
  Pin,
  Plus,
  Search,
  SquareTerminal,
} from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { LaunchDialog } from '../components/LaunchDialog'
import { QuestionCard } from '../components/QuestionCard'
import { SignalTrace } from '../components/SignalTrace'
import { StatusBadge, StatusDot } from '../components/StatusBadge'
import { activeCount, BOARD_ORDER, type BoardGroupKey, boardBuckets } from '../lib/board'
import {
  clockTime,
  dayTime,
  idleResponsePreview,
  isNeedsYou,
  relativeTime,
  repeatsMission,
  repoLabel,
  restatesMission,
  sessionLabel,
  sessionStateLine,
  taskPreview,
} from '../lib/format'
import { useLive } from '../lib/live'
import { useNow } from '../lib/theme'

type Filter = 'active' | 'waiting' | 'working' | 'idle' | 'ended' | 'archived'

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'active', label: 'Overview' },
  { key: 'waiting', label: 'Needs you' },
  { key: 'working', label: 'Working' },
  { key: 'idle', label: 'Finished' },
  { key: 'ended', label: 'Ended' },
  { key: 'archived', label: 'Archived' },
]

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']

function word(count: number): string {
  return WORDS[count] ?? String(count)
}

function Word(count: number): string {
  const value = word(count)
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function stampTitle(session: SessionSummary): string {
  if (session.status === 'ended') return 'Session ended'
  if (session.status === 'idle') return 'Turn finished'
  return 'Last activity'
}

/**
 * The timestamp a person reads on the row. For a finished turn this is the
 * last assistant reply, not a later hook heartbeat, so oldest waits sink to
 * the bottom of the finished group.
 */
function sortStamp(session: SessionSummary): number {
  if (session.status === 'ended') {
    return session.endedAt ?? session.activity?.at ?? session.lastActivityAt
  }
  if (session.status === 'idle') {
    const activity = session.activity
    if (activity?.kind === 'response') {
      // A hook Stop event carries the real finish time even when the registry
      // has no process entry. The generic placeholder is only trusted there;
      // for a registry-only row it can fall back to "now" on every refresh.
      if (activity.text !== 'Ready for the next prompt' || session.source === 'hook') {
        return activity.at
      }
    }
    return session.lastActivityAt
  }
  return session.activity?.at ?? session.lastActivityAt
}

const GROUPS: Record<BoardGroupKey, { title: string; hint: string }> = {
  needs: {
    title: 'Needs you now',
    hint: 'Questions can be answered from the board. Permission prompts must be handled in the terminal.',
  },
  finished: {
    title: 'Finished and awaiting your next prompt',
    hint: 'The last turn is complete. A live session is ready for your next prompt; a transcript-only row has no process attached.',
  },
  working: {
    title: 'Working now',
    hint: 'Mid-turn. Nothing to do unless you want to check progress.',
  },
  unknown: {
    title: 'No live signal',
    hint: 'The board has not seen a hook or transcript signal from these yet.',
  },
}

function LiveClock() {
  const now = useNow()
  return <span className="hero-clock">{clockTime(now, true)}</span>
}

function SessionRow({
  session,
  index,
  now,
}: {
  session: SessionSummary
  index: number
  now: number
}) {
  const title = session.mission || session.title || sessionLabel(session)
  const task = taskPreview(session)
  const reply = idleResponsePreview(session)
  const context = reply || task
  const contextLabel = reply ? 'Reply' : 'Latest ask'
  const redundant = reply ? repeatsMission(reply, title) : restatesMission(task, title)
  const showContext =
    (session.status === 'working' || session.status === 'idle') && context.length > 0 && !redundant
  const showTrace = session.status === 'working' || session.status === 'waiting'
  const stamp = sortStamp(session)
  const repo = repoLabel(session)
  const sameName = Boolean(session.project) && repo.toLowerCase() === session.project?.toLowerCase()
  const repoText = [sameName ? null : repo, session.gitBranch].filter(Boolean).join(' / ')

  return (
    <Link
      to={`/sessions/${session.id}`}
      className={[
        'session-row',
        isNeedsYou(session) ? 'is-waiting' : '',
        session.archived ? 'is-archived' : '',
      ]
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
          <StatusBadge status={session.status} className="session-status-pill" />
          {session.pinned ? <Pin className="pin-mark" size={11} aria-label="Pinned" /> : null}
        </span>
        <span className={`session-state state-${session.status}`}>{sessionStateLine(session)}</span>
        {showContext ? (
          <span className="session-context">
            <span className="context-label">{contextLabel}</span> {context}
          </span>
        ) : null}
        <span className="session-meta">
          {session.project ? (
            <span className="meta-item meta-project">
              <Folder size={10} aria-hidden="true" />
              {session.project}
            </span>
          ) : null}
          {repoText ? (
            <span className="meta-item">
              <GitBranch size={10} aria-hidden="true" />
              {repoText}
            </span>
          ) : null}
          {session.name && session.name !== title ? (
            <span className="meta-item">
              <SquareTerminal size={10} aria-hidden="true" />
              {session.name}
            </span>
          ) : null}
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
        </span>
      </span>
      {showTrace ? (
        <span className="session-signal-trace">
          <SignalTrace timeline={session.timeline} status={session.status} />
        </span>
      ) : null}
      <span className="session-side">
        <span className="session-time" title={stampTitle(session)}>
          <span className="sr-only">{stampTitle(session)}: </span>
          {dayTime(stamp, now)}
        </span>
        <span className="session-age">{relativeTime(stamp, now)}</span>
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
  if (filter === 'active') {
    return (
      <div className="empty">
        <h3>Nothing active right now.</h3>
        <p>Ended sessions are in the Ended tab. Start a new one with the button above.</p>
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
  const now = useNow(30_000)

  const buckets = useMemo(() => boardBuckets(sessions), [sessions])
  const { needs: waiting, finished, working, unknown, ended, archived } = buckets
  const activeSessions = useMemo(
    () => [...waiting, ...finished, ...working, ...unknown],
    [waiting, finished, working, unknown],
  )

  const visibleQuestions = useMemo(() => {
    const hidden = new Set([...buckets.archived, ...buckets.ended].map((session) => session.id))
    return questions
      .filter((question) => !hidden.has(question.sessionId))
      .sort((a, b) => Number(b.answerable) - Number(a.answerable) || a.createdAt - b.createdAt)
  }, [questions, buckets])

  const counts: Record<Filter, number> = {
    active: activeCount(buckets),
    waiting: waiting.length,
    working: working.length,
    idle: finished.length,
    ended: ended.length,
    archived: archived.length,
  }

  const query = search.trim().toLowerCase()
  const filtered = useMemo(() => {
    let base: SessionSummary[]
    if (filter === 'archived') base = buckets.archived
    else if (filter === 'waiting') base = buckets.needs
    else if (filter === 'working') base = buckets.working
    else if (filter === 'idle') base = buckets.finished
    else if (filter === 'ended') base = buckets.ended
    else base = [...buckets.needs, ...buckets.finished, ...buckets.working, ...buckets.unknown]
    const searched = query
      ? base.filter((session) =>
          [
            session.id,
            session.shortId,
            session.title,
            session.mission,
            session.name,
            session.project,
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
      if (isNeedsYou(session)) return 0
      if (session.status === 'working') return 1
      if (session.status === 'idle') return 2
      if (session.status === 'unknown') return 3
      return 4
    }
    return searched.slice().sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      const order = priority(a) - priority(b)
      if (order !== 0) return order
      return sortStamp(b) - sortStamp(a)
    })
  }, [buckets, filter, query])

  const filteredBuckets = useMemo(() => boardBuckets(filtered), [filtered])
  const groups = useMemo(() => {
    if (filter !== 'active') return []
    return BOARD_ORDER.map((key) => ({
      key,
      ...GROUPS[key],
      sessions: filteredBuckets[key],
    })).filter((group) => group.sessions.length > 0)
  }, [filter, filteredBuckets])

  const unread = sessions.reduce((sum, session) => sum + session.unreadMessages, 0)
  const launchEnabled = Boolean(config?.launchEnabled && !config.readOnly)
  const defaultCwd =
    activeSessions.find((session) => session.repoRoot)?.repoRoot ??
    activeSessions[0]?.projectPath ??
    ''

  let headline: string
  let supporting: string
  if (waiting.length > 0) {
    headline =
      waiting.length === 1
        ? 'One session needs you now.'
        : `${Word(waiting.length)} sessions need you now.`
    const parts = ['A question or permission prompt is holding the turn.']
    if (finished.length > 0) {
      parts.push(
        `${Word(finished.length)} ${
          finished.length === 1 ? 'session has' : 'sessions have'
        } finished and ${finished.length === 1 ? 'is' : 'are'} waiting for your next prompt.`,
      )
    }
    if (working.length > 0) {
      parts.push(
        `${Word(working.length)} ${
          working.length === 1 ? 'session is' : 'sessions are'
        } still working.`,
      )
    }
    supporting = parts.join(' ')
  } else if (finished.length > 0) {
    headline =
      finished.length === 1
        ? 'One session has finished.'
        : `${Word(finished.length)} sessions have finished.`
    const parts = [
      'The last turn is complete. Open one to read the result, or send the next prompt in its terminal.',
    ]
    if (working.length > 0) {
      parts.push(
        `${Word(working.length)} ${
          working.length === 1 ? 'session is' : 'sessions are'
        } still working.`,
      )
    }
    supporting = parts.join(' ')
  } else if (working.length > 0) {
    headline =
      working.length === 1
        ? 'One session is working.'
        : `${Word(working.length)} sessions are working.`
    supporting = 'Nothing needs you right now. The board updates as each turn moves.'
  } else if (activeSessions.length > 0) {
    headline = 'The board is quiet.'
    supporting = 'No session needs you right now. Updates arrive the moment one starts.'
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
          {waiting.length > 0 && finished.length > 0 ? (
            <span>{finished.length} finished</span>
          ) : null}
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
        filter === 'active' ? (
          <div className="board-groups">
            {groups.map((group) => (
              <section
                className={`board-group group-${group.key}`}
                key={group.key}
                aria-labelledby={`group-${group.key}`}
              >
                <div className="group-head">
                  <h3 id={`group-${group.key}`}>{group.title}</h3>
                  <span className="group-count">{group.sessions.length}</span>
                  <p className="group-hint">{group.hint}</p>
                </div>
                <div className="session-list">
                  {group.sessions.map((session, index) => (
                    <SessionRow key={session.id} session={session} index={index} now={now} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <div className="session-list">
            {filtered.map((session, index) => (
              <SessionRow key={session.id} session={session} index={index} now={now} />
            ))}
          </div>
        )
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
