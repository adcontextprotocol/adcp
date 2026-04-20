import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { Buffer } from 'buffer';
import sharp from 'sharp';
import { Reader } from '@contentauth/c2pa-node';
import {
  signC2PA,
  isC2PASigningEnabled,
  resetC2PASignerCache,
} from '../../src/services/c2pa.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'c2pa');
const CERT_PATH = join(FIXTURE_DIR, 'aao-c2pa.cert.pem');
const KEY_PATH = join(FIXTURE_DIR, 'aao-c2pa.key.pem');

let testPng: Buffer;
let CERT_B64: string;
let KEY_B64: string;

beforeAll(async () => {
  // Generate a test cert + key via the production ops script. Fixtures are
  // gitignored so secret scanners never see them; regenerating also exercises
  // the script as a side effect.
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
};

beforeEach(() => {
  resetC2PASignerCache();
});

afterEach(() => {
  process.env.C2PA_SIGNING_ENABLED = originalEnv.enabled;
  process.env.C2PA_CERT_PEM_B64 = originalEnv.cert;
  process.env.C2PA_PRIVATE_KEY_PEM_B64 = originalEnv.key;
  resetC2PASignerCache();
});

describe('isC2PASigningEnabled', () => {
  it('returns false when the feature flag is off', () => {
    process.env.C2PA_SIGNING_ENABLED = 'false';
    process.env.C2PA_CERT_PEM_B64 = CERT_B64;
    process.env.C2PA_PRIVATE_KEY_PEM_B64 = KEY_B64;
    expect(isC2PASigningEnabled()).toBe(false);
  });

  it('returns false when the flag is on but cert is missing', () => {
    process.env.C2PA_SIGNING_ENABLED = 'true';
    delete process.env.C2PA_CERT_PEM_B64;
    process.env.C2PA_PRIVATE_KEY_PEM_B64 = KEY_B64;
    expect(isC2PASigningEnabled()).toBe(false);
  });

  it('returns false when the flag is on but key is missing', () => {
    process.env.C2PA_SIGNING_ENABLED = 'true';
    process.env.C2PA_CERT_PEM_B64 = CERT_B64;
    delete process.env.C2PA_PRIVATE_KEY_PEM_B64;
    expect(isC2PASigningEnabled()).toBe(false);
  });

  it('returns true when the flag is on and both secrets are present', () => {
    process.env.C2PA_SIGNING_ENABLED = 'true';
    process.env.C2PA_CERT_PEM_B64 = CERT_B64;
    process.env.C2PA_PRIVATE_KEY_PEM_B64 = KEY_B64;
    expect(isC2PASigningEnabled()).toBe(true);
  });
});

describe('signC2PA', () => {
  beforeEach(() => {
    process.env.C2PA_SIGNING_ENABLED = 'true';
    process.env.C2PA_CERT_PEM_B64 = CERT_B64;
    process.env.C2PA_PRIVATE_KEY_PEM_B64 = KEY_B64;
  });

  it('throws a descriptive error when cert/key env vars are missing', () => {
    delete process.env.C2PA_CERT_PEM_B64;
    expect(() =>
      signC2PA(testPng, {
        claimGenerator: 'AAO Test Generator/1.0',
        softwareAgent: { name: 'gemini-3.1-flash-image-preview', version: 'preview' },
      }),
    ).toThrow(/C2PA_CERT_PEM_B64/);
  });

  it('returns a signed buffer larger than the input and a digest hex string', () => {
    const result = signC2PA(testPng, {
      claimGenerator: 'AAO Test Generator/1.0',
      softwareAgent: { name: 'gemini-3.1-flash-image-preview', version: 'preview' },
    });

    expect(result.signedBuffer.length).toBeGreaterThan(testPng.length);
    expect(result.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.manifestBytes).toBeGreaterThan(0);
  });

  it('embeds a manifest a Reader can read back with the expected assertions', async () => {
    const result = signC2PA(testPng, {
      claimGenerator: 'AAO Portrait Generator/1.0',
      title: 'Test portrait',
      softwareAgent: { name: 'gemini-3.1-flash-image-preview', version: 'preview' },
      attributes: { vibe: 'at-my-desk', palette: 'amber' },
    });

    const reader = await Reader.fromAsset({
      buffer: result.signedBuffer,
      mimeType: 'image/png',
    });

    const active = reader.getActive();
    expect(active).not.toBeNull();
    expect(active?.title).toBe('Test portrait');

    const generatorInfoNames = (active?.claim_generator_info ?? []).map((g) => g.name);
    expect(generatorInfoNames).toContain('AAO Portrait Generator/1.0');

    const actionsAssertion = active?.assertions?.find((a) =>
      a.label.startsWith('c2pa.actions'),
    );
    expect(actionsAssertion).toBeDefined();

    const customAssertion = active?.assertions?.find(
      (a) => a.label === 'org.agenticadvertising.generation',
    );
    expect(customAssertion).toBeDefined();
  });

  it('marks the asset as AI-generated via the trainedAlgorithmicMedia digital source type', async () => {
    const result = signC2PA(testPng, {
      claimGenerator: 'AAO Illustration Generator/1.0',
      softwareAgent: { name: 'gemini-3.1-flash-image-preview', version: 'preview' },
    });

    const reader = await Reader.fromAsset({
      buffer: result.signedBuffer,
      mimeType: 'image/png',
    });

    const serialized = JSON.stringify(reader.json());
    expect(serialized).toContain('trainedAlgorithmicMedia');
  });

  it('omits the custom AAO assertion when no attributes are supplied', async () => {
    const result = signC2PA(testPng, {
      claimGenerator: 'AAO Test Generator/1.0',
      softwareAgent: { name: 'gemini-3.1-flash-image-preview', version: 'preview' },
    });

    const reader = await Reader.fromAsset({
      buffer: result.signedBuffer,
      mimeType: 'image/png',
    });

    const active = reader.getActive();
    const customAssertion = active?.assertions?.find(
      (a) => a.label === 'org.agenticadvertising.generation',
    );
    expect(customAssertion).toBeUndefined();
  });
});
