/**
 * Database layer for escalation triage suggestions.
 *
 * Suggestions are written by the triage runner and reviewed by admins.
 */

import { query } from './client.js';

export type SuggestedStatus = 'resolved' | 'wont_do' | 'keep_open' | 'file_as_issue';
export type SuggestionConfidence = 'high' | 'medium' | 'low';
export type SuggestionDecision = 'accepted' | 'rejected' | 'superseded';

export interface ProposedGithubIssue {
  title: string;
  body: string;
  repo: string;
  labels: string[];
}

export interface TriageSuggestion {
  id: number;
  escalation_id: number;
  suggested_at: Date;
  suggested_status: SuggestedStatus;
  confidence: SuggestionConfidence;
  bucket: string | null;
  reasoning: string;
  evidence: string[];
  proposed_github_issue: ProposedGithubIssue | null;
  reviewed_at: Date | null;
  reviewed_by: string | null;
  decision: SuggestionDecision | null;
  decision_notes: string | null;
}

export interface TriageSuggestionInput {
  escalation_id: number;
  suggested_status: SuggestedStatus;
  confidence: SuggestionConfidence;
  bucket?: string | null;
  reasoning: string;
  evidence: string[];
  proposed_github_issue?: ProposedGithubIssue | null;
}

/**
 * Insert a new suggestion. Returns null if a pending suggestion already
 * exists for this escalation (unique partial index enforces this), which
 * lets the runner be safely re-invoked without duplicate rows.
 */
export async function insertSuggestionIfNew(
  input: TriageSuggestionInput,
): Promise<TriageSuggestion | null> {
  const result = await query<TriageSuggestion>(
    `INSERT INTO escalation_triage_suggestions
      (escalation_id, suggested_status, confidence, bucket, reasoning, evidence, proposed_github_issue)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [
      input.escalation_id,
      input.suggested_status,
      input.confidence,
      input.bucket ?? null,
      input.reasoning,
      JSON.stringify(input.evidence ?? []),
      input.proposed_github_issue ? JSON.stringify(input.proposed_github_issue) : null,
    ],
  );
  return result.rows[0] ?? null;
}

export interface ListSuggestionsFilters {
  pending_only?: boolean;
  confidence?: SuggestionConfidence;
  bucket?: string;
  limit?: number;
  offset?: number;
}

export async function listSuggestions(
  filters: ListSuggestionsFilters = {},
): Promise<TriageSuggestion[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (filters.pending_only) conditions.push(`decision IS NULL`);
  if (filters.confidence) {
    conditions.push(`confidence = $${i++}`);
    params.push(filters.confidence);
  }
  if (filters.bucket) {
    conditions.push(`bucket = $${i++}`);
    params.push(filters.bucket);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(filters.limit ?? 100, 500);
  const offset = Math.max(filters.offset ?? 0, 0);

  const result = await query<TriageSuggestion>(
    `SELECT * FROM escalation_triage_suggestions
     ${where}
     ORDER BY suggested_at DESC
     LIMIT $${i++} OFFSET $${i}`,
    [...params, limit, offset],
  );
  return result.rows;
}

export async function getSuggestion(id: number): Promise<TriageSuggestion | null> {
  const result = await query<TriageSuggestion>(
    `SELECT * FROM escalation_triage_suggestions WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function getPendingSuggestionForEscalation(
  escalationId: number,
): Promise<TriageSuggestion | null> {
  const result = await query<TriageSuggestion>(
    `SELECT * FROM escalation_triage_suggestions
     WHERE escalation_id = $1 AND decision IS NULL
     LIMIT 1`,
    [escalationId],
  );
  return result.rows[0] ?? null;
}

export async function recordDecision(
  id: number,
  decision: SuggestionDecision,
  reviewedBy: string,
  notes?: string,
): Promise<TriageSuggestion | null> {
  const result = await query<TriageSuggestion>(
    `UPDATE escalation_triage_suggestions
     SET decision = $2,
         reviewed_by = $3,
         reviewed_at = NOW(),
         decision_notes = $4
     WHERE id = $1
     RETURNING *`,
    [id, decision, reviewedBy, notes ?? null],
  );
  return result.rows[0] ?? null;
}

export async function getSuggestionStats(): Promise<{
  pending: number;
  by_confidence: Record<string, number>;
  by_bucket: Record<string, number>;
}> {
  const [pending, byConf, byBucket] = await Promise.all([
    query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM escalation_triage_suggestions WHERE decision IS NULL`,
    ),
    query<{ confidence: string; count: string }>(
      `SELECT confidence, COUNT(*)::text AS count
       FROM escalation_triage_suggestions
       WHERE decision IS NULL
       GROUP BY confidence`,
    ),
    query<{ bucket: string | null; count: string }>(
      `SELECT bucket, COUNT(*)::text AS count
       FROM escalation_triage_suggestions
       WHERE decision IS NULL
       GROUP BY bucket`,
    ),
  ]);

  const by_confidence: Record<string, number> = {};
  for (const r of byConf.rows) by_confidence[r.confidence] = parseInt(r.count, 10);

  const by_bucket: Record<string, number> = {};
  for (const r of byBucket.rows) by_bucket[r.bucket ?? 'unknown'] = parseInt(r.count, 10);

  return {
    pending: parseInt(pending.rows[0]?.count ?? '0', 10),
    by_confidence,
    by_bucket,
  };
}
