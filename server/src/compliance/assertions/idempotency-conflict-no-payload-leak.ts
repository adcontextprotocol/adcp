/**
 * Assertion: `idempotency.conflict_no_payload_leak`.
 *
 * `IDEMPOTENCY_CONFLICT` error bodies MUST NOT contain any fields from the
 * cached request. The reviewer check on `universal/idempotency.yaml`
 * (`key_reuse_conflict` phase) states it explicitly: leaking the cached
 * payload turns idempotency-key reuse into a read oracle for an attacker
 * who stole a key. This assertion converts that manual review into a
 * programmatic gate: the error response for a key-reuse conflict must
 * carry only `code` + `message`, with no trace of budgets, dates,
 * product ids, or idempotency keys anywhere in the payload.
 *
 * See adcontextprotocol/adcp#2639.
 */

import {
  registerAssertion,
  type AssertionContext,
  type AssertionSpec,
  type AssertionResult,
  type StoryboardStepResult,
} from '@adcp/client/testing';

export const ASSERTION_ID = 'idempotency.conflict_no_payload_leak';

/**
 * Keys that are safe on a conflict response. Any other property name
 * inside the error body counts as a leak. Keeping the allowlist minimal
 * forces sellers to return code + message and nothing else.
 */
const ALLOWED_ERROR_KEYS = new Set([
  'code',
  'message',
  'status',
  'retry_after',
  'correlation_id',
  'request_id',
  'operation_id',
]);

const CONFLICT_CODES = new Set(['IDEMPOTENCY_CONFLICT', 'CONFLICT']);

function collectLeakedKeys(value: unknown, allowed: Set<string>): string[] {
  const leaked: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }
    if (v !== null && typeof v === 'object') {
      for (const [key, inner] of Object.entries(v as Record<string, unknown>)) {
        if (!allowed.has(key)) leaked.push(key);
        walk(inner);
      }
    }
  };
  walk(value);
  return leaked;
}

function extractErrorCode(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const record = body as Record<string, unknown>;
  if (typeof record.code === 'string') return record.code;
  if (typeof record.error_code === 'string') return record.error_code;
  const err = record.error;
  if (err && typeof err === 'object') {
    const errRec = err as Record<string, unknown>;
    if (typeof errRec.code === 'string') return errRec.code;
  }
  return undefined;
}

function pickErrorBody(stepResult: StoryboardStepResult): unknown {
  // `response` is the parsed body whether the step succeeded or errored.
  // `error` carries the unwrapped error payload on failures. Prefer the
  // richer structure and fall back to the raw string.
  if (stepResult.response !== undefined && stepResult.response !== null) return stepResult.response;
  return stepResult.error;
}

function onStep(
  _ctx: AssertionContext,
  stepResult: StoryboardStepResult
): Omit<AssertionResult, 'assertion_id' | 'scope'>[] {
  // This assertion only applies to conflict rejections. Non-error steps and
  // other error codes get a clean pass.
  if (!stepResult.expect_error) return [];
  const body = pickErrorBody(stepResult);
  const code = extractErrorCode(body);
  if (!code || !CONFLICT_CODES.has(code)) return [];

  const leaked = collectLeakedKeys(body, ALLOWED_ERROR_KEYS);
  if (leaked.length === 0) {
    return [
      {
        passed: true,
        description: `${code} response carries only allowlisted fields`,
      },
    ];
  }
  const dedup = [...new Set(leaked)].sort();
  return [
    {
      passed: false,
      description: `${code} response leaked non-allowlisted fields from the cached request`,
      error: `step "${stepResult.step_id}" body contained: ${dedup.join(', ')}`,
    },
  ];
}

export const spec: AssertionSpec = {
  id: ASSERTION_ID,
  description:
    'IDEMPOTENCY_CONFLICT error bodies must not contain cached request payload fields — only code + message',
  onStep,
};

registerAssertion(spec);
