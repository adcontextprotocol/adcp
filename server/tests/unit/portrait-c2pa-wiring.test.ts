import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { Buffer } from 'buffer';
import sharp from 'sharp';
import { Reader } from '@contentauth/c2pa-node';
import { finalizePortrait, compositeAIBadge } from '../../src/services/portrait-generator.js';
import { resetC2PASignerCache } from '../../src/services/c2pa.js';
import * as errorNotifier from '../../src/addie/error-notifier.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'c2pa');
const CERT_PATH = join(FIXTURE_DIR, 'aao-c2pa.cert.pem');
const KEY_PATH = join(FIXTURE_DIR, 'aao-c2pa.key.pem');

let testPng: Buffer;
let CERT_B64: string;
let KEY_B64: string;

beforeAll(async () => {
  if (existsSync(CERT_PATH)) rmSync(CERT_PATH);
  if (existsSync(KEY_PATH)) rmSync(KEY_PATH);
  execFileSync('bash', [join(__dirname, '..', '..', '..', 'scripts', 'generate-c2pa-cert.sh'), FIXTURE_DIR], {
    stdio: 'pipe',
  });
  CERT_B64 = readFileSync(CERT_PATH).toString('base64');
  KEY_B64 = readFileSync(KEY_PATH).toString('base64');

  // Portrait-sized: 512x512 amber square — matches the real avatar dimensions
  // closely enough that the badge sizing logic exercises real values.
  testPng = await sharp({
    create: { width: 512, height: 512, channels: 4, background: { r: 212, g: 160, b: 23, alpha: 1 } },
  })
    .png()
    .toBuffer();
});

const originalEnv = {
  enabled: process.env.C2PA_SIGNING_ENABLED,
  cert: process.env.C2PA_CERT_PEM_B64,
  key: process.env.C2PA_PRIVATE_KEY_PEM_B64,
  strict: process.env.C2PA_STRICT,
};

beforeEach(() => {
  resetC2PASignerCache();
  vi.spyOn(errorNotifier, 'notifySystemError').mockImplementation(() => undefined);
});

afterEach(() => {
  process.env.C2PA_SIGNING_ENABLED = originalEnv.enabled;
  process.env.C2PA_CERT_PEM_B64 = originalEnv.cert;
  process.env.C2PA_PRIVATE_KEY_PEM_B64 = originalEnv.key;
  process.env.C2PA_STRICT = originalEnv.strict;
  resetC2PASignerCache();
  vi.restoreAllMocks();
});

describe('compositeAIBadge', () => {
  it('adds visible badge pixels in the bottom-right corner', async () => {
    const badged = await compositeAIBadge(testPng);
    expect(badged.length).toBeGreaterThan(0);

    // Badge is ~10% of the short edge with ~2.5% margin, so for a 512px
    // portrait it sits around (440–500, 440–500). Sample the center of that
    // range and compare to a pixel in the clean top-left region — the badge
    // pixel should differ.
    const raw = await sharp(badged).raw().toBuffer({ resolveWithObject: true });
    const { data, info } = raw;
    const topLeftIdx = 0;
    const badgeCenterY = info.height - Math.round(info.height * 0.075);
    const badgeCenterX = info.width - Math.round(info.width * 0.075);
    const badgeIdx = (badgeCenterY * info.width + badgeCenterX) * info.channels;
    const topLeftPixel = [data[topLeftIdx], data[topLeftIdx + 1], data[topLeftIdx + 2]];
    const badgePixel = [data[badgeIdx], data[badgeIdx + 1], data[badgeIdx + 2]];
    expect(topLeftPixel).not.toEqual(badgePixel);
  });

  it('preserves the original image dimensions', async () => {
    const badged = await compositeAIBadge(testPng);
    const meta = await sharp(badged).metadata();
    expect(meta.width).toBe(512);
    expect(meta.height).toBe(512);
  });
});

describe('finalizePortrait', () => {
  it('badges but does not sign when the feature flag is off', async () => {
    delete process.env.C2PA_SIGNING_ENABLED;
    const result = await finalizePortrait(testPng, {
      vibe: 'at-my-desk',
      palette: 'amber',
      promptUsed: 'a test prompt',
    });
    expect(result.c2pa).toBeUndefined();
    expect(result.imageBuffer.length).toBeGreaterThan(0);
    // Different from raw — badge was applied.
    expect(result.imageBuffer).not.toEqual(testPng);
  });

  it('badges and signs when flag + secrets are present', async () => {
    process.env.C2PA_SIGNING_ENABLED = 'true';
    process.env.C2PA_CERT_PEM_B64 = CERT_B64;
    process.env.C2PA_PRIVATE_KEY_PEM_B64 = KEY_B64;

    const result = await finalizePortrait(testPng, {
      vibe: 'at-my-desk',
      palette: 'amber',
      promptUsed: 'a test prompt with secret content',
    });

    expect(result.c2pa).toBeDefined();
    expect(result.c2pa?.manifestDigest).toMatch(/^[a-f0-9]{64}$/);

    const reader = await Reader.fromAsset({ buffer: result.imageBuffer, mimeType: 'image/png' });
    const active = reader.getActive();
    expect(active?.title).toBe('AAO Member Portrait');

    const custom = active?.assertions?.find(
      (a) => a.label === 'org.agenticadvertising.generation',
    );
    expect(custom).toBeDefined();

    // Prompt was hashed, not embedded.
    const serialized = JSON.stringify(reader.json());
    expect(serialized).not.toContain('secret content');
    expect(serialized).toContain('prompt_sha256');
  });

  it('returns the badged-but-unsigned buffer when signing throws (default)', async () => {
    process.env.C2PA_SIGNING_ENABLED = 'true';
    process.env.C2PA_CERT_PEM_B64 = CERT_B64;
    process.env.C2PA_PRIVATE_KEY_PEM_B64 = KEY_B64;
    delete process.env.C2PA_STRICT;

    // Pre-badging the "not a PNG" buffer would throw in sharp. Instead,
    // bypass the sharp step by constructing a PNG that sharp accepts but
    // c2pa-node will reject — a corrupted PNG payload. Easier route: run
    // the real path but spy out signC2PA to throw.
    const c2pa = await import('../../src/services/c2pa.js');
    vi.spyOn(c2pa, 'signC2PA').mockImplementation(() => {
      throw new Error('simulated sign failure');
    });

    const result = await finalizePortrait(testPng, {
      vibe: 'at-my-desk',
      palette: 'amber',
      promptUsed: 'prompt',
    });
    expect(result.c2pa).toBeUndefined();
    expect(result.imageBuffer.length).toBeGreaterThan(0);
    expect(errorNotifier.notifySystemError).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'c2pa-portrait-signing' }),
    );
  });

  it('rethrows when C2PA_STRICT=true', async () => {
    process.env.C2PA_SIGNING_ENABLED = 'true';
    process.env.C2PA_CERT_PEM_B64 = CERT_B64;
    process.env.C2PA_PRIVATE_KEY_PEM_B64 = KEY_B64;
    process.env.C2PA_STRICT = 'true';

    const c2pa = await import('../../src/services/c2pa.js');
    vi.spyOn(c2pa, 'signC2PA').mockImplementation(() => {
      throw new Error('simulated sign failure');
    });

    await expect(
      finalizePortrait(testPng, { vibe: 'at-my-desk', palette: 'amber', promptUsed: 'p' }),
    ).rejects.toThrow(/simulated sign failure/);
    expect(errorNotifier.notifySystemError).toHaveBeenCalledTimes(1);
  });
});
