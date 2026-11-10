import { describe, expect, it } from 'vitest'
import { isIdleNotification } from '../server/session-manager.js'

describe('isIdleNotification', () => {
  it('treats the idle prompt notification as idle, not as waiting for the human', () => {
    expect(
      isIdleNotification({
        message: 'Claude is waiting for your input',
        type: 'idle_prompt',
        at: 1,
      }),
    ).toBe(true)
  })

  it('falls back to the message when an older payload has no type', () => {
    expect(
      isIdleNotification({ message: 'Claude is waiting for your input', type: null, at: 1 }),
    ).toBe(true)
  })

  it('keeps permission prompts blocking', () => {
    expect(
      isIdleNotification({
        message: 'Claude needs your permission to use Bash',
        type: 'permission_prompt',
        at: 1,
      }),
    ).toBe(false)
  })

  it('keeps elicitation dialogs blocking', () => {
    expect(
      isIdleNotification({
        message: 'Claude needs your input to continue',
        type: 'elicitation_dialog',
        at: 1,
      }),
    ).toBe(false)
  })
})
