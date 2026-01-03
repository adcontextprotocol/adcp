/**
 * Momentum Check Job
 *
 * Analyzes outreach history and user activity to create action items.
 * Runs periodically to detect:
 * - Users who need a nudge (no response/activity after outreach)
 * - Warm leads (some engagement but no conversion)
 * - Momentum opportunities (good activity, time to engage)
 * - Conversions (celebrate!)
 */

import { logger } from '../../logger.js';
import { query } from '../../db/client.js';
import {
  createActionItem,
  reopenSnoozedItems,
} from '../../db/account-management-db.js';

// Configuration
const NUDGE_DAYS = 3; // Days after outreach with no activity to suggest nudge
const WARM_LEAD_DAYS = 7; // Days to consider someone a warm lead
const MOMENTUM_THRESHOLD = 3; // Number of activities to consider "momentum"

interface OutreachWithActivity {
  outreach_id: number;
  slack_user_id: string;
  workos_user_id: string | null;
  outreach_type: string;
  sent_at: Date;
  user_responded: boolean;
  days_since_outreach: number;
  // Activity since outreach
  slack_messages_since: number;
  email_clicks_since: number;
  logins_since: number;
  conversations_since: number;
  // User status
  is_linked: boolean;
  is_member: boolean;
}

/**
 * Get outreach records that might need follow-up
 */
async function getOutreachNeedingReview(): Promise<OutreachWithActivity[]> {
  const result = await query<OutreachWithActivity>(
    `SELECT
      mo.id as outreach_id,
      mo.slack_user_id,
      sm.workos_user_id,
      mo.outreach_type,
      mo.sent_at,
      mo.user_responded,
      EXTRACT(DAY FROM NOW() - mo.sent_at)::integer as days_since_outreach,
      -- Slack activity since outreach
      COALESCE((
        SELECT COUNT(*)
        FROM slack_user_activity sa
        WHERE sa.slack_user_id = mo.slack_user_id
          AND sa.activity_date >= mo.sent_at::date
      ), 0)::integer as slack_messages_since,
      -- Email clicks since outreach
      COALESCE((
        SELECT COUNT(*)
        FROM email_tracking et
        WHERE et.recipient_email = sm.slack_email
          AND et.event_type = 'click'
          AND et.created_at >= mo.sent_at
      ), 0)::integer as email_clicks_since,
      -- Dashboard logins since outreach
      COALESCE((
        SELECT COUNT(*)
        FROM user_engagement ue
        WHERE ue.user_id = sm.workos_user_id
          AND ue.event_type = 'login'
          AND ue.created_at >= mo.sent_at
      ), 0)::integer as logins_since,
      -- Conversations with Addie since outreach
      COALESCE((
        SELECT COUNT(*)
        FROM addie_threads at
        WHERE (at.slack_user_id = mo.slack_user_id OR at.workos_user_id = sm.workos_user_id)
          AND at.created_at >= mo.sent_at
      ), 0)::integer as conversations_since,
      -- User status
      sm.workos_user_id IS NOT NULL as is_linked,
      EXISTS(
        SELECT 1 FROM organization_memberships om
        WHERE om.user_id = sm.workos_user_id
      ) as is_member
    FROM member_outreach mo
    JOIN slack_user_mappings sm ON sm.slack_user_id = mo.slack_user_id
    WHERE mo.sent_at >= NOW() - INTERVAL '${WARM_LEAD_DAYS} days'
      AND mo.sent_at <= NOW() - INTERVAL '1 day'  -- At least 1 day old
      -- No existing open action item for this outreach
      AND NOT EXISTS (
        SELECT 1 FROM action_items ai
        WHERE ai.trigger_type = 'outreach'
          AND ai.trigger_id = mo.id::text
          AND ai.status = 'open'
      )
    ORDER BY mo.sent_at DESC`
  );

  return result.rows;
}

/**
 * Check for organization conversions (new paid members)
 */
async function checkForConversions(): Promise<void> {
  // Find orgs that converted to paid in the last day
  const result = await query<{
    org_id: string;
    org_name: string;
    stakeholder_id: string | null;
  }>(
    `SELECT
      o.workos_organization_id as org_id,
      o.name as org_name,
      os.user_id as stakeholder_id
    FROM organizations o
    LEFT JOIN org_stakeholders os ON os.organization_id = o.workos_organization_id AND os.role = 'owner'
    WHERE o.subscription_status = 'active'
      AND o.updated_at >= NOW() - INTERVAL '1 day'
      -- No existing celebration action item
      AND NOT EXISTS (
        SELECT 1 FROM action_items ai
        WHERE ai.org_id = o.workos_organization_id
          AND ai.action_type = 'celebration'
          AND ai.created_at >= NOW() - INTERVAL '7 days'
      )`
  );

  for (const org of result.rows) {
    await createActionItem({
      orgId: org.org_id,
      assignedTo: org.stakeholder_id || undefined,
      actionType: 'celebration',
      priority: 'medium',
      title: `${org.org_name} converted to paid!`,
      description: 'New paying member - great time to welcome them and offer help.',
      triggerType: 'conversion',
      triggerId: org.org_id,
    });

    logger.info({ orgId: org.org_id, orgName: org.org_name }, 'Created celebration action item for conversion');
  }
}

/**
 * Check for account linking (Slack user linked to AAO account)
 */
async function checkForAccountLinks(): Promise<void> {
  // Find users who linked their accounts in the last day after outreach
  const result = await query<{
    slack_user_id: string;
    workos_user_id: string;
    user_name: string;
    outreach_id: number;
    stakeholder_id: string | null;
  }>(
    `SELECT
      sm.slack_user_id,
      sm.workos_user_id,
      COALESCE(sm.slack_real_name, sm.slack_display_name) as user_name,
      mo.id as outreach_id,
      us.stakeholder_id
    FROM slack_user_mappings sm
    JOIN member_outreach mo ON mo.slack_user_id = sm.slack_user_id
      AND mo.outreach_type = 'account_link'
    LEFT JOIN user_stakeholders us ON us.slack_user_id = sm.slack_user_id AND us.role = 'owner'
    WHERE sm.workos_user_id IS NOT NULL
      AND sm.updated_at >= NOW() - INTERVAL '1 day'
      AND mo.sent_at >= sm.updated_at - INTERVAL '7 days'  -- Linked within 7 days of outreach
      -- No existing celebration action item
      AND NOT EXISTS (
        SELECT 1 FROM action_items ai
        WHERE ai.slack_user_id = sm.slack_user_id
          AND ai.action_type = 'celebration'
          AND ai.created_at >= NOW() - INTERVAL '1 day'
      )`
  );

  for (const user of result.rows) {
    await createActionItem({
      slackUserId: user.slack_user_id,
      workosUserId: user.workos_user_id,
      assignedTo: user.stakeholder_id || undefined,
      actionType: 'celebration',
      priority: 'low',
      title: `${user.user_name} linked their account!`,
      description: 'User linked Slack to AAO account after outreach.',
      triggerType: 'account_link',
      triggerId: user.slack_user_id,
      context: { outreach_id: user.outreach_id },
    });

    logger.info({ slackUserId: user.slack_user_id }, 'Created celebration action item for account link');
  }
}

/**
 * Result of analyzing outreach - what action item would be created
 */
export interface OutreachAnalysisResult {
  outreach: OutreachWithActivity;
  wouldCreate: boolean;
  actionType: 'nudge' | 'warm_lead' | 'momentum' | null;
  title: string;
  description: string;
  priority: 'high' | 'medium' | 'low';
  totalActivity: number;
  reason: string;
}

/**
 * Analyze outreach and determine what action item should be created
 * Returns the analysis result without creating anything (for preview/dry-run)
 */
function analyzeOutreachResult(outreach: OutreachWithActivity): OutreachAnalysisResult {
  const totalActivity =
    outreach.slack_messages_since +
    outreach.email_clicks_since +
    outreach.logins_since +
    outreach.conversations_since;

  // Determine what kind of action item to create
  let actionType: 'nudge' | 'warm_lead' | 'momentum' | null = null;
  let title = '';
  let description = '';
  let priority: 'high' | 'medium' | 'low' = 'medium';
  let reason = '';

  if (outreach.user_responded) {
    // They responded - check if conversion happened
    if (outreach.outreach_type === 'account_link' && outreach.is_linked) {
      // Success! Handled by checkForAccountLinks
      reason = 'User responded AND linked account - success, no action needed';
    } else if (!outreach.is_linked && outreach.outreach_type === 'account_link') {
      // They responded but didn't convert yet - warm lead
      actionType = 'warm_lead';
      title = `Responded but didn't link account`;
      description = `User responded to outreach ${outreach.days_since_outreach} days ago but hasn't linked their account yet. May need help.`;
      priority = 'medium';
      reason = 'User responded to outreach but has not linked their account';
    } else {
      reason = 'User responded - monitoring';
    }
  } else if (totalActivity >= MOMENTUM_THRESHOLD) {
    // No direct response but lots of activity - momentum
    actionType = 'momentum';
    title = `Active user, good time to engage`;
    description = `No response to outreach but user has been active: ${outreach.slack_messages_since} Slack messages, ${outreach.email_clicks_since} email clicks, ${outreach.logins_since} logins.`;
    priority = 'low';
    reason = `High activity (${totalActivity} actions) without direct response - good engagement opportunity`;
  } else if (totalActivity > 0) {
    // Some activity but no response - warm lead
    actionType = 'warm_lead';
    title = `Some activity, might need a nudge`;
    description = `User has some activity since outreach (${totalActivity} actions) but hasn't responded directly.`;
    priority = 'medium';
    reason = `Some activity (${totalActivity} actions) but no direct response`;
  } else if (outreach.days_since_outreach >= NUDGE_DAYS) {
    // No activity at all - needs nudge
    actionType = 'nudge';
    title = `No response after ${outreach.days_since_outreach} days`;
    description = `Outreach sent ${outreach.days_since_outreach} days ago with no activity since. Consider a follow-up.`;
    priority = 'medium';
    reason = `No activity for ${outreach.days_since_outreach} days - needs follow-up`;
  } else {
    reason = `Only ${outreach.days_since_outreach} days since outreach - too early for nudge (wait ${NUDGE_DAYS} days)`;
  }

  return {
    outreach,
    wouldCreate: actionType !== null,
    actionType,
    title,
    description,
    priority,
    totalActivity,
    reason,
  };
}

/**
 * Analyze outreach and create appropriate action items
 */
async function analyzeOutreach(outreach: OutreachWithActivity): Promise<void> {
  const result = analyzeOutreachResult(outreach);

  if (result.wouldCreate && result.actionType) {
    await createActionItem({
      slackUserId: outreach.slack_user_id,
      workosUserId: outreach.workos_user_id || undefined,
      actionType: result.actionType,
      priority: result.priority,
      title: result.title,
      description: result.description,
      context: {
        outreach_id: outreach.outreach_id,
        outreach_type: outreach.outreach_type,
        days_since_outreach: outreach.days_since_outreach,
        slack_messages_since: outreach.slack_messages_since,
        email_clicks_since: outreach.email_clicks_since,
        logins_since: outreach.logins_since,
        conversations_since: outreach.conversations_since,
      },
      triggerType: 'outreach',
      triggerId: outreach.outreach_id.toString(),
    });

    logger.info({
      slackUserId: outreach.slack_user_id,
      actionType: result.actionType,
      outreachId: outreach.outreach_id,
    }, 'Created action item from outreach analysis');
  }
}

/**
 * Get outreach data for a specific user (for preview)
 */
async function getOutreachForUser(slackUserId: string): Promise<OutreachWithActivity[]> {
  const result = await query<OutreachWithActivity>(
    `SELECT
      mo.id as outreach_id,
      mo.slack_user_id,
      sm.workos_user_id,
      mo.outreach_type,
      mo.sent_at,
      mo.user_responded,
      EXTRACT(DAY FROM NOW() - mo.sent_at)::integer as days_since_outreach,
      -- Slack activity since outreach
      COALESCE((
        SELECT COUNT(*)
        FROM slack_user_activity sa
        WHERE sa.slack_user_id = mo.slack_user_id
          AND sa.activity_date >= mo.sent_at::date
      ), 0)::integer as slack_messages_since,
      -- Email clicks since outreach
      COALESCE((
        SELECT COUNT(*)
        FROM email_tracking et
        WHERE et.recipient_email = sm.slack_email
          AND et.event_type = 'click'
          AND et.created_at >= mo.sent_at
      ), 0)::integer as email_clicks_since,
      -- Dashboard logins since outreach
      COALESCE((
        SELECT COUNT(*)
        FROM user_engagement ue
        WHERE ue.user_id = sm.workos_user_id
          AND ue.event_type = 'login'
          AND ue.created_at >= mo.sent_at
      ), 0)::integer as logins_since,
      -- Conversations with Addie since outreach
      COALESCE((
        SELECT COUNT(*)
        FROM addie_threads at
        WHERE (at.slack_user_id = mo.slack_user_id OR at.workos_user_id = sm.workos_user_id)
          AND at.created_at >= mo.sent_at
      ), 0)::integer as conversations_since,
      -- User status
      sm.workos_user_id IS NOT NULL as is_linked,
      EXISTS(
        SELECT 1 FROM organization_memberships om
        WHERE om.user_id = sm.workos_user_id
      ) as is_member
    FROM member_outreach mo
    JOIN slack_user_mappings sm ON sm.slack_user_id = mo.slack_user_id
    WHERE mo.slack_user_id = $1
    ORDER BY mo.sent_at DESC
    LIMIT 10`,
    [slackUserId]
  );

  return result.rows;
}

/**
 * Preview momentum analysis for a specific user
 * Does NOT create any action items - just shows what would happen
 */
export async function previewMomentumForUser(slackUserId: string): Promise<{
  user: {
    slack_user_id: string;
    name: string | null;
    email: string | null;
    is_linked: boolean;
    is_member: boolean;
  };
  outreach: OutreachAnalysisResult[];
  existingActionItems: number;
}> {
  // Get user info
  const userResult = await query<{
    slack_user_id: string;
    slack_real_name: string | null;
    slack_display_name: string | null;
    slack_email: string | null;
    workos_user_id: string | null;
  }>(
    `SELECT slack_user_id, slack_real_name, slack_display_name, slack_email, workos_user_id
     FROM slack_user_mappings WHERE slack_user_id = $1`,
    [slackUserId]
  );

  if (userResult.rows.length === 0) {
    throw new Error(`User not found: ${slackUserId}`);
  }

  const userRow = userResult.rows[0];

  // Check if member
  const memberResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM organization_memberships WHERE user_id = $1`,
    [userRow.workos_user_id]
  );

  // Get existing action items
  const actionResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM action_items WHERE slack_user_id = $1 AND status = 'open'`,
    [slackUserId]
  );

  // Get and analyze outreach
  const outreachRecords = await getOutreachForUser(slackUserId);
  const analyses = outreachRecords.map(analyzeOutreachResult);

  return {
    user: {
      slack_user_id: slackUserId,
      name: userRow.slack_real_name || userRow.slack_display_name,
      email: userRow.slack_email,
      is_linked: userRow.workos_user_id !== null,
      is_member: parseInt(memberResult.rows[0].count, 10) > 0,
    },
    outreach: analyses,
    existingActionItems: parseInt(actionResult.rows[0].count, 10),
  };
}

/**
 * Dry-run the full momentum check job
 * Returns what WOULD be created without actually creating anything
 */
export async function dryRunMomentumCheck(): Promise<{
  outreachToAnalyze: number;
  wouldCreate: OutreachAnalysisResult[];
  wouldSkip: OutreachAnalysisResult[];
  snoozedToReopen: number;
}> {
  logger.info('Running momentum check dry-run');

  // Check snoozed items
  const snoozedResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM action_items WHERE status = 'snoozed' AND snoozed_until <= NOW()`
  );
  const snoozedToReopen = parseInt(snoozedResult.rows[0].count, 10);

  // Get outreach to analyze
  const outreachToReview = await getOutreachNeedingReview();

  const analyses = outreachToReview.map(analyzeOutreachResult);
  const wouldCreate = analyses.filter(a => a.wouldCreate);
  const wouldSkip = analyses.filter(a => !a.wouldCreate);

  logger.info({
    outreachToAnalyze: outreachToReview.length,
    wouldCreate: wouldCreate.length,
    wouldSkip: wouldSkip.length,
    snoozedToReopen,
  }, 'Momentum check dry-run completed');

  return {
    outreachToAnalyze: outreachToReview.length,
    wouldCreate,
    wouldSkip,
    snoozedToReopen,
  };
}

/**
 * Run the full momentum check job
 */
export async function runMomentumCheck(): Promise<{
  outreachAnalyzed: number;
  actionItemsCreated: number;
  snoozedReopened: number;
}> {
  logger.info('Running momentum check job');

  let actionItemsCreated = 0;

  // Reopen any snoozed items that are past their snooze time
  const snoozedReopened = await reopenSnoozedItems();
  if (snoozedReopened > 0) {
    logger.info({ count: snoozedReopened }, 'Reopened snoozed action items');
  }

  // Check for conversions
  await checkForConversions();

  // Check for account links
  await checkForAccountLinks();

  // Analyze outreach needing review
  const outreachToReview = await getOutreachNeedingReview();
  logger.info({ count: outreachToReview.length }, 'Found outreach records to analyze');

  for (const outreach of outreachToReview) {
    try {
      await analyzeOutreach(outreach);
      const result = analyzeOutreachResult(outreach);
      if (result.wouldCreate) actionItemsCreated++;
    } catch (error) {
      logger.error({ error, outreachId: outreach.outreach_id }, 'Error analyzing outreach');
    }
  }

  logger.info({
    outreachAnalyzed: outreachToReview.length,
    actionItemsCreated,
    snoozedReopened,
  }, 'Momentum check job completed');

  return {
    outreachAnalyzed: outreachToReview.length,
    actionItemsCreated,
    snoozedReopened,
  };
}
