import { OAuthError } from '@adcp/sdk/auth';

const OWNER_REAUTHORIZATION_CODES = new Set([
  'oauth_issuer_required', 'oauth_issuer_mismatch', 'owner_reauthorization_required', 'interactive_required',
]);

// The SDK's storyboard results retain message text rather than OAuthError.code.
// Match only its fixed messages, never an arbitrary mention of OAuth or a code.
const OWNER_REAUTHORIZATION_MESSAGES = new Set([
  'Saved OAuth credentials need a valid issuer. Clear them and sign in again, or set their issuer from trusted configuration.',
  'OAuth credentials belong to a different authorization server.',
  'Authorization-server metadata does not match the discovered issuer.',
  'OAuth owner reauthorization is required; this provider will not automatically clear credentials or register a new client. CLI: adcp <alias> --clear-oauth, then adcp <alias> --oauth.',
  'Saved OAuth credentials need owner authorization. Start a new sign-in; a server without dynamic registration requires an independently trusted client configuration.',
]);

/** Distinguish explicit owner recovery from an ordinary authorization challenge. */
export function isOAuthOwnerReauthorizationError(error: unknown): boolean {
  if (error instanceof OAuthError) return OWNER_REAUTHORIZATION_CODES.has(error.code ?? '');
  const message = error instanceof Error ? error.message : error;
  return typeof message === 'string' && OWNER_REAUTHORIZATION_MESSAGES.has(message);
}

/**
 * Detect when a storyboard step's error string signals that the user must
 * (re)authorize via OAuth. The @adcp/sdk SDK catches its own
 * `NeedsAuthorizationError` inside `runStep` and preserves only `err.message`
 * on the step result, so by the time runStoryboardStep / comply return we
 * only have a string. Two shapes map to "user must (re)authorize":
 *
 * - Transport 401 with WWW-Authenticate: Bearer → SDK's
 *   `NeedsAuthorizationError` message begins with
 *   "Agent <url> requires OAuth authorization."
 * - Agent returns an AdCP `AUTH_MISSING` error payload (200 body) when it
 *   accepted the token at the transport layer but rejected it at the
 *   application layer — common when a saved token has gone stale.
 *   `AUTH_REQUIRED` is the deprecated predecessor; matched during the 3.x window.
 *   `AUTH_INVALID` (terminal — credentials rejected) is intentionally excluded:
 *   it indicates revoked/expired credentials that need human rotation, not a
 *   re-authorization prompt.
 */
export function isOAuthRequiredErrorMessage(error: string | null | undefined): boolean {
  if (!error) return false;
  return isOAuthOwnerReauthorizationError(error)
    || /requires OAuth authorization/i.test(error)
    || /(^|[^A-Z0-9_])(AUTH_MISSING|AUTH_REQUIRED)($|[^A-Z0-9_])/.test(error);
}
