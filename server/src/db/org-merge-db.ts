/**
 * Organization Merge Database Operations
 *
 * Read-only merge inspection. Merging two organizations — moving all related
 * data from a secondary organization to a primary one, for duplicate cleanup or
 * company consolidation — is not currently performed here.
 *
 * #6827: `mergeOrganizations` is CONTAINED and executes nothing. Merge deletes
 * the secondary organization, and that lifecycle has no durable journal or
 * reconciliation contract, so the function refuses at the shared service
 * boundary. `previewMerge` below is read-only (SELECT/COUNT only) and remains
 * available.
 */

import { getPool } from './client.js';
import { createLogger } from '../logger.js';
import { OrganizationMergeUnavailableError } from './org-merge-containment.js';
import type { WorkOS } from '@workos-inc/node';

const logger = createLogger('org-merge-db');

export interface MergeSummary {
  primary_org_id: string;
  secondary_org_id: string;
  merged_by: string;
  merged_at: Date;
  tables_merged: {
    table_name: string;
    rows_moved: number;
    /** Only set on tables with a uniqueness conflict. Omitted for plain UPDATEs (e.g. users.primary_organization_id repoint). */
    rows_skipped_duplicate?: number;
  }[];
  prospect_notes_merged: boolean;
  enrichment_data_preserved: boolean;
  stripe_customer_action: 'kept_primary' | 'moved_from_secondary' | 'none' | 'conflict_unresolved' | null;
  workos_org_deleted: boolean;
  warnings: string[];
}

export type StripeCustomerResolution = 'keep_primary' | 'use_secondary' | 'keep_both_unlinked';

/**
 * CONTAINED (#6827). Always throws `OrganizationMergeUnavailableError` and
 * never merges, never deletes an organization and never calls a provider.
 *
 * Existing callers keep type-checking and the re-enable change does not have to
 * rediscover the contract. `_workos` and `_options` are accepted and ignored,
 * and `_workos` is optional so a caller is never pushed into constructing a
 * provider client for a call that always throws. Expect the re-enable change to
 * make it required again — widening it here is a property of the containment,
 * not of the eventual merge contract.
 *
 * @param primaryOrgId - The organization that would be kept (logged only)
 * @param secondaryOrgId - The organization that would be removed (logged only)
 * @param mergedBy - WorkOS user ID of the person initiating the merge (logged only)
 * @throws OrganizationMergeUnavailableError always; the `never` return type
 *   states that no MergeSummary is ever produced.
 */
export async function mergeOrganizations(
  primaryOrgId: string,
  secondaryOrgId: string,
  mergedBy: string,
  _workos?: WorkOS,
  _options?: {
    stripeCustomerResolution?: StripeCustomerResolution;
  }
): Promise<never> {
  // #6827 containment, defense in depth. This is the shared boundary every
  // merge caller passes through, so the refusal lives here and not only at the
  // contained route and the contained Addie tool: an overlooked or new caller
  // cannot reach the old sequence. It runs before getPool(), before
  // pool.connect() and before BEGIN, so there is no row lock, local write,
  // organization deletion, WorkOS membership write, provider organization
  // deletion, Stripe operation, audit row, cache invalidation or notification.
  //
  // The previous implementation is deliberately removed rather than left
  // unreachable behind this throw. That sequence IS the hazard — local delete,
  // commit, then a best-effort provider delete whose failure became a warning —
  // so re-enabling merge must be a new reviewed implementation satisfying the
  // lifecycle contract in docs/contributing/organization-deletion-containment.md,
  // not the deletion of a guard. Nothing is journalled and nothing is partially
  // applied because nothing is attempted. The removed body is readable in git
  // history at commit 97652f89 and earlier, as reference only — never as a
  // restore target.
  logger.warn(
    { primaryOrgId, secondaryOrgId, mergedBy },
    'Refused contained organization merge at the shared service boundary'
  );
  throw new OrganizationMergeUnavailableError();
}

/**
 * Get a preview of what would be merged without actually performing the merge
 *
 * @param primaryOrgId - The organization to keep
 * @param secondaryOrgId - The organization to remove
 * @returns Preview of merge operation
 */
export async function previewMerge(
  primaryOrgId: string,
  secondaryOrgId: string
): Promise<{
  primary_org: { id: string; name: string };
  secondary_org: { id: string; name: string };
  estimated_changes: {
    table_name: string;
    rows_to_move: number;
  }[];
  stripe_customer_conflict: {
    has_conflict: boolean;
    primary_customer_id: string | null;
    secondary_customer_id: string | null;
    requires_resolution: boolean;
  };
  warnings: string[];
}> {
  const pool = getPool();

  // Get organization names, personal workspace status, and stripe info
  const orgsResult = await pool.query(
    `SELECT workos_organization_id, name, is_personal, stripe_customer_id FROM organizations
     WHERE workos_organization_id = ANY($1)`,
    [[primaryOrgId, secondaryOrgId]]
  );

  if (orgsResult.rows.length !== 2) {
    throw new Error('Both organizations must exist');
  }

  const primaryOrg = orgsResult.rows.find(r => r.workos_organization_id === primaryOrgId);
  const secondaryOrg = orgsResult.rows.find(r => r.workos_organization_id === secondaryOrgId);

  if (!primaryOrg || !secondaryOrg) {
    throw new Error('Could not load organization details');
  }

  const warnings: string[] = [];

  // Warn if either organization is a personal workspace
  if (primaryOrg.is_personal) {
    warnings.unshift(`🔴 PRIMARY IS PERSONAL WORKSPACE: "${primaryOrg.name}" is a personal workspace and should not be merged with company organizations.`);
  }
  if (secondaryOrg.is_personal) {
    warnings.unshift(`🔴 SECONDARY IS PERSONAL WORKSPACE: "${secondaryOrg.name}" is a personal workspace and should not be merged with company organizations.`);
  }
  const estimatedChanges: { table_name: string; rows_to_move: number }[] = [];

  // Count rows in each table
  const tables = [
    { table: 'organization_memberships', column: 'workos_organization_id' },
    { table: 'organization_domains', column: 'workos_organization_id' },
    { table: 'organization_join_requests', column: 'workos_organization_id' },
    { table: 'working_group_memberships', column: 'workos_organization_id' },
    { table: 'member_profiles', column: 'workos_organization_id' },
    { table: 'org_activities', column: 'organization_id' },
    { table: 'org_stakeholders', column: 'organization_id' },
    { table: 'slack_activity_daily', column: 'organization_id' },
    { table: 'email_events', column: 'workos_organization_id' },
    { table: 'email_contacts', column: 'organization_id' },
    { table: 'action_items', column: 'org_id' },
    { table: 'registry_audit_log', column: 'workos_organization_id' },
    { table: 'revenue_events', column: 'workos_organization_id' },
    { table: 'subscription_line_items', column: 'workos_organization_id' },
    { table: 'event_registrations', column: 'organization_id' },
    { table: 'event_sponsorships', column: 'organization_id' },
    { table: 'user_agreement_acceptances', column: 'workos_organization_id' },
    { table: 'org_admin_group_dms', column: 'workos_organization_id' },
    { table: 'agent_contexts', column: 'organization_id' },
    { table: 'person_relationships', column: 'prospect_org_id' },
    { table: 'certification_goals', column: 'workos_organization_id' },
    { table: 'certification_expectations', column: 'workos_organization_id' },
    { table: 'user_goal_history', column: 'prospect_org_id' },
  ];

  for (const { table, column } of tables) {
    const result = await pool.query(
      `SELECT COUNT(*) as count FROM ${table} WHERE ${column} = $1`,
      [secondaryOrgId]
    );

    const count = parseInt(result.rows[0].count, 10);
    if (count > 0) {
      estimatedChanges.push({
        table_name: table,
        rows_to_move: count,
      });
    }
  }

  // Check org data to determine if user might have picked the wrong primary
  const orgDataCheck = await pool.query(
    `SELECT
       o.workos_organization_id,
       o.stripe_customer_id,
       o.stripe_subscription_id,
       o.subscription_status,
       o.enrichment_at,
       (SELECT COUNT(*) FROM organization_memberships WHERE workos_organization_id = o.workos_organization_id) as member_count,
       (SELECT COUNT(*) FROM member_profiles WHERE workos_organization_id = o.workos_organization_id) as has_profile,
       (SELECT COUNT(*) FROM working_group_memberships WHERE workos_organization_id = o.workos_organization_id) as wg_count,
       (SELECT COUNT(*) FROM revenue_events WHERE workos_organization_id = o.workos_organization_id) as revenue_events
     FROM organizations o
     WHERE o.workos_organization_id = ANY($1)`,
    [[primaryOrgId, secondaryOrgId]]
  );

  const primaryData = orgDataCheck.rows.find(r => r.workos_organization_id === primaryOrgId);
  const secondaryData = orgDataCheck.rows.find(r => r.workos_organization_id === secondaryOrgId);

  // Calculate a "value score" for each org - higher = more valuable to keep as primary
  const scoreOrg = (data: typeof primaryData) => {
    if (!data) return 0;
    let score = 0;
    // Stripe is most important - paying customer
    if (data.stripe_customer_id) score += 100;
    if (data.stripe_subscription_id) score += 50;
    if (data.subscription_status === 'active') score += 50;
    // Revenue history
    score += parseInt(data.revenue_events, 10) * 20;
    // Member engagement
    score += parseInt(data.member_count, 10) * 5;
    score += parseInt(data.wg_count, 10) * 10;
    if (parseInt(data.has_profile, 10) > 0) score += 15;
    // Enrichment data
    if (data.enrichment_at) score += 10;
    return score;
  };

  const primaryScore = scoreOrg(primaryData);
  const secondaryScore = scoreOrg(secondaryData);

  // If secondary has significantly more "value", warn strongly
  if (secondaryScore > primaryScore) {
    const reasons: string[] = [];
    if (secondaryData?.stripe_customer_id && !primaryData?.stripe_customer_id) {
      reasons.push('has Stripe customer');
    }
    if (secondaryData?.stripe_subscription_id && !primaryData?.stripe_subscription_id) {
      reasons.push('has active subscription');
    }
    if (parseInt(secondaryData?.revenue_events || '0', 10) > parseInt(primaryData?.revenue_events || '0', 10)) {
      reasons.push('has payment history');
    }
    if (parseInt(secondaryData?.member_count || '0', 10) > parseInt(primaryData?.member_count || '0', 10)) {
      reasons.push(`more members (${secondaryData?.member_count} vs ${primaryData?.member_count})`);
    }
    if (parseInt(secondaryData?.wg_count || '0', 10) > parseInt(primaryData?.wg_count || '0', 10)) {
      reasons.push('more working group participation');
    }

    if (reasons.length > 0) {
      warnings.unshift(`🔴 SWAP RECOMMENDED: The secondary org ${reasons.join(', ')}. Consider making it the primary instead.`);
    }
  }

  // Check for member profile conflict
  if (parseInt(primaryData?.has_profile || '0', 10) > 0 && parseInt(secondaryData?.has_profile || '0', 10) > 0) {
    warnings.push('Both organizations have member profiles - secondary profile will be deleted');
  }

  // Build Stripe customer conflict info
  const primaryCustomerId = primaryData?.stripe_customer_id || primaryOrg.stripe_customer_id || null;
  const secondaryCustomerId = secondaryData?.stripe_customer_id || secondaryOrg.stripe_customer_id || null;
  const bothHaveStripe = !!primaryCustomerId && !!secondaryCustomerId;

  // Stripe-specific warnings
  if (bothHaveStripe) {
    warnings.push(
      `🔴 STRIPE CONFLICT: Both orgs have Stripe customers (primary: ${primaryCustomerId}, secondary: ${secondaryCustomerId}). ` +
      `You must specify stripeCustomerResolution: 'keep_primary', 'use_secondary', or 'keep_both_unlinked'`
    );
  } else if (secondaryCustomerId && !primaryCustomerId) {
    warnings.push(`⚠️ STRIPE: Secondary org's Stripe customer ${secondaryCustomerId} will be moved to primary org`);
  }

  if (secondaryData?.stripe_subscription_id) {
    const status = secondaryData.subscription_status || 'unknown';
    warnings.push(`⚠️ STRIPE: Secondary org has subscription ${secondaryData.stripe_subscription_id} (status: ${status}) - cancel in Stripe before merging`);
  }

  // Check for admin DM channel conflict
  const adminDmCheck = await pool.query(
    `SELECT workos_organization_id FROM org_admin_group_dms WHERE workos_organization_id = ANY($1)`,
    [[primaryOrgId, secondaryOrgId]]
  );

  if (adminDmCheck.rows.length === 2) {
    warnings.push('Both organizations have Slack admin DM channels - secondary channel will be removed');
  }

  return {
    primary_org: { id: primaryOrg.workos_organization_id, name: primaryOrg.name },
    secondary_org: { id: secondaryOrg.workos_organization_id, name: secondaryOrg.name },
    estimated_changes: estimatedChanges,
    stripe_customer_conflict: {
      has_conflict: bothHaveStripe,
      primary_customer_id: primaryCustomerId,
      secondary_customer_id: secondaryCustomerId,
      requires_resolution: bothHaveStripe,
    },
    warnings,
  };
}
