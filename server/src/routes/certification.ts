import { Router } from 'express';
import { WorkOS } from '@workos-inc/node';
import { createLogger } from '../logger.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import * as certDb from '../db/certification-db.js';

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
      res.json({ credentials });
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

  // POST /api/me/certification/modules/:id/complete — mark module complete + auto-award credentials
  userRouter.post('/certification/modules/:id/complete', async (req, res) => {
    try {
      const userId = req.user!.id;
      const moduleId = req.params.id;
      const { score } = req.body;

      if (!score || typeof score !== 'object') {
        return res.status(400).json({ error: 'Score object is required' });
      }

      // Validate score values are numbers in 0-100 range
      const scoreValues = Object.values(score);
      if (scoreValues.length === 0 || !scoreValues.every((v): v is number => typeof v === 'number' && v >= 0 && v <= 100)) {
        return res.status(400).json({ error: 'All score values must be numbers between 0 and 100' });
      }

      // Verify the module was started by this user
      const existing = await certDb.getModuleProgress(userId, moduleId);
      if (!existing) {
        return res.status(400).json({ error: 'You must start this module before completing it' });
      }
      if (existing.status === 'completed') {
        return res.status(400).json({ error: 'Module already completed' });
      }

      const progress = await certDb.completeModule(userId, moduleId, score);

      // Auto-award any credentials the user is now eligible for
      let awardedCredentials: string[] = [];
      try {
        awardedCredentials = await certDb.checkAndAwardCredentials(userId);
      } catch (credError) {
        logger.error({ error: credError, userId }, 'Failed to check credential eligibility (continuing)');
      }

      res.json({ ...progress, awarded_credentials: awardedCredentials });
    } catch (error) {
      logger.error({ error, moduleId: req.params.id }, 'Failed to complete module');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

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
      const credentials = await certDb.getPublicUserCredentials(req.user!.id);
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

  // POST /api/me/certification/exam/:id/complete — submit exam results
  userRouter.post('/certification/exam/:id/complete', async (req, res) => {
    try {
      const attemptId = req.params.id;
      const { scores } = req.body;

      if (!scores || typeof scores !== 'object') {
        return res.status(400).json({ error: 'scores object is required' });
      }

      // Validate and compute scores server-side
      const scoreValues = Object.values(scores).filter(
        (v): v is number => typeof v === 'number'
      );
      if (scoreValues.length === 0 || !scoreValues.every(v => v >= 0 && v <= 100)) {
        return res.status(400).json({ error: 'All score values must be numbers between 0 and 100' });
      }

      const overall_score = Math.round(
        scoreValues.reduce((a, b) => a + b, 0) / scoreValues.length
      );
      const passing = scoreValues.every(s => s >= 70) && overall_score >= 70;

      const attempt = await certDb.getAttempt(attemptId);
      if (!attempt) {
        return res.status(404).json({ error: 'Attempt not found' });
      }

      if (attempt.workos_user_id !== req.user!.id) {
        return res.status(403).json({ error: 'Not authorized' });
      }

      if (attempt.status !== 'in_progress') {
        return res.status(400).json({ error: 'Attempt is already completed' });
      }

      // Issue credential via Certifier if passing
      let certifierCredentialId: string | undefined;
      let certifierPublicId: string | undefined;

      if (passing) {
        const track = await certDb.getTrack(attempt.track_id);
        if (track?.certifier_group_id) {
          try {
            const { issueCredential, isCertifierConfigured } = await import('../services/certifier-client.js');
            if (isCertifierConfigured()) {
              const twoYearsFromNow = new Date();
              twoYearsFromNow.setFullYear(twoYearsFromNow.getFullYear() + 2);

              const credential = await issueCredential({
                groupId: track.certifier_group_id,
                recipient: {
                  name: `${req.user!.firstName} ${req.user!.lastName}`,
                  email: req.user!.email,
                },
                expiryDate: twoYearsFromNow.toISOString().split('T')[0],
                customAttributes: {
                  'custom.track': track.name,
                  'custom.score': String(overall_score),
                },
              });
              certifierCredentialId = credential.id;
              certifierPublicId = credential.publicId;
            }
          } catch (certError) {
            logger.error({ error: certError, attemptId }, 'Failed to issue Certifier credential (continuing without it)');
          }
        }
      }

      const completed = await certDb.completeAttempt(
        attemptId, scores, overall_score, passing,
        certifierCredentialId, certifierPublicId
      );

      res.json(completed);
    } catch (error) {
      logger.error({ error, attemptId: req.params.id }, 'Failed to complete exam');
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

  return { publicRouter, userRouter, orgRouter };
}
