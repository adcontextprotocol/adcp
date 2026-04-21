/**
 * Compliance assertions registered against `@adcp/client`'s storyboard
 * runner (adcontextprotocol/adcp#2639). Importing this module registers
 * every assertion this repo ships — callers that drive storyboards via
 * `runStoryboard` should import it once at startup so that any storyboard
 * referencing an assertion id in its `invariants: [...]` list resolves
 * cleanly.
 */

import './context-no-secret-echo.js';
import './idempotency-conflict-no-payload-leak.js';
import './governance-denial-blocks-mutation.js';

export { ASSERTION_ID as CONTEXT_NO_SECRET_ECHO } from './context-no-secret-echo.js';
export { ASSERTION_ID as IDEMPOTENCY_CONFLICT_NO_PAYLOAD_LEAK } from './idempotency-conflict-no-payload-leak.js';
export { ASSERTION_ID as GOVERNANCE_DENIAL_BLOCKS_MUTATION } from './governance-denial-blocks-mutation.js';
