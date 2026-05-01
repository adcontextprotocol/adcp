/**
 * Fetch `get_adcp_capabilities` for an agent URL via the SDK.
 *
 * The SDK's `SingleAgentClient` already speaks both MCP and A2A and handles
 * transport negotiation, so we lean on it instead of re-rolling the
 * handshake. This is the same pattern used by `/public/discover-agent` in
 * `routes/registry-api.ts`.
 *
 * Returns the parsed capabilities response plus enough metadata for the
 * resolver's trace breadcrumb (no IPs, no headers, no chain — just enough
 * to render the privacy-filtered breadcrumb defined in the spec).
 */
import { SingleAgentClient } from "@adcp/sdk";
import { AgentResolverError } from "./errors.js";

export interface CapabilitiesFetchResult {
  /** Parsed `get_adcp_capabilities` response data. */
  data: Record<string, unknown>;
  /** Wall-clock at which the fetch completed (ISO 8601). */
  fetched_at: string;
  /** SDK never gives us upstream `Cache-Control`; we surface null. */
  cache_control: string | null;
  /** Best-effort byte estimate (length of the JSON-stringified response). */
  bytes: number;
  /** Whether the result came from the in-memory cache (set by the caller). */
  from_cache: boolean;
}

export async function fetchCapabilities(
  agentUrl: string,
  opts: { timeoutMs?: number } = {},
): Promise<CapabilitiesFetchResult> {
  const startedAt = new Date().toISOString();
  let result: { success: boolean; data?: Record<string, unknown>; error?: string; status?: string };
  try {
    const client = new SingleAgentClient({
      id: "aao-resolver",
      name: "aao-resolver",
      agent_uri: agentUrl,
      protocol: "mcp",
    });
    const taskResult = await client.getAdcpCapabilities(
      {},
      undefined,
      // TaskOptions accepts a timeoutMs in some SDK shapes; pass it via
      // `as any` so we stay forward-compatible with SDK bumps that rename
      // it. The outer `Promise.race` provides a hard backstop.
      opts.timeoutMs ? ({ timeoutMs: opts.timeoutMs } as never) : undefined,
    );
    result = {
      success: taskResult.success === true && taskResult.status === "completed",
      data: (taskResult as { data?: Record<string, unknown> }).data,
      error: (taskResult as { error?: string }).error,
      status: taskResult.status as string,
    };
  } catch (err) {
    throw new AgentResolverError(
      "request_signature_capabilities_unreachable",
      {
        agent_url: agentUrl,
        reason: err instanceof Error ? err.message.slice(0, 200) : "fetch failed",
        last_attempt_at: startedAt,
      },
    );
  }
  if (!result.success || !result.data) {
    throw new AgentResolverError(
      "request_signature_capabilities_unreachable",
      {
        agent_url: agentUrl,
        reason: result.error?.slice(0, 200) ?? "no data returned",
        last_attempt_at: startedAt,
      },
    );
  }
  const fetched_at = new Date().toISOString();
  const serialized = JSON.stringify(result.data);
  return {
    data: result.data,
    fetched_at,
    cache_control: null,
    bytes: Buffer.byteLength(serialized, "utf8"),
    from_cache: false,
  };
}
