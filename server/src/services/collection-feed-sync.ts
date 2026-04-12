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
}

export interface FeedResult {
  title: string;
  description?: string;
  artwork_url?: string;
  cadence?: string;
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
  installments: Installment[];
  last_synced_at: string;
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

export async function fetchRssFeed(url: string): Promise<FeedResult> {
  const feed = await rssParser.parseURL(url);

  const installments: Installment[] = (feed.items || []).map((item, i) => ({
    id: item.guid || slugify(item.title || `episode-${i}`),
    name: item.title || `Episode ${i + 1}`,
    description: item.contentSnippet?.slice(0, 500),
    published_at: item.isoDate || item.pubDate || undefined,
    duration_seconds: parseItuneDuration((item.itunes as Record<string, string>)?.duration),
    url: item.enclosure?.url || item.link || undefined,
    season: (item.itunes as Record<string, string>)?.season ? parseInt((item.itunes as Record<string, string>).season) : undefined,
    episode_number: (item.itunes as Record<string, string>)?.episode ? parseInt((item.itunes as Record<string, string>).episode) : undefined,
  }));

  return {
    title: feed.title || 'Untitled Feed',
    description: feed.description?.slice(0, 1000),
    artwork_url: feed.image?.url || (feed.itunes as Record<string, string>)?.image,
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
    const searchData = await searchResp.json() as { items?: Array<{ id: string }> };
    if (!searchData.items?.length) throw new Error(`YouTube channel not found: ${channelRef}`);
    channelId = searchData.items[0].id;
  }

  // Get channel info + uploads playlist
  const channelResp = await fetch(
    `https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails&id=${channelId}&key=${apiKey}`
  );
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
  }));

  // Fetch more episodes if available (up to 200 total)
  let nextUrl = showData.episodes.next;
  while (nextUrl && installments.length < 200) {
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

  for (const row of result.rows) {
    const manifest = row.brand_manifest || {};
    const collections = Array.isArray(manifest.collections) ? manifest.collections as CollectionFromFeed[] : [];
    const feedCollections = collections.filter(c => c.feed_url);

    if (feedCollections.length === 0) continue;

    let changed = false;
    for (const collection of feedCollections) {
      try {
        const { result: feedResult } = await fetchFeed(collection.feed_url);

        // Merge installments — update existing by ID, append new
        const existingById = new Map((collection.installments || []).map(i => [i.id, i]));
        for (const installment of feedResult.installments) {
          existingById.set(installment.id, { ...existingById.get(installment.id), ...installment });
        }
        collection.installments = Array.from(existingById.values())
          .sort((a, b) => (b.published_at || '').localeCompare(a.published_at || ''));

        collection.last_synced_at = new Date().toISOString();
        if (feedResult.artwork_url && !collection.artwork_url) {
          collection.artwork_url = feedResult.artwork_url;
        }
        changed = true;
        synced++;
      } catch (err) {
        logger.warn({ domain: row.domain, feed_url: collection.feed_url, err: err instanceof Error ? err.message : err }, 'Feed sync failed');
        errors++;
      }
    }

    if (changed) {
      // Write updated collections back to manifest
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
  }

  return { synced, errors };
}
