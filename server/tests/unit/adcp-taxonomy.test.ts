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
