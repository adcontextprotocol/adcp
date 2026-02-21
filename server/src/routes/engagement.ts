import { Router } from 'express';
import { createLogger } from '../logger.js';
import { requireAuth } from '../middleware/auth.js';
import { query } from '../db/client.js';
import { OrganizationDatabase } from '../db/organization-db.js';
import { OrgKnowledgeDatabase, type Persona } from '../db/org-knowledge-db.js';
import { WorkingGroupDatabase } from '../db/working-group-db.js';
import { checkMilestones } from '../addie/services/journey-computation.js';
import { getRecommendedGroupsForOrg } from '../addie/services/group-recommendations.js';
import { notifyAssessmentCompleted } from '../notifications/assessment.js';

const VALID_PERSONAS: Persona[] = ['molecule_builder', 'data_decoder', 'pureblood_protector', 'resops_integrator', 'ladder_climber', 'simple_starter', 'pragmatic_builder'];

const logger = createLogger('engagement-routes');

export interface EngagementRoutesConfig {
  orgDb: OrganizationDatabase;
  orgKnowledgeDb: OrgKnowledgeDatabase;
  workingGroupDb: WorkingGroupDatabase;
}

export function createEngagementRouter(config: EngagementRoutesConfig): Router {
  const router = Router();

  // GET /api/me/engagement - Member engagement dashboard data
  router.get('/', requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;

      // Resolve user's organization — check memberships table first, then users.primary_organization_id
      const membershipResult = await query<{ workos_organization_id: string }>(
        `SELECT workos_organization_id FROM (
           SELECT om.workos_organization_id, 1 AS priority
           FROM organization_memberships om
           WHERE om.workos_user_id = $1
           UNION ALL
           SELECT u.primary_organization_id, 2 AS priority
           FROM users u
           WHERE u.workos_user_id = $1 AND u.primary_organization_id IS NOT NULL
         ) ranked
         ORDER BY priority, workos_organization_id
         LIMIT 1`,
        [userId]
      );

      const orgId = membershipResult.rows[0]?.workos_organization_id;
      if (!orgId) {
        return res.status(404).json({ error: 'No organization found for user' });
      }

      // Parallel-fetch all dashboard data with individual error isolation
      const [
        orgData,
        milestones,
        signals,
        journeyHistory,
        recommendedGroups,
        currentGroups,
        contentContributions,
      ] = await Promise.all([
        // Organization core data
        query<{
          name: string;
          persona: string | null;
          aspiration_persona: string | null;
          persona_source: string | null;
          journey_stage: string | null;
          engagement_score: number | null;
          created_at: Date;
        }>(
          `SELECT name, persona, aspiration_persona, persona_source, journey_stage, engagement_score, created_at
           FROM organizations WHERE workos_organization_id = $1`,
          [orgId]
        ).then(r => r.rows[0] ?? null).catch(err => {
          logger.error({ err, orgId }, 'Failed to fetch organization data');
          return null;
        }),

        // Milestone checks
        checkMilestones(orgId).catch(err => {
          logger.error({ err, orgId }, 'Failed to check milestones');
          return null;
        }),

        // Engagement signals
        config.orgDb.getEngagementSignals(orgId).catch(err => {
          logger.error({ err, orgId }, 'Failed to fetch engagement signals');
          return null;
        }),

        // Journey stage history
        config.orgKnowledgeDb.getJourneyHistory(orgId).catch(err => {
          logger.error({ err, orgId }, 'Failed to fetch journey history');
          return [];
        }),

        // Persona-based group recommendations
        getRecommendedGroupsForOrg(orgId, { limit: 5 }).catch(err => {
          logger.error({ err, orgId }, 'Failed to fetch recommended groups');
          return [];
        }),

        // Current working group memberships
        config.workingGroupDb.getWorkingGroupsForOrganization(orgId).catch(err => {
          logger.error({ err, orgId }, 'Failed to fetch current groups');
          return [];
        }),

        // Content contributions from org members
        query<{
          id: string;
          title: string;
          status: string;
          content_type: string;
          created_at: Date;
          author_name: string | null;
        }>(
          `SELECT p.id, p.title, p.status, p.content_type, p.created_at,
                  COALESCE(p.author_name, u.first_name || ' ' || u.last_name) as author_name
           FROM perspectives p
           JOIN organization_memberships om ON om.workos_user_id = p.proposer_user_id
           LEFT JOIN users u ON u.workos_user_id = p.proposer_user_id
           WHERE om.workos_organization_id = $1
           ORDER BY p.created_at DESC LIMIT 10`,
          [orgId]
        ).then(r => r.rows).catch(err => {
          logger.error({ err, orgId }, 'Failed to fetch content contributions');
          return [];
        }),
      ]);

      res.json({
        organization_name: orgData?.name ?? null,
        journey_stage: orgData?.journey_stage ?? null,
        engagement_score: orgData?.engagement_score ?? null,
        persona: orgData?.persona ?? null,
        persona_source: orgData?.persona_source ?? null,
        persona_aspiration: orgData?.aspiration_persona ?? null,
        milestones,
        recommended_groups: recommendedGroups,
        current_group_count: Array.isArray(currentGroups) ? currentGroups.length : 0,
        activity: signals ? {
          dashboard_logins_30d: signals.login_count_30d,
          working_group_count: signals.working_group_count,
          email_clicks_30d: signals.email_click_count_30d,
          last_active: signals.last_login,
        } : null,
        journey_history: journeyHistory,
        content_contributions: Array.isArray(contentContributions)
          ? contentContributions.map(c => ({
              title: c.title,
              author: c.author_name,
              date: c.created_at,
              status: c.status,
              content_type: c.content_type,
            }))
          : [],
      });
    } catch (error) {
      logger.error({ error }, 'Failed to load engagement dashboard');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/me/persona-assessment - Save persona diagnostic result
  router.post('/persona-assessment', requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const { persona, scores } = req.body;

      if (!persona || !VALID_PERSONAS.includes(persona)) {
        return res.status(400).json({ error: 'Invalid persona', valid: VALID_PERSONAS });
      }

      // Validate scores: flat object of string→finite number pairs, max 20 keys
      if (scores !== undefined && scores !== null) {
        const isValid = typeof scores === 'object' &&
          !Array.isArray(scores) &&
          Object.keys(scores).length <= 20 &&
          Object.keys(scores).every(k => k.length > 0 && k.length <= 100) &&
          Object.values(scores).every(v => typeof v === 'number' && isFinite(v as number));
        if (!isValid) {
          return res.status(400).json({ error: 'Invalid scores format' });
        }
      }

      const membershipResult = await query<{ workos_organization_id: string }>(
        `SELECT workos_organization_id FROM (
           SELECT om.workos_organization_id, 1 AS priority
           FROM organization_memberships om WHERE om.workos_user_id = $1
           UNION ALL
           SELECT u.primary_organization_id, 2 AS priority FROM users u
           WHERE u.workos_user_id = $1 AND u.primary_organization_id IS NOT NULL
         ) ranked
         ORDER BY priority, workos_organization_id
         LIMIT 1`,
        [userId]
      );

      const orgId = membershipResult.rows[0]?.workos_organization_id;
      if (!orgId) {
        return res.status(404).json({ error: 'No organization found for user' });
      }

      await config.orgKnowledgeDb.setPersona(orgId, persona as Persona, 'diagnostic', {
        set_by_user_id: userId,
        source_reference: JSON.stringify(scores),
      });

      logger.info({ orgId, persona, userId }, 'Persona set via diagnostic assessment');

      res.json({ success: true, persona });

      // Fire-and-forget admin notification (after response is sent)
      const user = req.user!;
      const userName = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email;
      Promise.resolve().then(async () => {
        const orgResult = await query<{ name: string }>(
          `SELECT name FROM organizations WHERE workos_organization_id = $1`,
          [orgId]
        );
        const orgName = orgResult.rows[0]?.name ?? orgId;
        await notifyAssessmentCompleted({
          organizationName: orgName,
          userName,
          userEmail: user.email,
          persona,
        });
      }).catch(err => logger.warn({ err }, 'Failed to send assessment notification'));
    } catch (error) {
      logger.error({ error }, 'Failed to save persona assessment');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
