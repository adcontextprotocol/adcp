/**
 * #8322 — the JSONB containment filter the ownership and badge predicates
 * share. These assertions pin the two things a hand-written call site gets
 * wrong: placeholder arithmetic (the filter is spliced into queries that
 * already bind an org id) and what ends up inside the payload.
 */
import { describe, expect, it } from 'vitest';
import { agentIdentityContainment } from '../../src/db/agent-identity-match.js';

describe('agentIdentityContainment', () => {
  it('ORs one containment test per spelling of the agent identity', () => {
    const filter = agentIdentityContainment('mp.agents', 'https://agent.example.com/mcp', 1);

    expect(filter.sql).toBe(
      '(mp.agents @> $1::jsonb OR mp.agents @> $2::jsonb)',
    );
    expect(filter.params).toEqual([
      JSON.stringify([{ url: 'https://agent.example.com/mcp' }]),
      JSON.stringify([{ url: 'https://agent.example.com/mcp/' }]),
    ]);
    expect(filter.primaryPlaceholder).toBe(1);
    expect(filter.nextPlaceholder).toBe(3);
  });

  it('puts the pre-fold payload first so a one-row query can still prefer it', () => {
    // `params[0]` is what an exact-match reader bound before the fold.
    // `badge-issuance.ts` orders by it so the profile holding the key keeps
    // winning over one reached only through the fold.
    const fromSlash = agentIdentityContainment('mp.agents', 'https://agent.example.com/mcp/', 4);
    expect(fromSlash.params[0]).toBe(JSON.stringify([{ url: 'https://agent.example.com/mcp' }]));
    expect(fromSlash.primaryPlaceholder).toBe(4);
  });

  it('reaches the folded key when the caller holds the trailing-slash spelling', () => {
    const fromSlash = agentIdentityContainment('mp.agents', 'https://agent.example.com/mcp/', 1);
    const fromKey = agentIdentityContainment('mp.agents', 'https://agent.example.com/mcp', 1);

    // Either direction asks for the same pair: the fold is symmetric, which
    // is what lets an owner registered under one spelling pass a check made
    // under the other.
    expect(new Set(fromSlash.params)).toEqual(new Set(fromKey.params));
  });

  it('offsets placeholders so an org-scoped query keeps $1', () => {
    const filter = agentIdentityContainment('mp.agents', 'https://agent.example.com/mcp', 2);

    expect(filter.sql).toBe(
      '(mp.agents @> $2::jsonb OR mp.agents @> $3::jsonb)',
    );
    expect(filter.primaryPlaceholder).toBe(2);
    expect(filter.nextPlaceholder).toBe(4);
  });

  it('parenthesizes the OR so a later AND cannot widen it', () => {
    const filter = agentIdentityContainment('mp.agents', 'https://agent.example.com/mcp', 1);
    expect(filter.sql.startsWith('(')).toBe(true);
    expect(filter.sql.endsWith(')')).toBe(true);
  });

  it('keys only on `url`, never on the authorization spelling', () => {
    // `declared_url` is the spec-exact AUTHORIZATION spelling (#7829). A
    // containment payload that mentioned it would let a member point their
    // own agent at another agent's authorization and pass this predicate.
    const filter = agentIdentityContainment('mp.agents', 'https://agent.example.com/mcp/', 1);
    for (const payload of filter.params) {
      const parsed = JSON.parse(payload) as Array<Record<string, unknown>>;
      expect(parsed).toHaveLength(1);
      expect(Object.keys(parsed[0])).toEqual(['url']);
    }
  });

  it('falls back to the caller spelling for a URL the key rejects', () => {
    // Mirrors `registryAgentUrlLookupKey`'s `?? raw`: a historical row stored
    // under an unkeyable value is still reachable by that exact value.
    const filter = agentIdentityContainment('mp.agents', 'not-a-url', 1);
    expect(filter.sql).toBe('(mp.agents @> $1::jsonb)');
    expect(filter.params).toEqual([JSON.stringify([{ url: 'not-a-url' }])]);
    expect(filter.nextPlaceholder).toBe(2);
  });

  it('refuses a column reference that is not a bare identifier', () => {
    expect(() => agentIdentityContainment(
      "mp.agents) OR TRUE --",
      'https://agent.example.com/mcp',
      1,
    )).toThrow(/Unsafe agents column reference/);
  });
});
