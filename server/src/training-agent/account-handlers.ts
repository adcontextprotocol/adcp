/**
 * Account tool definitions and handlers for the training agent.
 *
 * Implements sync_accounts and sync_governance per the AdCP account schema.
 * Accounts are stored in session state; governance agents are stored per-account.
 */

import { randomUUID } from 'node:crypto';
import type { TrainingContext, ToolArgs, AccountRef } from './types.js';
import { sessionKeyFromArgs } from './state.js';
import { getAgentUrl } from './config.js';
import { encodeOffsetCursor, decodeOffsetCursor } from './pagination.js';

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

interface AccountWireShape {
  account_id: string;
  name: string;
  advertiser: string;
  // brand-ref.json defines this object; it carries domain + optional brand_id
  // only — `name` is not in the schema and additionalProperties is false.
  brand: { domain: string; brand_id?: string };
  operator: string;
  billing: string;
  account_scope: string;
  status: string;
  payment_terms?: string;
  rate_card?: string;
  credit_limit?: { amount: number; currency: string };
  sandbox?: true;
}

function accountStateToWire(account: AccountState): AccountWireShape {
  const advertiser = account.brand.name ?? account.brand.domain;
  const displayName = account.brand.domain === account.operator
    ? advertiser
    : `${advertiser} c/o ${account.operator}`;
  // brand-ref.json forbids `name` on the wire (additionalProperties: false),
  // so emit only the schema-declared fields. AccountState.brand.name is an
  // operational hint we use to derive `name`/`advertiser` above; it never
  // reaches the buyer.
  const wireBrand: { domain: string; brand_id?: string } = { domain: account.brand.domain };
  if (account.brand.brand_id !== undefined) wireBrand.brand_id = account.brand.brand_id;
  const wire: AccountWireShape = {
    account_id: account.accountId,
    name: displayName,
    advertiser,
    brand: wireBrand,
    operator: account.operator,
    billing: account.billing,
    account_scope: account.accountScope,
    status: account.status,
    payment_terms: account.paymentTerms,
  };
  if (account.rateCard) wire.rate_card = account.rateCard;
  if (account.creditLimit) wire.credit_limit = account.creditLimit;
  if (account.sandbox) wire.sandbox = true;
  return wire;
}

// Compliance fixture pool — used when the session has no synced accounts, so
// storyboards that rely on stable account IDs work without prior sync_accounts.
function getComplianceAccounts(): AccountWireShape[] {
  return [
    {
      account_id: 'acc_pagination_integrity_1',
      name: 'Acme c/o Pinnacle',
      advertiser: 'Acme Corp',
      brand: { domain: 'acme-corp.com' },
      operator: 'pinnacle-media.com',
      billing: 'operator',
      account_scope: 'operator_brand',
      status: 'active',
    },
    {
      account_id: 'acc_pagination_integrity_2',
      name: 'Nova c/o Pinnacle',
      advertiser: 'Nova Brands',
      brand: { domain: 'nova-brands.com' },
      operator: 'pinnacle-media.com',
      billing: 'operator',
      account_scope: 'operator_brand',
      status: 'active',
    },
    {
      account_id: 'acc_pagination_integrity_3',
      name: 'Pinnacle',
      advertiser: 'Pinnacle Media',
      brand: { domain: 'pinnacle-media.com' },
      operator: 'pinnacle-media.com',
      billing: 'operator',
      account_scope: 'brand',
      status: 'active',
    },
  ];
}

// ── Tool definitions ─────────────────────────────────────────────

export const ACCOUNT_REF_SCHEMA = {
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
    name: 'list_accounts',
    description: 'List accounts accessible to the authenticated agent. Supports status and sandbox filtering with cursor-based pagination.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    execution: { taskSupport: 'forbidden' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        status: {
          type: 'string',
          enum: ['active', 'pending_approval', 'rejected', 'payment_required', 'suspended', 'closed'],
          description: 'Filter accounts by status. Omit to return accounts in all statuses.',
        },
        sandbox: {
          type: 'boolean',
          description: 'Filter by sandbox status. Omit to return all accounts.',
        },
        pagination: {
          type: 'object',
          properties: {
            max_results: { type: 'integer', minimum: 1, maximum: 100, description: 'Max accounts per page (default 50, cap 100).' },
            cursor: { type: 'string', description: 'Continuation token from a previous list_accounts response.' },
          },
        },
      },
      required: [],
    },
  },
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
                minItems: 1,
                maxItems: 1,
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

interface ListAccountsRequest extends ToolArgs {
  status?: string;
  sandbox?: boolean;
  pagination?: { max_results?: number; cursor?: string };
}

export function handleListAccounts(args: ToolArgs, ctx: TrainingContext): object {
  const req = args as unknown as ListAccountsRequest;
  const sessionKey = sessionKeyFromArgs(req, ctx.mode, ctx.userId, ctx.moduleId);
  const accountMap = getAccountMap(sessionKey);

  let accounts: AccountWireShape[] = accountMap.size > 0
    ? Array.from(accountMap.values()).map(accountStateToWire)
    : getComplianceAccounts();

  if (req.status) {
    accounts = accounts.filter(a => a.status === req.status);
  }
  if (typeof req.sandbox === 'boolean') {
    accounts = req.sandbox
      ? accounts.filter(a => a.sandbox === true)
      : accounts.filter(a => !a.sandbox);
  }

  const totalMatching = accounts.length;
  const requestedMax = req.pagination?.max_results;
  const maxResults = Math.min(typeof requestedMax === 'number' ? requestedMax : 50, 100);
  const offset = decodeOffsetCursor('accounts', req.pagination?.cursor);
  if (offset === null) {
    return { errors: [{ code: 'INVALID_REQUEST', message: 'pagination.cursor is malformed' }] };
  }
  const pageEnd = Math.min(offset + maxResults, totalMatching);
  const pageAccounts = accounts.slice(offset, pageEnd);
  const hasMore = pageEnd < totalMatching;

  return {
    accounts: pageAccounts,
    pagination: {
      has_more: hasMore,
      total_count: totalMatching,
      ...(hasMore && { cursor: encodeOffsetCursor('accounts', pageEnd) }),
    },
  };
}

export function handleSyncGovernance(args: ToolArgs, ctx: TrainingContext) {
  const req = args as unknown as SyncGovernanceInput;

  if (!req.accounts || !Array.isArray(req.accounts) || req.accounts.length === 0) {
    return {
      errors: [{ code: 'INVALID_REQUEST', message: 'accounts array is required and must not be empty' }],
    };
  }

  // Schema-shape invariant: governance_agents has maxItems: 1 (#3015). A
  // multi-agent payload is a request-shape violation, not a per-account
  // business failure — return a top-level error envelope so the runner sees
  // success=false. Per-account errors[] are reserved for valid-shape but
  // business-fail cases (account-not-found, business-rule violations).
  const multiAgentAccounts = req.accounts.filter(
    a => Array.isArray(a.governance_agents) && a.governance_agents.length !== 1,
  );
  if (multiAgentAccounts.length > 0) {
    return {
      errors: [{
        code: 'INVALID_REQUEST',
        message: `governance_agents must contain exactly 1 entry per account; ${multiAgentAccounts.length} account(s) violated this constraint. An account binds to a single governance agent that owns the full lifecycle (purchase / modification / delivery phases). Specialist review composes inside the agent, not across multiple registrations.`,
      }],
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

    // Validate governance agent URL
    const agent = input.governance_agents[0];
    if (!agent.url) {
      results.push({
        account: acctRef,
        status: 'failed',
        errors: [{ code: 'INVALID_REQUEST', message: 'governance_agents[].url is required' }],
      });
      continue;
    }
    const validAgents: GovernanceAgentEntry[] = [{ url: agent.url }];

    // Replace semantics — overwrite previous governance agents
    acct.governanceAgents = validAgents;

    results.push({
      account: acctRef,
      status: 'synced',
      governance_agents: validAgents.map(a => ({ url: a.url })),
    });
  }

  return { accounts: results };
}
