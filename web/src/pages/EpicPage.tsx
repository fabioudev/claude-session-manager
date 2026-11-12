import type { DelegatedTask, EpicMessage, SessionSummary } from '@shared/types'
import {
  ArrowLeft,
  ArrowUpRight,
  Clock3,
  ExternalLink,
  GitBranch,
  LoaderCircle,
  Play,
  Send,
} from 'lucide-react'
import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api'
import { Markdown } from '../components/Markdown'
import { useToast } from '../components/Toast'
import { epicRollup, epicStatusLabel, epicTone } from '../lib/epics'
import { dayTime, relativeTime, sessionLabel } from '../lib/format'
import { useLive } from '../lib/live'

const EPIC_STATUS_LABEL: Record<string, string> = {
  active: 'Läuft',
  paused: 'Pausiert',
  blocked: 'Blockiert',
  done: 'Fertig',
  cancelled: 'Eingestellt',
}

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback
}

function authorLabel(
  message: EpicMessage,
  sessions: SessionSummary[],
  commanderSessionId: string | null,
): string {
  if (!message.authorSessionId) return message.kind === 'status' ? 'System' : 'Du'
  if (message.authorSessionId === commanderSessionId) return 'Commander'
  const session = sessions.find((item) => item.id === message.authorSessionId)
  return session ? sessionLabel(session) : 'Epic-Commander'
}

function TaskRow({ task, sessions }: { task: DelegatedTask; sessions: SessionSummary[] }) {
  const assignee = sessions.find((session) => session.id === task.assigneeSessionId)
  return (
    <li className="epic-task-row">
      <div className="epic-task-main">
        <span className={`task-state ${task.status}`}>{task.status.replace('_', ' ')}</span>
        <span className="epic-task-title">{task.title}</span>
        <span className="epic-task-meta">
          {assignee ? (
            <Link to={`/sessions/${encodeURIComponent(assignee.id)}`}>
              {sessionLabel(assignee)}
            </Link>
          ) : (
            'Niemand zugewiesen'
          )}
          <span className="epic-task-dot" aria-hidden="true">
            ·
          </span>
          <Clock3 size={12} aria-hidden="true" />
          {relativeTime(task.updatedAt)}
        </span>
      </div>
      {task.lastNote ? <p className="epic-task-note">{task.lastNote}</p> : null}
      <div className="epic-task-progress">
        <div className="epic-progress" aria-hidden="true">
          <span style={{ width: `${task.status === 'done' ? 100 : task.progress}%` }} />
        </div>
        <small>{task.status === 'done' ? 100 : task.progress}%</small>
      </div>
    </li>
  )
}

export function EpicPage() {
  const { id = '' } = useParams()
  const { sessions, commandCenter, config } = useLive()
  const { notify } = useToast()
  const [text, setText] = useState('')
  const [pending, setPending] = useState(false)
  const [starting, setStarting] = useState(false)
  const threadBody = useRef<HTMLDivElement>(null)
  const readOnly = Boolean(config?.readOnly)

  const epic = commandCenter.epics.find((item) => item.id === id) ?? null
  const rollup = useMemo(
    () => (epic ? epicRollup(epic, commandCenter.tasks, sessions) : null),
    [epic, commandCenter.tasks, sessions],
  )
  const messages = epic?.messages ?? []
  const messageKey = messages[messages.length - 1]?.id ?? null

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new message only
  useEffect(() => {
    const node = threadBody.current
    if (node) node.scrollTop = node.scrollHeight
  }, [messageKey])

  if (!epic || !rollup) {
    return (
      <div className="epics-page">
        <section className="epics-hero">
          <div>
            <Link className="epic-back" to="/epics">
              <ArrowLeft size={14} aria-hidden="true" /> Alle Epics
            </Link>
            <h1>Epic nicht gefunden</h1>
            <p>Dieses Epic existiert nicht mehr, oder der Link ist veraltet.</p>
          </div>
        </section>
      </div>
    )
  }

  const owner = rollup.owner
  const repoPaths = epic.repositories

  async function submit(event?: FormEvent) {
    event?.preventDefault()
    if (!epic || !text.trim() || pending || readOnly) return
    setPending(true)
    try {
      await api.postEpicMessage(epic.id, { body: text.trim() })
      setText('')
    } catch (cause) {
      notify(errorText(cause, 'Die Nachricht konnte nicht gesendet werden.'), 'error')
    } finally {
      setPending(false)
    }
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    void submit()
  }

  async function startCommander() {
    if (!epic || starting || readOnly) return
    setStarting(true)
    try {
      await api.spawnEpicCommander(epic.id)
      notify('Epic-Commander wird gestartet.', 'success')
    } catch (cause) {
      notify(errorText(cause, 'Der Epic-Commander konnte nicht gestartet werden.'), 'error')
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className="epics-page epic-detail">
      <section className="epic-header">
        <div className="epic-header-main">
          <Link className="epic-back" to="/epics">
            <ArrowLeft size={14} aria-hidden="true" /> Alle Epics
          </Link>
          <div className="epic-header-topline">
            <span className={`epic-status ${epicTone(rollup)}`}>
              {epic.status === 'active' ? epicStatusLabel(rollup) : EPIC_STATUS_LABEL[epic.status]}
            </span>
            <span className="epic-card-age">
              <Clock3 size={13} aria-hidden="true" />
              zuletzt {relativeTime(rollup.lastActivityAt)}
            </span>
          </div>
          <h1>{epic.title}</h1>
          <p className="epic-status-line">{epic.statusLine || 'Noch keine Statuszeile.'}</p>
          {epic.goal ? <p className="epic-goal">{epic.goal}</p> : null}
          <div className="epic-header-links">
            {repoPaths.length ? (
              repoPaths.map((repo) => (
                <span key={repo} className="epic-repo">
                  <GitBranch size={12} aria-hidden="true" />
                  {repo}
                </span>
              ))
            ) : (
              <span className="epic-repo">Kein Repo angegeben</span>
            )}
            {epic.previewUrl ? (
              <a
                className="epic-preview-link"
                href={epic.previewUrl}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink size={13} aria-hidden="true" />
                {epic.previewUrl.replace(/^https?:\/\//, '')}
              </a>
            ) : null}
          </div>
        </div>
        <div className="epic-header-side">
          <div className="epic-owner">
            <span>Epic-Commander</span>
            {owner ? (
              <Link to={`/sessions/${encodeURIComponent(owner.id)}`}>
                {sessionLabel(owner)}
                <ArrowUpRight size={13} aria-hidden="true" />
              </Link>
            ) : (
              <strong>nicht gestartet</strong>
            )}
            {!owner && !readOnly ? (
              <button
                className="btn btn-ghost epic-start"
                type="button"
                onClick={startCommander}
                disabled={starting}
              >
                {starting ? (
                  <LoaderCircle className="spin" size={14} aria-hidden="true" />
                ) : (
                  <Play size={14} aria-hidden="true" />
                )}
                Commander starten
              </button>
            ) : null}
          </div>
          <div className="epic-rollup">
            <div className="epic-rollup-figure">
              <strong>{rollup.progress}%</strong>
              <span>
                Ø Fortschritt · {rollup.done}/{rollup.total} fertig
              </span>
            </div>
            <div className="epic-progress" aria-hidden="true">
              <span style={{ width: `${rollup.progress}%` }} />
            </div>
            <ul className="epic-rollup-counts">
              <li>
                <span className="dot running" aria-hidden="true" />
                {rollup.counts.in_progress} laufen
              </li>
              <li>
                <span className="dot queued" aria-hidden="true" />
                {rollup.counts.queued} warten
              </li>
              <li>
                <span className="dot review" aria-hidden="true" />
                {rollup.counts.review} zur Abnahme
              </li>
              <li>
                <span className="dot blocked" aria-hidden="true" />
                {rollup.counts.blocked} blockiert
              </li>
            </ul>
          </div>
        </div>
      </section>

      <div className="epic-columns">
        <section className="epic-tasks" aria-labelledby="epic-tasks-title">
          <div className="command-section-head">
            <div>
              <h2 id="epic-tasks-title">Aufgaben</h2>
              <p>Alles, was der Epic-Commander aus diesem Ziel zerlegt hat.</p>
            </div>
            <span className="nav-count">{rollup.openTasks.length}</span>
          </div>
          {rollup.tasks.length ? (
            <ul className="epic-task-list">
              {rollup.tasks.map((task) => (
                <TaskRow key={task.id} task={task} sessions={sessions} />
              ))}
            </ul>
          ) : (
            <div className="epic-empty">
              Noch keine Aufgabe in diesem Epic. Der Epic-Commander legt sie an, sobald er arbeitet.
            </div>
          )}
        </section>

        <section className="epic-thread" aria-labelledby="epic-thread-title">
          <div className="command-section-head">
            <div>
              <h2 id="epic-thread-title">Thread</h2>
              <p>Fragen und Anmerkungen hier bleiben beim Epic — und werden dort beantwortet.</p>
            </div>
            {rollup.unanswered > 0 ? (
              <span className="attention-count">{rollup.unanswered}</span>
            ) : null}
          </div>
          <div className="epic-thread-body" ref={threadBody}>
            {messages.length ? (
              messages.map((message) => {
                const mine = !message.authorSessionId && message.kind !== 'status'
                const system = message.kind === 'status'
                return (
                  <article
                    key={message.id}
                    className={`epic-message${mine ? ' mine' : ''}${system ? ' system' : ''}`}
                  >
                    <header>
                      <strong>
                        {authorLabel(message, sessions, commandCenter.commanderSessionId)}
                      </strong>
                      <span>{dayTime(message.at)}</span>
                      {mine && !message.deliveredAt ? (
                        <span className="epic-message-state">noch nicht gelesen</span>
                      ) : null}
                    </header>
                    <Markdown text={message.body} />
                  </article>
                )
              })
            ) : (
              <div className="epic-empty">
                Noch nichts besprochen. Schreib hier, was du vom Epic willst — der Epic-Commander
                antwortet in diesem Thread.
              </div>
            )}
          </div>
          <form className="epic-composer" onSubmit={submit}>
            <label className="sr-only" htmlFor="epic-message">
              Nachricht an das Epic
            </label>
            <textarea
              id="epic-message"
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={keyDown}
              placeholder={
                owner
                  ? 'Frage oder Anmerkung an den Epic-Commander …'
                  : 'Frage oder Anmerkung — sie wird beim nächsten Prompt zugestellt …'
              }
              rows={3}
              maxLength={4_000}
              disabled={readOnly || pending}
            />
            <div className="epic-composer-foot">
              <span>
                {owner
                  ? `Antwortet im Thread · ${sessionLabel(owner)}`
                  : 'Noch kein Epic-Commander — die Nachricht wartet auf den Start.'}
              </span>
              <button
                className="btn btn-primary"
                type="submit"
                disabled={!text.trim() || readOnly || pending}
              >
                {pending ? (
                  <LoaderCircle className="spin" size={15} aria-hidden="true" />
                ) : (
                  <Send size={15} aria-hidden="true" />
                )}
                {pending ? 'Senden…' : 'Senden'}
              </button>
            </div>
          </form>
        </section>
      </div>
    </div>
  )
}
