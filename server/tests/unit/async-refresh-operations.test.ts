/**
 * Tests for #7083: async compliance refresh operations.
 *
 * The compliance_operations table coalesces concurrent refresh
 * requests per agent URL via a unique partial index on
 * (agent_url, status='pending'). These tests exercise the
 * DB-method contract without the full route setup.
 */

import { describe, expect, it } from 'vitest';

interface ComplianceOperation {
  id: string;
  agentUrl: string;
  status: 'pending' | 'completed' | 'failed';
  triggeredBy: string;
  runId: string | null;
  error: string | null;
}

function createInMemoryStore() {
  const ops = new Map<string, ComplianceOperation>();
  const pendingByAgent = new Map<string, string>();
  let idCounter = 0;

  return {
    create(input: { agentUrl: string; triggeredBy: string; userId: string }): { id: string } | null {
      if (pendingByAgent.has(input.agentUrl)) return null;
      const id = `op-${++idCounter}`;
      ops.set(id, {
        id,
        agentUrl: input.agentUrl,
        status: 'pending',
        triggeredBy: input.triggeredBy,
        runId: null,
        error: null,
      });
      pendingByAgent.set(input.agentUrl, id);
      return { id };
    },

    complete(operationId: string, runId: string): void {
      const op = ops.get(operationId);
      if (op && op.status === 'pending') {
        op.status = 'completed';
        op.runId = runId;
        pendingByAgent.delete(op.agentUrl);
      }
    },

    fail(operationId: string, error: string): void {
      const op = ops.get(operationId);
      if (op && op.status === 'pending') {
        op.status = 'failed';
        op.error = error;
        pendingByAgent.delete(op.agentUrl);
      }
    },

    getPending(agentUrl: string): ComplianceOperation | null {
      const id = pendingByAgent.get(agentUrl);
      return id ? ops.get(id) ?? null : null;
    },

    get(operationId: string): ComplianceOperation | null {
      return ops.get(operationId) ?? null;
    },
  };
}

describe('async compliance refresh operations (#7083)', () => {
  it('creates a pending operation for a new agent', () => {
    const store = createInMemoryStore();
    const result = store.create({ agentUrl: 'https://agent.example/mcp', triggeredBy: 'owner_test', userId: 'user1' });
    expect(result).not.toBeNull();
    expect(result!.id).toBeTruthy();

    const pending = store.getPending('https://agent.example/mcp');
    expect(pending).not.toBeNull();
    expect(pending!.status).toBe('pending');
  });

  it('rejects duplicate pending operations for the same agent', () => {
    const store = createInMemoryStore();
    const first = store.create({ agentUrl: 'https://agent.example/mcp', triggeredBy: 'owner_test', userId: 'user1' });
    expect(first).not.toBeNull();

    const second = store.create({ agentUrl: 'https://agent.example/mcp', triggeredBy: 'manual', userId: 'user2' });
    expect(second).toBeNull();
  });

  it('allows new operation after previous one completes', () => {
    const store = createInMemoryStore();
    const first = store.create({ agentUrl: 'https://agent.example/mcp', triggeredBy: 'owner_test', userId: 'user1' });
    store.complete(first!.id, 'run-abc');

    const completed = store.get(first!.id);
    expect(completed!.status).toBe('completed');
    expect(completed!.runId).toBe('run-abc');

    const second = store.create({ agentUrl: 'https://agent.example/mcp', triggeredBy: 'owner_test', userId: 'user1' });
    expect(second).not.toBeNull();
    expect(second!.id).not.toBe(first!.id);
  });

  it('allows new operation after previous one fails', () => {
    const store = createInMemoryStore();
    const first = store.create({ agentUrl: 'https://agent.example/mcp', triggeredBy: 'manual', userId: 'user1' });
    store.fail(first!.id, 'compliance run failed');

    const failed = store.get(first!.id);
    expect(failed!.status).toBe('failed');
    expect(failed!.error).toBe('compliance run failed');

    const second = store.create({ agentUrl: 'https://agent.example/mcp', triggeredBy: 'manual', userId: 'user1' });
    expect(second).not.toBeNull();
  });

  it('different agents can have concurrent pending operations', () => {
    const store = createInMemoryStore();
    const a = store.create({ agentUrl: 'https://agent-a.example/mcp', triggeredBy: 'owner_test', userId: 'user1' });
    const b = store.create({ agentUrl: 'https://agent-b.example/mcp', triggeredBy: 'owner_test', userId: 'user1' });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
  });

  it('complete is idempotent on non-pending operations', () => {
    const store = createInMemoryStore();
    const op = store.create({ agentUrl: 'https://agent.example/mcp', triggeredBy: 'manual', userId: 'user1' });
    store.complete(op!.id, 'run-1');
    store.complete(op!.id, 'run-2');

    const result = store.get(op!.id);
    expect(result!.runId).toBe('run-1');
  });
});
