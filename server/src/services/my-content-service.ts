/**
 * "My content" listing service.
 *
 * Shared by:
 *  - GET /api/me/content                                       (web/API)
 *  - get_my_content Addie tool                                 (chat)
 *
 * Centralizes the perspectives query (relationships, status filtering,
 * collection filtering, pageview enrichment) so the route and the Addie
 * tool produce identical outcomes. Closes the read-loopback half of
 * issue #3736 (filed as #3748): `callApi('GET', '/api/me/content', …)`
 * sent no credentials and got 401 from `requireAuth` — the route's
 * sole consumer for chat callers became unreachable.
 */

import { getPool } from '../db/client.js';
import { isWebUserAAOAdmin } from '../addie/admin-status-lookup.js';
import { fetchPathPageviewCounts } from './posthog-query.js';

export type MyContentStatus = 'draft' | 'pending_review' | 'published' | 'archived' | 'rejected';
const VALID_STATUSES: readonly MyContentStatus[] = ['draft', 'pending_review', 'published', 'archived', 'rejected'];

export type MyContentRelationship = 'author' | 'proposer' | 'owner';
const VALID_RELATIONSHIPS: readonly MyContentRelationship[] = ['author', 'proposer', 'owner'];

export interface MyContentItem {
  id: string;
  slug: string | null;
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
  relationships: MyContentRelationship[];
  authors: Array<{ user_id: string; display_name: string; display_title: string | null }>;
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
  performance?: { pageviews_last_30d: number };
}

export type MyContentErrorCode = 'invalid_status';

export interface MyContentErrorMetaByCode {
  invalid_status: { provided: string; valid: readonly string[] };
}

export class MyContentError<C extends MyContentErrorCode = MyContentErrorCode> extends Error {
  constructor(
    public readonly code: C,
    message: string,
    public readonly meta: MyContentErrorMetaByCode[C],
  ) {
    super(message);
    this.name = 'MyContentError';
  }

  is<K extends MyContentErrorCode>(code: K): this is MyContentError<K> & { meta: MyContentErrorMetaByCode[K] } {
    return (this.code as string) === (code as string);
  }
}

export interface ListMyContentInput {
  userId: string;
  /** One of MyContentStatus, the literal 'all', or undefined (returns all). */
  status?: string;
  /** Committee slug, or 'personal' (no committee), or undefined. */
  collection?: string;
  /** 'author' | 'proposer' | 'owner' filter — applied after the SQL. */
  relationship?: string;
  /** Defaults to 50, capped at 100 to match the route. */
  limit?: number;
}

export interface ListMyContentResult {
  items: MyContentItem[];
}

export async function listMyContent({
  userId,
  status,
  collection,
  relationship,
  limit,
}: ListMyContentInput): Promise<ListMyContentResult> {
  if (status !== undefined && status !== 'all' && !VALID_STATUSES.includes(status as MyContentStatus)) {
    throw new MyContentError('invalid_status', `status must be one of: ${VALID_STATUSES.join(', ')}, or 'all'`, {
      provided: status,
      valid: VALID_STATUSES,
    });
  }
  // Match the original route's coercion (`parseInt(...) || 50`): any
  // falsy or non-finite limit (including 0, NaN, negative numbers) is
  // treated as "use the default 50". Then cap at 100.
  const cappedLimit = Math.min(typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? limit : 50, 100);

  const pool = getPool();

  // Committees the user leads — feeds the "owner" relationship and the
  // SQL WHERE clause that surfaces all content for those committees.
  const leaderResult = await pool.query<{ working_group_id: string }>(
    `SELECT working_group_id FROM working_group_leaders WHERE user_id = $1`,
    [userId],
  );
  const ledCommitteeIds = leaderResult.rows.map((r) => r.working_group_id);

  // Admins see every perspective so they can edit anything (including
  // pre-existing content with no proposer or content from committees
  // they don't lead). Relationships are still computed so the UI/chat
  // can distinguish their own contributions.
  const userIsAdmin = await isWebUserAAOAdmin(userId);

  let queryText = `
    SELECT DISTINCT ON (p.id)
      p.id, p.slug, p.content_type, p.title, p.subtitle, p.category, p.excerpt,
      p.content, p.tags, p.featured_image_url,
      p.external_url, p.external_site_name, p.status, p.published_at,
      p.created_at, p.updated_at, p.working_group_id, p.proposer_user_id,
      wg.name as committee_name, wg.slug as committee_slug,
      CASE WHEN p.proposer_user_id = $1 THEN true ELSE false END as is_proposer,
      CASE WHEN EXISTS (SELECT 1 FROM content_authors ca WHERE ca.perspective_id = p.id AND ca.user_id = $1) THEN true ELSE false END as is_author,
      CASE WHEN p.working_group_id = ANY($2) THEN true ELSE false END as is_lead,
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
  const params: (string | string[] | number | boolean)[] = [userId, ledCommitteeIds, userIsAdmin];

  if (status && status !== 'all') {
    params.push(status);
    queryText += ` AND p.status = $${params.length}`;
  }

  if (collection) {
    if (collection === 'personal') {
      queryText += ` AND p.working_group_id IS NULL`;
    } else {
      params.push(collection);
      queryText += ` AND wg.slug = $${params.length}`;
    }
  }

  queryText += ` ORDER BY p.id, p.created_at DESC`;
  params.push(cappedLimit);
  queryText += ` LIMIT $${params.length}`;

  // Type the row shape so PG-shape drift (e.g. tags becoming non-array,
  // authors changing JSON shape) surfaces in TypeScript instead of
  // silently passing through `satisfies` checks against `any`.
  interface MyContentSqlRow {
    id: string;
    slug: string | null;
    content_type: string;
    title: string;
    subtitle: string | null;
    category: string | null;
    excerpt: string | null;
    content: string | null;
    tags: string[] | null;
    featured_image_url: string | null;
    external_url: string | null;
    external_site_name: string | null;
    status: string;
    published_at: Date | null;
    created_at: Date;
    updated_at: Date;
    working_group_id: string | null;
    proposer_user_id: string | null;
    committee_name: string | null;
    committee_slug: string | null;
    is_proposer: boolean;
    is_author: boolean;
    is_lead: boolean;
    authors: Array<{ user_id: string; display_name: string; display_title: string | null }> | null;
  }
  const result = await pool.query<MyContentSqlRow>(queryText, params);

  const items: MyContentItem[] = result.rows
    .map((row) => {
      const relationships: MyContentRelationship[] = [];
      if (row.is_author) relationships.push('author');
      if (row.is_proposer) relationships.push('proposer');
      if (row.is_lead) relationships.push('owner');
      return {
        id: row.id,
        slug: row.slug,
        title: row.title,
        subtitle: row.subtitle,
        content_type: row.content_type,
        category: row.category,
        excerpt: row.excerpt,
        content: row.content,
        tags: row.tags,
        featured_image_url: row.featured_image_url,
        external_url: row.external_url,
        external_site_name: row.external_site_name,
        status: row.status,
        collection: {
          type: row.working_group_id ? 'committee' : 'personal',
          committee_name: row.committee_name,
          committee_slug: row.committee_slug,
        },
        relationships,
        authors: row.authors || [],
        published_at: row.published_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
      } satisfies MyContentItem;
    })
    .filter((item) => {
      if (!relationship) return true;
      return item.relationships.includes(relationship as MyContentRelationship);
    });

  // Pageview enrichment. Match the prior route handler's behavior
  // exactly — let any PostHog error propagate to the caller, which
  // surfaces as a 500 from the route or a tool error from the Addie
  // adapter. Don't degrade silently here: if pageview data is
  // unexpectedly empty, the operator should see it.
  const publishedPaths = items
    .filter((item) => item.status === 'published' && typeof item.slug === 'string' && item.slug.length > 0)
    .map((item) => `/perspectives/${item.slug}`);

  const pageviewCounts = await fetchPathPageviewCounts(publishedPaths, 30);

  const itemsWithPerformance = items.map((item) => {
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

  return { items: itemsWithPerformance };
}
