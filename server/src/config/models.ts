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
   * Default: claude-sonnet-5
   * Override: CLAUDE_MODEL_PRIMARY
   */
  primary: process.env.CLAUDE_MODEL_PRIMARY || 'claude-sonnet-5',

  /**
   * Fast model for simple tasks (insight extraction, classification)
   * Default: claude-haiku-4-5
   * Override: CLAUDE_MODEL_FAST
   */
  fast: process.env.CLAUDE_MODEL_FAST || 'claude-haiku-4-5',

  /**
   * Precision model for high-stakes tasks (billing, financial, legal)
   * Default: claude-opus-5 (frontier reasoning at the Opus price tier)
   * Override: CLAUDE_MODEL_PRECISION
   *
   * Use this when accuracy is critical and hallucinations are costly.
   * Examples: sending invoices, quoting prices, handling payments.
   */
  precision: process.env.CLAUDE_MODEL_PRECISION || 'claude-opus-5',

  /**
   * Depth model for multi-step reasoning, expert consultation, and long-
   * context synthesis. Same model powers the AdCP triage routines so
   * Addie's deep-question answers stay consistent with GitHub triage.
   * Default: claude-opus-5
   * Override: CLAUDE_MODEL_DEPTH
   *
   * Use this when the turn requires reasoning across many docs, multi-
   * expert synthesis, or protocol-level analysis. Distinct from precision
   * (billing accuracy) — depth is about thinking, precision is about
   * "don't hallucinate this number."
   */
  depth: process.env.CLAUDE_MODEL_DEPTH || 'claude-opus-5',
} as const;

/**
 * Gemini models used by the image pipeline.
 *
 * Gemini 3.7 Flash is the general multimodal workhorse, but it does not emit
 * images. Native image generation therefore uses the current stable Flash
 * Image model instead of the retired preview endpoint.
 */
const geminiImageModel = process.env.GEMINI_MODEL_IMAGE || 'gemini-3.1-flash-image';

export const GeminiModelConfig = {
  /** Image inspection, validation, and other text-output multimodal tasks. */
  fast: process.env.GEMINI_MODEL_FAST || 'gemini-3.7-flash',

  /** Native image generation and editing. */
  image: geminiImageModel,

  /** C2PA version paired with the selected image model. */
  imageVersion: process.env.GEMINI_MODEL_IMAGE_VERSION || geminiImageModel.replace(/^gemini-/, ''),
} as const;

/**
 * Request fragment for bounded jobs that should not spend their response
 * budget on adaptive thinking. Older/overridden models receive no unknown
 * request field, preserving the model override contract.
 */
export function disableAdaptiveThinking(model: string):
  | { thinking: { type: 'disabled' } }
  | Record<string, never> {
  // Fable 5 and Mythos 5/Preview always think and reject `disabled`.
  const supportsDisablingThinking = /^claude-(?:sonnet-5|opus-(?:4-[78]|5))$/.test(model);
  return supportsDisablingThinking ? { thinking: { type: 'disabled' } } : {};
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
   * Model for active certification sessions. Kept separate so curriculum
   * adherence can be A/B tested without changing general Addie traffic.
   * Override: ADDIE_CERTIFICATION_MODEL (falls back to chat/Sonnet)
   */
  certification: process.env.ADDIE_CERTIFICATION_MODEL
    || process.env.ADDIE_ANTHROPIC_MODEL
    || ModelConfig.primary,

  /**
   * Model for anonymous web chat.
   *
   * Defaults to Sonnet (`primary`). Anonymous traffic exposes Addie's worst
   * failure modes — ritual phrases, length blow-out on short questions,
   * fabrication of integration details — which trace to Haiku's poor
   * adherence to negative instructions and conservative tool-call gating.
   * Sonnet handles those substantially better at a higher per-turn cost.
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
