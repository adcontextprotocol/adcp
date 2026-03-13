import { Router } from 'express';
import { WorkOS } from '@workos-inc/node';
import { createLogger } from '../logger.js';
import { requireAuth, requireAdmin, optionalAuth } from '../middleware/auth.js';
import { enrichUserWithMembership } from '../utils/html-config.js';
import * as certDb from '../db/certification-db.js';
import { query } from '../db/client.js';

const logger = createLogger('certification-routes');

const AUTH_ENABLED = !!(
  process.env.WORKOS_API_KEY &&
  process.env.WORKOS_CLIENT_ID
);
const workos = AUTH_ENABLED
  ? new WorkOS(process.env.WORKOS_API_KEY!, { clientId: process.env.WORKOS_CLIENT_ID! })
  : null;

/**
 * Create certification routes.
 * Returns publicRouter (mounted at /api/certification), userRouter (mounted at /api/me),
 * and orgRouter (mounted at /api/organizations).
 */
export function createCertificationRouters() {
  const publicRouter = Router();
  const userRouter = Router();
  const orgRouter = Router();

  // =====================================================
  // PUBLIC ROUTES (/api/certification/*)
  // =====================================================

  // GET /api/certification/tracks — list all tracks with module summaries
  publicRouter.get('/tracks', async (_req, res) => {
    try {
      const tracks = await certDb.getTracks();
      const modules = await certDb.getModules();

      const tracksWithModules = tracks.map(track => ({
        ...track,
        modules: modules
          .filter(m => m.track_id === track.id)
          .map(m => ({
            id: m.id,
            title: m.title,
            description: m.description,
            format: m.format,
            duration_minutes: m.duration_minutes,
            is_free: m.is_free,
            prerequisites: m.prerequisites,
            sort_order: m.sort_order,
          })),
      }));

      res.json({ tracks: tracksWithModules });
    } catch (error) {
      logger.error({ error }, 'Failed to get certification tracks');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/certification/modules/:id — module detail
  publicRouter.get('/modules/:id', optionalAuth, async (req, res) => {
    try {
      const mod = await certDb.getModule(req.params.id);
      if (!mod) {
        return res.status(404).json({ error: 'Module not found' });
      }

      const isAuthenticated = !!req.user;
      if (isAuthenticated) {
        await enrichUserWithMembership(req.user as any);
      }
      const isMember = isAuthenticated && (req.user as any).isMember;

      // Omit lesson plan and exercise details for gated modules if not a member
      if (!mod.is_free && !isMember) {
        return res.json({
          ...mod,
          lesson_plan: null,
          exercise_definitions: null,
          assessment_criteria: null,
          gated: true,
        });
      }

      res.json({ ...mod, gated: false });
    } catch (error) {
      logger.error({ error, moduleId: req.params.id }, 'Failed to get module');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/certification/credentials — public credential tier listing
  publicRouter.get('/credentials', async (_req, res) => {
    try {
      const credentials = await certDb.getCredentials();
      // Strip internal Certifier config from public response
      res.json({
        credentials: credentials.map(c => ({
          id: c.id, tier: c.tier, name: c.name, description: c.description,
          required_modules: c.required_modules, sort_order: c.sort_order,
          requires_any_track_complete: c.requires_any_track_complete,
          requires_credential: c.requires_credential,
        })),
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get credentials');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/certification/users/:userId/credentials — public user credentials
  publicRouter.get('/users/:userId/credentials', async (req, res) => {
    try {
      const credentials = await certDb.getPublicUserCredentials(req.params.userId);
      res.json({ credentials });
    } catch (error) {
      logger.error({ error, userId: req.params.userId }, 'Failed to get user credentials');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =====================================================
  // AUTHENTICATED ROUTES (/api/me/certification/*)
  // =====================================================

  userRouter.use('/certification', requireAuth);

  // GET /api/me/certification/progress — learner progress across all modules
  userRouter.get('/certification/progress', async (req, res) => {
    try {
      const userId = req.user!.id;
      const [progress, trackProgress, certifications, credentials] = await Promise.all([
        certDb.getProgress(userId),
        certDb.getTrackProgress(userId),
        certDb.getUserCertifications(userId),
        certDb.getPublicUserCredentials(userId),
      ]);

      res.json({ progress, trackProgress, certifications, credentials });
    } catch (error) {
      logger.error({ error }, 'Failed to get certification progress');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/me/certification/modules/:id/start — begin a module
  userRouter.post('/certification/modules/:id/start', async (req, res) => {
    try {
      const userId = req.user!.id;
      const moduleId = req.params.id;

      const mod = await certDb.getModule(moduleId);
      if (!mod) {
        return res.status(404).json({ error: 'Module not found' });
      }

      // Check membership for gated modules
      await enrichUserWithMembership(req.user as any);
      if (!mod.is_free && !(req.user as any).isMember) {
        return res.status(403).json({
          error: 'Membership required',
          message: 'This module requires an active AgenticAdvertising.org membership.',
        });
      }

      // Check prerequisites
      const prereqs = await certDb.checkPrerequisites(userId, moduleId);
      if (!prereqs.met) {
        return res.status(400).json({
          error: 'Prerequisites not met',
          missing: prereqs.missing,
          message: `Complete these modules first: ${prereqs.missing.join(', ')}`,
        });
      }

      const progress = await certDb.startModule(userId, moduleId, req.body.addie_thread_id);
      res.json(progress);
    } catch (error) {
      logger.error({ error, moduleId: req.params.id }, 'Failed to start module');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Module completion is only available through Addie's tool calls (complete_certification_module).
  // No REST API endpoint — prevents users from self-reporting scores without assessment.

  // GET /api/me/certification/certificates — issued certificates (legacy exam-based)
  userRouter.get('/certification/certificates', async (req, res) => {
    try {
      const certifications = await certDb.getUserCertifications(req.user!.id);
      res.json({ certifications });
    } catch (error) {
      logger.error({ error }, 'Failed to get certificates');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/me/certification/credentials — earned credentials
  userRouter.get('/certification/credentials', async (req, res) => {
    try {
      const credentials = await certDb.getOwnUserCredentials(req.user!.id);
      res.json({ credentials });
    } catch (error) {
      logger.error({ error }, 'Failed to get user credentials');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/me/certification/exam/start — begin capstone exam
  userRouter.post('/certification/exam/start', async (req, res) => {
    try {
      const userId = req.user!.id;
      const { track_id, addie_thread_id } = req.body;

      if (!track_id) {
        return res.status(400).json({ error: 'track_id is required' });
      }

      const track = await certDb.getTrack(track_id);
      if (!track) {
        return res.status(404).json({ error: 'Track not found' });
      }

      // Check for existing active attempt
      const active = await certDb.getActiveAttempt(userId, track_id);
      if (active) {
        return res.json(active);
      }

      // Verify all track modules are completed
      const modules = await certDb.getModulesForTrack(track_id);
      const progress = await certDb.getProgress(userId);
      const completedModules = new Set(
        progress.filter(p => p.status === 'completed').map(p => p.module_id)
      );
      const incomplete = modules.filter(m => m.format !== 'exam' && !completedModules.has(m.id));
      if (incomplete.length > 0) {
        return res.status(400).json({
          error: 'Track modules not completed',
          incomplete: incomplete.map(m => m.id),
          message: `Complete these modules first: ${incomplete.map(m => m.id).join(', ')}`,
        });
      }

      const attempt = await certDb.createAttempt(userId, track_id, addie_thread_id);
      res.json(attempt);
    } catch (error) {
      logger.error({ error }, 'Failed to start certification exam');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Exam completion is only available through Addie's tool calls (complete_certification_exam).
  // No REST API endpoint — prevents users from self-reporting exam scores without assessment.
  // Legacy endpoint removed; Certifier badge issuance handled in certification-tools.ts.
  userRouter.post('/certification/exam/:id/complete', (_req, res) => {
    res.status(410).json({ error: 'Exam completion is conducted through Addie. Start a chat and ask to take the capstone.' });
  });

  // =====================================================
  // ORG ROUTES (/api/organizations/:orgId/certification-summary)
  // =====================================================

  // GET /api/organizations/:orgId/certification-summary — team credential overview
  orgRouter.get('/:orgId/certification-summary', requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const { orgId } = req.params;

      // Verify user is a member of this org (same pattern as org routes)
      if (!workos) {
        return res.status(503).json({ error: 'Authentication not configured' });
      }
      const memberships = await workos.userManagement.listOrganizationMemberships({
        userId,
        organizationId: orgId,
      });

      if (memberships.data.length === 0) {
        return res.status(403).json({
          error: 'Access denied',
          message: 'You are not a member of this organization',
        });
      }

      const summary = await certDb.getOrgCertificationSummary(orgId);
      res.json(summary);
    } catch (error) {
      logger.error({ error, orgId: req.params.orgId }, 'Failed to get org certification summary');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =====================================================
  // ADMIN ROUTES
  // =====================================================

  const adminRouter = Router();
  adminRouter.use(requireAdmin);

  // POST /api/admin/certification/backfill-badges — retry Certifier for credentials missing data
  adminRouter.post('/backfill-badges', async (_req, res) => {
    try {
      const { issueCredential, isCertifierConfigured, getCredentialBadgeUrl } =
        await import('../services/certifier-client.js');

      if (!isCertifierConfigured()) {
        return res.status(503).json({ error: 'Certifier not configured' });
      }

      // Find credentials needing backfill (limit to avoid timeout)
      const needsBadgeUrl = await query<{
        id: string; workos_user_id: string; credential_id: string;
        certifier_credential_id: string | null; certifier_public_id: string | null;
      }>(
        `SELECT uc.id, uc.workos_user_id, uc.credential_id,
                uc.certifier_credential_id, uc.certifier_public_id
         FROM user_credentials uc
         JOIN certification_credentials cc ON cc.id = uc.credential_id
         WHERE uc.certifier_badge_url IS NULL
           AND cc.certifier_group_id IS NOT NULL
         LIMIT 50`
      );

      let updated = 0;
      const errors: string[] = [];

      for (const row of needsBadgeUrl.rows) {
        try {
          if (row.certifier_credential_id) {
            // Has certifier ID but missing badge URL — just fetch the badge
            const badgeUrl = await getCredentialBadgeUrl(row.certifier_credential_id);
            if (badgeUrl) {
              await certDb.awardCredential(
                row.workos_user_id, row.credential_id,
                row.certifier_credential_id, row.certifier_public_id || undefined,
                badgeUrl,
              );
              updated++;
            }
          } else {
            // No certifier ID at all — need to re-issue
            const cred = await certDb.getCredential(row.credential_id);
            if (!cred?.certifier_group_id) continue;

            // Get user info for Certifier
            const userResult = await query<{ first_name: string; last_name: string; email: string }>(
              'SELECT first_name, last_name, email FROM users WHERE workos_user_id = $1',
              [row.workos_user_id]
            );
            const user = userResult.rows[0];
            if (!user) continue;

            const credential = await issueCredential({
              groupId: cred.certifier_group_id,
              recipient: {
                name: `${user.first_name} ${user.last_name}`.trim() || user.email,
                email: user.email,
              },
            });

            let badgeUrl: string | null = null;
            try {
              badgeUrl = await getCredentialBadgeUrl(credential.id);
            } catch { /* badge URL is optional */ }

            await certDb.awardCredential(
              row.workos_user_id, row.credential_id,
              credential.id, credential.publicId,
              badgeUrl || undefined,
            );
            updated++;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`${row.credential_id}/${row.workos_user_id}: ${msg}`);
          logger.error({ error: err, row }, 'Backfill failed for credential');
        }
      }

      res.json({ total: needsBadgeUrl.rows.length, updated, errors });
    } catch (error) {
      logger.error({ error }, 'Failed to backfill badges');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/admin/certification/overview — aggregate metrics
  adminRouter.get('/overview', async (_req, res) => {
    try {
      const metrics = await certDb.getAdminOverviewMetrics();
      res.json(metrics);
    } catch (error) {
      logger.error({ error }, 'Failed to get admin overview metrics');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/admin/certification/learners — paginated learner list
  adminRouter.get('/learners', async (req, res) => {
    try {
      const search = req.query.search as string | undefined;
      const status = req.query.status as 'all' | 'active' | 'stuck' | 'completed' | undefined;
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const result = await certDb.getAdminLearnerList({ search, status, page, limit });
      res.json(result);
    } catch (error) {
      logger.error({ error }, 'Failed to get admin learner list');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/admin/certification/learners/:userId — individual learner detail
  adminRouter.get('/learners/:userId', async (req, res) => {
    try {
      const detail = await certDb.getAdminLearnerDetail(req.params.userId);
      if (!detail) return res.status(404).json({ error: 'Learner not found' });
      res.json(detail);
    } catch (error) {
      logger.error({ error }, 'Failed to get admin learner detail');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return { publicRouter, userRouter, orgRouter, adminRouter };
}
