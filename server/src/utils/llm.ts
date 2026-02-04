/**
 * Shared LLM utilities for simple completions and classifications
 *
 * Uses centralized model configuration and retry logic.
 * For conversational AI with tools, use AddieClaudeClient instead.
 */

import Anthropic from '@anthropic-ai/sdk';
import { ModelConfig } from '../config/models.js';
import { withRetry } from './anthropic-retry.js';
import { logger } from '../logger.js';

// Singleton client instance
let client: Anthropic | null = null;

/**
 * Get or create the shared Anthropic client
 */
function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ADDIE_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY or ADDIE_ANTHROPIC_API_KEY not configured');
    }
    client = new Anthropic({ apiKey });
  }
  return client;
}

/**
 * Check if the API key is configured
 */
export function isLLMConfigured(): boolean {
  return !!(process.env.ADDIE_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY);
}

/**
 * Result from an LLM completion with metadata for tracking
 */
export interface LLMResult {
  text: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
}

/**
 * Model tier for selecting appropriate model
 */
export type ModelTier = 'fast' | 'primary' | 'precision';

/**
 * Options for LLM completion
 */
export interface CompleteOptions {
  /** The prompt to send (user message) */
  prompt: string;
  /** Optional system prompt */
  system?: string;
  /** Maximum tokens in response (default: 100) */
  maxTokens?: number;
  /** Model tier to use (default: 'fast') */
  model?: ModelTier;
  /** Operation name for logging (default: 'llm-complete') */
  operationName?: string;
}

/**
 * Simple LLM completion for short responses
 *
 * Returns full result with metadata for tracking/logging.
 * Uses retry logic for transient errors.
 *
 * @example
 * const result = await complete({
 *   prompt: 'Select the best category: tech, sports, news',
 *   maxTokens: 20,
 *   model: 'fast',
 * });
 * console.log(result.text); // "tech"
 *
 * @example
 * // With system prompt
 * const result = await complete({
 *   system: 'You are a helpful assistant.',
 *   prompt: 'Summarize this document...',
 *   maxTokens: 500,
 *   model: 'primary',
 * });
 */
export async function complete(options: CompleteOptions): Promise<LLMResult> {
  const {
    prompt,
    system,
    maxTokens = 100,
    model = 'fast',
    operationName = 'llm-complete',
  } = options;

  const modelId = ModelConfig[model];
  const startTime = Date.now();

  const response = await withRetry(
    async () => {
      return getClient().messages.create({
        model: modelId,
        max_tokens: maxTokens,
        ...(system && { system }),
        messages: [{ role: 'user', content: prompt }],
      });
    },
    { maxRetries: 3, initialDelayMs: 1000 },
    operationName
  );

  const latencyMs = Date.now() - startTime;

  if (!response.content || response.content.length === 0) {
    throw new Error('Empty response from LLM');
  }
  const content = response.content[0];

  if (content.type !== 'text') {
    throw new Error('Unexpected response type from LLM');
  }

  return {
    text: content.text.trim(),
    model: modelId,
    inputTokens: response.usage?.input_tokens,
    outputTokens: response.usage?.output_tokens,
    latencyMs,
  };
}

/**
 * Options for yes/no classification
 */
export interface ClassifyOptions {
  /** The prompt asking a yes/no question */
  prompt: string;
  /** Operation name for logging (default: 'llm-classify') */
  operationName?: string;
}

/**
 * Result from a classification with metadata
 */
export interface ClassifyResult {
  result: boolean;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
}

/**
 * Quick yes/no classification using fast model
 *
 * Returns boolean result with metadata for tracking.
 * Prompt should ask a yes/no question ending with "Respond with only YES or NO."
 *
 * @example
 * const result = await classify({
 *   prompt: 'Is this about advertising? ... Respond with only YES or NO.',
 *   operationName: 'relevance-check',
 * });
 * if (result.result) { ... }
 */
export async function classify(options: ClassifyOptions): Promise<ClassifyResult> {
  const { prompt, operationName = 'llm-classify' } = options;

  const llmResult = await complete({
    prompt,
    maxTokens: 10,
    model: 'fast',
    operationName,
  });

  return {
    result: llmResult.text.toUpperCase() === 'YES',
    model: llmResult.model,
    inputTokens: llmResult.inputTokens,
    outputTokens: llmResult.outputTokens,
    latencyMs: llmResult.latencyMs,
  };
}

/**
 * Reset the client (for testing)
 */
export function resetClient(): void {
  client = null;
}
