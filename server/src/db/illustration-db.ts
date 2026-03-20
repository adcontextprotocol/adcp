/**
 * Perspective Illustration Database
 *
 * Manages AI-generated editorial illustrations for perspective articles —
 * creation, approval, serving, and rate-limit tracking.
 */

import { query, getPool } from './client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('illustration-db');

export interface PerspectiveIllustration {
  id: string;
  perspective_id: string;
  image_data: Buffer | null;
  prompt_used: string | null;
  author_description: string | null;
  status: 'pending' | 'generated' | 'approved' | 'rejected';
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

type IllustrationMetadata = Omit<PerspectiveIllustration, 'image_data'>;

const METADATA_COLUMNS = `id, perspective_id, prompt_used, author_description, status, approved_at, created_at, updated_at`;

/** Get illustration metadata by ID (no binary data) */
export async function getIllustrationById(id: string): Promise<IllustrationMetadata | null> {
  const result = await query<IllustrationMetadata>(
    `SELECT ${METADATA_COLUMNS} FROM perspective_illustrations WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

/** Get illustration binary data for serving */
export async function getIllustrationData(id: string): Promise<Buffer | null> {
  const result = await query<{ image_data: Buffer | null }>(
    `SELECT image_data FROM perspective_illustrations WHERE id = $1`,
    [id]
  );
  return result.rows[0]?.image_data || null;
}

/** Get the active (approved) illustration for a perspective */
export async function getIllustrationForPerspective(perspectiveId: string): Promise<IllustrationMetadata | null> {
  const prefixed = METADATA_COLUMNS.split(', ').map(c => `i.${c}`).join(', ');
  const result = await query<IllustrationMetadata>(
    `SELECT ${prefixed}
     FROM perspective_illustrations i
     JOIN perspectives p ON p.illustration_id = i.id
     WHERE p.id = $1`,
    [perspectiveId]
  );
  return result.rows[0] || null;
}

/** Get the latest generated (not yet approved) illustration for a perspective */
export async function getLatestGenerated(perspectiveId: string): Promise<IllustrationMetadata | null> {
  const result = await query<IllustrationMetadata>(
    `SELECT ${METADATA_COLUMNS} FROM perspective_illustrations
     WHERE perspective_id = $1 AND status = 'generated'
     ORDER BY created_at DESC LIMIT 1`,
    [perspectiveId]
  );
  return result.rows[0] || null;
}

/** Create a new illustration record */
export async function createIllustration(data: {
  perspective_id: string;
  image_data?: Buffer;
  prompt_used?: string;
  author_description?: string;
  status?: 'pending' | 'generated' | 'approved';
}): Promise<PerspectiveIllustration> {
  const result = await query<PerspectiveIllustration>(
    `INSERT INTO perspective_illustrations (perspective_id, image_data, prompt_used, author_description, status)
     VALUES ($1, decode($2, 'base64'), $3, $4, $5)
     RETURNING id, perspective_id, prompt_used, author_description, status, approved_at, created_at, updated_at`,
    [
      data.perspective_id,
      data.image_data ? data.image_data.toString('base64') : null,
      data.prompt_used || null,
      data.author_description || null,
      data.status || 'generated',
    ]
  );
  return result.rows[0];
}

/** Approve an illustration and set it as the perspective's active illustration */
export async function approveIllustration(illustrationId: string, perspectiveId: string): Promise<IllustrationMetadata | null> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE perspective_illustrations SET status = 'approved', approved_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND perspective_id = $2`,
      [illustrationId, perspectiveId]
    );
    await client.query(
      `UPDATE perspectives SET illustration_id = $1, updated_at = NOW() WHERE id = $2`,
      [illustrationId, perspectiveId]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return getIllustrationById(illustrationId);
}

/** Soft-delete an illustration (set status to rejected) */
export async function rejectIllustration(id: string): Promise<boolean> {
  const result = await query(
    `UPDATE perspective_illustrations SET status = 'rejected', updated_at = NOW() WHERE id = $1`,
    [id]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Count generations for a user in the current month (for rate limiting) */
export async function countMonthlyGenerations(userId: string): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM perspective_illustrations pi
     JOIN content_authors ca ON ca.perspective_id = pi.perspective_id
     WHERE ca.user_id = $1
       AND pi.created_at >= date_trunc('month', NOW())`,
    [userId]
  );
  return parseInt(result.rows[0].count, 10);
}

/** Check if a user is an author of a perspective */
export async function isAuthorOfPerspective(perspectiveId: string, userId: string): Promise<boolean> {
  const result = await query(
    `SELECT 1 FROM content_authors WHERE perspective_id = $1 AND user_id = $2`,
    [perspectiveId, userId]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Get perspective + illustration info by slug (for card.png endpoint) */
export async function getPerspectiveWithIllustration(slug: string): Promise<{
  id: string;
  title: string;
  category: string | null;
  featured_image_url: string | null;
  illustration_id: string | null;
  author_name: string | null;
  author_title: string | null;
} | null> {
  const result = await query<{
    id: string;
    title: string;
    category: string | null;
    featured_image_url: string | null;
    illustration_id: string | null;
    author_name: string | null;
    author_title: string | null;
  }>(
    `SELECT id, title, category, featured_image_url, illustration_id, author_name, author_title
     FROM perspectives
     WHERE slug = $1 AND status = 'published'`,
    [slug]
  );
  return result.rows[0] || null;
}
