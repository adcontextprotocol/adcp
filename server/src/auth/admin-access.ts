import type { AuthorizationSnapshot } from '../db/user-authorization-snapshot-db.js';

/**
 * Shared platform-admin authority vocabulary.
 *
 * `ADMIN_EMAILS` is deliberately configuration-only break-glass access. Keep
 * its parsing and decision labels here so audit and diagnostics cannot drift
 * from enforcement.
 */

export type AAOAdminAccessMechanism =
  | 'aao_admin_working_group'
  | 'break_glass_admin_email'
  | 'static_admin_api_key'
  | 'development';

export interface AAOAdminAccessDecision {
  isAdmin: boolean;
  mechanism: AAOAdminAccessMechanism | null;
}

/**
 * Email-based authority comes only from this request's primary-DB snapshot.
 * A pending intent can precede any epoch change, so epoch freshness alone is
 * insufficient. Missing state and unverified credentials never grant access.
 */
export function isBreakGlassAdmin(snapshot: AuthorizationSnapshot | null | undefined): boolean {
  if (!snapshot || snapshot.credential.emailMutationPending !== false
      || snapshot.credential.emailVerified !== true) return false;
  const email = snapshot.credential.email;
  if (!email) return false;
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) return false;

  return (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .some((configuredEmail) => configuredEmail.trim().toLowerCase() === normalizedEmail);
}

/** Classify a membership result without duplicating break-glass interpretation. */
export function decideAAOAdminAccess(
  isAdminByWorkingGroup: boolean,
  snapshot: AuthorizationSnapshot | null | undefined,
): AAOAdminAccessDecision {
  if (isAdminByWorkingGroup) return { isAdmin: true, mechanism: 'aao_admin_working_group' };
  if (isBreakGlassAdmin(snapshot)) return { isAdmin: true, mechanism: 'break_glass_admin_email' };
  return { isAdmin: false, mechanism: null };
}
