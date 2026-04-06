/**
 * Batch processing utilities for Anthropic Message Batches API
 *
 * Submits multiple messages.create requests as a single batch for 50% cost
 * savings. Results are polled and dispatched by custom_id.
 *
 * @see https://docs.anthropic.com/en/docs/build-with-claude/batch-processing
 */

import Anthropic from '@anthropic-ai/sdk';
import type { MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages/messages.js';
import type {
  MessageBatch,
  MessageBatchErroredResult,
  MessageBatchIndividualResponse,
  MessageBatchSucceededResult,
} from '@anthropic-ai/sdk/resources/messages/batches.js';
import { logger as baseLogger } from '../logger.js';

const logger = baseLogger.child({ module: 'batch' });

/** A single request to include in a batch */
export interface BatchRequest {
  /** Unique identifier for correlating results back to the request */
  customId: string;
  /** Standard messages.create parameters (non-streaming) */
  params: MessageCreateParamsNonStreaming;
}

/** The result for a single request within a completed batch */
export interface BatchItemResult {
  customId: string;
  status: 'succeeded' | 'errored' | 'canceled' | 'expired';
  /** The message response, present only when status is 'succeeded' */
  message?: Anthropic.Message;
  /** Error details, present only when status is 'errored' */
  error?: { type: string; message: string };
}

/** Options for submitting and waiting on a batch */
export interface BatchOptions {
  /** How often to poll for batch completion (default: 30_000ms) */
  pollIntervalMs?: number;
  /** Maximum time to wait before giving up (default: 3_600_000ms = 1 hour) */
  timeoutMs?: number;
  /** Operation name for logging */
  operationName?: string;
}

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 3_600_000; // 1 hour
const MAX_BATCH_SIZE = 100_000;

/**
 * Submit a batch of message requests and wait for all results.
 *
 * Returns results keyed by customId for easy lookup.
 */
export async function submitBatch(
  client: Anthropic,
  requests: BatchRequest[],
  options: BatchOptions = {},
): Promise<Map<string, BatchItemResult>> {
  const {
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    operationName = 'batch',
  } = options;

  if (requests.length === 0) {
    return new Map();
  }

  if (requests.length > MAX_BATCH_SIZE) {
    throw new Error(
      `Batch size ${requests.length} exceeds API limit of ${MAX_BATCH_SIZE} for ${operationName}`,
    );
  }

  // Submit the batch
  let batch;
  try {
    batch = await client.messages.batches.create({
      requests: requests.map((r) => ({
        custom_id: r.customId,
        params: r.params,
      })),
    });
  } catch (err) {
    throw new Error(
      `Batch submission failed for ${operationName}: ${err instanceof Error ? err.message : err}`,
    );
  }

  logger.info(
    { batchId: batch.id, requestCount: requests.length, operation: operationName },
    'Batch submitted',
  );

  // Poll until complete or timeout
  const completedBatch = await pollForCompletion(client, batch.id, {
    pollIntervalMs,
    timeoutMs,
    operationName,
  });

  // Fetch and parse results
  return collectResults(client, completedBatch, operationName);
}

/**
 * Poll a batch until processing_status is 'ended' or timeout.
 */
async function pollForCompletion(
  client: Anthropic,
  batchId: string,
  options: { pollIntervalMs: number; timeoutMs: number; operationName: string },
): Promise<MessageBatch> {
  const deadline = Date.now() + options.timeoutMs;

  while (true) {
    const batch = await client.messages.batches.retrieve(batchId);

    if (batch.processing_status === 'ended') {
      logger.info(
        {
          batchId,
          operation: options.operationName,
          counts: batch.request_counts,
        },
        'Batch processing ended',
      );
      return batch;
    }

    if (Date.now() >= deadline) {
      break;
    }

    const remaining = batch.request_counts.processing;
    const succeeded = batch.request_counts.succeeded;
    logger.debug(
      { batchId, processing: remaining, succeeded, operation: options.operationName },
      'Batch still processing',
    );

    await sleep(Math.min(options.pollIntervalMs, deadline - Date.now()));
  }

  // Timeout — cancel and throw
  logger.warn({ batchId, operation: options.operationName }, 'Batch timed out, canceling');
  try {
    await client.messages.batches.cancel(batchId);
  } catch (cancelErr) {
    logger.warn({ batchId, error: cancelErr }, 'Failed to cancel timed-out batch');
  }
  throw new Error(`Batch ${batchId} timed out after ${options.timeoutMs}ms`);
}

/**
 * Stream JSONL results from a completed batch and return as a Map.
 */
async function collectResults(
  client: Anthropic,
  batch: MessageBatch,
  operationName: string,
): Promise<Map<string, BatchItemResult>> {
  const results = new Map<string, BatchItemResult>();
  const decoder = await client.messages.batches.results(batch.id);

  for await (const entry of decoder) {
    const item = toBatchItemResult(entry);
    results.set(item.customId, item);
  }

  let succeeded = 0;
  results.forEach((r) => { if (r.status === 'succeeded') succeeded++; });
  const failed = results.size - succeeded;
  logger.info(
    { batchId: batch.id, succeeded, failed, operation: operationName },
    'Batch results collected',
  );

  return results;
}

/**
 * Convert an SDK batch result entry to our BatchItemResult.
 */
function toBatchItemResult(entry: MessageBatchIndividualResponse): BatchItemResult {
  const { custom_id, result } = entry;

  if (result.type === 'succeeded') {
    return {
      customId: custom_id,
      status: 'succeeded',
      message: (result as MessageBatchSucceededResult).message,
    };
  }

  if (result.type === 'errored') {
    const errResult = result as MessageBatchErroredResult;
    // ErrorResponse.error is the ErrorObject containing type + message
    const { type, message } = errResult.error.error;
    return {
      customId: custom_id,
      status: 'errored',
      error: { type, message },
    };
  }

  return {
    customId: custom_id,
    status: result.type as 'canceled' | 'expired',
  };
}

/**
 * Extract the text content from a succeeded batch result.
 * Returns null if the result is missing, failed, or has no text blocks.
 */
export function extractText(result: BatchItemResult | undefined): string | null {
  if (!result || result.status !== 'succeeded' || !result.message) {
    return null;
  }

  const text = result.message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

  return text || null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
