import { X } from 'lucide-react'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useLive } from '../lib/live'
import { useToast } from './Toast'

interface LaunchDialogProps {
  onClose: () => void
  defaultCwd?: string
}

export function LaunchDialog({ onClose, defaultCwd = '' }: LaunchDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const { refresh } = useLive()
  const { notify } = useToast()
  const [cwd, setCwd] = useState(defaultCwd)
  const [prompt, setPrompt] = useState('')
  const [name, setName] = useState('')
  const [model, setModel] = useState('')
  const [permissionMode, setPermissionMode] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
    return () => {
      if (dialog?.open) dialog.close()
    }
  }, [])

  function close() {
    const dialog = dialogRef.current
    if (dialog?.open) dialog.close()
    onClose()
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (pending || !prompt.trim()) return
    setPending(true)
    setError(null)
    try {
      const result = await api.launch({
        cwd: cwd.trim(),
        prompt: prompt.trim(),
        name: name.trim() || undefined,
        model: model || undefined,
        permissionMode: permissionMode || undefined,
      })
      if (!result.ok) {
        setError(result.error || 'The session could not be started.')
        setPending(false)
        return
      }
      notify(
        result.jobId
          ? `Background session started (${result.jobId.slice(0, 8)}).`
          : 'Background session started.',
        'success',
      )
      void refresh()
      close()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The session could not be started.')
      setPending(false)
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="sheet"
      aria-labelledby="launch-title"
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
    >
      <div className="sheet-head">
        <div>
          <div className="sheet-kicker">
            <span className="dot dot-idle" aria-hidden="true" />
            <span>Background session</span>
          </div>
          <h2 className="sheet-title" id="launch-title">
            Start a Claude Code session
          </h2>
          <p className="sheet-sub">
            Runs <code>claude --bg</code> in the working directory you choose.
          </p>
        </div>
        <button type="button" className="icon-btn" onClick={close} aria-label="Close">
          <X size={17} aria-hidden="true" />
        </button>
      </div>
      <form className="sheet-form" onSubmit={submit}>
        <div className="sheet-body">
          <div className="launch-grid">
            <div className="field span-2">
              <label htmlFor="launch-prompt">Task</label>
              <textarea
                id="launch-prompt"
                className="textarea"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="What should this session work on?"
                rows={4}
                autoFocus
                required
              />
            </div>
            <div className="field span-2">
              <label htmlFor="launch-cwd">Working directory</label>
              <input
                id="launch-cwd"
                className="input mono"
                value={cwd}
                onChange={(event) => setCwd(event.target.value)}
                placeholder="/path/to/repository"
                spellCheck={false}
                required
              />
              <p className="field-hint">An absolute path on the machine running the daemon.</p>
            </div>
            <div className="field">
              <label htmlFor="launch-name">Name</label>
              <input
                id="launch-name"
                className="input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Optional"
                maxLength={80}
              />
            </div>
            <div className="field">
              <label htmlFor="launch-model">Model</label>
              <select
                id="launch-model"
                className="select"
                value={model}
                onChange={(event) => setModel(event.target.value)}
              >
                <option value="">Default</option>
                <option value="opus">Opus</option>
                <option value="sonnet">Sonnet</option>
                <option value="haiku">Haiku</option>
                <option value="fable">Fable</option>
              </select>
            </div>
            <div className="field span-2">
              <label htmlFor="launch-permission">Permission mode</label>
              <select
                id="launch-permission"
                className="select"
                value={permissionMode}
                onChange={(event) => setPermissionMode(event.target.value)}
              >
                <option value="">Default</option>
                <option value="acceptEdits">Accept edits</option>
                <option value="plan">Plan</option>
                <option value="dontAsk">Don't ask</option>
                <option value="bypassPermissions">Bypass permissions</option>
              </select>
            </div>
          </div>
          <p className="launch-note">
            The session appears on the board once Claude Code registers it, usually within a few
            seconds. Only background sessions can be stopped from here.
          </p>
          {error ? <p className="form-error question-error">{error}</p> : null}
        </div>
        <div className="sheet-foot">
          <span className="grow" />
          <button type="button" className="btn btn-ghost" onClick={close} disabled={pending}>
            Cancel
          </button>
          <button className="btn btn-primary" type="submit" disabled={pending || !prompt.trim()}>
            {pending ? 'Starting…' : 'Start session'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
