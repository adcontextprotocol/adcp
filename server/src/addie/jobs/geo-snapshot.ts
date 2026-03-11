/**
 * GEO Visibility Snapshot Job
 *
 * Takes a daily snapshot of per-model visibility metrics from LLM Pulse
 * and stores them locally. Stored snapshots are used to compute per-model
 * trends that the LLM Pulse prompt_summary endpoint doesn't provide.
 */

import { createLogger } from "../../logger.js";
import { query } from "../../db/client.js";
import { fetchLLMPulse, getLLMPulseApiKey } from "../../services/llmpulse-client.js";

const logger = createLogger("geo-snapshot");

interface ModelMetric {
  model: string;
  mention_rate: number;
  citation_rate: number;
  net_sentiment: number;
  visibility: number;
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
    "/dimensions/projects"
  )) as { projects: Array<{ id: number }> };
  if (!projectsResult.projects?.length) {
    throw new Error("No LLM Pulse projects found");
  }
  const projectId = String(projectsResult.projects[0].id);

  // Fetch per-model metrics
  const modelSummary = (await fetchLLMPulse("/metrics/prompt_summary", {
    project_id: projectId,
    breakdown: "model",
    sort: "mentions",
    sort_dir: "desc",
    per_page: "20",
  })) as { data: ModelMetric[] };

  const models = modelSummary.data || [];
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
