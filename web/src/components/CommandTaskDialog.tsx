import type {
  DelegatedTask,
  DelegatedTaskPatch,
  DelegatedTaskPriority,
  DelegatedTaskStatus,
  SessionSummary,
} from '@shared/types'
import { ExternalLink, RefreshCw, X } from 'lucide-react'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { dayTime, relativeTime, sessionLabel } from '../lib/format'
import { useToast } from './Toast'

const STATUS_OPTIONS: Array<{ value: DelegatedTaskStatus; label: string }> = [
  { value: 'queued', label: 'Queue' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'review', label: 'Review' },
  { value: 'done', label: 'Done' },
  { value: 'cancelled', label: 'Cancelled' },
]

interface CommandTaskDialogProps {
  task: DelegatedTask
  sessions: SessionSummary[]
  readOnly: boolean
  onClose: () => void
}

export function CommandTaskDialog({ task, sessions, readOnly, onClose }: CommandTaskDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const { notify } = useToast()
  const [status, setStatus] = useState(task.status)
  const [priority, setPriority] = useState<DelegatedTaskPriority>(task.priority)
  const [progress, setProgress] = useState(task.progress)
  const [assignee, setAssignee] = useState(task.assigneeSessionId ?? '')
  const [note, setNote] = useState('')
  const [result, setResult] = useState(task.result ?? '')
  const [pending, setPending] = useState<'save' | 'dispatch' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const previousTask = useRef(task)

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
    return () => {
      if (dialog?.open) dialog.close()
    }
  }, [])

  // Live worker reports update untouched fields, but never erase an edit the
  // human has not saved yet.
  useEffect(() => {
    const previous = previousTask.current
    setStatus((current) => (current === previous.status ? task.status : current))
    setPriority((current) => (current === previous.priority ? task.priority : current))
    setProgress((current) => (current === previous.progress ? task.progress : current))
    setAssignee((current) =>
      current === (previous.assigneeSessionId ?? '') ? (task.assigneeSessionId ?? '') : current,
    )
    setResult((current) => (current === (previous.result ?? '') ? (task.result ?? '') : current))
    previousTask.current = task
  }, [task])

  function close() {
    dialogRef.current?.close()
    onClose()
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (pending || readOnly) return
    const patch: DelegatedTaskPatch = { expectedRevision: task.revision }
    if (status !== task.status) patch.status = status
    if (priority !== task.priority) patch.priority = priority
    if (progress !== task.progress) patch.progress = progress
    if (assignee !== (task.assigneeSessionId ?? '')) patch.assigneeSessionId = assignee || null
    if (note.trim()) patch.note = note.trim()
    if (result.trim() && result.trim() !== (task.result ?? '')) patch.result = result.trim()
    if (Object.keys(patch).length === 1) {
      notify('No changes to save.', 'neutral')
      return
    }
    setPending('save')
    setError(null)
    try {
      const updated = await api.updateTask(task.id, patch)
      setNote('')
      notify(`Task updated · revision ${updated.revision}.`, 'success')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The task could not be updated.')
    } finally {
      setPending(null)
    }
  }

  async function dispatch() {
    if (pending || readOnly) return
    setPending('dispatch')
    setError(null)
    try {
      const updated = await api.dispatchTask(task.id)
      const delivery = updated.lastDispatch
      if (!delivery?.ok) {
        notify(delivery?.error || 'Delivery failed; the task is blocked.', 'error')
      } else {
        notify(
          delivery.mode === 'typed'
            ? 'Task delivered to the live session.'
            : 'Task queued in the session inbox.',
          'success',
        )
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The task could not be dispatched.')
    } finally {
      setPending(null)
    }
  }

  const assignedSession = sessions.find((session) => session.id === task.assigneeSessionId)
  const assignableSessions = sessions.filter(
    (session) => session.live && session.status !== 'ended',
  )
  const offlineAssignee =
    assignedSession && !assignableSessions.some((session) => session.id === assignedSession.id)
      ? assignedSession
      : null
  const missingAssignee = !assignedSession ? task.assigneeSessionId : null
  const closed = task.status === 'done' || task.status === 'cancelled'

  return (
    <dialog
      ref={dialogRef}
      className="sheet command-task-sheet"
      aria-labelledby="command-task-title"
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
    >
      <div className="sheet-head">
        <div>
          <div className="sheet-kicker">
            <span>{task.id}</span>
            <span>revision {task.revision}</span>
          </div>
          <h2 className="sheet-title" id="command-task-title">
            {task.title}
          </h2>
          <p className="sheet-sub">
            Updated {relativeTime(task.updatedAt)} · created {dayTime(task.createdAt)}
          </p>
        </div>
        <button type="button" className="icon-btn" onClick={close} aria-label="Close task">
          <X size={17} aria-hidden="true" />
        </button>
      </div>
      <form className="sheet-form" onSubmit={save}>
        <div className="sheet-body">
          <section className="task-brief">
            <h3>Brief</h3>
            <p>{task.brief}</p>
          </section>

          <div className="command-form-grid">
            <div className="field">
              <label htmlFor="task-status">Status</label>
              <select
                id="task-status"
                className="select"
                value={status}
                onChange={(event) => setStatus(event.target.value as DelegatedTaskStatus)}
                disabled={readOnly || pending !== null}
              >
                {STATUS_OPTIONS.map((option) => (
                  <option value={option.value} key={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="task-priority">Priority</label>
              <select
                id="task-priority"
                className="select"
                value={priority}
                onChange={(event) => setPriority(event.target.value as DelegatedTaskPriority)}
                disabled={readOnly || pending !== null}
              >
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
            <div className="field span-2">
              <label htmlFor="task-assignee">Assigned session</label>
              <select
                id="task-assignee"
                className="select"
                value={assignee}
                onChange={(event) => setAssignee(event.target.value)}
                disabled={readOnly || pending !== null}
              >
                <option value="">Unassigned</option>
                {offlineAssignee ? (
                  <option value={offlineAssignee.id}>
                    {sessionLabel(offlineAssignee)} · offline
                  </option>
                ) : null}
                {missingAssignee ? (
                  <option value={missingAssignee}>{missingAssignee.slice(0, 8)} · offline</option>
                ) : null}
                {assignableSessions.map((session) => (
                  <option value={session.id} key={session.id}>
                    {sessionLabel(session)} · {session.status}
                  </option>
                ))}
              </select>
              {assignedSession ? (
                <p className="field-hint">
                  <Link to={`/sessions/${assignedSession.id}`}>
                    Open {sessionLabel(assignedSession)}{' '}
                    <ExternalLink size={11} aria-hidden="true" />
                  </Link>
                </p>
              ) : null}
            </div>
            <div className="field span-2">
              <label htmlFor="task-progress">Declared progress · {progress}%</label>
              <input
                id="task-progress"
                className="task-progress-input"
                type="range"
                min="0"
                max="100"
                step="5"
                value={progress}
                onChange={(event) => setProgress(Number(event.target.value))}
                disabled={readOnly || pending !== null}
              />
            </div>
            <div className="field span-2">
              <label htmlFor="task-note">Add a progress note</label>
              <textarea
                id="task-note"
                className="textarea"
                rows={2}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="What changed, what is next, or what is blocking this task?"
                disabled={readOnly || pending !== null}
              />
            </div>
            <div className="field span-2">
              <label htmlFor="task-result">Result for review</label>
              <textarea
                id="task-result"
                className="textarea"
                rows={3}
                value={result}
                onChange={(event) => setResult(event.target.value)}
                placeholder="Outcome, verification and anything the commander should check."
                disabled={readOnly || pending !== null}
              />
            </div>
          </div>

          {task.lastDispatch ? (
            <p className={`delivery-note ${task.lastDispatch.ok ? '' : 'failed'}`}>
              Last delivery: {task.lastDispatch.mode} ·{' '}
              {task.lastDispatch.error || task.lastDispatch.note || 'sent to the session'}
            </p>
          ) : null}
          {error ? <p className="form-error question-error">{error}</p> : null}

          <section className="task-history">
            <h3>History</h3>
            {task.activities.length ? (
              <ol>
                {[...task.activities].reverse().map((activity) => (
                  <li key={activity.id}>
                    <span className="task-history-dot" aria-hidden="true" />
                    <div>
                      <p>{activity.text}</p>
                      <span>{dayTime(activity.at)}</span>
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="field-hint">No task activity yet.</p>
            )}
          </section>
        </div>
        <div className="sheet-foot">
          <span className="sheet-foot-note grow">
            Progress is reported explicitly, never guessed.
          </span>
          <button
            type="button"
            className="btn"
            onClick={() => void dispatch()}
            disabled={readOnly || pending !== null || !assignee || closed}
          >
            <RefreshCw size={13} aria-hidden="true" />
            {pending === 'dispatch' ? 'Delivering…' : 'Deliver again'}
          </button>
          <button className="btn btn-primary" type="submit" disabled={readOnly || pending !== null}>
            {pending === 'save' ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
