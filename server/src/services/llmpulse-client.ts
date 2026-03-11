/**
 * LLM Pulse API client
 *
 * Shared HTTP client for fetching data from the LLM Pulse visibility
 * tracking API. Used by both the GEO dashboard routes and the daily
 * snapshot job.
 */

import { createLogger } from "../logger.js";

const logger = createLogger("llmpulse-client");

const DEFAULT_BASE_URL = "https://api.llmpulse.ai/api/v1";

export function getLLMPulseApiKey(): string | undefined {
  return process.env.LLMPULSE_API_KEY;
}

export async function fetchLLMPulse(
  path: string,
  params: Record<string, string> = {}
): Promise<unknown> {
  const apiKey = getLLMPulseApiKey();
  if (!apiKey) {
    throw new Error("LLMPULSE_API_KEY not configured");
  }

  const baseUrl = process.env.LLMPULSE_API_URL || DEFAULT_BASE_URL;
  const searchParams = new URLSearchParams(params);
  const url = `${baseUrl}${path}?${searchParams.toString()}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    logger.warn(
      { path, status: response.status },
      "LLM Pulse API request failed"
    );
    throw new Error(
      `LLM Pulse API error: ${response.status} ${response.statusText}${body ? ` - ${body}` : ""}`
    );
  }

  return response.json();
}
