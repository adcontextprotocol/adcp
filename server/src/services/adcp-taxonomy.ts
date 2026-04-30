/**
 * Single source of truth for AdCP protocol and specialism taxonomy.
 *
 * Keeps badge system types in sync with enums/adcp-protocol.json and
 * enums/specialism.json. A test enforces that these lists match the JSON
 * at runtime (see adcp-taxonomy.test.ts).
 *
 * Per-specialism status (stable vs preview) is read from the compliance
 * catalog at static/compliance/source/specialisms/{id}/index.yaml so that
 * the badge issuer respects preview specialisms (no stable verification).
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Verification axes for the AAO Verified mark. An agent's badge can carry
 * any non-empty subset of these — currently 'spec' (storyboards pass against
 * test-mode endpoint), 'live' to be added when the canonical-campaign runner
 * ships. Order in the array is preserved at the wire and re-ordered for
 * display.
 */
export const VERIFICATION_MODES = ['spec', 'live'] as const;
export type VerificationMode = typeof VERIFICATION_MODES[number];

export function isVerificationMode(value: unknown): value is VerificationMode {
  return typeof value === 'string' && (VERIFICATION_MODES as readonly string[]).includes(value);
}

/** AdCP protocol enum — must match enums/adcp-protocol.json. */
export type AdcpProtocol =
  | 'media-buy'
  | 'signals'
  | 'governance'
  | 'creative'
  | 'brand'
  | 'sponsored-intelligence';

export const ADCP_PROTOCOLS: readonly AdcpProtocol[] = [
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
  | 'collection-lists'
  | 'content-standards'
  | 'creative-ad-server'
  | 'creative-generative'
  | 'creative-template'
  | 'governance-aware-seller'
  | 'governance-delivery-monitor'
  | 'governance-spend-authority'
  | 'property-lists'
  | 'sales-broadcast-tv'
  | 'sales-catalog-driven'
  | 'sales-guaranteed'
  | 'sales-non-guaranteed'
  | 'sales-proposal-mode'
  | 'sales-social'
  | 'signal-marketplace'
  | 'signal-owned'
  | 'signed-requests';

export const ADCP_SPECIALISMS: readonly AdcpSpecialism[] = [
  'audience-sync',
  'brand-rights',
  'collection-lists',
  'content-standards',
  'creative-ad-server',
  'creative-generative',
  'creative-template',
  'governance-aware-seller',
  'governance-delivery-monitor',
  'governance-spend-authority',
  'property-lists',
  'sales-broadcast-tv',
  'sales-catalog-driven',
  'sales-guaranteed',
  'sales-non-guaranteed',
  'sales-proposal-mode',
  'sales-social',
  'signal-marketplace',
  'signal-owned',
  'signed-requests',
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
