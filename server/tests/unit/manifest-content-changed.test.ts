/**
 * Unit tests for manifestContentChanged — gates manager → publishers
 * fan-out so re-validation only fires on actual content drift, not on
 * every routine 60-minute crawl. (#4200 item 2.)
 */
import { describe, it, expect } from 'vitest';
import { manifestContentChanged } from '../../src/crawler.js';
import type { AdagentsManifest } from '../../src/db/publisher-db.js';

const baseManifest: AdagentsManifest = {
  authorized_agents: [
    { url: 'https://agent.example', authorized_for: 'All inventory' },
  ],
  properties: [
    { property_id: 'site', property_type: 'website', name: 'Site' },
  ],
};

describe('manifestContentChanged', () => {
  it('returns true when previous is null (first crawl)', () => {
    expect(manifestContentChanged(null, baseManifest)).toBe(true);
  });

  it('returns false for identical manifests', () => {
    expect(manifestContentChanged(baseManifest, baseManifest)).toBe(false);
  });

  it('returns false when only $schema or last_updated differ', () => {
    const next: AdagentsManifest = {
      ...baseManifest,
      $schema: 'https://adcontextprotocol.org/schemas/v2/adagents.json',
      last_updated: '2026-05-07T12:00:00Z',
    };
    expect(manifestContentChanged(baseManifest, next)).toBe(false);
  });

  it('returns true when authorized_agents changes', () => {
    const next: AdagentsManifest = {
      ...baseManifest,
      authorized_agents: [
        { url: 'https://agent.example', authorized_for: 'All inventory' },
        { url: 'https://other-agent.example', authorized_for: 'Display' },
      ],
    };
    expect(manifestContentChanged(baseManifest, next)).toBe(true);
  });

  it('returns true when properties changes', () => {
    const next: AdagentsManifest = {
      ...baseManifest,
      properties: [
        { property_id: 'site', property_type: 'website', name: 'Renamed' },
      ],
    };
    expect(manifestContentChanged(baseManifest, next)).toBe(true);
  });

  it('returns true when authorized_agents reorders (order semantically distinct)', () => {
    // Order matters — a publisher reshuffling priority is meaningful
    // signal for downstream consumers, not noise to swallow.
    const reordered: AdagentsManifest = {
      authorized_agents: [
        { url: 'https://b.example', authorized_for: 'B' },
        { url: 'https://a.example', authorized_for: 'A' },
      ],
      properties: [],
    };
    const original: AdagentsManifest = {
      authorized_agents: [
        { url: 'https://a.example', authorized_for: 'A' },
        { url: 'https://b.example', authorized_for: 'B' },
      ],
      properties: [],
    };
    expect(manifestContentChanged(original, reordered)).toBe(true);
  });

  it('treats missing authorized_agents/properties as empty arrays', () => {
    const previous: AdagentsManifest = { authorized_agents: [], properties: [] };
    const next: AdagentsManifest = {};
    expect(manifestContentChanged(previous, next)).toBe(false);
  });
});
