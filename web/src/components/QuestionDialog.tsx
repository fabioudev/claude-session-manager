import type { PendingQuestion } from '@shared/types'
import { X } from 'lucide-react'
import {
  createContext,
  type FormEvent,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { ApiError, api } from '../api'
import { countdown, repoLabel, sessionLabel } from '../lib/format'
import { useLive } from '../lib/live'
import { useNow } from '../lib/theme'
import { useToast } from './Toast'

interface QuestionDialogContextValue {
  openQuestion: (question: PendingQuestion) => void
}

const QuestionDialogContext = createContext<QuestionDialogContextValue | null>(null)

interface AnswerDraft {
  labels: string[]
  other: string
}

function draftFor(drafts: Record<number, AnswerDraft>, index: number): AnswerDraft {
  return drafts[index] ?? { labels: [], other: '' }
}

function Countdown({ expiresAt }: { expiresAt: number }) {
  const now = useNow()
  const remaining = expiresAt - now
  return (
    <span className={remaining < 20_000 ? 'question-expiry urgent' : 'question-expiry'}>
      {remaining <= 0 ? 'expired' : `${countdown(remaining)} left`}
    </span>
  )
}

function QuestionSheet({ question, onClose }: { question: PendingQuestion; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const { sessions, config, refresh } = useLive()
  const { notify } = useToast()
  const [drafts, setDrafts] = useState<Record<number, AnswerDraft>>({})
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const now = useNow()
  const session = sessions.find((candidate) => candidate.id === question.sessionId)
  const expired = question.expiresAt !== null && question.expiresAt <= now
  const writable = config !== null && !config.readOnly && config.questionMode !== 'terminal'
  const answerable = question.answerable && writable && !expired
  const complete = question.prompts.every((_prompt, index) => {
    const draft = draftFor(drafts, index)
    return draft.labels.length > 0 || draft.other.trim().length > 0
  })

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

  function setSingle(index: number, label: string) {
    setDrafts((current) => {
      const existing = draftFor(current, index)
      return { ...current, [index]: { labels: [label], other: existing.other } }
    })
  }

  function toggleMulti(index: number, label: string) {
    setDrafts((current) => {
      const existing = draftFor(current, index)
      const labels = existing.labels.includes(label)
        ? existing.labels.filter((item) => item !== label)
        : [...existing.labels, label]
      return { ...current, [index]: { labels, other: existing.other } }
    })
  }

  function setOther(index: number, other: string) {
    setDrafts((current) => {
      const existing = draftFor(current, index)
      return { ...current, [index]: { labels: existing.labels, other } }
    })
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!complete || pending || !answerable) return
    setPending(true)
    setError(null)
    try {
      await api.answerQuestion(question.id, {
        answers: question.prompts.map((_prompt, index) => {
          const draft = draftFor(drafts, index)
          return {
            index,
            labels: draft.labels,
            other: draft.other.trim() || null,
          }
        }),
      })
      notify(
        `Answer sent. ${session ? sessionLabel(session) : 'The session'} continues.`,
        'success',
      )
      close()
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        notify('That question was already answered or expired.', 'error')
        void refresh()
        close()
        return
      }
      setError(cause instanceof Error ? cause.message : 'Could not send the answer.')
      setPending(false)
    }
  }

  async function dismiss() {
    if (pending) return
    setPending(true)
    setError(null)
    try {
      await api.dismissQuestion(question.id)
      notify('Question dismissed. The prompt continues in the terminal.')
      close()
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 404) {
        close()
        return
      }
      setError(cause instanceof Error ? cause.message : 'Could not dismiss the question.')
      setPending(false)
    }
  }

  const sessionName = session ? sessionLabel(session) : question.sessionId.slice(0, 8)
  const project = session ? repoLabel(session) : 'Unknown project'

  return (
    <dialog
      ref={dialogRef}
      className="sheet"
      aria-labelledby="question-sheet-title"
      aria-describedby="question-sheet-sub"
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
    >
      <div className="sheet-head">
        <div>
          <div className="sheet-kicker">
            <span className="dot dot-waiting" aria-hidden="true" />
            <span>{sessionName}</span>
            <span aria-hidden="true">/</span>
            <span>{project}</span>
          </div>
          <h2 className="sheet-title" id="question-sheet-title">
            Answer the session
          </h2>
          <p className="sheet-sub" id="question-sheet-sub">
            {answerable
              ? 'The tool call is holding. Your answer is returned to the session and it continues.'
              : question.source === 'transcript'
                ? 'This question was found in the transcript. Answer it in the terminal.'
                : expired
                  ? 'This question expired. The session has moved on in the terminal.'
                  : !writable
                    ? 'This daemon does not accept answers right now.'
                    : 'This question cannot be answered from the board.'}
          </p>
        </div>
        <button type="button" className="icon-btn" onClick={close} aria-label="Close">
          <X size={17} aria-hidden="true" />
        </button>
      </div>

      <form className="sheet-form" onSubmit={submit}>
        <div className="sheet-body">
          {question.prompts.map((prompt, index) => {
            const draft = draftFor(drafts, index)
            return (
              <section className="prompt-block" key={prompt.header || `question-${index + 1}`}>
                <div className="prompt-label">
                  <span>{prompt.header || `Question ${index + 1}`}</span>
                  <span className="prompt-index">
                    {index + 1} of {question.prompts.length}
                  </span>
                </div>
                <h3 className="prompt-question">{prompt.question}</h3>
                {prompt.multiSelect ? <p className="prompt-multi">Select one or more.</p> : null}
                <div className="options">
                  {prompt.options.map((option) => {
                    const checked = draft.labels.includes(option.label)
                    return (
                      <label className="option" key={option.label}>
                        <input
                          type={prompt.multiSelect ? 'checkbox' : 'radio'}
                          name={`prompt-${index}`}
                          value={option.label}
                          checked={checked}
                          disabled={!answerable || pending}
                          onChange={() =>
                            prompt.multiSelect
                              ? toggleMulti(index, option.label)
                              : setSingle(index, option.label)
                          }
                        />
                        <span>
                          <span className="option-label">{option.label}</span>
                          {option.description ? (
                            <span className="option-description">{option.description}</span>
                          ) : null}
                        </span>
                      </label>
                    )
                  })}
                </div>
                <div className="other-field">
                  <input
                    className="input"
                    type="text"
                    placeholder="Or type a different answer"
                    aria-label={`Other answer for ${prompt.header || `question ${index + 1}`}`}
                    value={draft.other}
                    disabled={!answerable || pending}
                    onChange={(event) => setOther(index, event.target.value)}
                  />
                </div>
              </section>
            )
          })}
          {error ? <p className="form-error question-error">{error}</p> : null}
        </div>

        <div className="sheet-foot">
          {answerable ? (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void dismiss()}
              disabled={pending}
            >
              Answer in terminal
            </button>
          ) : (
            <button type="button" className="btn btn-ghost" onClick={close}>
              Close
            </button>
          )}
          <span className="grow" />
          {question.expiresAt !== null && answerable ? (
            <Countdown expiresAt={question.expiresAt} />
          ) : null}
          {answerable ? (
            <button className="btn btn-primary" type="submit" disabled={!complete || pending}>
              {pending ? 'Sending…' : 'Send answer'}
            </button>
          ) : null}
        </div>
      </form>
    </dialog>
  )
}

export function QuestionDialogProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<PendingQuestion | null>(null)
  const { questions } = useLive()

  useEffect(() => {
    if (!active) return
    if (!questions.some((question) => question.id === active.id)) setActive(null)
  }, [questions, active])

  const value = useMemo(
    () => ({ openQuestion: (question: PendingQuestion) => setActive(question) }),
    [],
  )

  return (
    <QuestionDialogContext.Provider value={value}>
      {children}
      {active ? (
        <QuestionSheet key={active.id} question={active} onClose={() => setActive(null)} />
      ) : null}
    </QuestionDialogContext.Provider>
  )
}

export function useQuestionDialog(): QuestionDialogContextValue {
  const value = useContext(QuestionDialogContext)
  if (!value) throw new Error('useQuestionDialog must be used inside <QuestionDialogProvider>')
  return value
}
