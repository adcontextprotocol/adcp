/**
 * Logo renditions and background classification.
 *
 * Rasterises stored, approved brand logos to PNG at a fixed set of widths, and
 * classifies which background a logo is drawn for from its rendered pixels.
 * Callers pass bytes already read from `brand_logos`; nothing here fetches a
 * URL, so a rendition can never reach a remote host.
 */

import sharp, { type Metadata, type Sharp } from 'sharp';
import { sanitizeSvg, sanitizeSvgAtSize } from './brand-logo-service.js';
import { AsyncSemaphore } from '../utils/async-semaphore.js';

/**
 * Renders (PNG renditions and background classification) run at once per
 * process. sharp runs on the libuv thread pool, 4 threads by default; two
 * leaves room for the file system, DNS and crypto work that shares it.
 */
export const LOGO_RENDER_CONCURRENCY = 2;
/** Renders allowed to wait for a slot before callers are shed. */
export const LOGO_RENDER_MAX_QUEUED = 32;

/** The process-wide render limiter: every logo render acquires it. */
export const logoRenderLimiter = new AsyncSemaphore(LOGO_RENDER_CONCURRENCY, LOGO_RENDER_MAX_QUEUED);

/** Widths a PNG rendition may be requested at. */
export const LOGO_RENDITION_WIDTHS = [64, 128, 256, 512, 1024] as const;
export type LogoRenditionWidth = typeof LOGO_RENDITION_WIDTHS[number];
export const DEFAULT_LOGO_RENDITION_WIDTH: LogoRenditionWidth = 512;

/** Height is by aspect ratio, but never more than this multiple of the width. */
const MAX_HEIGHT_TO_WIDTH = 4;

// Same decode cap as extractDimensions: a small file can claim gigapixel
// dimensions (or an SVG can render to them), so refuse before decoding.
const LOGO_INPUT_PIXEL_LIMIT = 24_000_000;

// sharp rasterises SVG at 72 DPI by default; density scales from there.
const SVG_BASE_DENSITY = 72;
/** sharp's minimum; below it planSvgRender resizes the root instead. */
const MIN_SVG_DENSITY = 1;
const MAX_SVG_DENSITY = 100_000;

const RASTERIZABLE_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
]);

export type LogoBackground = 'light-bg' | 'dark-bg' | 'transparent-bg';
export type DerivedLogoBackground = 'light-bg' | 'dark-bg';

export function isLogoBackground(value: unknown): value is LogoBackground {
  return value === 'light-bg' || value === 'dark-bg' || value === 'transparent-bg';
}

export function isLogoRenditionWidth(value: number): value is LogoRenditionWidth {
  return (LOGO_RENDITION_WIDTHS as readonly number[]).includes(value);
}

export function canRasterizeLogo(contentType: string): boolean {
  return RASTERIZABLE_CONTENT_TYPES.has(contentType.toLowerCase());
}

export type LogoRenditionRequest =
  | { ok: true; rendition: { format: 'png'; width: LogoRenditionWidth } | null }
  | { ok: false; error: string };

/**
 * Parse `?format=png&w=<width>` from a logo request. No `format` and no `w`
 * means the original bytes. Anything else unrecognised is rejected, so the
 * cache key space stays at one entry per allowed width.
 */
export function parseLogoRenditionQuery(query: Record<string, unknown>): LogoRenditionRequest {
  const { format, w } = query;
  if (format === undefined && w === undefined) return { ok: true, rendition: null };
  if (format !== 'png') {
    return { ok: false, error: 'Unsupported format. The only rendition format is png.' };
  }
  if (w === undefined) {
    return { ok: true, rendition: { format: 'png', width: DEFAULT_LOGO_RENDITION_WIDTH } };
  }
  const width = typeof w === 'string' && /^\d{1,5}$/.test(w) ? Number(w) : NaN;
  if (!isLogoRenditionWidth(width)) {
    return { ok: false, error: `Invalid width. Allowed widths: ${LOGO_RENDITION_WIDTHS.join(', ')}.` };
  }
  return { ok: true, rendition: { format: 'png', width } };
}

export class LogoRenditionError extends Error {
  constructor(
    readonly reason: 'unsupported' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'LogoRenditionError';
  }
}

export type SvgRenderPlan =
  | { kind: 'density'; density: number }
  | { kind: 'resize-root'; width: number; height: number };

/**
 * How to rasterise an SVG of the given intrinsic size (pixels at 72 DPI) so
 * it fits `width` × `maxHeight`.
 *
 * Normally that is a density: 72 DPI scaled to the target. sharp's density
 * cannot go below 1, so an SVG declaring an intrinsic size more than 72× the
 * target (a `width="345000"` root) would still decode at 1/72 of its declared
 * size, millions of pixels for a 64 px PNG. Then the plan instead rewrites
 * the root element to the target size and renders that at 72 DPI.
 */
export function planSvgRender(
  intrinsic: { width: number; height: number },
  width: number,
  maxHeight: number,
): SvgRenderPlan {
  const scale = Math.min(width / intrinsic.width, maxHeight / intrinsic.height);
  const density = SVG_BASE_DENSITY * scale;
  if (density >= MIN_SVG_DENSITY) {
    return { kind: 'density', density: Math.min(MAX_SVG_DENSITY, density) };
  }
  return {
    kind: 'resize-root',
    width: Math.max(1, Math.round(intrinsic.width * scale)),
    height: Math.max(1, Math.round(intrinsic.height * scale)),
  };
}

/**
 * Decode a logo into a pipeline sized to fit `width` × `width * 4`.
 * SVGs are re-sanitised and rendered at the density that hits the target
 * width, so vectors stay sharp; rasters are never enlarged.
 */
async function decodeLogo(data: Buffer, contentType: string, width: number): Promise<Sharp> {
  const type = contentType.toLowerCase();
  if (!canRasterizeLogo(type)) {
    throw new LogoRenditionError('unsupported', `Cannot rasterise ${contentType}`);
  }
  const maxHeight = width * MAX_HEIGHT_TO_WIDTH;
  const box = { width, height: maxHeight, fit: 'inside' as const };

  if (type === 'image/svg+xml') {
    // Stored SVGs were sanitised on the way in; sanitising again is cheap and
    // keeps this path safe for rows written before the current sanitiser.
    let svg: Buffer;
    try {
      svg = sanitizeSvg(data);
    } catch (err) {
      throw new LogoRenditionError('invalid', `Unsanitisable SVG: ${(err as Error).message}`);
    }
    let intrinsic: Metadata;
    try {
      // Reading an SVG's metadata parses it without rasterising, so the pixel
      // cap is lifted here: an SVG may declare a large intrinsic size and
      // still render small. The render below is sized to the target and
      // keeps the cap.
      intrinsic = await sharp(svg, { limitInputPixels: false, failOn: 'error' }).metadata();
    } catch (err) {
      throw new LogoRenditionError('invalid', `Unreadable SVG: ${(err as Error).message}`);
    }
    if (!intrinsic.width || !intrinsic.height) {
      throw new LogoRenditionError('invalid', 'SVG has no intrinsic size');
    }
    const plan = planSvgRender({ width: intrinsic.width, height: intrinsic.height }, width, maxHeight);
    if (plan.kind === 'resize-root') {
      const resized = sanitizeSvgAtSize(data, plan.width, plan.height);
      if (!resized) {
        throw new LogoRenditionError('invalid', 'SVG is too large to render at this width');
      }
      svg = resized;
    }
    const density = plan.kind === 'density' ? plan.density : SVG_BASE_DENSITY;
    return sharp(svg, { density, limitInputPixels: LOGO_INPUT_PIXEL_LIMIT, failOn: 'error' })
      .resize(box);
  }

  try {
    // `pages: 1` takes the first frame of an animated GIF/WebP.
    return sharp(data, { limitInputPixels: LOGO_INPUT_PIXEL_LIMIT, failOn: 'error', pages: 1 })
      .resize({ ...box, withoutEnlargement: true });
  } catch (err) {
    // sharp rejects some input (an empty buffer) as soon as it is constructed.
    throw new LogoRenditionError('invalid', `Unreadable image: ${(err as Error).message}`);
  }
}

/** Rasterise a stored logo to a PNG at one of the allowed widths. */
export async function renderLogoPng(
  data: Buffer,
  contentType: string,
  width: LogoRenditionWidth,
): Promise<Buffer> {
  if (!isLogoRenditionWidth(width)) {
    throw new LogoRenditionError('invalid', `Width ${width} is not an allowed rendition width`);
  }
  const pipeline = await decodeLogo(data, contentType, width);
  try {
    return await pipeline.png().toBuffer();
  } catch (err) {
    if (err instanceof LogoRenditionError) throw err;
    throw new LogoRenditionError('invalid', `Rendering failed: ${(err as Error).message}`);
  }
}

// ── Background classification ───────────────────────────────────────

const CLASSIFY_WIDTH = 256;
/** Pixels at or below this alpha count as fully transparent. */
const TRANSPARENT_ALPHA_MAX = 16;
/** Below this alpha a pixel is anti-aliasing fringe, not ink. */
const INK_ALPHA_MIN = 32;
/**
 * An image with less transparency than this carries its own background
 * (a JPEG, an opaque PNG, an SVG with a full-bleed rect).
 */
const OPAQUE_IMAGE_MAX_TRANSPARENT_FRACTION = 0.01;
/**
 * Relative luminance above which a colour counts as light ink. 0.4 is about
 * CIELAB L* 70: white, light grey and yellow are light; saturated reds,
 * oranges, greens and blues read well on white and are not.
 */
const LIGHT_LUMINANCE_THRESHOLD = 0.4;

const SRGB_TO_LINEAR = Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

function relativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * SRGB_TO_LINEAR[r] + 0.7152 * SRGB_TO_LINEAR[g] + 0.0722 * SRGB_TO_LINEAR[b];
}

/**
 * Classify RGBA pixels. Pure, so it is unit-testable without images.
 *
 * - An opaque image carries its own background, so its border decides: a
 *   light border means it is made for light backgrounds.
 * - Otherwise the ink (the non-transparent pixels, weighted by alpha)
 *   decides: mostly light ink means it is made for dark backgrounds.
 *
 * Returns null when there is no ink to judge.
 */
export function classifyRgbaPixels(
  pixels: Uint8Array | Buffer,
  width: number,
  height: number,
): DerivedLogoBackground | null {
  const total = width * height;
  if (total === 0 || pixels.length < total * 4) return null;

  let transparent = 0;
  for (let i = 3; i < total * 4; i += 4) {
    if (pixels[i] <= TRANSPARENT_ALPHA_MAX) transparent++;
  }

  if (transparent / total < OPAQUE_IMAGE_MAX_TRANSPARENT_FRACTION) {
    // Transparent border pixels (rounded or clipped corners) carry no
    // background colour; their RGB is usually black and would read as dark.
    let borderLuminance = 0;
    let borderCount = 0;
    const addBorder = (x: number, y: number) => {
      const o = (y * width + x) * 4;
      if (pixels[o + 3] <= TRANSPARENT_ALPHA_MAX) return;
      borderLuminance += relativeLuminance(pixels[o], pixels[o + 1], pixels[o + 2]);
      borderCount++;
    };
    for (let x = 0; x < width; x++) {
      addBorder(x, 0);
      if (height > 1) addBorder(x, height - 1);
    }
    for (let y = 1; y < height - 1; y++) {
      addBorder(0, y);
      if (width > 1) addBorder(width - 1, y);
    }
    if (borderCount > 0) {
      return borderLuminance / borderCount > LIGHT_LUMINANCE_THRESHOLD ? 'light-bg' : 'dark-bg';
    }
    // A fully transparent border: judge by the ink instead.
  }

  let inkWeight = 0;
  let lightInkWeight = 0;
  for (let o = 0; o < total * 4; o += 4) {
    const alpha = pixels[o + 3];
    if (alpha < INK_ALPHA_MIN) continue;
    const weight = alpha / 255;
    inkWeight += weight;
    if (relativeLuminance(pixels[o], pixels[o + 1], pixels[o + 2]) > LIGHT_LUMINANCE_THRESHOLD) {
      lightInkWeight += weight;
    }
  }
  if (inkWeight === 0) return null;
  return lightInkWeight / inkWeight > 0.5 ? 'dark-bg' : 'light-bg';
}

/**
 * Derive which background a stored logo is drawn for. Returns null when the
 * logo cannot be rasterised (a LogoRenditionError: unsupported type, bytes
 * that do not decode, over the pixel limit) or has no visible ink. Anything
 * else is unexpected and is rethrown, so a caller can retry it rather than
 * record the logo as unclassifiable.
 */
export async function classifyLogoBackground(
  data: Buffer,
  contentType: string,
): Promise<DerivedLogoBackground | null> {
  try {
    const pipeline = await decodeLogo(data, contentType, CLASSIFY_WIDTH);
    let decoded: { data: Buffer; info: { width: number; height: number; channels: number } };
    try {
      decoded = await pipeline
        .toColourspace('srgb')
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    } catch (err) {
      throw new LogoRenditionError('invalid', `Decoding failed: ${(err as Error).message}`);
    }
    if (decoded.info.channels !== 4) return null;
    return classifyRgbaPixels(decoded.data, decoded.info.width, decoded.info.height);
  } catch (err) {
    if (err instanceof LogoRenditionError) return null;
    throw err;
  }
}
