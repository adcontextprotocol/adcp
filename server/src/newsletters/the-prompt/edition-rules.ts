/**
 * The Prompt — rules every surface shares.
 *
 * The Prompt renders to four surfaces (email HTML, email plain text, the
 * Slack announcement and the web/perspective markdown). Each renderer used to
 * decide visibility and repeats on its own, and they drifted: unchecking a
 * section in the admin panel only removed Spec Insight, and only from the
 * HTML email. Every renderer now starts from `getVisiblePromptContent`, so a
 * hidden section or a repeated link is dropped in one place.
 *
 * The functions here are pure so they can be tested without a database.
 */

import { isSectionHidden } from '../config.js';
import { trimTrailing } from '../../utils/truncate.js';
import type {
  DigestContent,
  DigestShipment,
  DigestTakeAction,
} from '../../db/digest-db.js';

/** Section keys the admin panel can hide ("Include in email" toggle). */
export const PROMPT_HIDEABLE_SECTIONS = [
  'whatToWatch',
  'fromTheInside',
  'specInsight',
  'voices',
  'newMembers',
  'whatShipped',
] as const;

export type PromptSectionKey = (typeof PROMPT_HIDEABLE_SECTIONS)[number];

/** True unless an editor unchecked "Include in email" for this section. */
export function isSectionVisible(content: unknown, key: PromptSectionKey | string): boolean {
  return !isSectionHidden(content, key);
}

// ─── URL identity ──────────────────────────────────────────────────────

const TRACKING_PARAM = /^(utm_[a-z]+|ref|ref_src|fbclid|gclid|mc_cid|mc_eid)$/i;

/**
 * Reduce a URL to the identity used for "have we shown this already?".
 * Ignores scheme, `www.`, fragments, tracking parameters and a trailing
 * slash. Not a security check — never use the result as a link target.
 */
export function normalizeEditionUrl(raw: string): string {
  const trimmed = (raw || '').trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const params = [...url.searchParams.entries()]
      .filter(([key]) => !TRACKING_PARAM.test(key))
      .sort(([a], [b]) => a.localeCompare(b));
    const search = params.length > 0
      ? `?${params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`
      : '';
    const path = trimTrailing(url.pathname, '/');
    return `${host}${path}${search}`;
  } catch {
    const hash = trimmed.indexOf('#');
    return trimTrailing((hash >= 0 ? trimmed.slice(0, hash) : trimmed).toLowerCase(), '/');
  }
}

function dedupeByUrl<T>(items: T[], urlOf: (item: T) => string, seen: Set<string>): T[] {
  const kept: T[] = [];
  for (const item of items) {
    const key = normalizeEditionUrl(urlOf(item));
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    kept.push(item);
  }
  return kept;
}

/**
 * Drop repeats across an edition, in reading order: an article shown in
 * What to Watch is not repeated in Voices or What Shipped, and "Take action"
 * never points at a link already shown above it. The first occurrence wins.
 */
export function dedupeEditionItems(content: DigestContent): DigestContent {
  const seen = new Set<string>();
  const whatToWatch = dedupeByUrl(content.whatToWatch || [], (i) => i.url, seen);
  const whatShipped = content.whatShipped
    ? dedupeByUrl(content.whatShipped, (i) => i.url, seen)
    : undefined;
  const voices = dedupeByUrl(content.voices || [], (i) => i.url, seen);
  const takeActions = content.takeActions
    ? dedupeByUrl(content.takeActions, (a: DigestTakeAction) => a.ctaUrl, seen)
    : undefined;

  return {
    ...content,
    whatToWatch,
    voices,
    whatShipped: whatShipped && whatShipped.length > 0 ? whatShipped : undefined,
    takeActions: takeActions && takeActions.length > 0 ? takeActions : undefined,
  };
}

/**
 * The content a reader actually gets: hidden sections removed, repeats
 * dropped. Every Prompt renderer calls this first; none of them reads
 * `hiddenSections` itself.
 */
export function getVisiblePromptContent(content: DigestContent): DigestContent {
  const visible: DigestContent = {
    ...content,
    whatToWatch: isSectionVisible(content, 'whatToWatch') ? content.whatToWatch || [] : [],
    fromTheInside: isSectionVisible(content, 'fromTheInside') ? content.fromTheInside || [] : [],
    voices: isSectionVisible(content, 'voices') ? content.voices || [] : [],
    newMembers: isSectionVisible(content, 'newMembers') ? content.newMembers || [] : [],
    specInsight: isSectionVisible(content, 'specInsight') ? content.specInsight : undefined,
    whatShipped: isSectionVisible(content, 'whatShipped') ? content.whatShipped : undefined,
  };
  return dedupeEditionItems(visible);
}

// ─── Free-text paragraphs ──────────────────────────────────────────────

/**
 * Split editor- or model-written prose into paragraphs on blank lines.
 * Single line breaks stay inside their paragraph.
 */
export function splitParagraphs(text: string | undefined | null): string[] {
  if (!text) return [];
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

// ─── Look-back window ──────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

export interface LookbackOptions {
  /** When the most recent sent edition was built (its content's start point), if any. */
  lastSentAt: Date | null;
  /** Window used when there is no sent edition yet. */
  fallbackDays: number;
  now?: Date;
  /** Never look back less than this (a "send now" a day ago still gets a week). */
  minDays?: number;
  /** Never look back more than this (a long pause does not dump months of content). */
  maxDays?: number;
}

/**
 * Start of the window a section draws from: when the previous edition was
 * built, so nothing published between two editions is missed when the gap
 * is longer than the old fixed window. Clamped to [minDays, maxDays].
 */
export function computeLookbackStart(options: LookbackOptions): Date {
  const now = options.now ?? new Date();
  const minDays = options.minDays ?? 7;
  const maxDays = options.maxDays ?? 45;
  if (!options.lastSentAt || Number.isNaN(options.lastSentAt.getTime())) {
    return new Date(now.getTime() - options.fallbackDays * DAY_MS);
  }
  const earliest = now.getTime() - maxDays * DAY_MS;
  const latest = now.getTime() - minDays * DAY_MS;
  const start = Math.min(Math.max(options.lastSentAt.getTime(), earliest), latest);
  return new Date(start);
}

// ─── What Shipped ──────────────────────────────────────────────────────

const VERSION_RE = /\bv?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?\b/;

/**
 * Collapse patch releases of the same product and minor version into one
 * line ("AdCP 3.2.x — 3.2.3, 3.2.2, 3.2.1"), newest first. Items without a
 * recognisable semver, and minors with a single release, pass through
 * unchanged. Input is expected newest first.
 */
export function groupPatchReleases(items: DigestShipment[]): DigestShipment[] {
  const groups = new Map<string, { index: number; members: Array<{ item: DigestShipment; version: string }> }>();
  const out: Array<DigestShipment | { groupKey: string }> = [];

  for (const item of items) {
    const match = item.title.match(VERSION_RE);
    if (!match || match[4]) {
      // No version, or a prerelease (rc/beta) — keep as its own line.
      out.push(item);
      continue;
    }
    const product = item.title.slice(0, match.index).trim().toLowerCase();
    const key = `${product}|${match[1]}.${match[2]}`;
    const version = `${match[1]}.${match[2]}.${match[3]}`;
    const existing = groups.get(key);
    if (existing) {
      existing.members.push({ item, version });
    } else {
      groups.set(key, { index: out.length, members: [{ item, version }] });
      out.push({ groupKey: key });
    }
  }

  return out.map((entry) => {
    if (!('groupKey' in entry)) return entry;
    const group = groups.get(entry.groupKey)!;
    if (group.members.length === 1) return group.members[0].item;
    const newest = group.members[0];
    const [major, minor] = newest.version.split('.');
    const minorLabel = `${major}.${minor}.x`;
    const title = newest.item.title.replace(VERSION_RE, (m) => (m.startsWith('v') ? `v${minorLabel}` : minorLabel));
    const versions = group.members.map((m) => m.version).join(', ');
    return {
      title,
      url: newest.item.url,
      summary: newest.item.summary
        ? `${versions}. Latest: ${newest.item.summary}`
        : versions,
    };
  });
}
