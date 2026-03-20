/**
 * Member Portrait Database
 *
 * Manages illustrated member portraits — creation, approval, serving,
 * and rate-limit tracking.
 */

import { query } from './client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('portrait-db');

export interface MemberPortrait {
  id: string;
  member_profile_id: string;
  image_url: string;
  portrait_data: Buffer | null;
  prompt_used: string | null;
  vibe: string | null;
  palette: string;
  status: 'pending' | 'generated' | 'approved' | 'rejected';
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

type PortraitMetadata = Omit<MemberPortrait, 'portrait_data'>;

const METADATA_COLUMNS = `id, member_profile_id, image_url, prompt_used, vibe, palette, status, approved_at, created_at, updated_at`;

/** Get portrait metadata by ID (no binary data) */
export async function getPortraitById(id: string): Promise<PortraitMetadata | null> {
  const result = await query<PortraitMetadata>(
    `SELECT ${METADATA_COLUMNS} FROM member_portraits WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

/** Get portrait binary data for serving */
export async function getPortraitData(id: string): Promise<{ portrait_data: Buffer | null; image_url: string } | null> {
  const result = await query<{ portrait_data: Buffer | null; image_url: string }>(
    `SELECT portrait_data, image_url FROM member_portraits WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

/** Get the active (approved) portrait for a member profile */
export async function getActivePortrait(profileId: string): Promise<PortraitMetadata | null> {
  const prefixed = METADATA_COLUMNS.split(', ').map(c => `p.${c}`).join(', ');
  const result = await query<PortraitMetadata>(
    `SELECT ${prefixed}
     FROM member_portraits p
     JOIN member_profiles mp ON mp.portrait_id = p.id
     WHERE mp.id = $1`,
    [profileId]
  );
  return result.rows[0] || null;
}

/** Get the latest generated (not yet approved) portrait for a profile */
export async function getLatestGenerated(profileId: string): Promise<PortraitMetadata | null> {
  const result = await query<PortraitMetadata>(
    `SELECT ${METADATA_COLUMNS} FROM member_portraits
     WHERE member_profile_id = $1 AND status = 'generated'
     ORDER BY created_at DESC LIMIT 1`,
    [profileId]
  );
  return result.rows[0] || null;
}

/** Create a new portrait record */
export async function createPortrait(data: {
  member_profile_id: string;
  image_url: string;
  portrait_data?: Buffer;
  prompt_used?: string;
  vibe?: string;
  palette?: string;
  status?: 'pending' | 'generated' | 'approved';
}): Promise<PortraitMetadata> {
  const result = await query<PortraitMetadata>(
    `INSERT INTO member_portraits (member_profile_id, image_url, portrait_data, prompt_used, vibe, palette, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${METADATA_COLUMNS}`,
    [
      data.member_profile_id,
      data.image_url,
      data.portrait_data || null,
      data.prompt_used || null,
      data.vibe || null,
      data.palette || 'amber',
      data.status || 'generated',
    ]
  );
  return result.rows[0];
}

/** Approve a portrait and set it as the profile's active portrait */
export async function approvePortrait(portraitId: string, profileId: string): Promise<PortraitMetadata | null> {
  // Update portrait status
  await query(
    `UPDATE member_portraits SET status = 'approved', approved_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND member_profile_id = $2`,
    [portraitId, profileId]
  );

  // Point member_profiles.portrait_id at this portrait
  await query(
    `UPDATE member_profiles SET portrait_id = $1, updated_at = NOW() WHERE id = $2`,
    [portraitId, profileId]
  );

  return getPortraitById(portraitId);
}

/** Remove portrait from a profile (sets portrait_id to NULL) */
export async function removeFromProfile(profileId: string): Promise<void> {
  await query(
    `UPDATE member_profiles SET portrait_id = NULL, updated_at = NOW() WHERE id = $1`,
    [profileId]
  );
}

/** Soft-delete a portrait (set status to rejected) */
export async function rejectPortrait(id: string): Promise<boolean> {
  const result = await query(
    `UPDATE member_portraits SET status = 'rejected', updated_at = NOW() WHERE id = $1`,
    [id]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Count generations for a profile in the current month (for rate limiting) */
export async function countMonthlyGenerations(profileId: string): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM member_portraits
     WHERE member_profile_id = $1
       AND created_at >= date_trunc('month', NOW())`,
    [profileId]
  );
  return parseInt(result.rows[0].count, 10);
}

/** List all portraits (admin) */
export async function listPortraits(options?: {
  status?: string;
  limit?: number;
  offset?: number;
}): Promise<PortraitMetadata[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  if (options?.status) {
    conditions.push(`p.status = $${paramIndex++}`);
    params.push(options.status);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = options?.limit ?? 100;
  const offset = options?.offset ?? 0;
  params.push(limit, offset);

  const prefixed = METADATA_COLUMNS.split(', ').map(c => `p.${c}`).join(', ');
  const result = await query<PortraitMetadata & { display_name: string; slug: string }>(
    `SELECT ${prefixed}, mp.display_name, mp.slug
     FROM member_portraits p
     JOIN member_profiles mp ON mp.id = p.member_profile_id
     ${where}
     ORDER BY p.created_at DESC
     LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
    params as any[]
  );
  return result.rows;
}

/** Get public builders with approved portraits (for the Explore page) */
export async function getPublicBuilders(): Promise<Array<{
  profile_id: string;
  display_name: string;
  slug: string;
  portrait_id: string;
  portrait_url: string;
  tagline: string | null;
}>> {
  const result = await query<{
    profile_id: string;
    display_name: string;
    slug: string;
    portrait_id: string;
    portrait_url: string;
    tagline: string | null;
  }>(
    `SELECT mp.id as profile_id, mp.display_name, mp.slug,
            p.id as portrait_id, p.image_url as portrait_url,
            mp.tagline
     FROM member_profiles mp
     JOIN member_portraits p ON mp.portrait_id = p.id
     WHERE mp.is_public = true AND p.status = 'approved'
     ORDER BY mp.featured DESC, mp.display_name ASC`
  );
  return result.rows;
}

/** Map workos_user_id to portrait_id (for admin users page) */
export async function getUserPortraitMap(): Promise<Record<string, string>> {
  const result = await query<{ workos_user_id: string; portrait_id: string }>(
    `SELECT om.workos_user_id, mp.portrait_id::text
     FROM member_profiles mp
     JOIN organization_memberships om ON om.workos_organization_id = mp.workos_organization_id
     WHERE mp.portrait_id IS NOT NULL`
  );
  const map: Record<string, string> = {};
  for (const row of result.rows) {
    map[row.workos_user_id] = row.portrait_id;
  }
  return map;
}
