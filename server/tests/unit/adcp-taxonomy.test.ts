/**
 * Guardrail: ensure the TypeScript taxonomy constants stay in sync with
 * the canonical JSON enums in static/schemas/source/enums/.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ADCP_DOMAINS,
  ADCP_SPECIALISMS,
  isStableSpecialism,
  getSpecialismStatus,
} from '../../src/services/adcp-taxonomy.js';

function loadJsonEnum(relPath: string): string[] {
  const path = join(process.cwd(), relPath);
  const data = JSON.parse(readFileSync(path, 'utf8')) as { enum: string[] };
  return data.enum;
}

describe('adcp-taxonomy enum sync', () => {
  it('ADCP_DOMAINS matches enums/adcp-domain.json', () => {
    const canonical = loadJsonEnum('static/schemas/source/enums/adcp-domain.json');
    expect([...ADCP_DOMAINS].sort()).toEqual([...canonical].sort());
  });

  it('ADCP_SPECIALISMS matches enums/specialism.json', () => {
    const canonical = loadJsonEnum('static/schemas/source/enums/specialism.json');
    expect([...ADCP_SPECIALISMS].sort()).toEqual([...canonical].sort());
  });
});

describe('specialism status', () => {
  it('identifies preview specialisms from compliance catalog', () => {
    // These are marked `status: preview` in the catalog index.yaml files
    const previewSpecialisms = [
      'measurement-verification',
      'sales-exchange',
      'sales-retail-media',
      'sales-streaming-tv',
    ];
    for (const s of previewSpecialisms) {
      expect(getSpecialismStatus(s)).toBe('preview');
      expect(isStableSpecialism(s)).toBe(false);
    }
  });

  it('treats unmarked specialisms as stable', () => {
    expect(isStableSpecialism('sales-broadcast-tv')).toBe(true);
    expect(isStableSpecialism('creative-template')).toBe(true);
  });

  it('treats unknown specialisms as stable (safe default)', () => {
    expect(getSpecialismStatus('not-a-real-specialism')).toBe('stable');
  });
});
