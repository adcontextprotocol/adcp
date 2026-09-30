/**
 * Multi-agent routing for hosted grading of third-party agents (#7758).
 *
 * Storyboards that declare `requires: [multi_agent]` (the governance-aware
 * seller scenarios, and their brand/signals/creative siblings) send their
 * plan-setup and intent-check steps (`agent: governance`) to a governance
 * agent and everything else to the agent under test (`default_agent`). A
 * single-URL run cannot satisfy that, so the SDK skips them with
 * `requirement_unmet`, and a seller that claims the capability can never
 * complete its bundle.
 *
 * When AAO grades a third-party agent, the only governance agent it can
 * vouch for is the public test agent's governance tenant. This module builds
 * the routed run for that topology:
 *
 * - the storyboard's `default_agent` key is the agent under test, with the
 *   owner's credentials;
 * - the `governance` key is the public governance tenant, with the public
 *   test-agent credential from server config;
 * - any other agent key makes the storyboard unroutable. It is never sent to
 *   the agent under test.
 *
 * Trust boundaries:
 *
 * - The governance endpoint and credential come only from server config
 *   (`hostedGovernanceAgent()`). Nothing the agent under test returns,
 *   nothing a member supplies, and nothing in run context can change them.
 *   The storyboard's authored `governance_agent_url` must name the same
 *   origin, or the storyboard is unroutable. It is also pinned in the initial
 *   context so a caller-supplied context cannot swap it.
 * - Every routed entry carries explicit `auth`. The SDK only falls back to
 *   the run-level `auth` for an entry without its own, so the owner's
 *   credential cannot reach the governance route and the public credential
 *   is never on the agent-under-test entry or in context.
 * - Steps routed to governance may not use step-level `auth` directives or
 *   `$test_kit.auth` references. Hosted runs copy the owner credential into
 *   the shared test kit, so those would forward it to the governance agent.
 * - Run-level `headers` are shared across every routed agent by the SDK, so
 *   `withHostedMultiAgentRouting()` refuses to route a run that sets them.
 * - SSRF: routed agents inherit the run-level `transport`, so the hosted
 *   safe fetch applied by `withSdkSafeTransport()` guards both routes.
 */

import { createHash } from 'node:crypto';

import type { StoryboardRunOptions } from '@adcp/sdk/testing';

import { PUBLIC_TEST_AGENT, PUBLIC_TEST_AGENT_URLS } from '../config/test-agent.js';

/** Authored agent key the governance storyboards route plan steps to. */
export const HOSTED_GOVERNANCE_AGENT_KEY = 'governance';

/**
 * Base URL the training agent uses for the buyer-agent identity it binds to
 * an API-key credential (`server/src/training-agent/buyer-agent-registry.ts`).
 */
const TRAINING_BUYER_AGENT_BASE_URL = 'https://training-agent.adcontextprotocol.org';

/**
 * Authored context keys that name the governed agent under test. The
 * storyboards' prerequisites tell the runner to override these with the
 * endpoint it is grading; the governance agent binds the token audience to it.
 */
export const HOSTED_GOVERNED_AGENT_CONTEXT_KEYS = [
  'seller_agent_url',
  'signal_agent_url',
  'brand_agent_url',
  'creative_agent_url',
] as const;

type RoutedAgents = NonNullable<StoryboardRunOptions['agents']>;
type RoutedAgentEntry = RoutedAgents[string];
type RunAuth = NonNullable<StoryboardRunOptions['auth']>;

export interface HostedGovernanceAgent {
  /** MCP endpoint the runner dispatches `agent: governance` steps to. */
  url: string;
  /** Credential presented only to `url`. */
  auth: { type: 'bearer'; token: string };
  /**
   * Buyer identity the governance agent binds to `auth`. Its
   * `check_governance` requires `caller` to equal the authenticated identity.
   */
  callerIdentity: string;
}

/** Buyer-agent identity the training agent binds to a bearer API key. */
export function trainingAgentCallerIdentityForToken(token: string): string {
  // Mirrors @adcp/sdk verifyApiKey's key_id (sha256 hex, 32 chars) and the
  // training agent's neutral authenticated buyer-agent URL.
  const keyId = createHash('sha256').update(token).digest('hex').slice(0, 32);
  return `${TRAINING_BUYER_AGENT_BASE_URL}/authenticated/${keyId}`;
}

/** The public governance agent hosted grading routes governance steps to. */
export function hostedGovernanceAgent(): HostedGovernanceAgent {
  const token = PUBLIC_TEST_AGENT.token;
  return {
    url: PUBLIC_TEST_AGENT_URLS.governance,
    auth: { type: 'bearer', token },
    callerIdentity: trainingAgentCallerIdentityForToken(token),
  };
}

/** Structural subset of a storyboard the router reads and patches. */
export interface HostedRoutableStoryboard {
  id: string;
  requires?: readonly string[];
  default_agent?: string;
  context?: Record<string, unknown>;
  phases: ReadonlyArray<{
    steps: ReadonlyArray<{
      id?: string;
      task?: string;
      agent?: string;
      auth?: unknown;
      sample_request?: unknown;
    }>;
  }>;
}

export interface HostedAgentUnderTest {
  /** Endpoint being graded. Already validated by the caller's URL/SSRF policy. */
  url: string;
  /** Owner-supplied credential for `url`, if any. */
  auth?: RunAuth;
  transport?: RoutedAgentEntry['transport'];
}

export interface HostedMultiAgentRoutingInput<S extends HostedRoutableStoryboard> {
  storyboard: S;
  agentUnderTest: HostedAgentUnderTest;
  governance: HostedGovernanceAgent;
}

export type HostedMultiAgentRouting<S extends HostedRoutableStoryboard = HostedRoutableStoryboard> =
  | { kind: 'single_agent' }
  | {
    kind: 'routed';
    /** Storyboard to run: a copy with governance `caller` bound to our identity. */
    storyboard: S;
    agents: RoutedAgents;
    default_agent: string;
    /** Initial-context overrides. Applied over any caller-supplied context. */
    context: Record<string, string>;
  }
  | { kind: 'unroutable'; reason: string };

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function referencesTestKitAuth(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('$test_kit.auth');
  if (Array.isArray(value)) return value.some(referencesTestKitAuth);
  if (value && typeof value === 'object') return Object.values(value).some(referencesTestKitAuth);
  return false;
}

/**
 * Decide how hosted grading runs one storyboard against a third-party agent.
 *
 * Storyboards without `requires: [multi_agent]` are `single_agent` and keep
 * the existing single-URL run. `requires: [multi_agent]` storyboards are
 * `routed` only when every authored route resolves to the agent under test
 * or the configured governance agent; otherwise they are `unroutable`, with
 * a reason the caller reports instead of running the storyboard.
 */
export function hostedMultiAgentRoutingForStoryboard<S extends HostedRoutableStoryboard>(
  input: HostedMultiAgentRoutingInput<S>,
): HostedMultiAgentRouting<S> {
  const { storyboard, agentUnderTest, governance } = input;
  if (!storyboard.requires?.includes('multi_agent')) return { kind: 'single_agent' };

  const unroutable = (why: string): HostedMultiAgentRouting<S> => ({
    kind: 'unroutable',
    reason: `${storyboard.id} requires multi_agent but cannot be routed by hosted grading: ${why}`,
  });

  const defaultAgent = storyboard.default_agent;
  if (!defaultAgent) return unroutable('it declares no default_agent, so the agent under test is ambiguous.');
  if (defaultAgent === HOSTED_GOVERNANCE_AGENT_KEY) {
    return unroutable('its default_agent is the governance agent, which hosted grading supplies rather than grades.');
  }

  const governanceOrigin = originOf(governance.url);
  if (!governanceOrigin || new URL(governance.url).protocol !== 'https:') {
    return unroutable('the configured governance agent URL is not a valid HTTPS URL.');
  }

  const keys = new Set<string>();
  for (const phase of storyboard.phases) {
    for (const step of phase.steps) {
      if (step.agent === undefined) continue;
      keys.add(step.agent);
      if (step.agent !== HOSTED_GOVERNANCE_AGENT_KEY) continue;
      if (step.auth !== undefined || referencesTestKitAuth(step.sample_request)) {
        return unroutable(
          `step "${step.id ?? step.task ?? '?'}" is routed to the governance agent but declares its own credentials; hosted grading will not forward test-kit credentials across agents.`,
        );
      }
    }
  }
  const unknownKeys = [...keys].filter(key => key !== defaultAgent && key !== HOSTED_GOVERNANCE_AGENT_KEY);
  if (unknownKeys.length > 0) {
    return unroutable(
      `it routes steps to agent key(s) ${unknownKeys.map(k => `"${k}"`).join(', ')}; hosted grading can only supply the agent under test ("${defaultAgent}") and the public governance agent ("${HOSTED_GOVERNANCE_AGENT_KEY}").`,
    );
  }
  if (!keys.has(HOSTED_GOVERNANCE_AGENT_KEY)) {
    return unroutable(`it routes no steps to "${HOSTED_GOVERNANCE_AGENT_KEY}", so there is no second agent for hosted grading to supply.`);
  }

  const context: Record<string, string> = {};
  const authoredGovernanceUrl = storyboard.context?.governance_agent_url;
  if (authoredGovernanceUrl !== undefined) {
    if (typeof authoredGovernanceUrl !== 'string' || originOf(authoredGovernanceUrl) !== governanceOrigin) {
      return unroutable(
        `its governance_agent_url names a governance agent other than the hosted one (${governanceOrigin}); the seller would be told to trust an agent the runner is not using.`,
      );
    }
    // Pin the authored value so a caller-supplied initial context cannot
    // point the seller at a different governance agent.
    context.governance_agent_url = authoredGovernanceUrl;
  }
  for (const key of HOSTED_GOVERNED_AGENT_CONTEXT_KEYS) {
    if (storyboard.context?.[key] !== undefined) context[key] = agentUnderTest.url;
  }

  const agents: RoutedAgents = {
    [defaultAgent]: {
      url: agentUnderTest.url,
      ...(agentUnderTest.auth && { auth: agentUnderTest.auth }),
      ...(agentUnderTest.transport && { transport: agentUnderTest.transport }),
    },
    [HOSTED_GOVERNANCE_AGENT_KEY]: {
      url: governance.url,
      // Explicit auth is load-bearing: without it the SDK falls back to the
      // run-level auth, which is the owner's credential for the agent under test.
      auth: { ...governance.auth },
      transport: 'mcp',
    },
  };

  // The governance agent binds `caller` to the authenticated identity of the
  // credential it sees, which is ours. Patch a copy so the cached storyboard
  // is untouched.
  const patched = structuredClone(storyboard) as S;
  for (const phase of patched.phases) {
    for (const step of phase.steps) {
      if (step.agent !== HOSTED_GOVERNANCE_AGENT_KEY || step.task !== 'check_governance') continue;
      const request = step.sample_request as Record<string, unknown> | undefined;
      if (request && typeof request === 'object' && request.caller !== undefined) {
        request.caller = governance.callerIdentity;
      }
    }
  }

  return { kind: 'routed', storyboard: patched, agents, default_agent: defaultAgent, context };
}

/**
 * Apply a routed decision to hosted run options. Pass the result to
 * `runStoryboard('', routing.storyboard, options)`: the SDK requires an empty
 * positional URL when `agents` is set.
 */
export function withHostedMultiAgentRouting<T extends StoryboardRunOptions>(
  options: T,
  routing: Extract<HostedMultiAgentRouting, { kind: 'routed' }>,
): T {
  if (options.headers && Object.keys(options.headers).length > 0) {
    throw new Error('Hosted multi-agent routing refuses run-level headers: the SDK sends them to every routed agent.');
  }
  return {
    ...options,
    agents: routing.agents,
    default_agent: routing.default_agent,
    context: { ...options.context, ...routing.context },
  };
}
