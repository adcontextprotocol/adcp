import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { loadStoryboardFile, type Storyboard } from '@adcp/sdk/testing';
import { verifyApiKey } from '@adcp/sdk/server';

import {
  HOSTED_GOVERNANCE_AGENT_KEY,
  hostedGovernanceAgent,
  hostedMultiAgentRoutingForStoryboard,
  trainingAgentCallerIdentityForToken,
  withHostedMultiAgentRouting,
  type HostedGovernanceAgent,
  type HostedRoutableStoryboard,
} from '../../src/compliance/hosted-multi-agent-routing.js';
import { PUBLIC_TEST_AGENT, PUBLIC_TEST_AGENT_URLS } from '../../src/config/test-agent.js';
import { trainingBuyerAgentRegistry } from '../../src/training-agent/buyer-agent-registry.js';

const SOURCE = resolve(__dirname, '../../../static/compliance/source');
const SELLER_URL = 'https://seller.third-party.example/mcp';
const SELLER_TOKEN = 'owner-secret-seller-token-0123456789';
const GOVERNANCE: HostedGovernanceAgent = {
  url: 'https://test-agent.adcontextprotocol.org/governance/mcp',
  auth: { type: 'bearer', token: 'public-governance-token-abcdef' },
  callerIdentity: 'https://training-agent.adcontextprotocol.org/authenticated/abc',
};

function load(relativePath: string): Storyboard {
  return loadStoryboardFile(resolve(SOURCE, relativePath));
}

const GOVERNANCE_CONDITIONS = 'protocols/media-buy/scenarios/governance_conditions.yaml';

const ROUTED_STORYBOARDS: Array<[string, string]> = [
  [GOVERNANCE_CONDITIONS, 'sales'],
  ['protocols/media-buy/scenarios/governance_approved.yaml', 'sales'],
  ['protocols/media-buy/scenarios/governance_denied.yaml', 'sales'],
  ['protocols/media-buy/scenarios/governance_denied_recovery.yaml', 'sales'],
  ['specialisms/brand-rights/scenarios/governance_approved.yaml', 'brand'],
  ['specialisms/signal-marketplace/scenarios/governance_approved.yaml', 'signals'],
  ['specialisms/creative-transformers/scenarios/governance_approved.yaml', 'creative-builder'],
];

const SELLER_AUTH = { type: 'bearer' as const, token: SELLER_TOKEN };

/** `auth: null` grades an agent the owner configured without credentials. */
function route(storyboard: HostedRoutableStoryboard, auth: typeof SELLER_AUTH | null = SELLER_AUTH) {
  return hostedMultiAgentRoutingForStoryboard({
    storyboard,
    agentUnderTest: { url: SELLER_URL, ...(auth && { auth }) },
    governance: GOVERNANCE,
  });
}

function routed(storyboard: HostedRoutableStoryboard, auth: typeof SELLER_AUTH | null = SELLER_AUTH) {
  const result = route(storyboard, auth);
  if (result.kind !== 'routed') throw new Error(`expected routed, got ${JSON.stringify(result)}`);
  return result;
}

function synthetic(overrides: Partial<HostedRoutableStoryboard> = {}): HostedRoutableStoryboard {
  return {
    id: 'synthetic/multi_agent',
    requires: ['multi_agent'],
    default_agent: 'sales',
    context: { governance_agent_url: 'https://test-agent.adcontextprotocol.org', seller_agent_url: 'https://seller.example.com' },
    phases: [{
      steps: [
        { id: 'sync_plans', task: 'sync_plans', agent: 'governance', sample_request: { plans: [] } },
        { id: 'get_products', task: 'get_products', agent: 'sales', sample_request: {} },
      ],
    }],
    ...overrides,
  };
}

describe('hostedMultiAgentRoutingForStoryboard', () => {
  it('routes governance_conditions: default_agent to the seller, governance steps to the public governance agent', () => {
    const storyboard = load(GOVERNANCE_CONDITIONS);
    const result = routed(storyboard);

    expect(result.default_agent).toBe('sales');
    expect(Object.keys(result.agents).sort()).toEqual(['governance', 'sales']);
    expect(result.agents.sales).toEqual({ url: SELLER_URL, auth: { type: 'bearer', token: SELLER_TOKEN } });
    expect(result.agents.governance).toEqual({ url: GOVERNANCE.url, auth: GOVERNANCE.auth, transport: 'mcp' });
    expect(result.context).toEqual({
      governance_agent_url: 'https://test-agent.adcontextprotocol.org',
      seller_agent_url: SELLER_URL,
    });

    // sync_plans (the step that failed in #7758) is authored to governance.
    const syncPlans = result.storyboard.phases.flatMap(p => p.steps).find(s => s.task === 'sync_plans');
    expect(syncPlans?.agent).toBe(HOSTED_GOVERNANCE_AGENT_KEY);
    expect(result.governance_step_ids).toContain('sync_plans');
    expect(result.governance_step_ids).not.toContain('create_media_buy');
  });

  it('gives each run its own plan id on the shared governance tenant', () => {
    const storyboard = load(GOVERNANCE_CONDITIONS);
    const first = hostedMultiAgentRoutingForStoryboard({
      storyboard,
      agentUnderTest: { url: SELLER_URL },
      governance: GOVERNANCE,
      runNonce: 'run-a',
    });
    const second = hostedMultiAgentRoutingForStoryboard({ storyboard, agentUnderTest: { url: SELLER_URL }, governance: GOVERNANCE });
    const third = hostedMultiAgentRoutingForStoryboard({ storyboard, agentUnderTest: { url: SELLER_URL }, governance: GOVERNANCE });
    const planId = (r: typeof first) => {
      if (r.kind !== 'routed') throw new Error('expected routed');
      const step = r.storyboard.phases.flatMap(p => p.steps).find(s => s.task === 'sync_plans');
      return ((step?.sample_request as { plans: Array<{ plan_id: string }> }).plans[0]).plan_id;
    };
    expect(planId(first)).toBe('comply-gov-conditions-plan-run-a');
    expect(planId(second)).toMatch(/^comply-gov-conditions-plan-[0-9a-f-]{36}$/);
    expect(planId(second)).not.toBe(planId(third));
  });

  it('binds governance check_governance caller to our identity on a copy, leaving the cached storyboard untouched', () => {
    const storyboard = load(GOVERNANCE_CONDITIONS);
    const before = structuredClone(storyboard);
    const result = routed(storyboard);
    routed(storyboard);

    const checks = result.storyboard.phases
      .flatMap(p => p.steps)
      .filter(s => s.agent === 'governance' && s.task === 'check_governance');
    expect(checks.length).toBeGreaterThan(0);
    for (const step of checks) {
      expect((step.sample_request as Record<string, unknown>).caller).toBe(GOVERNANCE.callerIdentity);
    }
    expect(storyboard).toEqual(before);
    expect(result.storyboard).not.toBe(storyboard);
  });

  it.each(ROUTED_STORYBOARDS)('routes every shipped multi_agent storyboard (%s)', (file, defaultAgent) => {
    const result = routed(load(file));
    expect(result.default_agent).toBe(defaultAgent);
    expect(Object.keys(result.agents).sort()).toEqual([defaultAgent, 'governance'].sort());
    expect(result.agents[defaultAgent].url).toBe(SELLER_URL);
    expect(result.agents.governance.url).toBe(GOVERNANCE.url);
  });

  it('leaves storyboards that do not require multi_agent on the single-agent path', () => {
    expect(route(load('protocols/media-buy/scenarios/governance_agent_binding_acceptance.yaml'))).toEqual({
      kind: 'single_agent',
    });
    expect(route(synthetic({ requires: undefined }))).toEqual({ kind: 'single_agent' });
    expect(route(synthetic({ requires: ['controller'] }))).toEqual({ kind: 'single_agent' });
  });

  it('reports unknown agent keys as unroutable instead of sending them to the seller', () => {
    const result = route(synthetic({
      phases: [{
        steps: [
          { id: 'sync_plans', task: 'sync_plans', agent: 'governance' },
          { id: 'get_signals', task: 'get_signals', agent: 'signals' },
          { id: 'get_products', task: 'get_products', agent: 'sales' },
        ],
      }],
    }));
    expect(result.kind).toBe('unroutable');
    if (result.kind !== 'unroutable') return;
    expect(result.reason).toContain('"signals"');
    expect(result).not.toHaveProperty('agents');
  });

  it('is unroutable without a default_agent, with a governance default_agent, or without a governance route', () => {
    expect(route(synthetic({ default_agent: undefined })).kind).toBe('unroutable');
    expect(route(synthetic({ default_agent: 'governance' })).kind).toBe('unroutable');
    expect(route(synthetic({
      phases: [{ steps: [{ id: 'get_products', task: 'get_products', agent: 'sales' }] }],
    })).kind).toBe('unroutable');
  });

  describe('credential isolation', () => {
    it('never puts the seller credential on the governance route or the governance credential on the seller route', () => {
      const result = routed(load(GOVERNANCE_CONDITIONS));
      const { governance, sales } = result.agents;

      expect(JSON.stringify(governance)).not.toContain(SELLER_TOKEN);
      expect(JSON.stringify(sales)).not.toContain(GOVERNANCE.auth.token);
      expect(JSON.stringify(result.context)).not.toContain(GOVERNANCE.auth.token);
      expect(JSON.stringify(result.storyboard)).not.toContain(GOVERNANCE.auth.token);
      expect(JSON.stringify(result.storyboard)).not.toContain(SELLER_TOKEN);
    });

    it('gives the governance route explicit auth even when the seller has none, so the SDK cannot fall back to run-level auth', () => {
      // @adcp/sdk buildAgentOptions: `auth: entry.auth ?? options.auth`.
      const result = routed(load(GOVERNANCE_CONDITIONS), null);
      expect(result.agents.sales).toEqual({ url: SELLER_URL });
      expect(result.agents.governance.auth).toEqual(GOVERNANCE.auth);

      const options = withHostedMultiAgentRouting({ auth: { type: 'bearer', token: SELLER_TOKEN } }, result);
      const governanceEntry = options.agents!.governance;
      // Emulate the SDK's per-agent resolution for the governance entry.
      const effectiveGovernanceAuth = governanceEntry.auth ?? options.auth;
      expect(effectiveGovernanceAuth).toEqual(GOVERNANCE.auth);
      expect(JSON.stringify(effectiveGovernanceAuth)).not.toContain(SELLER_TOKEN);
    });

    it('does not share one auth object between routes', () => {
      const result = routed(load(GOVERNANCE_CONDITIONS));
      expect(result.agents.governance.auth).not.toBe(GOVERNANCE.auth);
    });

    it('refuses governance steps that would pull test-kit credentials (hosted copies the owner token into the test kit)', () => {
      const withAuthDirective = route(synthetic({
        phases: [{
          steps: [
            { id: 'sync_plans', task: 'sync_plans', agent: 'governance', auth: { from_test_kit: true } },
            { id: 'get_products', task: 'get_products', agent: 'sales' },
          ],
        }],
      }));
      expect(withAuthDirective.kind).toBe('unroutable');

      const unpinnedWithAuth = route(synthetic({
        phases: [{
          steps: [
            { id: 'sync_plans', task: 'sync_plans', agent: 'governance' },
            { id: 'check_governance', task: 'check_governance', auth: { from_test_kit: true } },
            { id: 'get_products', task: 'get_products', agent: 'sales', auth: { from_test_kit: true } },
          ],
        }],
      }));
      expect(unpinnedWithAuth.kind).toBe('unroutable');
      if (unpinnedWithAuth.kind === 'unroutable') expect(unpinnedWithAuth.reason).toContain('check_governance');

      const sellerPinnedWithAuth = route(synthetic({
        phases: [{
          steps: [
            { id: 'sync_plans', task: 'sync_plans', agent: 'governance' },
            { id: 'get_products', task: 'get_products', agent: 'sales', auth: { from_test_kit: true } },
          ],
        }],
      }));
      expect(sellerPinnedWithAuth.kind).toBe('routed');

      const contextKitReference = route(synthetic({
        context: { governance_agent_url: 'https://test-agent.adcontextprotocol.org', token: '$test_kit.auth.api_key' },
      }));
      expect(contextKitReference.kind).toBe('unroutable');

      const withKitReference = route(synthetic({
        phases: [{
          steps: [
            { id: 'sync_plans', task: 'sync_plans', agent: 'governance', sample_request: { token: '$test_kit.auth.api_key' } },
            { id: 'get_products', task: 'get_products', agent: 'sales' },
          ],
        }],
      }));
      expect(withKitReference.kind).toBe('unroutable');
    });

    it('refuses run-level headers, which the SDK shares across every routed agent', () => {
      const result = routed(load(GOVERNANCE_CONDITIONS));
      expect(() => withHostedMultiAgentRouting({ headers: { 'x-owner-secret': 'v' } }, result)).toThrow(/headers/);
      expect(() => withHostedMultiAgentRouting({ headers: {} }, result)).not.toThrow();
    });
  });

  describe('governance endpoint is not overridable by untrusted input', () => {
    it('rejects a storyboard whose governance_agent_url names another origin', () => {
      const result = route(synthetic({
        context: { governance_agent_url: 'https://attacker.example', seller_agent_url: 'https://seller.example.com' },
      }));
      expect(result.kind).toBe('unroutable');
    });

    it('rejects a non-string governance_agent_url', () => {
      expect(route(synthetic({ context: { governance_agent_url: 42 } })).kind).toBe('unroutable');
    });

    it('pins governance_agent_url and seller_agent_url over caller-supplied context', () => {
      const result = routed(load(GOVERNANCE_CONDITIONS));
      const options = withHostedMultiAgentRouting({
        context: {
          governance_agent_url: 'https://attacker.example/mcp',
          seller_agent_url: 'https://someone-else.example/mcp',
          unrelated: 'kept',
        },
      }, result);
      expect(options.context).toEqual({
        governance_agent_url: 'https://test-agent.adcontextprotocol.org',
        seller_agent_url: SELLER_URL,
        unrelated: 'kept',
      });
      expect(options.agents!.governance.url).toBe(GOVERNANCE.url);
    });

    it('routes governance to the configured endpoint regardless of what the agent under test is', () => {
      const result = hostedMultiAgentRoutingForStoryboard({
        storyboard: load(GOVERNANCE_CONDITIONS),
        agentUnderTest: { url: 'https://attacker.example/governance/mcp' },
        governance: GOVERNANCE,
      });
      if (result.kind !== 'routed') throw new Error('expected routed');
      expect(result.agents.governance.url).toBe(GOVERNANCE.url);
      expect(result.agents.sales.url).toBe('https://attacker.example/governance/mcp');
    });

    it('rejects a non-HTTPS configured governance endpoint', () => {
      const result = hostedMultiAgentRoutingForStoryboard({
        storyboard: load(GOVERNANCE_CONDITIONS),
        agentUnderTest: { url: SELLER_URL },
        governance: { ...GOVERNANCE, url: 'http://test-agent.adcontextprotocol.org/governance/mcp' },
      });
      expect(result.kind).toBe('unroutable');
    });
  });

  it('keeps the run-level transport so the hosted safe fetch guards both routes', () => {
    const fetchFn = (() => Promise.reject(new Error('unused'))) as typeof fetch;
    const result = routed(load(GOVERNANCE_CONDITIONS));
    const options = withHostedMultiAgentRouting({ transport: { fetchFn } } as never, result) as { transport?: { fetchFn?: unknown } };
    expect(options.transport?.fetchFn).toBe(fetchFn);
  });
});

describe('hostedGovernanceAgent', () => {
  it('uses the public test agent governance tenant and public credential from server config', () => {
    const governance = hostedGovernanceAgent();
    expect(governance.url).toBe(PUBLIC_TEST_AGENT_URLS.governance);
    expect(new URL(governance.url).protocol).toBe('https:');
    expect(new URL(governance.url).pathname).toBe('/governance/mcp');
    expect(governance.auth).toEqual({ type: 'bearer', token: PUBLIC_TEST_AGENT.token });
    expect(governance.callerIdentity).toBe(trainingAgentCallerIdentityForToken(PUBLIC_TEST_AGENT.token));
  });

  it('shares the governance origin with the authored governance_agent_url', () => {
    const storyboard = load(GOVERNANCE_CONDITIONS);
    expect(new URL(String(storyboard.context?.governance_agent_url)).origin)
      .toBe(new URL(hostedGovernanceAgent().url).origin);
  });

  it('derives the same caller identity the training agent binds to the credential', async () => {
    const token = 'identity-check-token';
    // Take key_id from the SDK authenticator the training agent uses, not
    // from our own derivation, so a format change (e.g. a `sha256:` prefix)
    // breaks this test.
    const authenticate = verifyApiKey({ keys: { [token]: { principal: 'static:public' } } });
    const principal = await authenticate({ headers: { authorization: `Bearer ${token}` } } as never);
    const credential = (principal as { credential?: { kind: 'api_key'; key_id: string } } | null)?.credential;
    expect(credential?.kind).toBe('api_key');
    const agent = await trainingBuyerAgentRegistry.resolve({ credential: credential! });
    expect(agent?.agent_url).toBe(trainingAgentCallerIdentityForToken(token));
  });
});
