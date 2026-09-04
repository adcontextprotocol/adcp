/**
 * Dedicated site-admin access mutations.
 *
 * These routes deliberately do not share the generic working-group membership
 * endpoints: the target group is security-sensitive and is always resolved by
 * the database from the server-owned `aao-admin` slug.
 */

import { Router, type Request, type Response } from 'express';
import { invalidateAllAdminStatusCaches } from '../addie/admin-status-cache.js';
import type { AAOAdminAccessMechanism } from '../auth/admin-access.js';
import {
  WorkingGroupDatabase,
  type AAOAdminMembershipAuditMechanism,
} from '../db/working-group-db.js';
import { createLogger } from '../logger.js';
import { requireGlobalAdmin } from '../middleware/auth.js';

const logger = createLogger('aao-admin-routes');
const MAX_REASON_LENGTH = 1_000;
const MAX_USER_ID_LENGTH = 255;

type AdminRequest = Request & { adminAccessMechanism?: AAOAdminAccessMechanism };

function parseMutationInput(body: unknown):
  | { targetUserId: string; reason: string }
  | { error: string; message: string } {
  const value = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const targetUserId = typeof value.workos_user_id === 'string' ? value.workos_user_id.trim() : '';
  const reason = typeof value.reason === 'string' ? value.reason.trim() : '';

  if (!targetUserId) return { error: 'workos_user_id_required', message: 'workos_user_id is required' };
  if (targetUserId.length > MAX_USER_ID_LENGTH) return { error: 'invalid_workos_user_id', message: 'workos_user_id is too long' };
  if (!reason) return { error: 'reason_required', message: 'reason must not be blank' };
  if (reason.length > MAX_REASON_LENGTH) return { error: 'reason_too_long', message: `reason exceeds ${MAX_REASON_LENGTH} characters` };
  return { targetUserId, reason };
}

function isMutationInput(input: ReturnType<typeof parseMutationInput>): input is { targetUserId: string; reason: string } {
  return 'targetUserId' in input;
}

function requireAuditMechanism(req: AdminRequest, res: Response): AAOAdminMembershipAuditMechanism | null {
  if (req.adminAccessMechanism) return req.adminAccessMechanism;
  logger.error({ actorUserId: req.user?.id }, 'Refused AAO site-admin mutation without audit attribution');
  res.status(500).json({
    error: 'admin_authorization_unavailable',
    message: 'Unable to determine the administrator authorization mechanism',
  });
  return null;
}

/** Mount the global-admin-only site-admin grant and revoke endpoints. */
export function createAAOAdminRouter(): Router {
  const router = Router();
  const workingGroupDb = new WorkingGroupDatabase();

  router.post('/grant', ...requireGlobalAdmin, async (req: AdminRequest, res: Response) => {
    const input = parseMutationInput(req.body);
    if (!isMutationInput(input)) return res.status(400).json(input);
    const actorAuthorizationMechanism = requireAuditMechanism(req, res);
    if (!actorAuthorizationMechanism) return;

    try {
      const membership = await workingGroupDb.grantAAOAdminMembership({
        targetUserId: input.targetUserId,
        actorUserId: req.user!.id,
        actorAuthorizationMechanism,
        reason: input.reason,
      });
      // This replica stops honoring an existing positive result immediately.
      invalidateAllAdminStatusCaches();
      return res.status(201).json({ membership });
    } catch (error) {
      logger.error({ err: error, actorUserId: req.user?.id }, 'AAO site-admin grant failed');
      return res.status(500).json({ error: 'aao_admin_grant_failed', message: 'Failed to grant site-admin access' });
    }
  });

  router.post('/revoke', ...requireGlobalAdmin, async (req: AdminRequest, res: Response) => {
    const input = parseMutationInput(req.body);
    if (!isMutationInput(input)) return res.status(400).json(input);
    const actorAuthorizationMechanism = requireAuditMechanism(req, res);
    if (!actorAuthorizationMechanism) return;

    try {
      const revokedUserId = await workingGroupDb.revokeAAOAdminMembership({
        targetUserId: input.targetUserId,
        actorUserId: req.user!.id,
        actorAuthorizationMechanism,
        reason: input.reason,
      });
      if (!revokedUserId) return res.status(404).json({ error: 'aao_admin_membership_not_found', message: 'User does not have site-admin access' });
      invalidateAllAdminStatusCaches();
      return res.json({ success: true });
    } catch (error) {
      logger.error({ err: error, actorUserId: req.user?.id }, 'AAO site-admin revoke failed');
      return res.status(500).json({ error: 'aao_admin_revoke_failed', message: 'Failed to revoke site-admin access' });
    }
  });

  return router;
}
