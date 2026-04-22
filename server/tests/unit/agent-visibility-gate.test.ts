import { describe, it, expect } from 'vitest';
import { gateAgentVisibilityForCaller } from '../../src/services/agent-visibility-gate.js';

/**
 * Shared-helper tests for the tier-gate coercion used by both POST and
 * PUT of /api/me/member-profile. The reviewer flagged (PR #2793) that
 * the PUT path did the gate but the POST path didn't — so an Explorer
 * user creating their first profile could land `visibility: 'public'`
 * on first write, and subsequent readers filtered strictly on
 * `=== 'public'` without a tier re-check. This helper centralizes the
 * coercion so neither path can drift.
 */

describe('gateAgentVisibilityForCaller', () => {
  it('returns empty results for a non-array input', () => {
    expect(gateAgentVisibilityForCaller(undefined, true)).toEqual({ agents: [], warnings: [] });
    expect(gateAgentVisibilityForCaller(null, false)).toEqual({ agents: [], warnings: [] });
    expect(gateAgentVisibilityForCaller('not an array', false)).toEqual({ agents: [], warnings: [] });
  });

  it('passes valid visibility values through when caller has API access', () => {
    const { agents, warnings } = gateAgentVisibilityForCaller(
      [
        { url: 'https://a', visibility: 'public' },
        { url: 'https://b', visibility: 'members_only' },
        { url: 'https://c', visibility: 'private' },
      ],
      true,
    );
    expect(warnings).toEqual([]);
    expect(agents).toEqual([
      { url: 'https://a', visibility: 'public' },
      { url: 'https://b', visibility: 'members_only' },
      { url: 'https://c', visibility: 'private' },
    ]);
  });

  it('downgrades public → members_only and emits a warning when caller lacks API access', () => {
    const { agents, warnings } = gateAgentVisibilityForCaller(
      [{ url: 'https://a', visibility: 'public' }],
      false,
    );
    expect(agents).toEqual([{ url: 'https://a', visibility: 'members_only' }]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      code: 'visibility_downgraded',
      agent_url: 'https://a',
      requested: 'public',
      applied: 'members_only',
      reason: 'tier_required',
    });
  });

  it('accepts members_only from a non-API-access caller', () => {
    const { agents, warnings } = gateAgentVisibilityForCaller(
      [{ url: 'https://a', visibility: 'members_only' }],
      false,
    );
    expect(agents).toEqual([{ url: 'https://a', visibility: 'members_only' }]);
    expect(warnings).toEqual([]);
  });

  it('translates legacy is_public:true to public when visibility is missing', () => {
    const { agents } = gateAgentVisibilityForCaller(
      [{ url: 'https://a', is_public: true }],
      true,
    );
    expect(agents[0].visibility).toBe('public');
  });

  it('translates legacy is_public:false (or missing) to private', () => {
    const { agents } = gateAgentVisibilityForCaller(
      [{ url: 'https://a' }, { url: 'https://b', is_public: false }],
      true,
    );
    expect(agents[0].visibility).toBe('private');
    expect(agents[1].visibility).toBe('private');
  });

  it('downgrades legacy is_public:true → members_only for a non-API-access caller', () => {
    // If a legacy client sends is_public:true against a downgraded org,
    // we still have to enforce the tier gate — not just for the new
    // `visibility:'public'` attack surface.
    const { agents, warnings } = gateAgentVisibilityForCaller(
      [{ url: 'https://a', is_public: true }],
      false,
    );
    expect(agents[0].visibility).toBe('members_only');
    expect(warnings).toHaveLength(1);
  });

  it('rejects unknown visibility strings by falling back to legacy is_public (then private)', () => {
    const { agents } = gateAgentVisibilityForCaller(
      [{ url: 'https://a', visibility: 'admin' }],
      true,
    );
    expect(agents[0].visibility).toBe('private');
  });

  it('strips unexpected fields from agent entries', () => {
    const { agents } = gateAgentVisibilityForCaller(
      [{ url: 'https://a', visibility: 'private', name: 'Agent', type: 'brand', password: 'hunter2' }],
      true,
    );
    expect(agents[0]).toEqual({ url: 'https://a', visibility: 'private', name: 'Agent', type: 'brand' });
    expect((agents[0] as any).password).toBeUndefined();
  });

  it('handles a mix of public and non-public agents in one call', () => {
    const { agents, warnings } = gateAgentVisibilityForCaller(
      [
        { url: 'https://a', visibility: 'public' },
        { url: 'https://b', visibility: 'private' },
        { url: 'https://c', visibility: 'public' },
      ],
      false,
    );
    expect(agents.map((a) => a.visibility)).toEqual(['members_only', 'private', 'members_only']);
    expect(warnings).toHaveLength(2);
    expect(warnings.map((w) => w.agent_url)).toEqual(['https://a', 'https://c']);
  });
});
