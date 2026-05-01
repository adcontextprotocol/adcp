/**
 * Append-only audit log for agent type transitions. Closes #3550.
 *
 * Three writers feed this table — see `461_create_type_reclassification_log.sql`
 * for the schema rationale. This module is intentionally minimal: a single
 * insert helper. Idempotency at the row level means the caller decides what
 * counts as a "change" — we don't dedupe.
 *
 * On insert failure we log and swallow — the audit log is observability, not
 * a write barrier. A failed audit write must NOT roll back the caller's
 * primary intent (a member-profile save, a crawl probe, a backfill row).
 */
import { query } from './client.js';
import { createLogger } from '../logger.js';
import { captureEvent } from '../utils/posthog.js';

const log = createLogger('type-reclassification-log');

export type TypeReclassificationSource =
  | 'backfill_script'
  | 'crawler_promote'
  | 'member_write';

export interface TypeReclassificationInsert {
  agentUrl: string;
  memberId?: string | null;
  oldType?: string | null;
  newType: string;
  source: TypeReclassificationSource;
  runId?: string | null;
  notes?: Record<string, unknown> | null;
}

export async function insertTypeReclassification(
  entry: TypeReclassificationInsert
): Promise<void> {
  try {
    await query(
      `INSERT INTO type_reclassification_log
         (agent_url, member_id, old_type, new_type, source, run_id, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        entry.agentUrl,
        entry.memberId ?? null,
        entry.oldType ?? null,
        entry.newType,
        entry.source,
        entry.runId ?? null,
        entry.notes ? JSON.stringify(entry.notes) : null,
      ]
    );
  } catch (err) {
    // PostgreSQL SQLSTATE codes are 5 chars; the first 2 are the error class
    // (e.g. '23' = integrity_constraint_violation, '08' = connection_exception).
    // The class is what ops actually alerts on — the full code is too granular.
    const pgCode = (err as { code?: unknown })?.code;
    const errorClass =
      typeof pgCode === 'string' && pgCode.length >= 2
        ? pgCode.slice(0, 2)
        : 'unknown';

    captureEvent('server-metrics', 'audit_log_insert_failed', {
      source: entry.source,
      error_class: errorClass,
    });

    log.warn(
      {
        err,
        agentUrl: entry.agentUrl,
        source: entry.source,
        oldType: entry.oldType ?? null,
        newType: entry.newType,
      },
      'Failed to insert type_reclassification_log row; swallowing — audit log is observability, not a write barrier.'
    );
  }
}
