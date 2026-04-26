/**
 * Centralized AI model configuration
 *
 * Default models can be overridden via environment variables.
 * This allows switching models without code changes.
 */

/**
 * Model IDs for different use cases
 */
export const ModelConfig = {
  /**
   * Primary model for complex tasks (Addie chat, rule analysis)
   * Default: claude-sonnet-4-6
   * Override: CLAUDE_MODEL_PRIMARY
   */
  primary: process.env.CLAUDE_MODEL_PRIMARY || 'claude-sonnet-4-6',

  /**
   * Fast model for simple tasks (insight extraction, classification)
   * Default: claude-haiku-4-5
   * Override: CLAUDE_MODEL_FAST
   */
  fast: process.env.CLAUDE_MODEL_FAST || 'claude-haiku-4-5',

  /**
   * Precision model for high-stakes tasks (billing, financial, legal)
   * Default: claude-opus-4-6 (most capable, but more expensive)
   * Override: CLAUDE_MODEL_PRECISION
   *
   * Use this when accuracy is critical and hallucinations are costly.
   * Examples: sending invoices, quoting prices, handling payments.
   */
  precision: process.env.CLAUDE_MODEL_PRECISION || 'claude-opus-4-6',

  /**
   * Depth model for multi-step reasoning, expert consultation, and long-
   * context synthesis. Same model powers the AdCP triage routines so
   * Addie's deep-question answers stay consistent with GitHub triage.
   * Default: claude-opus-4-7
   * Override: CLAUDE_MODEL_DEPTH
   *
   * Use this when the turn requires reasoning across many docs, multi-
   * expert synthesis, or protocol-level analysis. Distinct from precision
   * (billing accuracy) — depth is about thinking, precision is about
   * "don't hallucinate this number."
   */
  depth: process.env.CLAUDE_MODEL_DEPTH || 'claude-opus-4-7',
} as const;

/**
 * Anthropic beta flag that unlocks the 1M-token context window on
 * supported Claude models. Passed via the `betas` array on the
 * `/v1/messages` beta endpoint (NOT as a suffix on the model ID).
 */
export const CONTEXT_1M_BETA = 'context-1m-2025-08-07';

/**
 * Models that currently support the 1M context beta. Opus 4.7 is the
 * depth-tier default; Sonnet 4.6 supports it too. Extend this list as
 * Anthropic enables 1M on additional models.
 */
const MODELS_SUPPORTING_1M_CONTEXT = new Set<string>([
  'claude-opus-4-7',
  'claude-sonnet-4-6',
]);

/**
 * Returns additional Anthropic `betas` flags that should be enabled for
 * the given model. Currently: 1M context on depth-tier models.
 *
 * Opt out per-model with `CLAUDE_DISABLE_1M_CONTEXT=true`.
 */
export function getModelBetas(model: string): string[] {
  const betas: string[] = [];
  if (
    process.env.CLAUDE_DISABLE_1M_CONTEXT !== 'true' &&
    MODELS_SUPPORTING_1M_CONTEXT.has(model)
  ) {
    betas.push(CONTEXT_1M_BETA);
  }
  return betas;
}

/**
 * Addie-specific model configuration
 * Separate env var for backwards compatibility
 */
export const AddieModelConfig = {
  /**
   * Model for Addie chat responses
   * Override: ADDIE_ANTHROPIC_MODEL (falls back to primary)
   */
  chat: process.env.ADDIE_ANTHROPIC_MODEL || ModelConfig.primary,

  /**
   * Model for anonymous web chat.
   *
   * Defaults to Sonnet (`primary`). Anonymous traffic exposes Addie's worst
   * failure modes — ritual phrases, length blow-out on short questions,
   * fabrication of integration details — which trace to Haiku's poor
   * adherence to negative instructions and conservative tool-call gating.
   * Sonnet handles those substantially better at ~10x per-turn cost.
   * Total spend is bounded by `anonymousDailyLimiter` (50 messages/IP/day)
   * + the per-IP $5 daily Claude API cap, both unchanged by this default.
   *
   * Override: ADDIE_ANONYMOUS_MODEL — set to Haiku/`fast` if cost pressure
   * forces a downgrade.
   */
  anonymousChat: process.env.ADDIE_ANONYMOUS_MODEL || ModelConfig.primary,

  /**
   * Model for voice/video conversations
   * Override: ADDIE_VOICE_MODEL (falls back to primary/Sonnet)
   */
  voice: process.env.ADDIE_VOICE_MODEL || ModelConfig.primary,
} as const;
