import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function migration(name: string): string {
  return readFileSync(join(process.cwd(), 'server/src/db/migrations', name), 'utf8');
}

describe('durable governance and task schemas', () => {
  it('stores each governance binding once with both immutable account aliases', () => {
    const sql = migration('560_governance_bindings_and_task_owner_scope.sql');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS governance_agent_bindings');
    expect(sql).toContain('PRIMARY KEY (principal_scope, account_id)');
    expect(sql).toContain('UNIQUE (principal_scope, account_scope)');
    expect(sql).toContain('brand_domain TEXT NOT NULL');
    expect(sql).toContain('account_ref JSONB NOT NULL');
    expect(sql).toContain('jsonb_array_length(agents) = 1');
  });

  it('upgrades fresh and existing task registries to the SDK owner-scope shape', () => {
    const base = migration('463_adcp_decisioning_tasks.sql');
    const upgrade = migration('560_governance_bindings_and_task_owner_scope.sql');
    expect(base).toContain('CREATE TABLE IF NOT EXISTS adcp_decisioning_tasks');
    expect(upgrade).toContain('ADD COLUMN IF NOT EXISTS owner_scope TEXT');
    expect(upgrade).toContain('idx_adcp_decisioning_tasks_owner_account');
    expect(upgrade).toContain('(owner_scope, account_id)');
  });

  it('defines a recoverable leased seller-managed execution outbox', () => {
    const sql = migration('561_seller_managed_control_jobs.sql');
    for (const fragment of [
      'task_id TEXT PRIMARY KEY',
      'owner_scope TEXT NOT NULL',
      'expected_revision INTEGER NOT NULL CHECK (expected_revision >= 1)',
      'authorized_actions JSONB NOT NULL',
      'execution_context JSONB NOT NULL',
      'has_webhook BOOLEAN NOT NULL DEFAULT FALSE',
      'webhook_tenant_scope TEXT',
      'UNIQUE (idempotency_principal, account_id, idempotency_key)',
      'push_config_encrypted TEXT',
      'request_fingerprint TEXT NOT NULL',
      'lease_version BIGINT NOT NULL DEFAULT 0',
      'terminal_at TIMESTAMPTZ',
      'task_synced_at TIMESTAMPTZ',
      'WHERE task_synced_at IS NULL',
    ]) expect(sql).toContain(fragment);
  });

  it('keeps cross-session seller-control webhook replay fail-closed', () => {
    const source = readFileSync(
      join(process.cwd(), 'server/src/training-agent/seller-managed-control-jobs.ts'),
      'utf8',
    );
    expect(source).toContain("outbox.publisher_scope = 'adcp-training-agent'");
    expect(source).toContain('suppress_previous_webhook AS');
    expect(source).toContain('discard_previous_outbox AS');
    expect(source).toContain("authorized.webhook_tenant_scope,\n                'task-webhook:'");
    expect(source).toContain('idempotency_principal = $3');
    expect(source).toContain("tasks.tool = 'control_media_buy'");
  });
});
