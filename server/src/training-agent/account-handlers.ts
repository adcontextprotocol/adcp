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
import { getCommercialRelationship } from './commercial-relationships.js';
import { isPerAccountBillingRestricted } from './account-billing-relationships.js';
import { assertPublicTarget, SsrfRefusedError } from './webhook-fetch.js';

// ── Types ────────────────────────────────────────────────────────

interface SyncAccountsInput extends ToolArgs {
  accounts: SyncAccountInput[];
  dry_run?: boolean;
}

interface SyncAccountInput {
  account?: AccountRef;
  brand?: { domain: string; brand_id?: string; name?: string };
  operator?: string;
  billing?: 'operator' | 'agent' | 'advertiser';
  billing_entity?: Record<string, unknown>;
  payment_terms?: string;
  sandbox?: boolean;
  notification_configs?: NotificationConfigInput[];
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
  notificationConfigs: NotificationConfigState[];
  notificationConfigsTouched?: boolean;
  syncedAt: string;
}

export interface GovernanceAgentEntry {
  url: string;
}

interface NotificationConfigInput {
  subscriber_id?: string;
  url?: string;
  event_types?: string[];
  authentication?: {
    schemes?: string[];
    credentials?: string;
  };
  active?: boolean;
  ext?: unknown;
}

export interface NotificationConfigState {
  subscriberId: string;
  url: string;
  eventTypes: string[];
  authentication?: {
    schemes: string[];
    credentials?: string;
  };
  active: boolean;
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

function principalScope(principal: string | undefined): string {
  return principal && principal.length > 0 ? principal : 'anonymous';
}

function scopedStoreKey(sessionKey: string, principal: string | undefined): string {
  return `${principalScope(principal)}\u001F${sessionKey}`;
}

function getAccountMap(sessionKey: string, principal?: string): Map<string, AccountState> {
  const key = scopedStoreKey(sessionKey, principal);
  let map = accountStore.get(key);
  if (!map) {
    map = new Map();
    accountStore.set(key, map);
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

function findAccountByIdAcrossSessions(accountId: string, principal?: string): AccountState | undefined {
  const prefix = `${principalScope(principal)}\u001F`;
  for (const [key, accounts] of accountStore) {
    if (!key.startsWith(prefix)) continue;
    for (const acct of accounts.values()) {
      if (acct.accountId === accountId) return acct;
    }
  }
  return undefined;
}

function accountsForPrincipal(principal?: string): AccountState[] {
  const prefix = `${principalScope(principal)}\u001F`;
  const accounts: AccountState[] = [];
  for (const [key, scopedAccounts] of accountStore) {
    if (!key.startsWith(prefix)) continue;
    accounts.push(...scopedAccounts.values());
  }
  return accounts;
}

function accountMapsForPrincipal(sessionKey: string, principal?: string): Map<string, AccountState>[] {
  const scopedKey = scopedStoreKey(sessionKey, principal);
  const maps: Map<string, AccountState>[] = [];
  const primary = accountStore.get(scopedKey);
  if (primary) maps.push(primary);

  const prefix = `${principalScope(principal)}\u001F`;
  for (const [key, scopedAccounts] of accountStore) {
    if (key === scopedKey || !key.startsWith(prefix)) continue;
    maps.push(scopedAccounts);
  }
  return maps;
}

function accountStateFromWire(wire: AccountWireShape, now: string): AccountState {
  return {
    accountId: wire.account_id,
    brand: wire.brand,
    operator: wire.operator,
    billing: wire.billing,
    paymentTerms: wire.payment_terms ?? 'net_30',
    status: wire.status,
    accountScope: wire.account_scope,
    sandbox: wire.sandbox === true,
    rateCard: wire.rate_card,
    creditLimit: wire.credit_limit,
    governanceAgents: [],
    notificationConfigs: [],
    notificationConfigsTouched: false,
    syncedAt: now,
  };
}

function findComplianceAccountById(accountId: string, now: string): AccountState | undefined {
  const fixture = getComplianceAccounts().find(account => account.account_id === accountId);
  return fixture ? accountStateFromWire(fixture, now) : undefined;
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
  notification_configs?: Array<Record<string, unknown>>;
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
  if (account.notificationConfigs.length > 0 || account.notificationConfigsTouched) {
    wire.notification_configs = sanitizeNotificationConfigs(account.notificationConfigs);
  }
  return wire;
}

export const ACCOUNT_ANCHORED_NOTIFICATION_TYPE_VALUES = [
  'creative.status_changed',
  'creative.purged',
  'product.created',
  'product.updated',
  'product.priced',
  'product.removed',
  'signal.created',
  'signal.updated',
  'signal.priced',
  'signal.removed',
  'wholesale_feed.bulk_change',
] as const;

export type AccountAnchoredNotificationType = typeof ACCOUNT_ANCHORED_NOTIFICATION_TYPE_VALUES[number];

const ACCOUNT_ANCHORED_NOTIFICATION_TYPES = new Set<string>(ACCOUNT_ANCHORED_NOTIFICATION_TYPE_VALUES);

function sanitizeNotificationConfigs(configs: NotificationConfigState[]): Array<Record<string, unknown>> {
  return configs.map(config => ({
    subscriber_id: config.subscriberId,
    url: config.url,
    event_types: [...config.eventTypes],
    ...(config.authentication?.schemes?.length
      ? { authentication: { schemes: [...config.authentication.schemes] } }
      : {}),
    active: config.active,
  }));
}

function validationFailure(input: SyncAccountInput, field: string, message: string): Record<string, unknown> {
  return {
    ...(input.account ? { account: input.account } : { brand: input.brand, operator: input.operator }),
    action: 'failed',
    status: 'rejected',
    errors: [{ code: 'VALIDATION_ERROR', field, message }],
  };
}

function durableAccountIdentityError(ctx: TrainingContext): { errors: Array<{ code: string; message: string; recovery: string }> } | null {
  if (ctx.mode === 'open' && ctx.principal === 'static:public:shared') {
    return {
      errors: [{
        code: 'AUTH_REQUIRED',
        message: 'Durable account tools require a caller-unique credential; the published public test token is shared.',
        recovery: 'correctable',
      }],
    };
  }
  return null;
}

async function normalizeNotificationConfigs(input: SyncAccountInput): Promise<NotificationConfigState[] | { error: Record<string, unknown> } | undefined> {
  if (input.notification_configs === undefined) return undefined;
  if (!Array.isArray(input.notification_configs)) {
    return { error: validationFailure(input, 'notification_configs', 'notification_configs must be an array') };
  }
  if (input.notification_configs.length > 16) {
    return { error: validationFailure(input, 'notification_configs', 'notification_configs must contain at most 16 entries') };
  }

  const seen = new Set<string>();
  const out: NotificationConfigState[] = [];
  for (let i = 0; i < input.notification_configs.length; i++) {
    const config = input.notification_configs[i];
    const field = `notification_configs[${i}]`;
    if (!config || typeof config !== 'object') {
      return { error: validationFailure(input, field, 'notification config must be an object') };
    }
    if (!config.subscriber_id) {
      return { error: validationFailure(input, `${field}.subscriber_id`, 'subscriber_id is required') };
    }
    if (seen.has(config.subscriber_id)) {
      return { error: validationFailure(input, `${field}.subscriber_id`, 'subscriber_id must be unique within an account') };
    }
    seen.add(config.subscriber_id);
    if (config.active !== false) {
      return {
        error: validationFailure(
          input,
          `${field}.active`,
          'active must be false until the training sandbox implements a signed proof-of-control challenge for the webhook target',
        ),
      };
    }
    if (!config.url) {
      return { error: validationFailure(input, `${field}.url`, 'url is required') };
    }
    let parsed: URL;
    try {
      parsed = new URL(config.url);
    } catch {
      return { error: validationFailure(input, `${field}.url`, 'url must be a valid URL') };
    }
    const isLocalWebhook = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && isLocalWebhook)) {
      return { error: validationFailure(input, `${field}.url`, 'url must use HTTPS') };
    }
    if (parsed.username || parsed.password) {
      return { error: validationFailure(input, `${field}.url`, 'url must not include userinfo credentials') };
    }
    const isDocumentationHost = parsed.hostname === 'example.com' || parsed.hostname.endsWith('.example.com');
    if (parsed.protocol === 'https:' && !isDocumentationHost) {
      try {
        await assertPublicTarget(parsed);
      } catch (err) {
        const reason = err instanceof SsrfRefusedError ? err.reason : 'localhost or private network target';
        return { error: validationFailure(input, `${field}.url`, `url rejected by SSRF guard: ${reason}`) };
      }
    }
    if (!Array.isArray(config.event_types) || config.event_types.length === 0) {
      return { error: validationFailure(input, `${field}.event_types`, 'event_types must contain at least one notification type') };
    }
    const seenEventTypes = new Set<string>();
    for (let j = 0; j < config.event_types.length; j += 1) {
      const eventType = config.event_types[j];
      if (seenEventTypes.has(eventType)) {
        return { error: validationFailure(input, `${field}.event_types[${j}]`, 'event_types must be unique within a subscriber') };
      }
      seenEventTypes.add(eventType);
    }
    const invalidIndex = config.event_types.findIndex(t => !ACCOUNT_ANCHORED_NOTIFICATION_TYPES.has(t));
    if (invalidIndex !== -1) {
      return {
        error: validationFailure(
          input,
          `${field}.event_types[${invalidIndex}]`,
          `${config.event_types[invalidIndex]} is not valid on account-level notification_configs[]`,
        ),
      };
    }
    if (config.authentication?.schemes?.length && !config.authentication.credentials) {
      return { error: validationFailure(input, `${field}.authentication.credentials`, 'authentication.credentials is required when authentication.schemes is present') };
    }
    if (config.authentication?.schemes?.length) {
      const supportedSchemes = ['Bearer', 'HMAC-SHA256'];
      if (config.authentication.schemes.length !== 1 || !supportedSchemes.includes(config.authentication.schemes[0])) {
        return { error: validationFailure(input, `${field}.authentication.schemes`, 'authentication.schemes must contain exactly one supported legacy scheme') };
      }
      if (typeof config.authentication.credentials !== 'string' || config.authentication.credentials.length < 32) {
        return { error: validationFailure(input, `${field}.authentication.credentials`, 'authentication.credentials must be at least 32 characters') };
      }
    }

    out.push({
      subscriberId: config.subscriber_id,
      url: config.url,
      eventTypes: [...config.event_types],
      authentication: config.authentication?.schemes?.length
        ? {
            schemes: [...config.authentication.schemes],
            credentials: config.authentication.credentials,
          }
        : undefined,
      active: false,
    });
  }
  return out;
}

export interface AccountNotificationSubscriber {
  accountId: string;
  subscriberId: string;
  url: string;
  eventTypes: string[];
  authentication?: NotificationConfigState['authentication'];
}

export function getAccountNotificationSubscribers(
  sessionKey: string,
  notificationType: AccountAnchoredNotificationType,
  principal?: string,
  accountId?: string,
  accountRef?: AccountRef,
): AccountNotificationSubscriber[] {
  const accountMaps = accountMapsForPrincipal(sessionKey, principal);
  if (accountMaps.length === 0) return [];
  const canUseNaturalKey = Boolean(accountRef?.brand?.domain && accountRef.operator);
  const totalAccounts = accountMaps.reduce((count, accounts) => count + accounts.size, 0);
  if (!accountId && !canUseNaturalKey && totalAccounts !== 1) return [];
  const out: AccountNotificationSubscriber[] = [];
  const seen = new Set<string>();
  for (const accounts of accountMaps) {
    for (const account of accounts.values()) {
      if (accountId && account.accountId !== accountId) continue;
      if (!accountId && canUseNaturalKey && accountKey(accountRef!.brand!, accountRef!.operator!) !== accountKey(account.brand, account.operator)) continue;
      for (const config of account.notificationConfigs) {
        if (!config.active || !config.eventTypes.includes(notificationType)) continue;
        const subscriberKey = `${account.accountId}\u001F${config.subscriberId}\u001F${notificationType}`;
        if (seen.has(subscriberKey)) continue;
        seen.add(subscriberKey);
        out.push({
          accountId: account.accountId,
          subscriberId: config.subscriberId,
          url: config.url,
          eventTypes: [...config.eventTypes],
          authentication: config.authentication,
        });
      }
    }
  }
  return out;
}

export function resolveAccountIdForRef(
  sessionKey: string,
  principal: string | undefined,
  ref: AccountRef | undefined,
): string | undefined {
  if (!ref) return undefined;
  const account = findAccountByRef(getAccountMap(sessionKey, principal), ref)
    ?? (ref.account_id ? findAccountByIdAcrossSessions(ref.account_id, principal) : undefined);
  return account?.accountId;
}

export function resolveGovernanceAgentsForAccount(
  sessionKey: string,
  principal: string | undefined,
  ref: AccountRef | undefined,
): GovernanceAgentEntry[] {
  if (!ref) return [];
  for (const accounts of accountMapsForPrincipal(sessionKey, principal)) {
    const account = findAccountByRef(accounts, ref);
    if (account) return [...account.governanceAgents];
  }
  if (ref.account_id) {
    const account = findAccountByIdAcrossSessions(ref.account_id, principal);
    if (account) return [...account.governanceAgents];
  }
  return [];
}

export function seedAccountFixture(
  args: ToolArgs,
  ctx: TrainingContext,
): { success: boolean; message?: string; error?: string; error_detail?: string } {
  const identityError = durableAccountIdentityError(ctx);
  if (identityError) {
    return {
      success: false,
      error: identityError.errors[0]?.code ?? 'AUTH_REQUIRED',
      error_detail: identityError.errors[0]?.message ?? 'Durable account tools require caller identity',
    };
  }

  const params = ((args as Record<string, unknown>).params ?? {}) as Record<string, unknown>;
  const accountId = params.account_id;
  if (typeof accountId !== 'string' || accountId.length === 0) {
    return { success: false, error: 'INVALID_PARAMS', error_detail: 'params.account_id is required for seed_account' };
  }

  const fixture = (params.fixture ?? {}) as Record<string, unknown>;
  const brand = fixture.brand as { domain?: string; brand_id?: string; name?: string } | undefined;
  const operator = fixture.operator;
  if (!brand?.domain) {
    return { success: false, error: 'INVALID_PARAMS', error_detail: 'params.fixture.brand.domain is required for seed_account' };
  }
  if (typeof operator !== 'string' || operator.length === 0) {
    return { success: false, error: 'INVALID_PARAMS', error_detail: 'params.fixture.operator is required for seed_account' };
  }

  const billing = typeof fixture.billing === 'string' ? fixture.billing : 'operator';
  const status = typeof fixture.status === 'string' ? fixture.status : 'active';
  const now = new Date().toISOString();
  const sessionKey = sessionKeyFromArgs({}, ctx.mode, ctx.userId, ctx.moduleId);
  const accounts = getAccountMap(sessionKey, ctx.principal);
  const key = accountKey(brand as { domain: string; brand_id?: string }, operator);
  const existing = accounts.get(key)
    ?? findAccountByIdAcrossSessions(accountId, ctx.principal);

  const state: AccountState = {
    accountId,
    brand: brand as { domain: string; brand_id?: string; name?: string },
    operator,
    billing,
    paymentTerms: typeof fixture.payment_terms === 'string' ? fixture.payment_terms : 'net_30',
    status,
    accountScope: typeof fixture.account_scope === 'string' ? fixture.account_scope : 'operator_brand',
    sandbox: fixture.sandbox !== false,
    rateCard: typeof fixture.rate_card === 'string' ? fixture.rate_card : 'sandbox',
    creditLimit: undefined,
    governanceAgents: [],
    notificationConfigs: [],
    notificationConfigsTouched: false,
    syncedAt: now,
  };

  if (existing) {
    const existingComparable = JSON.stringify(accountStateToWire(existing));
    const nextComparable = JSON.stringify(accountStateToWire(state));
    if (existingComparable !== nextComparable) {
      return {
        success: false,
        error: 'INVALID_STATE',
        error_detail: `account_id "${accountId}" was already seeded with a different fixture - seed_account is idempotent`,
      };
    }
    return { success: true, message: `account_id "${accountId}" already seeded with the same fixture` };
  }

  accounts.set(key, state);
  return { success: true, message: `Account "${accountId}" seeded` };
}

// Compliance fixture pool — used when the session has no synced accounts, so
// storyboards that rely on stable account IDs work without prior sync_accounts.
function getComplianceAccounts(): AccountWireShape[] {
  return [
    {
      account_id: 'acc_pagination_integrity_1',
      name: 'Acme Outdoor c/o Pinnacle',
      advertiser: 'Acme Outdoor',
      brand: { domain: 'acmeoutdoor.example', brand_id: 'acme_outdoor' },
      operator: 'pinnacle-agency.example',
      billing: 'operator',
      account_scope: 'operator_brand',
      status: 'active',
      sandbox: true,
    },
    {
      account_id: 'acc_pagination_integrity_2',
      name: 'Acme Outdoor Trail c/o Trailhead',
      advertiser: 'Acme Outdoor',
      brand: { domain: 'acmeoutdoor.example', brand_id: 'acme_outdoor' },
      operator: 'trailhead-agency.example',
      billing: 'operator',
      account_scope: 'operator_brand',
      status: 'active',
      sandbox: true,
    },
    {
      account_id: 'acc_pagination_integrity_3',
      name: 'Acme Outdoor Direct',
      advertiser: 'Acme Outdoor',
      brand: { domain: 'acmeoutdoor.example', brand_id: 'acme_outdoor' },
      operator: 'acmeoutdoor.example',
      billing: 'operator',
      account_scope: 'brand',
      status: 'active',
      sandbox: true,
    },
  ];
}

// ── Tool definitions ─────────────────────────────────────────────

export const ACCOUNT_REF_SCHEMA = {
  type: 'object',
  oneOf: [
    {
      properties: { account_id: { type: 'string' } },
      required: ['account_id'],
      additionalProperties: false,
    },
    {
      properties: {
        brand: {
          type: 'object',
          properties: {
            domain: { type: 'string' },
            brand_id: { type: 'string' },
          },
          required: ['domain'],
          additionalProperties: false,
        },
        operator: { type: 'string' },
        sandbox: { type: 'boolean' },
      },
      required: ['brand', 'operator'],
      additionalProperties: false,
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
        account: {
          ...ACCOUNT_REF_SCHEMA,
          description: 'Optional exact account filter. Use account_id or a brand/operator natural key to return one matching account visible to the caller.',
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
              account: ACCOUNT_REF_SCHEMA,
              operator: { type: 'string' },
              billing: { type: 'string', enum: ['operator', 'agent', 'advertiser'] },
              billing_entity: { type: 'object' },
              payment_terms: { type: 'string', enum: ['net_15', 'net_30', 'net_45', 'net_60', 'net_90', 'prepay'] },
              sandbox: { type: 'boolean' },
              notification_configs: {
                type: 'array',
                maxItems: 16,
                items: {
                  type: 'object',
                  properties: {
                    subscriber_id: { type: 'string' },
                    url: { type: 'string', format: 'uri' },
                    event_types: { type: 'array', items: { type: 'string' } },
                    authentication: {
                      type: 'object',
                      properties: {
                        schemes: { type: 'array', items: { type: 'string' } },
                        credentials: { type: 'string' },
                      },
                      required: ['schemes', 'credentials'],
                    },
                    active: {
                      type: 'boolean',
                      enum: [false],
                      description: 'Must be false in the training sandbox until a signed proof-of-control challenge can activate the webhook target.',
                    },
                  },
                  required: ['subscriber_id', 'url', 'event_types', 'active'],
                },
              },
            },
            oneOf: [
              { required: ['brand', 'operator', 'billing'], not: { required: ['account'] } },
              {
                required: ['account'],
                allOf: [
                  { not: { required: ['brand'] } },
                  { not: { required: ['operator'] } },
                  { not: { required: ['billing'] } },
                ],
              },
            ],
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

// Seller-wide capability for the legacy /mcp route. Consumed both here
// (for the BILLING_NOT_SUPPORTED capability gate) and by
// task-handlers.ts (for the `supported_billing` advertisement on
// get_adcp_capabilities) — exported so the two surfaces are
// mechanically locked rather than comment-coupled. Submitting a value
// not in this list rejects with BILLING_NOT_SUPPORTED +
// error.details.scope: "capability". Per-tenant v6 routes carry their
// own supportedBillings declaration (see v6-*-platform.ts); the gate
// plumbing for those lands when accounts.upsert is wired on those
// platforms.
export const SUPPORTED_BILLINGS = ['agent', 'operator', 'advertiser'] as const;
type SupportedBilling = typeof SUPPORTED_BILLINGS[number];

export async function handleSyncAccounts(args: ToolArgs, ctx: TrainingContext) {
  const req = args as unknown as SyncAccountsInput;
  const identityError = durableAccountIdentityError(ctx);
  if (identityError) return identityError;

  if (!req.accounts || !Array.isArray(req.accounts) || req.accounts.length === 0) {
    return {
      errors: [{ code: 'INVALID_REQUEST', message: 'accounts array is required and must not be empty' }],
    };
  }

  const sessionKey = sessionKeyFromArgs(req, ctx.mode, ctx.userId, ctx.moduleId);
  const accounts = getAccountMap(sessionKey, ctx.principal);
  const agentUrl = getAgentUrl();
  const now = new Date().toISOString();
  const results: Record<string, unknown>[] = [];

  for (const input of req.accounts) {
    if (input.account) {
      const mixedProvisioningFields = [
        input.brand !== undefined && 'brand',
        input.operator !== undefined && 'operator',
        input.billing !== undefined && 'billing',
        input.sandbox !== undefined && 'sandbox',
      ].filter(Boolean);
      if (mixedProvisioningFields.length > 0) {
        results.push({
          account: input.account,
          action: 'failed',
          status: 'rejected',
          errors: [{
            code: 'INVALID_REQUEST',
            message: `Settings-update mode must not include provisioning fields: ${mixedProvisioningFields.join(', ')}`,
            field: String(mixedProvisioningFields[0]),
            recovery: 'correctable',
          }],
        });
        continue;
      }
      const existing = findAccountByRef(accounts, input.account)
        ?? (input.account.account_id ? findAccountByIdAcrossSessions(input.account.account_id, ctx.principal) : undefined)
        ?? (input.account.account_id ? findComplianceAccountById(input.account.account_id, now) : undefined);
      if (!existing) {
        results.push({
          account: input.account,
          action: 'failed',
          status: 'rejected',
          errors: [{
            code: 'ACCOUNT_NOT_FOUND',
            message: 'Account not found. Settings-update mode can only update accounts previously provisioned or discovered by this caller.',
          }],
        });
        continue;
      }
      if (!req.dry_run && !findAccountByRef(accounts, input.account)) {
        accounts.set(accountKey(existing.brand, existing.operator), existing);
      }

      if (input.payment_terms && !SUPPORTED_PAYMENT_TERMS.includes(input.payment_terms)) {
        results.push({
          account: input.account,
          action: 'failed',
          status: 'rejected',
          errors: [{
            code: 'PAYMENT_TERMS_NOT_SUPPORTED',
            message: `Payment terms '${input.payment_terms}' are not available. Supported: ${SUPPORTED_PAYMENT_TERMS.join(', ')}.`,
          }],
        });
        continue;
      }

      const notificationConfigs = await normalizeNotificationConfigs(input);
      if (notificationConfigs && 'error' in notificationConfigs) {
        results.push(notificationConfigs.error);
        continue;
      }
      const notificationConfigsProvided = Array.isArray(notificationConfigs);
      const nextNotificationConfigs = notificationConfigsProvided
        ? notificationConfigs
        : existing.notificationConfigs;

      const result: Record<string, unknown> = {
        account_id: existing.accountId,
        account: input.account,
        brand: existing.brand,
        operator: existing.operator,
        action: 'updated',
        status: existing.status,
        billing: existing.billing,
        account_scope: existing.accountScope,
        payment_terms: input.payment_terms ?? existing.paymentTerms,
        notification_configs: sanitizeNotificationConfigs(nextNotificationConfigs),
      };
      if (req.dry_run) {
        results.push(result);
        continue;
      }

      if (input.payment_terms) existing.paymentTerms = input.payment_terms;
      if (input.billing_entity) existing.billingEntity = input.billing_entity;
      if (notificationConfigsProvided) {
        existing.notificationConfigs = notificationConfigs;
        existing.notificationConfigsTouched = true;
      }
      existing.syncedAt = now;
      results.push(result);
      continue;
    }

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

    // Capability gate (BILLING_NOT_SUPPORTED, scope: "capability"). The
    // schema enum on `billing` already rejects anything outside operator/
    // agent/advertiser at validation time; this gate fires when the value
    // is structurally valid but not in the seller's advertised
    // `supported_billing` capability list. See
    // error-details/billing-not-supported.json.
    if (!SUPPORTED_BILLINGS.includes(input.billing as SupportedBilling)) {
      results.push({
        brand: input.brand,
        operator: input.operator,
        action: 'failed',
        status: 'rejected',
        errors: [{
          code: 'BILLING_NOT_SUPPORTED',
          message: `Billing model '${input.billing}' is not supported by this seller. Supported: ${SUPPORTED_BILLINGS.join(', ')}.`,
          recovery: 'correctable',
          details: {
            scope: 'capability',
            supported_billing: [...SUPPORTED_BILLINGS],
          },
        }],
      });
      continue;
    }

    // Per-account-relationship gate (BILLING_NOT_SUPPORTED, scope: "account").
    // Distinct from the capability gate above: the seller's capability
    // accepts the value, but the seller has no direct billing
    // relationship for THIS specific operator on THIS account. See
    // account-billing-relationships.ts for the operator-domain
    // convention the training-agent uses to simulate per-(operator,
    // billing) onboarding state. Recovery advice: same as the
    // capability gate (try the next-most-permissive value the seller's
    // supported_billing allows).
    if (isPerAccountBillingRestricted(input.operator, input.billing!)) {
      results.push({
        brand: input.brand,
        operator: input.operator,
        action: 'failed',
        status: 'rejected',
        errors: [{
          code: 'BILLING_NOT_SUPPORTED',
          message: `Operator '${input.operator}' has no direct billing relationship for '${input.billing}' billing. Try a different supported value.`,
          recovery: 'correctable',
          details: {
            scope: 'account',
            supported_billing: [...SUPPORTED_BILLINGS],
          },
        }],
      });
      continue;
    }

    // Per-buyer-agent commercial gate (BILLING_NOT_PERMITTED_FOR_AGENT).
    // The seller's capability accepts the value, but the calling buyer
    // agent's commercial relationship with the seller does not. Bright
    // line: emit only when agent identity has been established AND a
    // commercial-relationship record exists. `getCommercialRelationship`
    // returns undefined for principals without an onboarded record,
    // which falls through to no per-agent gate — preventing the code
    // from acting as an onboarding oracle for unrecognized callers.
    // See error-details/billing-not-permitted-for-agent.json (the
    // additionalProperties: false clamp on this details shape closes
    // the per-agent commercial-state oracle vector).
    const relationship = getCommercialRelationship(ctx.principal);
    if (relationship === 'passthrough_only' && input.billing !== 'operator') {
      results.push({
        brand: input.brand,
        operator: input.operator,
        action: 'failed',
        status: 'rejected',
        errors: [{
          code: 'BILLING_NOT_PERMITTED_FOR_AGENT',
          message: 'This buyer agent is onboarded as passthrough-only; only operator billing is permitted.',
          recovery: 'correctable',
          details: {
            rejected_billing: input.billing,
            suggested_billing: 'operator',
          },
        }],
      });
      continue;
    }

    const key = accountKey(input.brand, input.operator);
    const existing = accounts.get(key);
    const isSandbox = input.sandbox === true;
    const notificationConfigs = await normalizeNotificationConfigs(input);
    if (notificationConfigs && 'error' in notificationConfigs) {
      results.push(notificationConfigs.error);
      continue;
    }

    if (req.dry_run) {
      results.push({
        brand: input.brand,
        operator: input.operator,
        action: existing ? 'updated' : 'created',
        status: isSandbox ? 'active' : 'pending_approval',
        billing: input.billing,
        account_scope: 'operator_brand',
        sandbox: isSandbox || undefined,
        ...(
          Array.isArray(notificationConfigs)
            ? { notification_configs: sanitizeNotificationConfigs(notificationConfigs) }
            : existing?.notificationConfigs?.length
              ? { notification_configs: sanitizeNotificationConfigs(existing.notificationConfigs) }
              : {}
        ),
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
      billing: input.billing!,
      billingEntity: input.billing_entity,
      paymentTerms: input.payment_terms || 'net_30',
      status,
      accountScope: 'operator_brand',
      sandbox: isSandbox,
      rateCard: isSandbox ? 'sandbox' : 'standard',
      creditLimit: isSandbox ? undefined : { amount: 100000, currency: 'USD' },
      governanceAgents: existing?.governanceAgents || [],
      notificationConfigs: Array.isArray(notificationConfigs)
        ? notificationConfigs
        : existing?.notificationConfigs || [],
      notificationConfigsTouched: Array.isArray(notificationConfigs)
        ? true
        : existing?.notificationConfigsTouched,
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

    if (state.notificationConfigs.length > 0 || input.notification_configs !== undefined) {
      result.notification_configs = sanitizeNotificationConfigs(state.notificationConfigs);
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
  account?: AccountRef;
  status?: string;
  sandbox?: boolean;
  pagination?: { max_results?: number; cursor?: string };
}

function wireAccountMatchesRef(account: AccountWireShape, ref: AccountRef): boolean {
  if (ref.account_id) return account.account_id === ref.account_id;
  if (!ref.brand?.domain || !ref.operator) return false;
  if (account.brand.domain !== ref.brand.domain) return false;
  if (ref.brand.brand_id !== undefined && account.brand.brand_id !== ref.brand.brand_id) return false;
  if (account.operator !== ref.operator) return false;
  if (typeof ref.sandbox === 'boolean') return (account.sandbox === true) === ref.sandbox;
  return true;
}

function hasExactAccountFilter(ref: AccountRef | undefined): ref is AccountRef {
  return Boolean(ref?.account_id || (ref?.brand?.domain && ref.operator));
}

function mergeAccountFixtures(accounts: AccountWireShape[], fixtures: AccountWireShape[]): AccountWireShape[] {
  const seen = new Set(accounts.map(account => account.account_id));
  const merged = [...accounts];
  for (const fixture of fixtures) {
    if (seen.has(fixture.account_id)) continue;
    merged.push(fixture);
    seen.add(fixture.account_id);
  }
  return merged;
}

export function handleListAccounts(args: ToolArgs, ctx: TrainingContext): object {
  const req = args as unknown as ListAccountsRequest;
  const identityError = durableAccountIdentityError(ctx);
  if (identityError) return identityError;
  const sessionKey = sessionKeyFromArgs({}, ctx.mode, ctx.userId, ctx.moduleId);
  const accountMap = getAccountMap(sessionKey, ctx.principal);
  const preferFixtureAccounts = ctx.storyboardCompat?.version === '3.0';
  const exactAccountFilter = hasExactAccountFilter(req.account)
    && (req.sandbox !== true || Boolean(req.account?.account_id));
  const scopedAccounts = accountsForPrincipal(ctx.principal);

  let accounts: AccountWireShape[] = preferFixtureAccounts
    ? scopedAccounts.length > 0
      ? scopedAccounts.map(accountStateToWire)
      : getComplianceAccounts()
    : scopedAccounts.length > 0
      ? scopedAccounts.map(accountStateToWire)
      : accountMap.size > 0
        ? Array.from(accountMap.values()).map(accountStateToWire)
        : getComplianceAccounts();

  if (!preferFixtureAccounts && req.sandbox === true && !exactAccountFilter) {
    accounts = mergeAccountFixtures(accounts, getComplianceAccounts());
  }
  if (!preferFixtureAccounts && exactAccountFilter) {
    accounts = accounts.filter(a => wireAccountMatchesRef(a, req.account!));
  }
  if (!preferFixtureAccounts && req.status) {
    accounts = accounts.filter(a => a.status === req.status);
  }
  if (!preferFixtureAccounts && typeof req.sandbox === 'boolean') {
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
  const identityError = durableAccountIdentityError(ctx);
  if (identityError) return identityError;

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
  const accounts = getAccountMap(sessionKey, ctx.principal);
  const results: Record<string, unknown>[] = [];

  for (const input of req.accounts) {
    const acctRef = input.account;
    const acct = findAccountByRef(accounts, acctRef)
      ?? (acctRef.account_id ? findAccountByIdAcrossSessions(acctRef.account_id, ctx.principal) : undefined);

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
