import { describe, expect, it } from 'vitest'
import {
  idleResponsePreview,
  repeatsMission,
  restatesMission,
  sessionStateLine,
  taskPreview,
} from '../web/src/lib/format.js'
import { makeSession as session } from './support/session.js'

describe('idleResponsePreview', () => {
  it('cleans the last reply for an idle session', () => {
    const preview = session({
      activity: { kind: 'response', text: '**Done** — `npm test` passes', at: 2_000 },
    })
    expect(idleResponsePreview(preview)).toBe('Done — npm test passes')
  })

  it('ignores non-response activity and the generic placeholder', () => {
    expect(idleResponsePreview(session({ activity: { kind: 'tool', text: 'Bash', at: 1 } }))).toBe(
      '',
    )
    expect(
      idleResponsePreview(
        session({ activity: { kind: 'response', text: 'Ready for the next prompt', at: 1 } }),
      ),
    ).toBe('')
    expect(
      idleResponsePreview(
        session({
          status: 'working',
          activity: { kind: 'response', text: 'Still going', at: 1 },
        }),
      ),
    ).toBe('')
  })
})

describe('taskPreview', () => {
  it('collapses whitespace and truncates long tasks', () => {
    expect(taskPreview(session({ task: '  a\n b  ' }))).toBe('a b')
    const preview = taskPreview(session({ task: 'x'.repeat(300) }))
    expect(preview).toHaveLength(240)
    expect(preview.endsWith('…')).toBe(true)
  })

  it('drops a repository link pasted before the request', () => {
    expect(
      taskPreview(session({ task: 'https://github.com/acme/shop.git fix the double-submit race' })),
    ).toBe('fix the double-submit race')
  })
})

describe('repeatsMission', () => {
  it('ignores final punctuation and case', () => {
    expect(repeatsMission('Fix the cart race.', 'Fix the cart race')).toBe(true)
    expect(repeatsMission('fix  the cart race', 'Fix the cart race')).toBe(true)
  })

  it('ignores a repository link in front of the same prompt', () => {
    expect(
      repeatsMission('https://github.com/acme/shop.git fix the cart race', 'Fix the cart race'),
    ).toBe(true)
  })

  it('treats a full prompt as the truncated headline', () => {
    expect(
      repeatsMission(
        'Migrate the checkout tests from Jest to Vitest and remove the old mocks.',
        'Migrate the checkout tests from Jest to Vitest and remove the old…',
      ),
    ).toBe(true)
  })

  it('keeps a genuinely different latest prompt', () => {
    expect(repeatsMission('Also keep the optimistic UI.', 'Fix the cart race')).toBe(false)
  })
})

describe('restatesMission', () => {
  it('matches a prompt that opens with the mission and continues it', () => {
    expect(
      restatesMission(
        'Fix the cart race. A fast double click creates two orders, so add a guard.',
        'Fix the cart race',
      ),
    ).toBe(true)
  })

  it('requires a word boundary after the mission', () => {
    expect(restatesMission('Fix the cart raceway lights.', 'Fix the cart race')).toBe(false)
  })

  it('keeps a prompt that starts somewhere else', () => {
    expect(restatesMission('Also update the invoice PDF.', 'Fix the cart race')).toBe(false)
  })
})

describe('sessionStateLine', () => {
  it('explains a live finished turn', () => {
    expect(sessionStateLine(session({ status: 'idle', live: true, source: 'registry' }))).toBe(
      'Ready for your next prompt',
    )
  })

  it('treats a hook-only Stop event as a live finished turn', () => {
    expect(sessionStateLine(session({ status: 'idle', live: false, source: 'hook' }))).toBe(
      'Ready for your next prompt',
    )
  })

  it('hedges for a transcript-only idle session', () => {
    expect(sessionStateLine(session({ status: 'idle', source: 'transcript' }))).toBe(
      'Likely finished — no live signal',
    )
  })

  it('calls a transcript-only ended session history', () => {
    expect(
      sessionStateLine(
        session({ status: 'ended', source: 'transcript', statusDetail: 'Session closed' }),
      ),
    ).toBe('History — no live signal')
  })

  it('keeps a meaningful ended detail', () => {
    expect(
      sessionStateLine(
        session({
          status: 'ended',
          source: 'background',
          statusDetail: 'Background task failed',
        }),
      ),
    ).toBe('Background task failed')
  })
})
