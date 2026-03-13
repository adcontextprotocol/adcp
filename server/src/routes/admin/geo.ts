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
import { fetchLLMPulse, getLLMPulseApiKey } from "../../services/llmpulse-client.js";
import { fetchAiReferrerData, getPostHogQueryConfig } from "../../services/posthog-query.js";

const logger = createLogger("admin-geo");

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

interface LLMPulseModelSummary {
  model: string;
  mentions: number;
  mention_rate: number;
  citations: number;
  citation_rate: number;
  net_sentiment: number;
  visibility: number;
}

interface LLMPulseAnswer {
  prompt_id: number;
  mentions_count: number;
  citations_count: number;
  competitor_name?: string;
}

interface LLMPulseCompetitorMention {
  competitor_id: number;
  mentions_count: number;
}

// Dashboard output types
interface GeoVisibilityData {
  configured: true;
  updated_at: string;
  summary: {
    brand_mention_rate: number;
    brand_mention_rate_change: number | null;
    share_of_voice: number;
    share_of_voice_change: number | null;
    total_prompts: number;
    total_prompts_change: number | null;
    citation_rate: number;
    citation_rate_change: number | null;
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
  // Check last 3 entries to skip incomplete current-day zeros,
  // but don't reach far back into stale data
  const lookback = Math.min(3, data.length);
  for (let i = data.length - 1; i >= data.length - lookback; i--) {
    if (data[i].value !== 0) return data[i].value;
  }
  return data[data.length - 1].value ?? 0;
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

function computeChange(data: Array<{ date: string; value: number }>): number | null {
  if (!data || data.length < 14) return null;
  const recent = data.slice(-7);
  const previous = data.slice(-14, -7);
  const recentAvg = recent.reduce((sum, d) => sum + d.value, 0) / recent.length;
  const previousAvg = previous.reduce((sum, d) => sum + d.value, 0) / previous.length;
  return Math.round((recentAvg - previousAvg) * 10) / 10;
}

async function fetchVisibilityData(): Promise<GeoVisibilityData> {
  const pid = await getProjectId();
  const pidStr = String(pid);

  // Core metrics (required for dashboard)
  const [metricsResult, sovResult, topSourcesResult, competitorsResult, promptsResult] =
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
    ]);

  // Enrichment calls — degrade gracefully if any fail
  const [modelSummaryResult, answersResult, competitorMentionsResult] = await Promise.all([
    fetchLLMPulse("/metrics/prompt_summary", {
      project_id: pidStr,
      breakdown: "model",
      sort: "mentions",
      sort_dir: "desc",
      per_page: "20",
      range: "30",
    }).then((result) => {
      const r = result as { data: LLMPulseModelSummary[] };
      logger.info({ modelCount: r.data?.length ?? 0 }, "LLM Pulse model summary fetched");
      return r;
    }).catch((err) => {
      logger.warn({ err }, "Failed to fetch model summary from LLM Pulse");
      return { data: [] as LLMPulseModelSummary[] };
    }),
    fetchLLMPulse("/answers", {
      project_id: pidStr,
      per_page: "500",
    }).then((result) => {
      const r = result as { data: LLMPulseAnswer[] };
      logger.info({ answerCount: r.data?.length ?? 0 }, "LLM Pulse answers fetched");
      return r;
    }).catch((err) => {
      logger.warn({ err }, "Failed to fetch answers from LLM Pulse");
      return { data: [] as LLMPulseAnswer[] };
    }),
    fetchLLMPulse("/dimensions/competitor_mentions", {
      project_id: pidStr,
    }).then((result) => {
      const r = result as { data: LLMPulseCompetitorMention[] };
      logger.info({ competitorMentionCount: r.data?.length ?? 0 }, "LLM Pulse competitor mentions fetched");
      return r;
    }).catch((err) => {
      logger.warn({ err }, "Failed to fetch competitor mentions from LLM Pulse");
      return { data: [] as LLMPulseCompetitorMention[] };
    }),
  ]);

  // Log available metric series keys for debugging
  const seriesKeys = Object.keys(metricsResult.series || {});
  logger.info({ seriesKeys }, "LLM Pulse metrics summary series keys");

  // Extract brand mention rate from mentions metric
  const mentionsSeries = metricsResult.series?.mentions?.find(
    (s) => s.actor.type === "project"
  );
  // Fall back to visibility metric if mentions not available
  const visibilitySeries = metricsResult.series?.visibility?.find(
    (s) => s.actor.type === "project"
  );
  const brandMentionSeries = mentionsSeries || visibilitySeries;
  const brandMentionRate = brandMentionSeries
    ? getLatestValue(brandMentionSeries.data)
    : 0;

  if (!mentionsSeries && visibilitySeries) {
    logger.warn("Using 'visibility' series as fallback for brand mention rate — 'mentions' series not found");
  } else if (!mentionsSeries && !visibilitySeries) {
    logger.warn({ seriesKeys }, "Neither 'mentions' nor 'visibility' series found in metrics response");
  }

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

  // Build per-model breakdown from prompt_summary with model breakdown
  // Query stored snapshots for trend computation (last 14+ days)
  const modelTrends = new Map<string, "up" | "down" | "flat">();
  try {
    const snapshotsResult = await query<{ model: string; snapshot_date: string; mention_rate: number }>(
      `SELECT model, snapshot_date, mention_rate
       FROM geo_visibility_snapshots
       WHERE snapshot_date >= CURRENT_DATE - INTERVAL '30 days'
       ORDER BY model, snapshot_date`
    );
    // Group by model and compute trend from snapshot history
    const byModelSnapshots = new Map<string, Array<{ date: string; value: number }>>();
    for (const row of snapshotsResult.rows) {
      const arr = byModelSnapshots.get(row.model) || [];
      arr.push({ date: row.snapshot_date, value: Number(row.mention_rate) });
      byModelSnapshots.set(row.model, arr);
    }
    for (const [model, data] of byModelSnapshots) {
      modelTrends.set(model, computeTrend(data));
    }
  } catch (err) {
    logger.warn({ err }, "Failed to query snapshot trends, using flat");
  }

  const byModel: GeoVisibilityData["by_model"] = (modelSummaryResult.data || []).map((row) => ({
    model: row.model,
    mention_rate: Math.round(row.mention_rate * 10) / 10,
    sentiment: row.net_sentiment > 0.2 ? "positive" as const
      : row.net_sentiment < -0.2 ? "negative" as const
      : "neutral" as const,
    trend: modelTrends.get(row.model) || "flat" as const,
  }));

  // Build per-prompt mention lookup from answers (sticky-true: once mentioned, stays mentioned)
  const answersByPrompt = new Map<number, { mentioned: boolean; competitor: string | null }>();
  for (const answer of answersResult.data || []) {
    const existing = answersByPrompt.get(answer.prompt_id);
    answersByPrompt.set(answer.prompt_id, {
      mentioned: (existing?.mentioned ?? false) || answer.mentions_count > 0,
      competitor: answer.competitor_name || existing?.competitor || null,
    });
  }

  // Transform prompts with real mention data
  const prompts: GeoVisibilityData["prompts"] = (promptsResult.data || []).map((p) => {
    const answerData = answersByPrompt.get(p.id);
    return {
      text: p.prompt_text,
      adcp_mentioned: answerData?.mentioned ?? false,
      competitor_mentioned: answerData?.competitor ?? null,
      last_checked: p.last_executed_at,
    };
  });

  // Transform top sources
  const topCitedUrls: GeoVisibilityData["top_cited_urls"] = (topSourcesResult.data || []).map((s) => ({
    url: s.domain,
    citation_count: s.total_responses,
    avg_visibility: Math.round(s.avg_visibility * 10) / 10,
  }));

  // Build competitor data from SOV time series + dedicated mention counts
  const competitorMentionMap = new Map<number, number>();
  for (const cm of competitorMentionsResult.data || []) {
    competitorMentionMap.set(cm.competitor_id, cm.mentions_count);
  }

  const competitors: GeoVisibilityData["competitors"] = (competitorsResult.competitors || []).map((c) => {
    const competitorSov = sovResult.over_time?.find(
      (s) => s.actor.type === "competitor" && s.actor.id === c.id
    );
    return {
      name: c.name,
      mention_count: competitorMentionMap.get(c.id) || 0,
      share_of_voice: competitorSov ? Math.round(getLatestValue(competitorSov.data) * 10) / 10 : 0,
      trend: competitorSov ? computeTrend(competitorSov.data) : "flat" as const,
    };
  });

  return {
    configured: true,
    updated_at: new Date().toISOString(),
    summary: {
      brand_mention_rate: Math.round(brandMentionRate * 10) / 10,
      brand_mention_rate_change: brandMentionSeries ? computeChange(brandMentionSeries.data) : null,
      share_of_voice: Math.round(shareOfVoice * 10) / 10,
      share_of_voice_change: projectSov ? computeChange(projectSov.data) : null,
      total_prompts: promptsResult.total || prompts.length,
      total_prompts_change: null,
      citation_rate: Math.round(citationRate * 10) / 10,
      citation_rate_change: citationsSeries ? computeChange(citationsSeries.data) : null,
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
        const apiKey = getLLMPulseApiKey();
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
        const apiKey = getLLMPulseApiKey();
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

  // GET /api/admin/geo-referrers - AI referrer traffic from PostHog
  apiRouter.get(
    "/geo-referrers",
    requireAuth,
    requireManage,
    async (_req, res) => {
      try {
        if (!getPostHogQueryConfig()) {
          return res.json({
            configured: false,
            message: "PostHog query API not configured (set POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID)",
          });
        }

        const data = await fetchAiReferrerData();
        if (!data) {
          return res.status(502).json({
            error: "Failed to fetch AI referrer data from PostHog",
          });
        }

        res.json(data);
      } catch (error) {
        logger.error({ err: error }, "Error fetching AI referrer data");
        res.status(500).json({
          error: "Failed to fetch AI referrer data",
        });
      }
    }
  );

  // GET /api/admin/geo-article-sov - Share of voice from industry articles
  apiRouter.get(
    "/geo-article-sov",
    requireAuth,
    requireManage,
    async (_req, res) => {
      try {
        // Total articles and AdCP/agentic mention counts
        const totalsResult = await query<{
          total_articles: string;
          mentions_adcp_count: string;
          mentions_agentic_count: string;
        }>(
          `SELECT
             COUNT(*) AS total_articles,
             COUNT(*) FILTER (WHERE mentions_adcp = true) AS mentions_adcp_count,
             COUNT(*) FILTER (WHERE mentions_agentic = true) AS mentions_agentic_count
           FROM addie_knowledge
           WHERE is_active = true
             AND (category IN ('perspective', 'blog')
               OR article_type IN ('news', 'opinion', 'analysis', 'announcement'))`
        );

        const totals = totalsResult.rows[0];
        const totalArticles = parseInt(totals.total_articles, 10);
        const adcpMentions = parseInt(totals.mentions_adcp_count, 10);
        const agenticMentions = parseInt(totals.mentions_agentic_count, 10);

        // Competitor mention frequency from articles
        const competitorResult = await query<{ competitor: string; mention_count: string }>(
          `SELECT unnest(competitor_mentions) AS competitor, COUNT(*) AS mention_count
           FROM addie_knowledge
           WHERE is_active = true
             AND competitor_mentions IS NOT NULL
             AND array_length(competitor_mentions, 1) > 0
           GROUP BY competitor
           ORDER BY mention_count DESC
           LIMIT 20`
        );

        // Trend: articles per week over the last 12 weeks
        const trendResult = await query<{
          week: string;
          total: string;
          adcp: string;
          agentic: string;
        }>(
          `SELECT
             date_trunc('week', published_at)::date AS week,
             COUNT(*) AS total,
             COUNT(*) FILTER (WHERE mentions_adcp = true) AS adcp,
             COUNT(*) FILTER (WHERE mentions_agentic = true) AS agentic
           FROM addie_knowledge
           WHERE is_active = true
             AND published_at >= NOW() - INTERVAL '12 weeks'
             AND published_at IS NOT NULL
           GROUP BY week
           ORDER BY week`
        );

        // Recent articles that mention AdCP
        const recentAdcpResult = await query<{
          title: string;
          source_url: string;
          published_at: string;
          quality_score: number;
        }>(
          `SELECT title, source_url, published_at, quality_score
           FROM addie_knowledge
           WHERE is_active = true AND mentions_adcp = true
           ORDER BY published_at DESC NULLS LAST
           LIMIT 10`
        );

        res.json({
          summary: {
            total_articles: totalArticles,
            adcp_mentions: adcpMentions,
            agentic_mentions: agenticMentions,
            adcp_share: totalArticles > 0
              ? Math.round((adcpMentions / totalArticles) * 1000) / 10
              : 0,
            agentic_share: totalArticles > 0
              ? Math.round((agenticMentions / totalArticles) * 1000) / 10
              : 0,
          },
          competitors: competitorResult.rows.map((r) => ({
            name: r.competitor,
            mention_count: parseInt(r.mention_count, 10),
          })),
          trend: trendResult.rows.map((r) => ({
            week: r.week,
            total: parseInt(r.total, 10),
            adcp: parseInt(r.adcp, 10),
            agentic: parseInt(r.agentic, 10),
          })),
          recent_adcp_articles: recentAdcpResult.rows,
        });
      } catch (error) {
        logger.error({ err: error }, "Error fetching article share-of-voice");
        res.status(500).json({
          error: "Failed to fetch article share-of-voice data",
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
