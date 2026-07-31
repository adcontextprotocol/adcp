/**
 * Database layer for the Secretariat console's action queue.
 *
 * Proposer jobs write rows via `propose()`; nothing executes until a human
 * approves in the admin console. State machine:
 *
 *   proposed -> approved -> executing -> done
 *   proposed -> rejected
 *   executing -> failed -> (retry) -> proposed
 *
 * Every transition is a single atomic `UPDATE ... WHERE status = '<from>'`
 * so concurrent callers (two admins clicking approve, or the executor and
 * a manual retry racing) can't double-apply a transition — the second
 * caller's WHERE clause matches zero rows and gets null back.
 */

import { query } from './client.js';

export type SecretariatActionStatus =
  | 'proposed'
  | 'approved'
  | 'rejected'
  | 'executing'
  | 'done'
  | 'failed';

/** Allowlisted action kinds. Keep in sync with secretariat-executor.ts. */
export type SecretariatActionKind =
  | 'open_pr'
  | 'post_issue_comment'
  | 'file_issue'
  | 'post_slack_message';

export interface SecretariatAction {
  id: string;
  kind: string;
  title: string;
  rationale: string;
  payload: Record<string, unknown>;
  status: SecretariatActionStatus;
  origin: string;
  dedupe_key: string | null;
  edited: boolean;
  result: Record<string, unknown> | null;
  error: string | null;
  decided_by: string | null;
  decided_at: Date | null;
  executed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ProposeActionInput {
  kind: string;
  title: string;
  rationale: string;
  payload: Record<string, unknown>;
  origin: string;
  dedupe_key?: string | null;
}

const COLUMNS = `id, kind, title, rationale, payload, status, origin, dedupe_key,
  edited, result, error, decided_by, decided_at, executed_at, created_at, updated_at`;

/**
 * Insert a proposed action. When `dedupe_key` collides with an existing
 * row, the insert is a no-op and the existing row is returned — proposer
 * jobs can be re-invoked freely without duplicating proposals.
 */
export async function propose(input: ProposeActionInput): Promise<SecretariatAction> {
  const inserted = await query<SecretariatAction>(
    `INSERT INTO secretariat_actions (kind, title, rationale, payload, origin, dedupe_key)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING ${COLUMNS}`,
    [
      input.kind,
      input.title,
      input.rationale,
      JSON.stringify(input.payload),
      input.origin,
      input.dedupe_key ?? null,
    ],
  );
  if (inserted.rows[0]) return inserted.rows[0];

  // Conflict: dedupe_key already exists. Fetch and return the existing row.
  const existing = await query<SecretariatAction>(
    `SELECT ${COLUMNS} FROM secretariat_actions WHERE dedupe_key = $1`,
    [input.dedupe_key],
  );
  if (!existing.rows[0]) {
    throw new Error(`propose: dedupe_key conflict but no existing row found for ${input.dedupe_key}`);
  }
  return existing.rows[0];
}

export interface ListActionsFilters {
  status?: SecretariatActionStatus;
  limit?: number;
}

export async function listByStatus(filters: ListActionsFilters = {}): Promise<SecretariatAction[]> {
  const limit = Math.min(Math.max(filters.limit ?? 200, 1), 200);
  if (filters.status) {
    const result = await query<SecretariatAction>(
      `SELECT ${COLUMNS} FROM secretariat_actions
       WHERE status = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [filters.status, limit],
    );
    return result.rows;
  }
  const result = await query<SecretariatAction>(
    `SELECT ${COLUMNS} FROM secretariat_actions
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit],
  );
  return result.rows;
}

export async function get(id: string): Promise<SecretariatAction | null> {
  const result = await query<SecretariatAction>(
    `SELECT ${COLUMNS} FROM secretariat_actions WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** Approve a proposed action. Returns null if it was not in `proposed`. */
export async function approve(id: string, decidedBy: string): Promise<SecretariatAction | null> {
  const result = await query<SecretariatAction>(
    `UPDATE secretariat_actions
     SET status = 'approved', decided_by = $2, decided_at = NOW()
     WHERE id = $1 AND status = 'proposed'
     RETURNING ${COLUMNS}`,
    [id, decidedBy],
  );
  return result.rows[0] ?? null;
}

/** Reject a proposed action. Returns null if it was not in `proposed`. */
export async function reject(
  id: string,
  decidedBy: string,
  reason: string,
): Promise<SecretariatAction | null> {
  const result = await query<SecretariatAction>(
    `UPDATE secretariat_actions
     SET status = 'rejected', decided_by = $2, decided_at = NOW(), error = $3
     WHERE id = $1 AND status = 'proposed'
     RETURNING ${COLUMNS}`,
    [id, decidedBy, reason],
  );
  return result.rows[0] ?? null;
}

/**
 * Edit the payload (and optionally title) of a still-proposed action.
 * Marks `edited = true` so the approved-without-edit autonomy metric
 * stays accurate. Returns null if the action is not in `proposed`.
 */
export async function editPayload(
  id: string,
  payload: Record<string, unknown>,
  title?: string,
): Promise<SecretariatAction | null> {
  const result = await query<SecretariatAction>(
    `UPDATE secretariat_actions
     SET payload = $2::jsonb, title = COALESCE($3, title), edited = true
     WHERE id = $1 AND status = 'proposed'
     RETURNING ${COLUMNS}`,
    [id, JSON.stringify(payload), title ?? null],
  );
  return result.rows[0] ?? null;
}

/**
 * Atomically claim an approved action for execution. Returns null if the
 * action is not (or no longer) `approved` — e.g. a concurrent executor
 * tick already claimed it. This is the sole guard against double
 * execution; callers must not execute a payload without a successful
 * claim.
 */
export async function claimForExecution(id: string): Promise<SecretariatAction | null> {
  const result = await query<SecretariatAction>(
    `UPDATE secretariat_actions
     SET status = 'executing'
     WHERE id = $1 AND status = 'approved'
     RETURNING ${COLUMNS}`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function markDone(
  id: string,
  result_: Record<string, unknown>,
): Promise<SecretariatAction | null> {
  const result = await query<SecretariatAction>(
    `UPDATE secretariat_actions
     SET status = 'done', result = $2::jsonb, executed_at = NOW()
     WHERE id = $1 AND status = 'executing'
     RETURNING ${COLUMNS}`,
    [id, JSON.stringify(result_)],
  );
  return result.rows[0] ?? null;
}

export async function markFailed(id: string, error: string): Promise<SecretariatAction | null> {
  const result = await query<SecretariatAction>(
    `UPDATE secretariat_actions
     SET status = 'failed', error = $2
     WHERE id = $1 AND status = 'executing'
     RETURNING ${COLUMNS}`,
    [id, error],
  );
  return result.rows[0] ?? null;
}

/**
 * Send a failed action back to `proposed` so it can be reviewed, edited
 * if needed, and re-approved. Clears the prior decision and error so the
 * inbox card looks like a fresh proposal.
 */
export async function retry(id: string): Promise<SecretariatAction | null> {
  const result = await query<SecretariatAction>(
    `UPDATE secretariat_actions
     SET status = 'proposed', error = NULL, decided_by = NULL, decided_at = NULL
     WHERE id = $1 AND status = 'failed'
     RETURNING ${COLUMNS}`,
    [id],
  );
  return result.rows[0] ?? null;
}

export interface SecretariatActionStats {
  by_kind_status: Array<{ kind: string; status: SecretariatActionStatus; count: number }>;
  approval_rate_by_kind: Array<{
    kind: string;
    decided: number;
    approved_without_edit: number;
    rate: number | null;
  }>;
}

/**
 * Counts by kind x status, plus per-kind approved-without-edit rate
 * (approved where edited=false / all decided). Feeds the future
 * autonomy toggles: a kind with a consistently high rate is a candidate
 * to promote from "propose" to "auto-execute".
 */
export async function getStats(): Promise<SecretariatActionStats> {
  const [byKindStatus, byKind] = await Promise.all([
    query<{ kind: string; status: SecretariatActionStatus; count: string }>(
      `SELECT kind, status, COUNT(*)::text AS count
       FROM secretariat_actions
       GROUP BY kind, status
       ORDER BY kind, status`,
    ),
    query<{ kind: string; decided: string; approved_without_edit: string }>(
      `SELECT
         kind,
         COUNT(*) FILTER (WHERE decided_by IS NOT NULL)::text AS decided,
         COUNT(*) FILTER (
           WHERE decided_by IS NOT NULL AND status <> 'rejected' AND edited = false
         )::text AS approved_without_edit
       FROM secretariat_actions
       GROUP BY kind
       ORDER BY kind`,
    ),
  ]);

  return {
    by_kind_status: byKindStatus.rows.map((r) => ({
      kind: r.kind,
      status: r.status,
      count: parseInt(r.count, 10),
    })),
    approval_rate_by_kind: byKind.rows.map((r) => {
      const decided = parseInt(r.decided, 10);
      const approvedWithoutEdit = parseInt(r.approved_without_edit, 10);
      return {
        kind: r.kind,
        decided,
        approved_without_edit: approvedWithoutEdit,
        rate: decided > 0 ? approvedWithoutEdit / decided : null,
      };
    }),
  };
}
