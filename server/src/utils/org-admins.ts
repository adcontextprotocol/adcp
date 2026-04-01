/**
 * Shared utility for resolving org admin emails from WorkOS.
 * Used by notification call sites across routes and webhook handlers.
 */

import { WorkOS } from '@workos-inc/node';

/**
 * Get email addresses of org admins and owners from WorkOS.
 */
export async function getOrgAdminEmails(
  workos: WorkOS,
  orgId: string
): Promise<string[]> {
  const orgMemberships = await workos.userManagement.listOrganizationMemberships({
    organizationId: orgId,
  });

  const admins = orgMemberships.data.filter(
    m => m.role?.slug === 'admin' || m.role?.slug === 'owner'
  );

  const emails = await Promise.all(
    admins.map(async m => {
      try {
        const user = await workos.userManagement.getUser(m.userId);
        return user.email || null;
      } catch {
        return null;
      }
    })
  );

  return emails.filter((e): e is string => e !== null);
}
