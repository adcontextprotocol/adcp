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

const LLMPULSE_BASE_URL = "https://api.llmpulse.ai/v1";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

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
    models: string[];
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

function isCacheValid(): boolean {
  return cache !== null && Date.now() - cache.timestamp < CACHE_TTL_MS;
}

function getApiKey(): string | undefined {
  return process.env.LLMPULSE_API_KEY;
}

function getBaseUrl(): string {
  return process.env.LLMPULSE_API_URL || LLMPULSE_BASE_URL;
}

async function fetchLLMPulse(path: string): Promise<unknown> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("LLMPULSE_API_KEY not configured");
  }

  const url = `${getBaseUrl()}${path}`;
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

function transformToVisibilityData(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prompts: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  brands: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  competitors: any
): GeoVisibilityData {
  // Extract arrays from responses, handling various API shapes
  const promptList = Array.isArray(prompts) ? prompts : prompts?.data ?? prompts?.prompts ?? [];
  const brandData = Array.isArray(brands) ? brands : brands?.data ?? brands?.brands ?? {};
  const competitorList = Array.isArray(competitors)
    ? competitors
    : competitors?.data ?? competitors?.competitors ?? [];

  // Compute summary metrics from available data
  const totalPrompts = promptList.length;
  const mentionedCount = promptList.filter(
    (p: { mentioned?: boolean; adcp_mentioned?: boolean }) =>
      p.mentioned ?? p.adcp_mentioned ?? false
  ).length;
  const brandMentionRate = totalPrompts > 0 ? (mentionedCount / totalPrompts) * 100 : 0;

  const citedCount = promptList.filter(
    (p: { cited?: boolean; has_citation?: boolean }) =>
      p.cited ?? p.has_citation ?? false
  ).length;
  const citationRate = totalPrompts > 0 ? (citedCount / totalPrompts) * 100 : 0;

  // Share of voice from brand data
  const shareOfVoice =
    brandData.share_of_voice ?? brandData.sov ?? 0;

  // Per-model breakdown
  const byModel: GeoVisibilityData["by_model"] = Array.isArray(brandData.by_model ?? brandData.models)
    ? (brandData.by_model ?? brandData.models).map(
        (m: { model?: string; name?: string; mention_rate?: number; sentiment?: string; trend?: string }) => ({
          model: m.model ?? m.name ?? "unknown",
          mention_rate: m.mention_rate ?? 0,
          sentiment: normalizeSentiment(m.sentiment),
          trend: normalizeTrend(m.trend),
        })
      )
    : [];

  // Prompt details
  const transformedPrompts: GeoVisibilityData["prompts"] = promptList.map(
    (p: {
      text?: string;
      prompt?: string;
      query?: string;
      mentioned?: boolean;
      adcp_mentioned?: boolean;
      competitor_mentioned?: string | null;
      last_checked?: string;
      checked_at?: string;
    }) => ({
      text: p.text ?? p.prompt ?? p.query ?? "",
      adcp_mentioned: p.mentioned ?? p.adcp_mentioned ?? false,
      competitor_mentioned: p.competitor_mentioned ?? null,
      last_checked: p.last_checked ?? p.checked_at ?? new Date().toISOString(),
    })
  );

  // Top cited URLs
  const topCitedUrls: GeoVisibilityData["top_cited_urls"] = Array.isArray(
    brandData.top_cited_urls ?? brandData.citations
  )
    ? (brandData.top_cited_urls ?? brandData.citations).map(
        (c: { url?: string; citation_count?: number; count?: number; models?: string[] }) => ({
          url: c.url ?? "",
          citation_count: c.citation_count ?? c.count ?? 0,
          models: Array.isArray(c.models) ? c.models : [],
        })
      )
    : [];

  // Competitors
  const transformedCompetitors: GeoVisibilityData["competitors"] = (
    Array.isArray(competitorList) ? competitorList : []
  ).map(
    (c: {
      name?: string;
      mention_count?: number;
      mentions?: number;
      share_of_voice?: number;
      sov?: number;
      trend?: string;
    }) => ({
      name: c.name ?? "unknown",
      mention_count: c.mention_count ?? c.mentions ?? 0,
      share_of_voice: c.share_of_voice ?? c.sov ?? 0,
      trend: normalizeTrend(c.trend),
    })
  );

  return {
    configured: true,
    updated_at: new Date().toISOString(),
    summary: {
      brand_mention_rate: Math.round(brandMentionRate * 10) / 10,
      share_of_voice: Math.round(shareOfVoice * 10) / 10,
      total_prompts: totalPrompts,
      citation_rate: Math.round(citationRate * 10) / 10,
    },
    by_model: byModel,
    prompts: transformedPrompts,
    top_cited_urls: topCitedUrls,
    competitors: transformedCompetitors,
  };
}

function normalizeSentiment(
  value: string | undefined
): "positive" | "neutral" | "negative" {
  if (value === "positive" || value === "neutral" || value === "negative") {
    return value;
  }
  return "neutral";
}

function normalizeTrend(value: string | undefined): "up" | "down" | "flat" {
  if (value === "up" || value === "down" || value === "flat") {
    return value;
  }
  return "flat";
}

async function fetchVisibilityData(): Promise<GeoVisibilityData> {
  const [prompts, brands, competitors] = await Promise.all([
    fetchLLMPulse("/prompts"),
    fetchLLMPulse("/brands"),
    fetchLLMPulse("/competitors"),
  ]);

  return transformToVisibilityData(prompts, brands, competitors);
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
