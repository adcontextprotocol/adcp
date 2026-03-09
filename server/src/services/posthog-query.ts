/**
 * PostHog Query Client
 *
 * Queries PostHog analytics API for AI referrer traffic data.
 * Requires POSTHOG_PERSONAL_API_KEY for read access (separate from
 * the project API key used for event ingestion).
 */

import { createLogger } from "../logger.js";

const logger = createLogger("posthog-query");

const AI_REFERRER_DOMAINS = [
  "chatgpt.com",
  "chat.openai.com",
  "www.perplexity.ai",
  "perplexity.ai",
  "gemini.google.com",
  "copilot.microsoft.com",
  "claude.ai",
  "you.com",
  "phind.com",
  "kagi.com",
];

const AI_REFERRER_REGEX =
  "chatgpt|openai|perplexity|gemini|copilot|claude|anthropic|you\\.com|phind|kagi";

export function getPostHogQueryConfig(): {
  apiKey: string;
  projectId: string;
  host: string;
} | null {
  const apiKey = process.env.POSTHOG_PERSONAL_API_KEY;
  const projectId = process.env.POSTHOG_PROJECT_ID;
  if (!apiKey || !projectId) return null;
  return {
    apiKey,
    projectId,
    host: process.env.POSTHOG_HOST || "https://us.posthog.com",
  };
}

async function queryPostHog(
  config: { apiKey: string; projectId: string; host: string },
  queryPayload: Record<string, unknown>
): Promise<unknown> {
  const url = `${config.host}/api/projects/${config.projectId}/query/`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: queryPayload }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `PostHog query failed: ${response.status} ${response.statusText}${body ? ` - ${body}` : ""}`
    );
  }

  return response.json();
}

export interface AiReferrerSource {
  domain: string;
  pageviews: number;
  weeklyData: number[];
  weekLabels: string[];
}

export interface AiReferrerLandingPage {
  path: string;
  pageviews: number;
}

export interface AiReferrerData {
  sources: AiReferrerSource[];
  landingPages: AiReferrerLandingPage[];
  totalAiReferrals: number;
  totalPageviews: number;
  aiReferralShare: number;
  period: string;
}

export async function fetchAiReferrerData(): Promise<AiReferrerData | null> {
  const config = getPostHogQueryConfig();
  if (!config) return null;

  try {
    // Query 1: AI referrer pageviews by domain, weekly
    const byDomainQuery = {
      kind: "InsightVizNode",
      source: {
        kind: "TrendsQuery",
        dateRange: { date_from: "-30d" },
        interval: "week",
        series: [
          {
            kind: "EventsNode",
            event: "$pageview",
            custom_name: "AI referrals",
            properties: [
              {
                key: "$referring_domain",
                type: "event",
                operator: "regex",
                value: AI_REFERRER_REGEX,
              },
            ],
          },
        ],
        breakdownFilter: {
          breakdown: "$referring_domain",
          breakdown_type: "event",
          breakdown_limit: 10,
        },
      },
    };

    // Query 2: Total pageviews for the same period
    const totalQuery = {
      kind: "InsightVizNode",
      source: {
        kind: "TrendsQuery",
        dateRange: { date_from: "-30d" },
        interval: "week",
        series: [
          {
            kind: "EventsNode",
            event: "$pageview",
            custom_name: "All pageviews",
          },
        ],
      },
    };

    // Query 3: Top landing pages from AI referrers
    const landingPagesQuery = {
      kind: "InsightVizNode",
      source: {
        kind: "TrendsQuery",
        dateRange: { date_from: "-30d" },
        series: [
          {
            kind: "EventsNode",
            event: "$pageview",
            custom_name: "AI landing pages",
            properties: [
              {
                key: "$referring_domain",
                type: "event",
                operator: "regex",
                value: AI_REFERRER_REGEX,
              },
            ],
          },
        ],
        breakdownFilter: {
          breakdown: "$pathname",
          breakdown_type: "event",
          breakdown_limit: 10,
        },
        trendsFilter: { display: "ActionsBarValue" },
      },
    };

    const [byDomainResult, totalResult, landingPagesResult] =
      await Promise.all([
        queryPostHog(config, byDomainQuery),
        queryPostHog(config, totalQuery),
        queryPostHog(config, landingPagesQuery),
      ]);

    // Parse by-domain results
    const domainData = byDomainResult as {
      results: Array<{
        data: number[];
        labels: string[];
        count: number;
        breakdown_value: string;
      }>;
    };

    const sources: AiReferrerSource[] = (domainData.results || [])
      .filter((r) => AI_REFERRER_DOMAINS.some((d) => r.breakdown_value.includes(d)))
      .map((r) => ({
        domain: r.breakdown_value,
        pageviews: r.count,
        weeklyData: r.data,
        weekLabels: r.labels,
      }))
      .sort((a, b) => b.pageviews - a.pageviews);

    const totalAiReferrals = sources.reduce((sum, s) => sum + s.pageviews, 0);

    // Parse total pageviews
    const totalData = totalResult as {
      results: Array<{ count: number }>;
    };
    const totalPageviews = totalData.results?.[0]?.count || 0;

    // Parse landing pages
    const landingData = landingPagesResult as {
      results: Array<{
        aggregated_value: number;
        breakdown_value: string;
      }>;
    };

    const landingPages: AiReferrerLandingPage[] = (landingData.results || [])
      .filter((r) => r.breakdown_value !== "$$_posthog_breakdown_other_$$")
      .map((r) => ({
        path: r.breakdown_value,
        pageviews: r.aggregated_value,
      }))
      .sort((a, b) => b.pageviews - a.pageviews);

    return {
      sources,
      landingPages,
      totalAiReferrals,
      totalPageviews,
      aiReferralShare:
        totalPageviews > 0
          ? Math.round((totalAiReferrals / totalPageviews) * 10000) / 100
          : 0,
      period: "30d",
    };
  } catch (err) {
    logger.error({ err }, "Failed to fetch AI referrer data from PostHog");
    return null;
  }
}
