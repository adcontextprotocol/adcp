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
 * When AgenticAdvertising.org grades a third-party agent, the only governance
 * agent it can vouch for is the public test agent's governance tenant. This
 * module builds the routed run for that topology:
 *
 * - the storyboard's `default_agent` key is the agent under test, with the
 *   owner's credentials;
 * - the `governance` key is the public governance tenant, authenticated with
 *   a per-run hosted-grader credential. The governance agent binds that
 *   credential to the fixed hosted-grader buyer agent
 *   (`HOSTED_GRADER_BUYER_AGENT_URL`), which becomes the intent token
 *   `caller`. Sellers map the credential they give hosted grading to that
 *   same buyer agent, so the seller's caller check can pass;
 * - the seller receives, in `sync_governance`, a per-run seller credential
 *   bound to exactly the agent under test's URL, so its execution-time
 *   `check_governance` authenticates as itself;
 * - any other agent key makes the storyboard unroutable. It is never sent to
 *   the agent under test.
 *
 * Trust boundaries:
 *
 * - The governance endpoint comes only from server config. Nothing the agent
 *   under test returns, nothing a member supplies, and nothing in run context
 *   can change it. The storyboard's authored `governance_agent_url` must name
 *   the same origin, or the storyboard is unroutable. It is also pinned in the
 *   initial context so a caller-supplied context cannot swap it.
 * - Both minted credentials are short-lived (30 minutes), bound to one run
 *   nonce, and usable only on the governance tenant for their side of that
 *   run's plans (training-agent/governance-agent-credentials.ts). Callers
 *   must scrub them from anything they store or log
 *   (`redactHostedGovernanceSecrets`).
 * - Every routed entry carries explicit `auth`. The SDK only falls back to
 *   the run-level `auth` for an entry without its own, so the owner's
 *   credential cannot reach the governance route and the grader credential
 *   is never on the agent-under-test entry or in context.
 * - Steps not pinned to the agent under test may not use step-level `auth`
 *   directives or `$test_kit.auth` references, and neither may storyboard
 *   context. Hosted runs copy the owner credential into the shared test kit,
 *   and an unpinned step can be routed to governance by protocol, so those
 *   could forward it to the governance agent.
 * - The public governance agent is one shared sandbox tenant, and the
 *   authored plan ids are fixed. Each routed run suffixes them with its nonce
 *   so concurrent runs cannot touch the plan a run is grading against, and the
 *   minted credentials only reach plans with that suffix.
 * - Run-level `headers` are shared across every routed agent by the SDK, so
 *   `withHostedMultiAgentRouting()` refuses to route a run that sets them
 *   (`comply()` enforces the same).
 * - SSRF: routed agents inherit the run-level `transport`, so the hosted
 *   safe fetch applied by `withSdkSafeTransport()` guards both routes.
 */

import { randomUUID } from 'node:crypto';

import type { StoryboardRunOptions } from '@adcp/sdk/testing';

import { PUBLIC_TEST_AGENT_URLS } from '../config/test-agent.js';
import {
  governanceAgentCredentialsEnabled,
  mintGovernanceAgentCredential,
  mintHostedGraderCredential,
} from '../training-agent/governance-agent-credentials.js';
import {
  HOSTED_GRADER_BRAND_DOMAIN,
  HOSTED_GRADER_BUYER_AGENT_URL,
} from '../training-agent/hosted-grader.js';

/** Authored agent key the governance storyboards route plan steps to. */
export const HOSTED_GOVERNANCE_AGENT_KEY = 'governance';

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

/** The governance side of one hosted run. Built per run; holds live secrets. */
export interface HostedGovernanceAgent {
  /** MCP endpoint the runner dispatches `agent: governance` steps to. */
  url: string;
  /** Per-run hosted-grader credential, presented only to `url`. */
  auth: { type: 'bearer'; token: string };
  /**
   * Buyer identity the governance agent binds to `auth`. Its
   * `check_governance` requires `caller` to equal the authenticated identity.
   */
  callerIdentity: string;
  /** Per-run credential for the seller to present on its execution checks. */
  sellerCredential: string;
  /** Suffix for this run's governance plan ids; both credentials are bound to it. */
  runNonce: string;
}

export type HostedGovernanceAgentResult =
  | { kind: 'ready'; governance: HostedGovernanceAgent }
  | { kind: 'unavailable'; reason: string };

export interface HostedGovernanceAgentOptions {
  /** Governance MCP endpoint. Tests and local e2e only; production uses server config. */
  url?: string;
  /** Tests only: allow an `http://127.0.0.1` agent under test. */
  allowLoopbackHttp?: boolean;
}

/**
 * Mint the governance side of one hosted run against `agentUnderTestUrl`.
 * Unavailable when this deployment has no governance credential secret, or
 * when the agent under test's URL cannot hold a seller credential (not HTTPS,
 * or an AgenticAdvertising.org / AdCP host).
 */
export function hostedGovernanceAgentForRun(
  agentUnderTestUrl: string,
  options: HostedGovernanceAgentOptions = {},
): HostedGovernanceAgentResult {
  if (!governanceAgentCredentialsEnabled()) {
    return { kind: 'unavailable', reason: 'hosted governance grading is not enabled on this deployment.' };
  }
  const runNonce = randomUUID();
  let sellerCredential: string;
  try {
    sellerCredential = mintGovernanceAgentCredential(agentUnderTestUrl, {
      nonce: runNonce,
      ...(options.allowLoopbackHttp && { allowLoopbackHttp: true }),
    });
  } catch (err) {
    return { kind: 'unavailable', reason: `the agent under test cannot be registered with the sandbox governance agent: ${(err as Error).message}` };
  }
  return {
    kind: 'ready',
    governance: {
      url: options.url ?? PUBLIC_TEST_AGENT_URLS.governance,
      auth: { type: 'bearer', token: mintHostedGraderCredential({ nonce: runNonce }) },
      callerIdentity: HOSTED_GRADER_BUYER_AGENT_URL,
      sellerCredential,
      runNonce,
    },
  };
}

/** Tags of the credentials this module mints (governance-agent-credentials.ts). */
const MINTED_CREDENTIAL_PATTERN = /adcp-sandbox-gov(?:-grader)?\.v1\.[A-Za-z0-9_.-]*/g;

/** Secrets a routed run carries; scrub them from stored or logged output. */
export function hostedGovernanceSecrets(governance: HostedGovernanceAgent): string[] {
  return [governance.auth.token, governance.sellerCredential];
}

/**
 * Replace every occurrence of `secrets` in string values (and keys) of a
 * JSON-like value with `[redacted]`. Returns a new value; the input is not
 * mutated. Used on run results before they are stored, rendered, or logged.
 */
export function redactHostedGovernanceSecrets<T>(value: T, secrets: Iterable<string>): T {
  const list = [...secrets].filter(secret => secret.length > 0);
  if (list.length === 0) return value;
  // Exact secrets first, then anything shaped like a minted credential, so a
  // truncated echo (e.g. an error cut at a length limit) is scrubbed too.
  const scrub = (text: string): string => list
    .reduce((acc, secret) => acc.split(secret).join('[redacted]'), text)
    .replace(MINTED_CREDENTIAL_PATTERN, '[redacted]');
  const walk = (node: unknown, seen: WeakMap<object, unknown>): unknown => {
    if (typeof node === 'string') return scrub(node);
    if (!node || typeof node !== 'object') return node;
    if (seen.has(node)) return seen.get(node);
    if (Array.isArray(node)) {
      const out: unknown[] = [];
      seen.set(node, out);
      for (const item of node) out.push(walk(item, seen));
      return out;
    }
    if (node instanceof Date) return node;
    const out: Record<string, unknown> = {};
    seen.set(node, out);
    for (const [key, child] of Object.entries(node)) out[scrub(key)] = walk(child, seen);
    return out;
  };
  return walk(value, new WeakMap()) as T;
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
  /** Wire protocol for `url` (`AgentEntry.transport`). Defaults to the run's protocol. */
  protocol?: RoutedAgentEntry['transport'];
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
    /** Storyboard to run: a patched copy (plan ids, caller, seller credential). */
    storyboard: S;
    agents: RoutedAgents;
    default_agent: string;
    /** Initial-context overrides. Applied over any caller-supplied context. */
    context: Record<string, string>;
    /** Ids of the steps the governance agent serves, for attributing results. */
    governance_step_ids: string[];
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

type SyncGovernanceAccount = {
  account?: { brand?: { domain?: unknown } };
  governance_agents?: Array<{ url?: unknown; authentication?: { credentials?: unknown } }>;
};

function syncGovernanceAccounts(request: unknown): SyncGovernanceAccount[] {
  const accounts = (request as { accounts?: unknown } | undefined)?.accounts;
  return Array.isArray(accounts) ? accounts.filter(a => a && typeof a === 'object') as SyncGovernanceAccount[] : [];
}

/**
 * Decide how hosted grading runs one storyboard against a third-party agent.
 *
 * Storyboards without `requires: [multi_agent]` are `single_agent` and keep
 * the existing single-URL run. `requires: [multi_agent]` storyboards are
 * `routed` only when every authored route resolves to the agent under test
 * or the configured governance agent, and the buyer is the hosted-grader
 * brand; otherwise they are `unroutable`, with a reason the caller reports
 * instead of running the storyboard.
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

  if (referencesTestKitAuth(storyboard.context)) {
    return unroutable('its context references test-kit credentials; hosted grading will not forward them across agents.');
  }
  const keys = new Set<string>();
  let syncGovernanceSteps = 0;
  for (const phase of storyboard.phases) {
    for (const step of phase.steps) {
      if (step.agent !== undefined) keys.add(step.agent);
      if (step.task === 'sync_governance') {
        syncGovernanceSteps += 1;
        if (step.agent !== defaultAgent) {
          return unroutable(`step "${step.id ?? step.task}" registers governance on an agent other than the agent under test.`);
        }
        // The buyer must be the hosted-grader brand: its brand.json is the
        // one that lists the sandbox governance agent, and the one sellers
        // map the hosted-grading credential to. Older bundles name a
        // `.example` brand a seller cannot verify against.
        const accounts = syncGovernanceAccounts(step.sample_request);
        if (accounts.length === 0 || accounts.some(a => a.account?.brand?.domain !== HOSTED_GRADER_BRAND_DOMAIN)) {
          return unroutable(
            `its buyer brand is not ${HOSTED_GRADER_BRAND_DOMAIN}, so a seller cannot resolve the brand.json that authorizes the sandbox governance agent. Grade against a compliance bundle that uses the hosted-grader brand.`,
          );
        }
      }
      // Unpinned steps route by protocol and may land on governance, so only
      // steps pinned to the agent under test may carry their own credentials.
      if (step.agent === defaultAgent) continue;
      if (step.auth !== undefined || referencesTestKitAuth(step.sample_request)) {
        return unroutable(
          `step "${step.id ?? step.task ?? '?'}" may be served by the governance agent but declares its own credentials; hosted grading will not forward test-kit credentials across agents.`,
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
  if (syncGovernanceSteps === 0) {
    return unroutable('it never registers the governance agent with the agent under test, so there is no seller credential to issue.');
  }

  const context: Record<string, string> = {};
  const authoredGovernanceUrl = storyboard.context?.governance_agent_url;
  if (authoredGovernanceUrl !== undefined
    && (typeof authoredGovernanceUrl !== 'string' || originOf(authoredGovernanceUrl) !== governanceOrigin)) {
    return unroutable(
      `its governance_agent_url names a governance agent other than the hosted one (${governanceOrigin}); the seller would be told to trust an agent the runner is not using.`,
    );
  }
  // Always pin it, so a caller-supplied initial context cannot point the
  // seller (and the seller credential) at a different governance agent.
  const pinnedGovernanceUrl = typeof authoredGovernanceUrl === 'string' ? authoredGovernanceUrl : governanceOrigin;
  context.governance_agent_url = pinnedGovernanceUrl;
  // The seller credential may only be registered for the hosted governance
  // agent. Any other registration target makes the storyboard unroutable.
  for (const phase of storyboard.phases) {
    for (const step of phase.steps) {
      if (step.task !== 'sync_governance') continue;
      for (const account of syncGovernanceAccounts(step.sample_request)) {
        for (const agent of account.governance_agents ?? []) {
          const url = agent && typeof agent === 'object' ? agent.url : undefined;
          if (url !== '$context.governance_agent_url' && url !== pinnedGovernanceUrl) {
            return unroutable(
              `step "${step.id ?? step.task}" registers a governance agent other than the hosted one; hosted grading only issues a seller credential for ${pinnedGovernanceUrl}.`,
            );
          }
        }
      }
    }
  }
  for (const key of HOSTED_GOVERNED_AGENT_CONTEXT_KEYS) {
    // The seller credential binds exactly this string, and the governance
    // agent uses it as the token audience.
    if (storyboard.context?.[key] !== undefined) context[key] = agentUnderTest.url;
  }

  const agents: RoutedAgents = {
    [defaultAgent]: {
      url: agentUnderTest.url,
      ...(agentUnderTest.auth && { auth: agentUnderTest.auth }),
      ...(agentUnderTest.protocol && { transport: agentUnderTest.protocol }),
    },
    [HOSTED_GOVERNANCE_AGENT_KEY]: {
      url: governance.url,
      // Explicit auth is load-bearing: without it the SDK falls back to the
      // run-level auth, which is the owner's credential for the agent under test.
      auth: { ...governance.auth },
      transport: 'mcp',
    },
  };

  // Patch a copy so the cached storyboard is untouched (loaded storyboards are
  // plain YAML data, so structuredClone is lossless). Only request payloads
  // change, as ComplyOptions.routeStoryboard requires.
  const nonce = governance.runNonce;
  const patched = structuredClone(storyboard) as S;
  const governanceStepIds: string[] = [];
  for (const phase of patched.phases) {
    for (const step of phase.steps) {
      const request = step.sample_request as Record<string, unknown> | undefined;
      if (step.task === 'sync_governance' && request && typeof request === 'object') {
        // The seller presents this credential on its execution checks; it
        // authenticates as exactly the agent under test, for this run only.
        for (const account of syncGovernanceAccounts(request)) {
          for (const agent of account.governance_agents ?? []) {
            if (!agent || typeof agent !== 'object') continue;
            agent.authentication = { ...(agent.authentication ?? {}), credentials: governance.sellerCredential };
          }
        }
      }
      if (step.agent !== HOSTED_GOVERNANCE_AGENT_KEY) continue;
      if (step.id) governanceStepIds.push(step.id);
      if (!request || typeof request !== 'object') continue;
      // The governance agent binds `caller` to the authenticated identity of
      // the credential it sees: the hosted-grader buyer agent.
      if (step.task === 'check_governance' && request.caller !== undefined) {
        request.caller = governance.callerIdentity;
      }
      // Later steps read the plan id back through `$context.plan_id`.
      if (step.task === 'sync_plans' && Array.isArray(request.plans)) {
        for (const plan of request.plans as Array<Record<string, unknown>>) {
          if (plan && typeof plan.plan_id === 'string') plan.plan_id = `${plan.plan_id}-${nonce}`;
        }
      }
    }
  }

  return {
    kind: 'routed',
    storyboard: patched,
    agents,
    default_agent: defaultAgent,
    context,
    governance_step_ids: governanceStepIds,
  };
}

/**
 * Apply a routed decision to hosted run options. Pass the result to
 * `runStoryboard('', routing.storyboard, options)`: the SDK requires an empty
 * positional URL when `agents` is set. Run-level `auth` is dropped so the
 * runner's `entry.auth ?? options.auth` fallback can never hand the owner's
 * credential to another agent.
 */
export function withHostedMultiAgentRouting<T extends StoryboardRunOptions>(
  options: T,
  routing: Extract<HostedMultiAgentRouting, { kind: 'routed' }>,
): T {
  if (options.headers && Object.keys(options.headers).length > 0) {
    throw new Error('Hosted multi-agent routing refuses run-level headers: the SDK sends them to every routed agent.');
  }
  const { auth: _runAuth, ...rest } = options;
  return {
    ...rest,
    agents: routing.agents,
    default_agent: routing.default_agent,
    context: { ...options.context, ...routing.context },
  } as T;
}
