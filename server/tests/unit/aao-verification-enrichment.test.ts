import { describe, it, expect } from 'vitest';
import {
  buildAaoVerificationBlock,
  AAO_VERIFICATION_DEPRECATION_NOTICE,
} from '../../src/services/aao-verification-enrichment.js';
import type { AgentVerificationBadge, BadgeRole } from '../../src/db/compliance-db.js';

function makeBadge(overrides: Partial<AgentVerificationBadge> & {
  role: BadgeRole;
  adcp_version: string;
}): AgentVerificationBadge {
  return {
    agent_url: 'https://example.com/mcp',
    role: overrides.role,
    adcp_version: overrides.adcp_version,
    verified_at: overrides.verified_at ?? new Date('2026-04-01T00:00:00Z'),
    verified_protocol_version: overrides.verified_protocol_version ?? `${overrides.adcp_version}.0`,
    verified_specialisms: overrides.verified_specialisms ?? ['media-buy-seller'],
    verification_modes: overrides.verification_modes ?? ['spec'],
    verification_token: overrides.verification_token ?? null,
    token_expires_at: overrides.token_expires_at ?? null,
    membership_org_id: overrides.membership_org_id ?? 'org_test',
    status: overrides.status ?? 'active',
    revoked_at: overrides.revoked_at ?? null,
    revocation_reason: overrides.revocation_reason ?? null,
    created_at: overrides.created_at ?? new Date('2026-03-01T00:00:00Z'),
    updated_at: overrides.updated_at ?? new Date('2026-04-01T00:00:00Z'),
  };
}

describe('buildAaoVerificationBlock', () => {
  it('returns null for an empty badge list', () => {
    expect(buildAaoVerificationBlock([])).toBeNull();
  });

  it('builds a single-badge block with all expected fields', () => {
    const block = buildAaoVerificationBlock([
      makeBadge({ role: 'media-buy', adcp_version: '3.0' }),
    ]);
    expect(block).not.toBeNull();
    expect(block!.verified).toBe(true);
    expect(block!.badges).toHaveLength(1);
    expect(block!.badges[0]).toMatchObject({
      role: 'media-buy',
      adcp_version: '3.0',
      verification_modes: ['spec'],
    });
    expect(block!.roles).toEqual(['media-buy']);
    expect(block!.modes_by_role).toEqual({ 'media-buy': ['spec'] });
    expect(block!.deprecation_notice).toBe(AAO_VERIFICATION_DEPRECATION_NOTICE);
  });

  it('preserves input order in the badges[] array (caller is responsible for sort)', () => {
    // Caller-provided order is version-DESC for media-buy, then creative
    // at 3.1. We don't re-sort — caller's bulkGetActiveBadges already does.
    const block = buildAaoVerificationBlock([
      makeBadge({ role: 'media-buy', adcp_version: '3.1', verification_modes: ['spec', 'live'] }),
      makeBadge({ role: 'creative', adcp_version: '3.1' }),
      makeBadge({ role: 'media-buy', adcp_version: '3.0' }),
    ]);
    expect(block!.badges.map(b => `${b.role}@${b.adcp_version}`)).toEqual([
      'media-buy@3.1',
      'creative@3.1',
      'media-buy@3.0',
    ]);
  });

  it('dedupes by role for the legacy aliases, picking first occurrence per role', () => {
    // Legacy aliases (roles, modes_by_role) reflect highest-version-per-
    // role. Caller order determines "highest" — first occurrence wins.
    const block = buildAaoVerificationBlock([
      makeBadge({ role: 'media-buy', adcp_version: '3.1', verification_modes: ['spec', 'live'] }),
      makeBadge({ role: 'creative', adcp_version: '3.0' }),
      makeBadge({ role: 'media-buy', adcp_version: '3.0', verification_modes: ['spec'] }),
    ]);
    expect(block!.roles).toEqual(['media-buy', 'creative']);
    // Highest-version media-buy modes preserved; 3.0's modes don't overwrite.
    expect(block!.modes_by_role).toEqual({
      'media-buy': ['spec', 'live'],
      'creative': ['spec'],
    });
  });

  it('badges[] preserves version detail that modes_by_role flattens away', () => {
    // Buyer pinned to 3.0 reading modes_by_role would see "spec+live"
    // — wrong for their version. badges[] surfaces the per-version
    // truth so the buyer can filter correctly.
    const block = buildAaoVerificationBlock([
      makeBadge({ role: 'media-buy', adcp_version: '3.1', verification_modes: ['spec', 'live'] }),
      makeBadge({ role: 'media-buy', adcp_version: '3.0', verification_modes: ['spec'] }),
    ]);
    const badge30 = block!.badges.find(b => b.adcp_version === '3.0');
    const badge31 = block!.badges.find(b => b.adcp_version === '3.1');
    expect(badge30!.verification_modes).toEqual(['spec']);
    expect(badge31!.verification_modes).toEqual(['spec', 'live']);
    // The flattened alias picks the highest version's modes.
    expect(block!.modes_by_role['media-buy']).toEqual(['spec', 'live']);
  });

  it('verified_at is the first-deduped-badge timestamp (caller-ordered = newest)', () => {
    const newest = new Date('2026-04-29T12:00:00Z');
    const oldest = new Date('2026-01-15T08:00:00Z');
    const block = buildAaoVerificationBlock([
      makeBadge({ role: 'media-buy', adcp_version: '3.1', verified_at: newest }),
      makeBadge({ role: 'media-buy', adcp_version: '3.0', verified_at: oldest }),
    ]);
    expect(block!.verified_at).toBe(newest.toISOString());
  });

  it('drops malformed adcp_version to null (defense in depth)', () => {
    // DB CHECK + JWT signer regex prevent malformed values reaching
    // here in production. This test pins the defense-in-depth behavior
    // in case a future code path ever bypasses those (raw SQL backfill,
    // restored snapshot, replication slot replay).
    const block = buildAaoVerificationBlock([
      makeBadge({ role: 'media-buy', adcp_version: 'evil; DROP TABLE' }),
    ]);
    expect(block!.badges[0].adcp_version).toBeNull();
  });

  it('drops adcp_version with leading-zero major to null', () => {
    const block = buildAaoVerificationBlock([
      makeBadge({ role: 'media-buy', adcp_version: '0.5' }),
    ]);
    expect(block!.badges[0].adcp_version).toBeNull();
  });

  it('drops full-semver value (3.0.0) — the field is MAJOR.MINOR only', () => {
    const block = buildAaoVerificationBlock([
      makeBadge({ role: 'media-buy', adcp_version: '3.0.0' as never }),
    ]);
    expect(block!.badges[0].adcp_version).toBeNull();
  });

  it('preserves double-digit minors (3.10) — numeric sort lesson from Stage 1', () => {
    const block = buildAaoVerificationBlock([
      makeBadge({ role: 'media-buy', adcp_version: '3.10' }),
    ]);
    expect(block!.badges[0].adcp_version).toBe('3.10');
  });

  it('verified is always literal true (never `verified: false` returned)', () => {
    const block = buildAaoVerificationBlock([
      makeBadge({ role: 'media-buy', adcp_version: '3.0' }),
    ]);
    // Type-level: AaoVerificationBlock['verified'] is the literal type
    // `true`. Runtime: confirm.
    expect(block!.verified).toBe(true);
  });
});

describe('AAO_VERIFICATION_DEPRECATION_NOTICE', () => {
  it('mentions both deprecated fields by name', () => {
    expect(AAO_VERIFICATION_DEPRECATION_NOTICE).toContain('roles[]');
    expect(AAO_VERIFICATION_DEPRECATION_NOTICE).toContain('modes_by_role');
  });

  it('directs readers to badges[] for per-version detail', () => {
    expect(AAO_VERIFICATION_DEPRECATION_NOTICE).toContain('badges[]');
  });

  it('names the removal target', () => {
    expect(AAO_VERIFICATION_DEPRECATION_NOTICE).toContain('AdCP 4.0');
  });
});
