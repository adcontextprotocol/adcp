/**
 * GEO prompt sync service
 *
 * Mirrors the external LLM Pulse prompt inventory into `geo_prompts` so the
 * internal Claude monitor evaluates the same prompt set. Internal execution
 * remains separate, but the prompt registry is shared.
 */

import { getClient } from "../db/client.js";
import { createLogger } from "../logger.js";
import {
  fetchAllLLMPulsePages,
  fetchLLMPulse,
  getLLMPulseApiKey,
} from "./llmpulse-client.js";

const logger = createLogger("geo-prompt-sync");

type GeoPromptCategory =
  | "brand"
  | "competitive"
  | "intent"
  | "buyer"
  | "executive"
  | "audience"
  | "canary";

interface LLMPulseProject {
  id: number;
  name: string;
}

interface LLMPulsePrompt {
  id: number;
  prompt_text: string;
}

interface GeoPromptRow {
  id: number;
  prompt_text: string;
  category: string;
  is_active: boolean;
  source: string;
  external_prompt_id: string | number | null;
  external_project_id: string | number | null;
}

export interface GeoPromptSyncResult {
  configured: boolean;
  project_id: number | null;
  prompt_count: number;
  inserted: number;
  updated: number;
  reactivated: number;
  deactivated: number;
}

function normalizePromptText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeExternalId(value: string | number | null): number | null {
  if (value == null) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

export function inferGeoPromptCategory(promptText: string): GeoPromptCategory {
  const text = normalizePromptText(promptText);

  if (!text) return "brand";

  if (/(owned by|subsidiary|license|licensing|hallucinat|misinformation)/.test(text)) {
    return "canary";
  }

  if (
    /(compare|\bvs\b|versus|difference|differ|alternative|alternatives|framework|frameworks|openrtb|artf|proprietary|custom api|clean room|clean rooms|retail media|review|reviews)/.test(
      text
    )
  ) {
    return "competitive";
  }

  if (/(audience|segment|segments|signal|signals|first party data|targeting)/.test(text)) {
    return "audience";
  }

  if (
    /(membership|pricing|benefits|vendor|partner directory|who can help|find a vendor|my agency|buy programmatic ads|media buying)/.test(
      text
    )
  ) {
    return "buyer";
  }

  if (
    /(advertiser|advertisers|agency|agencies|industry adoption|widely adopted|ecosystem|who .* should care|practical benefits|workflow|skills or background knowledge|near future|business challenges)/.test(
      text
    )
  ) {
    return "executive";
  }

  if (
    /(how do i|how can i|how to|best way|best approach|enable|make my|let ai|ensure my|publish a discovery file|reduce integration|surface inventory|standardize|implement|map skus|verify my ad claims|verifiable)/.test(
      text
    )
  ) {
    return "intent";
  }

  return "brand";
}

export async function syncGeoPromptsFromLLMPulse(): Promise<GeoPromptSyncResult> {
  if (!getLLMPulseApiKey()) {
    return {
      configured: false,
      project_id: null,
      prompt_count: 0,
      inserted: 0,
      updated: 0,
      reactivated: 0,
      deactivated: 0,
    };
  }

  const projectsResult = (await fetchLLMPulse("/dimensions/projects")) as {
    projects: LLMPulseProject[];
  };
  const project = projectsResult.projects?.[0];
  if (!project) {
    throw new Error("No LLM Pulse project found for GEO prompt sync");
  }

  const externalPrompts = await fetchAllLLMPulsePages<LLMPulsePrompt>(
    "/dimensions/prompts",
    { project_id: String(project.id) }
  );

  const client = await getClient();
  let inserted = 0;
  let updated = 0;
  let reactivated = 0;
  let deactivated = 0;

  try {
    await client.query("BEGIN");

    const existingResult = await client.query<GeoPromptRow>(
      `SELECT id, prompt_text, category, is_active, source, external_prompt_id, external_project_id
       FROM geo_prompts
       ORDER BY id`
    );

    const existingRows = existingResult.rows;
    const byExternalId = new Map<string, GeoPromptRow>();
    const byNormalizedText = new Map<string, GeoPromptRow[]>();

    for (const row of existingRows) {
      const externalPromptId = normalizeExternalId(row.external_prompt_id);
      const externalProjectId = normalizeExternalId(row.external_project_id);

      if (externalPromptId != null && externalProjectId != null) {
        byExternalId.set(
          `${externalProjectId}:${externalPromptId}`,
          row
        );
      }

      const normalized = normalizePromptText(row.prompt_text);
      const matches = byNormalizedText.get(normalized) || [];
      matches.push(row);
      byNormalizedText.set(normalized, matches);
    }

    const syncedIds = new Set<number>();
    const externalIds = new Set<number>();

    for (const prompt of externalPrompts) {
      externalIds.add(prompt.id);
      const externalKey = `${project.id}:${prompt.id}`;
      const normalized = normalizePromptText(prompt.prompt_text);
      const matchedByText = (byNormalizedText.get(normalized) || []).find(
        (row) => row.external_prompt_id == null
      );
      const existing = byExternalId.get(externalKey) || matchedByText;
      const category = existing?.source === "llmpulse"
        ? inferGeoPromptCategory(prompt.prompt_text)
        : existing?.category || inferGeoPromptCategory(prompt.prompt_text);

      if (existing) {
        await client.query(
          `UPDATE geo_prompts
           SET prompt_text = $2,
               category = $3,
               is_active = true,
               source = 'llmpulse',
               external_prompt_id = $4,
               external_project_id = $5,
               last_synced_at = NOW()
           WHERE id = $1`,
          [existing.id, prompt.prompt_text, category, prompt.id, project.id]
        );
        updated += 1;
        if (!existing.is_active) {
          reactivated += 1;
        }
        syncedIds.add(existing.id);
        continue;
      }

      const insertResult = await client.query<{ id: number }>(
        `INSERT INTO geo_prompts
          (prompt_text, category, is_active, source, external_prompt_id, external_project_id, last_synced_at)
         VALUES ($1, $2, true, 'llmpulse', $3, $4, NOW())
         RETURNING id`,
        [prompt.prompt_text, category, prompt.id, project.id]
      );
      inserted += 1;
      syncedIds.add(insertResult.rows[0].id);
    }

    for (const row of existingRows) {
      const externalPromptId = normalizeExternalId(row.external_prompt_id);
      const externalProjectId = normalizeExternalId(row.external_project_id);
      const isSyncedPrompt =
        row.source === "llmpulse" || externalPromptId != null;
      const isMissingFromExternal =
        externalProjectId === project.id &&
        externalPromptId != null &&
        !externalIds.has(externalPromptId);
      const isLegacyActivePrompt =
        row.source !== "llmpulse" && row.is_active && !syncedIds.has(row.id);

      if ((isSyncedPrompt && isMissingFromExternal) || isLegacyActivePrompt) {
        await client.query(
          `UPDATE geo_prompts
           SET is_active = false,
               last_synced_at = NOW()
           WHERE id = $1`,
          [row.id]
        );
        deactivated += 1;
      }
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  logger.info(
    {
      projectId: project.id,
      promptCount: externalPrompts.length,
      inserted,
      updated,
      reactivated,
      deactivated,
    },
    "Synced GEO prompts from LLM Pulse"
  );

  return {
    configured: true,
    project_id: project.id,
    prompt_count: externalPrompts.length,
    inserted,
    updated,
    reactivated,
    deactivated,
  };
}
