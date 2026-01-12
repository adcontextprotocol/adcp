/**
 * Database layer for industry RSS feeds monitoring
 * RSS articles are stored as perspectives with source_type = 'rss'
 */

import { query } from './client.js';
import { logger } from '../logger.js';

// ============== Types ==============

export interface IndustryFeed {
  id: number;
  name: string;
  feed_url: string | null;
  category: string | null;
  fetch_interval_minutes: number;
  last_fetched_at: Date | null;
  is_active: boolean;
  error_count: number;
  last_error: string | null;
  email_slug: string | null;
  accepts_email: boolean;
  last_email_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface IndustryAlert {
  id: number;
  perspective_id: string | null;
  knowledge_id: number | null;
  alert_level: 'urgent' | 'high' | 'medium' | 'digest';
  channel_id: string | null;
  message_ts: string | null;
  sent_at: Date;
}

export interface RssArticleInput {
  feed_id: number;
  feed_name: string;
  guid: string;
  title: string;
  link: string;
  author?: string;
  published_at?: Date;
  description?: string;
  category?: string;
}

export interface RssPerspective {
  id: string;
  slug: string;
  title: string;
  external_url: string;
  external_site_name: string;
  category: string | null;
  excerpt: string | null;
  author_name: string | null;
  published_at: Date | null;
  feed_id: number;
  guid: string;
  status: string;
  feed_name?: string;
}

// ============== Feed Operations ==============

/**
 * Get all active feeds that need fetching
 * Only returns feeds with a valid feed_url (excludes email-only feeds)
 */
export async function getFeedsToFetch(): Promise<IndustryFeed[]> {
  const result = await query<IndustryFeed>(
    `SELECT * FROM industry_feeds
     WHERE is_active = true
       AND feed_url IS NOT NULL
       AND (last_fetched_at IS NULL
            OR last_fetched_at < NOW() - (fetch_interval_minutes || ' minutes')::interval)
     ORDER BY last_fetched_at ASC NULLS FIRST
     LIMIT 10`
  );
  return result.rows;
}

/**
 * Get all feeds for admin display
 */
export async function getAllFeeds(): Promise<IndustryFeed[]> {
  const result = await query<IndustryFeed>(
    `SELECT * FROM industry_feeds ORDER BY name`
  );
  return result.rows;
}

/**
 * Get a single feed by ID
 */
export async function getFeedById(feedId: number): Promise<IndustryFeed | null> {
  const result = await query<IndustryFeed>(
    `SELECT * FROM industry_feeds WHERE id = $1`,
    [feedId]
  );
  return result.rows[0] || null;
}

/**
 * Update feed after fetching
 */
export async function updateFeedStatus(
  feedId: number,
  success: boolean,
  error?: string
): Promise<void> {
  if (success) {
    await query(
      `UPDATE industry_feeds
       SET last_fetched_at = NOW(),
           error_count = 0,
           last_error = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [feedId]
    );
  } else {
    await query(
      `UPDATE industry_feeds
       SET last_fetched_at = NOW(),
           error_count = error_count + 1,
           last_error = $2,
           updated_at = NOW()
       WHERE id = $1`,
      [feedId, error]
    );
  }
}

/**
 * Normalize a URL for comparison purposes.
 * Removes trailing slashes, normalizes www prefix, and lowercases the hostname.
 */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Normalize hostname: lowercase and remove www prefix
    let hostname = parsed.hostname.toLowerCase();
    if (hostname.startsWith('www.')) {
      hostname = hostname.slice(4);
    }
    // Normalize path: remove trailing slash unless it's just "/"
    let path = parsed.pathname;
    if (path.length > 1 && path.endsWith('/')) {
      path = path.slice(0, -1);
    }
    // Rebuild without search params for comparison (RSS feeds rarely use them meaningfully)
    return `${parsed.protocol}//${hostname}${path}`;
  } catch {
    // If URL parsing fails, return the original lowercased
    return url.toLowerCase().replace(/\/+$/, '');
  }
}

/**
 * Find feeds with similar URLs (potential duplicates).
 * Returns feeds where the normalized URL matches or is very similar.
 */
export async function findSimilarFeeds(feedUrl: string): Promise<IndustryFeed[]> {
  const normalized = normalizeUrl(feedUrl);

  // Get all feeds and check for similar URLs
  const result = await query<IndustryFeed>(
    `SELECT * FROM industry_feeds WHERE feed_url IS NOT NULL`
  );

  const similar: IndustryFeed[] = [];
  for (const feed of result.rows) {
    if (feed.feed_url) {
      const feedNormalized = normalizeUrl(feed.feed_url);
      // Check if normalized URLs match
      if (feedNormalized === normalized) {
        similar.push(feed);
        continue;
      }
      // Check if one is a subdomain or path variant of the other
      // e.g., example.com/feed vs example.com/feed/rss
      try {
        const inputParsed = new URL(normalized.startsWith('http') ? normalized : `https://${normalized}`);
        const feedParsed = new URL(feedNormalized.startsWith('http') ? feedNormalized : `https://${feedNormalized}`);

        // Same hostname, similar paths
        if (inputParsed.hostname === feedParsed.hostname) {
          const inputPath = inputParsed.pathname.toLowerCase();
          const feedPath = feedParsed.pathname.toLowerCase();
          // Check if paths are variations of each other
          if (inputPath.startsWith(feedPath) || feedPath.startsWith(inputPath)) {
            similar.push(feed);
          }
        }
      } catch {
        // Ignore URL parsing errors
      }
    }
  }

  return similar;
}

/**
 * Add a new feed
 */
export async function addFeed(
  name: string,
  feedUrl: string | null,
  category?: string
): Promise<IndustryFeed> {
  const result = await query<IndustryFeed>(
    `INSERT INTO industry_feeds (name, feed_url, category)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [name, feedUrl, category]
  );
  return result.rows[0];
}

/**
 * Toggle feed active status
 */
export async function setFeedActive(feedId: number, isActive: boolean): Promise<void> {
  await query(
    `UPDATE industry_feeds SET is_active = $2, updated_at = NOW() WHERE id = $1`,
    [feedId, isActive]
  );
}

// ============== RSS Perspective Operations ==============

/**
 * Generate a URL-friendly slug from title
 */
function generateSlug(title: string, guid: string): string {
  const baseSlug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 80);

  // Add a hash of the guid to ensure uniqueness
  const hash = Math.abs(guid.split('').reduce((a, b) => {
    a = ((a << 5) - a) + b.charCodeAt(0);
    return a & a;
  }, 0)).toString(36).substring(0, 6);

  return `${baseSlug}-${hash}`;
}

/**
 * Check if RSS article already exists as a perspective
 */
export async function rssArticleExists(feedId: number, guid: string): Promise<boolean> {
  const result = await query<{ exists: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM perspectives WHERE feed_id = $1 AND guid = $2)`,
    [feedId, guid]
  );
  return result.rows[0].exists;
}

/**
 * Create a perspective from an RSS article
 * Returns the perspective ID if created, null if it already exists
 */
export async function createRssPerspective(article: RssArticleInput): Promise<string | null> {
  // First check if we already have this article (by guid)
  const existing = await rssArticleExists(article.feed_id, article.guid);
  if (existing) {
    return null;
  }

  // Generate slug, with retry on collision
  let slug = generateSlug(article.title, article.guid);
  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    try {
      const result = await query<{ id: string }>(
        `INSERT INTO perspectives (
           slug, content_type, title, category, excerpt,
           external_url, external_site_name, author_name,
           status, published_at, source_type, feed_id, guid, tags
         ) VALUES (
           $1, 'link', $2, $3, $4,
           $5, $6, $7,
           'published', $8, 'rss', $9, $10, ARRAY['rss-feed']::TEXT[]
         )
         RETURNING id`,
        [
          slug,
          article.title,
          article.category || 'Industry News',
          article.description?.substring(0, 500),
          article.link,
          article.feed_name,
          article.author,
          article.published_at || new Date(),
          article.feed_id,
          article.guid,
        ]
      );
      return result.rows[0]?.id || null;
    } catch (error) {
      // Handle slug collision by appending random suffix
      if (error instanceof Error && error.message.includes('perspectives_slug_key')) {
        attempts++;
        const suffix = Math.random().toString(36).substring(2, 6);
        slug = `${generateSlug(article.title, article.guid)}-${suffix}`;
      } else {
        throw error;
      }
    }
  }

  // If we exhausted retries, log and skip this article
  logger.warn({ title: article.title, guid: article.guid }, 'Failed to create RSS perspective after slug collision retries');
  return null;
}

/**
 * Create multiple RSS perspectives in batch
 * Returns count of newly created perspectives
 */
export async function createRssPerspectivesBatch(articles: RssArticleInput[]): Promise<number> {
  if (articles.length === 0) return 0;

  let created = 0;
  for (const article of articles) {
    const id = await createRssPerspective(article);
    if (id) created++;
  }
  return created;
}

/**
 * Get RSS perspectives that need content processing
 * (published but not yet in knowledge base, excluding failed ones)
 */
export async function getPendingRssPerspectives(limit: number = 10): Promise<RssPerspective[]> {
  const result = await query<RssPerspective & { feed_name: string }>(
    `SELECT p.*, f.name as feed_name
     FROM perspectives p
     JOIN industry_feeds f ON p.feed_id = f.id
     WHERE p.source_type = 'rss'
       AND p.status = 'published'
       AND NOT EXISTS (
         SELECT 1 FROM addie_knowledge k
         WHERE k.source_url = p.external_url
           AND k.fetch_status IN ('success', 'failed')
       )
     ORDER BY p.published_at DESC NULLS LAST
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

/**
 * Get recent RSS perspectives with their processing status
 */
export async function getRecentRssPerspectives(
  limit: number = 50
): Promise<(RssPerspective & { feed_name: string; summary?: string; quality_score?: number })[]> {
  const result = await query<RssPerspective & { feed_name: string; summary?: string; quality_score?: number }>(
    `SELECT p.*, f.name as feed_name, k.summary, k.quality_score
     FROM perspectives p
     JOIN industry_feeds f ON p.feed_id = f.id
     LEFT JOIN addie_knowledge k ON k.source_url = p.external_url
     WHERE p.source_type = 'rss'
     ORDER BY p.published_at DESC NULLS LAST
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

// ============== Alert Operations ==============

/**
 * Record that we sent an alert for a perspective
 */
export async function recordPerspectiveAlert(
  perspectiveId: string,
  alertLevel: 'urgent' | 'high' | 'medium' | 'digest',
  channelId?: string,
  messageTs?: string
): Promise<IndustryAlert> {
  const result = await query<IndustryAlert>(
    `INSERT INTO industry_alerts (perspective_id, alert_level, channel_id, message_ts)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [perspectiveId, alertLevel, channelId, messageTs]
  );
  return result.rows[0];
}

// ============== Stats ==============

export interface FeedStats {
  total_feeds: number;
  active_feeds: number;
  total_rss_perspectives: number;
  rss_perspectives_today: number;
  pending_processing: number;
  processed_success: number;
  processed_failed: number;
  alerts_sent_today: number;
}

export async function getFeedStats(): Promise<FeedStats> {
  const result = await query<FeedStats>(
    `SELECT
       (SELECT COUNT(*) FROM industry_feeds) as total_feeds,
       (SELECT COUNT(*) FROM industry_feeds WHERE is_active) as active_feeds,
       (SELECT COUNT(*) FROM perspectives WHERE source_type = 'rss') as total_rss_perspectives,
       (SELECT COUNT(*) FROM perspectives WHERE source_type = 'rss' AND created_at > NOW() - INTERVAL '24 hours') as rss_perspectives_today,
       (SELECT COUNT(*) FROM perspectives p
        JOIN industry_feeds f ON p.feed_id = f.id
        WHERE p.source_type = 'rss'
          AND p.status = 'published'
          AND NOT EXISTS (SELECT 1 FROM addie_knowledge k WHERE k.source_url = p.external_url AND k.fetch_status IN ('success', 'failed'))
       ) as pending_processing,
       (SELECT COUNT(*) FROM perspectives p
        JOIN addie_knowledge k ON k.source_url = p.external_url
        WHERE p.source_type = 'rss'
          AND k.fetch_status = 'success'
       ) as processed_success,
       (SELECT COUNT(*) FROM perspectives p
        JOIN addie_knowledge k ON k.source_url = p.external_url
        WHERE p.source_type = 'rss'
          AND k.fetch_status = 'failed'
       ) as processed_failed,
       (SELECT COUNT(*) FROM industry_alerts WHERE sent_at > NOW() - INTERVAL '24 hours') as alerts_sent_today`
  );
  return result.rows[0];
}

// ============== Extended Feed Operations ==============

export interface FeedWithStats extends IndustryFeed {
  article_count: number;
  articles_today: number;
  articles_this_week: number;
  last_article_at: Date | null;
}

/**
 * Get all feeds with article statistics
 */
export async function getAllFeedsWithStats(): Promise<FeedWithStats[]> {
  const result = await query<FeedWithStats>(
    `SELECT
       f.*,
       COALESCE(stats.article_count, 0)::int as article_count,
       COALESCE(stats.articles_today, 0)::int as articles_today,
       COALESCE(stats.articles_this_week, 0)::int as articles_this_week,
       stats.last_article_at
     FROM industry_feeds f
     LEFT JOIN LATERAL (
       SELECT
         COUNT(*) as article_count,
         COUNT(*) FILTER (WHERE p.created_at > NOW() - INTERVAL '24 hours') as articles_today,
         COUNT(*) FILTER (WHERE p.created_at > NOW() - INTERVAL '7 days') as articles_this_week,
         MAX(p.published_at) as last_article_at
       FROM perspectives p
       WHERE p.feed_id = f.id AND p.source_type = 'rss'
     ) stats ON true
     ORDER BY f.name`
  );
  return result.rows;
}

export interface RecentArticle {
  id: string;
  title: string;
  external_url: string;
  published_at: Date | null;
  created_at: Date;
  quality_score: number | null;
  summary: string | null;
}

/**
 * Get recent articles for a specific feed
 */
export async function getRecentArticlesForFeed(feedId: number, limit: number = 10): Promise<RecentArticle[]> {
  const result = await query<RecentArticle>(
    `SELECT
       p.id,
       p.title,
       p.external_url,
       p.published_at,
       p.created_at,
       k.quality_score,
       k.summary
     FROM perspectives p
     LEFT JOIN addie_knowledge k ON k.source_url = p.external_url
     WHERE p.feed_id = $1 AND p.source_type = 'rss'
     ORDER BY p.published_at DESC NULLS LAST, p.created_at DESC
     LIMIT $2`,
    [feedId, limit]
  );
  return result.rows;
}

/**
 * Update feed details
 */
export async function updateFeed(
  feedId: number,
  updates: {
    name?: string;
    feed_url?: string;
    category?: string;
    fetch_interval_minutes?: number;
  }
): Promise<IndustryFeed | null> {
  const setClauses: string[] = ['updated_at = NOW()'];
  const values: (string | number)[] = [];
  let paramIndex = 1;

  if (updates.name !== undefined) {
    setClauses.push(`name = $${paramIndex++}`);
    values.push(updates.name);
  }
  if (updates.feed_url !== undefined) {
    setClauses.push(`feed_url = $${paramIndex++}`);
    values.push(updates.feed_url);
  }
  if (updates.category !== undefined) {
    setClauses.push(`category = $${paramIndex++}`);
    values.push(updates.category);
  }
  if (updates.fetch_interval_minutes !== undefined) {
    setClauses.push(`fetch_interval_minutes = $${paramIndex++}`);
    values.push(updates.fetch_interval_minutes);
  }

  values.push(feedId);

  const result = await query<IndustryFeed>(
    `UPDATE industry_feeds SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
    values
  );
  return result.rows[0] || null;
}

/**
 * Delete a feed and its associated perspectives
 */
export async function deleteFeed(feedId: number): Promise<boolean> {
  // First delete associated alerts
  await query(
    `DELETE FROM industry_alerts WHERE perspective_id IN (
       SELECT id FROM perspectives WHERE feed_id = $1
     )`,
    [feedId]
  );

  // Then delete perspectives
  await query(
    `DELETE FROM perspectives WHERE feed_id = $1`,
    [feedId]
  );

  // Finally delete the feed
  const result = await query(
    `DELETE FROM industry_feeds WHERE id = $1`,
    [feedId]
  );
  return (result.rowCount ?? 0) > 0;
}

// ============== Email Subscription Operations ==============

/**
 * Generate a unique email slug from the feed name
 * Prefixed with "feed-" to distinguish from other email addresses on the domain
 */
function generateEmailSlug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 35); // Leave room for "feed-" prefix
  return `feed-${base}`;
}

/**
 * Enable email subscription for a feed
 * Generates a unique email address slug
 */
export async function enableFeedEmail(feedId: number): Promise<IndustryFeed | null> {
  // First get the feed to generate slug from name
  const feed = await getFeedById(feedId);
  if (!feed) return null;

  // Generate base slug
  let slug = generateEmailSlug(feed.name);
  let attempts = 0;

  // Ensure uniqueness by appending number if needed
  while (attempts < 10) {
    const checkResult = await query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM industry_feeds WHERE email_slug = $1 AND id != $2)`,
      [slug, feedId]
    );

    if (!checkResult.rows[0].exists) break;

    attempts++;
    slug = `${generateEmailSlug(feed.name)}-${attempts}`;
  }

  const result = await query<IndustryFeed>(
    `UPDATE industry_feeds
     SET email_slug = $2, accepts_email = true, updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [feedId, slug]
  );
  return result.rows[0] || null;
}

/**
 * Disable email subscription for a feed
 */
export async function disableFeedEmail(feedId: number): Promise<IndustryFeed | null> {
  const result = await query<IndustryFeed>(
    `UPDATE industry_feeds
     SET accepts_email = false, updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [feedId]
  );
  return result.rows[0] || null;
}

/**
 * Get a feed by its email slug (for webhook handler)
 */
export async function getFeedByEmailSlug(emailSlug: string): Promise<IndustryFeed | null> {
  const result = await query<IndustryFeed>(
    `SELECT * FROM industry_feeds WHERE email_slug = $1 AND accepts_email = true`,
    [emailSlug]
  );
  return result.rows[0] || null;
}

/**
 * Update last email received timestamp
 */
export async function updateFeedLastEmail(feedId: number): Promise<void> {
  await query(
    `UPDATE industry_feeds SET last_email_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [feedId]
  );
}

export interface EmailArticleInput {
  feed_id: number;
  feed_name: string;
  message_id: string;
  subject: string;
  from_email: string;
  from_name?: string;
  received_at: Date;
  html_content?: string;
  text_content?: string;
  links: { url: string; text?: string }[];
}

/**
 * Create a perspective from an email newsletter
 * Returns the perspective ID if created, null if it already exists
 */
export async function createEmailPerspective(article: EmailArticleInput): Promise<string | null> {
  const slug = generateSlug(article.subject, article.message_id);

  // For email newsletters, we create the perspective with the email content as the body
  // and extract the first link as the external_url if available
  const primaryLink = article.links[0]?.url;

  const result = await query<{ id: string }>(
    `INSERT INTO perspectives (
       slug, content_type, title, category, excerpt,
       external_url, external_site_name, author_name,
       status, published_at, source_type, feed_id, guid, tags, body
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8,
       'published', $9, 'email', $10, $11, ARRAY['newsletter']::TEXT[], $12
     )
     ON CONFLICT (feed_id, guid) WHERE guid IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      slug,
      primaryLink ? 'link' : 'article', // link if we have a primary URL, article otherwise
      article.subject,
      'Newsletter',
      article.text_content?.substring(0, 500) || null,
      primaryLink || null,
      article.feed_name,
      article.from_name || article.from_email,
      article.received_at,
      article.feed_id,
      article.message_id,
      article.html_content || article.text_content || null,
    ]
  );

  if (result.rows[0]?.id) {
    await updateFeedLastEmail(article.feed_id);
  }

  return result.rows[0]?.id || null;
}

// ============== Feed Proposal Operations ==============

export interface FeedProposal {
  id: number;
  url: string;
  name: string | null;
  reason: string | null;
  category: string | null;
  proposed_by_slack_user_id: string | null;
  proposed_by_workos_user_id: string | null;
  proposed_at: Date;
  status: 'pending' | 'approved' | 'rejected' | 'duplicate';
  reviewed_by_workos_user_id: string | null;
  reviewed_at: Date | null;
  review_notes: string | null;
  feed_id: number | null;
  source_channel_id: string | null;
  source_message_ts: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateProposalInput {
  url: string;
  name?: string;
  reason?: string;
  category?: string;
  proposed_by_slack_user_id?: string;
  proposed_by_workos_user_id?: string;
  source_channel_id?: string;
  source_message_ts?: string;
}

/**
 * Check if a URL has already been proposed or exists as a feed
 */
export async function findExistingProposalOrFeed(url: string): Promise<{
  existingFeed: IndustryFeed | null;
  existingProposal: FeedProposal | null;
}> {
  const normalized = normalizeUrl(url);

  // Check for existing feed with similar URL
  const feedResult = await query<IndustryFeed>(
    `SELECT * FROM industry_feeds WHERE feed_url IS NOT NULL`
  );

  let existingFeed: IndustryFeed | null = null;
  for (const feed of feedResult.rows) {
    if (feed.feed_url && normalizeUrl(feed.feed_url) === normalized) {
      existingFeed = feed;
      break;
    }
  }

  // Check for pending proposal with similar URL (using normalization)
  const proposalResult = await query<FeedProposal>(
    `SELECT * FROM feed_proposals WHERE status = 'pending'`
  );

  let existingProposal: FeedProposal | null = null;
  for (const proposal of proposalResult.rows) {
    if (normalizeUrl(proposal.url) === normalized) {
      existingProposal = proposal;
      break;
    }
  }

  return {
    existingFeed,
    existingProposal,
  };
}

/**
 * Create a new feed proposal
 */
export async function createFeedProposal(input: CreateProposalInput): Promise<FeedProposal> {
  const result = await query<FeedProposal>(
    `INSERT INTO feed_proposals (
       url, name, reason, category,
       proposed_by_slack_user_id, proposed_by_workos_user_id,
       source_channel_id, source_message_ts
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      input.url,
      input.name || null,
      input.reason || null,
      input.category || null,
      input.proposed_by_slack_user_id || null,
      input.proposed_by_workos_user_id || null,
      input.source_channel_id || null,
      input.source_message_ts || null,
    ]
  );
  return result.rows[0];
}

/**
 * Get pending feed proposals for admin review
 */
export async function getPendingProposals(limit: number = 20): Promise<FeedProposal[]> {
  const result = await query<FeedProposal>(
    `SELECT * FROM feed_proposals
     WHERE status = 'pending'
     ORDER BY proposed_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

/**
 * Approve a feed proposal - creates the feed and updates the proposal
 */
export async function approveProposal(
  proposalId: number,
  reviewedByWorkosUserId: string,
  feedName: string,
  feedUrl: string,
  category?: string
): Promise<{ proposal: FeedProposal; feed: IndustryFeed }> {
  // Create the feed
  const feed = await addFeed(feedName, feedUrl, category);

  // Update the proposal
  const result = await query<FeedProposal>(
    `UPDATE feed_proposals SET
       status = 'approved',
       reviewed_by_workos_user_id = $2,
       reviewed_at = NOW(),
       feed_id = $3,
       updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [proposalId, reviewedByWorkosUserId, feed.id]
  );

  return { proposal: result.rows[0], feed };
}

/**
 * Reject a feed proposal
 */
export async function rejectProposal(
  proposalId: number,
  reviewedByWorkosUserId: string,
  reason?: string
): Promise<FeedProposal> {
  const result = await query<FeedProposal>(
    `UPDATE feed_proposals SET
       status = 'rejected',
       reviewed_by_workos_user_id = $2,
       reviewed_at = NOW(),
       review_notes = $3,
       updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [proposalId, reviewedByWorkosUserId, reason || null]
  );
  return result.rows[0];
}

/**
 * Get proposal stats for admin dashboard
 */
export async function getProposalStats(): Promise<{
  pending: number;
  approved: number;
  rejected: number;
  duplicate: number;
}> {
  const result = await query<{ status: string; count: string }>(
    `SELECT status, COUNT(*) as count FROM feed_proposals GROUP BY status`
  );

  const stats = { pending: 0, approved: 0, rejected: 0, duplicate: 0 };
  for (const row of result.rows) {
    if (row.status in stats) {
      stats[row.status as keyof typeof stats] = parseInt(row.count, 10);
    }
  }
  return stats;
}
