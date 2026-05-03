/**
 * Photo-badge compositing for AgenticAdvertising.org member Slack profile photos.
 *
 * Overlays a small circular badge onto a member's existing Slack profile photo:
 * - Badge position: bottom-right corner
 * - Badge size: ~28% of the base image's shorter dimension
 * - Style: brand-color fill (#047857) with a white ring border
 *
 * Placeholder badge: an inline SVG with "AgAd" initials + brand color. Swap
 * the SVG string for the final asset once design delivers it; the compositing
 * path and upload flow remain unchanged.
 */

import sharp from 'sharp';
import { createLogger } from '../logger.js';

const logger = createLogger('photo-badge');

// ──────────────────────────────────────────────────────────────────────────────
// Placeholder badge SVG — replace with final design asset when available.
// 256×256 px, circular, brand teal fill, white "AgAd" initials.
// The SVG is converted to a PNG buffer by sharp at composite time.
// ──────────────────────────────────────────────────────────────────────────────
const PLACEHOLDER_BADGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <circle cx="128" cy="128" r="128" fill="#047857"/>
  <circle cx="128" cy="128" r="118" fill="none" stroke="#ffffff" stroke-width="8"/>
  <text x="128" y="148" font-family="system-ui, -apple-system, sans-serif"
        font-size="72" font-weight="700" fill="#ffffff"
        text-anchor="middle" dominant-baseline="auto">AgAd</text>
</svg>`;

/**
 * Composite the AgenticAdvertising.org member badge onto a profile photo.
 *
 * @param photoBuffer - The original profile photo as a Buffer (JPEG or PNG)
 * @returns The composited image as a JPEG Buffer, ready for upload to Slack
 */
export async function compositeProfileBadge(photoBuffer: Buffer): Promise<Buffer> {
  const base = sharp(photoBuffer);
  const { width = 512, height = 512 } = await base.metadata();

  const shortSide = Math.min(width, height);
  const badgeSize = Math.round(shortSide * 0.28);

  const badgePng = await sharp(Buffer.from(PLACEHOLDER_BADGE_SVG))
    .resize(badgeSize, badgeSize)
    .png()
    .toBuffer();

  const result = await sharp(photoBuffer)
    .rotate() // auto-rotate from EXIF orientation and strip EXIF
    .composite([
      {
        input: badgePng,
        gravity: 'southeast',
        blend: 'over',
      },
    ])
    .jpeg({ quality: 90 })
    .toBuffer();

  logger.debug({ width, height, badgeSize }, 'Composited profile badge');
  return result;
}

/**
 * Fetch a remote image URL and return it as a Buffer.
 * Only Slack CDN hostnames are allowed to prevent SSRF.
 */
export async function fetchImageBuffer(url: string): Promise<Buffer> {
  const host = new URL(url).hostname;
  if (!host.endsWith('.slack.com') && !host.endsWith('.slack-edge.com')) {
    throw new Error(`Refusing to fetch non-Slack image URL: ${host}`);
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch image from ${url}: HTTP ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
