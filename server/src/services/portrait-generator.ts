/**
 * Portrait Generator Service
 *
 * Generates illustrated member portraits using Gemini. Accepts an optional
 * photo reference and a vibe setting. The generated image follows the AAO
 * graphic novel aesthetic with palette-specific coloring.
 */

import { createHash } from 'crypto';
import { GoogleGenerativeAI } from '@google/generative-ai';
import sharp from 'sharp';
import { createLogger } from '../logger.js';
import { withGeminiRetry } from '../utils/gemini-retry.js';
import { signC2PA, isC2PASigningEnabled } from './c2pa.js';
import { notifySystemError } from '../addie/error-notifier.js';

const logger = createLogger('portrait-generator');

const GEMINI_IMAGE_MODEL = 'gemini-3.1-flash-image-preview';
const GEMINI_IMAGE_VERSION = 'preview';

const PALETTES: Record<string, string> = {
  amber: `Flat illustration, amber/gold-led color palette (#D4A017 primary, #F4C430 secondary, #FFE066 light accents). Graphic novel style with clean linework and subtle gradients. Circular composition centered on the subject, suitable for avatar/profile use. Warm, approachable tone.`,
  blue: `Flat illustration, blue-led color palette (#1a36b4 primary, #2d4fd6 secondary, #6b8cef light accents). Graphic novel style with clean linework and subtle gradients. Circular composition centered on the subject, suitable for avatar/profile use. Tech-forward but warm.`,
  teal: `Flat illustration, teal-led color palette (#0d9488 primary, #14b8a6 secondary, #5eead4 light accents). Graphic novel style with clean linework and subtle gradients. Circular composition centered on the subject, suitable for avatar/profile use. Tech-forward but warm.`,
};

export const VIBE_OPTIONS: Record<string, string> = {
  'at-my-desk': 'Sitting at a modern workstation with monitors showing dashboards and analytics in the background.',
  'on-stage': 'Standing at a podium or on stage with soft spotlighting and an audience silhouette.',
  'in-a-studio': 'In a production studio with cameras, lighting rigs, and creative equipment.',
  'boardroom': 'In a conference room with a whiteboard covered in diagrams behind them.',
  'casual': 'Simple, clean background with warm ambient lighting.',
};

export interface GeneratePortraitOptions {
  photoBuffer?: Buffer;
  photoMimeType?: string;
  vibe: string;
  palette?: string;
}

export interface GeneratePortraitResult {
  imageBuffer: Buffer;
  promptUsed: string;
  /**
   * C2PA provenance metadata, present when signing is enabled and succeeded.
   * The imageBuffer already carries the embedded manifest; these fields are
   * persisted alongside the row so admin tools can find unsigned portraits
   * without parsing every PNG.
   */
  c2pa?: {
    signedAt: Date;
    manifestDigest: string;
  };
}

let genAI: GoogleGenerativeAI | null = null;

function getGenAI(): GoogleGenerativeAI {
  if (!genAI) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY environment variable is required for portrait generation');
    }
    genAI = new GoogleGenerativeAI(apiKey);
  }
  return genAI;
}

/**
 * Generate an illustrated portrait.
 *
 * If a photo buffer is provided, it's used as a visual reference for the
 * subject's appearance. The photo is never stored — it exists only in
 * memory during the API call.
 */
export async function generatePortrait(options: GeneratePortraitOptions): Promise<GeneratePortraitResult> {
  const { photoBuffer, photoMimeType, vibe, palette = 'amber' } = options;

  const paletteStyle = PALETTES[palette] || PALETTES.amber;
  const vibeDescription = VIBE_OPTIONS[vibe];
  if (!vibeDescription) {
    throw new Error(`Invalid vibe: ${vibe}. Must be one of: ${Object.keys(VIBE_OPTIONS).join(', ')}`);
  }

  let prompt = `${paletteStyle}\n\n`;

  if (photoBuffer) {
    prompt += `Use the provided photo as a reference for the person's appearance — face shape, hair style, skin tone, glasses, and other distinguishing features. Create an illustrated version of this person, not a photorealistic copy.\n\n`;
  }

  prompt += `Setting: ${vibeDescription}\n\n`;
  prompt += `Do not include any text, words, labels, or logos in the image. Square aspect ratio.`;

  const ai = getGenAI();
  const model = ai.getGenerativeModel(
    {
      model: 'gemini-3.1-flash-image-preview',
      generationConfig: {
        // @ts-expect-error - responseModalities not in SDK types yet
        responseModalities: ['TEXT', 'IMAGE'],
      },
    },
    { timeout: 180_000 },
  );

  // Build content parts
  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];

  if (photoBuffer && photoMimeType) {
    parts.push({
      inlineData: {
        mimeType: photoMimeType,
        data: photoBuffer.toString('base64'),
      },
    });
  }

  parts.push({ text: prompt });

  logger.info({ vibe, palette, hasPhoto: !!photoBuffer }, 'Generating portrait');

  const result = await withGeminiRetry(
    () => model.generateContent(parts),
    { initialDelayMs: 5000, maxDelayMs: 30000 },
    'generatePortrait',
  );
  const response = result.response;

  for (const part of response.candidates?.[0]?.content?.parts ?? []) {
    if (part.inlineData) {
      const mimeType = part.inlineData.mimeType || 'image/png';
      if (!mimeType.startsWith('image/')) {
        throw new Error(`Gemini returned non-image content: ${mimeType}`);
      }
      const rawBuffer = Buffer.from(part.inlineData.data, 'base64');
      logger.info({ sizeKB: (rawBuffer.length / 1024).toFixed(0) }, 'Portrait generated');
      return await finalizePortrait(rawBuffer, { vibe, palette, promptUsed: prompt });
    }
  }

  const text = response.text?.() || 'No response';
  throw new Error(`Gemini did not return an image. Response: ${text.slice(0, 200)}`);
}

/**
 * Composite an "AI" corner badge onto the portrait and embed an AAO C2PA
 * manifest. The badge is CA SB 942's visible disclosure path; the manifest
 * is Art 50's machine-readable path. Order matters: badge must go on
 * before signing so the signature covers the disclosed pixels.
 *
 * Failure policy matches the illustration generator: C2PA_STRICT rethrows,
 * default returns the unsigned-but-badged buffer so a transient signing
 * failure never blocks a member from getting their portrait. Every failure
 * fires a throttled notifySystemError alert.
 */
export async function finalizePortrait(
  rawBuffer: Buffer,
  meta: { vibe: string; palette: string; promptUsed: string },
): Promise<GeneratePortraitResult> {
  const badgedBuffer = await compositeAIBadge(rawBuffer);

  if (!isC2PASigningEnabled()) {
    return { imageBuffer: badgedBuffer, promptUsed: meta.promptUsed };
  }
  try {
    const signed = signC2PA(badgedBuffer, {
      claimGenerator: 'AAO Portrait Generator',
      title: 'AAO Member Portrait',
      softwareAgent: { name: GEMINI_IMAGE_MODEL, version: GEMINI_IMAGE_VERSION },
      attributes: {
        vibe: meta.vibe,
        palette: meta.palette,
        prompt_sha256: createHash('sha256').update(meta.promptUsed).digest('hex'),
      },
    });
    return {
      imageBuffer: signed.signedBuffer,
      promptUsed: meta.promptUsed,
      c2pa: { signedAt: new Date(), manifestDigest: signed.manifestDigest },
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error({ err, vibe: meta.vibe, palette: meta.palette }, 'C2PA signing failed for portrait');
    notifySystemError({
      source: 'c2pa-portrait-signing',
      errorMessage: `Portrait signing failed (vibe=${meta.vibe}, palette=${meta.palette}): ${errorMessage}`,
    });
    if (process.env.C2PA_STRICT === 'true') {
      throw err;
    }
    return { imageBuffer: badgedBuffer, promptUsed: meta.promptUsed };
  }
}

/**
 * Composite a small "AI" badge in the bottom-right corner of the portrait.
 * Satisfies CA SB 942's visible-disclosure requirement without dominating
 * the avatar. Uses an SVG overlay so the badge is crisp at any portrait size.
 */
export async function compositeAIBadge(imageBuffer: Buffer): Promise<Buffer> {
  const metadata = await sharp(imageBuffer).metadata();
  const shortEdge = Math.min(metadata.width ?? 512, metadata.height ?? 512);
  const badgeSize = Math.max(32, Math.round(shortEdge * 0.1));
  const fontSize = Math.round(badgeSize * 0.55);
  const margin = Math.round(badgeSize * 0.25);

  const badgeSvg = Buffer.from(`
    <svg width="${badgeSize}" height="${badgeSize}" viewBox="0 0 ${badgeSize} ${badgeSize}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${badgeSize}" height="${badgeSize}" rx="${Math.round(badgeSize * 0.2)}"
            fill="rgba(30,30,30,0.78)" stroke="rgba(255,255,255,0.9)" stroke-width="1.5"/>
      <text x="50%" y="55%" dominant-baseline="middle" text-anchor="middle"
            font-family="system-ui, -apple-system, sans-serif" font-weight="700"
            font-size="${fontSize}" fill="#ffffff">AI</text>
    </svg>`);

  // Pad the badge into a transparent canvas so sharp's southeast gravity
  // gives us the margin we want from the edge.
  const padded = await sharp({
    create: {
      width: badgeSize + margin,
      height: badgeSize + margin,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: badgeSvg, top: 0, left: 0 }])
    .png()
    .toBuffer();

  return sharp(imageBuffer)
    .composite([{ input: padded, gravity: 'southeast' }])
    .png()
    .toBuffer();
}

/**
 * Validate a generated portrait using Gemini vision.
 * Checks for gibberish text and general quality.
 */
export async function validatePortrait(imageBuffer: Buffer): Promise<{
  valid: boolean;
  issues: string[];
}> {
  const ai = getGenAI();
  const model = ai.getGenerativeModel({ model: 'gemini-2.0-flash' }, { timeout: 30_000 });

  const validationPrompt =
    `Analyze this portrait illustration for quality. Check: ` +
    `1) Is there any garbled or nonsensical text in the image? ` +
    `2) Does it look like a proper illustrated portrait suitable for a profile avatar? ` +
    `3) Is the subject centered and the composition clean? ` +
    `Respond ONLY with valid JSON (no markdown fences): ` +
    `{ "valid": true/false, "issues": ["issue 1", "issue 2"] }`;

  try {
    const result = await withGeminiRetry(
      () => model.generateContent([
        {
          inlineData: {
            mimeType: 'image/png',
            data: imageBuffer.toString('base64'),
          },
        },
        validationPrompt,
      ]),
      undefined,
      'validatePortrait',
    );

    const text = result.response.text().trim();
    const jsonStr = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    return JSON.parse(jsonStr);
  } catch (err) {
    logger.warn({ err }, 'Portrait validation failed, treating as valid');
    return { valid: true, issues: [] };
  }
}
