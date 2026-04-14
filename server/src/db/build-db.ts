/**
 * The Build — Database Layer
 *
 * Types and queries for Sage's biweekly contributor briefing.
 * Mirrors the digest-db pattern for The Prompt.
 */

import { query } from './client.js';

// ─── Content Types ─────────────────────────────────────────────────────

export interface BuildContent {
  contentVersion: 1;
  statusLine: string;
  decisions: BuildDecision[];
  whatShipped: BuildRelease[];
  deepDive: BuildDeepDive | null;
  helpNeeded: BuildHelpItem[];
  contributorSpotlight: BuildContributor[];
  editorsNote?: string;
  emailSubject?: string;
  editHistory?: BuildEditEntry[];
  coverImageUrl?: string;
  dateFlavor?: string;
  generatedAt: string;
  /** Section keys to hide from rendering */
  hiddenSections?: string[];
  /** Admin-added custom sections */
  customSections?: import('../newsletters/config.js').CustomSection[];
  /** Paste-your-own mode: markdown body that replaces all auto-generated sections */
  pastedContent?: string;
  /** Available content to cherry-pick from, keyed by section */
  candidatePool?: {
    decisions?: BuildDecision[];
    whatShipped?: BuildRelease[];
    helpNeeded?: BuildHelpItem[];
    contributorSpotlight?: BuildContributor[];
    events?: BuildEvent[];
  };
  /** IDs of items the editor dismissed (won't reappear on regenerate) */
  dismissedIds?: string[];
}

export interface BuildDecision {
  id: string;
  workingGroup: string;
  workingGroupId: string;
  title: string;
  status: 'decided' | 'open_for_comment' | 'under_review';
  summary: string;
  url: string;
  commentDeadline?: string;
}

export interface BuildRelease {
  id: string;
  repo: string;
  version: string;
  releaseDate: string;
  summary: string;
  releaseUrl: string;
  breaking: boolean;
  migrationNote: string | null;
}

export interface BuildDeepDive {
  title: string;
  slug: string;
  body: string;
  relatedDocs: string[];
}

export interface BuildHelpItem {
  id: string;
  title: string;
  url: string;
  source: string;
  type: 'code' | 'review' | 'writing' | 'expertise';
  context: string;
}

export interface BuildContributor {
  id: string;
  name: string;
  handle?: string;
  contribution: string;
  url?: string;
}

export interface BuildEvent {
  id: string;
  title: string;
  slug: string;
  startTime: string;
  endTime?: string;
  status: 'upcoming' | 'completed';
  hasRecap: boolean;
  recapExcerpt?: string;
  recapVideoUrl?: string;
  previouslyIncluded?: boolean;
}

export interface BuildEditEntry {
  editedBy: string;
  editedAt: string;
  description: string;
}

// ─── Edition Record ────────────────────────────────────────────────────

/** Columns to SELECT for BuildRecord — excludes cover_image_data (BYTEA). */
const BUILD_COLUMNS = `id, edition_date, status, content, approved_by, approved_at,
  review_channel_id, review_message_ts, perspective_id, created_at, sent_at,
  send_stats, cover_prompt_used,
  (cover_image_data IS NOT NULL) AS has_cover_image`;

export interface BuildRecord {
  id: number;
  edition_date: Date;
  status: string;
  content: BuildContent;
  approved_by: string | null;
  approved_at: Date | null;
  review_channel_id: string | null;
  review_message_ts: string | null;
  perspective_id: string | null;
  created_at: Date;
  sent_at: Date | null;
  send_stats: unknown | null;
  has_cover_image: boolean;
}

// ─── Queries ───────────────────────────────────────────────────────────

export async function createBuildEdition(editionDate: string, content: BuildContent): Promise<BuildRecord | null> {
  const result = await query<BuildRecord>(
    `INSERT INTO build_editions (edition_date, content)
     VALUES ($1, $2)
     ON CONFLICT (edition_date) DO NOTHING
     RETURNING ${BUILD_COLUMNS}`,
    [editionDate, JSON.stringify(content)],
  );
  return result.rows[0] || null;
}

export async function getBuildByDate(editionDate: string): Promise<BuildRecord | null> {
  const result = await query<BuildRecord>(
    `SELECT ${BUILD_COLUMNS} FROM build_editions WHERE edition_date = $1`,
    [editionDate],
  );
  return result.rows[0] || null;
}

export async function getCurrentBuildEdition(): Promise<BuildRecord | null> {
  const result = await query<BuildRecord>(
    `SELECT ${BUILD_COLUMNS} FROM build_editions
     WHERE created_at > NOW() - INTERVAL '21 days'
     ORDER BY edition_date DESC
     LIMIT 1`,
  );
  return result.rows[0] || null;
}

export async function approveBuildEdition(id: number, approvedBy: string): Promise<BuildRecord | null> {
  const result = await query<BuildRecord>(
    `UPDATE build_editions
     SET status = 'approved', approved_by = $2, approved_at = NOW()
     WHERE id = $1 AND status = 'draft'
     RETURNING ${BUILD_COLUMNS}`,
    [id, approvedBy],
  );
  return result.rows[0] || null;
}

export async function updateBuildContent(id: number, content: BuildContent): Promise<BuildRecord | null> {
  const result = await query<BuildRecord>(
    `UPDATE build_editions
     SET content = $2
     WHERE id = $1 AND status = 'draft'
     RETURNING ${BUILD_COLUMNS}`,
    [id, JSON.stringify(content)],
  );
  return result.rows[0] || null;
}

export async function markBuildSent(id: number, stats: unknown): Promise<boolean> {
  const result = await query(
    `UPDATE build_editions
     SET status = 'sent', sent_at = NOW(), send_stats = $2
     WHERE id = $1
     RETURNING id`,
    [id, JSON.stringify(stats)],
  );
  return result.rows.length > 0;
}

export async function setBuildReviewMessage(id: number, channelId: string, messageTs: string): Promise<void> {
  await query(
    `UPDATE build_editions SET review_channel_id = $2, review_message_ts = $3 WHERE id = $1`,
    [id, channelId, messageTs],
  );
}

export async function getBuildByReviewMessage(channelId: string, messageTs: string): Promise<BuildRecord | null> {
  const result = await query<BuildRecord>(
    `SELECT ${BUILD_COLUMNS} FROM build_editions WHERE review_channel_id = $1 AND review_message_ts = $2`,
    [channelId, messageTs],
  );
  return result.rows[0] || null;
}

export async function setBuildPerspectiveId(id: number, perspectiveId: string): Promise<void> {
  await query(
    `UPDATE build_editions SET perspective_id = $2 WHERE id = $1`,
    [id, perspectiveId],
  );
}

export async function getRecentBuildEditions(limit: number = 10): Promise<BuildRecord[]> {
  const result = await query<BuildRecord>(
    `SELECT ${BUILD_COLUMNS} FROM build_editions WHERE status = 'sent' ORDER BY edition_date DESC LIMIT $1`,
    [limit],
  );
  return result.rows;
}

/**
 * Get contributor-seat members eligible for The Build.
 * Returns users whose organization has at least one contributor seat.
 */
export async function getBuildRecipients(): Promise<Array<{
  workos_user_id: string;
  email: string;
  first_name: string | null;
  has_slack: boolean;
  persona: string | null;
  journey_stage: string | null;
}>> {
  const result = await query(
    `SELECT DISTINCT ON (u.workos_user_id)
       u.workos_user_id,
       u.email,
       u.first_name,
       (u.primary_slack_user_id IS NOT NULL) AS has_slack,
       o.persona,
       o.journey_stage
     FROM users u
     JOIN organization_memberships om ON om.workos_user_id = u.workos_user_id
     JOIN organizations o ON o.workos_organization_id = om.workos_organization_id
     WHERE u.email IS NOT NULL
       AND u.email != ''
       AND om.seat_type = 'contributor'
       AND NOT EXISTS (
         SELECT 1 FROM user_email_preferences uep
         JOIN user_email_category_preferences uecp ON uecp.user_preference_id = uep.id
         WHERE uep.workos_user_id = u.workos_user_id
           AND uecp.category_id = 'the_build'
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
       )
     ORDER BY u.workos_user_id, om.created_at ASC`,
  );
  return result.rows;
}

// ─── Cover Image ──────────────────────────────────────────────────────

const MAX_COVER_IMAGE_SIZE = 5 * 1024 * 1024; // 5 MB

export async function setBuildCoverImage(
  editionId: number,
  imageData: Buffer,
  promptUsed: string,
): Promise<boolean> {
  if (imageData.length > MAX_COVER_IMAGE_SIZE) {
    throw new Error(`Cover image too large: ${(imageData.length / 1024 / 1024).toFixed(1)} MB`);
  }
  const result = await query(
    `UPDATE build_editions
     SET cover_image_data = $2, cover_prompt_used = $3
     WHERE id = $1 AND status = 'draft'`,
    [editionId, imageData, promptUsed],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getBuildCoverImageWithPrompt(
  editionDate: string,
): Promise<{ imageData: Buffer; promptUsed: string } | null> {
  const result = await query<{ cover_image_data: Buffer; cover_prompt_used: string | null }>(
    `SELECT cover_image_data, cover_prompt_used FROM build_editions
     WHERE edition_date = $1 AND cover_image_data IS NOT NULL`,
    [editionDate],
  );
  if (!result.rows[0]) return null;
  return {
    imageData: result.rows[0].cover_image_data,
    promptUsed: result.rows[0].cover_prompt_used || 'Unknown',
  };
}

export async function getBuildCoverImage(
  editionDate: string,
): Promise<Buffer | null> {
  const result = await getBuildCoverImageWithPrompt(editionDate);
  return result?.imageData || null;
}
