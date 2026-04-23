/**
 * Literal allowlist of system-automation identifiers that bypass per-user
 * caps (tool-rate-limiter, claude-cost-tracker, any future per-user gate).
 *
 * Prefix-matching on `system:` was historically fragile because
 * dev-mode cookies can produce any `workos_user_id`, including one
 * that starts with the `system:` prefix. Callers must check the
 * identifier against this exact set so a misrouted session can't
 * trivially bypass enforcement by naming itself something like
 * `system:evil`.
 *
 * Adding a new system caller: add both the identifier here AND a code
 * path that always passes the identifier to the claude-client /
 * tool-rate-limiter. PR review catches the missing path because the
 * absence of this import is immediately visible.
 */
export const SYSTEM_USER_IDS: ReadonlySet<string> = new Set([
  'system:addie',
  'system:sage',
  'system:scope3_seed',
  'system:logo-service',
  'system:google-alias-merge',
]);
