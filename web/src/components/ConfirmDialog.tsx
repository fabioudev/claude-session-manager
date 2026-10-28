import { X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

interface ConfirmDialogProps {
  title: string
  description: string
  confirmLabel: string
  danger?: boolean
  onConfirm: () => Promise<void> | void
  onClose: () => void
}

export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  danger = false,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
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

  async function confirm() {
    if (pending) return
    setPending(true)
    setError(null)
    try {
      await onConfirm()
      close()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The action failed.')
      setPending(false)
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="sheet"
      aria-labelledby="confirm-title"
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
    >
      <div className="sheet-head">
        <div>
          <div className="sheet-kicker">
            <span className={`dot ${danger ? 'dot-waiting' : 'dot-idle'}`} aria-hidden="true" />
            <span>{danger ? 'Confirm' : 'Action'}</span>
          </div>
          <h2 className="sheet-title" id="confirm-title">
            {title}
          </h2>
        </div>
        <button type="button" className="icon-btn" onClick={close} aria-label="Close">
          <X size={17} aria-hidden="true" />
        </button>
      </div>
      <div className="sheet-body">
        <p className="detail-task">{description}</p>
        {error ? <p className="form-error question-error">{error}</p> : null}
      </div>
      <div className="sheet-foot">
        <span className="grow" />
        <button type="button" className="btn btn-ghost" onClick={close} disabled={pending}>
          Cancel
        </button>
        <button
          type="button"
          className={danger ? 'btn btn-danger' : 'btn btn-primary'}
          onClick={() => void confirm()}
          disabled={pending}
        >
          {pending ? 'Working…' : confirmLabel}
        </button>
      </div>
    </dialog>
  )
}
