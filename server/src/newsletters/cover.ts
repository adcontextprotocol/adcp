/**
 * Shared Newsletter Cover Image Module
 *
 * Generates date-flavored cover illustrations for any newsletter edition.
 * Used by both The Prompt and The Build.
 */

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

  const prefix = config.coverRoutePrefix || `/${config.id.replace('the_', '')}`;
  const coverImageUrl = `${BASE_URL}${prefix}/${editionDate}/cover.png`;

  return { coverImageUrl, imageBuffer, promptUsed };
}
