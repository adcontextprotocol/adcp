/**
 * Journey Stage Computation Service
 *
 * Computes journey stage for organizations based on milestone achievements.
 * Stages can progress forward or regress when milestones are lost.
 */

import { getPool } from '../../db/client.js';
import { OrgKnowledgeDatabase, type JourneyStage, type JourneyTriggerType } from '../../db/org-knowledge-db.js';
import { logger as baseLogger } from '../../logger.js';

const logger = baseLogger.child({ module: 'journey-computation' });
const orgKnowledgeDb = new OrgKnowledgeDatabase();

const STAGE_ORDER: JourneyStage[] = [
  'aware', 'evaluating', 'joined', 'onboarding',
  'participating', 'contributing', 'leading', 'advocating',
];

function stageIndex(stage: JourneyStage): number {
  return STAGE_ORDER.indexOf(stage);
}

interface MilestoneCheck {
  has_leadership: boolean;
  has_content_proposals: boolean;
  has_working_groups: boolean;
  has_recruiting_activity: boolean;
  member_days: number;
  has_subscription: boolean;
}

/**
 * Check milestones for an organization
 */
async function checkMilestones(orgId: string): Promise<MilestoneCheck | null> {
  const pool = getPool();

  const result = await pool.query(
    `SELECT
       o.subscription_status,
       o.created_at,
       EXISTS (
         SELECT 1 FROM working_group_leaders wgl
         JOIN organization_memberships om ON om.workos_user_id = wgl.user_id
         WHERE om.workos_organization_id = $1
       ) as has_leadership,
       EXISTS (
         SELECT 1 FROM perspectives p
         JOIN organization_memberships om ON om.workos_user_id = p.workos_user_id
         WHERE om.workos_organization_id = $1
       ) as has_content_proposals,
       EXISTS (
         SELECT 1 FROM working_group_memberships wgm
         JOIN organization_memberships om ON om.workos_user_id = wgm.workos_user_id
         WHERE om.workos_organization_id = $1 AND wgm.status = 'active'
       ) as has_working_groups,
       EXISTS (
         SELECT 1 FROM member_search_analytics msa
         JOIN member_profiles mp ON mp.id = msa.member_profile_id
         WHERE mp.workos_organization_id = $1
           AND msa.event_type = 'introduction_sent'
           AND msa.created_at > NOW() - INTERVAL '90 days'
       ) as has_recruiting_activity
     FROM organizations o
     WHERE o.workos_organization_id = $1`,
    [orgId]
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  const memberDays = row.created_at
    ? Math.floor((Date.now() - new Date(row.created_at).getTime()) / (1000 * 60 * 60 * 24))
    : 0;

  return {
    has_leadership: row.has_leadership,
    has_content_proposals: row.has_content_proposals,
    has_working_groups: row.has_working_groups,
    has_recruiting_activity: row.has_recruiting_activity,
    member_days: memberDays,
    has_subscription: row.subscription_status === 'active',
  };
}

/**
 * Determine the appropriate journey stage based on milestones
 */
function determineStage(milestones: MilestoneCheck): JourneyStage {
  // Check from highest to lowest stage
  if (milestones.has_leadership && milestones.has_recruiting_activity) {
    return 'advocating';
  }
  if (milestones.has_leadership) {
    return 'leading';
  }
  if (milestones.has_content_proposals) {
    return 'contributing';
  }
  if (milestones.has_working_groups) {
    return 'participating';
  }
  if (milestones.has_subscription && milestones.member_days <= 90) {
    return 'onboarding';
  }
  if (milestones.has_subscription) {
    return 'joined';
  }
  return 'aware';
}

/**
 * Compute and update journey stage for a single organization.
 * Returns the transition if a stage change occurred, null otherwise.
 */
export async function computeJourneyStage(
  orgId: string,
  triggerType: JourneyTriggerType = 'recomputation',
  triggerDetail?: string
): Promise<{ from: JourneyStage | null; to: JourneyStage } | null> {
  const milestones = await checkMilestones(orgId);
  if (!milestones) return null;

  const newStage = determineStage(milestones);

  // Get current stage
  const pool = getPool();
  const currentResult = await pool.query<{ journey_stage: JourneyStage | null }>(
    `SELECT journey_stage FROM organizations WHERE workos_organization_id = $1`,
    [orgId]
  );
  const currentStage = currentResult.rows[0]?.journey_stage ?? null;

  if (currentStage === newStage) return null;

  // Determine if this is progression or regression
  const isRegression = currentStage !== null && stageIndex(newStage) < stageIndex(currentStage);
  const effectiveTrigger = isRegression && triggerType === 'recomputation'
    ? 'milestone_lost' as JourneyTriggerType
    : triggerType;

  const transition = await orgKnowledgeDb.transitionJourneyStage(orgId, newStage, effectiveTrigger, {
    trigger_detail: triggerDetail || `computed: ${JSON.stringify(milestones)}`,
    triggered_by: 'system',
  });

  if (transition) {
    logger.info(
      { orgId, from: currentStage, to: newStage, trigger: effectiveTrigger, isRegression },
      'Journey stage transition'
    );
  }

  return { from: currentStage, to: newStage };
}

/**
 * Recompute journey stages for all organizations as a background job.
 */
export async function runJourneyComputationJob(options: { limit?: number } = {}): Promise<{
  processed: number;
  transitions: number;
  regressions: number;
}> {
  const { limit = 100 } = options;
  const pool = getPool();

  const result = await pool.query(
    `SELECT workos_organization_id
     FROM organizations
     WHERE is_personal = false
       AND subscription_status IS NOT NULL
     ORDER BY last_activity_at DESC NULLS LAST
     LIMIT $1`,
    [limit]
  );

  let transitions = 0;
  let regressions = 0;

  for (const row of result.rows) {
    try {
      const change = await computeJourneyStage(row.workos_organization_id);
      if (change) {
        transitions++;
        if (change.from && stageIndex(change.to) < stageIndex(change.from)) {
          regressions++;
        }
      }
    } catch (error) {
      logger.warn({ error, orgId: row.workos_organization_id }, 'Failed to compute journey stage');
    }
  }

  return { processed: result.rows.length, transitions, regressions };
}
