/**
 * Unit test: trainingBuyerAgentRegistry resolves the right BuyerAgent
 * for each demo-bearer prefix family. Companion to the
 * sync-accounts-gates integration test, which exercises the framework's
 * end-to-end path; this test pins the resolver's prefix → billing_capabilities
 * mapping in isolation so a regression on the data shape surfaces here
 * before it surfaces against the framework.
 */

import { describe, it, expect } from 'vitest';
import type { AdcpCredential } from '@adcp/sdk/server';
import { trainingBuyerAgentRegistry } from './buyer-agent-registry.js';

// Synthesize a BuyerAgentResolveInput as the framework would construct it
// from a `verifyApiKey({ verify })` callback that stamped extra:
// { demo_token: <token> } on its returned AuthPrincipal.
function input(
  token: string | undefined,
  kind: AdcpCredential['kind'] = 'api_key',
): { credential: AdcpCredential; extra?: Record<string, unknown> } {
  const credential: AdcpCredential =
    kind === 'api_key'
      ? { kind: 'api_key', key_id: `sha256:hash-of-${token}` }
      : kind === 'oauth'
        ? { kind: 'oauth', client_id: 'unused', scopes: [] }
        : { kind: 'http_sig', keyid: 'unused', agent_url: 'unused', verified_at: 0 };
  return token === undefined
    ? { credential }
    : { credential, extra: { demo_token: token } };
}

describe('trainingBuyerAgentRegistry', () => {
  it('passthrough-only token → BuyerAgent with billing_capabilities {operator}', async () => {
    const agent = await trainingBuyerAgentRegistry.resolve(
      input('demo-billing-passthrough-v1'),
    );
    expect(agent).not.toBeNull();
    expect(agent?.status).toBe('active');
    expect([...(agent?.billing_capabilities ?? [])].sort()).toEqual(['operator']);
    expect(agent?.agent_url).toContain('demo/demo-billing-passthrough-v1');
  });

  it('agent-billable token → BuyerAgent with billing_capabilities {operator, agent, advertiser}', async () => {
    const agent = await trainingBuyerAgentRegistry.resolve(
      input('demo-billing-agent-billable-v1'),
    );
    expect(agent).not.toBeNull();
    expect(agent?.status).toBe('active');
    expect([...(agent?.billing_capabilities ?? [])].sort()).toEqual([
      'advertiser',
      'agent',
      'operator',
    ]);
  });

  it('unrecognized demo prefix → null (uniform-response rule)', async () => {
    // demo-* token that doesn't match any known commercial-relationship
    // prefix family. Resolver returns null, framework leaves ctx.agent
    // undefined, no per-agent gate fires.
    const agent = await trainingBuyerAgentRegistry.resolve(
      input('demo-unrecognized-v1'),
    );
    expect(agent).toBeNull();
  });

  it('missing extra.demo_token → null', async () => {
    // Static-key authenticators (TRAINING_AGENT_TOKEN /
    // PUBLIC_TEST_AGENT_TOKEN) don't stamp demo_token; resolver returns
    // null and falls through. No commercial relationship inferred for
    // production-shaped principals — security posture matches
    // commercial-relationships.ts.
    const agent = await trainingBuyerAgentRegistry.resolve(input(undefined));
    expect(agent).toBeNull();
  });

  it('non-string extra.demo_token → null (defensive type-check)', async () => {
    // Adopter-supplied extra is Record<string, unknown> — the resolver
    // shape-checks before using.
    const agent = await trainingBuyerAgentRegistry.resolve({
      credential: { kind: 'api_key', key_id: 'sha256:x' },
      extra: { demo_token: 12345 as unknown as string },
    });
    expect(agent).toBeNull();
  });

  it('http_sig credential → null (bearerOnly factory rejects signed traffic)', async () => {
    // The training-agent uses bearerOnly; signed traffic is refused at
    // the registry layer regardless of extra. Documented behavior of
    // BuyerAgentRegistry.bearerOnly per the SDK factory's posture.
    const agent = await trainingBuyerAgentRegistry.resolve(
      input('demo-billing-passthrough-v1', 'http_sig'),
    );
    expect(agent).toBeNull();
  });
});
