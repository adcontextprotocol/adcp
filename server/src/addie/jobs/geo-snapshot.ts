/**
 * GEO Visibility Snapshot Job
 *
 * Takes a daily snapshot of per-model visibility metrics from LLM Pulse
 * and stores them locally. Stored snapshots are used to compute per-model
 * trends that the LLM Pulse prompt_summary endpoint doesn't provide.
 */

import { createLogger } from "../../logger.js";
import { query } from "../../db/client.js";
import {
  fetchAllLLMPulsePages,
  fetchLLMPulse,
  getLLMPulseApiKey,
} from "../../services/llmpulse-client.js";

const logger = createLogger("geo-snapshot");

interface ModelMetric {
  prompt_id: number;
  responses: number;
  mentions: number;
  citations: number;
  model: string;
  citation_rate: number | null;
  net_sentiment?: number | null;
  visibility: number | null;
}

function computeRate(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return (numerator / denominator) * 100;
}

function aggregateModelMetrics(rows: ModelMetric[]): Array<{
  model: string;
  mention_rate: number;
  citation_rate: number;
  net_sentiment: number;
  visibility: number;
}> {
  const byModel = new Map<
    string,
    {
      responses: number;
      mentions: number;
      citations: number;
      weightedVisibility: number;
      weightedSentiment: number;
      sentimentWeight: number;
    }
  >();

  for (const row of rows) {
    const current = byModel.get(row.model) ?? {
      responses: 0,
      mentions: 0,
      citations: 0,
      weightedVisibility: 0,
      weightedSentiment: 0,
      sentimentWeight: 0,
    };

    current.responses += row.responses || 0;
    current.mentions += row.mentions || 0;
    current.citations += row.citations || 0;
    current.weightedVisibility += (row.visibility || 0) * (row.responses || 0);
    if (row.net_sentiment != null) {
      current.weightedSentiment += row.net_sentiment * (row.responses || 0);
      current.sentimentWeight += row.responses || 0;
    }

    byModel.set(row.model, current);
  }

  return Array.from(byModel.entries()).map(([model, totals]) => ({
    model,
    mention_rate: computeRate(totals.mentions, totals.responses),
    citation_rate: computeRate(totals.citations, totals.responses),
    net_sentiment: totals.sentimentWeight
      ? totals.weightedSentiment / totals.sentimentWeight
      : 0,
    visibility: totals.responses ? totals.weightedVisibility / totals.responses : 0,
  }));
}

export async function runGeoSnapshotJob(): Promise<{
  modelsSnapped: number;
  skipped: boolean;
}> {
  if (!getLLMPulseApiKey()) {
    logger.info("LLMPULSE_API_KEY not configured, skipping snapshot");
    return { modelsSnapped: 0, skipped: true };
  }

  // Use Postgres CURRENT_DATE for timezone consistency
  const dateResult = await query<{ today: string }>(
    "SELECT CURRENT_DATE::text AS today"
  );
  const today = dateResult.rows[0].today;

  // Check if we already have a snapshot for today
  const existing = await query(
    "SELECT 1 FROM geo_visibility_snapshots WHERE snapshot_date = $1 LIMIT 1",
    [today]
  );
  if (existing.rows.length > 0) {
    logger.info({ date: today }, "Snapshot already exists for today");
    return { modelsSnapped: 0, skipped: true };
  }

  // Get project ID
  const projectsResult = (await fetchLLMPulse(
    "/dimensions/projects",
    { range: "30" }
  )) as { projects: Array<{ id: number }> };
  if (!projectsResult.projects?.length) {
    throw new Error("No LLM Pulse projects found");
  }
  const projectId = String(projectsResult.projects[0].id);

  // Fetch per-model metrics
  const modelSummaryRows = await fetchAllLLMPulsePages<ModelMetric>("/metrics/prompt_summary", {
    project_id: projectId,
    breakdown: "model",
    sort: "mentions",
    sort_dir: "desc",
    range: "30",
  });

  const models = aggregateModelMetrics(modelSummaryRows);
  if (models.length === 0) {
    logger.warn("No model data returned from LLM Pulse");
    return { modelsSnapped: 0, skipped: false };
  }

  // Batch insert all models in one query
  const values: unknown[] = [];
  const placeholders: string[] = [];
  let paramIndex = 1;
  for (const m of models) {
    placeholders.push(
      `($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`
    );
    values.push(
      today,
      m.model,
      m.mention_rate || 0,
      m.citation_rate || 0,
      m.net_sentiment || 0,
      m.visibility || 0,
    );
  }

  await query(
    `INSERT INTO geo_visibility_snapshots
      (snapshot_date, model, mention_rate, citation_rate, net_sentiment, visibility)
     VALUES ${placeholders.join(", ")}
     ON CONFLICT (snapshot_date, model) DO NOTHING`,
    values
  );

  logger.info(
    { date: today, models: models.length },
    "GEO visibility snapshot saved"
  );
  return { modelsSnapped: models.length, skipped: false };
}
