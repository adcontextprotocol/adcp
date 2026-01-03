/**
 * Account Management Database Service
 *
 * Handles user/org stakeholders and action items for account management.
 * Supports auto-assignment from interactions and momentum-aware action items.
 */

import { query } from './client.js';

// Types
export type StakeholderRole = 'owner' | 'interested' | 'connected';
export type AssignmentReason = 'outreach' | 'conversation' | 'onboarding' | 'manual';
export type ActionType = 'nudge' | 'warm_lead' | 'momentum' | 'feedback' | 'alert' | 'follow_up' | 'celebration';
export type ActionPriority = 'high' | 'medium' | 'low';
export type ActionStatus = 'open' | 'snoozed' | 'completed' | 'dismissed';

export interface UserStakeholder {
  id: number;
  slack_user_id: string | null;
  workos_user_id: string | null;
  stakeholder_id: string;
  stakeholder_name: string;
  stakeholder_email: string | null;
  role: StakeholderRole;
  assignment_reason: AssignmentReason | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ActionItem {
  id: number;
  slack_user_id: string | null;
  workos_user_id: string | null;
  org_id: string | null;
  assigned_to: string | null;
  action_type: ActionType;
  priority: ActionPriority;
  title: string;
  description: string | null;
  context: Record<string, unknown>;
  trigger_type: string | null;
  trigger_id: string | null;
  trigger_data: Record<string, unknown> | null;
  status: ActionStatus;
  snoozed_until: Date | null;
  resolved_at: Date | null;
  resolved_by: string | null;
  resolution_note: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ActionItemWithContext extends ActionItem {
  user_name: string | null;
  user_email: string | null;
  org_name: string | null;
  assigned_to_name: string | null;
  assigned_to_email: string | null;
}

export interface MyAccount {
  account_type: 'user' | 'org';
  stakeholder_id: string;
  role: StakeholderRole;
  account_id: string;
  account_name: string | null;
  account_email: string | null;
  org_name: string | null;
  assignment_reason: string | null;
  assigned_at: Date;
  last_slack_activity: Date | null;
  last_conversation: Date | null;
  open_action_items: number;
}

// =====================================================
// USER STAKEHOLDERS
// =====================================================

/**
 * Assign a user to an admin (auto or manual)
 */
export async function assignUserStakeholder(params: {
  slackUserId?: string;
  workosUserId?: string;
  stakeholderId: string;
  stakeholderName: string;
  stakeholderEmail?: string;
  role?: StakeholderRole;
  reason?: AssignmentReason;
  notes?: string;
}): Promise<UserStakeholder | null> {
  const {
    slackUserId,
    workosUserId,
    stakeholderId,
    stakeholderName,
    stakeholderEmail,
    role = 'owner',
    reason,
    notes,
  } = params;

  if (!slackUserId && !workosUserId) {
    throw new Error('Must provide slackUserId or workosUserId');
  }

  const result = await query<UserStakeholder>(
    `INSERT INTO user_stakeholders (
      slack_user_id, workos_user_id,
      stakeholder_id, stakeholder_name, stakeholder_email,
      role, assignment_reason, notes
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT DO NOTHING
    RETURNING *`,
    [slackUserId, workosUserId, stakeholderId, stakeholderName, stakeholderEmail, role, reason, notes]
  );

  return result.rows[0] || null;
}

/**
 * Get the owner of a user account
 */
export async function getUserOwner(slackUserId?: string, workosUserId?: string): Promise<string | null> {
  const result = await query<{ stakeholder_id: string }>(
    `SELECT stakeholder_id FROM user_stakeholders
     WHERE (slack_user_id = $1 OR workos_user_id = $2)
       AND role = 'owner'
     LIMIT 1`,
    [slackUserId, workosUserId]
  );

  return result.rows[0]?.stakeholder_id || null;
}

/**
 * Get all stakeholders for a user
 */
export async function getUserStakeholders(slackUserId?: string, workosUserId?: string): Promise<UserStakeholder[]> {
  const result = await query<UserStakeholder>(
    `SELECT * FROM user_stakeholders
     WHERE slack_user_id = $1 OR workos_user_id = $2
     ORDER BY role, created_at`,
    [slackUserId, workosUserId]
  );

  return result.rows;
}

/**
 * Get accounts assigned to an admin
 */
export async function getMyAccounts(stakeholderId: string): Promise<MyAccount[]> {
  const result = await query<MyAccount>(
    `SELECT * FROM my_accounts
     WHERE stakeholder_id = $1
     ORDER BY open_action_items DESC, assigned_at DESC`,
    [stakeholderId]
  );

  return result.rows;
}

/**
 * Remove stakeholder assignment
 */
export async function removeUserStakeholder(
  slackUserId: string | undefined,
  workosUserId: string | undefined,
  stakeholderId: string
): Promise<boolean> {
  const result = await query(
    `DELETE FROM user_stakeholders
     WHERE (slack_user_id = $1 OR workos_user_id = $2)
       AND stakeholder_id = $3`,
    [slackUserId, workosUserId, stakeholderId]
  );

  return (result.rowCount ?? 0) > 0;
}

// =====================================================
// ACTION ITEMS
// =====================================================

/**
 * Create an action item
 */
export async function createActionItem(params: {
  slackUserId?: string;
  workosUserId?: string;
  orgId?: string;
  assignedTo?: string;
  actionType: ActionType;
  priority?: ActionPriority;
  title: string;
  description?: string;
  context?: Record<string, unknown>;
  triggerType?: string;
  triggerId?: string;
  triggerData?: Record<string, unknown>;
}): Promise<ActionItem> {
  const {
    slackUserId,
    workosUserId,
    orgId,
    assignedTo,
    actionType,
    priority = 'medium',
    title,
    description,
    context = {},
    triggerType,
    triggerId,
    triggerData,
  } = params;

  // If no assignee specified, try to find the account owner
  let finalAssignedTo = assignedTo;
  if (!finalAssignedTo) {
    if (slackUserId || workosUserId) {
      finalAssignedTo = await getUserOwner(slackUserId, workosUserId) ?? undefined;
    }
    // Could also check org_stakeholders for org_id
  }

  const result = await query<ActionItem>(
    `INSERT INTO action_items (
      slack_user_id, workos_user_id, org_id,
      assigned_to, action_type, priority,
      title, description, context,
      trigger_type, trigger_id, trigger_data
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    ON CONFLICT (trigger_type, trigger_id) WHERE trigger_type IS NOT NULL AND trigger_id IS NOT NULL AND status = 'open'
    DO NOTHING
    RETURNING *`,
    [
      slackUserId, workosUserId, orgId,
      finalAssignedTo, actionType, priority,
      title, description, JSON.stringify(context),
      triggerType, triggerId, triggerData ? JSON.stringify(triggerData) : null,
    ]
  );

  // If conflict (already exists), return null-ish but don't fail
  if (!result.rows[0]) {
    // Return existing item
    const existing = await query<ActionItem>(
      `SELECT * FROM action_items
       WHERE trigger_type = $1 AND trigger_id = $2 AND status = 'open'`,
      [triggerType, triggerId]
    );
    return existing.rows[0];
  }

  return result.rows[0];
}

/**
 * Get action items with filters
 */
export async function getActionItems(params: {
  assignedTo?: string;
  slackUserId?: string;
  workosUserId?: string;
  orgId?: string;
  status?: ActionStatus | ActionStatus[];
  actionType?: ActionType | ActionType[];
  priority?: ActionPriority | ActionPriority[];
  limit?: number;
  offset?: number;
}): Promise<ActionItemWithContext[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (params.assignedTo) {
    conditions.push(`assigned_to = $${paramIndex++}`);
    values.push(params.assignedTo);
  }

  if (params.slackUserId) {
    conditions.push(`slack_user_id = $${paramIndex++}`);
    values.push(params.slackUserId);
  }

  if (params.workosUserId) {
    conditions.push(`workos_user_id = $${paramIndex++}`);
    values.push(params.workosUserId);
  }

  if (params.orgId) {
    conditions.push(`org_id = $${paramIndex++}`);
    values.push(params.orgId);
  }

  if (params.status) {
    const statuses = Array.isArray(params.status) ? params.status : [params.status];
    conditions.push(`status = ANY($${paramIndex++})`);
    values.push(statuses);
  }

  if (params.actionType) {
    const types = Array.isArray(params.actionType) ? params.actionType : [params.actionType];
    conditions.push(`action_type = ANY($${paramIndex++})`);
    values.push(types);
  }

  if (params.priority) {
    const priorities = Array.isArray(params.priority) ? params.priority : [params.priority];
    conditions.push(`priority = ANY($${paramIndex++})`);
    values.push(priorities);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = params.limit || 50;
  const offset = params.offset || 0;

  const result = await query<ActionItemWithContext>(
    `SELECT * FROM action_items_with_context
     ${whereClause}
     ORDER BY
       CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
       created_at DESC
     LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
    [...values, limit, offset]
  );

  return result.rows;
}

/**
 * Get open action items for the admin dashboard
 */
export async function getOpenActionItems(assignedTo?: string, limit = 20): Promise<ActionItemWithContext[]> {
  return getActionItems({
    assignedTo,
    status: 'open',
    limit,
  });
}

/**
 * Update action item status
 */
export async function updateActionItemStatus(
  id: number,
  status: ActionStatus,
  options?: {
    resolvedBy?: string;
    resolutionNote?: string;
    snoozedUntil?: Date;
  }
): Promise<ActionItem | null> {
  const updates: string[] = ['status = $2', 'updated_at = NOW()'];
  const values: unknown[] = [id, status];
  let paramIndex = 3;

  if (status === 'completed' || status === 'dismissed') {
    updates.push(`resolved_at = NOW()`);
    if (options?.resolvedBy) {
      updates.push(`resolved_by = $${paramIndex++}`);
      values.push(options.resolvedBy);
    }
    if (options?.resolutionNote) {
      updates.push(`resolution_note = $${paramIndex++}`);
      values.push(options.resolutionNote);
    }
  }

  if (status === 'snoozed' && options?.snoozedUntil) {
    updates.push(`snoozed_until = $${paramIndex++}`);
    values.push(options.snoozedUntil);
  }

  const result = await query<ActionItem>(
    `UPDATE action_items SET ${updates.join(', ')} WHERE id = $1 RETURNING *`,
    values
  );

  return result.rows[0] || null;
}

/**
 * Complete an action item
 */
export async function completeActionItem(
  id: number,
  resolvedBy: string,
  resolutionNote?: string
): Promise<ActionItem | null> {
  return updateActionItemStatus(id, 'completed', { resolvedBy, resolutionNote });
}

/**
 * Dismiss an action item
 */
export async function dismissActionItem(
  id: number,
  resolvedBy: string,
  resolutionNote?: string
): Promise<ActionItem | null> {
  return updateActionItemStatus(id, 'dismissed', { resolvedBy, resolutionNote });
}

/**
 * Snooze an action item
 */
export async function snoozeActionItem(id: number, until: Date): Promise<ActionItem | null> {
  return updateActionItemStatus(id, 'snoozed', { snoozedUntil: until });
}

/**
 * Reopen snoozed items that are past their snooze time
 */
export async function reopenSnoozedItems(): Promise<number> {
  const result = await query(
    `UPDATE action_items
     SET status = 'open', snoozed_until = NULL, updated_at = NOW()
     WHERE status = 'snoozed' AND snoozed_until <= NOW()`
  );

  return result.rowCount ?? 0;
}

/**
 * Get action item counts by type and priority
 */
export async function getActionItemStats(assignedTo?: string): Promise<{
  total_open: number;
  by_priority: { high: number; medium: number; low: number };
  by_type: Record<ActionType, number>;
}> {
  const whereClause = assignedTo ? `WHERE assigned_to = $1 AND status = 'open'` : `WHERE status = 'open'`;
  const values = assignedTo ? [assignedTo] : [];

  const result = await query<{
    total_open: string;
    high_count: string;
    medium_count: string;
    low_count: string;
    nudge_count: string;
    warm_lead_count: string;
    momentum_count: string;
    feedback_count: string;
    alert_count: string;
    follow_up_count: string;
    celebration_count: string;
  }>(
    `SELECT
      COUNT(*) as total_open,
      COUNT(*) FILTER (WHERE priority = 'high') as high_count,
      COUNT(*) FILTER (WHERE priority = 'medium') as medium_count,
      COUNT(*) FILTER (WHERE priority = 'low') as low_count,
      COUNT(*) FILTER (WHERE action_type = 'nudge') as nudge_count,
      COUNT(*) FILTER (WHERE action_type = 'warm_lead') as warm_lead_count,
      COUNT(*) FILTER (WHERE action_type = 'momentum') as momentum_count,
      COUNT(*) FILTER (WHERE action_type = 'feedback') as feedback_count,
      COUNT(*) FILTER (WHERE action_type = 'alert') as alert_count,
      COUNT(*) FILTER (WHERE action_type = 'follow_up') as follow_up_count,
      COUNT(*) FILTER (WHERE action_type = 'celebration') as celebration_count
     FROM action_items
     ${whereClause}`,
    values
  );

  const row = result.rows[0];
  return {
    total_open: parseInt(row.total_open, 10),
    by_priority: {
      high: parseInt(row.high_count, 10),
      medium: parseInt(row.medium_count, 10),
      low: parseInt(row.low_count, 10),
    },
    by_type: {
      nudge: parseInt(row.nudge_count, 10),
      warm_lead: parseInt(row.warm_lead_count, 10),
      momentum: parseInt(row.momentum_count, 10),
      feedback: parseInt(row.feedback_count, 10),
      alert: parseInt(row.alert_count, 10),
      follow_up: parseInt(row.follow_up_count, 10),
      celebration: parseInt(row.celebration_count, 10),
    },
  };
}
