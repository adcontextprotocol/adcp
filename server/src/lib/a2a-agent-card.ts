/**
 * A2A agent card discovery for the registry server.
 *
 * The well-known URI of an A2A agent card is `/.well-known/agent-card.json`
 * (A2A §8.2), and the registry probes only that path. Agents don't serve
 * the pre-1.0 `/.well-known/agent.json`, so the registry doesn't probe it
 * (#7875).
 */
import { sdkSafeFetch } from "../utils/sdk-safe-fetch.js";

export const A2A_AGENT_CARD_PATH = "/.well-known/agent-card.json";

/**
 * Report whether the origin of `url` serves an A2A agent card at the
 * well-known URI. The discovery endpoints (`/api/discover-agent` in
 * http.ts and `/api/public/discover-agent` in registry-api.ts) use it to
 * list A2A next to an MCP endpoint they already found. A failed or non-2xx
 * fetch means no card.
 */
export async function hasA2AAgentCard(url: string): Promise<boolean> {
  try {
    const response = await sdkSafeFetch(new URL(A2A_AGENT_CARD_PATH, url).toString(), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
