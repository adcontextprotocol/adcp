import { query } from './client.js';

export interface DigestRecord {
  id: number;
  edition_date: Date;
  status: 'draft' | 'approved' | 'sent' | 'skipped';
  approved_by: string | null;
  approved_at: Date | null;
  review_channel_id: string | null;
  review_message_ts: string | null;
  content: DigestContent;
  created_at: Date;
  sent_at: Date | null;
  send_stats: DigestSendStats | null;
}

export interface DigestContent {
  intro: string;
  news: DigestNewsItem[];
  newMembers: DigestNewMember[];
  conversations: DigestConversation[];
  workingGroups: DigestWorkingGroup[];
  generatedAt: string;
}

export interface DigestNewsItem {
  title: string;
  url: string;
  summary: string;
  whyItMatters: string;
  tags: string[];
  knowledgeId?: number;
}

export interface DigestNewMember {
  name: string;
}

export interface DigestConversation {
  summary: string;
  channelName: string;
  threadUrl: string;
  participants: string[];
}

export interface DigestWorkingGroup {
  name: string;
  summary: string;
  nextMeeting?: string;
}

export interface DigestSendStats {
  email_count: number;
  slack_count: number;
  by_segment: Record<string, number>;
}

export interface DigestEmailRecipient {
  workos_user_id: string;
  email: string;
  first_name: string | null;
  has_slack: boolean;
}

export interface DigestArticle {
  id: number;
  title: string;
  source_url: string;
  summary: string;
  addie_notes: string;
  quality_score: number;
  relevance_tags: string[];
  published_at: Date | null;
}

/**
 * Create a new digest draft. Returns null if one already exists for this date.
 */
export async function createDigest(
  editionDate: string,
  content: DigestContent,
): Promise<DigestRecord | null> {
  const result = await query<DigestRecord>(
    `INSERT INTO weekly_digests (edition_date, status, content)
     VALUES ($1, 'draft', $2)
     ON CONFLICT (edition_date) DO NOTHING
     RETURNING *`,
    [editionDate, JSON.stringify(content)],
  );
  return result.rows[0] || null;
}

/**
 * Get a digest by its edition date (YYYY-MM-DD)
 */
export async function getDigestByDate(editionDate: string): Promise<DigestRecord | null> {
  const result = await query<DigestRecord>(
    `SELECT * FROM weekly_digests WHERE edition_date = $1`,
    [editionDate],
  );
  return result.rows[0] || null;
}

/**
 * Get the current week's digest (most recent by edition_date)
 */
export async function getCurrentWeekDigest(): Promise<DigestRecord | null> {
  const result = await query<DigestRecord>(
    `SELECT * FROM weekly_digests
     WHERE edition_date >= CURRENT_DATE - INTERVAL '7 days'
     ORDER BY edition_date DESC
     LIMIT 1`,
  );
  return result.rows[0] || null;
}

/**
 * Approve a digest. Sets status to 'approved' and records who approved it.
 */
export async function approveDigest(id: number, approvedBy: string): Promise<DigestRecord | null> {
  const result = await query<DigestRecord>(
    `UPDATE weekly_digests
     SET status = 'approved', approved_by = $2, approved_at = NOW()
     WHERE id = $1 AND status = 'draft'
     RETURNING *`,
    [id, approvedBy],
  );
  return result.rows[0] || null;
}

/**
 * Update the review message reference after posting to Slack
 */
export async function setReviewMessage(
  id: number,
  channelId: string,
  messageTs: string,
): Promise<void> {
  await query(
    `UPDATE weekly_digests
     SET review_channel_id = $2, review_message_ts = $3
     WHERE id = $1`,
    [id, channelId, messageTs],
  );
}

/**
 * Mark a digest as sent with stats
 */
export async function markSent(id: number, stats: DigestSendStats): Promise<void> {
  await query(
    `UPDATE weekly_digests
     SET status = 'sent', sent_at = NOW(), send_stats = $2
     WHERE id = $1`,
    [id, JSON.stringify(stats)],
  );
}

/**
 * Mark a digest as skipped (no approval received in time)
 */
export async function markSkipped(id: number): Promise<void> {
  await query(
    `UPDATE weekly_digests SET status = 'skipped' WHERE id = $1`,
    [id],
  );
}

/**
 * Find a digest by its Slack review message
 */
export async function getDigestByReviewMessage(
  channelId: string,
  messageTs: string,
): Promise<DigestRecord | null> {
  const result = await query<DigestRecord>(
    `SELECT * FROM weekly_digests
     WHERE review_channel_id = $1 AND review_message_ts = $2`,
    [channelId, messageTs],
  );
  return result.rows[0] || null;
}

/**
 * Get recent high-quality articles from addie_knowledge for digest inclusion.
 * Excludes articles already included in a previous sent digest.
 */
export async function getRecentArticlesForDigest(
  days: number = 7,
  limit: number = 10,
): Promise<DigestArticle[]> {
  const result = await query<DigestArticle>(
    `SELECT k.id, k.title, k.source_url, k.summary, k.addie_notes,
            k.quality_score, k.relevance_tags, k.published_at
     FROM addie_knowledge k
     WHERE k.quality_score >= 4
       AND k.fetch_status = 'success'
       AND k.is_active = TRUE
       AND k.source_url IS NOT NULL
       AND k.addie_notes IS NOT NULL
       AND k.created_at > NOW() - make_interval(days => $1)
       AND NOT EXISTS (
         SELECT 1 FROM weekly_digests wd
         WHERE wd.status = 'sent'
           AND wd.content::jsonb -> 'news' @> jsonb_build_array(jsonb_build_object('knowledgeId', k.id))
       )
     ORDER BY k.quality_score DESC, k.published_at DESC NULLS LAST
     LIMIT $2`,
    [days, limit],
  );
  return result.rows;
}

/**
 * Get organizations created in the last N days (non-personal)
 */
export async function getNewOrganizations(days: number = 7): Promise<Array<{
  name: string;
  description: string | null;
  created_at: Date;
}>> {
  const result = await query<{
    name: string;
    description: string | null;
    created_at: Date;
  }>(
    `SELECT name, description, created_at
     FROM organizations
     WHERE created_at > NOW() - make_interval(days => $1)
       AND is_personal = FALSE
     ORDER BY created_at DESC`,
    [days],
  );
  return result.rows;
}

/**
 * Get users eligible to receive the weekly digest email.
 * Returns users with email who haven't opted out of the weekly_digest category.
 */
export async function getDigestEmailRecipients(): Promise<DigestEmailRecipient[]> {
  const result = await query<DigestEmailRecipient>(
    `SELECT
       u.workos_user_id,
       u.email,
       u.first_name,
       (u.primary_slack_user_id IS NOT NULL) AS has_slack
     FROM users u
     WHERE u.email IS NOT NULL
       AND u.email != ''
       AND NOT EXISTS (
         SELECT 1 FROM user_email_preferences uep
         JOIN user_email_category_preferences uecp ON uecp.user_preference_id = uep.id
         WHERE uep.workos_user_id = u.workos_user_id
           AND uecp.category_id = 'weekly_digest'
           AND uecp.enabled = FALSE
       )
       AND NOT EXISTS (
         SELECT 1 FROM user_email_preferences uep
         WHERE uep.workos_user_id = u.workos_user_id
           AND uep.global_unsubscribe = TRUE
       )`,
  );
  return result.rows;
}

/**
 * Get the most recent sent digests for the web archive
 */
export async function getRecentDigests(limit: number = 10): Promise<DigestRecord[]> {
  const result = await query<DigestRecord>(
    `SELECT * FROM weekly_digests
     WHERE status = 'sent'
     ORDER BY edition_date DESC
     LIMIT $1`,
    [limit],
  );
  return result.rows;
}

/**
 * Record a feedback vote from a digest email
 */
export async function recordDigestFeedback(
  editionDate: string,
  vote: 'yes' | 'no',
  trackingId?: string,
): Promise<void> {
  await query(
    `INSERT INTO digest_feedback (edition_date, vote, tracking_id) VALUES ($1, $2, $3)`,
    [editionDate, vote, trackingId || null],
  );
}
