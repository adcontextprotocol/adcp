/**
 * `plan_hash` golden-vector conformance.
 *
 * Each fixture under static/compliance/source/test-vectors/plan-hash/ pins
 * the canonicalization, exclusion list, hash, and base64url encoding
 * bit-exactly. A drift in any of those layers fails here before it can ship.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalize } from '@adcp/sdk';
import { describe, expect, it } from 'vitest';
import { computePlanHash, stripBookkeeping } from '../../src/training-agent/plan-hash.js';

const VECTORS_DIR = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  '..',
  '..',
  'static',
  'compliance',
  'source',
  'test-vectors',
  'plan-hash',
);

interface Vector {
  name: string;
  plan_as_supplied: Record<string, unknown>;
  expected: {
    preimage: Record<string, unknown>;
    jcs_bytes: string;
    sha256_hex: string;
    plan_hash: string;
  };
}

function loadVectors(): Array<{ file: string; vector: Vector }> {
  return readdirSync(VECTORS_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(file => ({
      file,
      vector: JSON.parse(readFileSync(join(VECTORS_DIR, file), 'utf8')) as Vector,
    }));
}

describe('plan_hash conformance against golden vectors', () => {
  const cases = loadVectors();

  it.each(cases)('$file — $vector.name', ({ vector }) => {
    expect(stripBookkeeping(vector.plan_as_supplied)).toEqual(vector.expected.preimage);

    const jcs = canonicalize(stripBookkeeping(vector.plan_as_supplied));
    expect(jcs).toBe(vector.expected.jcs_bytes);

    const sha256 = createHash('sha256').update(jcs, 'utf8').digest('hex');
    expect(sha256).toBe(vector.expected.sha256_hex);

    expect(computePlanHash(vector.plan_as_supplied)).toBe(vector.expected.plan_hash);
  });

  it('every claim decodes to exactly 32 bytes', () => {
    for (const { vector } of cases) {
      const decoded = Buffer.from(vector.expected.plan_hash, 'base64url');
      expect(decoded.length).toBe(32);
    }
  });

  it('emits unpadded base64url', () => {
    for (const { vector } of cases) {
      expect(vector.expected.plan_hash).not.toContain('=');
      expect(computePlanHash(vector.plan_as_supplied)).not.toContain('=');
    }
  });
});

describe('plan_hash bookkeeping exclusion', () => {
  it('strips the closed list and leaves other fields intact', () => {
    const plan = {
      plan_id: 'p1',
      brand: { domain: 'example.com' },
      ext: { trace_id: 'abc' },
      version: 5,
      status: 'active',
      syncedAt: '2026-04-19T12:00:00Z',
      revisionHistory: [{ version: 4 }],
      committedBudget: 1000,
      committedByType: { media_buy: 1000 },
    };

    expect(stripBookkeeping(plan)).toEqual({
      plan_id: 'p1',
      brand: { domain: 'example.com' },
      ext: { trace_id: 'abc' },
    });
  });

  it('treats unknown bookkeeping-shaped fields as IN the preimage (fail-safe inclusion)', () => {
    const plan = {
      plan_id: 'p1',
      brand: { domain: 'example.com' },
      mysteryField: 'something the GA invented',
    };
    expect(stripBookkeeping(plan)).toHaveProperty('mysteryField');
  });
});
