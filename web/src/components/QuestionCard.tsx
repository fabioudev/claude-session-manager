import type { PendingQuestion } from '@shared/types'
import { ArrowUpRight } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError, api } from '../api'
import { countdown, repoLabel, sessionLabel } from '../lib/format'
import { useLive } from '../lib/live'
import { useNow } from '../lib/theme'
import { useQuestionDialog } from './QuestionDialog'
import { useToast } from './Toast'

export function QuestionCard({ question }: { question: PendingQuestion }) {
  const { sessions, config, refresh } = useLive()
  const { openQuestion } = useQuestionDialog()
  const { notify } = useToast()
  const [dismissing, setDismissing] = useState(false)
  const now = useNow()
  const session = sessions.find((candidate) => candidate.id === question.sessionId)
  const first = question.prompts[0]
  const expired = question.expiresAt !== null && question.expiresAt <= now
  const writable = config !== null && !config.readOnly && config.questionMode !== 'terminal'
  const answerable = question.answerable && writable && !expired
  const optionPreview = first?.options
    .map((option) => option.label)
    .slice(0, 4)
    .join('  /  ')

  async function dismiss() {
    if (dismissing) return
    setDismissing(true)
    try {
      await api.dismissQuestion(question.id)
      notify('Question dismissed. The prompt continues in the terminal.')
      void refresh()
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 404) {
        void refresh()
      } else {
        notify(cause instanceof Error ? cause.message : 'Could not dismiss the question.', 'error')
      }
    } finally {
      setDismissing(false)
    }
  }

  return (
    <article
      className="question-card"
      aria-label={`Question from ${session ? sessionLabel(session) : question.sessionId}`}
    >
      <div className="question-body">
        <div className="question-meta">
          {session ? (
            <Link className="session-ref" to={`/sessions/${session.id}`}>
              {sessionLabel(session)}
            </Link>
          ) : (
            <span className="session-ref">{question.sessionId.slice(0, 8)}</span>
          )}
          <span>{session ? repoLabel(session) : 'Unknown project'}</span>
          {first?.header ? <span className="question-header">{first.header}</span> : null}
          {question.prompts.length > 1 ? <span>{question.prompts.length} questions</span> : null}
          {question.source === 'transcript' ? <span>From transcript</span> : null}
        </div>
        <h3 className="question-title">{first?.question || 'A session is waiting for input.'}</h3>
        {optionPreview ? <p className="question-options-preview">{optionPreview}</p> : null}
      </div>
      <div className="question-actions">
        <div className="question-actions-row">
          {answerable ? (
            <>
              <button
                type="button"
                className="btn btn-accent"
                onClick={() => openQuestion(question)}
              >
                Answer
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void dismiss()}
                disabled={dismissing}
              >
                Terminal
              </button>
            </>
          ) : (
            <Link className="btn" to={`/sessions/${question.sessionId}`}>
              Open session
              <ArrowUpRight size={13} aria-hidden="true" />
            </Link>
          )}
        </div>
        {question.expiresAt !== null && answerable ? (
          <span className="question-expiry">{`${countdown(question.expiresAt - now)} left`}</span>
        ) : expired ? (
          <span className="question-expiry">Expired</span>
        ) : !answerable ? (
          <span className="question-terminal-note">
            {question.source === 'transcript'
              ? 'Answer in the terminal.'
              : config?.questionMode === 'terminal'
                ? 'Questions are set to terminal only.'
                : config?.readOnly
                  ? 'The daemon is read-only.'
                  : 'Answer in the terminal.'}
          </span>
        ) : null}
      </div>
    </article>
  )
}
