/**
 * RSS Feed Fetcher Service
 *
 * Fetches and parses RSS feeds from ad tech publications,
 * creating perspectives for processing by the content curator.
 */

import Parser from 'rss-parser';
import { logger } from '../../logger.js';
import {
  getFeedsToFetch,
  getFeedById,
  updateFeedStatus,
  createRssPerspectivesBatch,
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

interface FeedItem {
  guid?: string;
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
function isRssFetchable(feedUrl: string): boolean {
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
    logger.debug({ feedId: feed.id, name: feed.name, url: feed.feed_url }, 'Skipping non-HTTP feed');
    return [];
  }

  logger.debug({ feedId: feed.id, name: feed.name, url: feed.feed_url }, 'Fetching RSS feed');

  const parsed = await parser.parseURL(feed.feed_url);

  if (!parsed.items || parsed.items.length === 0) {
    logger.warn({ feedId: feed.id }, 'Feed returned no items');
    return [];
  }

  const articles: RssArticleInput[] = [];

  for (const item of parsed.items as FeedItem[]) {
    // Skip items without essential fields
    if (!item.title || !item.link) {
      continue;
    }

    // Generate a stable GUID
    const guid = item.guid || item.link;

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
      title: item.title,
      link: item.link,
      author: item.creator || item.author,
      published_at: publishedAt,
      description: item.contentSnippet || item.content?.substring(0, 1000),
      category: feed.category || undefined,
    });
  }

  logger.debug({ feedId: feed.id, articlesFound: articles.length }, 'Parsed RSS feed');
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
    logger.debug('No feeds need fetching');
    return { feedsProcessed: 0, newPerspectives: 0, errors: 0 };
  }

  logger.debug({ feedCount: feeds.length }, 'Processing RSS feeds');

  let totalNewPerspectives = 0;
  let errorCount = 0;

  for (const feed of feeds) {
    try {
      const articles = await fetchFeed(feed);

      if (articles.length > 0) {
        // Create perspectives from RSS articles
        const created = await createRssPerspectivesBatch(articles);
        totalNewPerspectives += created;
        logger.debug({ feedId: feed.id, created }, 'Created perspectives from RSS');
      }

      await updateFeedStatus(feed.id, true);
    } catch (error) {
      errorCount++;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ error, feedId: feed.id, name: feed.name }, 'Failed to fetch RSS feed');
      await updateFeedStatus(feed.id, false, errorMessage);
    }

    // Small delay between feeds to be respectful
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  logger.info(
    { feedsProcessed: feeds.length, newPerspectives: totalNewPerspectives, errors: errorCount },
    'Completed RSS feed processing'
  );

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
