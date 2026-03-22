/**
 * Portrait Generator Service
 *
 * Generates illustrated member portraits using Gemini. Accepts an optional
 * photo reference and a vibe setting. The generated image follows the AAO
 * graphic novel aesthetic with palette-specific coloring.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { createLogger } from '../logger.js';

const logger = createLogger('portrait-generator');

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
  const model = ai.getGenerativeModel({
    model: 'gemini-3.1-flash-image-preview',
    generationConfig: {
      // @ts-expect-error - responseModalities not in SDK types yet
      responseModalities: ['TEXT', 'IMAGE'],
    },
  });

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

  const result = await model.generateContent(parts);
  const response = result.response;

  for (const part of response.candidates?.[0]?.content?.parts ?? []) {
    if (part.inlineData) {
      const imageBuffer = Buffer.from(part.inlineData.data, 'base64');
      logger.info({ sizeKB: (imageBuffer.length / 1024).toFixed(0) }, 'Portrait generated');
      return { imageBuffer, promptUsed: prompt };
    }
  }

  const text = response.text?.() || 'No response';
  throw new Error(`Gemini did not return an image. Response: ${text.slice(0, 200)}`);
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
  const model = ai.getGenerativeModel({ model: 'gemini-2.0-flash' });

  const validationPrompt =
    `Analyze this portrait illustration for quality. Check: ` +
    `1) Is there any garbled or nonsensical text in the image? ` +
    `2) Does it look like a proper illustrated portrait suitable for a profile avatar? ` +
    `3) Is the subject centered and the composition clean? ` +
    `Respond ONLY with valid JSON (no markdown fences): ` +
    `{ "valid": true/false, "issues": ["issue 1", "issue 2"] }`;

  try {
    const result = await model.generateContent([
      {
        inlineData: {
          mimeType: 'image/png',
          data: imageBuffer.toString('base64'),
        },
      },
      validationPrompt,
    ]);

    const text = result.response.text().trim();
    const jsonStr = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    return JSON.parse(jsonStr);
  } catch (err) {
    logger.warn({ err }, 'Portrait validation failed, treating as valid');
    return { valid: true, issues: [] };
  }
}
