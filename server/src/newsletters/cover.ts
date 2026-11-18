/**
 * Shared Newsletter Cover Image Module
 *
 * Generates date-flavored cover illustrations for any newsletter edition.
 * Used by both The Prompt and The Build.
 */

import { createHash } from 'node:crypto';
import { createLogger } from '../logger.js';
import { complete, isLLMConfigured } from '../utils/llm.js';
import { generateIllustration } from '../services/illustration-generator.js';
import type { NewsletterConfig } from './config.js';

const logger = createLogger('newsletter-cover');

const BASE_URL = process.env.BASE_URL || 'https://agenticadvertising.org';

// ─── Date Flavor ──────────────────────────────────────────────────────

/**
 * Generate a fun, globally-aware cultural or seasonal note for today's date.
 * Used as visual context for the cover illustration — NOT displayed to readers.
 * Picks from global holidays, obscure celebrations, seasonal events from any
 * hemisphere/region, or just an interesting fact about the date.
 */
export async function generateDateFlavor(): Promise<string | null> {
  if (!isLLMConfigured()) return null;

  const today = new Date();
  const formatted = today.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  try {
    const result = await complete({
      system: `You pick a single fun, globally-aware observance, celebration, or seasonal fact for a given date. This will be used as visual inspiration for a newsletter cover illustration.

RULES:
- Be GLOBAL. Draw from any country, culture, region, or hemisphere. Do NOT default to US/Western holidays.
- It's fine to pick something obscure, nerdy, or delightful — "National Cheese Donut Day in Perth" is great.
- It's equally fine to pick a major global celebration if one falls on this date (Diwali, Lunar New Year, Eid, etc.).
- If nothing interesting falls on this exact date, pick the closest upcoming notable observance within a week.
- Include the country/region/culture of origin.
- Respond with ONLY a single sentence describing the observance and a brief visual cue for an illustrator.
- Example: "It's Holi in India — a festival of colors with clouds of bright powder in the air."
- Example: "Today is World Standards Day — celebrated globally with flags and formal ceremonies."
- Example: "It's cherry blossom season in Tokyo — pale pink petals against clear skies."
- If nothing is particularly interesting, respond with an empty string.`,
      prompt: `What's interesting about ${formatted}?`,
      maxTokens: 80,
      model: 'fast',
      operationName: 'newsletter-date-flavor',
    });

    const text = result.text.trim();
    return text.length > 5 ? text : null;
  } catch {
    logger.warn('Failed to generate date flavor');
    return null;
  }
}

// ─── Cover Versioning ─────────────────────────────────────────────────

/**
 * Content hash of a cover image, used as the `v` query parameter. The cover
 * route serves "the current cover for this date", so without a version a
 * regenerated cover kept the old URL and every cache (browser, email client
 * proxy, CDN) kept showing the old image for a week.
 */
export function coverVersion(imageData: Buffer): string {
  return createHash('sha256').update(imageData).digest('hex').slice(0, 16);
}

/** Public cover URL for an edition, versioned by the image's content hash. */
export function buildCoverImageUrl(
  config: Pick<NewsletterConfig, 'id' | 'coverRoutePrefix'>,
  editionDate: string,
  imageData: Buffer,
): string {
  const prefix = config.coverRoutePrefix || `/${config.id.replace('the_', '')}`;
  return `${BASE_URL}${prefix}/${editionDate}/cover.png?v=${coverVersion(imageData)}`;
}

/**
 * Cache-Control for a cover response. A URL whose `v` matches the image
 * being served can be cached forever (a new cover gets a new URL); anything
 * else — an unversioned URL from an older edition, or a stale version — is
 * cached briefly so a regenerated cover shows up.
 */
export function coverCacheControl(imageData: Buffer, requestedVersion: unknown): string {
  if (typeof requestedVersion === 'string' && requestedVersion === coverVersion(imageData)) {
    return 'public, max-age=31536000, immutable';
  }
  return 'public, max-age=300';
}

// ─── Cover Generation ─────────────────────────────────────────────────

export interface CoverResult {
  coverImageUrl: string;
  imageBuffer: Buffer;
  promptUsed: string;
}

/**
 * Generate and store a cover image for any newsletter edition.
 * Returns the public URL and image data, or null if the newsletter
 * doesn't support cover images or the edition is no longer a draft.
 */
export async function generateCoverForEdition(
  config: NewsletterConfig,
  editionId: number,
  subject: string,
  excerpt: string,
  editionDate: string,
  dateFlavor?: string,
): Promise<CoverResult | null> {
  if (!config.db.setCoverImage) return null;

  const { imageBuffer, promptUsed, c2pa } = await generateIllustration({
    title: subject,
    category: config.perspectiveCategory,
    excerpt,
    editionDate,
    dateFlavor,
  });

  const stored = await config.db.setCoverImage(
    editionId,
    imageBuffer,
    promptUsed,
    c2pa?.signedAt,
    c2pa?.manifestDigest,
  );
  if (!stored) {
    logger.warn({ editionId, newsletterId: config.id }, 'Could not store cover — edition may no longer be a draft');
    return null;
  }

  const coverImageUrl = buildCoverImageUrl(config, editionDate, imageBuffer);

  return { coverImageUrl, imageBuffer, promptUsed };
}
