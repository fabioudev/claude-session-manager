import { describe, expect, it } from 'vitest'
import { estimatedCostUsd, normalizeModel, pricingForModel } from '../server/pricing.js'

describe('pricing', () => {
  it('normalizes provider prefixes and decorations', () => {
    expect(normalizeModel('anthropic/claude-sonnet-5')).toBe('claude-sonnet-5')
    expect(normalizeModel('Claude-Opus-5-5[1m]')).toBe('claude-opus-5-5')
    expect(normalizeModel('claude-haiku-4-5[foo]')).toBe('claude-haiku-4-5')
  })

  it('returns a known price row', () => {
    const pricing = pricingForModel('claude-sonnet-5')
    expect(pricing).toMatchObject({
      inputPerMTok: 2,
      outputPerMTok: 10,
      cacheReadPerMTok: 0.2,
      cacheWritePerMTok: 2.5,
      contextWindow: 1_000_000,
    })
  })

  it('returns null for unknown and missing models', () => {
    expect(pricingForModel(null)).toBeNull()
    expect(pricingForModel('deepseek-v4.1-flash')).toBeNull()
  })

  it('estimates and rounds cost', () => {
    expect(
      estimatedCostUsd('claude-sonnet-5', {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      }),
    ).toBe(2)
    expect(
      estimatedCostUsd('claude-sonnet-5', {
        inputTokens: 100,
        outputTokens: 100,
        cacheReadTokens: 100,
        cacheCreationTokens: 100,
      }),
    ).toBe(0.0015)
    expect(
      estimatedCostUsd('unknown-model', {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 1,
        cacheCreationTokens: 1,
      }),
    ).toBeNull()
  })
})
