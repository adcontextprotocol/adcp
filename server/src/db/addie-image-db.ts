/**
 * Addie Image Library Database
 *
 * Manages the searchable image asset registry and search event logging.
 * Gap detection (images Addie wishes she had) is derived from zero-result
 * searches rather than a separate request mechanism.
 */

import { query } from './client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('addie-image-db');

// ============================================================================
// TYPES
// ============================================================================

export interface AddieImage {
  id: number;
  filename: string;
  alt_text: string;
  topics: string[];
  category: string;
  characters: string[];
  description: string | null;
  image_url: string;
  approved: boolean;
  created_at: string;
  updated_at: string;
}

export interface ImageSearchEvent {
  id: number;
  query: string;
  intent: string | null;
  context_type: string;
  thread_id: string | null;
  slack_user_id: string | null;
  results_returned: number;
  result_ids: number[] | null;
  created_at: string;
}

// ============================================================================
// IMAGE ASSET QUERIES
// ============================================================================

const IMAGE_COLUMNS = 'id, filename, alt_text, topics, category, characters, description, image_url, approved, created_at, updated_at';

/** Search images using full-text search with relevance ranking */
export async function searchImages(
  searchQuery: string,
  options?: { topics?: string[]; category?: string; limit?: number }
): Promise<AddieImage[]> {
  const conditions: string[] = ['approved = true'];
  const params: unknown[] = [];
  let paramIndex = 1;

  // OR-based full-text search: split query into words joined with | so that
  // "governance workflow" matches images containing either term. ts_rank
  // naturally boosts results matching more terms.
  let hasTextSearch = false;
  let tsqueryExpr = '';
  if (searchQuery) {
    const words = searchQuery.replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean);
    if (words.length > 0) {
      tsqueryExpr = words.join(' | ');
      conditions.push(`search_vector @@ to_tsquery('english', $${paramIndex})`);
      params.push(tsqueryExpr);
      paramIndex++;
      hasTextSearch = true;
    }
  }

  // Topic overlap filter
  if (options?.topics?.length) {
    conditions.push(`topics && $${paramIndex}::text[]`);
    params.push(options.topics);
    paramIndex++;
  }

  // Category filter
  if (options?.category) {
    conditions.push(`category = $${paramIndex}`);
    params.push(options.category);
    paramIndex++;
  }

  const limit = options?.limit ?? 10;
  params.push(limit);

  // Order by relevance when text search is used, otherwise by recency
  const orderBy = hasTextSearch
    ? `ts_rank(search_vector, to_tsquery('english', $1)) DESC`
    : 'created_at DESC';

  const sql = `
    SELECT ${IMAGE_COLUMNS} FROM addie_images
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${orderBy}
    LIMIT $${paramIndex}
  `;

  const result = await query<AddieImage>(sql, params as any[]);
  return result.rows;
}

/** List all images with optional filters */
export async function listImages(options?: {
  category?: string;
  approved?: boolean;
  limit?: number;
  offset?: number;
}): Promise<AddieImage[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  if (options?.category) {
    conditions.push(`category = $${paramIndex++}`);
    params.push(options.category);
  }
  if (options?.approved !== undefined) {
    conditions.push(`approved = $${paramIndex++}`);
    params.push(options.approved);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = options?.limit ?? 100;
  const offset = options?.offset ?? 0;

  params.push(limit, offset);

  const result = await query<AddieImage>(
    `SELECT ${IMAGE_COLUMNS} FROM addie_images ${where} ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
    params as any[]
  );
  return result.rows;
}

/** Get a single image by ID */
export async function getImage(id: number): Promise<AddieImage | null> {
  const result = await query<AddieImage>(
    `SELECT ${IMAGE_COLUMNS} FROM addie_images WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

/** Create a new image asset */
export async function createImage(data: {
  filename: string;
  alt_text: string;
  topics: string[];
  category: string;
  characters?: string[];
  description?: string;
  image_url: string;
  approved?: boolean;
}): Promise<AddieImage> {
  const result = await query<AddieImage>(
    `INSERT INTO addie_images (filename, alt_text, topics, category, characters, description, image_url, approved)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      data.filename,
      data.alt_text,
      data.topics,
      data.category,
      data.characters || [],
      data.description || null,
      data.image_url,
      data.approved ?? true,
    ]
  );
  return result.rows[0];
}

/** Update an image asset */
const UPDATABLE_COLUMNS = new Set([
  'alt_text', 'topics', 'category', 'characters',
  'description', 'image_url', 'approved',
]);

export async function updateImage(
  id: number,
  data: Partial<{
    alt_text: string;
    topics: string[];
    category: string;
    characters: string[];
    description: string;
    image_url: string;
    approved: boolean;
  }>
): Promise<AddieImage | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined && UPDATABLE_COLUMNS.has(key)) {
      sets.push(`${key} = $${paramIndex++}`);
      params.push(value);
    }
  }

  if (sets.length === 0) return getImage(id);

  sets.push(`updated_at = NOW()`);
  params.push(id);

  const result = await query<AddieImage>(
    `UPDATE addie_images SET ${sets.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
    params as any[]
  );
  return result.rows[0] || null;
}

/** Delete an image asset */
export async function deleteImage(id: number): Promise<boolean> {
  const result = await query('DELETE FROM addie_images WHERE id = $1', [id]);
  return (result.rowCount ?? 0) > 0;
}

// ============================================================================
// SEARCH EVENT LOGGING
// ============================================================================

/** Log an image search event */
export async function logImageSearch(data: {
  query: string;
  intent?: string;
  context_type?: string;
  thread_id?: string;
  slack_user_id?: string;
  results_returned: number;
  result_ids?: number[];
}): Promise<ImageSearchEvent> {
  const result = await query<ImageSearchEvent>(
    `INSERT INTO addie_image_searches (query, intent, context_type, thread_id, slack_user_id, results_returned, result_ids)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      data.query,
      data.intent || null,
      data.context_type || 'conversation',
      data.thread_id || null,
      data.slack_user_id || null,
      data.results_returned,
      data.result_ids || null,
    ]
  );
  return result.rows[0];
}

/** List recent search events */
export async function listSearches(options?: {
  limit?: number;
  offset?: number;
  zeroResultsOnly?: boolean;
}): Promise<ImageSearchEvent[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  if (options?.zeroResultsOnly) {
    conditions.push('results_returned = 0');
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;

  params.push(limit, offset);

  const result = await query<ImageSearchEvent>(
    `SELECT * FROM addie_image_searches ${where} ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
    params as any[]
  );
  return result.rows;
}

/** Get search stats for the admin dashboard */
export async function getSearchStats(): Promise<{
  total_searches: number;
  zero_result_searches: number;
  total_images: number;
}> {
  const [searchStats, imageCount] = await Promise.all([
    query<{ total: string; zero_results: string }>(
      `SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE results_returned = 0) as zero_results
       FROM addie_image_searches`
    ),
    query<{ count: string }>('SELECT COUNT(*) as count FROM addie_images WHERE approved = true'),
  ]);

  const stats = searchStats.rows[0];
  return {
    total_searches: parseInt(stats.total, 10),
    zero_result_searches: parseInt(stats.zero_results, 10),
    total_images: parseInt(imageCount.rows[0].count, 10),
  };
}

/** Get top search queries with zero results (gap analysis) */
export async function getTopMisses(limit = 20): Promise<Array<{ query: string; count: number; last_searched: string }>> {
  const result = await query<{ query: string; count: string; last_searched: string }>(
    `SELECT query, COUNT(*) as count, MAX(created_at) as last_searched
     FROM addie_image_searches
     WHERE results_returned = 0
     GROUP BY query
     ORDER BY count DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows.map(r => ({ query: r.query, count: parseInt(r.count, 10), last_searched: r.last_searched }));
}
