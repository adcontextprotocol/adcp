/**
 * Account tool definitions and handlers for the training agent.
 *
 * Implements sync_accounts and sync_governance per the AdCP account schema.
 * Accounts are stored in session state; governance agents are stored per-account.
 */

import { randomUUID } from 'node:crypto';
import type { TrainingContext, ToolArgs, AccountRef } from './types.js';
import { getSession, sessionKeyFromArgs } from './state.js';
import { getAgentUrl } from './config.js';

// ── Types ────────────────────────────────────────────────────────

interface SyncAccountsInput extends ToolArgs {
  accounts: SyncAccountInput[];
  dry_run?: boolean;
}

interface SyncAccountInput {
  brand: { domain: string; brand_id?: string; name?: string };
  operator: string;
  billing: 'operator' | 'agent' | 'advertiser';
  billing_entity?: Record<string, unknown>;
  payment_terms?: string;
  sandbox?: boolean;
}

interface AccountState {
  accountId: string;
  brand: { domain: string; brand_id?: string; name?: string };
  operator: string;
  billing: string;
  billingEntity?: Record<string, unknown>;
  paymentTerms: string;
  status: string;
  accountScope: string;
  sandbox: boolean;
  rateCard?: string;
  creditLimit?: { amount: number; currency: string };
  governanceAgents: GovernanceAgentEntry[];
  syncedAt: string;
}

interface GovernanceAgentEntry {
  url: string;
  categories?: string[];
}

interface SyncGovernanceInput extends ToolArgs {
  accounts: SyncGovernanceAccountInput[];
}

interface SyncGovernanceAccountInput {
  account: AccountRef;
  governance_agents: GovernanceAgentInput[];
}

interface GovernanceAgentInput {
  url: string;
  authentication: { schemes: string[]; credentials: string };
  categories?: string[];
}

// ── Session state extension ──────────────────────────────────────

// Account state is stored alongside the existing session state using a
// module-level Map keyed by session key → account key → AccountState.
// This avoids modifying the shared SessionState interface.
const accountStore = new Map<string, Map<string, AccountState>>();

function getAccountMap(sessionKey: string): Map<string, AccountState> {
  let map = accountStore.get(sessionKey);
  if (!map) {
    map = new Map();
    accountStore.set(sessionKey, map);
  }
  return map;
}

function accountKey(brand: { domain: string; brand_id?: string }, operator: string): string {
  const brandPart = brand.brand_id ? `${brand.domain}:${brand.brand_id}` : brand.domain;
  return `${brandPart}::${operator}`;
}

function findAccountByRef(accounts: Map<string, AccountState>, ref: AccountRef): AccountState | undefined {
  if (ref.account_id) {
    for (const [, acct] of accounts) {
      if (acct.accountId === ref.account_id) return acct;
    }
    return undefined;
  }
  if (ref.brand?.domain && ref.operator) {
    return accounts.get(accountKey(ref.brand, ref.operator));
  }
  return undefined;
}

/** Exported for testing — clear all account state */
export function clearAccountStore(): void {
  accountStore.clear();
}

// ── Tool definitions ─────────────────────────────────────────────

const ACCOUNT_REF_SCHEMA = {
  type: 'object',
  oneOf: [
    { properties: { account_id: { type: 'string' } }, required: ['account_id'] },
    {
      properties: {
        brand: { type: 'object', properties: { domain: { type: 'string' } }, required: ['domain'] },
        operator: { type: 'string' },
        sandbox: { type: 'boolean' },
      },
      required: ['brand'],
    },
  ],
};

export const ACCOUNT_TOOLS = [
  {
    name: 'sync_accounts',
    description: 'Sync advertiser accounts with this seller. Declare which brands and operators you represent, and receive account IDs and status. Sandbox accounts are provisioned instantly; non-sandbox accounts may require human approval.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        accounts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              brand: {
                type: 'object',
                properties: {
                  domain: { type: 'string' },
                  brand_id: { type: 'string' },
                  name: { type: 'string' },
                },
                required: ['domain'],
              },
              operator: { type: 'string' },
              billing: { type: 'string', enum: ['operator', 'agent', 'advertiser'] },
              billing_entity: { type: 'object' },
              payment_terms: { type: 'string', enum: ['net_15', 'net_30', 'net_45', 'net_60', 'net_90', 'prepay'] },
              sandbox: { type: 'boolean' },
            },
            required: ['brand', 'operator', 'billing'],
          },
        },
        dry_run: { type: 'boolean' },
      },
      required: ['accounts'],
    },
  },
  {
    name: 'sync_governance',
    description: 'Register governance agent endpoints on accounts. The seller calls these agents via check_governance during media buy lifecycle events. Uses replace semantics: each call replaces previously synced agents on the specified accounts.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    execution: { taskSupport: 'forbidden' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        accounts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              account: ACCOUNT_REF_SCHEMA,
              governance_agents: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    url: { type: 'string', format: 'uri' },
                    authentication: {
                      type: 'object',
                      properties: {
                        schemes: { type: 'array', items: { type: 'string' } },
                        credentials: { type: 'string' },
                      },
                      required: ['schemes', 'credentials'],
                    },
                    categories: { type: 'array', items: { type: 'string' } },
                  },
                  required: ['url', 'authentication'],
                },
              },
            },
            required: ['account', 'governance_agents'],
          },
        },
      },
      required: ['accounts'],
    },
  },
];

// ── Handler implementations ─────────────────────────────────────

const SUPPORTED_PAYMENT_TERMS = ['net_15', 'net_30', 'net_45', 'net_60', 'net_90', 'prepay'];

export function handleSyncAccounts(args: ToolArgs, ctx: TrainingContext) {
  const req = args as unknown as SyncAccountsInput;

  if (!req.accounts || !Array.isArray(req.accounts) || req.accounts.length === 0) {
    return {
      errors: [{ code: 'INVALID_REQUEST', message: 'accounts array is required and must not be empty' }],
    };
  }

  const sessionKey = sessionKeyFromArgs(req, ctx.mode, ctx.userId, ctx.moduleId);
  const accounts = getAccountMap(sessionKey);
  const agentUrl = getAgentUrl();
  const now = new Date().toISOString();
  const results: Record<string, unknown>[] = [];

  for (const input of req.accounts) {
    if (!input.brand?.domain) {
      results.push({
        brand: input.brand,
        operator: input.operator,
        action: 'failed',
        status: 'rejected',
        errors: [{ code: 'INVALID_REQUEST', message: 'brand.domain is required' }],
      });
      continue;
    }

    if (!input.operator) {
      results.push({
        brand: input.brand,
        operator: input.operator,
        action: 'failed',
        status: 'rejected',
        errors: [{ code: 'INVALID_REQUEST', message: 'operator is required' }],
      });
      continue;
    }

    // Validate payment terms
    if (input.payment_terms && !SUPPORTED_PAYMENT_TERMS.includes(input.payment_terms)) {
      results.push({
        brand: input.brand,
        operator: input.operator,
        action: 'failed',
        status: 'rejected',
        errors: [{
          code: 'PAYMENT_TERMS_NOT_SUPPORTED',
          message: `Payment terms '${input.payment_terms}' are not available. Supported: ${SUPPORTED_PAYMENT_TERMS.join(', ')}.`,
        }],
      });
      continue;
    }

    const key = accountKey(input.brand, input.operator);
    const existing = accounts.get(key);
    const isSandbox = input.sandbox === true;

    if (req.dry_run) {
      results.push({
        brand: input.brand,
        operator: input.operator,
        action: existing ? 'updated' : 'created',
        status: isSandbox ? 'active' : 'pending_approval',
        billing: input.billing,
        account_scope: 'operator_brand',
        sandbox: isSandbox || undefined,
      });
      continue;
    }

    const accountId = existing?.accountId || `acc_${input.brand.domain.replace(/\./g, '_')}_${randomUUID().slice(0, 8)}`;
    const action = existing ? 'updated' : 'created';

    // Sandbox accounts are active immediately; non-sandbox may need approval
    const status = isSandbox ? 'active' : (existing?.status === 'active' ? 'active' : 'pending_approval');

    const state: AccountState = {
      accountId,
      brand: input.brand,
      operator: input.operator,
      billing: input.billing,
      billingEntity: input.billing_entity,
      paymentTerms: input.payment_terms || 'net_30',
      status,
      accountScope: 'operator_brand',
      sandbox: isSandbox,
      rateCard: isSandbox ? 'sandbox' : 'standard',
      creditLimit: isSandbox ? undefined : { amount: 100000, currency: 'USD' },
      governanceAgents: existing?.governanceAgents || [],
      syncedAt: now,
    };

    accounts.set(key, state);

    const result: Record<string, unknown> = {
      account_id: accountId,
      brand: input.brand,
      operator: input.operator,
      name: `${input.brand.name || input.brand.domain} (via ${input.operator})`,
      action,
      status,
      billing: input.billing,
      account_scope: 'operator_brand',
      payment_terms: state.paymentTerms,
      rate_card: state.rateCard,
    };

    if (input.billing_entity) {
      // Echo billing entity without bank details (write-only)
      const { bank, ...safe } = input.billing_entity as Record<string, unknown>;
      result.billing_entity = safe;
    }

    if (state.creditLimit) {
      result.credit_limit = state.creditLimit;
    }

    if (isSandbox) {
      result.sandbox = true;
    }

    if (status === 'pending_approval') {
      result.setup = {
        url: `${agentUrl.replace('/mcp', '')}/account-setup/${accountId}`,
        message: 'Complete advertiser registration and credit application. A sales representative will review your account within 1 business day.',
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      };
    }

    results.push(result);
  }

  return {
    ...(req.dry_run && { dry_run: true }),
    accounts: results,
  };
}

export function handleSyncGovernance(args: ToolArgs, ctx: TrainingContext) {
  const req = args as unknown as SyncGovernanceInput;

  if (!req.accounts || !Array.isArray(req.accounts) || req.accounts.length === 0) {
    return {
      errors: [{ code: 'INVALID_REQUEST', message: 'accounts array is required and must not be empty' }],
    };
  }

  const sessionKey = sessionKeyFromArgs(req, ctx.mode, ctx.userId, ctx.moduleId);
  const accounts = getAccountMap(sessionKey);
  const results: Record<string, unknown>[] = [];

  for (const input of req.accounts) {
    const acctRef = input.account;
    const acct = findAccountByRef(accounts, acctRef);

    if (!acct) {
      // Account not found — return a useful error
      const refDesc = acctRef.account_id
        ? `account_id '${acctRef.account_id}'`
        : `brand '${acctRef.brand?.domain}' / operator '${acctRef.operator}'`;
      results.push({
        account: acctRef,
        status: 'failed',
        errors: [{
          code: 'ACCOUNT_NOT_FOUND',
          message: `Account ${refDesc} does not exist. Call sync_accounts first to establish the account relationship.`,
        }],
      });
      continue;
    }

    // Validate governance agent URLs
    const validAgents: GovernanceAgentEntry[] = [];
    let hasFailed = false;
    for (const agent of input.governance_agents) {
      if (!agent.url) {
        results.push({
          account: acctRef,
          status: 'failed',
          errors: [{ code: 'INVALID_REQUEST', message: 'governance_agents[].url is required' }],
        });
        hasFailed = true;
        break;
      }
      validAgents.push({
        url: agent.url,
        categories: agent.categories,
      });
    }

    if (hasFailed) continue;

    // Replace semantics — overwrite previous governance agents
    acct.governanceAgents = validAgents;

    results.push({
      account: acctRef,
      status: 'synced',
      governance_agents: validAgents.map(a => ({
        url: a.url,
        ...(a.categories && { categories: a.categories }),
      })),
    });
  }

  return { accounts: results };
}
