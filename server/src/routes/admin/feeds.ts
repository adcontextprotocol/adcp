/**
 * Admin Industry Feeds routes module
 *
 * Admin-only routes for managing RSS/email feeds:
 * - List feeds with stats
 * - Create/update/delete feeds
 * - Auto-discover RSS feeds from URLs
 * - Enable/disable feeds
 * - Manual feed fetch trigger
 * - Email subscription management
 */

import { Router } from 'express';
import { createLogger } from '../../logger.js';
import { requireAuth, requireAdmin } from '../../middleware/auth.js';
import { decodeHtmlEntities } from '../../utils/html-entities.js';
import {
  getAllFeedsWithStats,
  getFeedById,
  addFeed,
  updateFeed,
  deleteFeed,
  setFeedActive,
  getRecentArticlesForFeed,
  getFeedStats,
  enableFeedEmail,
  disableFeedEmail,
  type RecentArticle,
} from '../../db/industry-feeds-db.js';
import { fetchSingleFeed } from '../../addie/services/feed-fetcher.js';

const logger = createLogger('admin-feeds-routes');

/**
 * Try to discover RSS feeds from a URL
 */
async function discoverRssFeeds(url: string): Promise<{ title: string; url: string }[]> {
  const feeds: { title: string; url: string }[] = [];

  try {
    // Fetch the page
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AdCP/1.0; +https://adcontextprotocol.org)',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch URL: ${response.status}`);
    }

    const contentType = response.headers.get('content-type') || '';
    const text = await response.text();

    // Check if this is directly an RSS/Atom feed
    if (contentType.includes('xml') ||
        contentType.includes('rss') ||
        contentType.includes('atom') ||
        text.trim().startsWith('<?xml') ||
        text.includes('<rss') ||
        text.includes('<feed')) {
      // This is a feed itself
      let title = 'RSS Feed';
      const titleMatch = text.match(/<title>([^<]+)<\/title>/i);
      if (titleMatch) {
        title = titleMatch[1].trim();
      }
      feeds.push({ title, url });
      return feeds;
    }

    // Parse HTML and look for feed links
    const feedLinkRegex = /<link[^>]+type=["'](application\/rss\+xml|application\/atom\+xml|application\/feed\+json)["'][^>]*>/gi;
    let match;

    while ((match = feedLinkRegex.exec(text)) !== null) {
      const linkTag = match[0];

      // Extract href
      const hrefMatch = linkTag.match(/href=["']([^"']+)["']/i);
      if (!hrefMatch) continue;

      let feedUrl = hrefMatch[1];

      // Convert relative URLs to absolute
      if (feedUrl.startsWith('/')) {
        const urlObj = new URL(url);
        feedUrl = `${urlObj.origin}${feedUrl}`;
      } else if (!feedUrl.startsWith('http')) {
        const urlObj = new URL(url);
        feedUrl = `${urlObj.origin}/${feedUrl}`;
      }

      // Extract title
      const feedTitleMatch = linkTag.match(/title=["']([^"']+)["']/i);
      const feedTitle = feedTitleMatch ? feedTitleMatch[1] : 'RSS Feed';

      feeds.push({ title: feedTitle, url: feedUrl });
    }

    // Also check common feed paths if no feeds found
    if (feeds.length === 0) {
      const urlObj = new URL(url);
      const commonPaths = ['/feed', '/rss', '/feed.xml', '/rss.xml', '/atom.xml', '/feeds/posts/default'];

      for (const path of commonPaths) {
        try {
          const feedUrl = `${urlObj.origin}${path}`;
          const feedResponse = await fetch(feedUrl, {
            method: 'HEAD',
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; AdCP/1.0)',
            },
          });

          if (feedResponse.ok) {
            const feedContentType = feedResponse.headers.get('content-type') || '';
            if (feedContentType.includes('xml') ||
                feedContentType.includes('rss') ||
                feedContentType.includes('atom')) {
              feeds.push({ title: `${urlObj.hostname} Feed`, url: feedUrl });
              break;
            }
          }
        } catch {
          // Ignore errors for common path checks
        }
      }
    }
  } catch (error) {
    logger.error({ err: error, url }, 'Error discovering feeds');
    throw error;
  }

  return feeds;
}

/**
 * Create admin feeds routes
 * Returns a router to be mounted at /api/admin/feeds
 */
export function createAdminFeedsRouter(): Router {
  const router = Router();

  // GET /api/admin/feeds - List all feeds with stats
  router.get('/', requireAuth, requireAdmin, async (_req, res) => {
    try {
      const feeds = await getAllFeedsWithStats();
      const stats = await getFeedStats();
      res.json({ feeds, stats });
    } catch (error) {
      logger.error({ err: error }, 'List feeds error');
      res.status(500).json({
        error: 'Failed to list feeds',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /api/admin/feeds/:id - Get single feed with recent articles
  router.get('/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const feedId = parseInt(req.params.id, 10);
      if (isNaN(feedId)) {
        return res.status(400).json({ error: 'Invalid feed ID' });
      }

      const feed = await getFeedById(feedId);
      if (!feed) {
        return res.status(404).json({ error: 'Feed not found' });
      }

      const recentArticles = await getRecentArticlesForFeed(feedId, 10);
      // Decode HTML entities in article titles and summaries
      const decodedArticles = recentArticles.map((article: RecentArticle) => ({
        ...article,
        title: decodeHtmlEntities(article.title),
        summary: article.summary ? decodeHtmlEntities(article.summary) : null,
      }));
      res.json({ feed, recentArticles: decodedArticles });
    } catch (error) {
      logger.error({ err: error }, 'Get feed error');
      res.status(500).json({
        error: 'Failed to get feed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // POST /api/admin/feeds - Create new feed
  router.post('/', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { name, feed_url, category, enable_email } = req.body;

      // For email-only feeds, we don't require a feed_url
      const isEmailOnly = enable_email && !feed_url;

      if (!name) {
        return res.status(400).json({ error: 'Name is required' });
      }

      if (!isEmailOnly && !feed_url) {
        return res.status(400).json({ error: 'Feed URL is required for RSS feeds' });
      }

      // Validate URL if provided
      if (feed_url) {
        try {
          new URL(feed_url);
        } catch {
          return res.status(400).json({ error: 'Invalid feed URL' });
        }
      }

      // Create the feed (with null feed_url for email-only)
      const feed = await addFeed(name, feed_url || null, category);
      logger.info({ feedId: feed.id, name, feed_url, isEmailOnly }, 'Feed created');

      // If email-only, enable email subscription immediately
      if (isEmailOnly) {
        const updatedFeed = await enableFeedEmail(feed.id);
        if (updatedFeed) {
          logger.info({ feedId: feed.id, emailSlug: updatedFeed.email_slug }, 'Email enabled for new feed');
          return res.json({ feed: updatedFeed });
        }
      }

      res.json({ feed });
    } catch (error) {
      logger.error({ err: error }, 'Create feed error');
      res.status(500).json({
        error: 'Failed to create feed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // POST /api/admin/feeds/discover - Auto-discover RSS feed from a URL
  router.post('/discover', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { url } = req.body;

      if (!url) {
        return res.status(400).json({ error: 'URL is required' });
      }

      // Validate URL
      try {
        new URL(url);
      } catch {
        return res.status(400).json({ error: 'Invalid URL' });
      }

      const feeds = await discoverRssFeeds(url);
      res.json({ feeds });
    } catch (error) {
      logger.error({ err: error }, 'Discover feeds error');
      res.status(500).json({
        error: 'Failed to discover feeds',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // PUT /api/admin/feeds/:id - Update feed
  router.put('/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const feedId = parseInt(req.params.id, 10);
      if (isNaN(feedId)) {
        return res.status(400).json({ error: 'Invalid feed ID' });
      }

      const { name, feed_url, category, fetch_interval_minutes } = req.body;

      const feed = await updateFeed(feedId, {
        name,
        feed_url,
        category,
        fetch_interval_minutes,
      });

      if (!feed) {
        return res.status(404).json({ error: 'Feed not found' });
      }

      logger.info({ feedId, updates: req.body }, 'Feed updated');
      res.json({ feed });
    } catch (error) {
      logger.error({ err: error }, 'Update feed error');
      res.status(500).json({
        error: 'Failed to update feed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // POST /api/admin/feeds/:id/toggle - Enable/disable feed
  router.post('/:id/toggle', requireAuth, requireAdmin, async (req, res) => {
    try {
      const feedId = parseInt(req.params.id, 10);
      if (isNaN(feedId)) {
        return res.status(400).json({ error: 'Invalid feed ID' });
      }

      const { is_active } = req.body;
      await setFeedActive(feedId, !!is_active);

      logger.info({ feedId, is_active }, 'Feed toggled');
      res.json({ success: true, is_active: !!is_active });
    } catch (error) {
      logger.error({ err: error }, 'Toggle feed error');
      res.status(500).json({
        error: 'Failed to toggle feed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // POST /api/admin/feeds/:id/fetch - Manually trigger feed fetch
  router.post('/:id/fetch', requireAuth, requireAdmin, async (req, res) => {
    try {
      const feedId = parseInt(req.params.id, 10);
      if (isNaN(feedId)) {
        return res.status(400).json({ error: 'Invalid feed ID' });
      }

      const feed = await getFeedById(feedId);
      if (!feed) {
        return res.status(404).json({ error: 'Feed not found' });
      }

      const result = await fetchSingleFeed(feedId);
      logger.info({ feedId, result }, 'Manual feed fetch completed');

      res.json({
        success: result.success,
        message: result.success
          ? `Fetched ${result.newPerspectives} new articles`
          : `Fetch failed: ${result.error}`,
        newArticles: result.newPerspectives,
      });
    } catch (error) {
      logger.error({ err: error }, 'Manual fetch error');
      res.status(500).json({
        error: 'Failed to fetch feed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // DELETE /api/admin/feeds/:id - Delete feed
  router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const feedId = parseInt(req.params.id, 10);
      if (isNaN(feedId)) {
        return res.status(400).json({ error: 'Invalid feed ID' });
      }

      const deleted = await deleteFeed(feedId);
      if (!deleted) {
        return res.status(404).json({ error: 'Feed not found' });
      }

      logger.info({ feedId }, 'Feed deleted');
      res.json({ success: true, deleted: feedId });
    } catch (error) {
      logger.error({ err: error }, 'Delete feed error');
      res.status(500).json({
        error: 'Failed to delete feed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // POST /api/admin/feeds/:id/email - Enable/disable email subscription for a feed
  router.post('/:id/email', requireAuth, requireAdmin, async (req, res) => {
    try {
      const feedId = parseInt(req.params.id, 10);
      if (isNaN(feedId)) {
        return res.status(400).json({ error: 'Invalid feed ID' });
      }

      const { enable } = req.body;
      let feed;

      if (enable) {
        feed = await enableFeedEmail(feedId);
      } else {
        feed = await disableFeedEmail(feedId);
      }

      if (!feed) {
        return res.status(404).json({ error: 'Feed not found' });
      }

      // Return the email address if enabled
      const emailAddress = feed.accepts_email && feed.email_slug
        ? `${feed.email_slug}@updates.agenticadvertising.org`
        : null;

      logger.info({ feedId, enable, emailAddress }, 'Feed email toggled');
      res.json({
        success: true,
        feed,
        email_address: emailAddress,
      });
    } catch (error) {
      logger.error({ err: error }, 'Toggle feed email error');
      res.status(500).json({
        error: 'Failed to toggle feed email',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  return router;
}
