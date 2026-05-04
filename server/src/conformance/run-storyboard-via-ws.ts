/**
 * Run a storyboard against an adopter connected via Socket Mode.
 *
 * Resolves the live `ConformanceSession` for the given org, wraps its
 * MCP `Client` as an `AgentClient` via `AgentClient.fromMCPClient` (the
 * SDK's existing in-process injection seam), and dispatches to the
 * standard `runStoryboard` runner. The runner sees a normal `_client`
 * override and behaves exactly as it would for any in-process test —
 * the WebSocket transport is invisible above the MCP layer.
 *
 * No changes to the existing storyboard runner or compliance heartbeat
 * are required. This is a separate runner that picks the same storyboards
 * from the same registry.
 */

import { AgentClient } from '@adcp/sdk';
import { runStoryboard } from '@adcp/sdk/testing';
import type { StoryboardResult, StoryboardRunOptions } from '@adcp/sdk/testing';
import { conformanceSessions } from './session-store.js';
import { getStoryboard } from '../services/storyboards.js';
import { createLogger } from '../logger.js';

const logger = createLogger('conformance-run-storyboard');

export class ConformanceNotConnectedError extends Error {
  constructor(public readonly orgId: string) {
    super(
      `No conformance session for org ${orgId}. Ask Addie for a fresh conformance token and run @adcp/sdk's ConformanceClient against this org.`,
    );
    this.name = 'ConformanceNotConnectedError';
  }
}

export class StoryboardNotFoundError extends Error {
  constructor(public readonly storyboardId: string) {
    super(`Unknown storyboard: ${storyboardId}`);
    this.name = 'StoryboardNotFoundError';
  }
}

export interface RunStoryboardViaWsOptions {
  timeoutMs?: number;
  testSessionId?: string;
}

/**
 * Synthetic agent URL used to satisfy `runStoryboard`'s positional
 * `agentUrlOrUrls` argument. The runner reads `_client` first when it's
 * present, so this URL is never actually dialed — it only feeds debug
 * logs and error messages. The `adcp-conformance-socket://` scheme makes
 * it obvious in traces that this run rode the Socket Mode path.
 */
const SYNTHETIC_AGENT_URL_PREFIX = 'adcp-conformance-socket://';

export async function runStoryboardViaConformanceSocket(
  orgId: string,
  storyboardId: string,
  options: RunStoryboardViaWsOptions = {},
): Promise<StoryboardResult> {
  const session = conformanceSessions.get(orgId);
  if (!session) {
    throw new ConformanceNotConnectedError(orgId);
  }

  // Liveness check — a session can linger in the store for one tick if
  // the adopter disconnected between the runner's session lookup and a
  // displaced same-org connect's eviction. Treat a closed transport as
  // not-connected so the runner returns the connect-the-client hint
  // rather than dispatching into a dead AgentClient.
  if (session.transport.isClosed()) {
    conformanceSessions.remove(orgId);
    throw new ConformanceNotConnectedError(orgId);
  }

  const storyboard = getStoryboard(storyboardId);
  if (!storyboard) {
    throw new StoryboardNotFoundError(storyboardId);
  }

  // The MCP `Client` type imported from the ESM build of
  // `@modelcontextprotocol/sdk` and the same type baked into `@adcp/sdk`'s
  // CJS build look distinct to TypeScript even though they're structurally
  // identical at runtime. The `unknown` round-trip skips the duplicated-
  // declaration check without weakening the actual contract.
  const mcpClient = session.mcpClient as unknown as Parameters<typeof AgentClient.fromMCPClient>[0];
  const agentClient = AgentClient.fromMCPClient(mcpClient);
  const syntheticUrl = `${SYNTHETIC_AGENT_URL_PREFIX}${orgId}`;
  const testSessionId = options.testSessionId ?? `conformance-${orgId}-${Date.now()}`;

  logger.info(
    { orgId, storyboardId, testSessionId },
    'running storyboard over conformance socket',
  );

  // `_client` is a private-by-convention injection seam on
  // `StoryboardRunOptions` (see comply()'s usage). It's recognized by
  // `getOrCreateClient` but isn't on the public type. Cast through the
  // narrow runOptions shape rather than `as any` so unrelated typos still
  // get caught.
  const runOptions = {
    _client: agentClient,
    test_session_id: testSessionId,
    timeout_ms: options.timeoutMs ?? 60_000,
  } as StoryboardRunOptions & { _client: AgentClient };

  return runStoryboard(syntheticUrl, storyboard, runOptions);
}
