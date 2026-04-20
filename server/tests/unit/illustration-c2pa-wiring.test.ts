import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { Buffer } from 'buffer';
import sharp from 'sharp';
import { Reader } from '@contentauth/c2pa-node';
import { attachC2PAIfEnabled } from '../../src/services/illustration-generator.js';
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
  it('returns the input unchanged when signing is disabled', () => {
    delete process.env.C2PA_SIGNING_ENABLED;
    const input = { imageBuffer: testPng, promptUsed: 'test prompt' };
    const result = attachC2PAIfEnabled(input, { title: 'Test hero' });
    expect(result.imageBuffer).toBe(testPng);
    expect(result.c2pa).toBeUndefined();
  });

  it('signs the buffer and populates c2pa metadata when enabled', async () => {
    process.env.C2PA_SIGNING_ENABLED = 'true';
    process.env.C2PA_CERT_PEM_B64 = CERT_B64;
    process.env.C2PA_PRIVATE_KEY_PEM_B64 = KEY_B64;

    const result = attachC2PAIfEnabled(
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
    const result = attachC2PAIfEnabled(
      { imageBuffer: testPng, promptUsed: secretPrompt },
      { title: 'Hero' },
    );

    const reader = await Reader.fromAsset({ buffer: result.imageBuffer, mimeType: 'image/png' });
    const serialized = JSON.stringify(reader.json());
    expect(serialized).not.toContain('author-private');
    expect(serialized).toContain('prompt_sha256');
  });

  it('returns the unsigned result and alerts when signing throws on malformed input', () => {
    process.env.C2PA_SIGNING_ENABLED = 'true';
    process.env.C2PA_CERT_PEM_B64 = CERT_B64;
    process.env.C2PA_PRIVATE_KEY_PEM_B64 = KEY_B64;
    delete process.env.C2PA_STRICT;

    // Valid cert/key but the buffer is not a PNG — Builder.sign throws when
    // trying to parse the PNG ancillary-chunk structure. This exercises the
    // real sign-failure fallback, not a startup-config error.
    const notAPng = Buffer.from('this is plain text, definitely not PNG bytes');
    const input = { imageBuffer: notAPng, promptUsed: 'test' };
    const result = attachC2PAIfEnabled(input, { title: 'Hero' });

    expect(result.imageBuffer).toBe(notAPng);
    expect(result.c2pa).toBeUndefined();
    expect(errorNotifier.notifySystemError).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'c2pa-illustration-signing' }),
    );
  });

  it('rethrows the signing error in strict mode', () => {
    process.env.C2PA_SIGNING_ENABLED = 'true';
    process.env.C2PA_CERT_PEM_B64 = CERT_B64;
    process.env.C2PA_PRIVATE_KEY_PEM_B64 = KEY_B64;
    process.env.C2PA_STRICT = 'true';

    const notAPng = Buffer.from('not PNG');
    const input = { imageBuffer: notAPng, promptUsed: 'test' };

    expect(() => attachC2PAIfEnabled(input, { title: 'Hero' })).toThrow();
    expect(errorNotifier.notifySystemError).toHaveBeenCalledTimes(1);
  });

  it('does not fire the error alert on the happy path', () => {
    process.env.C2PA_SIGNING_ENABLED = 'true';
    process.env.C2PA_CERT_PEM_B64 = CERT_B64;
    process.env.C2PA_PRIVATE_KEY_PEM_B64 = KEY_B64;
    delete process.env.C2PA_STRICT;

    const result = attachC2PAIfEnabled(
      { imageBuffer: testPng, promptUsed: 'ok' },
      { title: 'Hero' },
    );
    expect(result.c2pa).toBeDefined();
    expect(errorNotifier.notifySystemError).not.toHaveBeenCalled();
  });
});
