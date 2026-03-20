/**
 * Perspective Title Card Generator & Compositor
 *
 * Two modes:
 * 1. Typographic fallback — amber gradient + title text (no AI generation needed)
 * 2. AI illustration composite — Gemini illustration + gradient overlay + author portrait + title
 *
 * Cards are 1200x630 (standard OG image size).
 */

// @ts-ignore - sharp default export varies by bundler
import sharp from 'sharp';

interface CardOptions {
  title: string;
  category?: string;
  authorName?: string;
  authorTitle?: string;
}

interface CompositeCardOptions {
  illustrationBuffer: Buffer;
  authorPortraitBuffer?: Buffer;
  title: string;
  category?: string;
  authorName?: string;
  authorTitle?: string;
}

// Amber palette background variations (for typographic fallback)
const BACKGROUNDS = [
  { angle: 135, stops: [{ color: '#92400e', pos: 0 }, { color: '#b45309', pos: 50 }, { color: '#d97706', pos: 100 }] },
  { angle: 90, stops: [{ color: '#78350f', pos: 0 }, { color: '#92400e', pos: 40 }, { color: '#f59e0b', pos: 100 }] },
  { angle: 0, stops: [{ color: '#451a03', pos: 0 }, { color: '#92400e', pos: 60 }, { color: '#b45309', pos: 100 }] },
  { angle: 160, stops: [{ color: '#78350f', pos: 0 }, { color: '#b45309', pos: 70 }, { color: '#fbbf24', pos: 100 }] },
];

function hashString(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash) + s.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function wrapText(text: string, maxCharsPerLine: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    if (currentLine.length + word.length + 1 > maxCharsPerLine) {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = currentLine ? `${currentLine} ${word}` : word;
    }
  }
  if (currentLine) lines.push(currentLine);

  if (lines.length > 4) {
    lines.length = 4;
    lines[3] = lines[3].replace(/\s+\S*$/, '...');
  }

  return lines;
}

/**
 * Build an SVG text overlay for the bottom portion of a card.
 * Used by both the typographic fallback and the AI composite.
 */
function buildTextOverlaySvg(options: {
  title: string;
  category?: string;
  authorName?: string;
  authorTitle?: string;
  hasPortrait?: boolean;
}): string {
  const { title, category, authorName, authorTitle, hasPortrait } = options;

  const titleLines = wrapText(title, 30);
  const titleFontSize = titleLines.length <= 2 ? 48 : 40;
  const titleLineHeight = titleFontSize * 1.25;

  // Position title in lower portion of card
  const titleBaseY = 440;
  const titleStartY = titleBaseY - (titleLines.length - 1) * titleLineHeight;

  // If portrait present, shift title right to make room
  const titleX = hasPortrait ? 180 : 60;

  const titleTexts = titleLines.map((line, i) =>
    `<text x="${titleX}" y="${titleStartY + i * titleLineHeight}" font-family="Georgia, 'Times New Roman', serif" font-size="${titleFontSize}" font-weight="700" fill="white">${escapeXml(line)}</text>`
  ).join('\n    ');

  const categoryY = titleStartY - 30;
  const categoryText = category
    ? `<text x="${titleX}" y="${categoryY}" font-family="system-ui, -apple-system, sans-serif" font-size="14" font-weight="600" fill="white" opacity="0.7" letter-spacing="2.5">${escapeXml(category.toUpperCase())}</text>`
    : '';

  let authorText = '';
  if (authorName) {
    const authorX = hasPortrait ? 180 : 60;
    const authorY = titleStartY + titleLines.length * titleLineHeight + 24;
    authorText = `<text x="${authorX}" y="${authorY}" font-family="system-ui, -apple-system, sans-serif" font-size="16" font-weight="600" fill="white" opacity="0.8">${escapeXml(authorName)}</text>`;
    if (authorTitle) {
      authorText += `\n    <text x="${authorX}" y="${authorY + 22}" font-family="system-ui, -apple-system, sans-serif" font-size="13" fill="white" opacity="0.5">${escapeXml(authorTitle)}</text>`;
    }
  }

  const aaoMark = `<text x="1140" y="40" font-family="system-ui, -apple-system, sans-serif" font-size="12" fill="white" opacity="0.4" text-anchor="end" letter-spacing="1">AGENTICADVERTISING.ORG</text>`;

  return `${aaoMark}
    ${categoryText}
    ${titleTexts}
    ${authorText}`;
}

/**
 * Typographic fallback card — amber gradient + title text.
 * Used when no AI illustration is available.
 */
export async function generatePerspectiveCard(options: CardOptions): Promise<Buffer> {
  const { title, category, authorName, authorTitle } = options;
  const bg = BACKGROUNDS[hashString(title) % BACKGROUNDS.length];

  const rad = (bg.angle * Math.PI) / 180;
  const x1 = Math.round(50 - Math.cos(rad) * 50);
  const y1 = Math.round(50 - Math.sin(rad) * 50);
  const x2 = Math.round(50 + Math.cos(rad) * 50);
  const y2 = Math.round(50 + Math.sin(rad) * 50);

  const titleLines = wrapText(title, 28);
  const titleFontSize = titleLines.length <= 2 ? 56 : 46;
  const titleLineHeight = titleFontSize * 1.2;
  const titleStartY = 240 - ((titleLines.length - 1) * titleLineHeight) / 2;

  const titleTexts = titleLines.map((line, i) =>
    `<text x="80" y="${titleStartY + i * titleLineHeight}" font-family="Georgia, 'Times New Roman', serif" font-size="${titleFontSize}" font-weight="700" fill="white" opacity="0.95">${escapeXml(line)}</text>`
  ).join('\n    ');

  const categoryText = category
    ? `<text x="80" y="${titleStartY - titleLineHeight - 10}" font-family="system-ui, -apple-system, sans-serif" font-size="16" font-weight="600" fill="white" opacity="0.6" letter-spacing="3">${escapeXml(category.toUpperCase())}</text>`
    : '';

  let authorText = '';
  if (authorName) {
    const authorY = 530;
    authorText = `
    <text x="1120" y="${authorY}" font-family="system-ui, -apple-system, sans-serif" font-size="20" font-weight="600" fill="white" opacity="0.85" text-anchor="end">${escapeXml(authorName)}</text>`;
    if (authorTitle) {
      authorText += `
    <text x="1120" y="${authorY + 26}" font-family="system-ui, -apple-system, sans-serif" font-size="15" fill="white" opacity="0.55" text-anchor="end">${escapeXml(authorTitle)}</text>`;
    }
  }

  const aaoMark = `<text x="1120" y="80" font-family="system-ui, -apple-system, sans-serif" font-size="14" fill="white" opacity="0.4" text-anchor="end" letter-spacing="1">AGENTICADVERTISING.ORG</text>`;
  const decoLine = `<rect x="80" y="${titleStartY + titleLines.length * titleLineHeight + 20}" width="80" height="3" rx="1.5" fill="white" opacity="0.3"/>`;

  const svg = `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="${x1}%" y1="${y1}%" x2="${x2}%" y2="${y2}%">
      ${bg.stops.map(s => `<stop offset="${s.pos}%" stop-color="${s.color}"/>`).join('\n      ')}
    </linearGradient>
    <filter id="grain">
      <feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="3" stitchTiles="stitch"/>
      <feColorMatrix type="saturate" values="0"/>
      <feBlend in="SourceGraphic" mode="multiply" result="monoNoise"/>
      <feComponentTransfer>
        <feFuncA type="linear" slope="0.08"/>
      </feComponentTransfer>
      <feBlend in="SourceGraphic" mode="normal"/>
    </filter>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect width="1200" height="630" filter="url(#grain)" opacity="0.5"/>
  ${aaoMark}
  ${categoryText}
  ${titleTexts}
  ${decoLine}
  ${authorText}
</svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * Composite card — AI illustration + optional author portrait with amber ring.
 * No text overlay — the HTML card handles title/category/author display.
 */
export async function compositePerspectiveCard(options: CompositeCardOptions): Promise<Buffer> {
  const { illustrationBuffer, authorPortraitBuffer } = options;

  // Start with the AI illustration, resize to exactly 1200x630
  let base = sharp(illustrationBuffer).resize(1200, 630, { fit: 'cover' });

  const composites: sharp.OverlayOptions[] = [];

  // If author portrait exists, add it with an amber ring at bottom-right
  // 220px portrait on 1200px card = ~18% width, visible at carousel size (~60px)
  if (authorPortraitBuffer) {
    const portraitSize = 220;
    const ringWidth = 8;
    const ringSize = portraitSize + ringWidth * 2;

    // Create circular portrait with amber ring
    const ringSvg = `<svg width="${ringSize}" height="${ringSize}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="${ringSize / 2}" cy="${ringSize / 2}" r="${ringSize / 2}" fill="#d97706"/>
      <circle cx="${ringSize / 2}" cy="${ringSize / 2}" r="${portraitSize / 2}" fill="black"/>
    </svg>`;

    const circularPortrait = await sharp(authorPortraitBuffer)
      .resize(portraitSize, portraitSize, { fit: 'cover' })
      .composite([{
        input: Buffer.from(`<svg width="${portraitSize}" height="${portraitSize}"><circle cx="${portraitSize / 2}" cy="${portraitSize / 2}" r="${portraitSize / 2}" fill="white"/></svg>`),
        blend: 'dest-in',
      }])
      .png()
      .toBuffer();

    const ringBuffer = await sharp(Buffer.from(ringSvg))
      .composite([{ input: circularPortrait, top: ringWidth, left: ringWidth }])
      .png()
      .toBuffer();

    composites.push({
      input: ringBuffer,
      top: 630 - ringSize - 40,
      left: 1200 - ringSize - 40,
    });
  }

  if (composites.length > 0) {
    return base.composite(composites).png().toBuffer();
  }

  return base.png().toBuffer();
}
