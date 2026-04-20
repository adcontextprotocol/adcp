/**
 * Portrait Database
 *
 * Manages illustrated member portraits — creation, approval, serving,
 * and rate-limit tracking. Portraits belong to users (not member profiles).
 */

import { query, getPool } from './client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('portrait-db');

export interface MemberPortrait {
  id: string;
  user_id: string | null;
  member_profile_id: string | null;
  image_url: string;
  portrait_data: Buffer | null;
  prompt_used: string | null;
  vibe: string | null;
  palette: string;
  status: 'pending' | 'generated' | 'approved' | 'rejected';
  approved_at: string | null;
  created_at: string;
  updated_at: string;
  c2pa_signed_at: string | null;
  c2pa_manifest_digest: string | null;
}

type PortraitMetadata = Omit<MemberPortrait, 'portrait_data'>;

const METADATA_COLUMNS = `id, user_id, member_profile_id, image_url, prompt_used, vibe, palette, status, approved_at, created_at, updated_at, c2pa_signed_at, c2pa_manifest_digest`;

/** Get portrait metadata by ID (no binary data) */
export async function getPortraitById(id: string): Promise<PortraitMetadata | null> {
  const result = await query<PortraitMetadata>(
    `SELECT ${METADATA_COLUMNS} FROM member_portraits WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

/** Get portrait binary data for serving (approved portraits, or generated for preview) */
export async function getPortraitData(id: string): Promise<{ portrait_data: Buffer | null; image_url: string; status: string } | null> {
  const result = await query<{ portrait_data: Buffer | null; image_url: string; status: string }>(
    `SELECT portrait_data, image_url, status FROM member_portraits WHERE id = $1 AND status IN ('approved', 'generated')`,
    [id]
  );
  return result.rows[0] || null;
}

/** Get the active (approved) portrait for a user */
export async function getActivePortrait(userId: string): Promise<PortraitMetadata | null> {
  const prefixed = METADATA_COLUMNS.split(', ').map(c => `p.${c}`).join(', ');
  const result = await query<PortraitMetadata>(
    `SELECT ${prefixed}
     FROM member_portraits p
     JOIN users u ON u.portrait_id = p.id
     WHERE u.workos_user_id = $1`,
    [userId]
  );
  return result.rows[0] || null;
}

/** Get the latest generated (not yet approved) portrait for a user */
export async function getLatestGenerated(userId: string): Promise<PortraitMetadata | null> {
  const result = await query<PortraitMetadata>(
    `SELECT ${METADATA_COLUMNS} FROM member_portraits
     WHERE user_id = $1 AND status = 'generated'
     ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
}

/** Create a new portrait record */
export async function createPortrait(data: {
  user_id: string;
  member_profile_id?: string | null;
  image_url: string;
  portrait_data?: Buffer;
  prompt_used?: string;
  vibe?: string;
  palette?: string;
  status?: 'pending' | 'generated' | 'approved';
  c2pa_signed_at?: Date;
  c2pa_manifest_digest?: string;
}): Promise<PortraitMetadata> {
  const result = await query<PortraitMetadata>(
    `INSERT INTO member_portraits (user_id, member_profile_id, image_url, portrait_data, prompt_used, vibe, palette, status, c2pa_signed_at, c2pa_manifest_digest)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING ${METADATA_COLUMNS}`,
    [
      data.user_id,
      data.member_profile_id || null,
      data.image_url,
      data.portrait_data || null,
      data.prompt_used || null,
      data.vibe || null,
      data.palette || 'amber',
      data.status || 'generated',
      data.c2pa_signed_at ?? null,
      data.c2pa_manifest_digest ?? null,
    ]
  );
  return result.rows[0];
}

/** Approve a portrait and set it as the user's active portrait and community avatar */
export async function approvePortrait(portraitId: string, userId: string): Promise<PortraitMetadata | null> {
  const portraitUrl = `/api/portraits/${portraitId}.png`;
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const updateResult = await client.query(
      `UPDATE member_portraits SET status = 'approved', approved_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND user_id = $2`,
      [portraitId, userId]
    );
    if ((updateResult.rowCount ?? 0) === 0) {
      await client.query('ROLLBACK');
      return null;
    }
    // Set as user's active portrait and avatar
    await client.query(
      `UPDATE users SET portrait_id = $1, avatar_url = $2 WHERE workos_user_id = $3`,
      [portraitId, portraitUrl, userId]
    );
    // Also sync to member_profiles if the user has one (for directory display)
    await client.query(
      `UPDATE member_profiles mp
       SET portrait_id = $1, updated_at = NOW()
       FROM organization_memberships om
       WHERE om.workos_user_id = $2
         AND om.workos_organization_id = mp.workos_organization_id`,
      [portraitId, userId]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return getPortraitById(portraitId);
}

/** Remove portrait from a user and clear their avatar */
export async function removeFromUser(userId: string): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE users SET portrait_id = NULL, avatar_url = NULL
       WHERE workos_user_id = $1 AND avatar_url LIKE '/api/portraits/%'`,
      [userId]
    );
    // Also clear from member_profiles if user has one
    await client.query(
      `UPDATE member_profiles mp
       SET portrait_id = NULL, updated_at = NOW()
       FROM organization_memberships om
       WHERE om.workos_user_id = $1
         AND om.workos_organization_id = mp.workos_organization_id
         AND mp.portrait_id IS NOT NULL`,
      [userId]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Get the active portrait ID for a user */
export async function getActivePortraitId(userId: string): Promise<string | null> {
  const result = await query(
    `SELECT portrait_id FROM users WHERE workos_user_id = $1`,
    [userId]
  );
  return result.rows[0]?.portrait_id ?? null;
}

/** Soft-delete a portrait (set status to rejected) */
export async function rejectPortrait(id: string): Promise<boolean> {
  const result = await query(
    `UPDATE member_portraits SET status = 'rejected', updated_at = NOW() WHERE id = $1`,
    [id]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Count generations for a user in the current month (for rate limiting) */
export async function countMonthlyGenerations(userId: string): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM member_portraits
     WHERE user_id = $1
       AND created_at >= date_trunc('month', NOW())`,
    [userId]
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
    `SELECT ${prefixed},
            COALESCE(mp.display_name, u.first_name || ' ' || u.last_name) as display_name,
            COALESCE(mp.slug, cp.slug) as slug
     FROM member_portraits p
     LEFT JOIN users u ON u.workos_user_id = p.user_id
     LEFT JOIN member_profiles mp ON mp.id = p.member_profile_id
     LEFT JOIN community_profiles cp ON cp.user_id = p.user_id
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
    `SELECT workos_user_id, portrait_id::text
     FROM users
     WHERE portrait_id IS NOT NULL`
  );
  const map: Record<string, string> = {};
  for (const row of result.rows) {
    map[row.workos_user_id] = row.portrait_id;
  }
  return map;
}
