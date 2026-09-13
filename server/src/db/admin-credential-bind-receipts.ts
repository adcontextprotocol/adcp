import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PoolClient, QueryResult } from 'pg';

// These proofs are scoped to the admin saga and always use its supplied client.
// A proof performs reads only; the transaction owner runs every proof after
// forcing deferred constraints and immediately before its checked COMMIT.
export type AdminCredentialReceipt = ((client: PoolClient) => Promise<void>) & {
  audit?: { operationId: string; row: Record<string, unknown> };
};
export const ADMIN_CREDENTIAL_ROW_VERSION = "xmin::text || ':' || ctid::text AS receipt_version";

export function assertSingleAdminCredentialRow<T extends Record<string, unknown>>(result: QueryResult<T>): T {
  const row = result.rows[0];
  if (result.rowCount !== 1 || result.rows.length !== 1 || !row
    || typeof row.receipt_version !== 'string' || !/^\d+:\(\d+,\d+\)$/.test(row.receipt_version)) {
    throw new Error('Unconfirmed admin credential row receipt');
  }
  return row;
}

const actions = {
  operation: 'admin_credential_bind',
  quarantine: 'identity_credential_admin_compensation_quarantined',
  deletion: 'identity_credential_admin_compensation_deleted',
} as const;

interface AuditInput {
  kind: keyof typeof actions;
  workosUserId: string;
  operationId: string;
  details: Record<string, unknown>;
}

function assertAudit(row: Record<string, unknown>, input: AuditInput): void {
  if (row.workos_organization_id !== 'system' || row.workos_user_id !== input.workosUserId
    || row.action !== actions[input.kind] || row.resource_type !== 'admin_credential_bind_operation'
    || row.resource_id !== input.operationId || !isDeepStrictEqual(row.details, input.details)
    || typeof row.id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(row.id)
    || !(row.created_at instanceof Date) || !Number.isFinite(row.created_at.getTime())) {
    throw new Error('Altered admin credential audit receipt');
  }
}

/** Also checks an existing quarantine retained across the provider deletion. */
export function adminCredentialAuditReceipt(row: Record<string, unknown>, input: AuditInput): AdminCredentialReceipt {
  assertAudit(row, input);
  const expected = structuredClone(row);
  const verify: AdminCredentialReceipt = async (client) => {
    // Operation tuple versions distinguish legitimate repeated reconciliation
    // events. A lifecycle marker has exactly one event per operation/action.
    const actual = await client.query(
      `SELECT *, ${ADMIN_CREDENTIAL_ROW_VERSION} FROM registry_audit_log
        WHERE id = $1 OR (resource_id = $2 AND action = $3
          ${input.kind === 'operation' ? "AND (details->>'operation_version') IS NOT DISTINCT FROM $4::text" : ''})
        FOR UPDATE`,
      [expected.id, input.operationId, actions[input.kind], ...(input.kind === 'operation' ? [input.details.operation_version ?? null] : [])],
    );
    if (!isDeepStrictEqual(assertSingleAdminCredentialRow(actual), expected)) {
      throw new Error('Admin credential audit changed before commit');
    }
  };
  verify.audit = { operationId: input.operationId, row: expected };
  return verify;
}

export async function insertAdminCredentialAudit(client: PoolClient, input: AuditInput): Promise<AdminCredentialReceipt> {
  const id = randomUUID();
  const createdAt = new Date();
  const action = actions[input.kind];
  if (!action) throw new Error('Unknown admin credential audit action');
  const result = await client.query(
    `INSERT INTO registry_audit_log /* ${action} */
       (id, workos_organization_id, workos_user_id, action, resource_type, resource_id, details, created_at)
     VALUES ($1, 'system', $2, $3, 'admin_credential_bind_operation', $4, $5::jsonb, $6)
     RETURNING *, ${ADMIN_CREDENTIAL_ROW_VERSION}, created_at = $6::timestamptz AS timestamp_matches`,
    [id, input.workosUserId, action, input.operationId, JSON.stringify(input.details), createdAt],
  );
  const row = assertSingleAdminCredentialRow(result);
  if (row.id !== id || row.timestamp_matches !== true) throw new Error('Altered admin audit identity or timestamp');
  const stored = { ...row };
  delete stored.timestamp_matches;
  return adminCredentialAuditReceipt(stored, input);
}

export async function verifyAdminCredentialTransaction(client: PoolClient, receipts: AdminCredentialReceipt[]): Promise<void> {
  if ((await client.query('SET CONSTRAINTS ALL IMMEDIATE')).command !== 'SET') {
    throw new Error('Unconfirmed deferred constraint check');
  }
  for (const receipt of receipts) await receipt(client);
}

/** Snapshot before any phase writes; final verification detects extra events too.
 * Do not retain this transaction-local cardinality snapshot for later phases. */
export async function readAdminCredentialAuditCohort(client: PoolClient, operationId: string, lock = false): Promise<Record<string, unknown>[]> {
  const result = await client.query(
    `SELECT *, ${ADMIN_CREDENTIAL_ROW_VERSION} FROM registry_audit_log WHERE resource_id = $1 ORDER BY id ${lock ? 'FOR UPDATE' : ''}`, [operationId],
  );
  if (result.rowCount !== result.rows.length || new Set(result.rows.map(row => row.id)).size !== result.rows.length) {
    throw new Error('Unconfirmed admin audit cohort');
  }
  for (const row of result.rows) {
    assertSingleAdminCredentialRow({ ...result, rows: [row], rowCount: 1 });
    if (typeof row.id !== 'string') throw new Error('Unconfirmed admin audit identity');
  }
  return result.rows;
}

export async function verifyAdminCredentialAuditCohort(client: PoolClient, operationId: string,
  baseline: Record<string, unknown>[], receipts: AdminCredentialReceipt[]): Promise<void> {
  const expected = new Map(baseline.map(row => [row.id, row]));
  for (const receipt of receipts) {
    if (!receipt.audit || receipt.audit.operationId !== operationId) continue;
    const row = receipt.audit.row;
    const previous = expected.get(row.id);
    if (previous && !isDeepStrictEqual(previous, row)) throw new Error('Prior admin audit was changed');
    expected.set(row.id, row);
  }
  const actual = await readAdminCredentialAuditCohort(client, operationId, true);
  if (actual.length !== expected.size || actual.some(row => !isDeepStrictEqual(row, expected.get(row.id)))) {
    throw new Error('Admin audit cohort changed before commit');
  }
}
