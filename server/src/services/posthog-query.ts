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
  "anthropic.com",
  "you.com",
  "phind.com",
  "kagi.com",
];

// Derive regex from domain list to prevent drift
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
const AI_REFERRER_REGEX = AI_REFERRER_DOMAINS
  .map(escapeRegExp)
  .join("|");

// PostHog's query API lives on the dashboard host (us.posthog.com),
// not the ingestion host (us.i.posthog.com) used by POSTHOG_HOST.
const POSTHOG_QUERY_HOST = "https://us.posthog.com";

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
    host: POSTHOG_QUERY_HOST,
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
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `PostHog query failed: ${response.status} ${response.statusText}${body ? ` - ${body}` : ""}`
    );
  }

  return response.json();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getResultsArray(response: unknown): any[] {
  const obj = response as Record<string, unknown> | null;
  // PostHog query API returns "result" (singular); legacy insights API uses "results" (plural)
  const arr = obj?.result ?? obj?.results;
  return Array.isArray(arr) ? arr : [];
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
let referrerCache: { data: AiReferrerData; timestamp: number } | null = null;

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
  if (referrerCache && Date.now() - referrerCache.timestamp < CACHE_TTL_MS) {
    return referrerCache.data;
  }

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

    // Parse by-domain results (defensive: PostHog response shape may vary)
    const domainResults = getResultsArray(byDomainResult);

    const sources: AiReferrerSource[] = domainResults
      .filter((r) => r.breakdown_value && AI_REFERRER_DOMAINS.some((d) => String(r.breakdown_value).includes(d)))
      .map((r) => ({
        domain: String(r.breakdown_value),
        pageviews: Number(r.count) || 0,
        weeklyData: Array.isArray(r.data) ? r.data.map(Number) : [],
        weekLabels: Array.isArray(r.labels) ? r.labels.map(String) : [],
      }))
      .sort((a, b) => b.pageviews - a.pageviews);

    const totalAiReferrals = sources.reduce((sum, s) => sum + s.pageviews, 0);

    // Parse total pageviews
    const totalResults = getResultsArray(totalResult);
    const totalPageviews = Number(totalResults[0]?.count) || 0;

    // Parse landing pages
    const landingResults = getResultsArray(landingPagesResult);

    const landingPages: AiReferrerLandingPage[] = landingResults
      .filter((r) => r.breakdown_value && r.breakdown_value !== "$$_posthog_breakdown_other_$$")
      .map((r) => ({
        path: String(r.breakdown_value),
        pageviews: Number(r.aggregated_value) || 0,
      }))
      .sort((a, b) => b.pageviews - a.pageviews);

    const result: AiReferrerData = {
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

    referrerCache = { data: result, timestamp: Date.now() };
    return result;
  } catch (err) {
    logger.error({ err }, "Failed to fetch AI referrer data from PostHog");
    return null;
  }
}

// ── Page performance diagnostics ──

export interface PageException {
  timestamp: string;
  person: string;
  message: string;
  url: string;
}

export interface PagePerformanceData {
  pageviews: number;
  uniqueUsers: number;
  exceptions: PageException[];
  slowPageLoads: number;
  period: string;
}

/**
 * Query PostHog for page-level diagnostics: errors, slow loads, and user-level data.
 * Useful for investigating reports of pages hanging or erroring.
 */
export async function fetchPageDiagnostics(
  pathname: string,
  days = 7
): Promise<PagePerformanceData | null> {
  // Validate pathname: must be a URL path, reject anything that could inject HogQL
  if (!/^\/[\w\-./%]+$/.test(pathname) || pathname.length > 500) {
    logger.warn({ pathname }, "Invalid pathname for page diagnostics query");
    return null;
  }
  const safeDays = Math.max(1, Math.min(Math.floor(days), 90));
  // Defense-in-depth: escape single quotes for HogQL string literals
  const safePath = pathname.replace(/'/g, "\\'");

  const config = getPostHogQueryConfig();
  if (!config) return null;

  try {
    // Query 1: Pageview count + unique users for this path
    const pageviewQuery = {
      kind: "HogQLQuery",
      query: `
        SELECT
          count() AS pageviews,
          count(DISTINCT person_id) AS unique_users
        FROM events
        WHERE event = '$pageview'
          AND properties.$pathname = '${safePath}'
          AND timestamp > now() - interval ${safeDays} day
      `,
    };

    // Query 2: Exceptions on this page (JS errors, unhandled rejections)
    const exceptionsQuery = {
      kind: "HogQLQuery",
      query: `
        SELECT
          timestamp,
          person.properties.email AS person_email,
          properties.$exception_message AS message,
          properties.$current_url AS url
        FROM events
        WHERE event = '$exception'
          AND properties.$current_url LIKE '%${safePath}%'
          AND timestamp > now() - interval ${safeDays} day
        ORDER BY timestamp DESC
        LIMIT 50
      `,
    };

    // Query 3: Slow page loads (web vitals LCP > 4s, which is "poor")
    const slowLoadsQuery = {
      kind: "HogQLQuery",
      query: `
        SELECT count() AS slow_loads
        FROM events
        WHERE event = '$web_vitals'
          AND properties.$pathname = '${safePath}'
          AND properties.$web_vitals_LCP_value > 4000
          AND timestamp > now() - interval ${safeDays} day
      `,
    };

    const [pageviewResult, exceptionsResult, slowLoadsResult] =
      await Promise.all([
        queryPostHog(config, pageviewQuery),
        queryPostHog(config, exceptionsQuery),
        queryPostHog(config, slowLoadsQuery),
      ]);

    // Parse pageviews
    const pvRows = getResultsArray(pageviewResult);
    const pageviews = Number(pvRows[0]?.[0]) || 0;
    const uniqueUsers = Number(pvRows[0]?.[1]) || 0;

    // Parse exceptions
    const exRows = getResultsArray(exceptionsResult);
    const exceptions: PageException[] = exRows.map((row: unknown[]) => ({
      timestamp: String(row[0] || ""),
      person: String(row[1] || "unknown"),
      message: String(row[2] || ""),
      url: String(row[3] || ""),
    }));

    // Parse slow loads
    const slRows = getResultsArray(slowLoadsResult);
    const slowPageLoads = Number(slRows[0]?.[0]) || 0;

    return {
      pageviews,
      uniqueUsers,
      exceptions,
      slowPageLoads,
      period: `${days}d`,
    };
  } catch (err) {
    logger.error({ err, pathname }, "Failed to fetch page diagnostics from PostHog");
    return null;
  }
}
