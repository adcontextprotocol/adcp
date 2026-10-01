import { describe, it, expect, vi, beforeEach } from 'vitest';
import sharp from 'sharp';
import * as zlib from 'zlib';

const mocks = vi.hoisted(() => ({ parse: vi.fn() }));

vi.mock('@anthropic-ai/sdk', () => {
  class Anthropic {
    messages = { parse: mocks.parse };
  }
  return { default: Anthropic };
});

import {
  BrandBookImportError,
  detectDocumentType,
  extractPptx,
  parsePptxTheme,
  prepareCandidates,
  proposeBrandFields,
  sourceFromUpload,
  toBrandFragment,
  type BrandBookProposal,
  type CandidateImage,
} from '../../src/services/brand-book-import.js';

/** Minimal stored ZIP, enough for yauzl to read a fake .pptx. */
function zip(files: Record<string, string | Buffer>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const nameBuf = Buffer.from(name);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuf, end]);
}

const THEME_XML = `<a:theme><a:themeElements><a:clrScheme name="Acme">
  <a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
  <a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
  <a:accent1><a:srgbClr val="1a4d8f"/></a:accent1>
  <a:accent2><a:srgbClr val="F2A900"/></a:accent2>
</a:clrScheme><a:fontScheme name="Acme">
  <a:majorFont><a:latin typeface="Montserrat"/></a:majorFont>
  <a:minorFont><a:latin typeface="Source Sans &amp; Co"/></a:minorFont>
</a:fontScheme></a:themeElements></a:theme>`;

async function png(width: number, height: number, color = { r: 26, g: 77, b: 143 }): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
}

function proposal(overrides: Partial<BrandBookProposal> = {}): BrandBookProposal {
  return {
    brand_name: 'Acme',
    description: 'Acme makes anvils.',
    tagline: null,
    industries: ['manufacturing', 'manufacturing', ' '],
    tone: { voice: 'Plainspoken', attributes: ['direct'], dos: [], donts: ['jargon'] },
    colors: { primary: '1a4d8f', secondary: '#FA0', accent: 'PMS 286', background: null, text: '#111111' },
    fonts: { primary: 'Montserrat', secondary: null },
    logos: [
      { candidate_id: 'c1', variant: 'primary', background: 'light-bg', orientation: 'horizontal', usage: 'Default' },
      { candidate_id: 'c9', variant: 'icon', background: 'dark-bg', orientation: 'square', usage: null },
      { candidate_id: 'c1', variant: 'wordmark', background: 'light-bg', orientation: 'horizontal', usage: null },
    ],
    restrictions: ['Never stretch the logo'],
    logo_placement: { min_clear_space: '1x', min_height: null },
    evidence: [{ field: 'colors.primary', page: 4 }],
    warnings: ['Accent color given only as Pantone.'],
    ...overrides,
  };
}

describe('input detection', () => {
  it('recognizes PDFs and PPTX containers and rejects everything else', () => {
    expect(detectDocumentType(Buffer.from('%PDF-1.7\n...'))).toBe('pdf');
    expect(detectDocumentType(zip({ 'ppt/presentation.xml': '<p/>' }))).toBe('pptx');
    expect(detectDocumentType(zip({ 'word/document.xml': '<w/>' }))).toBeNull();
    expect(detectDocumentType(Buffer.from('<html>'))).toBeNull();
  });

  it('rejects unsupported uploads with a user-facing error', () => {
    expect(() => sourceFromUpload(Buffer.from('hello'))).toThrow(BrandBookImportError);
  });
});

describe('PPTX extraction', () => {
  it('reads theme colors and fonts', () => {
    expect(parsePptxTheme(THEME_XML)).toEqual({
      colors: { dk1: '#000000', lt1: '#FFFFFF', accent1: '#1A4D8F', accent2: '#F2A900' },
      majorFont: 'Montserrat',
      minorFont: 'Source Sans & Co',
    });
  });

  it('reads slide text in order, the theme, and media images', async () => {
    const image = await png(200, 80);
    const pptx = zip({
      'ppt/presentation.xml': '<p/>',
      'ppt/slides/slide2.xml': '<a:t>Tone: plainspoken</a:t>',
      'ppt/slides/slide1.xml': '<a:t>Acme brand guide</a:t><a:t>&amp; more</a:t>',
      'ppt/theme/theme1.xml': THEME_XML,
      'ppt/media/image1.png': image,
    });
    const result = await extractPptx(pptx);
    expect(result.slideText).toBe('[Slide 1] Acme brand guide & more\n[Slide 2] Tone: plainspoken');
    expect(result.theme.colors.accent1).toBe('#1A4D8F');
    expect(result.images).toHaveLength(1);
  });
});

describe('prepareCandidates', () => {
  it('decodes a bounded number of raw images however many a file carries', async () => {
    const image = await png(60, 60);
    const raw = Array.from({ length: 200 }, (_, i) => ({ data: image, page: i + 1 }));
    const started = Date.now();
    const candidates = await prepareCandidates(raw);
    expect(candidates.length).toBeLessThanOrEqual(16);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('drops tiny images, de-duplicates, and assigns stable ids', async () => {
    const logo = await png(400, 120);
    const candidates = await prepareCandidates([
      { data: await png(20, 20), page: 1 },
      { data: logo, page: 2 },
      { data: logo, page: 3 },
      { data: await png(1200, 1200, { r: 255, g: 255, b: 255 }), page: 2 },
    ]);
    expect(candidates.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(Math.max(candidates[0].width, candidates[0].height)).toBeLessThanOrEqual(512);
  });
});

describe('toBrandFragment', () => {
  const candidates: CandidateImage[] = [{ id: 'c1', png: Buffer.alloc(0), width: 400, height: 120, page: 2 }];

  it('maps a proposal to brand.json fields and normalizes values', () => {
    const { fragment, logos, warnings } = toBrandFragment(proposal(), candidates, 'acme.example');
    expect(fragment).toMatchObject({
      names: [{ en: 'Acme' }],
      description: 'Acme makes anvils.',
      industries: ['manufacturing'],
      tone: { voice: 'Plainspoken', attributes: ['direct'], donts: ['jargon'] },
      colors: { primary: '#1A4D8F', secondary: '#FFAA00', text: '#111111' },
      fonts: { primary: 'Montserrat' },
      visual_guidelines: { restrictions: ['Never stretch the logo'], logo_placement: { min_clear_space: '1x' } },
    });
    expect(fragment).not.toHaveProperty('tagline');
    expect(warnings).toContain('Dropped accent color "PMS 286": not a #RRGGBB hex value.');
    expect(warnings).toContain('Accent color given only as Pantone.');
    expect(logos).toEqual([{
      id: 'primary_1',
      candidate_id: 'c1',
      url: 'https://acme.example/brand-assets/primary_1.png',
      variant: 'primary',
      background: 'light-bg',
      orientation: 'horizontal',
      usage: 'Default',
    }]);
    expect((fragment.logos as unknown[])[0]).not.toHaveProperty('candidate_id');
  });

  it('never references a candidate id the server did not extract', () => {
    const { logos } = toBrandFragment(proposal(), [], 'acme.example');
    expect(logos).toEqual([]);
  });
});

describe('proposeBrandFields', () => {
  beforeEach(() => {
    mocks.parse.mockReset();
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  it('sends the PDF and labeled candidates with structured output and low effort', async () => {
    mocks.parse.mockResolvedValue({
      stop_reason: 'end_turn',
      parsed_output: proposal(),
      usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: null, cache_read_input_tokens: null },
    });
    const result = await proposeBrandFields({
      source: { type: 'pdf', buffer: Buffer.from('%PDF-1.7') },
      candidates: [{ id: 'c1', png: Buffer.from('img'), width: 400, height: 120, page: 2 }],
      domain: 'acme.example',
    });

    const request = mocks.parse.mock.calls[0][0];
    expect(mocks.parse.mock.calls[0][1]).toEqual({ timeout: 90_000, maxRetries: 1 });
    expect(request.model).toBe('claude-sonnet-5-5');
    expect(request.output_config.effort).toBe('low');
    expect(request.output_config.format).toBeDefined();
    expect(request).not.toHaveProperty('tool_choice');
    const content = request.messages[0].content;
    expect(content[0]).toMatchObject({ type: 'document', source: { media_type: 'application/pdf' } });
    expect(content[1]).toMatchObject({ type: 'text', text: 'Candidate image c1 (page 2), 400x120:' });
    expect(content[2]).toMatchObject({ type: 'image', source: { media_type: 'image/png' } });
    expect(request.system).toContain('untrusted data');
    expect(result.usage).toEqual({ input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: undefined, cache_read_input_tokens: undefined });
  });

  it('turns a refusal into a 422 without exposing details', async () => {
    mocks.parse.mockResolvedValue({ stop_reason: 'refusal', parsed_output: null, usage: { input_tokens: 1, output_tokens: 0 } });
    await expect(proposeBrandFields({
      source: { type: 'html', text: 'x'.repeat(300), url: 'https://acme.example/brand' },
      candidates: [],
      domain: 'acme.example',
    })).rejects.toMatchObject({ status: 422 });
  });
});
