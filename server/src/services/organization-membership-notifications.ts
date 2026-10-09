import type { WorkOS } from '@workos-inc/node';
import {
  OrganizationDatabase, getSeatUsage, getSeatLimits, resolveMembershipTier,
  checkAndUpdateSeatWarning, resetSeatWarningIfNeeded, type SeatType,
} from '../db/organization-db.js';
import { getOrgAdminEmails } from '../utils/org-admins.js';
import { notifyMemberAdded, notifySeatWarning, notifySeatFreed, notifySeatRequest } from '../slack/org-group-dm.js';

// These helpers run only after the membership transaction and required audit
// commit. Notification delivery never supplies authority or changes its result.
export async function notifyMembershipSeats(workos: WorkOS, orgId: string, change: 'added' | 'upgraded' | 'freed', added?: { email: string; role: string; seat: SeatType }): Promise<void> {
  const org = await new OrganizationDatabase().getOrganization(orgId);
  const orgName = org?.name ?? 'Organization';
  const tier = resolveMembershipTier(org);
  const seatLimits = getSeatLimits(tier);
  const seatUsage = await getSeatUsage(orgId);
  const adminEmails = await getOrgAdminEmails(workos, orgId);
  if (added && adminEmails.length) await notifyMemberAdded({ orgId, orgName, adminEmails, memberEmail: added.email, role: added.role, seatType: added.seat, seatUsage, seatLimits });
  if (change === 'freed') {
    const previous = await resetSeatWarningIfNeeded(orgId, 'contributor', seatUsage.contributor, seatLimits.contributor);
    if (previous >= 80 && adminEmails.length) await notifySeatFreed({ orgId, orgName, adminEmails, seatType: 'contributor', usage: seatUsage.contributor, limit: seatLimits.contributor });
    return;
  }
  for (const seat of (change === 'added' ? ['contributor', 'community'] : ['contributor']) as Array<'contributor' | 'community'>) {
    const usage = seat === 'contributor' ? seatUsage.contributor : seatUsage.community_only;
    const limit = seat === 'contributor' ? seatLimits.contributor : seatLimits.community;
    const warning = await checkAndUpdateSeatWarning(orgId, seat, usage, limit, tier);
    if (warning?.shouldNotify && adminEmails.length) await notifySeatWarning({ orgId, orgName, adminEmails, seatType: seat, threshold: warning.threshold, usage, limit });
  }
}

export async function notifyMembershipSeatRequest(workos: WorkOS, orgId: string, actorId: string, resourceType: string, resourceName?: string): Promise<void> {
  const org = await new OrganizationDatabase().getOrganization(orgId);
  const member = await workos.userManagement.getUser(actorId);
  const adminEmails = await getOrgAdminEmails(workos, orgId);
  if (adminEmails.length) await notifySeatRequest({ orgId, orgName: org?.name ?? 'Organization', adminEmails, memberName: [member.firstName, member.lastName].filter(Boolean).join(' ') || member.email, memberEmail: member.email, resourceType, resourceName });
}
