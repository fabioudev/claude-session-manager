import type { SessionSummary } from '../shared/types.js'

export type DispatchMode = 'typed' | 'queued'

export interface DispatchDecision {
  mode: DispatchMode
  /** Why the prompt cannot be typed, for the person reading the result. */
  reason: string | null
}

export interface DispatchInput {
  session: SessionSummary
  /** The session's runtime says a turn is in flight. */
  working: boolean
  /** The session is at a question the board can answer. */
  hasQuestion: boolean
  /** restart/resume machinery exists on this platform. */
  supported: boolean
  /** Launching sessions is allowed in the settings. */
  launchEnabled: boolean
  /** Read-only daemons never touch a session. */
  readOnly: boolean
}

/**
 * A prompt can only be typed into a pane that is live and idle. Everything else
 * falls back to the inbox, which the session reads on its next turn: queueing is
 * never wrong, it is only slower.
 */
export function dispatchDecision(input: DispatchInput): DispatchDecision {
  const queued = (reason: string): DispatchDecision => ({ mode: 'queued', reason })
  if (input.readOnly) return queued('This board is read-only.')
  if (!input.launchEnabled) return queued('Launching sessions is disabled in the settings.')
  if (!input.supported) return queued('Typing into a pane is only supported on Linux.')
  if (input.session.archived) return queued('This session is archived.')
  if (!input.session.live) return queued('This session is not running.')
  if (!input.session.tmux) return queued('This session has no tmux pane to type into.')
  if (input.hasQuestion) return queued('The session is answering a question right now.')
  if (input.working) return queued('The session is working; the prompt waits for its next turn.')
  if (input.session.status === 'waiting') {
    return queued('The session is waiting at a prompt in its terminal.')
  }
  return { mode: 'typed', reason: null }
}

export interface WakeInput {
  session: SessionSummary
  /** The background job's own state, or null when there is no job. */
  backgroundState: string | null
  /** The job's process is gone; its state file may still say "working". */
  backgroundExited?: boolean
  /** The session is at a question only the person can answer. */
  hasQuestion: boolean
  supported: boolean
  launchEnabled: boolean
  readOnly: boolean
}

export type WakeDecision = { wake: false; reason: string | null } | { wake: true; stop: boolean }

/**
 * A background session has no pane, so an inbox message waits for a turn that
 * never comes. It has to be woken instead: stop the waiting job and resume it
 * with the text. Only a job that is visibly not running can be woken safely —
 * resuming a running one starts a copy that works alongside the original.
 *
 * `session.live` is false for background jobs, so the job id and its state are
 * what decide here, not the interactive live flag.
 */
export function wakeDecision(input: WakeInput): WakeDecision {
  const no = (reason: string | null): WakeDecision => ({ wake: false, reason })
  if (input.readOnly) return no('This board is read-only.')
  if (!input.launchEnabled) return no('Launching sessions is disabled in the settings.')
  if (!input.supported) return no('Waking a background session is only supported on Linux.')
  if (!input.session.jobId) return no('This session is not a background job.')
  if (input.hasQuestion) return no('The session is answering a question right now.')
  if (input.session.archived) return no('This session is archived.')
  // A dead job cannot be working, whatever its last written state claims: the
  // process was stopped (or the manager restarted) before it could record the
  // exit. There is nothing to stop, so resume it directly.
  if (input.backgroundExited) return { wake: true, stop: false }
  if (input.backgroundState === 'blocked') return { wake: true, stop: true }
  if (
    input.backgroundState === 'done' ||
    input.backgroundState === 'stopped' ||
    input.backgroundState === 'failed'
  ) {
    return { wake: true, stop: false }
  }
  // "working" and "unknown" both mean the job may still own the conversation;
  // queue instead of risking a parallel copy.
  return no(
    input.backgroundState === 'working'
      ? 'The session is working; the prompt waits for its next turn.'
      : 'The background job state is unclear; the prompt waits for its next turn.',
  )
}
