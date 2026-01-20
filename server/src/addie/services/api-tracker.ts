/**
 * API Call Tracker
 *
 * Tracks all Anthropic API calls for performance metrics.
 * This captures both chat messages and background tasks (router, insight extraction, etc.)
 */

import { query } from '../../db/client.js';
import { logger } from '../../logger.js';

export interface ApiCallRecord {
  model: string;
  purpose: string;
  tokens_input?: number;
  tokens_output?: number;
  latency_ms?: number;
  thread_id?: string;
}

/**
 * Track an API call for performance metrics
 */
export async function trackApiCall(record: ApiCallRecord): Promise<void> {
  try {
    await query(
      `INSERT INTO addie_api_calls (model, purpose, tokens_input, tokens_output, latency_ms, thread_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        record.model,
        record.purpose,
        record.tokens_input ?? null,
        record.tokens_output ?? null,
        record.latency_ms ?? null,
        record.thread_id ?? null,
      ]
    );
  } catch (error) {
    // Don't fail the main operation if tracking fails
    logger.warn({ error, record }, 'Failed to track API call');
  }
}

/**
 * API call purposes for consistent tracking
 * Add new purposes here as tracking is implemented for other background tasks
 */
export const ApiPurpose = {
  ROUTER: 'router',
  INSIGHT_EXTRACTION: 'insight_extraction',
} as const;

export type ApiPurpose = (typeof ApiPurpose)[keyof typeof ApiPurpose];
