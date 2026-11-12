import type {
  ActivityEvent,
  CommandCenterSnapshot,
  CommanderUpdate,
  CommanderUpdateKind,
  DecisionRequest,
  DelegatedTask,
  KnowledgeEntry,
  PublicConfig,
  SessionSummary,
} from '@shared/types'
import {
  ArrowUpRight,
  BookOpen,
  Boxes,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  Command,
  History,
  ListPlus,
  LoaderCircle,
  MessageCircle,
  Pin,
  Search,
  Send,
  X,
} from 'lucide-react'
import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { CommandTaskDialog } from '../components/CommandTaskDialog'
import { Markdown } from '../components/Markdown'
import { QuestionCard } from '../components/QuestionCard'
import { useToast } from '../components/Toast'
import {
  activeKnowledge,
  type CommanderReply,
  commanderFeed,
  commandStats,
  featureGroups,
  latestCommanderMessage,
  offlineAssignments,
  taskColumns,
  visibleQuestions,
} from '../lib/command'
import { relativeTime, sessionLabel } from '../lib/format'
import { useLive } from '../lib/live'

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback
}

function CommanderPanel({
  commandCenter,
  sessions,
  config,
  onOpenTask,
}: {
  commandCenter: CommandCenterSnapshot
  sessions: SessionSummary[]
  config: PublicConfig | null
  onOpenTask: (taskId: string) => void
}) {
  const { notify } = useToast()
  const [text, setText] = useState('')
  const [pending, setPending] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [clipped, setClipped] = useState(false)
  const [replies, setReplies] = useState<CommanderReply[]>([])
  const reportBody = useRef<HTMLDivElement>(null)
  const commanderSessionId = commandCenter.commanderSessionId
  const commander = sessions.find((session) => session.id === commanderSessionId)
  const latest = useMemo(
    () => latestCommanderMessage(commandCenter, replies),
    [commandCenter, replies],
  )
  const latestKey =
    latest === null ? null : latest.type === 'update' ? latest.update.id : latest.reply.id

  // The commander answers in its own chat far more often than it files a
  // report, and those answers were invisible here: the strip only knew about
  // report_status. Read its newest replies from the session detail as well.
  const commanderActivityAt = commander?.lastActivityAt ?? 0
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch when the session answers
  useEffect(() => {
    if (!commanderSessionId) {
      setReplies([])
      return
    }
    let cancelled = false
    api
      .session(commanderSessionId)
      .then((detail) => {
        if (cancelled) return
        setReplies(
          detail.activities
            .filter((activity) => activity.kind === 'response')
            .map((activity: ActivityEvent) => ({
              id: activity.id,
              at: activity.at,
              text: (activity.detail || activity.title || '').trim(),
            }))
            .filter((reply) => reply.text.length > 0)
            .slice(-40),
        )
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [commanderSessionId, commanderActivityAt])

  // A new message collapses back to the compact excerpt.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the message changes
  useEffect(() => {
    setExpanded(false)
  }, [latestKey])

  // Offer "Show complete" only when the excerpt actually hides text.
  // biome-ignore lint/correctness/useExhaustiveDependencies: measure the clamped node after it renders
  useEffect(() => {
    const node = reportBody.current
    if (!node || expanded) return
    setClipped(node.scrollHeight > node.clientHeight + 1)
  }, [latestKey, expanded])
  const latestUpdate = latest?.type === 'update' ? latest.update : null
  const latestReply = latest?.type === 'reply' ? latest.reply : null
  const commanderLive = Boolean(commander?.live && commander.status !== 'ended')
  const candidates = sessions.filter((session) => session.live && session.status !== 'ended')
  const commanderOffline =
    commander && !candidates.some((session) => session.id === commander.id) ? commander : null
  const readOnly = Boolean(config?.readOnly)
  // No commander yet, or the chosen one ended: the daemon starts/resumes one
  // with the next command, so the console is usable without a manual pick.
  const autoCommander = Boolean(config?.launchEnabled && !readOnly)
  const canCommand = commanderLive || autoCommander

  async function choose(sessionId: string) {
    if (readOnly) return
    try {
      await api.setCommander(sessionId || null)
      notify(sessionId ? 'Main session selected.' : 'Main session cleared.', 'success')
    } catch (cause) {
      notify(errorText(cause, 'The main session could not be changed.'), 'error')
    }
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault()
    if (!text.trim() || pending || readOnly || !canCommand) return
    setPending(true)
    try {
      const command = await api.command(text.trim())
      setText('')
      notify(
        command.result.mode === 'typed'
          ? 'Command delivered to your main session.'
          : 'Command queued for your main session.',
        'success',
      )
    } catch (cause) {
      notify(errorText(cause, 'The command could not be delivered.'), 'error')
    } finally {
      setPending(false)
    }
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter keeps the newline. Ignore the Enter that
    // confirms an IME composition, or every Japanese/Chinese input would send
    // the half-written command.
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    void submit()
  }

  return (
    <section className="command-deck" aria-labelledby="command-deck-title">
      <div className="command-console">
        <div className="command-console-head">
          <div>
            <h2 id="command-deck-title">Give the goal, not the busywork.</h2>
            <p>
              Your main session breaks it down, delegates it and brings results back for review.
            </p>
          </div>
          <Command size={25} strokeWidth={1.4} aria-hidden="true" />
        </div>
        <form onSubmit={submit}>
          <label className="sr-only" htmlFor="commander-command">
            Goal for the main session
          </label>
          <textarea
            id="commander-command"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={keyDown}
            placeholder="What should your sessions accomplish?"
            rows={5}
            maxLength={12_000}
            disabled={readOnly || pending}
          />
          <div className="command-console-foot">
            <span>
              {commanderLive
                ? 'Enter to send · Shift + Enter for a new line'
                : commanderOffline
                  ? autoCommander
                    ? 'Main session is offline — your next command resumes it automatically'
                    : 'Main session is offline — choose a live session'
                  : autoCommander
                    ? 'No main session yet — your first command starts one automatically'
                    : 'Select a main session to begin'}
            </span>
            <button
              className="btn btn-primary command-send"
              type="submit"
              disabled={!text.trim() || !canCommand || readOnly || pending}
            >
              {pending ? (
                <LoaderCircle className="spin" size={15} aria-hidden="true" />
              ) : (
                <Send size={15} aria-hidden="true" />
              )}
              {pending ? 'Delivering…' : 'Command sessions'}
            </button>
          </div>
        </form>

        <div
          className={`commander-latest${
            latestUpdate ? ` kind-${latestUpdate.kind}` : latestReply ? ' kind-reply' : ' empty'
          }`}
        >
          <div className="commander-latest-head">
            <span className="channel-kind">
              {latestUpdate ? UPDATE_LABEL[latestUpdate.kind] : latestReply ? 'Reply' : 'Channel'}
            </span>
            <span className="commander-latest-meta">
              {latestUpdate
                ? `${updateAuthorLabel(latestUpdate, sessions)} · ${relativeTime(latestUpdate.at)}`
                : latestReply
                  ? `${commander ? sessionLabel(commander) : 'Main session'} · ${relativeTime(latestReply.at)}`
                  : 'No reports yet'}
            </span>
            <div className="commander-latest-actions">
              {clipped ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setExpanded((value) => !value)}
                  aria-expanded={expanded}
                  aria-controls="commander-latest-body"
                >
                  {expanded ? 'Show less' : 'Show complete'}
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setShowHistory(true)}
              >
                <History size={13} aria-hidden="true" /> History
              </button>
            </div>
          </div>
          {latestUpdate ? (
            <>
              <h3 className="commander-latest-title">{latestUpdate.title}</h3>
              {latestUpdate.body ? (
                <div
                  id="commander-latest-body"
                  ref={reportBody}
                  className={`commander-latest-body${expanded ? ' expanded' : ''}`}
                >
                  <Markdown text={latestUpdate.body} />
                </div>
              ) : null}
            </>
          ) : latestReply ? (
            <div
              id="commander-latest-body"
              ref={reportBody}
              className={`commander-latest-body${expanded ? ' expanded' : ''}`}
            >
              <Markdown text={latestReply.text} />
            </div>
          ) : (
            <p className="commander-latest-empty">
              Your main session will answer here once you give it a goal.
            </p>
          )}
        </div>

        {showHistory ? (
          <CommanderHistoryDialog
            commandCenter={commandCenter}
            sessions={sessions}
            replies={replies}
            onOpenTask={onOpenTask}
            onClose={() => setShowHistory(false)}
          />
        ) : null}
      </div>

      <aside className="commander-card" aria-label="Main session">
        <div className="commander-orbit" aria-hidden="true">
          <Command size={24} strokeWidth={1.5} />
        </div>
        <div className="commander-card-copy">
          <span>Main session</span>
          <h3>{commander ? sessionLabel(commander) : 'Automatic commander'}</h3>
          <p>
            {commander
              ? `${commander.statusDetail} · ${commander.repoName || commander.projectName}`
              : autoCommander
                ? 'Starts automatically with your first command.'
                : 'One live session coordinates all the others.'}
          </p>
        </div>
        <label className="sr-only" htmlFor="commander-select">
          Main session
        </label>
        <select
          id="commander-select"
          className="select"
          value={commander?.id ?? ''}
          onChange={(event) => void choose(event.target.value)}
          disabled={readOnly}
        >
          <option value="">
            {autoCommander
              ? 'Automatic — start a commander when needed'
              : 'No main session selected'}
          </option>
          {commanderOffline ? (
            <option value={commanderOffline.id}>{sessionLabel(commanderOffline)} · offline</option>
          ) : null}
          {candidates.map((session) => (
            <option value={session.id} key={session.id}>
              {sessionLabel(session)} · {session.status}
            </option>
          ))}
        </select>
        <div className="commander-presence">
          <span
            className={`dot ${commander?.status === 'working' ? 'dot-working' : commander ? 'dot-live' : 'dot-idle'}`}
            aria-hidden="true"
          />
          <span>
            {commander
              ? commander.status
              : autoCommander
                ? 'auto-starts on first command'
                : 'waiting for selection'}
          </span>
          {commanderOffline ? (
            <span>
              offline — {autoCommander ? 'next command resumes it' : 'commands are paused'}
            </span>
          ) : null}
          <span>{candidates.length} live sessions available</span>
        </div>
      </aside>
    </section>
  )
}

const UPDATE_LABEL: Record<CommanderUpdateKind, string> = {
  status: 'Update',
  progress: 'Progress',
  blocked: 'Blocked',
  done: 'Done',
  question: 'Question',
  note: 'Note',
}

function projectName(projectPath: string | null): string {
  if (!projectPath) return 'Every project'
  const parts = projectPath.split('/').filter(Boolean)
  return parts[parts.length - 1] || projectPath
}

function updateAuthorLabel(update: CommanderUpdate, sessions: SessionSummary[]): string {
  if (update.authorSessionId === null) return 'Ledger'
  const author = sessions.find((session) => session.id === update.authorSessionId)
  return author ? sessionLabel(author) : 'Commander'
}

/**
 * The full conversation with the main session: human goals on the right, the
 * commander's reports on the left, ledger events in between. It lives behind
 * the History button so the composer stays a single, calm answer.
 */
function ChannelFeed({
  commandCenter,
  sessions,
  replies,
  onOpenTask,
}: {
  commandCenter: CommandCenterSnapshot
  sessions: SessionSummary[]
  replies: CommanderReply[]
  onOpenTask: (taskId: string) => void
}) {
  const feed = useMemo(() => commanderFeed(commandCenter, 60, replies), [commandCenter, replies])
  const feedRef = useRef<HTMLDivElement>(null)

  // Newest report at the bottom, the way a conversation reads. The scroll
  // target is a ref, so the feed length is the only proxy for "something new".
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-scroll when a report arrives
  useEffect(() => {
    const node = feedRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [feed.length])

  return (
    <section className="channel-feed" ref={feedRef} aria-label="Commander channel messages">
      {feed.length === 0 ? (
        <div className="channel-empty">
          <MessageCircle size={24} strokeWidth={1.3} aria-hidden="true" />
          <div>
            <strong>The channel is quiet.</strong>
            <p>
              Give your main session a goal in the composer. It delegates first and then reports
              back here — you can keep working on something else in the meantime.
            </p>
          </div>
        </div>
      ) : (
        feed.map((entry) =>
          entry.type === 'command' ? (
            <article className="channel-command" key={entry.id}>
              <div className="channel-bubble">
                <p>{entry.text}</p>
                <span>
                  You · {relativeTime(entry.at)} ·{' '}
                  {entry.ok ? (entry.mode === 'typed' ? 'delivered' : 'queued') : 'delivery failed'}
                </span>
              </div>
            </article>
          ) : entry.type === 'reply' ? (
            <article className="channel-update channel-reply" key={entry.id}>
              <header>
                <span className="channel-kind">Reply</span>
                <span>Main session · {relativeTime(entry.at)}</span>
              </header>
              <div className="channel-body">
                <Markdown text={entry.text} />
              </div>
            </article>
          ) : (
            <article
              className={`channel-update kind-${entry.update.kind}${entry.update.authorSessionId === null ? ' system' : ''}`}
              key={entry.id}
            >
              <header>
                <span className="channel-kind">{UPDATE_LABEL[entry.update.kind]}</span>
                <span>
                  {entry.update.authorSessionId === null
                    ? 'Ledger'
                    : (() => {
                        const author = sessions.find(
                          (session) => session.id === entry.update.authorSessionId,
                        )
                        return author ? sessionLabel(author) : 'Commander'
                      })()}{' '}
                  · {relativeTime(entry.at)}
                </span>
              </header>
              <h3>{entry.update.title}</h3>
              {entry.update.body ? (
                <div className="channel-body">
                  <Markdown text={entry.update.body} />
                </div>
              ) : null}
              {entry.update.projectPath || entry.update.taskIds.length ? (
                <div className="channel-refs">
                  {entry.update.projectPath ? (
                    <span>{projectName(entry.update.projectPath)}</span>
                  ) : null}
                  {entry.update.taskIds.map((taskId) => {
                    const task = commandCenter.tasks.find((candidate) => candidate.id === taskId)
                    return (
                      <button type="button" key={taskId} onClick={() => onOpenTask(taskId)}>
                        {task ? task.title : taskId}
                      </button>
                    )
                  })}
                </div>
              ) : null}
            </article>
          ),
        )
      )}
    </section>
  )
}

/**
 * The full channel in a modal: opened from the composer so the page itself
 * shows only the newest report.
 */
function CommanderHistoryDialog({
  commandCenter,
  sessions,
  replies,
  onOpenTask,
  onClose,
}: {
  commandCenter: CommandCenterSnapshot
  sessions: SessionSummary[]
  replies: CommanderReply[]
  onOpenTask: (taskId: string) => void
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
    // The feed scrolls itself on mount, but a closed <dialog> has no layout,
    // so that first scroll lands at 0 and the history opened at the oldest
    // message. Repeat it once the dialog is rendered, so the newest entry is
    // the one in view.
    const feed = dialog?.querySelector<HTMLElement>('.channel-feed')
    const frame = feed
      ? requestAnimationFrame(() => {
          feed.scrollTop = feed.scrollHeight
        })
      : 0
    return () => {
      if (frame) cancelAnimationFrame(frame)
      if (dialog?.open) dialog.close()
    }
  }, [])

  function close() {
    dialogRef.current?.close()
  }

  return (
    <dialog
      ref={dialogRef}
      className="sheet commander-history-sheet"
      aria-labelledby="commander-history-title"
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
      onClose={onClose}
    >
      <div className="sheet-head">
        <div>
          <div className="sheet-kicker">
            <span>Commander channel</span>
            <span>
              {commandCenter.updates.length}{' '}
              {commandCenter.updates.length === 1 ? 'report' : 'reports'}
            </span>
          </div>
          <h2 className="sheet-title" id="commander-history-title">
            Conversation with your main session
          </h2>
          <p className="sheet-sub">Every goal you sent and every report that came back.</p>
        </div>
        <button type="button" className="icon-btn" onClick={close} aria-label="Close history">
          <X size={17} aria-hidden="true" />
        </button>
      </div>
      <div className="commander-history-body">
        <ChannelFeed
          commandCenter={commandCenter}
          sessions={sessions}
          replies={replies}
          onOpenTask={onOpenTask}
        />
      </div>
    </dialog>
  )
}

/**
 * One card per project with open work: how many agents are running, how far
 * the work is, and what is waiting on a human. Answers "which features are
 * being worked on right now?" without opening a single task.
 */
function FeaturesInFlight({
  tasks,
  onOpenTask,
}: {
  tasks: DelegatedTask[]
  onOpenTask: (taskId: string) => void
}) {
  const groups = useMemo(() => featureGroups(tasks), [tasks])
  return (
    <section className="feature-overview" aria-labelledby="feature-overview-title">
      <div className="command-section-head">
        <div>
          <h2 id="feature-overview-title">
            <Boxes size={19} strokeWidth={1.6} aria-hidden="true" /> Features in flight
          </h2>
          <p>Every project with work in motion, and its declared state.</p>
        </div>
        <span className="channel-count">
          {groups.length} {groups.length === 1 ? 'project' : 'projects'}
        </span>
      </div>

      {groups.length === 0 ? (
        <div className="feature-empty">
          <Boxes size={22} strokeWidth={1.3} aria-hidden="true" />
          <div>
            <strong>Nothing in flight.</strong>
            <p>Open tasks appear here grouped by project as soon as work is delegated.</p>
          </div>
        </div>
      ) : (
        <div className="feature-grid">
          {groups.map((group) => (
            <article className="feature-card" key={group.key}>
              <header>
                <strong>{group.label}</strong>
                <span>{relativeTime(group.lastActivityAt)}</span>
              </header>
              <div
                className="feature-meter"
                role="progressbar"
                aria-label={`Progress for ${group.label}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={group.averageProgress}
              >
                <span style={{ width: `${group.averageProgress}%` }} />
              </div>
              <div className="feature-counts">
                {group.inProgress ? <span>{group.inProgress} running</span> : null}
                {group.review ? <span>{group.review} in review</span> : null}
                {group.blocked ? <span className="attention">{group.blocked} blocked</span> : null}
                {group.queued ? <span>{group.queued} queued</span> : null}
                <strong>{group.averageProgress}%</strong>
              </div>
              <ul>
                {group.tasks.slice(0, 4).map((task) => (
                  <li key={task.id}>
                    <button type="button" onClick={() => onOpenTask(task.id)}>
                      <span className={`feature-dot status-${task.status}`} aria-hidden="true" />
                      <span>{task.title}</span>
                      <small>{task.status === 'review' ? 100 : task.progress}%</small>
                    </button>
                  </li>
                ))}
              </ul>
              {group.tasks.length > 4 ? (
                <span className="feature-more">+{group.tasks.length - 4} more in the pipeline</span>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </section>
  )
}

function DecisionCard({
  decision,
  sessions,
  readOnly,
}: {
  decision: DecisionRequest
  sessions: SessionSummary[]
  readOnly: boolean
}) {
  const { notify } = useToast()
  const [answer, setAnswer] = useState('')
  const [pending, setPending] = useState(false)
  const session = sessions.find((candidate) => candidate.id === decision.requestedBySessionId)

  async function resolve(event: FormEvent) {
    event.preventDefault()
    if (!answer.trim() || pending || readOnly) return
    setPending(true)
    try {
      const resolved = await api.resolveDecision(decision.id, answer.trim())
      if (resolved.delivery?.ok) {
        notify('Answer delivered and the session can continue.', 'success')
      } else {
        notify(resolved.delivery?.error || 'Answer saved, but delivery needs attention.', 'error')
      }
      setAnswer('')
    } catch (cause) {
      notify(errorText(cause, 'The answer could not be saved.'), 'error')
    } finally {
      setPending(false)
    }
  }

  return (
    <article className="decision-card">
      <div className="decision-card-head">
        <CircleAlert size={17} aria-hidden="true" />
        <div>
          <span>{session ? sessionLabel(session) : decision.requestedBySessionId.slice(0, 8)}</span>
          <span>asked {relativeTime(decision.createdAt)}</span>
        </div>
      </div>
      {/* Sessions write these in Markdown — headings, lists, code, links. */}
      <Markdown text={decision.question} className="decision-question" />
      {decision.context ? <Markdown text={decision.context} className="decision-context" /> : null}
      <form onSubmit={resolve}>
        <label className="sr-only" htmlFor={`answer-${decision.id}`}>
          Answer to {decision.question}
        </label>
        <textarea
          id={`answer-${decision.id}`}
          className="textarea"
          rows={2}
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          placeholder={
            readOnly
              ? 'Read-only mode — answers are disabled.'
              : 'Your decision and any constraints…'
          }
          required
          disabled={readOnly}
        />
        <div className="decision-actions">
          {session ? (
            <Link to={`/sessions/${session.id}`}>
              Open session <ArrowUpRight size={12} aria-hidden="true" />
            </Link>
          ) : (
            <span />
          )}
          <button
            className="btn btn-accent"
            type="submit"
            disabled={!answer.trim() || pending || readOnly}
          >
            {pending ? 'Sending…' : 'Answer & continue'}
          </button>
        </div>
      </form>
    </article>
  )
}

function TaskCard({
  task,
  sessions,
  onOpen,
}: {
  task: DelegatedTask
  sessions: SessionSummary[]
  onOpen: () => void
}) {
  const assignee = sessions.find((session) => session.id === task.assigneeSessionId)
  return (
    <article className={`command-task-card priority-${task.priority}`}>
      <button type="button" onClick={onOpen} aria-label={`Open task ${task.title}`}>
        <div className="task-card-topline">
          <span className={`task-priority ${task.priority}`}>
            {task.priority === 'normal' ? 'Task' : task.priority}
          </span>
          <span>{relativeTime(task.updatedAt)}</span>
        </div>
        <h3>{task.title}</h3>
        <p className="task-card-brief">{task.brief}</p>
        {task.lastNote ? <p className="task-card-note">{task.lastNote}</p> : null}
        <div className="task-meter-label">
          <span>{assignee ? sessionLabel(assignee) : 'Unassigned'}</span>
          <strong>{task.progress}%</strong>
        </div>
        <div
          className="task-meter"
          role="progressbar"
          aria-label={`Progress for ${task.title}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={task.progress}
        >
          <span style={{ width: `${task.progress}%` }} />
        </div>
        <div className="task-card-footer">
          <span>
            {task.lastDispatch && !task.lastDispatch.ok
              ? 'Delivery failed'
              : task.lastDispatch?.mode === 'queued' && task.status === 'queued'
                ? 'In inbox'
                : task.status.replace('_', ' ')}
          </span>
          <ChevronRight size={14} aria-hidden="true" />
        </div>
      </button>
    </article>
  )
}

function NewTaskForm({ sessions, onDone }: { sessions: SessionSummary[]; onDone: () => void }) {
  const { notify } = useToast()
  const [title, setTitle] = useState('')
  const [brief, setBrief] = useState('')
  const [assignee, setAssignee] = useState('')
  const [priority, setPriority] = useState<'low' | 'normal' | 'high' | 'urgent'>('normal')
  const [pending, setPending] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (pending) return
    setPending(true)
    try {
      const task = await api.createTask({
        title: title.trim(),
        brief: brief.trim(),
        priority,
        assigneeSessionId: assignee || null,
      })
      if (task.lastDispatch && !task.lastDispatch.ok) {
        notify(
          task.lastDispatch.error || 'Task created, but delivery failed; it is blocked.',
          'error',
        )
      } else {
        notify(
          task.lastDispatch?.mode === 'typed'
            ? 'Task created and delivered.'
            : task.assigneeSessionId
              ? 'Task created and queued in the session inbox.'
              : 'Task added to the queue.',
          'success',
        )
      }
      onDone()
    } catch (cause) {
      notify(errorText(cause, 'The task could not be created.'), 'error')
    } finally {
      setPending(false)
    }
  }

  return (
    <form className="new-task-form" onSubmit={submit}>
      <div className="command-form-grid">
        <div className="field span-2">
          <label htmlFor="new-task-title">Task title</label>
          <input
            id="new-task-title"
            className="input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="A clear outcome"
            maxLength={180}
            required
          />
        </div>
        <div className="field span-2">
          <label htmlFor="new-task-brief">Brief and acceptance criteria</label>
          <textarea
            id="new-task-brief"
            className="textarea"
            rows={4}
            value={brief}
            onChange={(event) => setBrief(event.target.value)}
            placeholder="Context, constraints and what done means…"
            required
          />
        </div>
        <div className="field">
          <label htmlFor="new-task-assignee">Session</label>
          <select
            id="new-task-assignee"
            className="select"
            value={assignee}
            onChange={(event) => setAssignee(event.target.value)}
          >
            <option value="">Assign later</option>
            {sessions
              .filter((session) => session.live && session.status !== 'ended')
              .map((session) => (
                <option value={session.id} key={session.id}>
                  {sessionLabel(session)} · {session.status}
                </option>
              ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="new-task-priority">Priority</label>
          <select
            id="new-task-priority"
            className="select"
            value={priority}
            onChange={(event) => setPriority(event.target.value as typeof priority)}
          >
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </select>
        </div>
      </div>
      <div className="inline-form-actions">
        <button type="button" className="btn btn-ghost" onClick={onDone}>
          Cancel
        </button>
        <button
          className="btn btn-primary"
          type="submit"
          disabled={pending || !title.trim() || !brief.trim()}
        >
          {pending ? 'Creating…' : 'Create task'}
        </button>
      </div>
    </form>
  )
}

function KnowledgeComposer({
  sessions,
  onDone,
}: {
  sessions: SessionSummary[]
  onDone: () => void
}) {
  const { notify } = useToast()
  const projects = [
    ...new Set(sessions.map((session) => session.repoRoot || session.projectPath).filter(Boolean)),
  ] as string[]
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [tags, setTags] = useState('')
  const [projectPath, setProjectPath] = useState('')
  const [always, setAlways] = useState(true)
  const [pending, setPending] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (pending) return
    setPending(true)
    try {
      await api.shareKnowledge({
        title: title.trim(),
        body: body.trim(),
        tags: tags
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
        projectPath: projectPath || null,
        always,
      })
      notify('Knowledge shared with the relevant sessions.', 'success')
      onDone()
    } catch (cause) {
      notify(errorText(cause, 'Knowledge could not be saved.'), 'error')
    } finally {
      setPending(false)
    }
  }

  return (
    <form className="knowledge-composer" onSubmit={submit}>
      <div className="command-form-grid">
        <div className="field span-2">
          <label htmlFor="knowledge-title">Title</label>
          <input
            id="knowledge-title"
            className="input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="What should every relevant session know?"
            required
          />
        </div>
        <div className="field span-2">
          <label htmlFor="knowledge-body">Knowledge</label>
          <textarea
            id="knowledge-body"
            className="textarea"
            rows={4}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="A durable decision, convention, constraint or hard-won fact. Never store credentials."
            required
          />
        </div>
        <div className="field">
          <label htmlFor="knowledge-project">Scope</label>
          <select
            id="knowledge-project"
            className="select"
            value={projectPath}
            onChange={(event) => setProjectPath(event.target.value)}
          >
            <option value="">Every project</option>
            {projects.map((project) => (
              <option value={project} key={project}>
                {project}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="knowledge-tags">Tags</label>
          <input
            id="knowledge-tags"
            className="input"
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            placeholder="release, backend, conventions"
          />
        </div>
        <label className="knowledge-pin span-2">
          <input
            type="checkbox"
            checked={always}
            onChange={(event) => setAlways(event.target.checked)}
          />
          <Pin size={14} aria-hidden="true" />
          <span>
            <strong>Pin into every prompt</strong>
            <small>Unpinned knowledge is available at session start and through search.</small>
          </span>
        </label>
      </div>
      <div className="inline-form-actions">
        <button type="button" className="btn btn-ghost" onClick={onDone}>
          Cancel
        </button>
        <button
          className="btn btn-primary"
          type="submit"
          disabled={pending || !title.trim() || !body.trim()}
        >
          {pending ? 'Sharing…' : 'Share knowledge'}
        </button>
      </div>
    </form>
  )
}

function KnowledgeCard({ entry, readOnly }: { entry: KnowledgeEntry; readOnly: boolean }) {
  const { notify } = useToast()
  async function archive() {
    try {
      await api.updateKnowledge(entry.id, { archived: true, expectedRevision: entry.revision })
      notify('Knowledge archived. Future prompts will not include it.', 'success')
    } catch (cause) {
      notify(errorText(cause, 'Knowledge could not be archived.'), 'error')
    }
  }
  return (
    <details className="knowledge-entry">
      <summary>
        <span className="knowledge-entry-icon">
          <BookOpen size={16} aria-hidden="true" />
        </span>
        <span className="knowledge-entry-heading">
          <strong>{entry.title}</strong>
          <small>
            {entry.projectPath || 'Every project'} · {relativeTime(entry.updatedAt)}
          </small>
        </span>
        {entry.always ? (
          <span className="knowledge-pinned">
            <Pin size={11} aria-hidden="true" /> Pinned
          </span>
        ) : null}
        <ChevronRight className="knowledge-chevron" size={15} aria-hidden="true" />
      </summary>
      <div className="knowledge-entry-body">
        <Markdown text={entry.body} />
        <div className="knowledge-entry-foot">
          <span>{entry.tags.join(' · ')}</span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void archive()}
            disabled={readOnly}
          >
            Archive
          </button>
        </div>
      </div>
    </details>
  )
}

export function CommandPage() {
  const { sessions, questions, commandCenter, config } = useLive()
  const [showTaskForm, setShowTaskForm] = useState(false)
  const [showKnowledgeForm, setShowKnowledgeForm] = useState(false)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [showDone, setShowDone] = useState(true)
  const [knowledgeQuery, setKnowledgeQuery] = useState('')
  const stats = useMemo(() => commandStats(commandCenter), [commandCenter])
  const columns = useMemo(
    () => taskColumns(commandCenter.tasks, showDone),
    [commandCenter.tasks, showDone],
  )
  const openDecisions = commandCenter.decisions.filter((decision) => !decision.resolvedAt)
  const offline = offlineAssignments(commandCenter.tasks, sessions)
  const knowledge = activeKnowledge(commandCenter, knowledgeQuery)
  const selectedTask = commandCenter.tasks.find((task) => task.id === selectedTaskId) ?? null
  const openQuestions = visibleQuestions(questions, sessions)
  const needsCount = openDecisions.length + openQuestions.length + offline.length
  const activeTasks = commandCenter.tasks.filter(
    (task) => task.status !== 'done' && task.status !== 'cancelled',
  )

  return (
    <div className="command-page">
      <section className="command-hero">
        <div>
          <h1>Your sessions, under one command.</h1>
          <p>Set the direction. Watch the work. Step in only where your judgment matters.</p>
        </div>
        <div className="command-hero-figure">
          <strong>{stats.active}</strong>
          <span>active {stats.active === 1 ? 'task' : 'tasks'}</span>
          <div className="hero-progress" aria-hidden="true">
            <span style={{ width: `${stats.averageProgress}%` }} />
          </div>
          <small>{stats.averageProgress}% average declared progress</small>
        </div>
      </section>

      <CommanderPanel
        commandCenter={commandCenter}
        sessions={sessions}
        config={config}
        onOpenTask={setSelectedTaskId}
      />

      <section className="command-stats" aria-label="Command center summary">
        <div>
          <span>In motion</span>
          <strong>{stats.inProgress}</strong>
          <small>workers reported in</small>
        </div>
        <div>
          <span>Waiting for review</span>
          <strong>{stats.review}</strong>
          <small>results to verify</small>
        </div>
        <div className={needsCount ? 'attention' : ''}>
          <span>Needs you</span>
          <strong>{needsCount}</strong>
          <small>{openDecisions.length} durable decisions</small>
        </div>
        <div>
          <span>Completed today</span>
          <strong>{stats.doneToday}</strong>
          <small>verified outcomes</small>
        </div>
      </section>

      <FeaturesInFlight tasks={commandCenter.tasks} onOpenTask={setSelectedTaskId} />

      <section className="command-needs" aria-labelledby="command-needs-title">
        <div className="command-section-head">
          <div>
            <h2 id="command-needs-title">Needs you</h2>
            <p>Decisions and delivery problems, collected in one place.</p>
          </div>
          {needsCount ? (
            <span className="attention-count">{needsCount}</span>
          ) : (
            <Check size={18} aria-hidden="true" />
          )}
        </div>
        {needsCount === 0 ? (
          <div className="needs-clear">
            <span className="needs-clear-mark">
              <Check size={17} aria-hidden="true" />
            </span>
            <div>
              <strong>Nothing is waiting on you.</strong>
              <p>Your sessions can keep moving without a decision right now.</p>
            </div>
          </div>
        ) : (
          <div className="needs-grid">
            {openDecisions.map((decision) => (
              <DecisionCard
                key={decision.id}
                decision={decision}
                sessions={sessions}
                readOnly={Boolean(config?.readOnly)}
              />
            ))}
            {openQuestions.map((question) => (
              <QuestionCard key={question.id} question={question} />
            ))}
            {offline.map((task) => {
              const session = sessions.find((candidate) => candidate.id === task.assigneeSessionId)
              return (
                <article className="offline-task" key={task.id}>
                  <Clock3 size={17} aria-hidden="true" />
                  <div>
                    <h3>{task.title}</h3>
                    <p>
                      {session ? sessionLabel(session) : 'The assigned session'} is not running.
                      Resume it or assign someone else.
                    </p>
                  </div>
                  <button className="btn" type="button" onClick={() => setSelectedTaskId(task.id)}>
                    Reassign
                  </button>
                </article>
              )
            })}
          </div>
        )}
      </section>

      <section className="command-work" aria-labelledby="command-work-title">
        <div className="command-section-head">
          <div>
            <h2 id="command-work-title">Work in motion</h2>
            <p>{activeTasks.length} open tasks · explicit updates from every worker</p>
          </div>
          <div className="section-actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setShowDone((value) => !value)}
            >
              {showDone ? 'Hide done' : 'Show done'}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setShowTaskForm((value) => !value)}
              disabled={config?.readOnly}
            >
              <ListPlus size={14} aria-hidden="true" /> Add task
            </button>
          </div>
        </div>
        {showTaskForm ? (
          <NewTaskForm sessions={sessions} onDone={() => setShowTaskForm(false)} />
        ) : null}
        {commandCenter.tasks.length === 0 && !showTaskForm ? (
          <div className="command-empty">
            <Command size={28} strokeWidth={1.3} aria-hidden="true" />
            <h3>No delegated work yet.</h3>
            <p>Give your main session a goal above, or create a task directly.</p>
            <button
              className="btn"
              type="button"
              onClick={() => setShowTaskForm(true)}
              disabled={config?.readOnly}
            >
              Create the first task
            </button>
          </div>
        ) : (
          <div className={`task-pipeline ${showDone ? '' : 'without-done'}`}>
            {columns.map((column) => (
              <section
                className={`task-column task-column-${column.status}`}
                key={column.status}
                aria-label={`${column.label}: ${column.tasks.length} tasks`}
              >
                <div className="task-column-head">
                  <div>
                    <h3>{column.label}</h3>
                    <p>{column.description}</p>
                  </div>
                  <span>{column.tasks.length}</span>
                </div>
                <div className="task-column-list">
                  {column.tasks.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      sessions={sessions}
                      onOpen={() => setSelectedTaskId(task.id)}
                    />
                  ))}
                  {column.tasks.length === 0 ? (
                    <div className="task-column-empty">No tasks here</div>
                  ) : null}
                </div>
              </section>
            ))}
          </div>
        )}
      </section>

      <section className="command-knowledge" aria-labelledby="command-knowledge-title">
        <div className="command-section-head">
          <div>
            <h2 id="command-knowledge-title">Shared knowledge</h2>
            <p>Durable decisions and conventions, scoped to the sessions that need them.</p>
          </div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setShowKnowledgeForm((value) => !value)}
            disabled={config?.readOnly}
          >
            <BookOpen size={14} aria-hidden="true" /> Add knowledge
          </button>
        </div>
        {showKnowledgeForm ? (
          <KnowledgeComposer sessions={sessions} onDone={() => setShowKnowledgeForm(false)} />
        ) : null}
        <div className="knowledge-toolbar">
          <Search size={15} aria-hidden="true" />
          <label className="sr-only" htmlFor="knowledge-search">
            Search shared knowledge
          </label>
          <input
            id="knowledge-search"
            value={knowledgeQuery}
            onChange={(event) => setKnowledgeQuery(event.target.value)}
            placeholder="Search decisions, conventions and project notes…"
          />
          {knowledgeQuery ? (
            <button
              type="button"
              className="icon-btn"
              onClick={() => setKnowledgeQuery('')}
              aria-label="Clear knowledge search"
            >
              <X size={14} aria-hidden="true" />
            </button>
          ) : (
            <span>{knowledge.length} entries</span>
          )}
        </div>
        <div className="knowledge-list">
          {knowledge.map((entry) => (
            <KnowledgeCard key={entry.id} entry={entry} readOnly={Boolean(config?.readOnly)} />
          ))}
          {!knowledge.length ? (
            <div className="knowledge-empty">
              <BookOpen size={22} strokeWidth={1.4} aria-hidden="true" />
              <div>
                <strong>
                  {knowledgeQuery
                    ? 'No knowledge matches this search.'
                    : 'No shared knowledge yet.'}
                </strong>
                <p>
                  {knowledgeQuery
                    ? 'Try a broader term or clear the search.'
                    : 'Add the decisions and conventions your sessions should not have to rediscover.'}
                </p>
              </div>
            </div>
          ) : null}
        </div>
      </section>

      {selectedTask ? (
        <CommandTaskDialog
          key={selectedTask.id}
          task={selectedTask}
          sessions={sessions}
          readOnly={Boolean(config?.readOnly)}
          onClose={() => setSelectedTaskId(null)}
        />
      ) : null}
    </div>
  )
}
