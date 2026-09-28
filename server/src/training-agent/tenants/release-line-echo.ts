import { AsyncLocalStorage } from 'node:async_hooks';
import type { CreateAdcpServerFromPlatformOptions } from '@adcp/sdk/server';
import { resolveServedAdcpVersionForTool } from '../task-handlers.js';
import {
  TRAINING_AGENT_CURRENT_ADCP_RELEASE,
  TRAINING_AGENT_CURRENT_ADCP_VERSION,
} from '../types.js';

type ResponseEnhancer = NonNullable<CreateAdcpServerFromPlatformOptions['responseEnhancer']>;

/**
 * Set while the SDK dispatches a `tools/call` that the training agent serves
 * at the release-line pin (`"3.2"`).
 */
const servingReleaseLine = new AsyncLocalStorage<true>();

function servesReleaseLine(body: unknown): boolean {
  if ((TRAINING_AGENT_CURRENT_ADCP_RELEASE as string) === TRAINING_AGENT_CURRENT_ADCP_VERSION) return false;
  if (!body || typeof body !== 'object') return false;
  const { method, params } = body as { method?: unknown; params?: { name?: unknown; arguments?: unknown } };
  if (method !== 'tools/call' || typeof params?.name !== 'string') return false;
  const args = params.arguments;
  const toolArgs = args && typeof args === 'object' && !Array.isArray(args)
    ? args as Record<string, unknown>
    : {};
  const resolution = resolveServedAdcpVersionForTool(params.name, toolArgs);
  return resolution.ok && resolution.servedVersion === TRAINING_AGENT_CURRENT_ADCP_RELEASE;
}

/** Run an MCP dispatch, marking it when the request is served at the release line. */
export function runWithReleaseLineEcho<T>(body: unknown, fn: () => T): T {
  return servesReleaseLine(body) ? servingReleaseLine.run(true, fn) : fn();
}

/**
 * Until @adcp/sdk ships the 3.2 GA bundle, the SDK stamps its own bundle
 * label (`3.2-rc.7`) on responses to a request the training agent served at
 * `"3.2"`. Correct that echo inside the SDK response pipeline so the
 * structured result and its JSON text mirror agree with the negotiated
 * release. Inert once the current bundle is the release line itself.
 */
export const releaseLineEchoEnhancer: ResponseEnhancer = (response) => {
  if (servingReleaseLine.getStore() !== true) return;
  const structured = (response as { structuredContent?: unknown }).structuredContent;
  if (!structured || typeof structured !== 'object' || Array.isArray(structured)) return;
  const record = structured as Record<string, unknown>;
  if (record.adcp_version !== TRAINING_AGENT_CURRENT_ADCP_VERSION) return;
  const first = Array.isArray(response.content) ? response.content[0] as { type?: unknown; text?: unknown } | undefined : undefined;
  const textMirrorsStructured = first?.type === 'text' && first.text === JSON.stringify(record);
  record.adcp_version = TRAINING_AGENT_CURRENT_ADCP_RELEASE;
  if (textMirrorsStructured && first) first.text = JSON.stringify(record);
};
