/**
 * `signing_keys` across several matching `authorized_agents[]` entries
 * (#9016): pinned only if every matching entry pins; the allowed keys are the
 * union.
 *
 * The combination helper and `AgentValidator` both run the shared fixture
 * table; the registry directory runs it against Postgres in
 * tests/integration/registry-directory-origin-only.test.ts.
 */
import dns from 'node:dns/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentUrlAuthorizedBy } from '../../src/db/registry-agent-url-key.js';
import {
  combinedSigningKeys,
  entryPinsSigningKeys,
  everyMatchingEntryPins,
} from '../../src/services/matched-signing-keys.js';
import { AgentValidator } from '../../src/validator.js';
import {
  SIGNING_KEY_CASES,
  fixtureSigningKey,
  signingKeyCaseEntries,
} from '../fixtures/authorized-agent-url-matching.js';

const kidsOf = (keys: Array<{ kid?: unknown }> | undefined) => (keys ? keys.map(k => k.kid) : null);

describe('combinedSigningKeys', () => {
  const k1 = fixtureSigningKey('k1');
  const k2 = fixtureSigningKey('k2');

  it('is no restriction when nothing matches', () => {
    expect(combinedSigningKeys([])).toBeUndefined();
    expect(everyMatchingEntryPins([])).toBe(false);
  });

  it('is no restriction when any entry has absent or empty signing_keys', () => {
    expect(combinedSigningKeys([{ signing_keys: [k1] }, {}])).toBeUndefined();
    expect(combinedSigningKeys([{ signing_keys: [] }, { signing_keys: [k1] }])).toBeUndefined();
    expect(combinedSigningKeys([{ signing_keys: null }, { signing_keys: [k1] }])).toBeUndefined();
    expect(entryPinsSigningKeys({ signing_keys: [] })).toBe(false);
    expect(entryPinsSigningKeys({ signing_keys: 'k1' })).toBe(false);
  });

  it('is the union when every entry pins, in document order, duplicates once', () => {
    expect(combinedSigningKeys([{ signing_keys: [k2] }, { signing_keys: [k1, k2] }])).toEqual([k2, k1]);
  });

  it('treats member order as irrelevant when deduplicating', () => {
    const reordered = { x: k1.x, alg: k1.alg, crv: k1.crv, kty: k1.kty, kid: k1.kid };
    expect(combinedSigningKeys([{ signing_keys: [k1] }, { signing_keys: [reordered] }])).toEqual([k1]);
  });

  it('keeps a revoked copy of a key alongside an unrevoked one, so the revocation is not lost', () => {
    const revoked = { ...k1, revoked_at: '2026-11-01T00:00:00Z' };
    expect(combinedSigningKeys([{ signing_keys: [k1] }, { signing_keys: [revoked] }])).toEqual([k1, revoked]);
  });

  it.each(SIGNING_KEY_CASES)('$why', ({ agent, entries, expectedKids }) => {
    const matching = signingKeyCaseEntries(entries)
      .filter(entry => agentUrlAuthorizedBy(entry.url as string, agent)) as Array<{
        signing_keys?: Array<{ kid: string }>;
      }>;
    expect(kidsOf(combinedSigningKeys(matching))).toEqual(expectedKids);
    expect(everyMatchingEntryPins(matching)).toBe(expectedKids !== null);
  });
});

describe('AgentValidator matched_authorization.signing_keys', () => {
  let validator: AgentValidator;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    validator = new AgentValidator();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(dns, 'lookup').mockResolvedValue([
      { address: '203.0.113.5', family: 4 },
    ] as unknown as Awaited<ReturnType<typeof dns.lookup>>);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function serve(manifest: unknown) {
    fetchMock.mockImplementation(async () => new Response(
      JSON.stringify(manifest),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
  }

  it.each(SIGNING_KEY_CASES)('$why', async ({ agent, entries, expectedKids }) => {
    serve({ authorized_agents: signingKeyCaseEntries(entries) });
    const result = await validator.validate('example.com', agent);
    expect(result.authorized).toBe(true);
    expect(kidsOf(result.matched_authorization?.signing_keys)).toEqual(expectedKids);
  });

  it('counts only the entries that authorize the requested scope', async () => {
    // The origin entry is unpinned but covers GB only; the /mcp entry pins k1
    // everywhere. A US request is authorized by /mcp alone, so k1 applies; a
    // GB request is authorized by both, so the agent is unpinned there.
    serve({
      authorized_agents: [
        { url: 'https://signer.example.com', authorized_for: 'GB', countries: ['GB'] },
        { url: 'https://signer.example.com/mcp', authorized_for: 'All', signing_keys: [fixtureSigningKey('k1')] },
      ],
    });
    const us = await validator.validate('example.com', 'https://signer.example.com/mcp', { country: 'US' });
    expect(kidsOf(us.matched_authorization?.signing_keys)).toEqual(['k1']);
    const gb = await validator.validate('example.com', 'https://signer.example.com/mcp', { country: 'GB' });
    expect(gb.matched_authorization?.signing_keys).toBeUndefined();
  });

  it('keeps the first matching entry for the descriptive fields', async () => {
    serve({
      authorized_agents: [
        { url: 'https://signer.example.com', authorized_for: 'Origin', delegation_type: 'direct' },
        {
          url: 'https://signer.example.com/mcp',
          authorized_for: 'Path',
          delegation_type: 'ad_network',
          signing_keys: [fixtureSigningKey('k1')],
        },
      ],
    });
    const result = await validator.validate('example.com', 'https://signer.example.com/mcp');
    expect(result.matched_authorization?.delegation_type).toBe('direct');
    expect(result.matched_authorization?.signing_keys).toBeUndefined();
  });
});
