/**
 * Override hook for SDK-shipped compliance assertions.
 *
 * `@adcp/client` 5.9.0 ships three cross-step invariants as built-in
 * defaults:
 *
 *   - `context.no_secret_echo`
 *   - `idempotency.conflict_no_payload_leak`
 *   - `governance.denial_blocks_mutation`
 *
 * The SDK's `context.no_secret_echo` default is a no-op against structured
 * `auth` objects (bearer/basic/oauth discriminated union): it pushes the
 * object reference into the secret set, then scans for it via
 * `String.includes(obj)` which coerces to `[object Object]` and matches
 * nothing. Tracked upstream at adcp-client#751 — the fix adds an
 * `{ override: true }` option to `registerAssertion` plus the structural
 * secret extractor we've already implemented locally.
 *
 * Until 5.9.1 lands, `registerAssertion` throws on duplicate ids, so we
 * can't just re-register our strict implementation. Workaround:
 * snapshot every SDK default via `getAssertion()`, call
 * `clearAssertionRegistry()` to drop them all, re-register the defaults
 * we want to keep (everything except context.no_secret_echo), then
 * register our strict `context.no_secret_echo` implementation in its
 * place.
 *
 * When 5.9.1 ships: replace this module with a single
 * `registerAssertion(contextSpec, { override: true })` call.
 */

import {
  registerAssertion,
  clearAssertionRegistry,
  listAssertions,
  getAssertion,
  type AssertionSpec,
} from '@adcp/client/testing';
// Side effect: register SDK defaults on first import.
import '@adcp/client/testing';
import { spec as strictContextSpec, ASSERTION_ID as CONTEXT_NO_SECRET_ECHO } from './context-no-secret-echo.js';

let installed = false;

/**
 * Install our stricter `context.no_secret_echo` while preserving every other
 * SDK default. Idempotent across multiple imports (the storyboard runner,
 * the manual runners, the storyboard service all import this module).
 */
function installStrictOverrides(): void {
  if (installed) return;
  installed = true;

  // Snapshot every default the SDK has registered.
  const preserved: AssertionSpec[] = [];
  for (const id of listAssertions()) {
    if (id === CONTEXT_NO_SECRET_ECHO) continue;
    const spec = getAssertion(id);
    if (spec) preserved.push(spec);
  }

  clearAssertionRegistry();
  for (const spec of preserved) registerAssertion(spec);
  registerAssertion(strictContextSpec);
}

installStrictOverrides();

export { CONTEXT_NO_SECRET_ECHO };
