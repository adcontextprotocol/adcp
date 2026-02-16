/**
 * Ban management and registry activity routes
 */

import { Router } from 'express';
import { createLogger } from '../../logger.js';
import { requireAuth, requireAdmin, invalidateBanCache } from '../../middleware/auth.js';
import { serveHtmlWithConfig } from '../../utils/html-config.js';
import { bansDb } from '../../db/bans-db.js';
import { getPool } from '../../db/client.js';
import type { BanType, BanScope } from '../../db/bans-db.js';

const logger = createLogger('admin-bans');

const VALID_BAN_TYPES: BanType[] = ['user', 'organization', 'api_key'];
const VALID_SCOPES: BanScope[] = ['platform', 'registry_brand', 'registry_property'];

export function setupBanRoutes(pageRouter: Router, apiRouter: Router): void {
  // Page route
  pageRouter.get('/bans', requireAuth, requireAdmin, (req, res) => {
    serveHtmlWithConfig(req, res, 'admin-bans.html').catch((err) => {
      logger.error({ err }, 'Error serving admin bans page');
      res.status(500).send('Internal server error');
    });
  });

  // GET /api/admin/bans - List active bans
  apiRouter.get('/bans', requireAuth, requireAdmin, async (req, res) => {
    try {
      const banType = req.query.ban_type as string | undefined;
      const scope = req.query.scope as string | undefined;
      const entityId = req.query.entity_id as string | undefined;

      const bans = await bansDb.listBans({
        ban_type: banType && VALID_BAN_TYPES.includes(banType as BanType)
          ? banType as BanType : undefined,
        scope: scope && VALID_SCOPES.includes(scope as BanScope)
          ? scope as BanScope : undefined,
        entity_id: entityId,
      });

      res.json({ bans });
    } catch (error) {
      logger.error({ err: error }, 'Error listing bans');
      res.status(500).json({ error: 'Failed to list bans' });
    }
  });

  // POST /api/admin/bans - Create a ban
  apiRouter.post('/bans', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { ban_type, entity_id, scope, scope_target, reason, banned_email, expires_at } = req.body;

      if (!ban_type || !entity_id || !scope || !reason) {
        return res.status(400).json({
          error: 'ban_type, entity_id, scope, and reason are required',
        });
      }
      if (!VALID_BAN_TYPES.includes(ban_type)) {
        return res.status(400).json({
          error: `ban_type must be one of: ${VALID_BAN_TYPES.join(', ')}`,
        });
      }
      if (!VALID_SCOPES.includes(scope)) {
        return res.status(400).json({
          error: `scope must be one of: ${VALID_SCOPES.join(', ')}`,
        });
      }

      const ban = await bansDb.createBan({
        ban_type,
        entity_id,
        scope,
        scope_target: scope_target?.toLowerCase(),
        banned_by_user_id: req.user!.id,
        banned_by_email: req.user!.email,
        banned_email,
        reason,
        expires_at: expires_at ? new Date(expires_at) : undefined,
      });

      if (scope === 'platform') {
        invalidateBanCache(ban_type === 'api_key' ? 'apikey' : 'user', entity_id);
      }

      logger.info(
        { banId: ban.id, ban_type, entity_id, scope, adminEmail: req.user!.email },
        'Ban created'
      );

      res.json(ban);
    } catch (error: any) {
      if (error?.constraint) {
        return res.status(409).json({ error: 'Ban already exists for this entity/scope' });
      }
      logger.error({ err: error }, 'Error creating ban');
      res.status(500).json({ error: 'Failed to create ban' });
    }
  });

  // DELETE /api/admin/bans/:banId - Remove a ban
  apiRouter.delete('/bans/:banId', requireAuth, requireAdmin, async (req, res) => {
    try {
      const removed = await bansDb.removeBan(req.params.banId);
      if (!removed) {
        return res.status(404).json({ error: 'Ban not found' });
      }

      if (removed.scope === 'platform') {
        invalidateBanCache(
          removed.ban_type === 'api_key' ? 'apikey' : 'user',
          removed.entity_id
        );
      }

      logger.info(
        { banId: req.params.banId, adminEmail: req.user!.email },
        'Ban removed'
      );

      res.json({ success: true });
    } catch (error) {
      logger.error({ err: error }, 'Error removing ban');
      res.status(500).json({ error: 'Failed to remove ban' });
    }
  });

  // GET /api/admin/bans/registry-activity - Query registry edit history
  apiRouter.get('/bans/registry-activity', requireAuth, requireAdmin, async (req, res) => {
    try {
      const editorUserId = req.query.editor_user_id as string | undefined;
      const orgId = req.query.org_id as string | undefined;
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

      if (!editorUserId && !orgId) {
        return res.status(400).json({
          error: 'editor_user_id or org_id is required',
        });
      }

      const pool = getPool();

      // Build a UNION query across brand and property revisions
      const userFilter = editorUserId
        ? 'editor_user_id = $1'
        : `editor_user_id IN (
            SELECT workos_user_id FROM organization_memberships WHERE workos_organization_id = $1
          )`;
      const filterValue = editorUserId || orgId;

      const result = await pool.query(
        `SELECT * FROM (
          SELECT 'brand' as entity_type, brand_domain as domain,
            revision_number, editor_user_id, editor_email, editor_name,
            edit_summary, is_rollback, created_at
          FROM brand_revisions WHERE ${userFilter}
          UNION ALL
          SELECT 'property' as entity_type, publisher_domain as domain,
            revision_number, editor_user_id, editor_email, editor_name,
            edit_summary, is_rollback, created_at
          FROM property_revisions WHERE ${userFilter}
        ) combined
        ORDER BY created_at DESC
        LIMIT $2`,
        [filterValue, limit]
      );

      res.json({ edits: result.rows });
    } catch (error) {
      logger.error({ err: error }, 'Error querying registry activity');
      res.status(500).json({ error: 'Failed to query registry activity' });
    }
  });
}
