/**
 * Guardrail: ensure the TypeScript taxonomy constants stay in sync with
 * the canonical JSON enums in static/schemas/source/enums/.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ADCP_PROTOCOLS,
  ADCP_SPECIALISMS,
  isStableSpecialism,
  getSpecialismStatus,
  SUPPORTED_BADGE_VERSIONS,
  isSupportedBadgeVersion,
} from '../../src/services/adcp-taxonomy.js';

function loadJsonEnum(relPath: string): string[] {
  const path = join(process.cwd(), relPath);
  const data = JSON.parse(readFileSync(path, 'utf8')) as { enum: string[] };
  return data.enum;
}

describe('adcp-taxonomy enum sync', () => {
  it('ADCP_PROTOCOLS matches enums/adcp-protocol.json', () => {
    const canonical = loadJsonEnum('static/schemas/source/enums/adcp-protocol.json');
    expect([...ADCP_PROTOCOLS].sort()).toEqual([...canonical].sort());
  });

  it('ADCP_SPECIALISMS matches enums/specialism.json', () => {
    const canonical = loadJsonEnum('static/schemas/source/enums/specialism.json');
    expect([...ADCP_SPECIALISMS].sort()).toEqual([...canonical].sort());
  });
});

describe('specialism status', () => {
  // No specialisms are currently marked `status: preview` in the compliance catalog —
  // earlier preview specialisms (sales-exchange, sales-retail-media, sales-streaming-tv,
  // measurement-verification) were removed from the enum entirely rather than retained
  // behind a status flag. The preview mechanism remains in place for future use.

  it('treats all current specialisms as stable', () => {
    expect(isStableSpecialism('sales-broadcast-tv')).toBe(true);
    expect(isStableSpecialism('creative-template')).toBe(true);
    expect(isStableSpecialism('property-lists')).toBe(true);
    expect(isStableSpecialism('collection-lists')).toBe(true);
    expect(isStableSpecialism('signed-requests')).toBe(true);
    expect(isStableSpecialism('governance-aware-seller')).toBe(true);
  });

  it('treats unknown specialisms as stable (safe default)', () => {
    expect(getSpecialismStatus('not-a-real-specialism')).toBe('stable');
  });
});

describe('SUPPORTED_BADGE_VERSIONS', () => {
  it('is a non-empty array of MAJOR.MINOR strings', () => {
    expect(SUPPORTED_BADGE_VERSIONS.length).toBeGreaterThan(0);
    for (const v of SUPPORTED_BADGE_VERSIONS) {
      // Same shape as the agent_verification_badges.adcp_version CHECK.
      expect(v).toMatch(/^[1-9][0-9]*\.[0-9]+$/);
    }
  });

  it('isSupportedBadgeVersion accepts every entry', () => {
    for (const v of SUPPORTED_BADGE_VERSIONS) {
      expect(isSupportedBadgeVersion(v)).toBe(true);
    }
  });

  it('isSupportedBadgeVersion rejects unknown values', () => {
    expect(isSupportedBadgeVersion('99.0')).toBe(false);
    expect(isSupportedBadgeVersion(null)).toBe(false);
    expect(isSupportedBadgeVersion(undefined)).toBe(false);
    expect(isSupportedBadgeVersion('')).toBe(false);
  });
});
