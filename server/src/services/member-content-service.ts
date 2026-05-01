/**
 * Member content service.
 *
 * Shared by:
 *  - GET /api/me/content                (web/API)
 *  - get_my_content Addie tool          (chat)
 *
 * Centralises the query so the route and Addie tool produce identical results
 * and can't drift apart. Replaces a previous server-to-self HTTP loopback in
 * `callApi` that was rejected by `requireAuth` middleware (issue #3748).
 *
 * IMPORTANT: `userId` must be the authenticated user's own id. This function
 * does not perform impersonation — passing a different user's id will return
 * that user's content without access control. The callers (route via `req.user`
 * and Addie tool via `memberContext.workos_user`) both enforce this invariant.
 */

import { getPool } from '../db/client.js';
import { fetchPathPageviewCounts } from './posthog-query.js';
import { isWebUserAAOAdmin } from '../addie/mcp/admin-tools.js';

export interface ContentItem {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  content_type: string;
  category: string | null;
  excerpt: string | null;
  content: string | null;
  tags: string[] | null;
  featured_image_url: string | null;
  external_url: string | null;
  external_site_name: string | null;
  status: string;
  collection: {
    type: 'committee' | 'personal';
    committee_name: string | null;
    committee_slug: string | null;
  };
  relationships: string[];
  authors: Array<{ user_id: string; display_name: string; display_title: string | null }>;
  published_at: string | null;
  created_at: string;
  updated_at: string;
  performance?: { pageviews_last_30d: number };
}

export interface ListContentForUserOptions {
  userId: string;
  /** Pass isWebUserAAOAdmin(userId) from the route; always false from Addie tool. */
  isAdmin: boolean;
  status?: string;
  collection?: string;
  relationship?: string;
  limit?: number;
  /** Set true for the web route (PostHog enrichment); false for Addie (skips external I/O). */
  includePageviews?: boolean;
}

export type ListContentForUserResult =
  | { ok: true; items: ContentItem[] }
  | { ok: false; error: 'invalid_status'; validStatuses: string[] };

export async function listContentForUser(
  opts: ListContentForUserOptions,
): Promise<ListContentForUserResult> {
  const { userId, isAdmin, status, collection, relationship } = opts;
  const limit = Math.min(opts.limit ?? 50, 100);
  const includePageviews = opts.includePageviews ?? false;
  const pool = getPool();

  // Get committees user leads (for "owner" relationship)
  const leaderResult = await pool.query(
    `SELECT working_group_id FROM working_group_leaders WHERE user_id = $1`,
    [userId]
  );
  const ledCommitteeIds = leaderResult.rows.map((r: { working_group_id: string }) => r.working_group_id);

  // Build the query
  let sqlQuery = `
    SELECT DISTINCT ON (p.id)
      p.id, p.slug, p.content_type, p.title, p.subtitle, p.category, p.excerpt,
      p.content, p.tags, p.featured_image_url,
      p.external_url, p.external_site_name, p.status, p.published_at,
      p.created_at, p.updated_at, p.working_group_id, p.proposer_user_id,
      wg.name as committee_name, wg.slug as committee_slug,
      -- Determine relationships
      CASE WHEN p.proposer_user_id = $1 THEN true ELSE false END as is_proposer,
      CASE WHEN EXISTS (SELECT 1 FROM content_authors ca WHERE ca.perspective_id = p.id AND ca.user_id = $1) THEN true ELSE false END as is_author,
      CASE WHEN p.working_group_id = ANY($2) THEN true ELSE false END as is_lead,
      -- Get authors
      (SELECT json_agg(json_build_object(
        'user_id', ca.user_id,
        'display_name', ca.display_name,
        'display_title', ca.display_title
      ) ORDER BY ca.display_order)
      FROM content_authors ca WHERE ca.perspective_id = p.id) as authors
    FROM perspectives p
    LEFT JOIN working_groups wg ON wg.id = p.working_group_id
    WHERE (
      $3::boolean = true
      OR p.proposer_user_id = $1
      OR EXISTS (SELECT 1 FROM content_authors ca WHERE ca.perspective_id = p.id AND ca.user_id = $1)
      OR p.working_group_id = ANY($2)
    )
  `;
  const params: (string | string[] | number | boolean)[] = [userId, ledCommitteeIds, isAdmin];

  // Apply filters
  if (status && status !== 'all') {
    const validStatuses = ['draft', 'pending_review', 'published', 'archived', 'rejected'];
    if (!validStatuses.includes(status)) {
      return { ok: false, error: 'invalid_status', validStatuses };
    }
    params.push(status);
    sqlQuery += ` AND p.status = $${params.length}`;
  }

  if (collection) {
    if (collection === 'personal') {
      sqlQuery += ` AND p.working_group_id IS NULL`;
    } else {
      params.push(collection);
      sqlQuery += ` AND wg.slug = $${params.length}`;
    }
  }

  sqlQuery += ` ORDER BY p.id, p.created_at DESC`;
  params.push(limit);
  sqlQuery += ` LIMIT $${params.length}`;

  const result = await pool.query(sqlQuery, params);

  // Format response with relationships
  // The `relationship` filter is applied here in application code because the
  // relationship columns are computed expressions (is_author, is_proposer,
  // is_lead), not stored values — they cannot be pushed into the WHERE clause.
  const items: ContentItem[] = result.rows.map((row: Record<string, unknown>) => {
    const relationships: string[] = [];
    if (row.is_author) relationships.push('author');
    if (row.is_proposer) relationships.push('proposer');
    if (row.is_lead) relationships.push('owner');

    return {
      id: row.id as string,
      slug: row.slug as string,
      title: row.title as string,
      subtitle: row.subtitle as string | null,
      content_type: row.content_type as string,
      category: row.category as string | null,
      excerpt: row.excerpt as string | null,
      content: row.content as string | null,
      tags: row.tags as string[] | null,
      featured_image_url: row.featured_image_url as string | null,
      external_url: row.external_url as string | null,
      external_site_name: row.external_site_name as string | null,
      status: row.status as string,
      collection: {
        type: row.working_group_id ? 'committee' : 'personal',
        committee_name: row.committee_name as string | null,
        committee_slug: row.committee_slug as string | null,
      },
      relationships,
      authors: (row.authors as Array<{ user_id: string; display_name: string; display_title: string | null }>) || [],
      published_at: row.published_at as string | null,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }).filter((item: ContentItem) => {
    if (!relationship) return true;
    return item.relationships.includes(relationship);
  });

  if (!includePageviews) {
    return { ok: true, items };
  }

  // Pageview enrichment — only for the web route path (Addie skips this I/O).
  const publishedPaths = items
    .filter(item => item.status === 'published' && typeof item.slug === 'string' && item.slug.length > 0)
    .map(item => `/perspectives/${item.slug}`);

  const pageviewCounts = await fetchPathPageviewCounts(publishedPaths, 30);

  const itemsWithPerformance = items.map(item => {
    if (item.status !== 'published' || !item.slug || !pageviewCounts) {
      return item;
    }
    return {
      ...item,
      performance: {
        pageviews_last_30d: pageviewCounts[`/perspectives/${item.slug}`] ?? 0,
      },
    };
  });

  return { ok: true, items: itemsWithPerformance };
}

/**
 * Convenience wrapper for the web route — resolves `isAdmin` from the DB so
 * callers don't have to import `isWebUserAAOAdmin` separately.
 */
export async function listContentForWebUser(
  userId: string,
  opts: Omit<ListContentForUserOptions, 'userId' | 'isAdmin' | 'includePageviews'>,
): Promise<ListContentForUserResult> {
  const isAdmin = await isWebUserAAOAdmin(userId);
  return listContentForUser({ ...opts, userId, isAdmin, includePageviews: true });
}
