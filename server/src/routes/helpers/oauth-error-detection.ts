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
  return /requires OAuth authorization/i.test(error)
    || /(^|[^A-Z0-9_])(AUTH_MISSING|AUTH_REQUIRED)($|[^A-Z0-9_])/.test(error);
}
