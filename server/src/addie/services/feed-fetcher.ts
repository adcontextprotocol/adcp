/**
 * RSS Feed Fetcher Service
 *
 * Fetches and parses RSS feeds from ad tech publications,
 * creating perspectives for processing by the content curator.
 */

import Parser from 'rss-parser';
import { logger } from '../../logger.js';
import { decodeHtmlEntities } from '../../utils/html-entities.js';
import {
  getFeedsToFetch,
  getFeedById,
  updateFeedStatus,
  createRssPerspectivesBatch,
  normalizeUrl,
  type IndustryFeed,
  type RssArticleInput,
} from '../../db/industry-feeds-db.js';

const parser = new Parser({
  timeout: 30000,
  headers: {
    'User-Agent': 'AddieBot/1.0 (AgenticAdvertising.org industry monitor)',
    Accept: 'application/rss+xml, application/xml, text/xml',
  },
});

/**
 * Validate that content is actually RSS/Atom XML, not HTML
 * Some sites disable their RSS feeds and redirect to HTML pages
 */
function validateRssContent(content: string, contentType: string): { valid: boolean; error?: string } {
  // Check content type header first
  const isXmlContentType =
    contentType.includes('xml') || contentType.includes('rss') || contentType.includes('atom');

  // Check for HTML doctype or opening tags (indicates redirect to HTML page)
  const trimmed = content.trim().toLowerCase();
  if (trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html')) {
    return {
      valid: false,
      error: 'Feed URL returned HTML instead of RSS/XML (feed may be disabled)',
    };
  }

  // Check for valid XML/RSS markers (use trimmed which is lowercased for case-insensitive matching)
  const hasXmlDeclaration = trimmed.startsWith('<?xml');
  const hasRssTag = trimmed.includes('<rss');
  const hasFeedTag = trimmed.includes('<feed'); // Atom feeds
  const hasRdfTag = trimmed.includes('<rdf:'); // RDF feeds

  if (!hasXmlDeclaration && !hasRssTag && !hasFeedTag && !hasRdfTag) {
    // If content type says XML but content doesn't look like RSS
    if (isXmlContentType) {
      return {
        valid: false,
        error: 'Content type is XML but content does not appear to be RSS/Atom',
      };
    }
    return {
      valid: false,
      error: 'Feed URL did not return valid RSS/Atom content',
    };
  }

  return { valid: true };
}

interface FeedItem {
  guid?: string | { _?: string; $?: Record<string, string> };
  link?: string;
  title?: string;
  pubDate?: string;
  isoDate?: string;
  creator?: string;
  author?: string;
  contentSnippet?: string;
  content?: string;
}

/**
 * Check if a feed URL is an HTTP/HTTPS URL that can be fetched as RSS
 */
function isRssFetchable(feedUrl: string | null): feedUrl is string {
  if (!feedUrl) return false;
  try {
    const url = new URL(feedUrl);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Fetch and parse a single RSS feed
 */
async function fetchFeed(feed: IndustryFeed): Promise<RssArticleInput[]> {
  // Skip email-only feeds (those with non-HTTP URLs like email://)
  if (!isRssFetchable(feed.feed_url)) {
    return [];
  }

  // Pre-fetch content to validate it's actually RSS/XML before parsing
  // This prevents cryptic XML parsing errors when sites return HTML
  const response = await fetch(feed.feed_url, {
    headers: {
      'User-Agent': 'AddieBot/1.0 (AgenticAdvertising.org industry monitor)',
      Accept: 'application/rss+xml, application/xml, text/xml',
    },
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type') || '';
  const content = await response.text();

  // Validate content is RSS/XML, not HTML (e.g., from a redirect)
  const validation = validateRssContent(content, contentType);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  // Parse the validated content
  const parsed = await parser.parseString(content);

  if (!parsed.items || parsed.items.length === 0) {
    return [];
  }

  const articles: RssArticleInput[] = [];

  for (const item of parsed.items as FeedItem[]) {
    // Skip items without essential fields
    if (!item.title || !item.link) {
      continue;
    }

    // Generate a stable GUID
    // Handle RSS guids that may be objects with _ property (text content) from XML parsing
    // Some feeds have guid with only attributes ($) but no text content (_)
    const rawGuid = item.guid;
    let guid: string;
    if (typeof rawGuid === 'string') {
      guid = rawGuid;
    } else if (typeof rawGuid === 'object' && rawGuid !== null && '_' in rawGuid && rawGuid._) {
      guid = rawGuid._;
    } else {
      // Fall back to link if guid is missing or empty object
      guid = item.link;
    }

    // Parse publication date
    let publishedAt: Date | undefined;
    if (item.isoDate) {
      publishedAt = new Date(item.isoDate);
    } else if (item.pubDate) {
      publishedAt = new Date(item.pubDate);
    }

    // Skip very old articles (older than 7 days)
    if (publishedAt) {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      if (publishedAt < sevenDaysAgo) {
        continue;
      }
    }

    articles.push({
      feed_id: feed.id,
      feed_name: feed.name,
      guid,
      // Decode title since it displays in UI/Slack where entities look bad
      title: decodeHtmlEntities(item.title),
      // Normalize URL to prevent duplicates from different feeds with tracking params
      link: normalizeUrl(item.link),
      author: item.creator || item.author,
      published_at: publishedAt,
      // Description is used for content processing, not direct display
      description: item.contentSnippet || item.content?.substring(0, 1000),
      category: feed.category || undefined,
    });
  }

  return articles;
}

/**
 * Process all feeds that need fetching
 */
export async function processFeedsToFetch(): Promise<{
  feedsProcessed: number;
  newPerspectives: number;
  errors: number;
}> {
  const feeds = await getFeedsToFetch();

  if (feeds.length === 0) {
    return { feedsProcessed: 0, newPerspectives: 0, errors: 0 };
  }

  let totalNewPerspectives = 0;
  let errorCount = 0;

  for (const feed of feeds) {
    try {
      const articles = await fetchFeed(feed);

      if (articles.length > 0) {
        const created = await createRssPerspectivesBatch(articles);
        totalNewPerspectives += created;
      }

      await updateFeedStatus(feed.id, true);
    } catch (error) {
      errorCount++;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.debug({ feedId: feed.id, name: feed.name, error: errorMessage }, 'Failed to fetch RSS feed');
      await updateFeedStatus(feed.id, false, errorMessage);
    }

    // Small delay between feeds to be respectful
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // Only log when there's something notable
  if (errorCount > 0) {
    logger.info(
      { feedsProcessed: feeds.length, newPerspectives: totalNewPerspectives, errors: errorCount },
      'RSS feed processing complete with errors'
    );
  } else if (totalNewPerspectives > 0) {
    logger.debug(
      { feedsProcessed: feeds.length, newPerspectives: totalNewPerspectives, errors: errorCount },
      'RSS feed processing complete'
    );
  }

  return {
    feedsProcessed: feeds.length,
    newPerspectives: totalNewPerspectives,
    errors: errorCount,
  };
}

/**
 * Fetch a specific feed by ID (for manual refresh)
 */
export async function fetchSingleFeed(feedId: number): Promise<{
  success: boolean;
  newPerspectives: number;
  error?: string;
}> {
  const feed = await getFeedById(feedId);

  if (!feed) {
    return { success: false, newPerspectives: 0, error: 'Feed not found' };
  }

  // Email-only feeds cannot be fetched via RSS
  if (!isRssFetchable(feed.feed_url)) {
    return {
      success: false,
      newPerspectives: 0,
      error: 'This feed receives content via email only, not RSS',
    };
  }

  try {
    const articles = await fetchFeed(feed);
    const created = articles.length > 0 ? await createRssPerspectivesBatch(articles) : 0;
    await updateFeedStatus(feedId, true);
    return { success: true, newPerspectives: created };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    await updateFeedStatus(feedId, false, errorMessage);
    return { success: false, newPerspectives: 0, error: errorMessage };
  }
}
