/**
 * Single source of truth for AdCP domain and specialism taxonomy.
 *
 * Keeps badge system types in sync with enums/adcp-domain.json and
 * enums/specialism.json. A test enforces that these lists match the JSON
 * at runtime (see verification-status.test.ts).
 *
 * Per-specialism status (stable vs preview) is read from the compliance
 * catalog at static/compliance/source/specialisms/{id}/index.yaml so that
 * the badge issuer respects preview specialisms (no stable verification).
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

/** AdCP domain enum — must match enums/adcp-domain.json. */
export type AdcpDomain =
  | 'media-buy'
  | 'signals'
  | 'governance'
  | 'creative'
  | 'brand'
  | 'sponsored-intelligence';

export const ADCP_DOMAINS: readonly AdcpDomain[] = [
  'media-buy',
  'signals',
  'governance',
  'creative',
  'brand',
  'sponsored-intelligence',
];

/** AdCP specialism enum — must match enums/specialism.json. */
export type AdcpSpecialism =
  | 'audience-sync'
  | 'brand-rights'
  | 'content-standards'
  | 'creative-ad-server'
  | 'creative-generative'
  | 'creative-template'
  | 'governance-delivery-monitor'
  | 'governance-spend-authority'
  | 'inventory-lists'
  | 'measurement-verification'
  | 'sales-broadcast-tv'
  | 'sales-catalog-driven'
  | 'sales-exchange'
  | 'sales-guaranteed'
  | 'sales-non-guaranteed'
  | 'sales-proposal-mode'
  | 'sales-retail-media'
  | 'sales-social'
  | 'sales-streaming-tv'
  | 'signal-marketplace'
  | 'signal-owned';

export const ADCP_SPECIALISMS: readonly AdcpSpecialism[] = [
  'audience-sync',
  'brand-rights',
  'content-standards',
  'creative-ad-server',
  'creative-generative',
  'creative-template',
  'governance-delivery-monitor',
  'governance-spend-authority',
  'inventory-lists',
  'measurement-verification',
  'sales-broadcast-tv',
  'sales-catalog-driven',
  'sales-exchange',
  'sales-guaranteed',
  'sales-non-guaranteed',
  'sales-proposal-mode',
  'sales-retail-media',
  'sales-social',
  'sales-streaming-tv',
  'signal-marketplace',
  'signal-owned',
];

/** Per-specialism status derived from compliance catalog frontmatter. */
export type SpecialismStatus = 'stable' | 'preview' | 'deprecated';

function loadSpecialismStatuses(): Record<string, SpecialismStatus> {
  const catalogRoot = join(process.cwd(), 'static', 'compliance', 'source', 'specialisms');
  const statuses: Record<string, SpecialismStatus> = {};
  try {
    for (const entry of readdirSync(catalogRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const indexPath = join(catalogRoot, entry.name, 'index.yaml');
      try {
        const yaml = readFileSync(indexPath, 'utf8');
        const match = yaml.match(/^status:\s*(stable|preview|deprecated)\s*$/m);
        statuses[entry.name] = (match?.[1] as SpecialismStatus) ?? 'stable';
      } catch {
        statuses[entry.name] = 'stable';
      }
    }
  } catch {
    // Catalog not available — treat all as stable (safe default)
  }
  return statuses;
}

const SPECIALISM_STATUSES = loadSpecialismStatuses();

export function getSpecialismStatus(specialism: string): SpecialismStatus {
  return SPECIALISM_STATUSES[specialism] ?? 'stable';
}

export function isStableSpecialism(specialism: string): boolean {
  return getSpecialismStatus(specialism) === 'stable';
}
