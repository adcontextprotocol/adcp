import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import {
  canRasterizeLogo,
  classifyLogoBackground,
  classifyRgbaPixels,
  LogoRenditionError,
  parseLogoRenditionQuery,
  renderLogoPng,
  type LogoRenditionWidth,
} from '../../src/services/logo-rendition.js';

const FIXTURES = path.join(__dirname, '../fixtures/brand-logos');
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name));

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function svg(width: number, height: number, body: string, viewBox = `0 0 ${width} ${height}`): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${viewBox}">${body}</svg>`,
  );
}

async function solidPng(
  w: number,
  h: number,
  background: { r: number; g: number; b: number; alpha: number },
  overlay?: { r: number; g: number; b: number },
): Promise<Buffer> {
  let img = sharp({ create: { width: w, height: h, channels: 4, background } });
  if (overlay) {
    const block = await sharp({
      create: { width: Math.floor(w / 2), height: Math.floor(h / 2), channels: 3, background: overlay },
    }).png().toBuffer();
    img = img.composite([{ input: block, left: Math.floor(w / 4), top: Math.floor(h / 4) }]);
  }
  return img.png().toBuffer();
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    let c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A tiny valid PNG whose IHDR claims 60000x60000 pixels. */
async function pixelBombPng(): Promise<Buffer> {
  const bomb = Buffer.from(await solidPng(2, 2, { r: 0, g: 0, b: 0, alpha: 1 }));
  // IHDR data starts at offset 16; patch width/height and fix the chunk CRC.
  bomb.writeUInt32BE(60000, 16);
  bomb.writeUInt32BE(60000, 20);
  bomb.writeUInt32BE(crc32(bomb.subarray(12, 29)), 29);
  return bomb;
}

const CLEAR = { r: 0, g: 0, b: 0, alpha: 0 };

// ── Query parsing ───────────────────────────────────────────────────

describe('parseLogoRenditionQuery', () => {
  it('returns no rendition when neither format nor w is present', () => {
    expect(parseLogoRenditionQuery({})).toEqual({ ok: true, rendition: null });
  });

  it('defaults to 512 for format=png alone', () => {
    expect(parseLogoRenditionQuery({ format: 'png' })).toEqual({
      ok: true,
      rendition: { format: 'png', width: 512 },
    });
  });

  it.each([64, 128, 256, 512, 1024])('accepts w=%i', (w) => {
    expect(parseLogoRenditionQuery({ format: 'png', w: String(w) })).toEqual({
      ok: true,
      rendition: { format: 'png', width: w },
    });
  });

  it.each([
    ['w without format', { w: '256' }],
    ['unknown format', { format: 'webp' }],
    ['uppercase format', { format: 'PNG' }],
    ['repeated format', { format: ['png', 'png'] }],
    ['unallowed width', { format: 'png', w: '100' }],
    ['zero width', { format: 'png', w: '0' }],
    ['negative width', { format: 'png', w: '-64' }],
    ['non-numeric width', { format: 'png', w: 'abc' }],
    ['decimal width', { format: 'png', w: '64.0' }],
    ['hex width', { format: 'png', w: '0x40' }],
    ['padded width', { format: 'png', w: ' 64' }],
    ['repeated w', { format: 'png', w: ['1', '2'] }],
    ['empty w', { format: 'png', w: '' }],
    ['nested object w', { format: 'png', w: { a: '64' } }],
  ])('rejects %s', (_label, query) => {
    expect(parseLogoRenditionQuery(query as Record<string, unknown>).ok).toBe(false);
  });
});

describe('canRasterizeLogo', () => {
  it.each(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml', 'IMAGE/PNG'])(
    'accepts %s',
    (ct) => expect(canRasterizeLogo(ct)).toBe(true),
  );
  it.each(['image/x-icon', 'image/vnd.microsoft.icon', 'text/html', ''])('rejects %s', (ct) =>
    expect(canRasterizeLogo(ct)).toBe(false),
  );
});

// ── Rendition ───────────────────────────────────────────────────────

describe('renderLogoPng', () => {
  it('emits a PNG with the exact requested width for an SVG', async () => {
    const data = svg(300, 100, '<rect width="300" height="100" fill="#e61d2b"/>');
    for (const w of [64, 128, 256, 512, 1024] as LogoRenditionWidth[]) {
      const png = await renderLogoPng(data, 'image/svg+xml', w);
      expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
      const meta = await sharp(png).metadata();
      expect(meta.format).toBe('png');
      expect(meta.width).toBe(w);
      expect(meta.height).toBe(Math.round((w * 100) / 300));
    }
  });

  it('renders the production Coca-Cola SVG at the exact width', async () => {
    const png = await renderLogoPng(fixture('coca-cola-a9bec631-red-ink.svg'), 'image/svg+xml', 256);
    expect((await sharp(png).metadata()).width).toBe(256);
  });

  it('keeps a small SVG sharp by scaling it up to the target width', async () => {
    const data = svg(10, 10, '<circle cx="5" cy="5" r="5" fill="#000"/>');
    const meta = await sharp(await renderLogoPng(data, 'image/svg+xml', 512)).metadata();
    expect(meta.width).toBe(512);
    expect(meta.height).toBe(512);
  });

  it('does not enlarge a raster smaller than the requested width', async () => {
    const png = await solidPng(40, 20, { r: 200, g: 0, b: 0, alpha: 1 });
    const meta = await sharp(await renderLogoPng(png, 'image/png', 256)).metadata();
    expect(meta.width).toBe(40);
    expect(meta.height).toBe(20);
  });

  it('shrinks a larger raster to the requested width', async () => {
    const png = await solidPng(400, 200, { r: 200, g: 0, b: 0, alpha: 1 });
    const meta = await sharp(await renderLogoPng(png, 'image/png', 128)).metadata();
    expect(meta.width).toBe(128);
    expect(meta.height).toBe(64);
  });

  it('renders JPEG input', async () => {
    const jpeg = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#336699' } })
      .jpeg()
      .toBuffer();
    const png = await renderLogoPng(jpeg, 'image/jpeg', 64);
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect((await sharp(png).metadata()).width).toBe(64);
  });

  it('caps the height of a very tall SVG at 4x the width', async () => {
    const data = svg(10, 1000, '<rect width="10" height="1000" fill="#000"/>');
    const meta = await sharp(await renderLogoPng(data, 'image/svg+xml', 64)).metadata();
    expect(meta.height).toBe(256);
    expect(meta.width).toBeLessThanOrEqual(64);
  });

  it('caps the height of a very tall raster at 4x the width', async () => {
    const png = await solidPng(20, 1000, { r: 0, g: 0, b: 0, alpha: 1 });
    const meta = await sharp(await renderLogoPng(png, 'image/png', 64)).metadata();
    expect(meta.height).toBeLessThanOrEqual(256);
  });

  it('rejects a width outside the allowed set', async () => {
    const data = svg(10, 10, '<rect width="10" height="10"/>');
    await expect(renderLogoPng(data, 'image/svg+xml', 100 as LogoRenditionWidth)).rejects.toMatchObject({
      name: 'LogoRenditionError',
      reason: 'invalid',
    });
  });

  it('throws unsupported for image/x-icon', async () => {
    const err = await renderLogoPng(Buffer.from('ico'), 'image/x-icon', 64).catch((e) => e);
    expect(err).toBeInstanceOf(LogoRenditionError);
    expect(err.reason).toBe('unsupported');
  });

  it('rejects a pixel-bomb PNG header with huge claimed dimensions', async () => {
    const err = await renderLogoPng(await pixelBombPng(), 'image/png', 64).catch((e) => e);
    expect(err).toBeInstanceOf(LogoRenditionError);
    expect(err.reason).toBe('invalid');
  });

  it('renders an SVG that declares a large intrinsic size at the target width', async () => {
    const data = svg(80000, 40000, '<rect width="800" height="400"/>', '0 0 800 400');
    const meta = await sharp(await renderLogoPng(data, 'image/svg+xml', 512)).metadata();
    expect(meta.width).toBe(512);
    expect(meta.height).toBe(256);
  });

  it('rejects an SVG too large to render under the pixel limit even at minimum density', async () => {
    const data = svg(10_000_000, 10_000_000, '<rect width="10" height="10"/>', '0 0 10 10');
    await expect(renderLogoPng(data, 'image/svg+xml', 64)).rejects.toBeInstanceOf(LogoRenditionError);
  });

  it('throws invalid for garbage bytes labelled as PNG', async () => {
    await expect(renderLogoPng(Buffer.from('not a png'), 'image/png', 64)).rejects.toMatchObject({
      reason: 'invalid',
    });
  });

  it('renders an SVG with <image href="http://…"> without any network access', async () => {
    const data = svg(
      100,
      100,
      '<rect width="100" height="100" fill="#fff"/><image href="http://127.0.0.1:1/x.png" width="100" height="100"/>',
    );
    const png = await renderLogoPng(data, 'image/svg+xml', 64);
    expect((await sharp(png).metadata()).width).toBe(64);
  });

  it('renders an SVG with <use> and an external reference without network access', async () => {
    const data = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="100" height="100">' +
        '<defs><rect id="r" width="50" height="50" fill="#000"/></defs>' +
        '<use xlink:href="#r"/><use href="http://127.0.0.1:1/evil.svg#a"/></svg>',
    );
    const png = await renderLogoPng(data, 'image/svg+xml', 64);
    expect((await sharp(png).metadata()).width).toBe(64);
  });

  it('renders an SVG containing a <script>', async () => {
    const data = svg(100, 100, '<script>throw new Error("x")</script><rect width="100" height="100" fill="#000"/>');
    const png = await renderLogoPng(data, 'image/svg+xml', 64);
    expect((await sharp(png).metadata()).width).toBe(64);
  });

  describe('a paint server in a nested data: SVG', () => {
    // The nested document is never sanitised and can carry an <image> whose
    // bytes would be decoded outside the pixel limit. Small and blue here.
    async function nestedImageReference(): Promise<string> {
      const blue = await solidPng(8, 8, { r: 0, g: 0, b: 255, alpha: 1 });
      const inner =
        '<svg xmlns="http://www.w3.org/2000/svg"><pattern id="p" patternUnits="userSpaceOnUse" width="8" height="8">' +
        `<image width="8" height="8" href="data:image/png;base64,${blue.toString('base64')}"/></pattern></svg>`;
      return `data:image/svg+xml;base64,${Buffer.from(inner).toString('base64')}#p`;
    }

    async function expectNothingDrawn(png: Buffer) {
      const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      expect(info.width).toBe(64);
      for (let o = 3; o < data.length; o += 4) expect(data[o]).toBe(0);
    }

    it('is not loaded from a fill attribute', async () => {
      const ref = await nestedImageReference();
      const png = await renderLogoPng(svg(16, 16, `<rect width="16" height="16" fill="url(${ref})"/>`), 'image/svg+xml', 64);
      await expectNothingDrawn(png);
    });

    it('is not loaded from a <style> rule', async () => {
      const ref = await nestedImageReference();
      const png = await renderLogoPng(
        svg(16, 16, `<style>.x{fill:url(${ref})}</style><rect class="x" width="16" height="16"/>`),
        'image/svg+xml',
        64,
      );
      await expectNothingDrawn(png);
    });
  });
});

// ── Classification ──────────────────────────────────────────────────

describe('classifyLogoBackground: production regression fixtures', () => {
  it('Coca-Cola white-ink logo is drawn for dark backgrounds', async () => {
    expect(await classifyLogoBackground(fixture('coca-cola-636eabf2-white-ink.svg'), 'image/svg+xml')).toBe(
      'dark-bg',
    );
  });

  it('Coca-Cola red-ink logo is drawn for light backgrounds', async () => {
    expect(await classifyLogoBackground(fixture('coca-cola-a9bec631-red-ink.svg'), 'image/svg+xml')).toBe(
      'light-bg',
    );
  });
});

describe('classifyLogoBackground: synthetic inputs', () => {
  const rect = (fill: string) => `<rect x="10" y="10" width="80" height="30" fill="${fill}"/>`;

  it('black SVG ink → light-bg', async () => {
    expect(await classifyLogoBackground(svg(100, 50, rect('#000')), 'image/svg+xml')).toBe('light-bg');
  });

  it('white SVG ink → dark-bg', async () => {
    expect(await classifyLogoBackground(svg(100, 50, rect('#fff')), 'image/svg+xml')).toBe('dark-bg');
  });

  it('yellow SVG ink → dark-bg', async () => {
    expect(await classifyLogoBackground(svg(100, 50, rect('#ffe000')), 'image/svg+xml')).toBe('dark-bg');
  });

  it('saturated red SVG ink → light-bg', async () => {
    expect(await classifyLogoBackground(svg(100, 50, rect('#e61d2b')), 'image/svg+xml')).toBe('light-bg');
  });

  it('transparent PNG with black ink → light-bg', async () => {
    expect(await classifyLogoBackground(await solidPng(100, 100, CLEAR, { r: 0, g: 0, b: 0 }), 'image/png')).toBe('light-bg');
  });

  it('transparent PNG with white ink → dark-bg', async () => {
    expect(await classifyLogoBackground(await solidPng(100, 100, CLEAR, { r: 255, g: 255, b: 255 }), 'image/png')).toBe('dark-bg');
  });

  it('opaque white PNG with black ink → light-bg (border rule)', async () => {
    const png = await solidPng(100, 100, { r: 255, g: 255, b: 255, alpha: 1 }, { r: 0, g: 0, b: 0 });
    expect(await classifyLogoBackground(png, 'image/png')).toBe('light-bg');
  });

  it('opaque white JPEG with black ink → light-bg (border rule)', async () => {
    const png = await solidPng(100, 100, { r: 255, g: 255, b: 255, alpha: 1 }, { r: 0, g: 0, b: 0 });
    const jpeg = await sharp(png).flatten({ background: '#fff' }).jpeg({ quality: 95 }).toBuffer();
    expect(await classifyLogoBackground(jpeg, 'image/jpeg')).toBe('light-bg');
  });

  it('opaque black PNG with white ink → dark-bg (border rule)', async () => {
    const png = await solidPng(100, 100, { r: 0, g: 0, b: 0, alpha: 1 }, { r: 255, g: 255, b: 255 });
    expect(await classifyLogoBackground(png, 'image/png')).toBe('dark-bg');
  });

  it('opaque black background → dark-bg', async () => {
    const png = await solidPng(100, 100, { r: 0, g: 0, b: 0, alpha: 1 });
    expect(await classifyLogoBackground(png, 'image/png')).toBe('dark-bg');
  });

  it('fully transparent PNG → null', async () => {
    expect(await classifyLogoBackground(await solidPng(50, 50, CLEAR), 'image/png')).toBeNull();
  });

  it('empty SVG → null', async () => {
    expect(await classifyLogoBackground(svg(50, 50, ''), 'image/svg+xml')).toBeNull();
  });

  it('ICO bytes → null', async () => {
    const ico = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0]);
    expect(await classifyLogoBackground(ico, 'image/x-icon')).toBeNull();
  });

  it('garbage bytes → null without throwing', async () => {
    expect(await classifyLogoBackground(Buffer.from('definitely not an image'), 'image/png')).toBeNull();
    expect(await classifyLogoBackground(Buffer.from('<svg'), 'image/svg+xml')).toBeNull();
    expect(await classifyLogoBackground(Buffer.alloc(0), 'image/png')).toBeNull();
  });

  it('SVG with a <script> still classifies from its visible ink', async () => {
    const data = svg(100, 50, `<script>fetch("http://127.0.0.1:1/")</script>${rect('#000')}`);
    expect(await classifyLogoBackground(data, 'image/svg+xml')).toBe('light-bg');
  });

  it('SVG with an external href image still classifies from its local ink', async () => {
    const data = svg(100, 50, `<image href="http://127.0.0.1:1/x.png" width="100" height="50"/>${rect('#fff')}`);
    expect(await classifyLogoBackground(data, 'image/svg+xml')).toBe('dark-bg');
  });

  it('SVG with an external href in <use> classifies without network access', async () => {
    const data = svg(100, 50, `<use href="http://127.0.0.1:1/evil.svg#a"/>${rect('#000')}`);
    expect(await classifyLogoBackground(data, 'image/svg+xml')).toBe('light-bg');
  });

  it('pixel-bomb PNG → null without throwing', async () => {
    expect(await classifyLogoBackground(await pixelBombPng(), 'image/png')).toBeNull();
  });
});

describe('classifyRgbaPixels', () => {
  const px = (w: number, h: number, fn: (x: number, y: number) => [number, number, number, number]) => {
    const b = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) b.set(fn(x, y), (y * w + x) * 4);
    return b;
  };

  it('returns null for zero-sized or short buffers', () => {
    expect(classifyRgbaPixels(Buffer.alloc(0), 0, 0)).toBeNull();
    expect(classifyRgbaPixels(Buffer.alloc(4), 2, 2)).toBeNull();
  });

  it('ignores faint anti-aliasing fringe when judging ink', () => {
    const p = px(10, 10, (x, y) => {
      if (x < 2 && y < 2) return [0, 0, 0, 255];
      if (x > 6) return [255, 255, 255, 20];
      return [0, 0, 0, 0];
    });
    expect(classifyRgbaPixels(p, 10, 10)).toBe('light-bg');
  });

  it('weights ink by alpha', () => {
    // 10 white pixels at half alpha (weight ~5) vs 8 opaque black (weight 8).
    const p = px(6, 6, (x, y) => {
      const i = y * 6 + x;
      if (i < 10) return [255, 255, 255, 128];
      if (i < 18) return [0, 0, 0, 255];
      return [0, 0, 0, 0];
    });
    expect(classifyRgbaPixels(p, 6, 6)).toBe('light-bg');
  });

  it('uses the border, not the ink, for an opaque image', () => {
    const p = px(10, 10, (x, y) => (x > 2 && x < 7 && y > 2 && y < 7 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    expect(classifyRgbaPixels(p, 10, 10)).toBe('dark-bg');
  });

  it('handles 1x1 images', () => {
    expect(classifyRgbaPixels(Buffer.from([255, 255, 255, 255]), 1, 1)).toBe('light-bg');
    expect(classifyRgbaPixels(Buffer.from([0, 0, 0, 255]), 1, 1)).toBe('dark-bg');
  });
});
