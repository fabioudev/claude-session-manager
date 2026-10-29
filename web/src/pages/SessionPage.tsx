import type {
  ActivityEvent,
  ActivityKind,
  SessionDetail,
  SessionPatch,
  SessionSummary,
  TodoItem,
} from '@shared/types'
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Bot,
  Check,
  CircleDot,
  Copy,
  CornerDownRight,
  FileCode2,
  Folder,
  GitBranch,
  type LucideIcon,
  MessageSquare,
  Pencil,
  Pin,
  PinOff,
  Send,
  Square,
  Wrench,
} from 'lucide-react'
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ApiError, api } from '../api'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { QuestionCard } from '../components/QuestionCard'
import { SignalTrace } from '../components/SignalTrace'
import { StatusBadge } from '../components/StatusBadge'
import { useToast } from '../components/Toast'
import {
  clockTime,
  compactNumber,
  dateTime,
  formatCost,
  formatModel,
  relativeTime,
  repeatsMission,
  repoLabel,
  shortDuration,
} from '../lib/format'
import { useLive } from '../lib/live'

const ACTIVITY_LABEL: Record<ActivityKind, string> = {
  prompt: 'Prompt',
  response: 'Response',
  tool: 'Tool',
  'tool-result': 'Tool result',
  status: 'Status',
  question: 'Question',
  message: 'Message',
  file: 'File',
  error: 'Error',
}

function activityIcon(kind: ActivityKind): ReactNode {
  const Icon: LucideIcon =
    kind === 'prompt'
      ? CornerDownRight
      : kind === 'response'
        ? Bot
        : kind === 'tool'
          ? Wrench
          : kind === 'tool-result'
            ? Check
            : kind === 'question' || kind === 'message'
              ? MessageSquare
              : kind === 'file'
                ? FileCode2
                : kind === 'error'
                  ? AlertTriangle
                  : CircleDot
  return <Icon size={11} aria-hidden="true" />
}

function Fact({
  label,
  mono = false,
  children,
}: {
  label: string
  mono?: boolean
  children: ReactNode
}) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd className={mono ? 'mono' : undefined}>{children}</dd>
    </div>
  )
}

function ActivityRow({ activity }: { activity: ActivityEvent }) {
  const detail = activity.detail?.trim()
  return (
    <li className={`activity-item kind-${activity.kind}`}>
      <span className="activity-time">{clockTime(activity.at)}</span>
      <span className="activity-marker">{activityIcon(activity.kind)}</span>
      <div className="activity-body">
        <div className="activity-kind">
          {ACTIVITY_LABEL[activity.kind]}
          {activity.tool ? ` / ${activity.tool}` : ''}
          {activity.file && activity.file !== activity.title ? ` / ${activity.file}` : ''}
        </div>
        <div className="activity-title">{activity.title}</div>
        {detail ? (
          detail.length <= 220 ? (
            <p className="activity-detail">{detail}</p>
          ) : (
            <details className="activity-detail">
              <summary>Details</summary>
              {detail}
            </details>
          )
        ) : null}
      </div>
    </li>
  )
}

function TodoRow({ todo }: { todo: TodoItem }) {
  const mark = todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '◆' : ''
  const className =
    todo.status === 'completed'
      ? 'todo done'
      : todo.status === 'in_progress'
        ? 'todo active'
        : 'todo'
  return (
    <div className={className}>
      <span className="todo-mark" aria-hidden="true">
        {mark}
      </span>
      <span>{todo.status === 'in_progress' ? todo.activeForm || todo.content : todo.content}</span>
    </div>
  )
}

function repoHref(remote: string | null): string | null {
  if (!remote) return null
  const ssh = remote.match(/^git@([^:]+):(.+?)(?:\.git)?$/)
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`
  if (remote.startsWith('http://') || remote.startsWith('https://')) {
    return remote.replace(/\.git$/, '')
  }
  return null
}

function sessionName(sessions: SessionSummary[], id: string): string {
  const session = sessions.find((candidate) => candidate.id === id)
  return session?.mission || session?.title || id.slice(0, 8)
}

export function SessionPage() {
  const { id = '' } = useParams()
  const { sessions, config, refresh, messageTick } = useLive()
  const { notify } = useToast()
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [missing, setMissing] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [taskExpanded, setTaskExpanded] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [claimPath, setClaimPath] = useState('')
  const [claimPending, setClaimPending] = useState(false)
  const [confirmRelease, setConfirmRelease] = useState(false)
  const [confirmStop, setConfirmStop] = useState(false)
  const [messageDraft, setMessageDraft] = useState('')
  const [sending, setSending] = useState(false)
  const tickRef = useRef(messageTick)

  const load = useCallback(async () => {
    try {
      const next = await api.session(id)
      setDetail(next)
      setMissing(false)
      setLoadError(null)
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 404) {
        setMissing(true)
      } else {
        setLoadError(cause instanceof Error ? cause.message : 'Could not load the session.')
      }
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    setDetail(null)
    setLoading(true)
    setMissing(false)
    setLoadError(null)
    setEditing(false)
    setTaskExpanded(false)
    setTitleDraft('')
    setClaimPath('')
    setMessageDraft('')
    void load()
  }, [load])

  useEffect(() => {
    if (missing) return
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, 5000)
    return () => window.clearInterval(timer)
  }, [load, missing])

  useEffect(() => {
    if (tickRef.current === messageTick) return
    tickRef.current = messageTick
    if (!missing) void load()
  }, [messageTick, missing, load])

  const liveSession = sessions.find((session) => session.id === id)
  const session = liveSession ?? detail?.session ?? null

  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value)
      notify(`${label} copied.`, 'success')
    } catch {
      notify(`Could not copy the ${label.toLowerCase()}.`, 'error')
    }
  }

  async function patch(next: SessionPatch, note: string) {
    try {
      await api.patchSession(id, next)
      notify(note, 'success')
      await refresh()
      await load()
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'Could not update the session.', 'error')
    }
  }

  async function saveTitle(event: FormEvent) {
    event.preventDefault()
    const trimmed = titleDraft.trim()
    setEditing(false)
    await patch({ title: trimmed || null }, trimmed ? 'Title saved.' : 'Title reset.')
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault()
    const body = messageDraft.trim()
    if (!body || sending || !session) return
    setSending(true)
    try {
      await api.sendMessage({ body, toSessionId: session.id, kind: 'note' })
      setMessageDraft('')
      notify('Message queued for this session.', 'success')
      await load()
      await refresh()
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'Could not send the message.', 'error')
    } finally {
      setSending(false)
    }
  }

  async function claimFile(event: FormEvent) {
    event.preventDefault()
    const value = claimPath.trim()
    if (!value || claimPending) return
    setClaimPending(true)
    try {
      const result = await api.claim(id, { paths: [value], ttlMinutes: 120 })
      if (result.conflicts.length > 0) {
        const names = [
          ...new Set(result.conflicts.map((claim) => sessionName(sessions, claim.sessionId))),
        ].join(', ')
        notify(`Claim recorded. ${names} also claimed this path.`, 'error')
      } else {
        notify('File claimed for two hours.', 'success')
      }
      setClaimPath('')
      await load()
      await refresh()
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'Could not claim the file.', 'error')
    } finally {
      setClaimPending(false)
    }
  }

  async function releaseClaims() {
    await api.releaseClaims(id)
    notify('File claims released.', 'success')
    await load()
    await refresh()
  }

  async function stopSession() {
    const result = await api.stop(id)
    if (!result.ok) throw new Error(result.error || 'The session could not be stopped.')
    notify('Stop signal sent to the background session.', 'success')
    await load()
    await refresh()
  }

  if (missing) {
    return (
      <div className="detail-missing">
        <Link className="back-link" to="/">
          <ArrowLeft size={12} aria-hidden="true" />
          Board
        </Link>
        <div className="empty">
          <h3>This session is not on the board.</h3>
          <p>
            The transcript may have been removed, or the daemon may have started with a different
            Claude directory.
          </p>
          <div className="empty-actions">
            <Link className="btn" to="/">
              Back to the board
            </Link>
          </div>
        </div>
      </div>
    )
  }

  if (!session) {
    return (
      <div className="detail-loading" aria-busy="true">
        <span className="skeleton" style={{ width: 92, height: 10 }} />
        <span className="skeleton" style={{ width: 'min(520px, 72%)', height: 34 }} />
        <span className="skeleton" style={{ width: 'min(640px, 88%)', height: 13 }} />
        <span className="skeleton" style={{ width: 'min(460px, 64%)', height: 13 }} />
      </div>
    )
  }

  const question = liveSession?.question ?? session.question
  const timeline = session.timeline
  const total30 = timeline.counts.slice(-30).reduce((sum, value) => sum + value, 0)
  const waitingMinutes = timeline.waiting.slice(-30).reduce((sum, value) => sum + value, 0)
  const activities = (detail?.activities ?? []).slice(-80).reverse()
  const messages = (detail?.messages ?? []).slice(-4).reverse()
  const claims = detail?.claims ?? []
  const todosDone = session.todos.filter((todo) => todo.status === 'completed').length
  const remote = repoHref(session.gitRemoteUrl)
  const repo = repoLabel(session)
  const sameProject =
    Boolean(session.project) && repo.toLowerCase() === session.project?.toLowerCase()
  const repoText = [sameProject ? null : repo, session.gitBranch].filter(Boolean).join(' / ')
  const terminal = session.tmux ? `tmux ${session.tmux}` : session.pid ? `pid ${session.pid}` : null
  const traceStart = timeline.end - 30 * timeline.bucketMs
  const readOnly = Boolean(config?.readOnly)
  const taskText = session.task || session.statusDetail
  const taskLong = taskText.length > 700
  const missionText = session.mission || session.title
  const taskRepeatsMission = repeatsMission(taskText, missionText)

  return (
    <>
      <Link className="back-link" to="/">
        <ArrowLeft size={12} aria-hidden="true" />
        Board
      </Link>

      <header className="detail-head">
        <div className="detail-title-row">
          <div className="detail-title-block">
            <div className="detail-kicker">
              <StatusBadge status={session.status} />
              {session.kind === 'background' ? <span className="chip">Background</span> : null}
              {session.archived ? <span className="chip chip-muted">Archived</span> : null}
              <span className="detail-status-text">{session.statusDetail}</span>
            </div>
            {editing ? (
              <form className="title-form" onSubmit={saveTitle}>
                <input
                  className="input detail-title-input"
                  value={titleDraft}
                  onChange={(event) => setTitleDraft(event.target.value)}
                  placeholder="Session title"
                  aria-label="Session title"
                  maxLength={160}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      setEditing(false)
                    }
                  }}
                />
                <div className="title-form-actions">
                  <button className="btn btn-sm btn-primary" type="submit">
                    Save
                  </button>
                  <button
                    className="btn btn-sm btn-ghost"
                    type="button"
                    onClick={() => setEditing(false)}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <h1>{missionText}</h1>
            )}
            <p className={taskLong && !taskExpanded ? 'detail-task is-clamped' : 'detail-task'}>
              {taskRepeatsMission ? null : <span className="detail-task-label">Latest prompt</span>}
              {taskText}
            </p>
            {taskLong ? (
              <button
                type="button"
                className="task-toggle"
                aria-expanded={taskExpanded}
                onClick={() => setTaskExpanded((value) => !value)}
              >
                {taskExpanded ? 'Show less' : 'Show full task'}
              </button>
            ) : null}
            <div className="detail-meta">
              {session.project ? (
                <span className="meta-item meta-project">
                  <Folder size={11} aria-hidden="true" />
                  {session.project}
                </span>
              ) : null}
              {repoText ? (
                <span className="meta-item">
                  <GitBranch size={11} aria-hidden="true" />
                  {remote && !sameProject ? (
                    <a href={remote} target="_blank" rel="noreferrer">
                      {repoText}
                    </a>
                  ) : (
                    repoText
                  )}
                </span>
              ) : null}
              {session.startedAt ? (
                <span className="meta-item">started {dateTime(session.startedAt)}</span>
              ) : null}
              <span className="meta-item">{formatModel(session.model)}</span>
              <span className="meta-item">{session.shortId}</span>
              {session.activity && session.status === 'working' ? (
                <span className="meta-item detail-live-activity">
                  {session.activity.tool ? `${session.activity.tool}: ` : ''}
                  {session.activity.text}
                </span>
              ) : null}
            </div>
          </div>

          <div className="detail-actions">
            {detail?.transcriptPath ? (
              <button
                type="button"
                className="icon-btn"
                title="Copy transcript path"
                aria-label="Copy transcript path"
                onClick={() => void copy(detail.transcriptPath ?? '', 'Transcript path')}
              >
                <Copy size={15} aria-hidden="true" />
              </button>
            ) : null}
            <button
              type="button"
              className={session.pinned ? 'icon-btn active' : 'icon-btn'}
              title={session.pinned ? 'Unpin session' : 'Pin session'}
              aria-label={session.pinned ? 'Unpin session' : 'Pin session'}
              onClick={() =>
                void patch(
                  { pinned: !session.pinned },
                  session.pinned ? 'Session unpinned.' : 'Session pinned.',
                )
              }
            >
              {session.pinned ? (
                <PinOff size={15} aria-hidden="true" />
              ) : (
                <Pin size={15} aria-hidden="true" />
              )}
            </button>
            <button
              type="button"
              className="icon-btn"
              title="Rename session"
              aria-label="Rename session"
              onClick={() => {
                setTitleDraft(session.titleSource === 'custom' ? session.title : missionText)
                setEditing(true)
              }}
            >
              <Pencil size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={session.archived ? 'icon-btn active' : 'icon-btn'}
              title={session.archived ? 'Restore to the board' : 'Archive session'}
              aria-label={session.archived ? 'Restore to the board' : 'Archive session'}
              onClick={() =>
                void patch(
                  { archived: !session.archived },
                  session.archived ? 'Session restored to the board.' : 'Session archived.',
                )
              }
            >
              {session.archived ? (
                <ArchiveRestore size={15} aria-hidden="true" />
              ) : (
                <Archive size={15} aria-hidden="true" />
              )}
            </button>
            {session.jobId ? (
              <button
                type="button"
                className="btn btn-sm btn-danger"
                onClick={() => setConfirmStop(true)}
              >
                <Square size={11} aria-hidden="true" />
                Stop
              </button>
            ) : null}
          </div>
        </div>
      </header>

      {loadError ? (
        <div className="banner banner-offline" role="status" style={{ marginTop: 24 }}>
          <AlertTriangle size={14} aria-hidden="true" />
          <span>
            <strong>Could not refresh this session.</strong> {loadError}
          </span>
        </div>
      ) : null}

      {question ? (
        <div className="detail-question">
          <QuestionCard question={question} />
        </div>
      ) : null}

      <div className="detail-grid">
        <div className="detail-main">
          <section className="panel trace-panel" aria-labelledby="signal-heading">
            <div className="panel-head">
              <h2 id="signal-heading">Signal, last 30 minutes</h2>
              <span className="count">
                {clockTime(traceStart)}–{clockTime(timeline.end)}
              </span>
            </div>
            <SignalTrace timeline={timeline} status={session.status} large />
            <div className="trace-legend">
              <span className="legend-item">
                <span className="legend-swatch" aria-hidden="true" />
                activity
              </span>
              <span className="legend-item">
                <span className="legend-swatch accent" aria-hidden="true" />
                waiting for input
              </span>
            </div>
            <div className="trace-stats">
              <div className="stat">
                <span className="stat-value">{total30}</span>
                <span className="stat-label">events, 30m</span>
              </div>
              <div className="stat">
                <span className="stat-value">{waitingMinutes}m</span>
                <span className="stat-label">waiting, 30m</span>
              </div>
              <div className="stat">
                <span className="stat-value">{compactNumber(session.tokens?.totalTokens)}</span>
                <span className="stat-label">tokens</span>
              </div>
              <div className="stat">
                <span className="stat-value">{formatCost(session.tokens?.costUsd)}</span>
                <span className="stat-label">est. cost</span>
              </div>
              <div className="stat">
                <span className="stat-value">
                  {session.tokens?.contextPct != null
                    ? `${Math.round(session.tokens.contextPct)}%`
                    : '—'}
                </span>
                <span className="stat-label">context</span>
              </div>
            </div>
          </section>

          <section className="panel" aria-labelledby="activity-heading" style={{ marginTop: 34 }}>
            <div className="panel-head">
              <h2 id="activity-heading">Activity</h2>
              <span className="count">
                {detail ? `${detail.activities.length} recorded` : 'loading'}
              </span>
            </div>
            {activities.length > 0 ? (
              <ol className="activity-list">
                {activities.map((activity) => (
                  <ActivityRow key={activity.id} activity={activity} />
                ))}
              </ol>
            ) : loading ? (
              <div className="detail-loading detail-loading-inline" aria-busy="true">
                <span className="skeleton" style={{ width: '78%', height: 12 }} />
                <span className="skeleton" style={{ width: '62%', height: 12 }} />
                <span className="skeleton" style={{ width: '70%', height: 12 }} />
              </div>
            ) : (
              <div className="empty empty-inline">
                <h3>No activity recorded yet.</h3>
                <p>
                  Prompts, tool calls and responses appear here as the session writes them to its
                  transcript.
                </p>
              </div>
            )}
          </section>
        </div>

        <aside className="detail-side">
          <section className="side-section">
            <h2>Details</h2>
            <dl className="facts">
              <Fact label="Session" mono>
                <button
                  type="button"
                  className="copy-line"
                  onClick={() => void copy(session.id, 'Session id')}
                  title="Copy full session id"
                >
                  <span>{session.id}</span>
                  <Copy size={10} aria-hidden="true" />
                </button>
              </Fact>
              <Fact label="Working dir" mono>
                <button
                  type="button"
                  className="copy-line"
                  onClick={() => void copy(session.projectPath, 'Project path')}
                  title="Copy project path"
                >
                  <span>{session.projectPath}</span>
                  <Copy size={10} aria-hidden="true" />
                </button>
              </Fact>
              {session.gitBranch ? (
                <Fact label="Branch" mono>
                  {session.gitBranch}
                </Fact>
              ) : null}
              <Fact label="Started">
                {session.startedAt ? (
                  <span title={dateTime(session.startedAt)}>{relativeTime(session.startedAt)}</span>
                ) : (
                  'unknown'
                )}
              </Fact>
              <Fact label="Last signal">
                <span title={dateTime(session.lastActivityAt)}>
                  {relativeTime(session.lastActivityAt)}
                </span>
              </Fact>
              <Fact label="Model">{formatModel(session.model)}</Fact>
              <Fact label="Version">{session.version ?? 'unknown'}</Fact>
              {terminal ? (
                <Fact label="Terminal" mono>
                  {terminal}
                </Fact>
              ) : null}
              <Fact label="Signal">{session.source}</Fact>
              {session.backgroundState ? <Fact label="Job">{session.backgroundState}</Fact> : null}
              {session.needs ? <Fact label="Needs">{session.needs}</Fact> : null}
              {detail?.transcriptPath ? (
                <Fact label="Transcript" mono>
                  <button
                    type="button"
                    className="copy-line"
                    onClick={() => void copy(detail.transcriptPath ?? '', 'Transcript path')}
                    title="Copy transcript path"
                  >
                    <span>{detail.transcriptPath}</span>
                    <Copy size={10} aria-hidden="true" />
                  </button>
                </Fact>
              ) : null}
            </dl>
          </section>

          {session.todos.length > 0 ? (
            <section className="side-section">
              <h2>
                Todos
                <span className="count">
                  {todosDone}/{session.todos.length}
                </span>
              </h2>
              <div className="todo-list">
                {session.todos.map((todo) => (
                  <TodoRow key={todo.content} todo={todo} />
                ))}
              </div>
            </section>
          ) : null}

          <section className="side-section">
            <h2>
              File claims
              <span className="count">
                {claims.length} active · {shortDuration(2 * 60 * 60 * 1000)} default
              </span>
            </h2>
            {claims.length === 0 ? (
              <p className="side-note">
                No files reserved. Claims warn other sessions before they edit the same path.
              </p>
            ) : (
              <div className="claim-list">
                {claims.map((claim) => (
                  <div className="claim" key={claim.id}>
                    {claim.paths.map((path) => (
                      <div className="claim-path" key={path}>
                        {path}
                      </div>
                    ))}
                    <div className="claim-meta">expires {relativeTime(claim.expiresAt)}</div>
                    {claim.note ? <div className="claim-note">{claim.note}</div> : null}
                  </div>
                ))}
              </div>
            )}
            {!readOnly ? (
              <>
                <form className="claim-form" onSubmit={claimFile}>
                  <input
                    className="input mono"
                    value={claimPath}
                    onChange={(event) => setClaimPath(event.target.value)}
                    placeholder="src/file.ts"
                    aria-label="File or directory to claim"
                  />
                  <button
                    className="btn btn-sm"
                    type="submit"
                    disabled={!claimPath.trim() || claimPending}
                  >
                    {claimPending ? 'Claiming…' : 'Claim'}
                  </button>
                </form>
                {claims.length > 0 ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost claim-release"
                    onClick={() => setConfirmRelease(true)}
                  >
                    Release all claims
                  </button>
                ) : null}
              </>
            ) : (
              <p className="side-note">Read-only mode. Claims cannot be changed from the board.</p>
            )}
          </section>

          <section className="side-section">
            <h2>
              Messages
              <span className="count">{detail?.messages.length ?? 0}</span>
            </h2>
            {messages.length > 0 ? (
              <div className="message-list">
                {messages.map((message) => (
                  <article
                    className={message.fromSessionId ? 'message' : 'message from-human'}
                    key={message.id}
                  >
                    <div className="message-head">
                      <span>{message.fromName}</span>
                      <span>{relativeTime(message.createdAt)}</span>
                    </div>
                    <div className="message-body">{message.body}</div>
                  </article>
                ))}
              </div>
            ) : (
              <p className="side-note">
                No messages yet. A message lands in the session's inbox; it sees it the next time it
                checks for peers.
              </p>
            )}
            {!readOnly ? (
              <form className="message-compose" onSubmit={sendMessage}>
                <textarea
                  className="textarea"
                  value={messageDraft}
                  onChange={(event) => setMessageDraft(event.target.value)}
                  placeholder={`Message ${missionText}`}
                  aria-label={`Message ${missionText}`}
                  maxLength={8000}
                />
                <div className="composer-foot">
                  <span className="composer-note">Queued for its next inbox check.</span>
                  <button
                    className="btn btn-sm"
                    type="submit"
                    disabled={!messageDraft.trim() || sending}
                  >
                    <Send size={11} aria-hidden="true" />
                    {sending ? 'Sending…' : 'Send'}
                  </button>
                </div>
              </form>
            ) : (
              <p className="side-note">Read-only mode. Messages cannot be sent.</p>
            )}
          </section>
        </aside>
      </div>

      {confirmRelease ? (
        <ConfirmDialog
          title="Release all file claims?"
          description="Other sessions will no longer see these files reserved by this session. The session itself can claim them again."
          confirmLabel="Release claims"
          onConfirm={releaseClaims}
          onClose={() => setConfirmRelease(false)}
        />
      ) : null}

      {confirmStop ? (
        <ConfirmDialog
          title={`Stop “${missionText}”?`}
          description="The background job receives a stop signal. Work in progress may be left unfinished."
          confirmLabel="Stop session"
          danger
          onConfirm={stopSession}
          onClose={() => setConfirmStop(false)}
        />
      ) : null}
    </>
  )
}
