import type { Request, RequestHandler, Router } from 'express';
import type { OrganizationMembership, Invitation } from '@workos-inc/node';
import { requireAuth } from '../middleware/auth.js';
import { invitationRateLimiter } from '../middleware/rate-limit.js';
import { validateEmail } from '../middleware/validation.js';
import { invalidateMembershipCache } from '../db/org-filters.js';
import type { JoinRequest } from '../db/join-request-db.js';
import type { SeatType, SeatUpgradeRequest } from '../db/organization-db.js';
import {
  MembershipMutationError, OrganizationMembershipMutation as Mutation,
  isMembershipRole, mutationDenied, type MutationReply, type Role,
} from '../services/organization-membership-mutation.js';
import { createLogger } from '../logger.js';
import { notifyMemberSeatChanged } from '../slack/org-group-dm.js';
import { notifyMembershipSeats, notifyMembershipSeatRequest } from '../services/organization-membership-notifications.js';

const logger = createLogger('organization-membership-routes');
function invalid(message: string): never { throw new MembershipMutationError(400, message); }
function conflict(message: string): never { throw new MembershipMutationError(409, message); }
function notFound(message: string): never { throw new MembershipMutationError(404, message); }

function emailInput(value: unknown): string {
  if (typeof value !== 'string') invalid('email is required');
  const result = validateEmail(value);
  if (!result.valid) invalid(result.error ?? 'Invalid email');
  return value.trim().toLowerCase();
}
function roleInput(value: unknown, allowOwner = true): Role {
  const role = value === undefined ? 'member' : value;
  if (!isMembershipRole(role) || (!allowOwner && role === 'owner')) invalid('Invalid role');
  return role;
}
function seatInput(value: unknown): SeatType {
  if (value === undefined) return 'community_only';
  if (value !== 'contributor' && value !== 'community_only') invalid('Invalid seat type');
  return value;
}
function assignRole(tx: Mutation, role: Role): void {
  if (role === 'owner' && tx.role !== 'owner' && !tx.platformAdmin) mutationDenied('Only owners can assign the owner role');
}
function memberBinding(tx: Mutation, member: OrganizationMembership, userId?: string): void {
  if (member.organizationId !== tx.orgId || (userId !== undefined && member.userId !== userId)) notFound('Member not found');
  if (member.status !== 'active' || !isMembershipRole(member.role?.slug)) conflict('Member is not active');
}

function expectMember(tx: Mutation, member: OrganizationMembership): void {
  const { id, userId, organizationId, status } = member;
  const role = member.role.slug;
  tx.expectTarget(id, async () => {
    const current = await tx.workos.userManagement.getOrganizationMembership(id);
    if (current.id !== id || current.userId !== userId || current.organizationId !== organizationId
      || current.status !== status || current.role?.slug !== role) conflict('Target membership changed; retry the request');
  });
}

function expectInvitation(tx: Mutation, invitation: Invitation, expectedState = invitation.state): void {
  const { id, organizationId, email } = invitation;
  tx.expectTarget(id, async () => {
    const current = await tx.workos.userManagement.getInvitation(id);
    if (current.id !== id || current.organizationId !== organizationId || current.email !== email || current.state !== expectedState
      || (expectedState === 'pending' && Date.parse(current.expiresAt) <= Date.now())) conflict('Invitation changed; retry the request');
  });
}

async function targetMember(tx: Mutation, id: string, userId?: string): Promise<OrganizationMembership> {
  const member = await tx.readProvider(() => tx.workos.userManagement.getOrganizationMembership(id));
  if (member.id !== id) notFound('Member not found');
  memberBinding(tx, member, userId);
  const [local] = await tx.rows('SELECT workos_membership_id, role FROM organization_memberships WHERE workos_organization_id = $1 AND workos_user_id = $2', [tx.orgId, member.userId]);
  if (!local || local.workos_membership_id !== member.id || local.role !== member.role.slug) conflict('Membership mirror is not current; retry after synchronization');
  expectMember(tx, member);
  return member;
}

async function lastOwner(tx: Mutation, member: OrganizationMembership, role: Role): Promise<void> {
  if (member.role.slug !== 'owner' || role === 'owner') return;
  let after: string | undefined;
  const cursors = new Set<string>();
  const owners = new Map<string, OrganizationMembership>();
  do {
    const page = await tx.readProvider(() => tx.workos.userManagement.listOrganizationMemberships({ organizationId: tx.orgId, statuses: ['active'], limit: 100, after }));
    for (const row of page.data) {
      if (row.organizationId === tx.orgId && row.status === 'active' && row.role?.slug === 'owner') owners.set(row.userId, row);
    }
    after = page.listMetadata?.after ?? undefined;
    if (after && cursors.has(after)) throw new MembershipMutationError(503, 'Owner inventory unavailable');
    if (after) cursors.add(after);
  } while (after);
  const localOwners = await tx.rows<{ workos_user_id: string; workos_membership_id: string }>("SELECT workos_user_id, workos_membership_id FROM organization_memberships WHERE workos_organization_id = $1 AND role = 'owner'", [tx.orgId]);
  const survivor = localOwners.find(row => row.workos_user_id !== member.userId && owners.get(row.workos_user_id)?.id === row.workos_membership_id);
  if (!owners.has(member.userId) || !survivor) conflict('The last owner cannot be demoted');
  expectMember(tx, owners.get(survivor.workos_user_id)!);
  tx.expectTarget(`owner-mirror:${survivor.workos_user_id}`, async () => {
    const rows = await tx.rows("SELECT 1 FROM organization_memberships WHERE workos_organization_id = $1 AND workos_user_id = $2 AND workos_membership_id = $3 AND role = 'owner'", [tx.orgId, survivor.workos_user_id, survivor.workos_membership_id]);
    if (rows.length !== 1) conflict('The remaining owner changed; retry the request');
  });
}

async function roleChangeAllowed(tx: Mutation, member: OrganizationMembership, role: Role): Promise<void> {
  if (member.userId === tx.actorId) invalid('Cannot change own role');
  assignRole(tx, role);
  if (member.role.slug === 'owner' && tx.role !== 'owner' && !tx.platformAdmin) mutationDenied("Only owners can change another owner's role");
  await lastOwner(tx, member, role);
}

async function insertMember(tx: Mutation, member: OrganizationMembership, email: string, seat: SeatType): Promise<void> {
  await tx.write(
    `INSERT INTO organization_memberships (workos_user_id, workos_organization_id, workos_membership_id, email, role, seat_type, provisioning_source)
     VALUES ($1, $2, $3, $4, $5, $6, 'admin_added')
     ON CONFLICT (workos_user_id, workos_organization_id) DO UPDATE
       SET role = EXCLUDED.role, seat_type = EXCLUDED.seat_type, updated_at = NOW()
       WHERE organization_memberships.workos_membership_id = EXCLUDED.workos_membership_id
         AND organization_memberships.role = EXCLUDED.role
     RETURNING id`, [member.userId, tx.orgId, member.id, email, member.role.slug, seat],
  );
}

async function createMember(tx: Mutation, userId: string, role: Role): Promise<OrganizationMembership> {
  assignRole(tx, role);
  const member = await tx.providerWrite('create_membership', { user_id: userId, role }, () => tx.workos.userManagement.createOrganizationMembership({ userId, organizationId: tx.orgId, roleSlug: role }), async created => {
    // Never delete an unrelated or subsequently promoted membership as compensation.
    const current = await tx.workos.userManagement.getOrganizationMembership(created.id);
    if (current.userId !== userId || current.organizationId !== tx.orgId || current.role?.slug !== role || current.status !== 'active') throw new Error('Created membership changed; manual reconciliation required');
    await tx.workos.userManagement.deleteOrganizationMembership(created.id);
  });
  memberBinding(tx, member, userId);
  if (member.role.slug !== role) throw new MembershipMutationError(503, 'Provider role does not match requested role');
  expectMember(tx, member);
  return member;
}

async function stageInvitation(tx: Mutation, invitation: Invitation, email: string, seat: SeatType): Promise<void> {
  await tx.write(
    `INSERT INTO invitation_seat_types (workos_invitation_id, workos_organization_id, email, seat_type, source)
     VALUES ($1, $2, $3, $4, 'invited') RETURNING workos_invitation_id`,
    [invitation.id, tx.orgId, email, seat],
  );
}
async function sendInvitation(tx: Mutation, email: string, role: Role): Promise<Invitation> {
  assignRole(tx, role);
  const invitation = await tx.providerWrite('send_invitation', { email, role }, () => tx.workos.userManagement.sendInvitation({
    email, organizationId: tx.orgId, roleSlug: role, ...(tx.staticAdmin ? {} : { inviterUserId: tx.actorId }),
  }), async created => {
    const current = await tx.workos.userManagement.getInvitation(created.id);
    if (current.organizationId !== tx.orgId || current.email.toLowerCase() !== email || current.state !== 'pending') throw new Error('Invitation changed; manual reconciliation required');
    await tx.workos.userManagement.revokeInvitation(created.id);
  });
  if (invitation.organizationId !== tx.orgId || invitation.email.toLowerCase() !== email || invitation.state !== 'pending') throw new MembershipMutationError(503, 'Provider invitation does not match the request');
  expectInvitation(tx, invitation);
  return invitation;
}

async function pendingInvitation(tx: Mutation, id: string): Promise<Invitation> {
  const invitation = await tx.readProvider(() => tx.workos.userManagement.getInvitation(id));
  if (invitation.id !== id || invitation.organizationId !== tx.orgId) notFound('Invitation not found');
  if (invitation.state !== 'pending' || Date.parse(invitation.expiresAt) <= Date.now()) conflict('Invitation is not pending');
  expectInvitation(tx, invitation);
  return invitation;
}

function invitationReply(invitation: Invitation): Record<string, unknown> {
  return { id: invitation.id, email: invitation.email, state: invitation.state, expires_at: invitation.expiresAt, accept_invitation_url: invitation.acceptInvitationUrl };
}

function handler(minimumRole: Role, allowPlatformAdmin: boolean, operation: (tx: Mutation, req: Request) => Promise<MutationReply>): RequestHandler {
  return async (req, res) => {
    try {
      const result = await Mutation.run(req, minimumRole, allowPlatformAdmin, tx => operation(tx, req));
      res.status(result.status ?? 200).json(result.body);
    } catch (error) {
      const status = error instanceof MembershipMutationError ? error.status : 503;
      if (!(error instanceof MembershipMutationError)) logger.error({ error }, 'Membership mutation unavailable');
      res.status(status).json({ error: error instanceof MembershipMutationError ? error.message : 'Membership service unavailable' });
    }
  };
}

export function registerOrganizationMembershipMutations(router: Router): void {
  for (const decision of ['approve', 'reject'] as const) {
    router.post(`/:orgId/join-requests/:requestId/${decision}`, requireAuth, handler('admin', false, async (tx, req) => {
      const role = roleInput(req.body?.role, false);
      // Hold the request row through the provider call and local commit. A requester
      // cancellation uses a conditional UPDATE on this same row, so approval and
      // cancellation now have one database serialization point instead of allowing
      // a provider membership to be created from a stale pending snapshot.
      const [join] = await tx.rows<JoinRequest>(
        'SELECT * FROM organization_join_requests WHERE id = $1 AND workos_organization_id = $2 FOR UPDATE',
        [req.params.requestId, tx.orgId],
      );
      if (!join) notFound('Request not found');
      if (join.status !== 'pending') conflict('Request not pending');
      if (req.body?.reason !== undefined && typeof req.body.reason !== 'string') invalid('Invalid rejection reason');
      let member: OrganizationMembership | undefined;
      if (decision === 'approve') {
        await tx.requireTeam();
        await tx.seatAvailable('community_only');
        member = await createMember(tx, join.workos_user_id, role);
      }
      await tx.local([join.workos_user_id], async () => {
        if (member) await insertMember(tx, member, join.user_email, 'community_only');
        await tx.write(
          `UPDATE organization_join_requests SET status = $1, handled_by_user_id = $2, handled_at = NOW(), rejection_reason = $3, updated_at = NOW()
           WHERE id = $4 AND workos_organization_id = $5 AND workos_user_id = $6 AND status = 'pending' RETURNING id`,
          [decision === 'approve' ? 'approved' : 'rejected', tx.actorId, decision === 'reject' ? req.body?.reason ?? null : null, join.id, tx.orgId, join.workos_user_id],
        );
        await tx.audit(decision === 'approve' ? 'join_request_approved' : 'join_request_rejected', 'join_request', join.id, { requester_user_id: join.workos_user_id, role_assigned: member ? role : undefined });
      });
      if (member) tx.afterCommit.push(() => notifyMembershipSeats(tx.workos, tx.orgId, 'added', { email: join.user_email, role, seat: 'community_only' }));
      return { body: { success: true } };
    }));
  }

  router.post('/:orgId/invitations', requireAuth, invitationRateLimiter, handler('admin', false, async (tx, req) => {
    const email = emailInput(req.body?.email);
    const role = roleInput(req.body?.role);
    const seat = seatInput(req.body?.seat_type);
    assignRole(tx, role);
    await tx.requireTeam();
    await tx.seatAvailable(seat);
    const invitation = await sendInvitation(tx, email, role);
    await tx.local([], async () => {
      await stageInvitation(tx, invitation, email, seat);
      await tx.audit('member_invited', 'invitation', invitation.id, { email, role, seat_type: seat });
    });
    return { body: { success: true, invitation: invitationReply(invitation) } };
  }));

  router.delete('/:orgId/invitations/:invitationId', requireAuth, handler('admin', false, async (tx, req) => {
    const invitation = await pendingInvitation(tx, req.params.invitationId);
    const stages = await tx.rows('SELECT workos_invitation_id FROM invitation_seat_types WHERE workos_invitation_id = $1 AND workos_organization_id = $2', [invitation.id, tx.orgId]);
    await tx.providerWrite('revoke_invitation', { invitation_id: invitation.id }, () => tx.workos.userManagement.revokeInvitation(invitation.id));
    expectInvitation(tx, invitation, 'revoked');
    await tx.local([], async () => {
      await tx.write('DELETE FROM invitation_seat_types WHERE workos_invitation_id = $1 AND workos_organization_id = $2', [invitation.id, tx.orgId], stages.length);
      await tx.audit('invitation_revoked', 'invitation', invitation.id, { email: invitation.email });
    });
    return { body: { success: true, message: 'Invitation revoked successfully' } };
  }));

  router.post('/:orgId/invitations/:invitationId/resend', requireAuth, handler('admin', false, async (tx, req) => {
    const old = await pendingInvitation(tx, req.params.invitationId);
    const stages = await tx.rows<{ seat_type: SeatType }>('SELECT seat_type FROM invitation_seat_types WHERE workos_invitation_id = $1 AND workos_organization_id = $2', [old.id, tx.orgId]);
    const seat = stages[0]?.seat_type ?? 'community_only';
    await tx.requireTeam();
    if (!stages.length) await tx.seatAvailable(seat);
    await tx.providerWrite('revoke_invitation', { invitation_id: old.id }, () => tx.workos.userManagement.revokeInvitation(old.id));
    expectInvitation(tx, old, 'revoked');
    const invitation = await sendInvitation(tx, old.email.toLowerCase(), 'member');
    await tx.local([], async () => {
      await tx.write('DELETE FROM invitation_seat_types WHERE workos_invitation_id = $1 AND workos_organization_id = $2', [old.id, tx.orgId], stages.length);
      await stageInvitation(tx, invitation, old.email, seat);
      await tx.audit('invitation_resent', 'invitation', invitation.id, { email: old.email, old_invitation_id: old.id, seat_type: seat });
    });
    return { body: { success: true, invitation: invitationReply(invitation) } };
  }));

  router.post('/:orgId/domain-users/add', requireAuth, handler('admin', false, async (tx, req) => {
    const email = emailInput(req.body?.email);
    const role = roleInput(req.body?.role, false);
    await tx.requireTeam();
    const domains = await tx.rows<{ domain: string }>('SELECT domain FROM organization_domains WHERE workos_organization_id = $1 AND verified = true', [tx.orgId]);
    if (!domains.some(row => row.domain.toLowerCase() === email.split('@')[1])) invalid('Domain not verified');
    const mappings = await tx.rows<{ workos_user_id: string | null }>('SELECT workos_user_id FROM slack_user_mappings WHERE LOWER(slack_email) = $1', [email]);
    if (mappings.length !== 1) invalid('User mapping not found or ambiguous');
    await tx.seatAvailable('community_only');
    const userId = mappings[0].workos_user_id;
    if (!userId) {
      const invitation = await sendInvitation(tx, email, role);
      await tx.local([], async () => {
        await stageInvitation(tx, invitation, email, 'community_only');
        await tx.audit('member_invited', 'invitation', invitation.id, { email, role, method: 'domain_auto_add' });
      });
      return { body: { success: true, action: 'invited', invitation: invitationReply(invitation) } };
    }
    const user = await tx.readProvider(() => tx.workos.userManagement.getUser(userId));
    if (user.id !== userId || user.email.toLowerCase() !== email) conflict('User mapping is not current');
    const existing = await tx.readProvider(() => tx.workos.userManagement.listOrganizationMemberships({ userId, organizationId: tx.orgId, statuses: ['active', 'inactive', 'pending'] }));
    if (existing.data.some(row => row.userId === userId && row.organizationId === tx.orgId)) conflict('Membership or pending invitation already exists');
    const member = await createMember(tx, userId, role);
    await tx.local([userId], async () => {
      await insertMember(tx, member, email, 'community_only');
      const requests = await tx.rows<{ id: string }>("SELECT id FROM organization_join_requests WHERE workos_organization_id = $1 AND workos_user_id = $2 AND status = 'pending' FOR UPDATE", [tx.orgId, userId]);
      for (const join of requests) await tx.write("UPDATE organization_join_requests SET status = 'cancelled', handled_by_user_id = $1, handled_at = NOW() WHERE id = $2 AND workos_organization_id = $3 AND workos_user_id = $4 AND status = 'pending'", [tx.actorId, join.id, tx.orgId, userId]);
      await tx.audit('member_added', 'membership', member.id, { target_user_id: userId, email, role, method: 'domain_auto_add' });
    });
    tx.afterCommit.push(() => notifyMembershipSeats(tx.workos, tx.orgId, 'added', { email, role, seat: 'community_only' }));
    return { body: { success: true, action: 'added', membership: { id: member.id, userId, role } } };
  }));

  router.post('/:orgId/members/by-email', requireAuth, handler('admin', true, async (tx, req) => {
    const email = emailInput(req.body?.email);
    const role = roleInput(req.body?.role);
    const seat = seatInput(req.body?.seat_type);
    assignRole(tx, role);
    await tx.requireTeam();
    const users = await tx.readProvider(() => tx.workos.userManagement.listUsers({ email }));
    const matches = users.data.filter(user => user.email.toLowerCase() === email);
    if (matches.length > 1) conflict('User email is ambiguous');
    const user = matches[0];
    if (!user) {
      await tx.seatAvailable(seat);
      const invitation = await sendInvitation(tx, email, 'member');
      await tx.local([], async () => {
        await stageInvitation(tx, invitation, email, seat);
        await tx.audit('member_invited', 'invitation', invitation.id, { email, requested_role: role, invited_role: 'member', seat_type: seat, via: 'by_email' });
      });
      return { status: 201, body: { success: true, action: 'invited', invited_role: 'member', requested_role: role, seat_type: seat, invitation: invitationReply(invitation) } };
    }
    const existing = await tx.readProvider(() => tx.workos.userManagement.listOrganizationMemberships({ userId: user.id, organizationId: tx.orgId, statuses: ['active', 'inactive', 'pending'] }));
    const members = existing.data.filter(row => row.userId === user.id && row.organizationId === tx.orgId);
    if (members.length > 1) conflict('Membership is ambiguous');
    if (!members.length) {
      if (user.id === tx.actorId && !tx.platformAdmin) mutationDenied();
      const local = await tx.rows('SELECT id FROM organization_memberships WHERE workos_organization_id = $1 AND workos_user_id = $2', [tx.orgId, user.id]);
      if (local.length) conflict('Membership mirror is not current');
      await tx.seatAvailable(seat);
      const member = await createMember(tx, user.id, role);
      await tx.local([user.id], async () => {
        await insertMember(tx, member, email, seat);
        await tx.audit('member_added', 'membership', member.id, { target_user_id: user.id, target_email: email, role, seat_type: seat, via: 'by_email' });
      });
      return { status: 201, body: { success: true, action: 'membership_created', user_id: user.id, role, seat_type: seat } };
    }
    const member = await targetMember(tx, members[0].id, user.id);
    await roleChangeAllowed(tx, member, role);
    if (member.role.slug === role) return { body: { success: true, action: 'no_change', user_id: user.id, role } };
    const updated = await tx.providerWrite('update_membership_role', { membership_id: member.id, user_id: member.userId, old_role: member.role.slug, new_role: role }, () => tx.workos.userManagement.updateOrganizationMembership(member.id, { roleSlug: role }));
    memberBinding(tx, updated, member.userId);
    if (updated.id !== member.id || updated.role.slug !== role) throw new MembershipMutationError(503, 'Provider role does not match requested role');
    expectMember(tx, updated);
    await tx.local([user.id], async () => {
      await tx.write('UPDATE organization_memberships SET role = $1, updated_at = NOW() WHERE workos_organization_id = $2 AND workos_user_id = $3 AND workos_membership_id = $4 AND role = $5', [role, tx.orgId, user.id, member.id, member.role.slug]);
      await tx.audit('member_role_changed', 'membership', member.id, { target_user_id: user.id, old_role: member.role.slug, new_role: role, via: 'by_email' });
    });
    return { body: { success: true, action: 'role_updated', user_id: user.id, role, previous_role: member.role.slug } };
  }));

  router.patch('/:orgId/members/:membershipId', requireAuth, handler('admin', false, async (tx, req) => {
    if (req.body?.role === undefined && req.body?.seat_type === undefined) invalid('At least one of role or seat_type is required');
    if (req.body?.status !== undefined) invalid('Membership status cannot be changed through this route');
    const role = req.body?.role === undefined ? undefined : roleInput(req.body.role);
    const seat = req.body?.seat_type === undefined ? undefined : seatInput(req.body.seat_type);
    const member = await targetMember(tx, req.params.membershipId);
    if (role) await roleChangeAllowed(tx, member, role);
    const oldSeat = await tx.effectiveSeat(member.userId);
    const [oldLocal] = await tx.rows<{ seat_type: SeatType }>('SELECT seat_type FROM organization_memberships WHERE workos_organization_id = $1 AND workos_user_id = $2', [tx.orgId, member.userId]);
    if (seat === 'contributor' && oldSeat !== 'contributor') await tx.seatAvailable(seat);
    if (role && role !== member.role.slug) {
      const updated = await tx.providerWrite('update_membership_role', { membership_id: member.id, user_id: member.userId, old_role: member.role.slug, new_role: role }, () => tx.workos.userManagement.updateOrganizationMembership(member.id, { roleSlug: role }));
      memberBinding(tx, updated, member.userId);
      if (updated.id !== member.id || updated.role.slug !== role) throw new MembershipMutationError(503, 'Provider role does not match requested role');
      expectMember(tx, updated);
    }
    await tx.local([member.userId], async () => {
      await tx.write('UPDATE organization_memberships SET role = $1, seat_type = COALESCE($2, seat_type), updated_at = NOW() WHERE workos_organization_id = $3 AND workos_user_id = $4 AND workos_membership_id = $5 AND role = $6', [role ?? member.role.slug, seat ?? null, tx.orgId, member.userId, member.id, member.role.slug]);
      if (role) await tx.audit('member_role_changed', 'membership', member.id, { target_user_id: member.userId, old_role: member.role.slug, new_role: role });
      if (seat) await tx.audit('member_seat_type_changed', 'membership', member.id, { target_user_id: member.userId, old_seat_type: oldLocal.seat_type, new_seat_type: seat });
    });
    if (seat && seat !== oldLocal.seat_type) {
      tx.afterCommit.push(() => notifyMemberSeatChanged({ userId: member.userId, newSeatType: seat, context: 'admin_action' }));
      tx.afterCommit.push(() => notifyMembershipSeats(tx.workos, tx.orgId, seat === 'contributor' ? 'upgraded' : 'freed'));
    }
    return { body: { success: true, membership: { id: member.id, user_id: member.userId, role: role ?? member.role.slug, status: member.status, ...(seat ? { seat_type: seat } : {}) } } };
  }));

  router.delete('/:orgId/members/:membershipId', requireAuth, handler('admin', false, async (tx, req) => {
    const member = await targetMember(tx, req.params.membershipId);
    if (member.userId === tx.actorId) invalid('Cannot remove self');
    if (member.role.slug === 'owner') invalid('Cannot remove owner');
    if (member.role.slug === 'admin' && tx.role !== 'owner') mutationDenied('Only owners can remove admins');
    const oldSeat = await tx.effectiveSeat(member.userId);
    await tx.providerWrite('delete_membership', { membership_id: member.id, user_id: member.userId, old_role: member.role.slug }, () => tx.workos.userManagement.deleteOrganizationMembership(member.id));
    tx.expectTarget(member.id, async () => {
      try { await tx.workos.userManagement.getOrganizationMembership(member.id); }
      catch (error) {
        const status = (error as { status?: number; statusCode?: number }).status ?? (error as { statusCode?: number }).statusCode;
        if (status === 404) return;
        throw error;
      }
      conflict('Provider membership deletion is not confirmed');
    });
    await tx.local([member.userId], async () => {
      await tx.write('DELETE FROM organization_memberships WHERE workos_user_id = $1 AND workos_organization_id = $2 AND workos_membership_id = $3 AND role = $4', [member.userId, tx.orgId, member.id, member.role.slug]);
      const primary = await tx.rows<{ workos_user_id: string }>('SELECT workos_user_id FROM users WHERE workos_user_id = $1 AND primary_organization_id = $2', [member.userId, tx.orgId]);
      await tx.write('UPDATE users SET primary_organization_id = NULL, updated_at = NOW() WHERE workos_user_id = $1 AND primary_organization_id = $2', [member.userId, tx.orgId], primary.length);
      await tx.audit('member_removed', 'membership', member.id, { removed_user_id: member.userId, removed_role: member.role.slug });
    });
    tx.afterCommit.push(async () => invalidateMembershipCache(tx.orgId));
    if (oldSeat === 'contributor') tx.afterCommit.push(() => notifyMembershipSeats(tx.workos, tx.orgId, 'freed'));
    return { body: { success: true, message: 'Member removed successfully' } };
  }));

  router.post('/:orgId/seat-requests', requireAuth, invitationRateLimiter, handler('member', false, async (tx, req) => {
    const { resource_type, resource_id, resource_name } = req.body ?? {};
    if (!['working_group', 'council', 'product_summit'].includes(resource_type)) invalid('Invalid resource type');
    if (resource_id !== undefined && (typeof resource_id !== 'string' || resource_id.length > 255)) invalid('Invalid resource_id');
    if (resource_name !== undefined && (typeof resource_name !== 'string' || resource_name.length > 500)) invalid('Invalid resource_name');
    if (await tx.effectiveSeat(tx.actorId) === 'contributor') invalid('Already a contributor');
    let id = '';
    await tx.local([], async () => {
      const [created] = await tx.write<{ id: string }>(
        `INSERT INTO seat_upgrade_requests (workos_organization_id, workos_user_id, resource_type, resource_id, resource_name)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING id`,
        [tx.orgId, tx.actorId, resource_type, resource_id ?? '', resource_name ?? null],
      );
      id = created.id;
      await tx.audit('seat_upgrade_requested', 'seat_upgrade_request', id, { resource_type, resource_id, resource_name });
    });
    tx.afterCommit.push(() => notifyMembershipSeatRequest(tx.workos, tx.orgId, tx.actorId, resource_type, resource_name));
    return { body: { id, status: 'pending' } };
  }));

  for (const decision of ['approve', 'deny'] as const) {
    router.post(`/:orgId/seat-requests/:requestId/${decision}`, requireAuth, handler('admin', false, async (tx, req) => {
      const [seatRequest] = await tx.rows<SeatUpgradeRequest>('SELECT * FROM seat_upgrade_requests WHERE id = $1 AND workos_organization_id = $2', [req.params.requestId, tx.orgId]);
      if (!seatRequest) notFound('Request not found');
      if (seatRequest.status !== 'pending') conflict('Request already resolved');
      let member: OrganizationMembership | undefined;
      if (decision === 'approve') {
        const [local] = await tx.rows<{ workos_membership_id: string }>('SELECT workos_membership_id FROM organization_memberships WHERE workos_organization_id = $1 AND workos_user_id = $2', [tx.orgId, seatRequest.workos_user_id]);
        if (!local?.workos_membership_id) conflict('Target is no longer a member');
        member = await targetMember(tx, local.workos_membership_id, seatRequest.workos_user_id);
        if (await tx.effectiveSeat(member.userId) !== 'contributor') await tx.seatAvailable('contributor');
      }
      const status = decision === 'approve' ? 'approved' : 'denied';
      await tx.local([seatRequest.workos_user_id], async () => {
        if (member) await tx.write("UPDATE organization_memberships SET seat_type = 'contributor', updated_at = NOW() WHERE workos_organization_id = $1 AND workos_user_id = $2 AND workos_membership_id = $3 AND role = $4", [tx.orgId, member.userId, member.id, member.role.slug]);
        await tx.write('UPDATE seat_upgrade_requests SET status = $1, resolved_at = NOW(), resolved_by = $2 WHERE id = $3 AND workos_organization_id = $4 AND workos_user_id = $5 AND status = \'pending\'', [status, tx.actorId, seatRequest.id, tx.orgId, seatRequest.workos_user_id]);
        await tx.audit(decision === 'approve' ? 'seat_upgrade_approved' : 'seat_upgrade_denied', 'seat_upgrade_request', seatRequest.id, { target_user_id: seatRequest.workos_user_id });
      });
      tx.afterCommit.push(() => notifyMemberSeatChanged({ userId: seatRequest.workos_user_id, newSeatType: decision === 'approve' ? 'contributor' : 'community_only', context: decision === 'approve' ? 'request_approved' : 'request_denied', resourceName: seatRequest.resource_name ?? undefined }));
      if (decision === 'approve') tx.afterCommit.push(() => notifyMembershipSeats(tx.workos, tx.orgId, 'upgraded'));
      return { body: { success: true, status } };
    }));
  }
}
