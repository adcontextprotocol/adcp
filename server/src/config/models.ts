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
} as const;

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
   * Model for anonymous web chat (cost-controlled)
   * Override: ADDIE_ANONYMOUS_MODEL (falls back to fast/Haiku)
   */
  anonymousChat: process.env.ADDIE_ANONYMOUS_MODEL || ModelConfig.fast,
} as const;
