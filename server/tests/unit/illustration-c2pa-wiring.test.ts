import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { Buffer } from 'buffer';
import sharp from 'sharp';
import { Reader } from '@contentauth/c2pa-node';
import { attachC2PAIfEnabled } from '../../src/services/illustration-generator.js';
import { resetC2PASignerCache } from '../../src/services/c2pa.js';
import * as c2pa from '../../src/services/c2pa.js';
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

  testPng = await sharp({
    create: { width: 64, height: 64, channels: 4, background: { r: 212, g: 160, b: 23, alpha: 1 } },
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

describe('attachC2PAIfEnabled', () => {
  it('returns the input unchanged when signing is disabled', async () => {
    delete process.env.C2PA_SIGNING_ENABLED;
    const input = { imageBuffer: testPng, promptUsed: 'test prompt' };
    const result = await attachC2PAIfEnabled(input, { title: 'Test hero' });
    expect(result.imageBuffer).toBe(testPng);
    expect(result.c2pa).toBeUndefined();
  });

  it('signs the buffer and populates c2pa metadata when enabled', async () => {
    process.env.C2PA_SIGNING_ENABLED = 'true';
    process.env.C2PA_CERT_PEM_B64 = CERT_B64;
    process.env.C2PA_PRIVATE_KEY_PEM_B64 = KEY_B64;

    const result = await attachC2PAIfEnabled(
      { imageBuffer: testPng, promptUsed: 'test prompt with private bits' },
      { title: 'Test hero', category: 'The Prompt', editionDate: '2026-04-20' },
    );

    expect(result.imageBuffer.length).toBeGreaterThan(testPng.length);
    expect(result.c2pa).toBeDefined();
    expect(result.c2pa?.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.c2pa?.signedAt).toBeInstanceOf(Date);

    const reader = await Reader.fromAsset({ buffer: result.imageBuffer, mimeType: 'image/png' });
    const active = reader.getActive();
    expect(active?.title).toBe('Test hero');

    const custom = active?.assertions?.find(
      (a) => a.label === 'org.agenticadvertising.generation',
    );
    expect(custom).toBeDefined();
  });

  it('hashes the prompt instead of embedding it verbatim', async () => {
    process.env.C2PA_SIGNING_ENABLED = 'true';
    process.env.C2PA_CERT_PEM_B64 = CERT_B64;
    process.env.C2PA_PRIVATE_KEY_PEM_B64 = KEY_B64;

    const secretPrompt = 'author-private visual-description-that-should-not-leak';
    const result = await attachC2PAIfEnabled(
      { imageBuffer: testPng, promptUsed: secretPrompt },
      { title: 'Hero' },
    );

    const reader = await Reader.fromAsset({ buffer: result.imageBuffer, mimeType: 'image/png' });
    const serialized = JSON.stringify(reader.json());
    expect(serialized).not.toContain('author-private');
    expect(serialized).toContain('prompt_sha256');
  });

  it('signs a WebP buffer by normalizing through sharp before handing to c2pa', async () => {
    process.env.C2PA_SIGNING_ENABLED = 'true';
    process.env.C2PA_CERT_PEM_B64 = CERT_B64;
    process.env.C2PA_PRIVATE_KEY_PEM_B64 = KEY_B64;

    // Gemini's image model occasionally returns non-PNG formats (webp, jpeg).
    // c2pa-node throws "type is unsupported" when handed those bytes under
    // an image/png declaration; the sharp re-encode is the guardrail.
    const webpBuffer = await sharp({
      create: { width: 64, height: 64, channels: 4, background: { r: 10, g: 10, b: 200, alpha: 1 } },
    })
      .webp()
      .toBuffer();

    const result = await attachC2PAIfEnabled(
      { imageBuffer: webpBuffer, promptUsed: 'ok' },
      { title: 'WebP hero' },
    );

    expect(result.c2pa).toBeDefined();
    const reader = await Reader.fromAsset({ buffer: result.imageBuffer, mimeType: 'image/png' });
    expect(reader.getActive()?.title).toBe('WebP hero');
  });

  it('returns the unsigned result and alerts when sharp rejects the input', async () => {
    process.env.C2PA_SIGNING_ENABLED = 'true';
    process.env.C2PA_CERT_PEM_B64 = CERT_B64;
    process.env.C2PA_PRIVATE_KEY_PEM_B64 = KEY_B64;
    delete process.env.C2PA_STRICT;

    // Exercises the catch-block fallback via the sharp-reencode phase: if
    // Gemini ever returns bytes sharp cannot decode, we still return unsigned
    // and fire the alert instead of blocking the caller.
    const notAnImage = Buffer.from('this is plain text, definitely not image bytes');
    const input = { imageBuffer: notAnImage, promptUsed: 'test' };
    const result = await attachC2PAIfEnabled(input, { title: 'Hero' });

    expect(result.imageBuffer).toBe(notAnImage);
    expect(result.c2pa).toBeUndefined();
    expect(errorNotifier.notifySystemError).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'c2pa-illustration-signing' }),
    );
  });

  it('returns the unsigned result and alerts when signC2PA itself throws post-sharp', async () => {
    process.env.C2PA_SIGNING_ENABLED = 'true';
    process.env.C2PA_CERT_PEM_B64 = CERT_B64;
    process.env.C2PA_PRIVATE_KEY_PEM_B64 = KEY_B64;
    delete process.env.C2PA_STRICT;

    // Regression coverage for the original "type is unsupported" production
    // bug: a buffer sharp accepts but the sign layer rejects must still fall
    // back cleanly. Spy on signC2PA so the sharp step succeeds and the throw
    // originates from the sign layer.
    vi.spyOn(c2pa, 'signC2PA').mockImplementation(() => {
      throw new Error('simulated c2pa-node sign failure');
    });

    const result = await attachC2PAIfEnabled(
      { imageBuffer: testPng, promptUsed: 'test' },
      { title: 'Hero' },
    );

    // Fallback returns the original (unsigned) input result — not the
    // re-encoded buffer — so callers never ship something we half-processed.
    expect(result.imageBuffer).toBe(testPng);
    expect(result.c2pa).toBeUndefined();
    expect(errorNotifier.notifySystemError).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'c2pa-illustration-signing' }),
    );
  });

  it('rethrows the signing error in strict mode', async () => {
    process.env.C2PA_SIGNING_ENABLED = 'true';
    process.env.C2PA_CERT_PEM_B64 = CERT_B64;
    process.env.C2PA_PRIVATE_KEY_PEM_B64 = KEY_B64;
    process.env.C2PA_STRICT = 'true';

    const notAnImage = Buffer.from('not an image');
    const input = { imageBuffer: notAnImage, promptUsed: 'test' };

    await expect(attachC2PAIfEnabled(input, { title: 'Hero' })).rejects.toThrow();
    expect(errorNotifier.notifySystemError).toHaveBeenCalledTimes(1);
  });

  it('does not fire the error alert on the happy path', async () => {
    process.env.C2PA_SIGNING_ENABLED = 'true';
    process.env.C2PA_CERT_PEM_B64 = CERT_B64;
    process.env.C2PA_PRIVATE_KEY_PEM_B64 = KEY_B64;
    delete process.env.C2PA_STRICT;

    const result = await attachC2PAIfEnabled(
      { imageBuffer: testPng, promptUsed: 'ok' },
      { title: 'Hero' },
    );
    expect(result.c2pa).toBeDefined();
    expect(errorNotifier.notifySystemError).not.toHaveBeenCalled();
  });
});
