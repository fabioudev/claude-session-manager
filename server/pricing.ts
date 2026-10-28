/**
 * Best-effort pricing for the models Claude Code sessions run on. Values are
 * Anthropic first-party list prices in USD per million tokens (cached 2026-10).
 * Anything unrecognised (local models, third-party gateways) yields null rather
 * than a misleading number, and the UI shows tokens only.
 */
export interface ModelPricing {
  inputPerMTok: number
  outputPerMTok: number
  cacheReadPerMTok: number
  cacheWritePerMTok: number
  contextWindow: number
}

interface PriceRow {
  match: RegExp
  input: number
  output: number
  context: number
}

const ROWS: PriceRow[] = [
  { match: /^claude-fable-5(-1)?\b/, input: 10, output: 50, context: 1_000_000 },
  { match: /^claude-mythos-5(-1)?\b/, input: 10, output: 50, context: 1_000_000 },
  { match: /^claude-opus-5-5\b/, input: 4, output: 20, context: 1_000_000 },
  { match: /^claude-opus-5\b/, input: 5, output: 25, context: 1_000_000 },
  { match: /^claude-opus-4-[678]\b/, input: 5, output: 25, context: 1_000_000 },
  { match: /^claude-sonnet-5-5\b/, input: 2, output: 10, context: 1_000_000 },
  { match: /^claude-sonnet-5\b/, input: 2, output: 10, context: 1_000_000 },
  { match: /^claude-sonnet-4-6\b/, input: 3, output: 15, context: 1_000_000 },
  { match: /^claude-sonnet-4-5\b/, input: 3, output: 15, context: 200_000 },
  { match: /^claude-sonnet-4\b/, input: 3, output: 15, context: 200_000 },
  { match: /^claude-haiku-5-5\b/, input: 0.1, output: 0.5, context: 1_000_000 },
  { match: /^claude-haiku-4-5\b/, input: 1, output: 5, context: 200_000 },
  { match: /^claude-3-5-haiku\b/, input: 0.8, output: 4, context: 200_000 },
  { match: /^claude-3-haiku\b/, input: 0.25, output: 1.25, context: 200_000 },
  { match: /^claude-opus-4-1\b/, input: 15, output: 75, context: 200_000 },
  { match: /^claude-opus-4\b/, input: 15, output: 75, context: 200_000 },
  { match: /^claude-3-opus\b/, input: 15, output: 75, context: 200_000 },
  { match: /^claude-3-7-sonnet\b/, input: 3, output: 15, context: 200_000 },
  { match: /^claude-3-5-sonnet\b/, input: 3, output: 15, context: 200_000 },
  { match: /^claude-3-sonnet\b/, input: 3, output: 15, context: 200_000 },
]

/** Strip provider prefixes, dated snapshot suffixes and Claude Code decorations. */
export function normalizeModel(model: string): string {
  let value = model.trim().toLowerCase()
  value = value.replace(/^[a-z0-9_-]+\//, '')
  value = value.replace(/\[1m\]$/, '')
  value = value.replace(/\[[^\]]*\]$/, '')
  return value
}

export function pricingForModel(model: string | null | undefined): ModelPricing | null {
  if (!model) return null
  const normalized = normalizeModel(model)
  for (const row of ROWS) {
    if (!row.match.test(normalized)) continue
    return {
      inputPerMTok: row.input,
      outputPerMTok: row.output,
      cacheReadPerMTok: row.input * 0.1,
      cacheWritePerMTok: row.input * 1.25,
      contextWindow: row.context,
    }
  }
  return null
}

export function estimatedCostUsd(
  model: string | null | undefined,
  tokens: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
  },
): number | null {
  const pricing = pricingForModel(model)
  if (!pricing) return null
  const cost =
    (tokens.inputTokens * pricing.inputPerMTok +
      tokens.outputTokens * pricing.outputPerMTok +
      tokens.cacheReadTokens * pricing.cacheReadPerMTok +
      tokens.cacheCreationTokens * pricing.cacheWritePerMTok) /
    1_000_000
  return Math.round(cost * 10_000) / 10_000
}
