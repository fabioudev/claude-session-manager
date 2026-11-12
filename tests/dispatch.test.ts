import { describe, expect, it } from 'vitest'
import {
  type DispatchInput,
  dispatchDecision,
  type WakeInput,
  wakeDecision,
} from '../server/dispatch.js'
import { makeSession } from './support/session.js'

const base: DispatchInput = {
  session: makeSession({ id: 's', status: 'idle', live: true, tmux: 'dev1:@0.%0' }),
  working: false,
  hasQuestion: false,
  supported: true,
  launchEnabled: true,
  readOnly: false,
}

describe('dispatchDecision', () => {
  it('types into a live, idle session', () => {
    expect(dispatchDecision(base)).toEqual({ mode: 'typed', reason: null })
  })

  it('queues while the session is working', () => {
    const decision = dispatchDecision({ ...base, working: true })
    expect(decision.mode).toBe('queued')
    expect(decision.reason).toContain('working')
  })

  it('queues when a question is open, because typing would answer it', () => {
    const decision = dispatchDecision({ ...base, hasQuestion: true })
    expect(decision.mode).toBe('queued')
    expect(decision.reason).toContain('question')
  })

  it('queues for a session that is waiting at a terminal prompt', () => {
    const decision = dispatchDecision({
      ...base,
      session: makeSession({ id: 's', status: 'waiting', live: true, tmux: 'dev1:@0.%0' }),
    })
    expect(decision.mode).toBe('queued')
  })

  it('queues for an ended session', () => {
    const decision = dispatchDecision({
      ...base,
      session: makeSession({ id: 's', status: 'ended', live: false }),
    })
    expect(decision.mode).toBe('queued')
    expect(decision.reason).toContain('not running')
  })

  it('queues when the board may not touch the session', () => {
    expect(dispatchDecision({ ...base, readOnly: true }).mode).toBe('queued')
    expect(dispatchDecision({ ...base, launchEnabled: false }).mode).toBe('queued')
    expect(dispatchDecision({ ...base, supported: false }).mode).toBe('queued')
  })
})

const background: WakeInput = {
  session: makeSession({
    id: 'bg',
    kind: 'background',
    live: true,
    tmux: null,
    status: 'waiting',
    jobId: 'bg',
    backgroundState: 'blocked',
  }),
  backgroundState: 'blocked',
  hasQuestion: false,
  supported: true,
  launchEnabled: true,
  readOnly: false,
}

describe('wakeDecision', () => {
  it('stops a blocked background job before resuming it', () => {
    expect(wakeDecision(background)).toEqual({ wake: true, stop: true })
  })

  it('wakes a background job even though the summary reports live: false', () => {
    expect(
      wakeDecision({ ...background, session: { ...background.session, live: false } }),
    ).toEqual({ wake: true, stop: true })
  })

  it('resumes a finished job without stopping it', () => {
    expect(wakeDecision({ ...background, backgroundState: 'done' })).toEqual({
      wake: true,
      stop: false,
    })
  })

  it('leaves a working job alone instead of copying it', () => {
    const decision = wakeDecision({ ...background, backgroundState: 'working' })
    expect(decision.wake).toBe(false)
    expect(decision.reason).toContain('working')
  })

  it('wakes a job whose state still says working but whose process is gone', () => {
    expect(
      wakeDecision({ ...background, backgroundState: 'working', backgroundExited: true }),
    ).toEqual({ wake: true, stop: false })
    // A dead job needs no stop either, whatever state it froze in.
    expect(
      wakeDecision({ ...background, backgroundState: 'blocked', backgroundExited: true }),
    ).toEqual({ wake: true, stop: false })
  })

  it('does not guess when the job state is unknown', () => {
    expect(wakeDecision({ ...background, backgroundState: 'unknown' }).wake).toBe(false)
  })

  it('queues to a session that has a question open', () => {
    expect(wakeDecision({ ...background, hasQuestion: true }).wake).toBe(false)
  })

  it('wakes a session whose question expired, because no terminal can answer it', () => {
    expect(
      wakeDecision({
        ...background,
        hasQuestion: true,
        questionExpired: true,
        backgroundState: 'blocked',
      }),
    ).toEqual({ wake: true, stop: true })
    // An expired question on a job that still works must not become a copy.
    expect(
      wakeDecision({
        ...background,
        hasQuestion: true,
        questionExpired: true,
        backgroundState: 'working',
      }).wake,
    ).toBe(false)
  })

  it('does not wake a session without a background job', () => {
    expect(
      wakeDecision({
        ...background,
        session: makeSession({ id: 'x', live: false, tmux: null, jobId: null }),
      }).wake,
    ).toBe(false)
  })

  it('honours read-only and disabled launching', () => {
    expect(wakeDecision({ ...background, readOnly: true }).wake).toBe(false)
    expect(wakeDecision({ ...background, launchEnabled: false }).wake).toBe(false)
    expect(wakeDecision({ ...background, supported: false }).wake).toBe(false)
  })
})
