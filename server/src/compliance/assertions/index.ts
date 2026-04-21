/**
 * Compliance assertions registered against `@adcp/client`'s storyboard
 * runner (adcontextprotocol/adcp#2639). Importing this module registers
 * every assertion this repo ships — callers that drive storyboards via
 * `runStoryboard` should import it once at startup so that any storyboard
 * referencing an assertion id in its `invariants: [...]` list resolves
 * cleanly.
 *
 * `context.no_secret_echo` and `idempotency.conflict_no_payload_leak` are now
 * shipped by `@adcp/client` as built-in default invariants (see
 * `default-invariants.js` in the SDK); the local registrations that used to
 * live here were removed in the 5.8 upgrade.
 */

import './governance-denial-blocks-mutation.js';

export { ASSERTION_ID as GOVERNANCE_DENIAL_BLOCKS_MUTATION } from './governance-denial-blocks-mutation.js';
