/**
 * Read-only certification reconciliation snapshot.
 *
 * This command never mutates state. It requires exact learner/module/thread
 * identifiers, reports durable reservation status, and names the existing
 * audited admin endpoint an operator may use after reviewing the evidence.
 *
 * Development:
 *   DATABASE_URL=... npx tsx server/src/scripts/audit-certification-reconciliation.ts \
 *     --workos-user-id=user_... --module-id=C3 --thread-id=<uuid> [--attempt-id=<uuid>]
 *
 * Production after deployment:
 *   fly ssh console -a adcp-docs -C 'node /app/dist/scripts/audit-certification-reconciliation.js \
 *     --workos-user-id=user_... --module-id=C3 --thread-id=<uuid> [--attempt-id=<uuid>]'
 */

import { getDatabaseConfig } from '../config.js';
import { closeDatabase, getPool, initializeDatabase } from '../db/client.js';
import { DURABLE_HANDLER_OUTCOME_TOOLS } from '../addie/side-effect-claims.js';
import {
  classifyReservation,
  DURABLE_RESERVATION_RESULT,
  type AuditedToolCall,
} from '../certification/durable-outcome-reconciliation.js';

interface Arguments {
  workosUserId: string;
  moduleId: string;
  threadId: string;
  attemptId?: string;
}

interface ToolCallRow extends AuditedToolCall {
  created_at: Date;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseArguments(argv: string[]): Arguments {
  const values = new Map<string, string>();
  for (const arg of argv) {
    const match = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (!match) throw new Error(`Invalid argument ${JSON.stringify(arg)}; use --name=value`);
    values.set(match[1], match[2]);
  }

  const workosUserId = values.get('workos-user-id');
  const moduleId = values.get('module-id')?.toUpperCase();
  const threadId = values.get('thread-id');
  const attemptId = values.get('attempt-id');
  if (!workosUserId || !moduleId || !threadId) {
    throw new Error('--workos-user-id, --module-id, and --thread-id are required');
  }
  if (workosUserId.length > 255) throw new Error('--workos-user-id is too long');
  if (!/^[A-Z][A-Z0-9]{0,9}$/.test(moduleId)) throw new Error('--module-id is invalid');
  if (!UUID_RE.test(threadId)) throw new Error('--thread-id must be a UUID');
  if (attemptId && !UUID_RE.test(attemptId)) throw new Error('--attempt-id must be a UUID');

  return { workosUserId, moduleId, threadId, ...(attemptId && { attemptId }) };
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const dbConfig = getDatabaseConfig();
  if (!dbConfig) throw new Error('DATABASE_URL is required');
  initializeDatabase(dbConfig);
  const pool = getPool();

  try {
    const [learner, thread, module, progress, attempts, checkpoints, credentials, adminCompletions, adminAttemptResolutions, callRows] = await Promise.all([
      pool.query('SELECT * FROM users WHERE workos_user_id = $1', [args.workosUserId]),
      pool.query(
        `SELECT * FROM addie_threads
         WHERE thread_id = $1 AND user_id = $2`,
        [args.threadId, args.workosUserId],
      ),
      pool.query('SELECT * FROM certification_modules WHERE id = $1', [args.moduleId]),
      pool.query(
        `SELECT * FROM learner_progress
         WHERE workos_user_id = $1 AND module_id = $2`,
        [args.workosUserId, args.moduleId],
      ),
      pool.query(
        `SELECT * FROM certification_attempts
         WHERE workos_user_id = $1
           AND (module_id = $2 OR ($3::uuid IS NOT NULL AND id = $3::uuid))
         ORDER BY created_at DESC`,
        [args.workosUserId, args.moduleId, args.attemptId ?? null],
      ),
      pool.query(
        `SELECT * FROM teaching_checkpoints
         WHERE workos_user_id = $1 AND module_id = $2
         ORDER BY created_at DESC`,
        [args.workosUserId, args.moduleId],
      ),
      pool.query(
        `SELECT uc.*, cc.name, cc.tier, cc.required_modules, cc.certifier_group_id
         FROM user_credentials uc
         JOIN certification_credentials cc ON cc.id = uc.credential_id
         WHERE uc.workos_user_id = $1
         ORDER BY uc.awarded_at, uc.id`,
        [args.workosUserId],
      ),
      pool.query(
        `SELECT * FROM admin_module_completions
         WHERE workos_user_id = $1 AND module_id = $2
         ORDER BY created_at DESC`,
        [args.workosUserId, args.moduleId],
      ),
      pool.query(
        `SELECT * FROM admin_attempt_resolutions
         WHERE workos_user_id = $1 AND module_id = $2
         ORDER BY created_at DESC`,
        [args.workosUserId, args.moduleId],
      ),
      pool.query<ToolCallRow>(
        `SELECT m.message_id::text,
                m.sequence_number,
                m.created_at,
                tool_call->>'name' AS name,
                tool_call->'input' AS input,
                tool_call->'result' AS result,
                CASE WHEN tool_call ? 'is_error'
                     THEN (tool_call->>'is_error')::boolean END AS is_error,
                tool_call->>'result_status' AS result_status,
                tool_call->>'durable_outcome' AS durable_outcome
         FROM addie_thread_messages m
         CROSS JOIN LATERAL jsonb_array_elements(COALESCE(m.tool_calls::jsonb, '[]'::jsonb)) tool_call
         WHERE m.thread_id = $1
           AND tool_call->>'name' = ANY($2::text[])
         ORDER BY m.sequence_number, m.created_at`,
        [args.threadId, DURABLE_HANDLER_OUTCOME_TOOLS],
      ),
    ]);

    if (learner.rows.length !== 1) throw new Error('Exact learner was not found');
    if (thread.rows.length !== 1) throw new Error('Thread was not found or does not belong to the learner');
    if (module.rows.length !== 1) throw new Error('Certification module was not found');
    if (args.attemptId && !attempts.rows.some((row) => row.id === args.attemptId)) {
      throw new Error('Attempt was not found for this learner/module scope');
    }

    const reservations = callRows.rows
      .filter((call) => call.result === DURABLE_RESERVATION_RESULT && call.is_error === true)
      .map((reservation) => ({
        message_id: reservation.message_id,
        sequence_number: reservation.sequence_number,
        tool_name: reservation.name,
        input: reservation.input,
        ...classifyReservation(reservation, callRows.rows),
      }));

    const progressRow = progress.rows[0] as { status?: string } | undefined;
    const activeAttempt = attempts.rows.find((row) => row.status === 'in_progress') as { id: string } | undefined;
    const latestCheckpoint = checkpoints.rows[0] as { id: string } | undefined;
    const recommendation = progressRow?.status === 'completed' || progressRow?.status === 'tested_out'
      ? {
          action: 'verify_only',
          reason: `Module is already ${progressRow.status}; do not submit another completion.`,
        }
      : checkpoints.rows.length === 0
        ? {
            action: 'human_certification_judgment_required',
            reason: 'No persisted teaching checkpoint exists. Do not complete or fabricate evidence.',
          }
        : activeAttempt
        ? {
            action: 'human_review_then_admin_attempt_resolution',
            reason: 'An in-progress attempt exists. A human must validate the checkpoint and scores before mutation.',
            endpoint: `POST /api/admin/certification/attempts/${activeAttempt.id}/resolve`,
            required_teaching_checkpoint_id: latestCheckpoint?.id,
          }
        : {
            action: 'human_review_then_admin_module_completion',
            reason: 'No active attempt exists. The audited endpoint will independently validate checkpoint ownership, criteria, and scores.',
            endpoint: `POST /api/admin/certification/learners/${args.workosUserId}/modules/${args.moduleId}/complete`,
          };

    console.log(JSON.stringify({
      generated_at: new Date().toISOString(),
      mode: 'dry_run_read_only',
      identifiers: {
        workos_user_id: args.workosUserId,
        module_id: args.moduleId,
        thread_id: args.threadId,
        attempt_id: args.attemptId ?? null,
      },
      learner: learner.rows[0],
      thread: thread.rows[0],
      module: module.rows[0],
      learner_progress: progress.rows,
      certification_attempts: attempts.rows,
      teaching_checkpoints: checkpoints.rows,
      durable_reservations: reservations,
      certification_tool_calls: callRows.rows,
      credentials: credentials.rows,
      admin_module_completions: adminCompletions.rows,
      admin_attempt_resolutions: adminAttemptResolutions.rows,
      recommendation,
      safety: {
        mutated: false,
        evidence_policy: 'Do not infer evidence not present in teaching_checkpoints.',
        credential_policy: 'Use audited admin endpoints only; never insert credentials directly.',
      },
    }, null, 2));
  } finally {
    await closeDatabase();
  }
}

main().catch((error) => {
  console.error('Certification reconciliation audit failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
