/**
 * GEO (Generative Engine Optimization) visibility routes
 *
 * Provides LLM visibility data to the admin dashboard by integrating
 * with the LLM Pulse API. Tracks brand mentions, share of voice,
 * citation rates, and competitor comparisons across LLM models.
 */

import { Router } from "express";
import { createLogger } from "../../logger.js";
import { requireAuth, requireManage } from "../../middleware/auth.js";
import { query } from "../../db/client.js";

const logger = createLogger("admin-geo");

const LLMPULSE_BASE_URL = "https://api.llmpulse.ai/api/v1";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// LLM Pulse API response types
interface LLMPulseProject {
  id: number;
  name: string;
}

interface LLMPulseMetricSeries {
  actor: { type: string; id: number; name: string; domain?: string };
  metric: string;
  data: Array<{ date: string; value: number }>;
}

interface LLMPulseTopSource {
  domain: string;
  total_responses: number;
  avg_visibility: number;
}

interface LLMPulseCompetitor {
  id: number;
  name: string;
  domain: string;
}

// Dashboard output types
interface GeoVisibilityData {
  configured: true;
  updated_at: string;
  summary: {
    brand_mention_rate: number;
    share_of_voice: number;
    total_prompts: number;
    citation_rate: number;
  };
  by_model: Array<{
    model: string;
    mention_rate: number;
    sentiment: "positive" | "neutral" | "negative";
    trend: "up" | "down" | "flat";
  }>;
  prompts: Array<{
    text: string;
    adcp_mentioned: boolean;
    competitor_mentioned: string | null;
    last_checked: string;
  }>;
  top_cited_urls: Array<{
    url: string;
    citation_count: number;
    avg_visibility: number;
  }>;
  competitors: Array<{
    name: string;
    mention_count: number;
    share_of_voice: number;
    trend: "up" | "down" | "flat";
  }>;
}

interface CacheEntry {
  data: GeoVisibilityData;
  timestamp: number;
}

let cache: CacheEntry | null = null;
let projectId: number | null = null;

function isCacheValid(): boolean {
  return cache !== null && Date.now() - cache.timestamp < CACHE_TTL_MS;
}

function getApiKey(): string | undefined {
  return process.env.LLMPULSE_API_KEY;
}

function getBaseUrl(): string {
  return process.env.LLMPULSE_API_URL || LLMPULSE_BASE_URL;
}

async function fetchLLMPulse(path: string, params: Record<string, string> = {}): Promise<unknown> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("LLMPULSE_API_KEY not configured");
  }

  const searchParams = new URLSearchParams(params);
  const url = `${getBaseUrl()}${path}?${searchParams.toString()}`;
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
    throw new Error(
      `LLM Pulse API error: ${response.status} ${response.statusText}${body ? ` - ${body}` : ""}`
    );
  }

  return response.json();
}

async function getProjectId(): Promise<number> {
  if (projectId) return projectId;

  const result = await fetchLLMPulse("/dimensions/projects") as { projects: LLMPulseProject[] };
  if (!result.projects?.length) {
    throw new Error("No LLM Pulse projects found");
  }
  projectId = result.projects[0].id;
  return projectId;
}

function getLatestValue(data: Array<{ date: string; value: number }>): number {
  if (!data?.length) return 0;
  // Walk backwards from the end to find the most recent non-zero value
  for (let i = data.length - 1; i >= 0; i--) {
    if (data[i].value !== 0) return data[i].value;
  }
  return 0;
}

function computeTrend(data: Array<{ date: string; value: number }>): "up" | "down" | "flat" {
  if (!data || data.length < 14) return "flat";
  // Compare last 7 days vs previous 7 days
  const recent = data.slice(-7);
  const previous = data.slice(-14, -7);
  const recentAvg = recent.reduce((sum, d) => sum + d.value, 0) / recent.length;
  const previousAvg = previous.reduce((sum, d) => sum + d.value, 0) / previous.length;
  if (recentAvg > previousAvg * 1.1) return "up";
  if (recentAvg < previousAvg * 0.9) return "down";
  return "flat";
}

async function fetchVisibilityData(): Promise<GeoVisibilityData> {
  const pid = await getProjectId();
  const pidStr = String(pid);

  // Fetch all data in parallel
  const [metricsResult, sovResult, topSourcesResult, competitorsResult, promptsResult, modelsResult] =
    await Promise.all([
      fetchLLMPulse("/metrics/summary", {
        project_id: pidStr,
        metrics: "mentions,citations,visibility,net_sentiment",
        range: "30",
      }) as Promise<{ series: Record<string, LLMPulseMetricSeries[]> }>,
      fetchLLMPulse("/metrics/sov", {
        project_id: pidStr,
        range: "30",
      }) as Promise<{ over_time: Array<{ actor: { type: string; id: number; name: string }; data: Array<{ date: string; value: number }> }> }>,
      fetchLLMPulse("/metrics/top_sources", {
        project_id: pidStr,
        range: "30",
        per_page: "10",
      }) as Promise<{ data: LLMPulseTopSource[] }>,
      fetchLLMPulse("/dimensions/competitors", {
        project_id: pidStr,
      }) as Promise<{ competitors: LLMPulseCompetitor[] }>,
      fetchLLMPulse("/dimensions/prompts", {
        project_id: pidStr,
        per_page: "100",
      }) as Promise<{ data: Array<{ id: number; prompt_text: string; last_executed_at: string }>; total: number }>,
      fetchLLMPulse("/dimensions/models", {
        project_id: pidStr,
      }) as Promise<{ models: string[] }>,
    ]);

  // Extract brand mention rate from visibility metric
  const visibilitySeries = metricsResult.series?.visibility?.find(
    (s) => s.actor.type === "project"
  );
  const brandMentionRate = visibilitySeries
    ? getLatestValue(visibilitySeries.data)
    : 0;

  // Extract citation rate from citations metric
  const citationsSeries = metricsResult.series?.citations?.find(
    (s) => s.actor.type === "project"
  );
  const citationRate = citationsSeries
    ? getLatestValue(citationsSeries.data)
    : 0;

  // Extract share of voice (project's SOV)
  const projectSov = sovResult.over_time?.find(
    (s) => s.actor.type === "project"
  );
  const shareOfVoice = projectSov
    ? getLatestValue(projectSov.data)
    : 0;

  // Build per-model breakdown using per-model metrics
  const mentionsSeries = metricsResult.series?.mentions || [];
  const byModel: GeoVisibilityData["by_model"] = (modelsResult.models || []).map((model) => {
    const modelMentions = mentionsSeries.find(
      (s) => s.actor.type === "project"
    );
    return {
      model,
      mention_rate: modelMentions ? getLatestValue(modelMentions.data) : 0,
      sentiment: "neutral" as const,
      trend: modelMentions ? computeTrend(modelMentions.data) : "flat" as const,
    };
  });

  // Transform prompts
  const prompts: GeoVisibilityData["prompts"] = (promptsResult.data || []).map((p) => ({
    text: p.prompt_text,
    adcp_mentioned: false, // LLM Pulse tracks this at aggregate level, not per-prompt
    competitor_mentioned: null,
    last_checked: p.last_executed_at,
  }));

  // Transform top sources
  const topCitedUrls: GeoVisibilityData["top_cited_urls"] = (topSourcesResult.data || []).map((s) => ({
    url: s.domain,
    citation_count: s.total_responses,
    avg_visibility: Math.round(s.avg_visibility * 10) / 10,
  }));

  // Build competitor data from SOV time series
  const competitors: GeoVisibilityData["competitors"] = (competitorsResult.competitors || []).map((c) => {
    const competitorSov = sovResult.over_time?.find(
      (s) => s.actor.type === "competitor" && s.actor.id === c.id
    );
    const competitorMentions = mentionsSeries.find(
      (s) => s.actor.type === "competitor" && s.actor.id === (c.id as unknown as number)
    );
    return {
      name: c.name,
      mention_count: competitorMentions ? getLatestValue(competitorMentions.data) : 0,
      share_of_voice: competitorSov ? Math.round(getLatestValue(competitorSov.data) * 10) / 10 : 0,
      trend: competitorSov ? computeTrend(competitorSov.data) : "flat" as const,
    };
  });

  return {
    configured: true,
    updated_at: new Date().toISOString(),
    summary: {
      brand_mention_rate: Math.round(brandMentionRate * 10) / 10,
      share_of_voice: Math.round(shareOfVoice * 10) / 10,
      total_prompts: promptsResult.total || prompts.length,
      citation_rate: Math.round(citationRate * 10) / 10,
    },
    by_model: byModel,
    prompts,
    top_cited_urls: topCitedUrls,
    competitors,
  };
}

export function setupGeoRoutes(apiRouter: Router): void {
  // GET /api/admin/geo-visibility - GEO visibility dashboard data
  apiRouter.get(
    "/geo-visibility",
    requireAuth,
    requireManage,
    async (_req, res) => {
      try {
        const apiKey = getApiKey();
        if (!apiKey) {
          return res.json({
            configured: false,
            message: "LLM Pulse API key not configured",
          });
        }

        if (isCacheValid()) {
          return res.json(cache!.data);
        }

        const data = await fetchVisibilityData();
        cache = { data, timestamp: Date.now() };
        res.json(data);
      } catch (error) {
        logger.error({ err: error }, "Error fetching GEO visibility data");

        // Return cached data if available, even if stale
        if (cache) {
          logger.info("Returning stale cached data after API error");
          return res.json({
            ...cache.data,
            _stale: true,
            _error: "Failed to refresh data from LLM Pulse API",
          });
        }

        res.status(502).json({
          error: "LLM Pulse API unavailable",
          message: "Unable to fetch GEO visibility data",
        });
      }
    }
  );

  // POST /api/admin/geo-visibility/refresh - Force cache refresh
  apiRouter.post(
    "/geo-visibility/refresh",
    requireAuth,
    requireManage,
    async (_req, res) => {
      try {
        const apiKey = getApiKey();
        if (!apiKey) {
          return res.json({
            configured: false,
            message: "LLM Pulse API key not configured",
          });
        }

        const data = await fetchVisibilityData();
        cache = { data, timestamp: Date.now() };

        logger.info("GEO visibility cache refreshed manually");
        res.json(data);
      } catch (error) {
        logger.error({ err: error }, "Error refreshing GEO visibility data");
        res.status(502).json({
          error: "LLM Pulse API unavailable",
          message: "Unable to refresh GEO visibility data",
        });
      }
    }
  );

  // GET /api/admin/geo-monitor - GEO prompt monitor results
  apiRouter.get(
    "/geo-monitor",
    requireAuth,
    requireManage,
    async (_req, res) => {
      try {
        // Fetch all prompts with their latest result
        const promptsResult = await query(
          `SELECT gp.id, gp.prompt_text, gp.category, gp.is_active, gp.created_at,
                  gpr.model, gpr.response_text, gpr.adcp_mentioned, gpr.competitor_mentioned,
                  gpr.sentiment, gpr.checked_at
           FROM geo_prompts gp
           LEFT JOIN LATERAL (
             SELECT * FROM geo_prompt_results r
             WHERE r.prompt_id = gp.id
             ORDER BY r.checked_at DESC
             LIMIT 1
           ) gpr ON true
           ORDER BY gp.category, gp.id`
        );

        const prompts = promptsResult.rows;

        // Compute summary
        const checkedPrompts = prompts.filter((p: { checked_at: string | null }) => p.checked_at !== null);
        const totalPrompts = prompts.length;
        const mentionedCount = checkedPrompts.filter((p: { adcp_mentioned: boolean }) => p.adcp_mentioned).length;
        const mentionRate = checkedPrompts.length > 0
          ? Math.round((mentionedCount / checkedPrompts.length) * 1000) / 10
          : 0;

        const lastChecked = checkedPrompts.length > 0
          ? checkedPrompts.reduce(
              (latest: string, p: { checked_at: string }) =>
                p.checked_at > latest ? p.checked_at : latest,
              checkedPrompts[0].checked_at
            )
          : null;

        // By category breakdown
        const byCategory: Record<string, number> = {};
        const categories = [...new Set(prompts.map((p: { category: string }) => p.category))];
        for (const cat of categories) {
          const catPrompts = checkedPrompts.filter((p: { category: string }) => p.category === cat);
          const catMentions = catPrompts.filter((p: { adcp_mentioned: boolean }) => p.adcp_mentioned).length;
          byCategory[cat] = catPrompts.length > 0
            ? Math.round((catMentions / catPrompts.length) * 1000) / 10
            : 0;
        }

        // Recent results (last 50)
        const recentResult = await query(
          `SELECT gpr.id, gp.prompt_text, gp.category, gpr.model, gpr.adcp_mentioned,
                  gpr.competitor_mentioned, gpr.sentiment, gpr.checked_at
           FROM geo_prompt_results gpr
           JOIN geo_prompts gp ON gp.id = gpr.prompt_id
           ORDER BY gpr.checked_at DESC
           LIMIT 50`
        );

        res.json({
          prompts: prompts.map((p: {
            id: number;
            prompt_text: string;
            category: string;
            is_active: boolean;
            adcp_mentioned: boolean | null;
            competitor_mentioned: string | null;
            sentiment: string | null;
            checked_at: string | null;
            model: string | null;
          }) => ({
            id: p.id,
            prompt_text: p.prompt_text,
            category: p.category,
            is_active: p.is_active,
            last_result: p.checked_at ? {
              adcp_mentioned: p.adcp_mentioned,
              competitor_mentioned: p.competitor_mentioned,
              sentiment: p.sentiment,
              model: p.model,
              checked_at: p.checked_at,
            } : null,
          })),
          summary: {
            total_prompts: totalPrompts,
            last_checked: lastChecked,
            mention_rate: mentionRate,
            by_category: byCategory,
          },
          recent_results: recentResult.rows,
        });
      } catch (error) {
        logger.error({ err: error }, "Error fetching GEO monitor data");
        res.status(500).json({
          error: "Failed to fetch GEO monitor data",
        });
      }
    }
  );
}
