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

export function isBreakGlassAdminEmail(email: string | null | undefined): boolean {
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
  email: string | null | undefined,
): AAOAdminAccessDecision {
  if (isAdminByWorkingGroup) return { isAdmin: true, mechanism: 'aao_admin_working_group' };
  if (isBreakGlassAdminEmail(email)) return { isAdmin: true, mechanism: 'break_glass_admin_email' };
  return { isAdmin: false, mechanism: null };
}
