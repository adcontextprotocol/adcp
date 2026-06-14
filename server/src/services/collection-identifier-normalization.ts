import { normalizeIdentifier } from './identifier-normalization.js';

export interface NormalizedCollectionIdentifier {
  type: string;
  value: string;
}

export const COLLECTION_KIND_VALUES = ['series', 'publication', 'event_series', 'rotation'] as const;
export type CollectionKind = typeof COLLECTION_KIND_VALUES[number];
export const COLLECTION_KIND_SET = new Set<string>(COLLECTION_KIND_VALUES);

export const DISTRIBUTION_IDENTIFIER_TYPE_VALUES = [
  'apple_podcast_id',
  'spotify_collection_id',
  'rss_url',
  'podcast_guid',
  'amazon_music_id',
  'iheart_id',
  'podcast_index_id',
  'youtube_channel_id',
  'youtube_channel_handle',
  'youtube_channel_url',
  'youtube_playlist_id',
  'amazon_title_id',
  'roku_channel_id',
  'pluto_channel_id',
  'tubi_id',
  'peacock_id',
  'tiktok_id',
  'twitch_channel',
  'imdb_id',
  'gracenote_id',
  'eidr_id',
  'domain',
  'substack_id',
] as const;
export type DistributionIdentifierType = typeof DISTRIBUTION_IDENTIFIER_TYPE_VALUES[number];
export const DISTRIBUTION_IDENTIFIER_TYPE_SET = new Set<string>(DISTRIBUTION_IDENTIFIER_TYPE_VALUES);

const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

export function isValidCollectionKind(value: unknown): value is CollectionKind {
  return typeof value === 'string' && COLLECTION_KIND_SET.has(value);
}

export function isValidDistributionIdentifierType(value: unknown): value is DistributionIdentifierType {
  return typeof value === 'string' && DISTRIBUTION_IDENTIFIER_TYPE_SET.has(value);
}

export function isValidCollectionPublisherDomain(value: string): boolean {
  return DOMAIN_PATTERN.test(value);
}

function normalizeYouTubeHandle(raw: string): string {
  const trimmed = raw.trim();
  const withoutAt = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
  return `@${withoutAt.toLowerCase()}`;
}

function normalizeYouTubeChannelUrl(raw: string): string {
  const trimmed = raw.trim();
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    let hostname = url.hostname.toLowerCase();
    if (hostname === 'www.youtube.com' || hostname === 'm.youtube.com') hostname = 'youtube.com';
    let pathname = url.pathname || '/';
    while (pathname.length > 1 && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }
    const segments = pathname.split('/').filter(Boolean);
    const channelTabSuffixes = new Set(['about', 'community', 'featured', 'playlists', 'shorts', 'streams', 'videos']);
    if (
      segments.length > 2
      && (segments[0].startsWith('@') || segments[0] === 'channel')
      && channelTabSuffixes.has(segments[2])
    ) {
      pathname = `/${segments[0]}/${segments[1]}`;
    } else if (
      segments.length > 1
      && segments[0].startsWith('@')
      && channelTabSuffixes.has(segments[1])
    ) {
      pathname = `/${segments[0]}`;
    }
    if (pathname.startsWith('/@')) {
      pathname = pathname.toLowerCase();
    }
    return `https://${hostname}${pathname}`;
  } catch {
    return trimmed;
  }
}

export function normalizeCollectionDistributionIdentifier(
  type: string,
  value: string,
): NormalizedCollectionIdentifier {
  if (type === 'domain' || type === 'subdomain' || type === 'rss_url') {
    const norm = normalizeIdentifier(type, value);
    return { type: norm.type, value: norm.value };
  }
  if (type === 'youtube_channel_handle') {
    return { type, value: normalizeYouTubeHandle(value) };
  }
  if (type === 'youtube_channel_url') {
    return { type, value: normalizeYouTubeChannelUrl(value) };
  }
  return { type, value: value.trim() };
}
