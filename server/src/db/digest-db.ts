import { query } from './client.js';

// ─── Current ("The Prompt") content shape ────────────────────────────────

export interface DigestContent {
  contentVersion: 2;
  openingTake: string;
  whatToWatch: DigestNewsItem[];
  fromTheInside: DigestInsiderGroup[];
  voices: DigestMemberPerspective[];
  newMembers: DigestNewMember[];
  specInsight?: DigestSpecInsight | null;
  shareableTake?: string;
  whatShipped?: DigestShipment[];
  takeActions?: DigestTakeAction[];
  editorsNote?: string;
  emailSubject?: string;
  editHistory?: DigestEditEntry[];
  coverImageUrl?: string;
  dateFlavor?: string;
  generatedAt: string;
  /** Section keys to hide from rendering */
  hiddenSections?: string[];
  /** Admin-added custom sections */
  customSections?: import('../newsletters/config.js').CustomSection[];
  /** Paste-your-own mode: markdown body that replaces all auto-generated sections */
  pastedContent?: string;
}

export interface DigestSpecInsight {
  id: string;
  title: string;
  body: string;
  relatedSpecSections: string[];
  sourceContext?: string;
}

export interface DigestShipment {
  title: string;
  url: string;
  summary: string;
}

export interface DigestInsiderGroup {
  name: string;
  groupId: string;
  summary: string;
  meetingRecaps: DigestMeetingRecap[];
  activeThreads: DigestThread[];
  nextMeeting?: string;
}

export interface DigestMeetingRecap {
  title: string;
  date: string;
  summary: string | null;
  meetingUrl: string;
}

export interface DigestThread {
  summary: string;
  replyCount: number;
  threadUrl: string;
  starter?: string;
  participantCount?: number;
}

export interface DigestNewsItem {
  title: string;
  url: string;
  summary: string;
  whyItMatters: string;
  tags: string[];
  knowledgeId?: number;
  suggestionId?: number;
  takeaways?: string[];
}

export interface DigestTakeAction {
  text: string;
  ctaLabel: string;
  ctaUrl: string;
}

export interface DigestNewMember {
  name: string;
}

export interface DigestMemberPerspective {
  slug: string;
  title: string;
  url: string;
  excerpt: string;
  authorName: string;
  publishedAt: string | null;
}

export interface DigestEditEntry {
  editedBy: string;
  editedAt: string;
  description: string;
}

// ─── Legacy content shape (for rendering old sent digests) ──────────────

export interface LegacyDigestContent {
  intro: string;
  memberPerspectives?: DigestMemberPerspective[];
  news: DigestNewsItem[];
  newMembers: DigestNewMember[];
  conversations: LegacyDigestConversation[];
  workingGroups: LegacyDigestWorkingGroup[];
  perspectives?: LegacyDigestPerspective[];
  socialPostIdeas?: LegacyDigestSocialPostIdea[];
  spotlightAction?: LegacyDigestSpotlightAction;
  editorsNote?: string;
  emailSubject?: string;
  editHistory?: DigestEditEntry[];
  generatedAt: string;
}

export interface LegacyDigestConversation {
  summary: string;
  channelName: string;
  threadUrl: string;
  participants: string[];
}

export interface LegacyDigestWorkingGroup {
  name: string;
  summary: string;
  nextMeeting?: string;
}

interface LegacyDigestPerspective {
  slug: string;
  title: string;
  excerpt: string | null;
  author_name: string | null;
  published_at: Date | null;
}

interface LegacyDigestSocialPostIdea {
  title: string;
  url: string;
  description: string;
}

interface LegacyDigestSpotlightAction {
  text: string;
  linkUrl?: string;
  linkLabel?: string;
}

/**
 * Type guard: returns true for old-format digest content (pre-"The Prompt").
 */
export function isLegacyContent(
  content: DigestContent | LegacyDigestContent,
): content is LegacyDigestContent {
  return !('contentVersion' in content) || (content as DigestContent).contentVersion !== 2;
}

// ─── Shared types ───────────────────────────────────────────────────────

/** Columns to SELECT for DigestRecord — excludes cover_image_data (BYTEA). */
const DIGEST_COLUMNS = `id, edition_date, status, approved_by, approved_at,
  review_channel_id, review_message_ts, content, created_at, sent_at,
  send_stats, perspective_id, cover_prompt_used,
  (cover_image_data IS NOT NULL) AS has_cover_image`;

export interface DigestRecord {
  id: number;
  edition_date: Date;
  status: 'draft' | 'approved' | 'sent' | 'skipped';
  approved_by: string | null;
  approved_at: Date | null;
  review_channel_id: string | null;
  review_message_ts: string | null;
  content: DigestContent | LegacyDigestContent;
  created_at: Date;
  sent_at: Date | null;
  send_stats: DigestSendStats | null;
  perspective_id: string | null;
  has_cover_image: boolean;
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
  persona: string | null;
  journey_stage: string | null;
  seat_type: string | null;
  wg_count: number;
  cert_modules_completed: number;
  cert_total_modules: number;
  is_member: boolean;
  has_profile: boolean;
}

/**
 * Persona clusters for email personalization.
 * Groups 7 personas into 3 clusters to avoid over-segmentation.
 */
export type PersonaCluster = 'builder' | 'strategist' | 'newcomer';

const PERSONA_CLUSTERS: Record<string, PersonaCluster> = {
  molecule_builder: 'builder',
  pragmatic_builder: 'builder',
  data_decoder: 'strategist',
  resops_integrator: 'strategist',
  ladder_climber: 'strategist',
  pureblood_protector: 'strategist',
  simple_starter: 'newcomer',
};

export function getPersonaCluster(persona: string | null): PersonaCluster {
  if (!persona) return 'newcomer';
  return PERSONA_CLUSTERS[persona] || 'newcomer';
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

export interface DigestPerspectiveRow {
  slug: string;
  title: string;
  excerpt: string | null;
  author_name: string | null;
  published_at: Date | null;
  body: string | null;
}

// ─── Database functions ─────────────────────────────────────────────────

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
     RETURNING ${DIGEST_COLUMNS}`,
    [editionDate, JSON.stringify(content)],
  );
  return result.rows[0] || null;
}

/**
 * Get a digest by its edition date (YYYY-MM-DD)
 */
export async function getDigestByDate(editionDate: string): Promise<DigestRecord | null> {
  const result = await query<DigestRecord>(
    `SELECT ${DIGEST_COLUMNS} FROM weekly_digests WHERE edition_date = $1`,
    [editionDate],
  );
  return result.rows[0] || null;
}

/**
 * Get the most recent digest edition (biweekly cadence, so look back 16 days)
 */
export async function getCurrentWeekDigest(): Promise<DigestRecord | null> {
  const result = await query<DigestRecord>(
    `SELECT ${DIGEST_COLUMNS} FROM weekly_digests
     WHERE edition_date >= CURRENT_DATE - INTERVAL '16 days'
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
     RETURNING ${DIGEST_COLUMNS}`,
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
export async function markSent(id: number, stats: DigestSendStats): Promise<boolean> {
  const result = await query(
    `UPDATE weekly_digests
     SET status = 'sent', sent_at = NOW(), send_stats = $2
     WHERE id = $1 AND status = 'approved'
     RETURNING id`,
    [id, JSON.stringify(stats)],
  );
  return result.rows.length > 0;
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
 * Revert a skipped digest back to draft so it can be edited and re-approved.
 */
export async function revertToDraft(id: number): Promise<DigestRecord | null> {
  const result = await query<DigestRecord>(
    `UPDATE weekly_digests
     SET status = 'draft', approved_by = NULL, approved_at = NULL
     WHERE id = $1 AND status = 'skipped'
     RETURNING ${DIGEST_COLUMNS}`,
    [id],
  );
  return result.rows[0] || null;
}

/**
 * Update the content of a draft digest. Only works on drafts.
 */
export async function updateDigestContent(
  id: number,
  content: DigestContent,
): Promise<DigestRecord | null> {
  const result = await query<DigestRecord>(
    `UPDATE weekly_digests
     SET content = $2
     WHERE id = $1 AND status = 'draft'
     RETURNING ${DIGEST_COLUMNS}`,
    [id, JSON.stringify(content)],
  );
  return result.rows[0] || null;
}

/**
 * Find a digest by its Slack review message
 */
export async function getDigestByReviewMessage(
  channelId: string,
  messageTs: string,
): Promise<DigestRecord | null> {
  const result = await query<DigestRecord>(
    `SELECT ${DIGEST_COLUMNS} FROM weekly_digests
     WHERE review_channel_id = $1 AND review_message_ts = $2`,
    [channelId, messageTs],
  );
  return result.rows[0] || null;
}

/**
 * Link a sent digest to its published perspective article.
 */
export async function setPerspectiveId(digestId: number, perspectiveId: string): Promise<void> {
  await query(
    `UPDATE weekly_digests SET perspective_id = $2 WHERE id = $1`,
    [digestId, perspectiveId],
  );
}

/**
 * Get recent high-quality articles from addie_knowledge for digest inclusion.
 * Excludes articles already included in a previous sent digest (checks both
 * legacy 'news' and current 'whatToWatch' field names).
 */
export async function getRecentArticlesForDigest(
  days: number = 7,
  limit: number = 10,
): Promise<DigestArticle[]> {
  const result = await query<DigestArticle>(
    `SELECT k.id, k.title, k.source_url, k.summary, k.addie_notes,
            k.quality_score, k.relevance_tags, k.published_at
     FROM addie_knowledge k
     WHERE k.quality_score >= 3
       AND k.fetch_status = 'success'
       AND k.is_active = TRUE
       AND k.source_url IS NOT NULL
       AND k.created_at > NOW() - make_interval(days => $1)
       AND NOT EXISTS (
         SELECT 1 FROM weekly_digests wd
         WHERE wd.status = 'sent'
           AND (
             wd.content::jsonb -> 'news' @> jsonb_build_array(jsonb_build_object('knowledgeId', k.id))
             OR wd.content::jsonb -> 'whatToWatch' @> jsonb_build_array(jsonb_build_object('knowledgeId', k.id))
           )
       )
     ORDER BY k.quality_score DESC, k.published_at DESC NULLS LAST
     LIMIT $2`,
    [days, limit],
  );
  return result.rows;
}

/**
 * Get recent published member perspectives for digest inclusion.
 * Excludes items already included in a previously sent digest (checks both
 * legacy 'memberPerspectives' and current 'voices' field names).
 */
export async function getRecentMemberPerspectivesForDigest(
  days: number = 7,
  limit: number = 5,
): Promise<DigestPerspectiveRow[]> {
  const result = await query<DigestPerspectiveRow>(
    `SELECT
        p.slug,
        p.title,
        p.excerpt,
        p.author_name,
        p.published_at
     FROM perspectives p
     LEFT JOIN working_groups wg ON wg.id = p.working_group_id
     WHERE p.status = 'published'
       AND (p.source_type IS NULL OR p.source_type NOT IN ('rss', 'email'))
       AND (p.content_origin IS NULL OR p.content_origin != 'official')
       AND p.published_at IS NOT NULL
       AND p.published_at > NOW() - make_interval(days => $1)
       AND NOT EXISTS (
         SELECT 1 FROM weekly_digests wd
         WHERE wd.status = 'sent'
           AND (
             COALESCE(wd.content::jsonb -> 'memberPerspectives', '[]'::jsonb)
               @> jsonb_build_array(jsonb_build_object('slug', p.slug))
             OR COALESCE(wd.content::jsonb -> 'voices', '[]'::jsonb)
               @> jsonb_build_array(jsonb_build_object('slug', p.slug))
           )
       )
     ORDER BY p.published_at DESC
     LIMIT $2`,
    [days, limit],
  );
  return result.rows;
}

/**
 * Get recent official perspectives (Town Hall recaps, white papers, reports).
 * These go into "Worth Your Time" — front and center, not in "Voices."
 */
export async function getRecentOfficialPerspectives(
  days: number = 14,
  limit: number = 5,
): Promise<DigestPerspectiveRow[]> {
  const result = await query<DigestPerspectiveRow>(
    `SELECT
        p.slug,
        p.title,
        p.excerpt,
        p.author_name,
        p.published_at,
        p.body
     FROM perspectives p
     WHERE p.status = 'published'
       AND p.content_origin = 'official'
       AND p.published_at IS NOT NULL
       AND p.published_at > NOW() - make_interval(days => $1)
     ORDER BY p.published_at DESC
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
  enrichment_description: string | null;
  created_at: Date;
}>> {
  const result = await query<{
    name: string;
    enrichment_description: string | null;
    created_at: Date;
  }>(
    `SELECT o.name, o.enrichment_description, o.created_at
     FROM organizations o
     WHERE o.created_at > NOW() - make_interval(days => $1)
       AND o.is_personal = FALSE
       AND o.subscription_status = 'active'
     ORDER BY o.created_at DESC`,
    [days],
  );
  return result.rows;
}

/**
 * Get users eligible to receive The Prompt email.
 * Returns users with email who haven't opted out of the_prompt (or legacy weekly_digest) category.
 */
export async function getDigestEmailRecipients(): Promise<DigestEmailRecipient[]> {
  const result = await query<DigestEmailRecipient>(
    `SELECT DISTINCT ON (u.workos_user_id)
       u.workos_user_id,
       u.email,
       u.first_name,
       (u.primary_slack_user_id IS NOT NULL) AS has_slack,
       o.persona,
       o.journey_stage,
       om.seat_type,
       COALESCE((SELECT COUNT(*) FROM working_group_memberships wgm WHERE wgm.workos_user_id = u.workos_user_id AND wgm.status = 'active'), 0)::int AS wg_count,
       COALESCE((SELECT COUNT(*) FROM certification_attempts ca WHERE ca.workos_user_id = u.workos_user_id AND ca.status = 'completed'), 0)::int AS cert_modules_completed,
       COALESCE((SELECT COUNT(*) FROM certification_modules WHERE format = 'capstone'), 0)::int AS cert_total_modules,
       COALESCE(o.subscription_status = 'active', FALSE) AS is_member,
       (u.first_name IS NOT NULL AND u.last_name IS NOT NULL) AS has_profile
     FROM users u
     LEFT JOIN organization_memberships om
       ON om.workos_user_id = u.workos_user_id
     LEFT JOIN organizations o
       ON o.workos_organization_id = om.workos_organization_id
     WHERE u.email IS NOT NULL
       AND u.email != ''
       AND NOT EXISTS (
         SELECT 1 FROM user_email_preferences uep
         JOIN user_email_category_preferences uecp ON uecp.user_preference_id = uep.id
         WHERE uep.workos_user_id = u.workos_user_id
           AND uecp.category_id IN ('the_prompt', 'weekly_digest')
           AND uecp.enabled = FALSE
       )
       AND NOT EXISTS (
         SELECT 1 FROM user_email_preferences uep
         WHERE uep.workos_user_id = u.workos_user_id
           AND uep.global_unsubscribe = TRUE
       )
       AND EXISTS (
         SELECT 1 FROM user_email_preferences uep
         WHERE uep.workos_user_id = u.workos_user_id
           AND uep.marketing_opt_in = TRUE
       )`,
  );
  return result.rows;
}

/**
 * Get the most recent sent digests for the web archive
 */
export async function getRecentDigests(limit: number = 10): Promise<DigestRecord[]> {
  const result = await query<DigestRecord>(
    `SELECT ${DIGEST_COLUMNS} FROM weekly_digests
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
    `INSERT INTO digest_feedback (edition_date, vote, tracking_id) VALUES ($1, $2, $3)
     ON CONFLICT (edition_date, tracking_id) WHERE tracking_id IS NOT NULL DO NOTHING`,
    [editionDate, vote, trackingId || null],
  );
}

/**
 * Get active WG memberships for all users (for digest personalization).
 * Returns a map of workos_user_id → array of WG names.
 */
export async function getUserWorkingGroupMap(): Promise<Map<string, string[]>> {
  const result = await query<{ workos_user_id: string; name: string }>(
    `SELECT wgm.workos_user_id, wg.name
     FROM working_group_memberships wgm
     JOIN working_groups wg ON wg.id = wgm.working_group_id
     WHERE wgm.status = 'active' AND wg.status = 'active'`,
  );
  const map = new Map<string, string[]>();
  for (const row of result.rows) {
    const groups = map.get(row.workos_user_id) || [];
    groups.push(row.name);
    map.set(row.workos_user_id, groups);
  }
  return map;
}

// ─── Cover Image ──────────────────────────────────────────────────────

const MAX_COVER_IMAGE_SIZE = 5 * 1024 * 1024; // 5 MB

/**
 * Save a cover image for a draft digest edition.
 * Returns false if the digest is no longer a draft (status guard).
 */
export async function setDigestCoverImage(
  digestId: number,
  imageData: Buffer,
  promptUsed: string,
): Promise<boolean> {
  if (imageData.length > MAX_COVER_IMAGE_SIZE) {
    throw new Error(`Cover image too large: ${(imageData.length / 1024 / 1024).toFixed(1)} MB`);
  }
  const result = await query(
    `UPDATE weekly_digests
     SET cover_image_data = $2, cover_prompt_used = $3
     WHERE id = $1 AND status = 'draft'`,
    [digestId, imageData, promptUsed],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Get the cover image binary and prompt for a digest by edition date.
 * Used by the serving route and the send pipeline (to reuse for perspectives).
 */
export async function getDigestCoverImageWithPrompt(
  editionDate: string,
): Promise<{ imageData: Buffer; promptUsed: string } | null> {
  const result = await query<{ cover_image_data: Buffer; cover_prompt_used: string | null }>(
    `SELECT cover_image_data, cover_prompt_used FROM weekly_digests
     WHERE edition_date = $1 AND cover_image_data IS NOT NULL`,
    [editionDate],
  );
  if (!result.rows[0]) return null;
  return {
    imageData: result.rows[0].cover_image_data,
    promptUsed: result.rows[0].cover_prompt_used || 'Unknown',
  };
}

/**
 * Get the cover image binary for a digest by edition date.
 * Used by the serving route.
 */
export async function getDigestCoverImage(
  editionDate: string,
): Promise<Buffer | null> {
  const result = await getDigestCoverImageWithPrompt(editionDate);
  return result?.imageData || null;
}
