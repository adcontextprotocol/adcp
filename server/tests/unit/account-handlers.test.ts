import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createTrainingAgentServer,
  invalidateCache,
  clearTaskStore,
} from '../../src/training-agent/task-handlers.js';
import { clearSessions } from '../../src/training-agent/state.js';
import { clearAccountStore } from '../../src/training-agent/account-handlers.js';
import { MUTATING_TOOLS, clearIdempotencyCache } from '../../src/training-agent/idempotency.js';
import type { TrainingContext } from '../../src/training-agent/types.js';

const DEFAULT_CTX: TrainingContext = { mode: 'open' };

function withIdempotencyKey(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  if (!MUTATING_TOOLS.has(toolName)) return args;
  if (args.idempotency_key !== undefined) return args;
  return { ...args, idempotency_key: `test-${randomUUID()}` };
}

/**
 * Simulate CallTool request on an MCP server.
 */
async function simulateCallTool(
  server: ReturnType<typeof createTrainingAgentServer>,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ result: Record<string, unknown>; isError?: boolean }> {
  const requestHandlers = (server as any)._requestHandlers as Map<string, Function>;
  const handler = requestHandlers.get('tools/call');
  if (!handler) {
    throw new Error('CallTool handler not found');
  }
  const response = await handler(
    { method: 'tools/call', params: { name: toolName, arguments: withIdempotencyKey(toolName, args) } },
    {},
  );
  const text = response.content?.[0]?.text;
  const parsed: Record<string, unknown> = response.structuredContent
    ? (response.structuredContent as Record<string, unknown>)
    : (text ? JSON.parse(text) : {});
  const result = (parsed.adcp_error as Record<string, unknown> | undefined) ?? parsed;
  return {
    result,
    isError: response.isError,
  };
}

// ── sync_accounts ──────────────────────────────────────────────────

describe('sync_accounts', () => {
  let server: ReturnType<typeof createTrainingAgentServer>;

  beforeEach(() => {
    clearSessions();
    clearAccountStore();
    clearTaskStore();
    clearIdempotencyCache();
    invalidateCache();
    server = createTrainingAgentServer(DEFAULT_CTX);
  });

  it('sandbox account is active immediately', async () => {
    const { result } = await simulateCallTool(server, 'sync_accounts', {
      accounts: [{
        brand: { domain: 'acme.com', name: 'Acme' },
        operator: 'agency-one',
        billing: 'operator',
        sandbox: true,
      }],
    });

    expect(result.accounts).toHaveLength(1);
    const acct = (result.accounts as Record<string, unknown>[])[0];
    expect(acct.status).toBe('active');
    expect(acct.sandbox).toBe(true);
    expect(acct.account_id).toBeTruthy();
    expect(acct.action).toBe('created');
    expect(acct.rate_card).toBe('sandbox');
    expect(acct.credit_limit).toBeUndefined();
    expect(acct.setup).toBeUndefined();
  });

  it('non-sandbox account is pending_approval with setup URL', async () => {
    const { result } = await simulateCallTool(server, 'sync_accounts', {
      accounts: [{
        brand: { domain: 'acme.com', name: 'Acme' },
        operator: 'agency-one',
        billing: 'operator',
      }],
    });

    expect(result.accounts).toHaveLength(1);
    const acct = (result.accounts as Record<string, unknown>[])[0];
    expect(acct.status).toBe('pending_approval');
    expect(acct.sandbox).toBeUndefined();
    expect(acct.account_id).toBeTruthy();
    expect(acct.action).toBe('created');
    expect(acct.rate_card).toBe('standard');
    expect(acct.credit_limit).toEqual({ amount: 100000, currency: 'USD' });

    const setup = acct.setup as Record<string, unknown>;
    expect(setup).toBeDefined();
    expect(typeof setup.url).toBe('string');
    expect(setup.message).toBeTruthy();
    expect(setup.expires_at).toBeTruthy();
  });

  it('duplicate account sync updates rather than creates', async () => {
    // First sync — creates
    const { result: first } = await simulateCallTool(server, 'sync_accounts', {
      accounts: [{
        brand: { domain: 'acme.com' },
        operator: 'agency-one',
        billing: 'operator',
        sandbox: true,
      }],
    });
    const firstAcct = (first.accounts as Record<string, unknown>[])[0];
    expect(firstAcct.action).toBe('created');
    const accountId = firstAcct.account_id;

    // Second sync — updates, same account_id preserved
    const { result: second } = await simulateCallTool(server, 'sync_accounts', {
      accounts: [{
        brand: { domain: 'acme.com' },
        operator: 'agency-one',
        billing: 'agent',
        sandbox: true,
      }],
    });
    const secondAcct = (second.accounts as Record<string, unknown>[])[0];
    expect(secondAcct.action).toBe('updated');
    expect(secondAcct.account_id).toBe(accountId);
    expect(secondAcct.billing).toBe('agent');
  });

  it('rejects account with missing brand.domain', async () => {
    const { result } = await simulateCallTool(server, 'sync_accounts', {
      accounts: [{
        brand: {},
        operator: 'agency-one',
        billing: 'operator',
      }],
    });

    const acct = (result.accounts as Record<string, unknown>[])[0];
    expect(acct.action).toBe('failed');
    expect(acct.status).toBe('rejected');
    const errors = acct.errors as Array<{ code: string; message: string }>;
    expect(errors[0].code).toBe('INVALID_REQUEST');
    expect(errors[0].message).toContain('brand.domain');
  });

  it('rejects account with missing operator', async () => {
    const { result } = await simulateCallTool(server, 'sync_accounts', {
      accounts: [{
        brand: { domain: 'acme.com' },
        operator: '',
        billing: 'operator',
      }],
    });

    const acct = (result.accounts as Record<string, unknown>[])[0];
    expect(acct.action).toBe('failed');
    expect(acct.status).toBe('rejected');
    const errors = acct.errors as Array<{ code: string; message: string }>;
    expect(errors[0].code).toBe('INVALID_REQUEST');
    expect(errors[0].message).toContain('operator');
  });

  it('rejects unsupported payment_terms', async () => {
    const { result } = await simulateCallTool(server, 'sync_accounts', {
      accounts: [{
        brand: { domain: 'acme.com' },
        operator: 'agency-one',
        billing: 'operator',
        payment_terms: 'net_120',
      }],
    });

    const acct = (result.accounts as Record<string, unknown>[])[0];
    expect(acct.action).toBe('failed');
    expect(acct.status).toBe('rejected');
    const errors = acct.errors as Array<{ code: string; message: string }>;
    expect(errors[0].code).toBe('PAYMENT_TERMS_NOT_SUPPORTED');
  });

  it('dry_run previews without persisting', async () => {
    const { result } = await simulateCallTool(server, 'sync_accounts', {
      accounts: [{
        brand: { domain: 'acme.com' },
        operator: 'agency-one',
        billing: 'operator',
        sandbox: true,
      }],
      dry_run: true,
    });

    expect(result.dry_run).toBe(true);
    const acct = (result.accounts as Record<string, unknown>[])[0];
    expect(acct.action).toBe('created');
    expect(acct.status).toBe('active');
    // No account_id assigned in dry run
    expect(acct.account_id).toBeUndefined();

    // Verify nothing persisted — second real call should still see 'created'
    const { result: real } = await simulateCallTool(server, 'sync_accounts', {
      accounts: [{
        brand: { domain: 'acme.com' },
        operator: 'agency-one',
        billing: 'operator',
        sandbox: true,
      }],
    });
    const realAcct = (real.accounts as Record<string, unknown>[])[0];
    expect(realAcct.action).toBe('created');
  });

  it('echoes billing_entity without bank details', async () => {
    const { result } = await simulateCallTool(server, 'sync_accounts', {
      accounts: [{
        brand: { domain: 'acme.com' },
        operator: 'agency-one',
        billing: 'operator',
        billing_entity: {
          name: 'Acme Inc.',
          address: '123 Main St',
          bank: { routing: '123456', account: '789' },
        },
        sandbox: true,
      }],
    });

    const acct = (result.accounts as Record<string, unknown>[])[0];
    const entity = acct.billing_entity as Record<string, unknown>;
    expect(entity.name).toBe('Acme Inc.');
    expect(entity.address).toBe('123 Main St');
    expect(entity.bank).toBeUndefined();
  });
});

// ── sync_governance ────────────────────────────────────────────────

describe('sync_governance', () => {
  let server: ReturnType<typeof createTrainingAgentServer>;

  beforeEach(() => {
    clearSessions();
    clearAccountStore();
    clearTaskStore();
    clearIdempotencyCache();
    invalidateCache();
    server = createTrainingAgentServer(DEFAULT_CTX);
  });

  async function createSandboxAccount(domain = 'acme.com', operator = 'agency-one') {
    const { result } = await simulateCallTool(server, 'sync_accounts', {
      accounts: [{
        brand: { domain },
        operator,
        billing: 'operator',
        sandbox: true,
      }],
    });
    return (result.accounts as Record<string, unknown>[])[0];
  }

  it('registers the governance agent on an existing account', async () => {
    await createSandboxAccount();

    const { result } = await simulateCallTool(server, 'sync_governance', {
      accounts: [{
        account: { brand: { domain: 'acme.com' }, operator: 'agency-one' },
        governance_agents: [{
          url: 'https://governance.example.com/mcp',
          authentication: { schemes: ['bearer'], credentials: 'tok_123' },
        }],
      }],
    });

    expect(result.accounts).toHaveLength(1);
    const govResult = (result.accounts as Record<string, unknown>[])[0];
    expect(govResult.status).toBe('synced');

    const agents = govResult.governance_agents as Array<{ url: string }>;
    expect(agents).toHaveLength(1);
    expect(agents[0].url).toBe('https://governance.example.com/mcp');
  });

  it('replaces the governance agent on second call', async () => {
    await createSandboxAccount();

    const ref = { brand: { domain: 'acme.com' }, operator: 'agency-one' };

    // First sync — one agent
    await simulateCallTool(server, 'sync_governance', {
      accounts: [{
        account: ref,
        governance_agents: [{
          url: 'https://gov-a.example.com/mcp',
          authentication: { schemes: ['bearer'], credentials: 'tok_a' },
        }],
      }],
    });

    // Second sync — different agent replaces the first
    const { result } = await simulateCallTool(server, 'sync_governance', {
      accounts: [{
        account: ref,
        governance_agents: [{
          url: 'https://gov-b.example.com/mcp',
          authentication: { schemes: ['bearer'], credentials: 'tok_b' },
        }],
      }],
    });

    const govResult = (result.accounts as Record<string, unknown>[])[0];
    expect(govResult.status).toBe('synced');
    const agents = govResult.governance_agents as Array<{ url: string }>;
    expect(agents).toHaveLength(1);
    expect(agents[0].url).toBe('https://gov-b.example.com/mcp');
  });

  it('rejects payloads carrying more than one governance agent at the request-shape layer (maxItems: 1)', async () => {
    await createSandboxAccount();

    const { result } = await simulateCallTool(server, 'sync_governance', {
      accounts: [{
        account: { brand: { domain: 'acme.com' }, operator: 'agency-one' },
        governance_agents: [
          {
            url: 'https://gov-a.example.com/mcp',
            authentication: { schemes: ['bearer'], credentials: 'tok_a' },
          },
          {
            url: 'https://gov-b.example.com/mcp',
            authentication: { schemes: ['bearer'], credentials: 'tok_b' },
          },
        ],
      }],
    });

    // Schema-shape violation → handler returns top-level errors[] envelope.
    // The framework wraps single-error envelopes as adcp_error{code,message}
    // (sync_governance is not in ERROR_IN_BODY_TOOLS), and simulateCallTool's
    // helper unwraps adcp_error to a flat {code,message} shape on `result`.
    // The MCP isError flag and structuredContent.adcp_error.code are what the
    // storyboard runner actually reads — the per-account success envelope is
    // never produced for this code path.
    expect(result.code).toBe('INVALID_REQUEST');
    expect(result.message as string).toContain('exactly 1 entry');
    expect(result.accounts).toBeUndefined();
  });

  it('returns ACCOUNT_NOT_FOUND when account does not exist', async () => {
    const { result } = await simulateCallTool(server, 'sync_governance', {
      accounts: [{
        account: { brand: { domain: 'nonexistent.com' }, operator: 'nobody' },
        governance_agents: [{
          url: 'https://gov.example.com/mcp',
          authentication: { schemes: ['bearer'], credentials: 'tok' },
        }],
      }],
    });

    const govResult = (result.accounts as Record<string, unknown>[])[0];
    expect(govResult.status).toBe('failed');
    const errors = govResult.errors as Array<{ code: string; message: string }>;
    expect(errors[0].code).toBe('ACCOUNT_NOT_FOUND');
    expect(errors[0].message).toContain('sync_accounts first');
  });

  it('finds account by account_id', async () => {
    const acct = await createSandboxAccount();
    const accountId = acct.account_id as string;

    const { result } = await simulateCallTool(server, 'sync_governance', {
      accounts: [{
        account: { account_id: accountId },
        governance_agents: [{
          url: 'https://gov.example.com/mcp',
          authentication: { schemes: ['bearer'], credentials: 'tok' },
        }],
      }],
    });

    const govResult = (result.accounts as Record<string, unknown>[])[0];
    expect(govResult.status).toBe('synced');
    const agents = govResult.governance_agents as Array<{ url: string }>;
    expect(agents).toHaveLength(1);
    expect(agents[0].url).toBe('https://gov.example.com/mcp');
  });
});
