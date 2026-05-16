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

/**
 * AdCP versions for which AAO actively issues per-version badges. The
 * heartbeat fans out per entry: for each version, it runs `comply()`
 * with the version-filtered storyboard set and calls
 * `processAgentBadges()` with that version.
 *
 * Adding a version is a deliberate decision — adding `'3.1'` here turns
 * on Verified Media Buy 3.1 (Spec) issuance for every eligible agent,
 * even ones that haven't been told yet. Update this in lockstep with
 * the `introduced_in:` fields on new storyboards under
 * static/compliance/source/specialisms/.
 *
 * Order matters: highest version first so heartbeat reports and queue
 * draining surface the newest version's pass/fail state first.
 */
export const SUPPORTED_BADGE_VERSIONS = ['3.0'] as const;
export type SupportedBadgeVersion = typeof SUPPORTED_BADGE_VERSIONS[number];

export function isSupportedBadgeVersion(value: unknown): value is SupportedBadgeVersion {
  return typeof value === 'string' && (SUPPORTED_BADGE_VERSIONS as readonly string[]).includes(value);
}

/**
 * Shape constraint for AdCP version strings (MAJOR.MINOR, e.g. '3.0').
 *
 * Single source of truth — also enforced by:
 *  - The `valid_adcp_version` CHECK constraint in migration 457
 *  - JWT signing in `verification-token.ts` (fail-closed)
 *  - SVG label rendering in `badge-svg.ts` (drop-on-malformed)
 *  - Route validators in `registry-api.ts` (length-bounded variant)
 *  - Panel JS in `dashboard-agents.html` (kept inline due to no module imports)
 *
 * If the constraint changes, update every site that mirrors it.
 */
export const ADCP_VERSION_RE = /^[1-9][0-9]*\.[0-9]+$/;

export function isValidAdcpVersionShape(value: unknown): value is string {
  return typeof value === 'string' && ADCP_VERSION_RE.test(value);
}

/** AdCP protocol enum — must match enums/adcp-protocol.json. */
export type AdcpProtocol =
  | 'media-buy'
  | 'signals'
  | 'governance'
  | 'creative'
  | 'brand'
  | 'sponsored-intelligence'
  | 'measurement';

export const ADCP_PROTOCOLS: readonly AdcpProtocol[] = [
  'media-buy',
  'signals',
  'governance',
  'creative',
  'brand',
  'sponsored-intelligence',
  'measurement',
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
  | 'signed-requests'
  | 'sponsored-intelligence';

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
  'sponsored-intelligence',
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
