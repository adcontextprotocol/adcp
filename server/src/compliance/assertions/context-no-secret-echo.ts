/**
 * Assertion: `context.no_secret_echo`.
 *
 * Every step response — success or error — MUST NOT echo back authentication
 * credentials the runner sent. In practice that means: no `Authorization:
 * Bearer <token>` literals anywhere in the body, no verbatim occurrence of
 * the test-kit's declared `api_key`, and no `authorization` / `api_key`
 * property name at any depth in the response payload.
 *
 * Motivation: once an agent mishandles auth on the error path (e.g. a 500
 * handler that serializes the incoming request for "debugging"), a stolen
 * bearer token can be confirmed by observing whether it reappears in the
 * response. The `universal/security.yaml` reviewer checklist flags this
 * manually; this assertion converts it into a programmatic gate that fires
 * on every storyboard that opts in.
 *
 * See adcontextprotocol/adcp#2639 for the invariants framework.
 */

import {
  registerAssertion,
  type AssertionContext,
  type AssertionSpec,
  type AssertionResult,
  type StoryboardStepResult,
} from '@adcp/client/testing';

export const ASSERTION_ID = 'context.no_secret_echo';

const BEARER_PATTERN = /\bbearer\s+[A-Za-z0-9._~+/=-]{10,}/i;
const SUSPECT_KEYS = new Set(['authorization', 'api_key', 'apikey', 'bearer', 'x-api-key']);

interface State {
  apiKey?: string;
}

/**
 * Walk `value` and apply `check(token)` to every string encountered, plus
 * `keyCheck(key)` to every object property name. First non-null return from
 * either wins and short-circuits the walk.
 */
function findSecret(
  value: unknown,
  check: (s: string) => string | null,
  keyCheck: (k: string) => string | null
): string | null {
  if (typeof value === 'string') return check(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findSecret(item, check, keyCheck);
      if (hit) return hit;
    }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const keyHit = keyCheck(key);
      if (keyHit) return keyHit;
      const hit = findSecret(v, check, keyCheck);
      if (hit) return hit;
    }
  }
  return null;
}

function onStart(ctx: AssertionContext): void {
  const testKit = ctx.options.test_kit as { auth?: { api_key?: string } } | undefined;
  const apiKey = testKit?.auth?.api_key;
  // Only treat the declared api_key as a secret to hunt for if it looks
  // non-trivial — short placeholder strings would generate false positives.
  if (typeof apiKey === 'string' && apiKey.length >= 8) {
    (ctx.state as State).apiKey = apiKey;
  }
}

function onStep(
  ctx: AssertionContext,
  stepResult: StoryboardStepResult
): Omit<AssertionResult, 'assertion_id' | 'scope'>[] {
  const body = stepResult.response;
  if (body === undefined || body === null) return [];

  const state = ctx.state as State;
  const apiKey = state.apiKey;

  const hit = findSecret(
    body,
    token => {
      if (BEARER_PATTERN.test(token)) return 'bearer token literal';
      if (apiKey && token.includes(apiKey)) return 'test-kit api_key value';
      return null;
    },
    key => (SUSPECT_KEYS.has(key.toLowerCase()) ? `suspect field "${key}"` : null)
  );

  if (hit) {
    return [
      {
        passed: false,
        description: 'response body leaked credentials back to the caller',
        error: `step "${stepResult.step_id}" response contains ${hit}`,
      },
    ];
  }
  return [];
}

export const spec: AssertionSpec = {
  id: ASSERTION_ID,
  description: 'Responses must not echo authentication credentials (bearer tokens, api keys, Authorization header values)',
  onStart,
  onStep,
};

registerAssertion(spec);
