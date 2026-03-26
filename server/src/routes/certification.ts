import { Router } from 'express';
import { WorkOS } from '@workos-inc/node';
import { createLogger } from '../logger.js';
import { requireAuth, requireAdmin, optionalAuth, isDevModeEnabled } from '../middleware/auth.js';
import { enrichUserWithMembership } from '../utils/html-config.js';
import * as certDb from '../db/certification-db.js';
import { query } from '../db/client.js';
import { notifyUser } from '../notifications/notification-service.js';

const logger = createLogger('certification-routes');

const AUTH_ENABLED = !!(
  process.env.WORKOS_API_KEY &&
  process.env.WORKOS_CLIENT_ID
);
const workos = AUTH_ENABLED
  ? new WorkOS(process.env.WORKOS_API_KEY!, { clientId: process.env.WORKOS_CLIENT_ID! })
  : null;

/**
 * Check if a user belongs to an organization.
 * In dev mode, checks local DB. In production, calls WorkOS API.
 */
async function isOrgMember(userId: string, orgId: string): Promise<boolean> {
  if (isDevModeEnabled()) {
    const result = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM organization_memberships
       WHERE workos_user_id = $1 AND workos_organization_id = $2`,
      [userId, orgId]
    );
    return parseInt(result.rows[0]?.count || '0') > 0;
  }
  if (!workos) return false;
  const memberships = await workos.userManagement.listOrganizationMemberships({ userId, organizationId: orgId });
  return memberships.data.length > 0;
}

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

  // GET /api/certification/stats — aggregate cert stats for social proof
  publicRouter.get('/stats', async (_req, res) => {
    try {
      const stats = await certDb.getCertAggregateStats();
      res.set('Cache-Control', 'public, max-age=300');
      res.json(stats);
    } catch (error) {
      logger.error({ error }, 'Failed to get certification stats');
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

      // Prevent restarting completed or tested-out modules
      const existing = await certDb.getModuleProgress(userId, moduleId);
      if (existing && (existing.status === 'completed' || existing.status === 'tested_out')) {
        return res.status(409).json({
          error: 'Module already completed',
          message: `Module ${moduleId} is already ${existing.status.replace('_', ' ')}.`,
          status: existing.status,
        });
      }

      const progress = await certDb.startModule(userId, moduleId, req.body?.addie_thread_id);
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

      const capstoneMod = modules.find(m => m.format === 'capstone' || m.format === 'exam');
      if (!capstoneMod) {
        return res.status(400).json({ error: 'No capstone module found for this track' });
      }

      const attempt = await certDb.createAttempt(userId, track_id, addie_thread_id, capstoneMod.id);
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

  // GET /api/me/certification/expectation — get current user's cert expectation + org social proof
  userRouter.get('/certification/expectation', async (req, res) => {
    try {
      const userId = req.user!.id;
      const orgResult = await query<{ workos_organization_id: string; name: string }>(
        `SELECT om.workos_organization_id, o.name
         FROM organization_memberships om
         JOIN organizations o ON o.workos_organization_id = om.workos_organization_id
         WHERE om.workos_user_id = $1 AND o.is_personal = false
         LIMIT 1`,
        [userId]
      );
      const orgId = orgResult.rows[0]?.workos_organization_id;
      const orgName = orgResult.rows[0]?.name;
      if (!orgId) return res.json({ expectation: null, org_stats: null });

      const [expectation, orgCertProgress] = await Promise.all([
        certDb.getCertExpectationForUser(orgId, userId),
        certDb.getOrgCertProgress(orgId),
      ]);

      let expectationResponse = null;
      if (expectation && expectation.status !== 'completed' && expectation.status !== 'declined') {
        // Suppress banner while snoozed
        if (!expectation.snooze_until || new Date(expectation.snooze_until) <= new Date()) {
          expectationResponse = { status: expectation.status };
        }
      }

      res.json({
        expectation: expectationResponse,
        org_stats: orgCertProgress.total > 1 ? {
          certified: orgCertProgress.certified,
          total: orgCertProgress.total,
          org_name: orgName,
        } : null,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get certification expectation');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/me/certification/expectation/decline — opt out of team cert expectation
  userRouter.post('/certification/expectation/decline', async (req, res) => {
    try {
      const userId = req.user!.id;
      const orgResult = await query<{ workos_organization_id: string }>(
        `SELECT workos_organization_id FROM organization_memberships WHERE workos_user_id = $1 LIMIT 1`,
        [userId]
      );
      const orgId = orgResult.rows[0]?.workos_organization_id;
      if (!orgId) return res.status(404).json({ error: 'No organization found' });

      const result = await certDb.declineCertExpectation(orgId, userId);
      if (!result) return res.status(404).json({ error: 'No active expectation found' });

      res.json({ status: 'declined' });
    } catch (error) {
      logger.error({ error }, 'Failed to decline certification expectation');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/me/certification/expectation/snooze — progressive snooze (7d → 30d → auto-decline)
  userRouter.post('/certification/expectation/snooze', async (req, res) => {
    try {
      const userId = req.user!.id;

      const orgResult = await query<{ workos_organization_id: string }>(
        `SELECT workos_organization_id FROM organization_memberships WHERE workos_user_id = $1 LIMIT 1`,
        [userId]
      );
      const orgId = orgResult.rows[0]?.workos_organization_id;
      if (!orgId) return res.status(404).json({ error: 'No organization found' });

      // Check current expectation to determine snooze progression
      const existing = await certDb.getCertExpectationForUser(orgId, userId);
      if (!existing || existing.status === 'completed' || existing.status === 'declined') {
        return res.status(404).json({ error: 'No active expectation found' });
      }

      // Progressive backoff: first snooze = 7 days, second = 30 days, third = auto-decline
      const previouslySnoozed = existing.snooze_until !== null;
      if (previouslySnoozed && existing.snooze_until && new Date(existing.snooze_until) < new Date()) {
        // They've snoozed before and it expired — this is the second+ snooze
        // Auto-decline instead of snoozeing indefinitely
        await certDb.declineCertExpectation(orgId, userId);
        return res.json({ status: 'declined', message: 'No worries — certification is always available if you change your mind.' });
      }

      const days = previouslySnoozed ? 30 : 7;
      const result = await certDb.snoozeCertExpectation(orgId, userId, days);
      if (!result) return res.status(404).json({ error: 'No active expectation found' });

      res.json({ status: 'snoozed', snooze_until: result.snooze_until });
    } catch (error) {
      logger.error({ error }, 'Failed to snooze certification expectation');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =====================================================
  // ORG ROUTES (/api/organizations/:orgId/certification-summary)
  // =====================================================

  // GET /api/organizations/:orgId/certification-summary — team credential overview
  orgRouter.get('/:orgId/certification-summary', requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const { orgId } = req.params;

      // Verify user is a member of this org
      if (!await isOrgMember(userId, orgId)) {
        return res.status(403).json({
          error: 'Access denied',
          message: 'You are not a member of this organization',
        });
      }

      const [summary, expectations] = await Promise.all([
        certDb.getOrgCertificationSummary(orgId),
        certDb.getCertExpectations(orgId),
      ]);

      // Reconcile expectation statuses in background (fire-and-forget).
      // Stale statuses self-correct on next load without blocking this response.
      Promise.all(
        expectations
          .filter(e => e.workos_user_id)
          .map(e => certDb.reconcileExpectationProgress(e.workos_user_id!, orgId))
      ).catch(err => logger.warn({ err }, 'Background cert reconciliation failed'));

      // Strip internal user IDs from client response
      const { members, ...rest } = summary;

      const pendingExpectations = expectations
        .filter(e => e.status !== 'declined') // Respect opt-out privacy
        .filter(e => !e.workos_user_id || !members.some(m => m.user_id === e.workos_user_id))
        .map(e => ({
          id: e.id,
          email: e.email,
          status: e.status,
          credential_target: e.credential_target,
          invited_at: e.invited_at,
          invited_by_name: e.invited_by_name,
          last_resent_at: e.last_resent_at,
        }));

      res.json({
        ...rest,
        members: members.map(({ user_id, ...m }) => m),
        expectations: pendingExpectations,
      });
    } catch (error) {
      logger.error({ error, orgId: req.params.orgId }, 'Failed to get org certification summary');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =====================================================
  // ORG ROUTES — Certification Invites
  // =====================================================

  // POST /api/organizations/:orgId/certification-invites — invite colleagues to certify
  orgRouter.post('/:orgId/certification-invites', requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const { orgId } = req.params;
      const { emails, credential_target } = req.body;

      if (!Array.isArray(emails) || emails.length === 0) {
        return res.status(400).json({ error: 'emails array is required' });
      }
      if (emails.length > 50) {
        return res.status(400).json({ error: 'Maximum 50 emails per request' });
      }
      if (credential_target) {
        const cred = await certDb.getCredential(credential_target);
        if (!cred) {
          return res.status(400).json({ error: 'Invalid credential_target' });
        }
      }

      // Verify user is an admin of this org (only admins can send invitations)
      const membershipResult = await query<{ role: string }>(
        `SELECT role FROM organization_memberships WHERE workos_user_id = $1 AND workos_organization_id = $2`,
        [userId, orgId]
      );
      if (!membershipResult.rows[0]) {
        return res.status(403).json({ error: 'You are not a member of this organization' });
      }
      if (membershipResult.rows[0].role !== 'admin') {
        return res.status(403).json({ error: 'Only organization admins can send certification invitations' });
      }

      let invited = 0;
      let alreadyMember = 0;
      let alreadyInvited = 0;
      const errors: string[] = [];

      // Load existing expectations once, not per email
      const existingExpectations = await certDb.getCertExpectations(orgId);
      const existingEmails = new Set(existingExpectations.map(e => e.email.toLowerCase()));

      const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

      for (const rawEmail of emails) {
        const email = String(rawEmail).toLowerCase().trim();
        if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
          errors.push(`Invalid email: ${String(rawEmail).slice(0, 100)}`);
          continue;
        }

        try {
          // Check if expectation already exists
          if (existingEmails.has(email)) {
            alreadyInvited++;
            continue;
          }

          // Check if already an org member
          const memberCheck = await query<{ workos_user_id: string; email: string }>(
            `SELECT om.workos_user_id, u.email
             FROM organization_memberships om
             JOIN users u ON u.workos_user_id = om.workos_user_id
             WHERE om.workos_organization_id = $1 AND LOWER(u.email) = $2`,
            [orgId, email]
          );

          if (memberCheck.rows.length > 0) {
            // Already in org — just create cert expectation with 'joined' status
            await certDb.createCertExpectation(orgId, email, userId, {
              status: 'joined',
              workosUserId: memberCheck.rows[0].workos_user_id,
              credentialTarget: credential_target,
            });
            alreadyMember++;
          } else {
            // Not in org — send WorkOS invitation + create expectation
            try {
              await workos?.userManagement.sendInvitation({
                email,
                organizationId: orgId,
              });
            } catch (inviteErr: any) {
              // Invitation may already exist — that's OK
              if (!inviteErr?.message?.includes('already') && !inviteErr?.code?.includes('already')) {
                throw inviteErr;
              }
            }
            await certDb.createCertExpectation(orgId, email, userId, {
              credentialTarget: credential_target,
            });
            invited++;
          }
          existingEmails.add(email);
        } catch (emailErr) {
          logger.error({ error: emailErr, email, orgId }, 'Failed to process certification invite');
          errors.push(`${email}: invite failed`);
        }
      }

      res.json({ invited, already_member: alreadyMember, already_invited: alreadyInvited, errors: errors.length > 0 ? errors : undefined });
    } catch (error) {
      logger.error({ error, orgId: req.params.orgId }, 'Failed to process certification invites');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/organizations/:orgId/certification-invites/:id/resend — re-send a stale invitation
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  orgRouter.post('/:orgId/certification-invites/:id/resend', requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const { orgId, id } = req.params;

      if (!UUID_RE.test(id)) {
        return res.status(400).json({ error: 'Invalid invitation ID' });
      }

      // Verify caller is an admin of this org
      const resendMembership = await query<{ role: string }>(
        `SELECT role FROM organization_memberships WHERE workos_user_id = $1 AND workos_organization_id = $2`,
        [userId, orgId]
      );
      if (!resendMembership.rows[0]) {
        return res.status(403).json({ error: 'You are not a member of this organization' });
      }
      if (resendMembership.rows[0].role !== 'admin') {
        return res.status(403).json({ error: 'Only organization admins can resend certification invitations' });
      }

      const updated = await certDb.resendCertExpectation(id, orgId);
      if (!updated) return res.status(404).json({ error: 'No pending invitation found' });

      // Re-send the WorkOS org invitation
      if (workos) {
        try {
          await workos.userManagement.sendInvitation({
            email: updated.email,
            organizationId: orgId,
          });
        } catch (inviteErr: any) {
          if (!inviteErr?.message?.includes('already') && !inviteErr?.code?.includes('already')) {
            logger.warn({ error: inviteErr, email: updated.email }, 'WorkOS re-invitation failed');
          }
        }
      }

      res.json({ status: 'resent', email: updated.email });
    } catch (error) {
      logger.error({ error, orgId: req.params.orgId, id: req.params.id }, 'Failed to resend certification invite');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =====================================================
  // ORG ROUTES — Certification Goals
  // =====================================================

  // GET /api/organizations/:orgId/certification-goals — list goals with progress
  orgRouter.get('/:orgId/certification-goals', requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const { orgId } = req.params;

      if (!await isOrgMember(userId, orgId)) {
        return res.status(403).json({ error: 'You are not a member of this organization' });
      }

      const goals = await certDb.getCertGoals(orgId);
      res.json({ goals });
    } catch (error) {
      logger.error({ error, orgId: req.params.orgId }, 'Failed to get certification goals');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/organizations/:orgId/certification-goals — create/update a goal (admin only)
  orgRouter.post('/:orgId/certification-goals', requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const { orgId } = req.params;
      const { credential_id, target_count, deadline } = req.body;

      if (!credential_id || typeof credential_id !== 'string' || !Number.isInteger(target_count) || target_count < 1 || target_count > 10000) {
        return res.status(400).json({ error: 'credential_id (string) and target_count (integer 1-10000) are required' });
      }

      // Validate deadline format
      let parsedDeadline: string | null = null;
      if (deadline) {
        const d = new Date(deadline);
        if (isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid deadline date' });
        parsedDeadline = d.toISOString().split('T')[0];
      }

      // Verify credential exists
      const credential = await certDb.getCredential(credential_id);
      if (!credential) {
        return res.status(400).json({ error: 'Invalid credential_id' });
      }

      // Verify admin role
      const membershipResult = await query<{ role: string }>(
        `SELECT role FROM organization_memberships WHERE workos_user_id = $1 AND workos_organization_id = $2`,
        [userId, orgId]
      );
      if (!membershipResult.rows[0] || membershipResult.rows[0].role !== 'admin') {
        return res.status(403).json({ error: 'Only organization admins can set certification goals' });
      }

      const goal = await certDb.createOrUpdateCertGoal(orgId, credential_id, target_count, parsedDeadline, userId);
      res.json({ goal });
    } catch (error) {
      logger.error({ error, orgId: req.params.orgId }, 'Failed to create certification goal');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // DELETE /api/organizations/:orgId/certification-goals/:id — remove a goal (admin only)
  orgRouter.delete('/:orgId/certification-goals/:id', requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const { orgId, id } = req.params;

      const membershipResult = await query<{ role: string }>(
        `SELECT role FROM organization_memberships WHERE workos_user_id = $1 AND workos_organization_id = $2`,
        [userId, orgId]
      );
      if (!membershipResult.rows[0] || membershipResult.rows[0].role !== 'admin') {
        return res.status(403).json({ error: 'Only organization admins can delete certification goals' });
      }

      const deleted = await certDb.deleteCertGoal(id, orgId);
      if (!deleted) return res.status(404).json({ error: 'Goal not found' });

      res.json({ status: 'deleted' });
    } catch (error) {
      logger.error({ error, orgId: req.params.orgId }, 'Failed to delete certification goal');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =====================================================
  // ORG ROUTES — Certification Nudge
  // =====================================================

  // GET /api/organizations/:orgId/certification-stalled — count of stalled learners
  orgRouter.get('/:orgId/certification-stalled', requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const { orgId } = req.params;

      if (!await isOrgMember(userId, orgId)) {
        return res.status(403).json({ error: 'You are not a member of this organization' });
      }

      const stalled = await certDb.getStalledLearners(orgId);
      res.json({ count: stalled.length });
    } catch (error) {
      logger.error({ error, orgId: req.params.orgId }, 'Failed to get stalled learner count');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/organizations/:orgId/certification-nudge — nudge stalled learners
  orgRouter.post('/:orgId/certification-nudge', requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const { orgId } = req.params;
      const { user_ids } = req.body;

      // Verify admin role
      const membershipResult = await query<{ role: string }>(
        `SELECT role FROM organization_memberships WHERE workos_user_id = $1 AND workos_organization_id = $2`,
        [userId, orgId]
      );
      if (!membershipResult.rows[0] || membershipResult.rows[0].role !== 'admin') {
        return res.status(403).json({ error: 'Only organization admins can send certification nudges' });
      }

      let stalledLearners = await certDb.getStalledLearners(orgId);

      // Filter to specific users if provided
      if (Array.isArray(user_ids) && user_ids.length > 0) {
        if (!user_ids.every(id => typeof id === 'string')) {
          return res.status(400).json({ error: 'user_ids must be an array of strings' });
        }
        const targetSet = new Set(user_ids);
        stalledLearners = stalledLearners.filter(l => targetSet.has(l.workos_user_id));
      }

      let nudged = 0;
      for (const learner of stalledLearners) {
        try {
          await notifyUser({
            recipientUserId: learner.workos_user_id,
            actorUserId: userId,
            type: 'certification_nudge',
            title: 'Your team is working toward certification — pick up where you left off',
            url: '/certification',
          });
          // Snooze for 7 days to prevent re-nudging
          await certDb.snoozeCertExpectation(orgId, learner.workos_user_id, 7);
          nudged++;
        } catch (err) {
          logger.error({ error: err, userId: learner.workos_user_id }, 'Failed to send cert nudge');
        }
      }

      res.json({ nudged, total_stalled: stalledLearners.length });
    } catch (error) {
      logger.error({ error, orgId: req.params.orgId }, 'Failed to send certification nudges');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =====================================================
  // ADMIN ROUTES
  // =====================================================

  const adminRouter = Router();
  adminRouter.use(requireAuth, requireAdmin);

  // POST /api/admin/certification/backfill-badges — retry Certifier for credentials missing data
  let backfillInProgress = false;
  adminRouter.post('/backfill-badges', async (_req, res) => {
    if (backfillInProgress) {
      return res.status(409).json({ error: 'Backfill already in progress' });
    }
    backfillInProgress = true;
    try {
      const { issueCredential, isCertifierConfigured, getCredentialBadgeUrl } =
        await import('../services/certifier-client.js');

      if (!isCertifierConfigured()) {
        return res.status(503).json({ error: 'Certifier not configured' });
      }

      // First: award any missing credentials for eligible learners
      const eligibleUsers = await query<{ workos_user_id: string }>(
        `SELECT DISTINCT workos_user_id FROM learner_progress
         WHERE status IN ('completed', 'tested_out')`
      );
      let credentialsAwarded = 0;
      for (const { workos_user_id } of eligibleUsers.rows) {
        try {
          const awarded = await certDb.checkAndAwardCredentials(workos_user_id);
          credentialsAwarded += awarded.length;
        } catch (err) {
          logger.error({ error: err, workos_user_id }, 'Failed to check/award credentials for user');
        }
      }

      // Then: backfill badges for credentials missing them
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

      res.json({ total: needsBadgeUrl.rows.length, updated, errors, credentialsAwarded });
    } catch (error) {
      logger.error({ error }, 'Failed to backfill badges');
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      backfillInProgress = false;
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
