import { describe, expect, it } from 'vitest'
import {
  type DispatchInput,
  dispatchDecision,
  looksLikeTerminalDialog,
  selfApprovesTool,
  type WakeInput,
  wakeDecision,
} from '../server/dispatch.js'
import { makeSession } from './support/session.js'

const base: DispatchInput = {
  session: makeSession({ id: 's', status: 'idle', live: true, tmux: 'dev1:@0.%0' }),
  working: false,
  hasQuestion: false,
  waitingFor: null,
  supported: true,
  launchEnabled: true,
  readOnly: false,
}

describe('dispatchDecision', () => {
  it('types into a live, idle session', () => {
    expect(dispatchDecision(base)).toEqual({ mode: 'typed', reason: null })
  })

  it('types into a session Claude Code reports as merely waiting at its prompt', () => {
    // "waiting" used to mean "do not type" on its own, which stranded every
    // prompt to an idle interactive session in an inbox nobody reads.
    const decision = dispatchDecision({
      ...base,
      session: makeSession({ id: 's', status: 'waiting', live: true, tmux: 'dev1:@0.%0' }),
    })
    expect(decision).toEqual({ mode: 'typed', reason: null })
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

  it('queues for a session at a dialog in its terminal', () => {
    const decision = dispatchDecision({ ...base, waitingFor: 'dialog open' })
    expect(decision.mode).toBe('queued')
    expect(decision.reason).toContain('dialog open')
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

describe('looksLikeTerminalDialog', () => {
  const inputBox = [
    '✻ Crunched for 1m 10s · done 12:53 PM',
    '',
    '──────────────────────────────────────────────────────────────',
    '❯ ',
    '──────────────────────────────────────────────────────────────',
    '  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ← 30 agents',
  ].join('\n')

  it('leaves the idle input box alone', () => {
    expect(looksLikeTerminalDialog(inputBox)).toBe(false)
  })

  it('recognises the "Background work is running" exit confirmation', () => {
    const pane = [
      inputBox,
      '',
      '   Background work is running',
      '   The following will stop when you exit:',
      '',
      '   scheduled task · 7,27,47 * * * * · [Commander-Watchdog, alle 20 min]',
      '',
      '   ❯ 1. Exit and stop tasks',
      '     2. Move to background and exit',
      '     3. Stay',
      '',
      '   Enter to confirm · Esc to cancel',
    ].join('\n')
    expect(looksLikeTerminalDialog(pane)).toBe(true)
  })

  it('recognises a permission prompt without the footer', () => {
    const pane = [
      ' Bash command',
      '   rm -rf ./build',
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. No',
    ].join('\n')
    expect(looksLikeTerminalDialog(pane)).toBe(true)
  })

  it('ignores text from earlier in the scrollback', () => {
    const pane = [
      '   Enter to confirm · Esc to cancel',
      ...Array.from({ length: 20 }, (_, index) => `line ${index}`),
      inputBox,
    ].join('\n')
    expect(looksLikeTerminalDialog(pane)).toBe(false)
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

  it('wakes a job that finished its turn although its state still says working', () => {
    // `tempo: "idle"` is the only sign that no turn is running; without this the
    // prompt would wait forever, because a background job starts no next turn.
    expect(
      wakeDecision({ ...background, backgroundState: 'working', backgroundIdle: true }),
    ).toEqual({ wake: true, stop: true })
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

describe('selfApprovesTool', () => {
  it('answers worktree switches itself and keeps every other prompt', () => {
    expect(selfApprovesTool('EnterWorktree')).toBe(true)
    expect(selfApprovesTool('ExitWorktree')).toBe(true)
    expect(selfApprovesTool('Bash')).toBe(false)
    expect(selfApprovesTool('Edit')).toBe(false)
    expect(selfApprovesTool('AskUserQuestion')).toBe(false)
    expect(selfApprovesTool(null)).toBe(false)
  })
})
