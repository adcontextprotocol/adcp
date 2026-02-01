/**
 * Database layer for Addie escalations
 * Tracks requests that Addie escalates to human admins
 */

import { query } from './client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('escalation-db');

// ============== Types ==============

export type EscalationCategory =
  | 'capability_gap'
  | 'needs_human_action'
  | 'complex_request'
  | 'sensitive_topic'
  | 'other';

export type EscalationPriority = 'low' | 'normal' | 'high' | 'urgent';

export type EscalationStatus =
  | 'open'
  | 'acknowledged'
  | 'in_progress'
  | 'resolved'
  | 'wont_do'
  | 'expired';

export interface Escalation {
  id: number;
  thread_id: string | null;
  message_id: string | null;
  slack_user_id: string | null;
  workos_user_id: string | null;
  user_display_name: string | null;
  category: EscalationCategory;
  priority: EscalationPriority;
  summary: string;
  original_request: string | null;
  addie_context: string | null;
  notification_channel_id: string | null;
  notification_sent_at: Date | null;
  notification_message_ts: string | null;
  status: EscalationStatus;
  resolved_by: string | null;
  resolved_at: Date | null;
  resolution_notes: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface EscalationInput {
  thread_id?: string;
  message_id?: string;
  slack_user_id?: string;
  workos_user_id?: string;
  user_display_name?: string;
  category: EscalationCategory;
  priority?: EscalationPriority;
  summary: string;
  original_request?: string;
  addie_context?: string;
}

export interface EscalationFilters {
  status?: EscalationStatus;
  category?: EscalationCategory;
  limit?: number;
  offset?: number;
}

// ============== Escalation Operations ==============

/**
 * Create a new escalation
 */
export async function createEscalation(input: EscalationInput): Promise<Escalation> {
  const result = await query<Escalation>(
    `INSERT INTO addie_escalations (
      thread_id, message_id, slack_user_id, workos_user_id, user_display_name,
      category, priority, summary, original_request, addie_context
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING *`,
    [
      input.thread_id || null,
      input.message_id || null,
      input.slack_user_id || null,
      input.workos_user_id || null,
      input.user_display_name || null,
      input.category,
      input.priority || 'normal',
      input.summary,
      input.original_request || null,
      input.addie_context || null,
    ]
  );
  return result.rows[0];
}

/**
 * Get a single escalation by ID
 */
export async function getEscalation(id: number): Promise<Escalation | null> {
  const result = await query<Escalation>(
    `SELECT * FROM addie_escalations WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

/**
 * List escalations with optional filters
 */
export async function listEscalations(filters: EscalationFilters = {}): Promise<Escalation[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  if (filters.status) {
    conditions.push(`status = $${paramIndex++}`);
    params.push(filters.status);
  }

  if (filters.category) {
    conditions.push(`category = $${paramIndex++}`);
    params.push(filters.category);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters.limit || 50;
  const offset = filters.offset || 0;

  // Assign parameter indexes explicitly for clarity
  const limitParamIndex = paramIndex++;
  const offsetParamIndex = paramIndex;
  params.push(limit, offset);

  const result = await query<Escalation>(
    `SELECT * FROM addie_escalations
     ${whereClause}
     ORDER BY
       CASE priority
         WHEN 'urgent' THEN 1
         WHEN 'high' THEN 2
         WHEN 'normal' THEN 3
         WHEN 'low' THEN 4
       END,
       created_at DESC
     LIMIT $${limitParamIndex} OFFSET $${offsetParamIndex}`,
    params
  );
  return result.rows;
}

/**
 * Count escalations with filters (for pagination)
 */
export async function countEscalations(
  filters: Omit<EscalationFilters, 'limit' | 'offset'> = {}
): Promise<number> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  if (filters.status) {
    conditions.push(`status = $${paramIndex++}`);
    params.push(filters.status);
  }

  if (filters.category) {
    conditions.push(`category = $${paramIndex++}`);
    params.push(filters.category);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM addie_escalations ${whereClause}`,
    params
  );
  return parseInt(result.rows[0]?.count || '0', 10);
}

/**
 * Get open escalations count by category
 */
export async function getEscalationStats(): Promise<{
  open: number;
  resolved_today: number;
  by_category: Record<string, number>;
}> {
  const [openCount, resolvedToday, byCategory] = await Promise.all([
    query<{ count: string }>(
      `SELECT COUNT(*) as count FROM addie_escalations WHERE status = 'open'`
    ),
    query<{ count: string }>(
      `SELECT COUNT(*) as count FROM addie_escalations
       WHERE status = 'resolved' AND resolved_at > NOW() - INTERVAL '24 hours'`
    ),
    query<{ category: string; count: string }>(
      `SELECT category, COUNT(*) as count FROM addie_escalations
       WHERE status = 'open'
       GROUP BY category`
    ),
  ]);

  const byCategoryMap: Record<string, number> = {};
  for (const row of byCategory.rows) {
    byCategoryMap[row.category] = parseInt(row.count, 10);
  }

  return {
    open: parseInt(openCount.rows[0]?.count || '0', 10),
    resolved_today: parseInt(resolvedToday.rows[0]?.count || '0', 10),
    by_category: byCategoryMap,
  };
}

/**
 * Update escalation status
 */
export async function updateEscalationStatus(
  id: number,
  status: EscalationStatus,
  resolvedBy?: string,
  notes?: string
): Promise<Escalation | null> {
  const isResolved = status === 'resolved' || status === 'wont_do' || status === 'expired';

  const result = await query<Escalation>(
    `UPDATE addie_escalations
     SET status = $2,
         resolved_by = CASE WHEN $3::text IS NOT NULL THEN $3 ELSE resolved_by END,
         resolved_at = CASE WHEN $4 THEN NOW() ELSE resolved_at END,
         resolution_notes = CASE WHEN $5::text IS NOT NULL THEN $5 ELSE resolution_notes END,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id, status, resolvedBy || null, isResolved, notes || null]
  );
  return result.rows[0] || null;
}

/**
 * Mark notification as sent
 */
export async function markNotificationSent(
  id: number,
  channelId: string,
  messageTs: string
): Promise<void> {
  await query(
    `UPDATE addie_escalations
     SET notification_channel_id = $2,
         notification_sent_at = NOW(),
         notification_message_ts = $3,
         updated_at = NOW()
     WHERE id = $1`,
    [id, channelId, messageTs]
  );
}

/**
 * Get escalations for a specific thread
 */
export async function getEscalationsForThread(threadId: string): Promise<Escalation[]> {
  const result = await query<Escalation>(
    `SELECT * FROM addie_escalations WHERE thread_id = $1 ORDER BY created_at DESC`,
    [threadId]
  );
  return result.rows;
}

/**
 * Build the notification message for escalation resolution
 * Shared between API endpoint and Addie tool to ensure consistency
 */
export function buildResolutionNotificationMessage(
  escalation: Escalation,
  status: 'resolved' | 'wont_do',
  customMessage?: string
): string {
  const statusLabel = status === 'resolved' ? 'resolved' : 'reviewed and closed';
  const defaultMessage = `Your request has been ${statusLabel}: "${escalation.summary}"`;

  return customMessage
    ? `${defaultMessage}\n\n${customMessage}`
    : defaultMessage;
}
