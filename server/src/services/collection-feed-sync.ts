/**
 * Collection Feed Sync Service
 *
 * Fetches content from RSS, YouTube, and Spotify feeds and converts
 * them into brand.json collections with installments.
 *
 * Feed URL is stored on the collection — the sync job re-fetches
 * periodically to pick up new episodes.
 */

import Parser from 'rss-parser';
import { createLogger } from '../logger.js';
import { BrandDatabase } from '../db/brand-db.js';
import { query } from '../db/client.js';

const logger = createLogger('collection-feed-sync');

// ─── Types ───────────────────────────────────────────────────────────

export interface Installment {
  id: string;
  name: string;
  description?: string;
  published_at?: string;
  duration_seconds?: number;
  url?: string;
  season?: number;
  episode_number?: number;
  topics?: string[];
  status?: 'active' | 'removed';
}

export interface FeedResult {
  title: string;
  description?: string;
  artwork_url?: string;
  cadence?: string;
  language?: string;
  genre?: string[];
  genre_taxonomy?: string;
  content_rating?: { system: string; rating: string };
  talent?: Array<{ name: string; role?: string }>;
  installments: Installment[];
}

export interface CollectionFromFeed {
  collection_id: string;
  name: string;
  kind: string;
  feed_url: string;
  feed_type: 'rss' | 'youtube' | 'spotify';
  description?: string;
  artwork_url?: string;
  cadence?: string;
  language?: string;
  genre?: string[];
  genre_taxonomy?: string;
  content_rating?: { system: string; rating: string };
  talent?: Array<{ name: string; role?: string }>;
  installments: Installment[];
  last_synced_at: string;
  last_sync_status?: 'ok' | 'error';
  last_sync_error?: string;
}

// ─── iTunes category → IAB Content Taxonomy mapping ──────────────────

const ITUNES_TO_IAB: Record<string, string> = {
  'arts': 'Arts & Entertainment',
  'business': 'Business',
  'comedy': 'Arts & Entertainment',
  'education': 'Education',
  'fiction': 'Arts & Entertainment',
  'government': 'News & Politics',
  'health & fitness': 'Health & Fitness',
  'history': 'Education',
  'kids & family': 'Family & Parenting',
  'leisure': 'Hobbies & Interests',
  'music': 'Music & Audio',
  'news': 'News & Politics',
  'religion & spirituality': 'Religion & Spirituality',
  'science': 'Science',
  'society & culture': 'Society',
  'sports': 'Sports',
  'technology': 'Technology & Computing',
  'true crime': 'News & Politics',
  'tv & film': 'Arts & Entertainment',
};

function mapItunesCategories(categories: string[]): string[] {
  const genres = new Set<string>();
  for (const cat of categories) {
    const mapped = ITUNES_TO_IAB[cat.toLowerCase()];
    if (mapped) genres.add(mapped);
  }
  return [...genres];
}

// ─── Product template suggestion ─────────────────────────────────────

export interface ProductSuggestion {
  name: string;
  description: string;
  collections: Array<{ collection_id: string }>;
  placement: string;
  pricing_model: string;
}

export function suggestProduct(collection: CollectionFromFeed): ProductSuggestion {
  const isAudio = collection.feed_type === 'rss' || collection.feed_type === 'spotify';
  const isVideo = collection.feed_type === 'youtube';

  return {
    name: `${collection.name} — Run of Show`,
    description: `Advertising across all episodes of ${collection.name}`,
    collections: [{ collection_id: collection.collection_id }],
    placement: isAudio ? 'mid-roll' : isVideo ? 'pre-roll' : 'run-of-show',
    pricing_model: 'cpm',
  };
}

// ─── Feed type detection ─────────────────────────────────────────────

export function detectFeedType(url: string): 'youtube' | 'spotify' | 'rss' {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host.includes('youtube.com') || host.includes('youtu.be')) return 'youtube';
    if (host.includes('spotify.com')) return 'spotify';
  } catch {
    // not a valid URL — treat as RSS
  }
  return 'rss';
}

// ─── Topic extraction ────────────────────────────────────────────────

const TOPIC_KEYWORDS: Record<string, string[]> = {
  'Technology': ['tech', 'artificial intelligence', 'software', 'crypto', 'blockchain', 'startup', 'silicon valley', 'algorithm', 'robot', 'machine learning', 'cybersecurity'],
  'Politics': ['election', 'congress', 'senate', 'president', 'democrat', 'republican', 'vote', 'policy', 'legislation', 'campaign', 'political', 'white house', 'government'],
  'Business': ['economy', 'market', 'stock', 'inflation', 'recession', 'ceo', 'ipo', 'startup', 'revenue', 'profit', 'wall street', 'trade', 'gdp', 'fed', 'interest rate'],
  'Health': ['health', 'medical', 'covid', 'vaccine', 'mental health', 'doctor', 'hospital', 'disease', 'fitness', 'wellness', 'diet', 'therapy'],
  'Science': ['science', 'climate', 'space', 'nasa', 'research', 'study', 'environment', 'species', 'physics', 'biology', 'evolution'],
  'Sports': ['nfl', 'nba', 'mlb', 'soccer', 'football', 'basketball', 'baseball', 'olympics', 'championship', 'playoff', 'super bowl', 'world cup', 'athlete'],
  'Entertainment': ['movie', 'film', 'tv show', 'celebrity', 'music', 'album', 'concert', 'streaming', 'netflix', 'hollywood', 'oscar', 'grammy', 'emmy'],
  'World': ['war', 'ukraine', 'russia', 'china', 'nato', 'un', 'refugee', 'immigration', 'border', 'middle east', 'europe', 'asia', 'africa'],
  'Crime': ['crime', 'murder', 'trial', 'jury', 'prison', 'police', 'investigation', 'fraud', 'lawsuit', 'court', 'judge', 'verdict'],
  'Education': ['school', 'university', 'college', 'student', 'teacher', 'education', 'curriculum', 'degree', 'tuition'],
};

export function extractTopics(title: string, description?: string): string[] {
  const text = `${title} ${description || ''}`.toLowerCase();
  const topics = new Set<string>();
  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    if (keywords.some(kw => {
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
    })) {
      topics.add(topic);
    }
  }
  return [...topics].slice(0, 5);
}

// ─── RSS Parser ──────────────────────────────────────────────────────

const rssParser = new Parser({
  timeout: 30000,
  headers: {
    'User-Agent': 'AAO-FeedSync/1.0 (AgenticAdvertising.org)',
    Accept: 'application/rss+xml, application/xml, text/xml, */*',
  },
});

function parseItuneDuration(duration: string | undefined): number | undefined {
  if (!duration) return undefined;
  // Could be seconds ("3600") or HH:MM:SS ("1:00:00") or MM:SS ("60:00")
  if (/^\d+$/.test(duration)) return parseInt(duration);
  const parts = duration.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return undefined;
}

export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

const MAX_INSTALLMENTS = 500;

export async function fetchRssFeed(url: string): Promise<FeedResult> {
  // Use safeFetch to prevent SSRF — validates URL AND all redirect hops
  const { safeFetch } = await import('../utils/url-security.js');
  const response = await safeFetch(url, {
    headers: {
      'User-Agent': 'AAO-FeedSync/1.0 (AgenticAdvertising.org)',
      Accept: 'application/rss+xml, application/xml, text/xml, */*',
    },
  });
  if (!response.ok) throw new Error(`Feed fetch failed: ${response.status}`);
  const xml = await response.text();
  if (xml.length > 10_000_000) throw new Error('Feed too large (max 10MB)');
  const feed = await rssParser.parseString(xml);

  const installments: Installment[] = (feed.items || []).slice(0, MAX_INSTALLMENTS).map((item, i) => ({
    id: item.guid || `${slugify(item.title || 'episode')}-${i}`,
    name: item.title || `Episode ${i + 1}`,
    description: item.contentSnippet?.slice(0, 500),
    published_at: item.isoDate || item.pubDate || undefined,
    duration_seconds: parseItuneDuration((item.itunes as Record<string, string>)?.duration),
    url: item.enclosure?.url || item.link || undefined,
    season: (item.itunes as Record<string, string>)?.season ? parseInt((item.itunes as Record<string, string>).season) : undefined,
    episode_number: (item.itunes as Record<string, string>)?.episode ? parseInt((item.itunes as Record<string, string>).episode) : undefined,
    topics: extractTopics(item.title || '', item.contentSnippet),
    status: 'active' as const,
  }));

  // Extract rich metadata from iTunes/podcast fields
  const itunesMeta = feed.itunes as Record<string, unknown> | undefined;
  const itunesCategories = Array.isArray(itunesMeta?.categories)
    ? (itunesMeta.categories as string[])
    : typeof itunesMeta?.category === 'string' ? [itunesMeta.category] : [];

  const explicitFlag = (itunesMeta?.explicit as string)?.toLowerCase();
  const contentRating = explicitFlag
    ? { system: 'podcast' as const, rating: explicitFlag === 'yes' || explicitFlag === 'true' || explicitFlag === 'explicit' ? 'explicit' : 'clean' }
    : undefined;

  const author = itunesMeta?.author as string || feed.creator || undefined;
  const talent = author ? [{ name: author, role: 'host' }] : undefined;

  const language = feed.language || undefined;
  const genre = itunesCategories.length > 0 ? mapItunesCategories(itunesCategories) : undefined;

  return {
    title: feed.title || 'Untitled Feed',
    description: feed.description?.slice(0, 1000),
    artwork_url: feed.image?.url || (itunesMeta?.image as string),
    language,
    genre: genre?.length ? genre : undefined,
    content_rating: contentRating,
    talent,
    installments,
  };
}

// ─── YouTube Parser ──────────────────────────────────────────────────

function extractYouTubeChannelId(url: string): string | null {
  try {
    const parsed = new URL(url);
    // youtube.com/channel/UCxxxxx
    const channelMatch = parsed.pathname.match(/^\/channel\/(UC[a-zA-Z0-9_-]+)/);
    if (channelMatch) return channelMatch[1];
    // youtube.com/@handle — need to resolve via API
    const handleMatch = parsed.pathname.match(/^\/@([a-zA-Z0-9_-]+)/);
    if (handleMatch) return `@${handleMatch[1]}`;
    return null;
  } catch {
    return null;
  }
}

export async function fetchYouTubeChannel(url: string): Promise<FeedResult> {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) throw new Error('YOUTUBE_API_KEY not configured');

  const channelRef = extractYouTubeChannelId(url);
  if (!channelRef) throw new Error('Could not extract YouTube channel from URL');

  // Resolve channel ID (handles @ mentions)
  let channelId = channelRef;
  if (channelRef.startsWith('@')) {
    const searchResp = await fetch(
      `https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails&forHandle=${channelRef.slice(1)}&key=${apiKey}`
    );
    if (!searchResp.ok) throw new Error(`YouTube API error: ${searchResp.status} ${searchResp.statusText}`);
    const searchData = await searchResp.json() as { items?: Array<{ id: string }> };
    if (!searchData.items?.length) throw new Error(`YouTube channel not found: ${channelRef}`);
    channelId = searchData.items[0].id;
  }

  // Get channel info + uploads playlist
  const channelResp = await fetch(
    `https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails&id=${channelId}&key=${apiKey}`
  );
  if (!channelResp.ok) throw new Error(`YouTube API error: ${channelResp.status} ${channelResp.statusText}`);
  const channelData = await channelResp.json() as {
    items?: Array<{
      snippet: { title: string; description: string; thumbnails: Record<string, { url: string }> };
      contentDetails: { relatedPlaylists: { uploads: string } };
    }>;
  };
  if (!channelData.items?.length) throw new Error('YouTube channel not found');

  const channel = channelData.items[0];
  const uploadsPlaylistId = channel.contentDetails.relatedPlaylists.uploads;

  // Fetch videos from uploads playlist (max 50 per page, up to 200)
  const installments: Installment[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 4; page++) {
    const listUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&playlistId=${uploadsPlaylistId}&maxResults=50&key=${apiKey}${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const listResp = await fetch(listUrl);
    const listData = await listResp.json() as {
      items?: Array<{
        snippet: { title: string; description: string; publishedAt: string; resourceId: { videoId: string } };
        contentDetails: { videoId: string };
      }>;
      nextPageToken?: string;
    };

    for (const item of listData.items || []) {
      installments.push({
        id: item.contentDetails.videoId,
        name: item.snippet.title,
        description: item.snippet.description?.slice(0, 500),
        published_at: item.snippet.publishedAt,
        url: `https://www.youtube.com/watch?v=${item.contentDetails.videoId}`,
        topics: extractTopics(item.snippet.title, item.snippet.description),
        status: 'active' as const,
      });
    }

    pageToken = listData.nextPageToken;
    if (!pageToken) break;
  }

  return {
    title: channel.snippet.title,
    description: channel.snippet.description?.slice(0, 1000),
    artwork_url: channel.snippet.thumbnails?.high?.url || channel.snippet.thumbnails?.default?.url,
    installments,
  };
}

// ─── Spotify Parser ──────────────────────────────────────────────────

function extractSpotifyShowId(url: string): string | null {
  try {
    const parsed = new URL(url);
    // open.spotify.com/show/XXXXX
    const match = parsed.pathname.match(/^\/show\/([a-zA-Z0-9]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

async function getSpotifyAccessToken(): Promise<string> {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET not configured');

  const resp = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    body: 'grant_type=client_credentials',
  });

  const data = await resp.json() as { access_token: string };
  return data.access_token;
}

export async function fetchSpotifyPodcast(url: string): Promise<FeedResult> {
  const showId = extractSpotifyShowId(url);
  if (!showId) throw new Error('Could not extract Spotify show ID from URL');

  const token = await getSpotifyAccessToken();

  // Get show info
  const showResp = await fetch(`https://api.spotify.com/v1/shows/${showId}?market=US`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!showResp.ok) throw new Error(`Spotify API error: ${showResp.status}`);
  const showData = await showResp.json() as {
    name: string;
    description: string;
    images: Array<{ url: string }>;
    episodes: {
      items: Array<{
        id: string;
        name: string;
        description: string;
        release_date: string;
        duration_ms: number;
        external_urls: { spotify: string };
      }>;
      next: string | null;
    };
  };

  const installments: Installment[] = showData.episodes.items.map(ep => ({
    id: ep.id,
    name: ep.name,
    description: ep.description?.slice(0, 500),
    published_at: ep.release_date,
    duration_seconds: Math.round(ep.duration_ms / 1000),
    url: ep.external_urls.spotify,
    topics: extractTopics(ep.name, ep.description),
    status: 'active' as const,
  }));

  // Fetch more episodes if available (up to 200 total)
  let nextUrl = showData.episodes.next;
  while (nextUrl && installments.length < 200 && nextUrl.startsWith('https://api.spotify.com/')) {
    const nextResp = await fetch(nextUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!nextResp.ok) break;
    const nextData = await nextResp.json() as {
      items: Array<{
        id: string; name: string; description: string;
        release_date: string; duration_ms: number;
        external_urls: { spotify: string };
      }>;
      next: string | null;
    };
    for (const ep of nextData.items) {
      installments.push({
        id: ep.id, name: ep.name, description: ep.description?.slice(0, 500),
        published_at: ep.release_date, duration_seconds: Math.round(ep.duration_ms / 1000),
        url: ep.external_urls.spotify,
        topics: extractTopics(ep.name, ep.description),
        status: 'active' as const,
      });
    }
    nextUrl = nextData.next;
  }

  return {
    title: showData.name,
    description: showData.description?.slice(0, 1000),
    artwork_url: showData.images?.[0]?.url,
    installments,
  };
}

// ─── Unified fetch ───────────────────────────────────────────────────

export async function fetchFeed(url: string): Promise<{ result: FeedResult; feedType: 'rss' | 'youtube' | 'spotify' }> {
  const feedType = detectFeedType(url);
  let result: FeedResult;

  switch (feedType) {
    case 'youtube':
      result = await fetchYouTubeChannel(url);
      break;
    case 'spotify':
      result = await fetchSpotifyPodcast(url);
      break;
    case 'rss':
    default:
      result = await fetchRssFeed(url);
      break;
  }

  return { result, feedType };
}

// ─── Sync all feeds ──────────────────────────────────────────────────

/**
 * Sync all brand collections that have feed_url set.
 * Called by the periodic job scheduler.
 */
const SYNC_CONCURRENCY = 3;
const SYNC_DELAY_MS = 500;

export async function syncAllFeeds(brandDb: BrandDatabase): Promise<{ synced: number; errors: number }> {
  // Find all brands with collections that have feed_url
  const result = await query<{ domain: string; brand_manifest: Record<string, unknown> }>(
    `SELECT domain, brand_manifest FROM brands
     WHERE brand_manifest IS NOT NULL
       AND brand_manifest->'collections' IS NOT NULL
       AND jsonb_array_length(brand_manifest->'collections') > 0`
  );

  let synced = 0;
  let errors = 0;

  // Process brands in batches to avoid overwhelming external APIs
  for (let i = 0; i < result.rows.length; i += SYNC_CONCURRENCY) {
    const batch = result.rows.slice(i, i + SYNC_CONCURRENCY);
    await Promise.all(batch.map(row => syncBrandFeeds(row).then(r => {
      synced += r.synced;
      errors += r.errors;
    })));
    // Delay between batches to respect rate limits
    if (i + SYNC_CONCURRENCY < result.rows.length) {
      await new Promise(r => setTimeout(r, SYNC_DELAY_MS));
    }
  }

  return { synced, errors };
}

async function syncBrandFeeds(row: { domain: string; brand_manifest: Record<string, unknown> }): Promise<{ synced: number; errors: number }> {
  let synced = 0;
  let errors = 0;

  const manifest = row.brand_manifest || {};
  const collections = Array.isArray(manifest.collections) ? manifest.collections as CollectionFromFeed[] : [];
  const feedCollections = collections.filter(c => c.feed_url);

  if (feedCollections.length === 0) return { synced, errors };

  let changed = false;
  for (const collection of feedCollections) {
    try {
      const { result: feedResult } = await fetchFeed(collection.feed_url);

      // Merge installments — update existing by ID, append new, mark removed
      const feedIds = new Set(feedResult.installments.map(i => i.id));
      const existingById = new Map((collection.installments || []).map(i => [i.id, i]));

      // Mark installments no longer in feed as removed (don't delete — something may depend on them)
      for (const [id, inst] of existingById) {
        if (!feedIds.has(id) && inst.status !== 'removed') {
          existingById.set(id, { ...inst, status: 'removed' });
        }
      }

      // Update existing + append new from feed
      for (const installment of feedResult.installments) {
        existingById.set(installment.id, { ...existingById.get(installment.id), ...installment, status: 'active' });
      }

      collection.installments = Array.from(existingById.values())
        .sort((a, b) => (b.published_at || '').localeCompare(a.published_at || ''))
        .slice(0, MAX_INSTALLMENTS);

      collection.last_synced_at = new Date().toISOString();
      collection.last_sync_status = 'ok';
      collection.last_sync_error = undefined;
      if (feedResult.artwork_url && !collection.artwork_url) {
        collection.artwork_url = feedResult.artwork_url;
      }
      changed = true;
      synced++;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.warn({ domain: row.domain, feed_url: collection.feed_url, err: errorMsg }, 'Feed sync failed');
      collection.last_synced_at = new Date().toISOString();
      collection.last_sync_status = 'error';
      collection.last_sync_error = errorMsg;
      changed = true;
      errors++;
    }
  }

  if (changed) {
    const updatedManifest = { ...manifest, collections };
    try {
      await query(
        'UPDATE brands SET brand_manifest = $1::jsonb, updated_at = NOW() WHERE domain = $2',
        [JSON.stringify(updatedManifest), row.domain]
      );
    } catch (err) {
      logger.error({ domain: row.domain, err: err instanceof Error ? err.message : err }, 'Failed to write synced collections');
      errors++;
    }
  }

  return { synced, errors };
}
