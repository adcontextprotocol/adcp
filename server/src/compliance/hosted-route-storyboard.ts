/**
 * Per-storyboard routing for hosted suite runs (`comply()`), through the
 * SDK's `ComplyOptions.routeStoryboard` hook (@adcp/sdk rc.53+).
 *
 * Two storyboard families cannot be graded correctly by one shared run
 * configuration:
 *
 * 1. `requires: [multi_agent]` governance storyboards (#7758). They route to
 *    the agent under test plus the sandbox governance agent; see
 *    hosted-multi-agent-routing.ts.
 * 2. Storyboards whose declared test kit is a live-mode principal
 *    (`sandbox: false`, e.g. `comply_controller_mode_gate`, #7772). Hosted
 *    runs copy the owner's grading credential into the run-level test kit,
 *    and the SDK then never loads the declared kit, so `from_test_kit` steps
 *    were sent as the owner's sandbox principal. This hook runs those steps
 *    with the declared kit's live-mode key instead, sent only to the agent
 *    under test.
 *
 * Everything else returns `undefined`, and `comply()` runs it as before.
 */

import type { ComplyOptions } from '@adcp/sdk/testing';

import type { TestKit } from '../services/storyboards.js';
import {
  hostedGovernanceAgentForRun,
  hostedGovernanceSecrets,
  hostedMultiAgentRoutingForStoryboard,
  type HostedAgentUnderTest,
  type HostedGovernanceAgentOptions,
  type HostedRoutableStoryboard,
} from './hosted-multi-agent-routing.js';

type RouteStoryboard = NonNullable<ComplyOptions['routeStoryboard']>;
type RouteStoryboardArg = Parameters<RouteStoryboard>[0];
type RouteResult = Awaited<ReturnType<RouteStoryboard>>;

/** Key of the agent under test in the single-entry live-mode route. */
export const LIVE_MODE_AGENT_KEY = 'agent_under_test';

export interface HostedRouteStoryboardInput {
  /** Owner credential for the agent under test (the run-level `auth`). */
  auth?: HostedAgentUnderTest['auth'];
  /** Wire protocol for the agent under test, when known. */
  protocol?: HostedAgentUnderTest['protocol'];
  /**
   * Resolve a storyboard's declared test kit from the compliance bundle the
   * run grades against (`getTestKitForStoryboard`).
   */
  resolveTestKit: (storyboardId: string) => TestKit | undefined;
  /** Collects every minted credential so the caller can scrub run output. */
  secrets: Set<string>;
  /** Tests and local e2e only. */
  governance?: HostedGovernanceAgentOptions;
}

interface LiveModeKitAuth {
  api_key?: unknown;
}

type StepWithAuth = { auth?: unknown };

function isFromTestKitApiKey(auth: unknown): boolean {
  return !!auth
    && typeof auth === 'object'
    && (auth as { type?: unknown }).type === 'api_key'
    && (auth as { from_test_kit?: unknown }).from_test_kit === true;
}

/**
 * Route a storyboard whose declared kit is a live-mode principal so its
 * `from_test_kit` steps carry that kit's key (#7772). Only applies when every
 * step reads the kit's API key, so no step that expects the owner's sandbox
 * principal is affected. The key goes only to the agent under test.
 */
export function liveModeTestKitRoute(
  storyboard: RouteStoryboardArg,
  agentUrl: string,
  kit: TestKit | undefined,
): RouteResult {
  if (!kit || kit.sandbox !== false) return undefined;
  const apiKey = (kit.auth as LiveModeKitAuth | undefined)?.api_key;
  if (typeof apiKey !== 'string' || apiKey.length === 0) return undefined;
  const steps = (storyboard.phases ?? []).flatMap(phase => (phase.steps ?? []) as StepWithAuth[]);
  if (steps.length === 0 || !steps.every(step => isFromTestKitApiKey(step.auth))) return undefined;

  const patched = structuredClone(storyboard);
  for (const phase of patched.phases ?? []) {
    for (const step of (phase.steps ?? []) as StepWithAuth[]) {
      // Same header the SDK sends for `from_test_kit`, with the declared
      // kit's value instead of the host-injected run-level one.
      step.auth = { type: 'api_key', value: apiKey };
    }
  }
  return {
    // No `auth` on the entry: comply() pins the run-level (owner) auth for the
    // transport, and each step's own directive overrides the header.
    agents: { [LIVE_MODE_AGENT_KEY]: { url: agentUrl } },
    default_agent: LIVE_MODE_AGENT_KEY,
    storyboard: patched,
  };
}

/** Build the `routeStoryboard` hook for one hosted `comply()` run. */
export function createHostedRouteStoryboard(input: HostedRouteStoryboardInput): RouteStoryboard {
  const { resolveTestKit } = input;
  return (storyboard, context) => {
    const agentUrl = context.agent_url;

    if (storyboard.prerequisites?.test_kit) {
      const liveRoute = liveModeTestKitRoute(storyboard, agentUrl, resolveTestKit(storyboard.id));
      if (liveRoute) return liveRoute;
    }

    if (!storyboard.requires?.includes('multi_agent')) return undefined;
    const governance = hostedGovernanceAgentForRun(agentUrl, input.governance);
    if (governance.kind === 'unavailable') {
      return { skip: `${storyboard.id} requires multi_agent: ${governance.reason}` };
    }
    for (const secret of hostedGovernanceSecrets(governance.governance)) input.secrets.add(secret);
    const routing = hostedMultiAgentRoutingForStoryboard({
      storyboard: storyboard as unknown as HostedRoutableStoryboard,
      agentUnderTest: {
        url: agentUrl,
        ...(input.auth && { auth: input.auth }),
        ...(input.protocol && { protocol: input.protocol }),
      },
      governance: governance.governance,
    });
    if (routing.kind === 'single_agent') return undefined;
    if (routing.kind === 'unroutable') return { skip: routing.reason };
    return {
      agents: routing.agents,
      default_agent: routing.default_agent,
      context: routing.context,
      storyboard: routing.storyboard as unknown as RouteStoryboardArg,
    };
  };
}
