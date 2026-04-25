/**
 * MCP tool definitions and AdCP task handlers for the training agent.
 *
 * Creates a per-request MCP Server with tools matching AdCP tasks.
 * Responses are deterministic — built from the product catalog and
 * session state, not from LLM calls.
 */

import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks';
import { PostgresTaskStore } from '@adcp/client';
import { mergeSeedProduct } from '@adcp/client/testing';
import { isDatabaseInitialized, getPool } from '../db/client.js';
import { createLogger } from '../logger.js';
import type { TrainingContext, CatalogProduct, MediaBuyState, PackageState, SignalActivationState, CreativeState, CreativeManifest, ToolArgs, ListReference, PackageTargeting } from './types.js';
import { encodeOffsetCursor, decodeOffsetCursor } from './pagination.js';
import type {
  Product,
  Proposal,
  FormatID,
  CreateMediaBuyRequest,
  UpdateMediaBuyRequest,
  GetProductsRequest,
  GetMediaBuysRequest,
  GetMediaBuyDeliveryRequest,
  ListCreativeFormatsRequest,
  SyncCreativesRequest,
  ListCreativesRequest,
  GetSignalsRequest,
  ActivateSignalRequest,
  GetCreativeDeliveryRequest,
  GetAdCPCapabilitiesRequest,
  BuildCreativeResponse,
  ListCreativesResponse,
  PreviewCreativeResponse,
  CreativeManifest as AdcpCreativeManifest,
} from '@adcp/client';
/** Escape HTML special characters to prevent injection in generated HTML responses. */
function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Build a structured MCP error response for tool calls (L3 error compliance). */
function adcpError(code: string, opts: { message: string; details?: unknown; recovery?: string; field?: string }, context?: unknown) {
  const errorObj = { code, ...opts };
  const body = context !== undefined
    ? { adcp_error: errorObj, context }
    : { adcp_error: errorObj };
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify(body) }],
    structuredContent: body,
  };
}

// Derive types from SDK request types that aren't re-exported from main entry
type PackageUpdate = NonNullable<UpdateMediaBuyRequest['packages']>[number];
type PackageUpdateExt = PackageUpdate & { canceled?: boolean; cancellation_reason?: string; targeting?: PackageTargeting; targeting_overlay?: PackageTargeting };
type Destination = NonNullable<ActivateSignalRequest['destinations']>[number];
type SignalFilters = NonNullable<GetSignalsRequest['filters']>;
type PricingOption = Product['pricing_options'][number];
type AuctionPricingOption = Exclude<PricingOption, { pricing_model: 'cpa' }>;

type GetMediaBuysArgs = GetMediaBuysRequest & ToolArgs & {
  status_filter?: string[];
  include_history?: number;
  include_snapshot?: boolean;
  pagination?: { max_results?: number; cursor?: string };
};

type UpdateMediaBuyArgs = UpdateMediaBuyRequest & ToolArgs & {
  revision?: number;
  canceled?: boolean;
  cancellation_reason?: string;
  paused?: boolean;
  new_packages?: PackageInput[];
};

interface PackageInput {
  product_id: string;
  pricing_option_id: string;
  budget: number;
  bid_price?: number;
  impressions?: number;
  paused?: boolean;
  start_time?: string;
  end_time?: string;
  format_ids?: FormatID[];
  targeting?: PackageTargeting;
  targeting_overlay?: PackageTargeting;
}

interface CreativeAssignmentInput {
  creative_id: string;
  package_id: string;
  media_buy_id: string;
}

const MAX_URL_LEN = 2048;
const MAX_ID_LEN = 256;
const MAX_TOKEN_LEN = 4096;

function validateListRef(ref: unknown, pathLabel: string): { ref?: ListReference; error?: TaskError } {
  if (ref === undefined || ref === null) return {};
  if (typeof ref !== 'object' || Array.isArray(ref)) {
    return { error: { code: 'VALIDATION_ERROR', message: `${pathLabel}: must be an object with agent_url and list_id`, field: pathLabel } };
  }
  const r = ref as Record<string, unknown>;
  const agent_url = r.agent_url;
  const list_id = r.list_id;
  const auth_token = r.auth_token;
  if (typeof agent_url !== 'string' || agent_url.length === 0 || agent_url.length > MAX_URL_LEN) {
    return { error: { code: 'VALIDATION_ERROR', message: `${pathLabel}.agent_url: must be a non-empty string up to ${MAX_URL_LEN} chars`, field: `${pathLabel}.agent_url` } };
  }
  if (!/^https?:\/\//i.test(agent_url)) {
    return { error: { code: 'VALIDATION_ERROR', message: `${pathLabel}.agent_url: must use http:// or https://`, field: `${pathLabel}.agent_url` } };
  }
  if (typeof list_id !== 'string' || list_id.length === 0 || list_id.length > MAX_ID_LEN) {
    return { error: { code: 'VALIDATION_ERROR', message: `${pathLabel}.list_id: must be a non-empty string up to ${MAX_ID_LEN} chars`, field: `${pathLabel}.list_id` } };
  }
  if (auth_token !== undefined && (typeof auth_token !== 'string' || auth_token.length > MAX_TOKEN_LEN)) {
    return { error: { code: 'VALIDATION_ERROR', message: `${pathLabel}.auth_token: must be a string up to ${MAX_TOKEN_LEN} chars`, field: `${pathLabel}.auth_token` } };
  }
  return { ref: { agent_url, list_id, ...(typeof auth_token === 'string' && { auth_token }) } };
}

function validateTargeting(t: unknown, pathLabel: string): { targeting?: PackageTargeting; errors: TaskError[] } {
  if (t === undefined || t === null) return { errors: [] };
  if (typeof t !== 'object' || Array.isArray(t)) {
    return { errors: [{ code: 'VALIDATION_ERROR', message: `${pathLabel}: must be an object`, field: pathLabel }] };
  }
  const src = t as Record<string, unknown>;
  const errors: TaskError[] = [];
  const pl = validateListRef(src.property_list, `${pathLabel}.property_list`);
  const cl = validateListRef(src.collection_list, `${pathLabel}.collection_list`);
  const cle = validateListRef(src.collection_list_exclude, `${pathLabel}.collection_list_exclude`);
  if (pl.error) errors.push(pl.error);
  if (cl.error) errors.push(cl.error);
  if (cle.error) errors.push(cle.error);
  if (errors.length) return { errors };
  if (!pl.ref && !cl.ref && !cle.ref) return { errors: [] };
  return {
    targeting: {
      ...(pl.ref && { property_list: pl.ref }),
      ...(cl.ref && { collection_list: cl.ref }),
      ...(cle.ref && { collection_list_exclude: cle.ref }),
    },
    errors: [],
  };
}

// Proposal lifecycle fields not yet in @adcp/client — remove after client update
interface ProposalLifecycle {
  proposal_status?: 'draft' | 'committed';
  insertion_order?: { io_id: string; requires_signature: boolean; terms?: Record<string, unknown> };
}
function proposalLifecycle(proposal: Proposal): ProposalLifecycle {
  return proposal as unknown as ProposalLifecycle;
}

import { buildCatalog, buildShowsForProducts, buildProposals } from './product-factory.js';
import { buildFormats, FORMAT_CHANNEL_MAP } from './formats.js';
import { getAllSignals, SIGNAL_PROVIDERS } from './signal-providers.js';
import {
  getSession, sessionKeyFromArgs,
  runWithSessionContext, flushDirtySessions,
  getComplianceCreatives, getComplianceCreative,
  MAX_MEDIA_BUYS_PER_SESSION, MAX_CREATIVES_PER_SESSION, MAX_USAGE_RECORDS_PER_SESSION,
} from './state.js';
import { getAgentUrl } from './config.js';
import {
  GOVERNANCE_TOOLS,
  handleSyncPlans,
  handleCheckGovernance,
  handleReportPlanOutcome,
  handleGetPlanAuditLogs,
} from './governance-handlers.js';
import {
  BRAND_TOOLS,
  handleGetBrandIdentity,
  handleGetRights,
  handleAcquireRights,
  handleUpdateRights,
  handleCreativeApproval,
} from './brand-handlers.js';
import {
  PROPERTY_TOOLS,
  handleCreatePropertyList,
  handleListPropertyLists,
  handleGetPropertyList,
  handleUpdatePropertyList,
  handleDeletePropertyList,
  handleValidatePropertyDelivery,
} from './property-handlers.js';
import {
  CONTENT_STANDARDS_TOOLS,
  handleCreateContentStandards,
  handleListContentStandards,
  handleGetContentStandards,
  handleUpdateContentStandards,
  handleCalibrateContent,
  handleValidateContentDelivery,
} from './content-standards-handlers.js';
import {
  ACCOUNT_TOOLS,
  handleListAccounts,
  handleSyncAccounts,
  handleSyncGovernance,
} from './account-handlers.js';
import {
  COLLECTION_LIST_TOOLS,
  handleCreateCollectionList,
  handleGetCollectionList,
  handleUpdateCollectionList,
  handleListCollectionLists,
  handleDeleteCollectionList,
} from './inventory-governance-handlers.js';
import {
  CATALOG_EVENT_TOOLS,
  handleSyncCatalogs,
  handleSyncEventSources,
  handleLogEvent,
  handleProvidePerformanceFeedback,
} from './catalog-event-handlers.js';
import {
  COMPLY_TEST_CONTROLLER_TOOL,
  handleComplyTestController,
  getDeliverySimulation,
  getAccountStatus,
  getSeededCreativeFormats,
} from './comply-test-controller.js';
import { PUBLISHERS } from './publishers.js';
import {
  isMutatingTool,
  validateKeyFormat,
  scopedPrincipal,
  getIdempotencyStore,
} from './idempotency.js';
import { maybeEmitCompletionWebhook } from './webhooks.js';
import { getRequestSigningCapability, getStrictRequestSigningCapability } from './request-signing.js';

const SUPPORTED_MAJOR_VERSIONS = [3] as const;
const MAX_PACKAGES_PER_BUY = 50;

// ── MCP Tasks store (SDK-managed) ─────────────────────────────────

/**
 * Shared task store across per-request Server instances.
 *
 * In production (database available), uses PostgresTaskStore so tasks
 * survive across Fly.io instances. In tests (no database), falls back
 * to InMemoryTaskStore.
 *
 * Note: no session isolation — any session can see/cancel tasks from
 * another. This is intentional for the training agent where all sessions
 * are sandboxed. Production servers should scope tasks by sessionId.
 */
let sdkTaskStore: InMemoryTaskStore | PostgresTaskStore | null = null;

function getTaskStore(): InMemoryTaskStore | PostgresTaskStore {
  if (!sdkTaskStore) {
    sdkTaskStore = isDatabaseInitialized()
      ? new PostgresTaskStore(getPool())
      : new InMemoryTaskStore();
  }
  return sdkTaskStore;
}

/** Look up which tools allow task augmentation. */
function toolSupportsTask(toolName: string): boolean {
  const tool = TOOLS.find(t => t.name === toolName);
  const support = tool?.execution?.taskSupport as string | undefined;
  return support === 'optional' || support === 'required';
}

/**
 * Extract an account-scoping string for the idempotency cache from the
 * tool arguments. Mirrors `sessionKeyFromArgs` but returns just the scope
 * portion (no `open:` prefix) so callers can feed it to `scopedPrincipal`.
 *
 * The scope is caller-controlled, so it doesn't authenticate anything —
 * its only job is to keep two different buyers on the same shared token
 * from seeing each other's idempotency outcomes.
 */
function deriveAccountScope(args: Record<string, unknown>): string | undefined {
  const account = (args.account as { account_id?: string; brand?: { domain?: string } } | undefined);
  if (account?.account_id && typeof account.account_id === 'string') {
    return `a:${account.account_id}`;
  }
  const domain = account?.brand?.domain
    ?? (args.brand as { domain?: string } | undefined)?.domain;
  if (typeof domain === 'string' && domain.length > 0) {
    return `b:${domain.toLowerCase()}`;
  }
  return undefined;
}

/** Clear the task store (for tests). Calls cleanup() to cancel TTL timers. */
export function clearTaskStore(): void {
  sdkTaskStore?.cleanup();
  sdkTaskStore = null;
}

/** Translate the agent's internal governance check shape into the wire-format
 * details block carried on a GOVERNANCE_DENIED error. Storyboards assert
 * `findings[]` and (when status is `conditions`) `conditions[]` on the error,
 * so surfacing them here is load-bearing. */
function governanceErrorDetails(check: import('./types.js').GovernanceCheckState): Record<string, unknown> {
  const details: Record<string, unknown> = {
    findings: check.findings.map(f => ({
      category_id: f.categoryId,
      severity: f.severity,
      explanation: f.explanation,
      ...(f.policyId && { policy_id: f.policyId }),
      ...(f.confidence !== undefined && { confidence: f.confidence }),
    })),
    plan_id: check.planId,
    check_id: check.checkId,
  };
  if (check.conditions?.length) {
    details.conditions = check.conditions.map(c => ({
      field: c.field,
      ...(c.requiredValue !== undefined && { required_value: c.requiredValue }),
      reason: c.reason,
    }));
  }
  return details;
}

/** Wire-format error shared by all training agent responses. */
interface TaskError {
  code: string;
  message: string;
  field?: string;
  details?: unknown;
  recovery?: string;
}

/** Signal deployment entry in get_signals response. */
interface SignalDeployment {
  type: 'agent' | 'platform';
  agent_url?: string;
  platform?: string;
  account?: string;
  is_live: boolean;
  activation_key?: { type: string; key: string; value: string };
  deployed_at?: string;
  estimated_activation_duration_minutes?: number;
}

/** Signal entry in get_signals response. */
interface SignalResponse {
  signal_agent_segment_id: string;
  signal_id: { source: string; data_provider_domain: string; id: string };
  name: string;
  description: string;
  value_type: string;
  signal_type: string;
  data_provider: string;
  coverage_percentage?: number;
  deployments: SignalDeployment[];
  pricing_options: SignalPricingOption[];
  categories?: string[];
  range?: { min: number; max: number };
}

/** Signal pricing option in get_signals response. */
interface SignalPricingOption {
  pricing_option_id: string;
  model: string;
  currency: string;
  cpm?: number;
  percent?: number;
  max_cpm?: number;
  amount?: number;
  period?: string;
}

/** Package delivery metrics in get_media_buy_delivery response. */
interface PackageDeliveryMetrics {
  package_id: string;
  spend: number;
  impressions: number;
  clicks: number;
  pricing_model: string;
  model: string;
  rate: number;
  currency: string;
  paused: boolean;
  delivery_status: 'delivering' | 'completed';
}

/** Creative variant in get_creative_delivery response. */
interface CreativeVariant {
  variant_id: string;
  generation_context: { context_type: string; topic: string; device_class: string };
  manifest: CreativeManifest;
  impressions: number;
  spend: number;
  clicks: number;
  ctr: number;
}

/** Creative delivery entry in get_creative_delivery response. */
interface CreativeDeliveryEntry {
  creative_id: string;
  media_buy_id?: string;
  format_id: FormatID;
  totals: { impressions: number; spend: number; clicks: number; ctr: number };
  variant_count: number;
  variants: CreativeVariant[];
}

/** Sync creative result entry. */
interface SyncCreativeResult {
  creative_id: string;
  action: 'created' | 'updated';
}

/** Creative assignment result. */
interface AssignmentResult {
  creative_id: string;
  package_id: string;
  status: 'assigned' | 'error';
  message?: string;
}


const logger = createLogger('training-agent');

/** Map natural vocabulary to terms that match signal tags and descriptions. */
const SYNONYM_MAP: Record<string, string[]> = {
  geographic: ['geo'],
  geospatial: ['geo'],
  geofence: ['geo'],
  geofencing: ['geo'],
  geotargeting: ['geo'],
  audience: ['segment'],
  audiences: ['segment'],
  segments: ['segment'],
  location: ['geo', 'proximity'],
  locations: ['geo', 'proximity'],
  identity: ['demographic', 'identity'],
  identities: ['demographic', 'identity'],
  purchase: ['retail', 'purchase'],
  purchases: ['retail', 'purchase'],
  buying: ['retail', 'purchase'],
  automotive: ['automotive'],
  auto: ['automotive'],
  car: ['automotive'],
  vehicle: ['automotive'],
  cars: ['automotive'],
  vehicles: ['automotive'],
  mobility: ['geo', 'behavioral'],
  movement: ['geo', 'behavioral'],
  travel: ['geo', 'behavioral'],
  footfall: ['geo', 'foot_traffic'],
  targeting: ['targeting', 'target'],
  credit: ['demographic', 'financial', 'credit'],
  loyalty: ['retail', 'behavioral', 'loyalty'],
  attribution: ['measurement'],
  shopper: ['retail', 'purchase'],
  brand: ['brand', 'retail'],
  buyer: ['retail', 'purchase'],
  basket: ['retail', 'purchase'],
  conquest: ['conquest', 'acquisition'],
  affinity: ['loyalty', 'behavioral'],
  frequency: ['frequency', 'behavioral'],
  dwell: ['dwell', 'behavioral'],
  engagement: ['engagement', 'behavioral'],
  sentiment: ['contextual', 'sentiment'],
  household: ['household', 'demographic'],
  income: ['income', 'financial'],
  demographic: ['demographic', 'identity'],
  contextual: ['contextual', 'content'],
  subscriber: ['subscriber', 'engagement'],
};

/** Derive lifecycle status from stored status and flight dates. */
export function deriveStatus(mb: MediaBuyState): string {
  if (mb.canceledAt) return 'canceled';
  if (mb.status === 'rejected') return 'rejected';
  const hasCreatives = mb.packages.some(pkg => pkg.creativeAssignments.length > 0);
  if (!hasCreatives && mb.status !== 'completed') {
    if (mb.complyControllerForced) {
      mb.complyControllerForced = false;
    } else {
      return 'pending_creatives';
    }
  }
  const now = new Date();
  if (mb.status === 'active' || mb.status === 'paused') {
    if (new Date(mb.endTime) < now) return 'completed';
    if (new Date(mb.startTime) > now) return 'pending_start';
  }
  if (mb.status === 'paused') return 'paused';
  return mb.status;
}

/** Map lifecycle status to valid buyer actions. */
function validActionsForStatus(status: string): string[] {
  switch (status) {
    case 'pending_creatives':
    case 'pending_start':
      return ['cancel', 'sync_creatives'];
    case 'active':
      return ['pause', 'cancel', 'update_budget', 'update_dates', 'update_packages', 'add_packages', 'sync_creatives'];
    case 'paused':
      return ['resume', 'cancel', 'update_budget', 'update_dates', 'update_packages', 'add_packages', 'sync_creatives'];
    default:
      return [];
  }
}

// ── Cached catalog and formats (built once at first use) ──────────
let cachedCatalog: CatalogProduct[] | null = null;
let cachedFormats: ReturnType<typeof buildFormats> | null = null;
let cachedProposals: import('@adcp/client').Proposal[] | null = null;

function getCatalog(): CatalogProduct[] {
  if (!cachedCatalog) cachedCatalog = buildCatalog();
  return cachedCatalog;
}

function getProposals(): import('@adcp/client').Proposal[] {
  if (!cachedProposals) cachedProposals = buildProposals(getCatalog());
  return cachedProposals;
}

function getFormats(): ReturnType<typeof buildFormats> {
  if (!cachedFormats) {
    cachedFormats = buildFormats(getAgentUrl());
  }
  return cachedFormats;
}

/** Invalidate cached catalog/formats (for tests or hot-reload) */
export function invalidateCache(): void {
  cachedCatalog = null;
  cachedFormats = null;
  cachedProposals = null;
}

/**
 * Canonicalize an agent URL for equality comparison: lowercase scheme + host,
 * strip a single trailing slash, preserve path case. Used to decide whether
 * a caller-supplied `format_id.agent_url` points at this agent.
 */
function canonicalizeAgentUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hostname = u.hostname.toLowerCase();
    u.protocol = u.protocol.toLowerCase();
    const s = u.toString();
    return s.endsWith('/') ? s.slice(0, -1) : s;
  } catch {
    return url.replace(/\/$/, '');
  }
}

/**
 * Merge products and pricing options seeded via comply_test_controller
 * (`seed_product`, `seed_pricing_option`) into the in-memory product map
 * used for create/validate flows. Seeded fixtures are permissive objects
 * (spec: additionalProperties: true) — we synthesize the minimum shape
 * the handlers consult (pricing_options with pricing_model/floor_price/
 * fixed_price/etc) so fixture-driven storyboards can reference products
 * that don't live in the static catalog.
 */
function overlaySeededProducts(
  session: import('./types.js').SessionState,
  productMap: Map<string, import('@adcp/client').Product>,
): void {
  const { seededProducts, seededPricingOptions } = session.complyExtensions;
  if (seededProducts.size === 0 && seededPricingOptions.size === 0) return;

  const pricingByProduct = new Map<string, Array<Record<string, unknown>>>();
  for (const [key, pxFx] of seededPricingOptions) {
    const sep = key.indexOf(':');
    const productId = sep > 0 ? key.slice(0, sep) : key;
    const list = pricingByProduct.get(productId) ?? [];
    list.push(pxFx);
    pricingByProduct.set(productId, list);
  }

  const productIds = new Set<string>([
    ...seededProducts.keys(),
    ...pricingByProduct.keys(),
  ]);
  for (const productId of productIds) {
    const existing = productMap.get(productId) ?? {} as Partial<Product>;
    const fixture = seededProducts.get(productId) as Partial<Product> | undefined;
    const seededPricing = pricingByProduct.get(productId);
    let merged = mergeSeedProduct(existing as Partial<Product>, fixture ?? null);
    merged = { ...merged, product_id: productId } as Partial<Product>;
    if (seededPricing && seededPricing.length > 0) {
      merged = mergeSeedProduct(merged, {
        pricing_options: seededPricing as unknown as Product['pricing_options'],
      });
    }
    productMap.set(productId, merged as Product);
  }
}

// ── Channel aliases for brief matching (module-scoped for perf) ──

const BRIEF_CHANNEL_ALIASES: Record<string, string> = {
  'ctv': 'ctv', 'connected tv': 'ctv', 'ott': 'ctv',
  'olv': 'olv', 'online video': 'olv', 'pre-roll': 'olv', 'preroll': 'olv',
  'display': 'display', 'banner': 'display',
  'social': 'social', 'social media': 'social',
  'native': 'native',
  'audio': 'streaming_audio', 'streaming audio': 'streaming_audio', 'podcast': 'podcast',
  'search': 'search', 'sem': 'search',
  'linear tv': 'linear_tv', 'linear': 'linear_tv',
  'dooh': 'dooh', 'digital out of home': 'dooh',
  'gaming': 'gaming', 'in-game': 'gaming',
  'email': 'email', 'newsletter': 'email',
  'print': 'print',
  'influencer': 'influencer',
  'radio': 'radio',
};

// ── Shared schema fragments ──────────────────────────────────────

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
      required: ['brand', 'operator'],
    },
  ],
} as const;

// Tools whose response schema defines an Error variant at top level
// (oneOf success | {errors: [...]}). Handler-returned errors are placed
// in the response body rather than wrapped in an MCP isError envelope,
// matching spec-compliant agents and allowing field_present validations
// on the errors array.
const ERROR_IN_BODY_TOOLS = new Set<string>([
  'update_media_buy',
]);

// ── Tool definitions ──────────────────────────────────────────────

const TOOLS = [
  {
    name: 'get_products',
    description: 'Discover available advertising products. Supports brief (curated discovery), wholesale (raw catalog), and refine (iterate on previous results) buying modes. Use this before create_media_buy to find valid product_id and pricing_option_id values. Not for checking delivery or managing existing buys. Returns sandbox catalog data.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        buying_mode: { type: 'string', enum: ['brief', 'wholesale', 'refine'] },
        brief: { type: 'string' },
        refine: { type: 'array' },
        account: ACCOUNT_REF_SCHEMA,
        brand: { type: 'object' },
        filters: { type: 'object' },
        fields: { type: 'array', items: { type: 'string' } },
      },
      required: ['buying_mode'],
    },
  },
  {
    name: 'list_creative_formats',
    description: 'List supported creative formats with asset requirements, dimensions, and rendering specifications. Filter by channels to see formats relevant to specific media types. Not for uploading creatives (use sync_creatives) or checking creative status.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    execution: { taskSupport: 'forbidden' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        format_ids: { type: 'array' },
        channels: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'create_media_buy',
    description: 'Create a media buy with one or more packages targeting specific products. Requires valid product_id and pricing_option_id from get_products. Not for updating existing buys (use update_media_buy). Cannot add packages to an existing buy after creation.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        idempotency_key: { type: 'string' },
        account: ACCOUNT_REF_SCHEMA,
        brand: { type: 'object', properties: { domain: { type: 'string' }, name: { type: 'string' } } },
        packages: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              product_id: { type: 'string' },
              pricing_option_id: { type: 'string' },
              budget: { type: 'number' },
              bid_price: { type: 'number' },
              impressions: { type: 'number' },
              paused: { type: 'boolean' },
              start_time: { type: 'string' },
              end_time: { type: 'string' },
              format_ids: { type: 'array' },
            },
            required: ['product_id', 'pricing_option_id', 'budget'],
          },
        },
        proposal_id: { type: 'string' },
        total_budget: { type: 'object', properties: { amount: { type: 'number' }, currency: { type: 'string' } } },
        start_time: { type: 'string', description: 'ISO 8601 date-time or "asap"' },
        end_time: { type: 'string' },
        channel: { type: 'string', description: 'Primary channel for governance compliance (display, video, native, audio)' },
        channels: { type: 'array', items: { type: 'string' }, description: 'Channels for governance compliance' },
        countries: { type: 'array', items: { type: 'string' }, description: 'Target countries (ISO 3166-1 alpha-2) for governance compliance' },
        governance_context: { type: 'string', maxLength: 4096, description: 'Opaque governance context from a prior check_governance response. Persisted and returned on get_media_buys.' },
        push_notification_config: {
          type: 'object',
          description: 'Webhook destination for async completion notification. RFC 9421 signed by default; HMAC-SHA256 fallback when authentication is populated.',
          properties: {
            url: { type: 'string', format: 'uri' },
            authentication: {
              type: 'object',
              properties: {
                schemes: { type: 'array', items: { type: 'string' } },
                credentials: { type: 'string' },
              },
            },
          },
        },
      },
      required: ['account', 'brand', 'start_time', 'end_time'],
    },
  },
  {
    name: 'get_media_buys',
    description: 'List media buys for the current session/account. Returns buy configuration and status only — not delivery metrics (use get_media_buy_delivery for that). Only returns buys created in the current session; buys from other sessions are not visible.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    execution: { taskSupport: 'forbidden' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        account: ACCOUNT_REF_SCHEMA,
        media_buy_ids: { type: 'array', items: { type: 'string' } },
        status_filter: { type: 'array', items: { type: 'string', enum: ['pending_creatives', 'pending_start', 'active', 'paused', 'completed', 'canceled', 'rejected'] }, description: 'Filter by lifecycle status. Defaults to ["active"] when no media_buy_ids provided.' },
        include_history: { type: 'integer', minimum: 0, maximum: 1000, description: 'Include the last N revision history entries per media buy. 0 or omit to exclude. Recommended: 5-10 for monitoring, 50+ for audit.' },
        include_snapshot: { type: 'boolean', description: 'Include full media buy snapshot in response' },
      },
    },
  },
  {
    name: 'get_media_buy_delivery',
    description: 'Get delivery metrics for a media buy including impressions, spend, and clicks by package. Requires a media_buy_id from create_media_buy. Returns simulated metrics proportional to elapsed flight time. Not for creating or updating buys.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    execution: { taskSupport: 'forbidden' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        account: ACCOUNT_REF_SCHEMA,
        media_buy_id: { type: 'string' },
        media_buy_ids: { type: 'array', items: { type: 'string' }, description: 'Plural form (SDK)' },
      },
      required: ['media_buy_id'] as const,
    },
  },
  {
    name: 'sync_creatives',
    description: 'Upload or update creative assets and optionally assign them to packages. Validates format_id against list_creative_formats. Not for listing existing creatives (use list_creatives). Creative content is not validated — only format_id is checked.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        account: ACCOUNT_REF_SCHEMA,
        creatives: { type: 'array' },
        assignments: { type: 'array' },
        dry_run: { type: 'boolean' },
      },
      required: ['account', 'creatives'],
    },
  },
  {
    name: 'list_creatives',
    description: 'List creative assets for the current session. Filter by creative_ids or media_buy_id to narrow results. When include_pricing is true and account is provided, returns per-creative pricing from the account rate card. Not for uploading or updating creatives (use sync_creatives).',
    annotations: { readOnlyHint: true, idempotentHint: true },
    execution: { taskSupport: 'forbidden' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        account: ACCOUNT_REF_SCHEMA,
        creative_ids: { type: 'array', items: { type: 'string' } },
        media_buy_id: { type: 'string' },
        include_pricing: { type: 'boolean', description: 'Include pricing from the account rate card on each creative (default: false). Requires account.' },
        include_snapshot: { type: 'boolean', description: 'Include delivery snapshot per creative' },
        filters: { type: 'object', properties: { creative_ids: { type: 'array', items: { type: 'string' } }, statuses: { type: 'array', items: { type: 'string' } } } },
      },
    },
  },
  {
    name: 'get_creative_delivery',
    description: 'Get variant-level creative delivery data including what was generated, manifests, and per-variant metrics. Call this to see what creatives were actually served and how each variant performed. Requires at least one of media_buy_ids or creative_ids.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    execution: { taskSupport: 'forbidden' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        account: ACCOUNT_REF_SCHEMA,
        media_buy_ids: { type: 'array', items: { type: 'string' } },
        creative_ids: { type: 'array', items: { type: 'string' } },
        max_variants: { type: 'number' },
      },
    },
  },
  {
    name: 'build_creative',
    description: 'Build a creative from assets and a target format. Supports two modes: (1) Stateless transformation — pass a creative_manifest with inline assets and a target_format_id to produce a serving tag. (2) Library retrieval — pass a creative_id referencing a synced creative to generate a tag. Returns a creative manifest with an HTML/JavaScript/VAST serving tag.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        account: ACCOUNT_REF_SCHEMA,
        creative_id: { type: 'string', description: 'Reference to a synced creative (ad server mode)' },
        creative_manifest: { type: 'object', description: 'Inline manifest with assets (transformation mode)' },
        target_format_id: { type: 'object', properties: { agent_url: { type: 'string' }, id: { type: 'string' } }, description: 'Target output format' },
        target_format_ids: { type: 'array', items: { type: 'object', properties: { agent_url: { type: 'string' }, id: { type: 'string' } } }, description: 'Multiple target formats' },
        brand: { type: 'object', properties: { domain: { type: 'string' } }, description: 'Brand reference for identity resolution' },
        media_buy_id: { type: 'string', description: 'Media buy context for placement-level tags' },
        package_id: { type: 'string', description: 'Package context for placement-level tags' },
        quality: { type: 'string', enum: ['draft', 'production'] },
        message: { type: 'string', description: 'Natural language instructions for generative builds' },
        include_preview: { type: 'boolean', description: 'Include a preview URL or inline HTML in the build response' },
        governance_context: { type: 'string', maxLength: 4096, description: 'Opaque governance context from check_governance. Echoed on the response.' },
      },
    },
  },
  {
    name: 'preview_creative',
    description: 'Preview a creative to see how it will render. Accepts a creative manifest (inline assets) or creative_id (from library). Returns a preview URL or inline HTML. Supports single and batch modes.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        account: ACCOUNT_REF_SCHEMA,
        request_type: { type: 'string', enum: ['single', 'batch', 'variant'], description: 'Preview mode: single, batch, or variant' },
        creative_manifest: { type: 'object', description: 'Creative manifest with assets to preview (required for single mode)' },
        creative_id: { type: 'string', description: 'Creative identifier for context (variant mode)' },
        requests: { type: 'array', description: 'Array of preview requests for batch mode (1-50 items)', minItems: 1, maxItems: 50, items: { type: 'object', properties: { creative_manifest: { type: 'object' } }, required: ['creative_manifest'] } },
        variant_id: { type: 'string', description: 'Variant ID from get_creative_delivery (required for variant mode)' },
        output_format: { type: 'string', enum: ['url', 'html', 'both'], description: 'Preview output format' },
        quality: { type: 'string', enum: ['draft', 'production'] },
        template_id: { type: 'string', description: 'Specific template ID for custom format rendering' },
        item_limit: { type: 'integer', minimum: 1, description: 'Max catalog items to render per preview' },
      },
      required: ['request_type'] as const,
    },
  },
  {
    name: 'update_media_buy',
    description: 'Update an existing media buy. Supports changing package budget, paused state, end_time, cancellation, and adding new packages. Requires revision for optimistic concurrency. Not for creating new buys (use create_media_buy).',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        account: ACCOUNT_REF_SCHEMA,
        media_buy_id: { type: 'string' },
        revision: { type: 'number', description: 'Current revision for optimistic concurrency control' },
        paused: { type: 'boolean', description: 'Pause (true) or resume (false) the media buy' },
        canceled: { type: 'boolean', const: true, description: 'Cancel the media buy (one-way, cannot be undone)' },
        cancellation_reason: { type: 'string', description: 'Reason for cancellation' },
        packages: { type: 'array' },
        new_packages: { type: 'array', items: { type: 'object', properties: { product_id: { type: 'string' }, pricing_option_id: { type: 'string' }, budget: { type: 'number' }, bid_price: { type: 'number' }, impressions: { type: 'number' }, paused: { type: 'boolean' }, start_time: { type: 'string' }, end_time: { type: 'string' }, format_ids: { type: 'array' } }, required: ['product_id', 'pricing_option_id', 'budget'] }, description: 'Add new packages to the media buy' },
        end_time: { type: 'string' },
        action: { type: 'string', description: 'Action to perform (pause, resume, cancel, extend)' },
      },
      required: ['account', 'media_buy_id'] as const,
    },
  },
  {
    name: 'get_signals',
    description: 'Discover signals matching campaign criteria. Supports natural language discovery via signal_spec or exact lookup via signal_ids. Returns signals with deployment status, pricing, and activation keys. Use this to find targetable audiences, contextual categories, geographic regions, and other data attributes.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        signal_spec: { type: 'string', description: 'Natural language description of desired signals' },
        brief: { type: 'string', description: 'Alias for signal_spec (SDK compatibility)' },
        signal_ids: { type: 'array', items: { type: 'object' }, description: 'Specific signals to look up by ID' },
        account: ACCOUNT_REF_SCHEMA,
        destinations: { type: 'array', items: { type: 'object' }, description: 'Filter to specific deployment targets' },
        countries: { type: 'array', items: { type: 'string' } },
        filters: { type: 'object' },
        max_results: { type: 'integer' },
      },
    },
  },
  {
    name: 'activate_signal',
    description: 'Activate a signal for use on a specific platform or agent. Requires signal_agent_segment_id from get_signals and at least one destination. Returns deployment status with activation keys.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        signal_agent_segment_id: { type: 'string' },
        signal_id: { type: 'string', description: 'Alias for signal_agent_segment_id (SDK compatibility)' },
        action: { type: 'string', enum: ['activate', 'deactivate'] },
        destinations: { type: 'array', items: { type: 'object' } },
        destination: { type: 'object', description: 'Single destination (SDK compatibility)' },
        options: { type: 'object', description: 'Activation options (SDK compatibility)' },
        pricing_option_id: { type: 'string' },
        governance_context: { type: 'string', maxLength: 4096, description: 'Opaque governance context from check_governance. Persisted on the activation.' },
        account: ACCOUNT_REF_SCHEMA,
      },
      required: [] as const,
    },
  },
  ...ACCOUNT_TOOLS,
  ...CATALOG_EVENT_TOOLS,
  ...GOVERNANCE_TOOLS,
  ...PROPERTY_TOOLS,
  ...COLLECTION_LIST_TOOLS,
  ...CONTENT_STANDARDS_TOOLS,
  ...BRAND_TOOLS,
  COMPLY_TEST_CONTROLLER_TOOL,
  {
    name: 'report_usage',
    description: 'Report consumption data for billing verification. Send creative_id and pricing_option_id for creative agents, signal_agent_segment_id for signals agents. The vendor verifies the reported cost against its rate card.',
    annotations: { readOnlyHint: false, idempotentHint: true },
    execution: { taskSupport: 'forbidden' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        account: ACCOUNT_REF_SCHEMA,
        idempotency_key: { type: 'string', description: 'UUID for retry safety' },
        reporting_period: { type: 'object', properties: { start: { type: 'string' }, end: { type: 'string' } }, required: ['start', 'end'] },
        usage: {
          type: 'array', items: {
            type: 'object', properties: {
              account: ACCOUNT_REF_SCHEMA,
              creative_id: { type: 'string', description: 'Creative identifier (creative agents)' },
              signal_agent_segment_id: { type: 'string', description: 'Signal identifier (signals agents)' },
              pricing_option_id: { type: 'string', description: 'Pricing option from discovery or build response' },
              impressions: { type: 'number' },
              media_spend: { type: 'number' },
              vendor_cost: { type: 'number' },
              currency: { type: 'string' },
            },
            required: ['account', 'vendor_cost', 'currency'],
          },
        },
      },
      required: ['reporting_period', 'usage'] as const,
    },
  },
  {
    name: 'get_adcp_capabilities',
    description: 'Discover the capabilities of this AdCP agent — supported tasks, features, and protocol version. Call once per session; capabilities are static.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    execution: { taskSupport: 'forbidden' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
];

// ── Task handler implementations ──────────────────────────────────

export async function handleGetProducts(args: ToolArgs, ctx: TrainingContext) {
  const req = args as unknown as GetProductsRequest & ToolArgs;
  const buyingMode = req.buying_mode || 'brief';
  const session = await getSession(sessionKeyFromArgs(req, ctx.mode, ctx.userId, ctx.moduleId));

  let products: Product[] = getCatalog().map(cp => ({ ...cp.product }));

  // Apply filters
  if (req.filters) {
    const channelFilter = req.filters.channels;
    if (channelFilter?.length) {
      products = products.filter(p =>
        p.channels?.some(c => (channelFilter as string[]).includes(c)),
      );
    }
    const deliveryTypeFilter = req.filters.delivery_type;
    if (deliveryTypeFilter) {
      products = products.filter(p => p.delivery_type === deliveryTypeFilter);
    }
  }

  // Brief mode: channel-aware keyword matching
  if (buyingMode === 'brief' && req.brief) {
    const briefLower = req.brief.toLowerCase();
    const terms = briefLower.split(/\s+/);

    // Extract channel names mentioned in the brief — these get heavy weight
    const briefChannels = new Set<string>();
    for (const [alias, channel] of Object.entries(BRIEF_CHANNEL_ALIASES)) {
      if (briefLower.includes(alias)) briefChannels.add(channel);
    }

    const scored = products
      .map(p => {
        const text = `${p.name} ${p.description} ${p.channels?.join(' ')}`.toLowerCase();
        const keywordScore = terms.filter(t => text.includes(t)).length;
        // Channel match: +10 per matching channel (dominates keyword scoring)
        const channelScore = briefChannels.size > 0
          ? (p.channels?.filter(c => briefChannels.has(c)).length ?? 0) * 10
          : 0;
        const totalScore = channelScore + keywordScore;
        return totalScore > 0 ? { product: p, totalScore, channelScore, keywordScore } : null;
      })
      .filter((s): s is NonNullable<typeof s> => s !== null)
      .sort((a, b) => b.totalScore - a.totalScore);

    // Cap at top 5 most relevant products so learners see brief mode as curated discovery
    const MAX_BRIEF_RESULTS = 5;
    products = scored.slice(0, MAX_BRIEF_RESULTS).map(s => ({
      ...s.product,
      brief_relevance: `Matches ${s.channelScore > 0 ? `${s.channelScore / 10} channel(s)` : 'keywords only'}. ${s.product.description}`,
    }));

    // If no keyword matches, return top products as suggestions
    if (products.length === 0) {
      products = getCatalog().slice(0, MAX_BRIEF_RESULTS).map(cp => ({
        ...cp.product,
        brief_relevance: 'Suggested product — no direct keyword match with your brief.',
      }));
    }
  }

  // Refine mode: apply include/omit/more_like_this/finalize
  type RefineEntry =
    | { scope: 'request'; ask?: string }
    | { scope: 'product'; product_id: string; action?: 'include' | 'omit' | 'more_like_this'; ask?: string }
    | { scope: 'proposal'; proposal_id: string; action?: 'include' | 'omit' | 'finalize'; ask?: string };

  type RefinementAppliedEntry = {
    scope: 'request' | 'product' | 'proposal';
    product_id?: string;
    proposal_id?: string;
    status: 'applied' | 'partial' | 'unable';
    notes?: string;
  };

  const refinementApplied: RefinementAppliedEntry[] = [];
  const proposalOmitIds = new Set<string>();
  if (buyingMode === 'refine' && req.refine) {
    const previousProducts = session.lastGetProductsContext?.products || products;
    const previousProposals = session.lastGetProductsContext?.proposals || getProposals();
    const omitIds = new Set<string>();
    const includeIds = new Set<string>();

    const askAckNotes = (ask?: string) =>
      ask ? { notes: `Ask acknowledged but not applied by training agent: ${ask}` } : {};

    for (const op of req.refine as unknown as RefineEntry[]) {
      if (op.scope === 'product') {
        const action = op.action ?? 'include';
        if (action === 'omit') {
          omitIds.add(op.product_id);
          refinementApplied.push({ scope: 'product', product_id: op.product_id, status: 'applied' });
        } else if (action === 'include') {
          includeIds.add(op.product_id);
          refinementApplied.push({ scope: 'product', product_id: op.product_id, status: op.ask ? 'partial' : 'applied', ...askAckNotes(op.ask) });
        } else if (action === 'more_like_this') {
          includeIds.add(op.product_id);
          const source = previousProducts.find(p => p.product_id === op.product_id);
          if (source) {
            const sourceChannels = source.channels;
            for (const p of getCatalog()) {
              if (p.product.channels?.some(c => sourceChannels?.includes(c))) {
                includeIds.add(p.product.product_id);
              }
            }
          }
          refinementApplied.push({ scope: 'product', product_id: op.product_id, status: 'applied' });
        }
      } else if (op.scope === 'proposal') {
        const action = op.action ?? 'include';
        const proposal = previousProposals.find(p => p.proposal_id === op.proposal_id);
        if (!proposal) {
          refinementApplied.push({ scope: 'proposal', proposal_id: op.proposal_id, status: 'unable', notes: `Proposal not found: ${op.proposal_id}` });
          continue;
        }
        if (action === 'omit') {
          proposalOmitIds.add(op.proposal_id);
          refinementApplied.push({ scope: 'proposal', proposal_id: op.proposal_id, status: 'applied' });
        } else if (action === 'include') {
          refinementApplied.push({ scope: 'proposal', proposal_id: op.proposal_id, status: op.ask ? 'partial' : 'applied', ...askAckNotes(op.ask) });
        } else if (action === 'finalize') {
          const status = proposalLifecycle(proposal).proposal_status;
          if (status === 'committed') {
            refinementApplied.push({ scope: 'proposal', proposal_id: op.proposal_id, status: 'applied', notes: 'Proposal already committed' });
          } else if (status === 'draft') {
            const committed = { ...proposal } as Record<string, unknown> & ProposalLifecycle;
            committed.proposal_status = 'committed';
            (committed as Record<string, unknown>).expires_at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

            const hasGuaranteed = proposal.allocations.some(alloc => {
              const cp = getCatalog().find(c => c.product.product_id === alloc.product_id);
              return cp?.product.delivery_type === 'guaranteed';
            });
            if (hasGuaranteed) {
              const publisherCp = getCatalog().find(c => c.product.product_id === proposal.allocations[0].product_id);
              const accountBrand = (req as unknown as Record<string, unknown>).account as Record<string, unknown> | undefined;
              const brandDomain = ((accountBrand?.brand as Record<string, unknown>)?.domain as string) || 'advertiser.example';
              committed.insertion_order = {
                io_id: `io_${randomUUID().replace(/-/g, '')}`,
                terms: {
                  advertiser: brandDomain,
                  publisher: publisherCp?.publisherId || 'unknown',
                  total_budget: {
                    amount: proposal.total_budget_guidance?.recommended ?? 0,
                    currency: proposal.total_budget_guidance?.currency ?? 'USD',
                  },
                  flight_start: new Date().toISOString(),
                  flight_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
                  payment_terms: 'net_30',
                },
                requires_signature: true,
              };
            }

            if (!session.lastGetProductsContext) {
              session.lastGetProductsContext = { products: [...products], proposals: [] };
            }
            const sessionProposals = session.lastGetProductsContext.proposals || [];
            const idx = sessionProposals.findIndex(p => p.proposal_id === op.proposal_id);
            const updatedProposal = committed as unknown as import('@adcp/client').Proposal;
            if (idx >= 0) {
              sessionProposals[idx] = updatedProposal;
            } else {
              sessionProposals.push(updatedProposal);
            }
            session.lastGetProductsContext.proposals = sessionProposals;

            refinementApplied.push({ scope: 'proposal', proposal_id: op.proposal_id, status: 'applied', notes: 'Proposal finalized — pricing committed, inventory held for 24 hours' });
          } else {
            refinementApplied.push({ scope: 'proposal', proposal_id: op.proposal_id, status: 'applied', notes: 'Proposal is already ready to buy (no finalization needed)' });
          }
        }
      } else if (op.scope === 'request') {
        refinementApplied.push({ scope: 'request', status: 'partial', notes: 'Request-level refinement acknowledged but not applied by training agent' });
      }
    }

    // Apply includes first (expand), then omits (filter) for products
    if (includeIds.size > 0) {
      products = getCatalog()
        .filter(cp => includeIds.has(cp.product.product_id))
        .map(cp => ({ ...cp.product }));
    }
    if (omitIds.size > 0) {
      products = products.filter(p => !omitIds.has(p.product_id));
    }
  }

  // Brief mode only: complete proposals by pulling in missing allocated products.
  // This prevents keyword capping from accidentally breaking proposals.
  const productIds = new Set(products.map(p => p.product_id));
  if (buyingMode === 'brief') {
    const catalogById = new Map(getCatalog().map(cp => [cp.product.product_id, cp.product]));
    for (const proposal of getProposals()) {
      const missing = proposal.allocations.filter(a => !productIds.has(a.product_id));
      const present = proposal.allocations.filter(a => productIds.has(a.product_id));
      if (present.length > 0 && missing.length > 0) {
        for (const alloc of missing) {
          const product = catalogById.get(alloc.product_id);
          if (product) {
            products.push({ ...product });
            productIds.add(alloc.product_id);
          }
        }
      }
    }
  }

  // In refine mode, use session proposals (which may include finalized versions)
  const sourceProposals = (buyingMode === 'refine' && session.lastGetProductsContext?.proposals)
    ? session.lastGetProductsContext.proposals
    : getProposals();

  const proposals = sourceProposals.filter(proposal =>
    proposal.allocations.every(a => productIds.has(a.product_id)) &&
    !proposalOmitIds.has(proposal.proposal_id),
  );

  // Store context for refine
  session.lastGetProductsContext = { products, proposals };

  return {
    products,
    ...(proposals.length > 0 && { proposals }),
    ...(refinementApplied.length > 0 && { refinement_applied: refinementApplied }),
  };
}

export async function handleListCreativeFormats(args: ToolArgs, _ctx: TrainingContext): Promise<object> {
  const req = args as unknown as ListCreativeFormatsRequest & { channels?: string[] };

  // When comply_test_controller.seed_creative_format has pre-populated formats,
  // use the seeded catalog so pagination-integrity storyboards can pin
  // has_more / cursor / total_count against a known set size. The seed pool is
  // process-global (not session-scoped) because list_creative_formats has no
  // tenant identity in its request schema — every call is a global catalog
  // read. Other seed_* scenarios (seed_creative, seed_media_buy) target
  // entities the listing call carries identity for and stay session-scoped.
  // Falls back to the static catalog when the seed pool is empty so normal
  // (non-compliance) callers are unaffected.
  let formats: ReturnType<typeof getFormats>;
  const seeded = getSeededCreativeFormats();
  if (seeded.size > 0) {
    // Seeded entries are stored as Record<string, unknown> with the format_id
    // stamped at seed time. Storyboards seed complete TrainingFormat-shaped
    // fixtures (name/description/renders/assets); the cast through unknown
    // matches that contract without re-validating at read time.
    formats = Array.from(seeded.values()) as unknown as ReturnType<typeof getFormats>;
  } else {
    formats = getFormats();

    // Filter by channels (informal field; stripped by SDK in compliance runs,
    // so this path is only reachable in non-SDK direct calls).
    if (req.channels?.length) {
      const validIds = new Set<string>();
      for (const [fmtId, fmtChannels] of Object.entries(FORMAT_CHANNEL_MAP)) {
        if (fmtChannels.some(c => req.channels!.includes(c))) {
          validIds.add(fmtId);
        }
      }
      formats = formats.filter(f => validIds.has(f.format_id.id));
    }
  }

  // Filter by format_ids (applies in both seeded and static paths)
  if (req.format_ids?.length) {
    const requestedIds = new Set(req.format_ids.map(f => f.id));
    formats = formats.filter(f => requestedIds.has(f.format_id.id));
  }

  const totalMatching = formats.length;
  const requestedMax = req.pagination?.max_results;
  const maxResults = Math.min(typeof requestedMax === 'number' ? requestedMax : 50, 100);
  const offset = decodeCreativeCursor(req.pagination?.cursor);
  if (offset === null) {
    return { errors: [{ code: 'INVALID_REQUEST', message: 'pagination.cursor is malformed' }] };
  }
  const pageEnd = Math.min(offset + maxResults, totalMatching);
  const pageFormats = formats.slice(offset, pageEnd);
  const hasMore = pageEnd < totalMatching;

  return {
    formats: pageFormats,
    pagination: {
      has_more: hasMore,
      total_count: totalMatching,
      ...(hasMore && { cursor: encodeCreativeCursor(pageEnd) }),
    },
  };
}

export async function handleCreateMediaBuy(args: ToolArgs, ctx: TrainingContext) {
  const req = args as unknown as CreateMediaBuyRequest & ToolArgs;
  const session = await getSession(sessionKeyFromArgs(req, ctx.mode, ctx.userId, ctx.moduleId));

  // Consume any single-shot directive registered by
  // comply_test_controller.force_create_media_buy_arm. Runs before all other
  // gates so the storyboard's wire-shape probe is not confounded by governance
  // or account-status checks; the directive is sandbox-only and the runner
  // explicitly opted into this response shape. Cleared after read — a second
  // create_media_buy from the same session resumes default behavior.
  // Idempotency_key replay is unaffected: the SDK's request-idempotency cache
  // wraps this handler, so a replayed request returns the cached submitted
  // response without re-evaluating the (now-empty) directive slot.
  const directive = session.complyExtensions.forcedCreateMediaBuyArm;
  if (
    directive
    && directive.arm === 'submitted'
    && typeof directive.taskId === 'string'
    && directive.taskId.length > 0
    && directive.taskId.length <= 128
  ) {
    session.complyExtensions.forcedCreateMediaBuyArm = undefined;
    const responseMessage =
      typeof directive.message === 'string' && directive.message.length <= 2000
        ? directive.message
        : undefined;
    return {
      status: 'submitted',
      task_id: directive.taskId,
      ...(responseMessage && { message: responseMessage }),
    };
  }

  // Enforce account status gates set by comply_test_controller
  const accountId = (req as unknown as Record<string, unknown>).account as { account_id?: string } | undefined;
  if (accountId?.account_id) {
    const acctStatus = getAccountStatus(session, accountId.account_id);
    if (acctStatus && acctStatus !== 'active') {
      const BLOCKED_STATUSES: Record<string, string> = {
        suspended: 'Account is suspended — contact the seller to resolve.',
        payment_required: 'Account requires payment before new media buys can be created.',
        closed: 'Account is closed and cannot create new media buys.',
        rejected: 'Account was rejected and cannot create media buys.',
      };
      return {
        errors: [{ code: 'ACCOUNT_STATUS_BLOCKED', message: BLOCKED_STATUSES[acctStatus] || `Account status "${acctStatus}" does not permit new media buys.` }] as TaskError[],
      };
    }
  }

  // Enforce governance: if governance plans exist, validate the buy budget.
  // Deny-on-any-plan: without a governance_context there is no way to know
  // which plan the buy targets, so a conservative deny teaches buyers to call
  // check_governance first.
  const rawGovCtx = (req as unknown as Record<string, unknown>).governance_context;
  const govCtx = typeof rawGovCtx === 'string' && rawGovCtx ? rawGovCtx : undefined;
  if (govCtx) {
    // Find the latest check for this governance_context (Map iterates in insertion order)
    let latestCheck: import('./types.js').GovernanceCheckState | undefined;
    for (const check of session.governanceChecks.values()) {
      if (check.governanceContext === govCtx) {
        latestCheck = check;
      }
    }
    if (latestCheck?.status === 'denied') {
      return {
        errors: [{
          code: 'GOVERNANCE_DENIED',
          message: latestCheck.explanation || 'Governance check denied this purchase.',
          details: governanceErrorDetails(latestCheck),
        }] as TaskError[],
      };
    }
    // governance_context provided but no matching check — reject if plans exist
    if (!latestCheck && session.governancePlans.size > 0) {
      return {
        errors: [{
          code: 'GOVERNANCE_DENIED',
          message: `governance_context "${govCtx}" does not match any governance check. Call check_governance first.`,
        }] as TaskError[],
      };
    }
  } else if (session.governancePlans.size > 0) {
    // No governance_context provided but plans exist — compute budget and check
    const buyBudget = req.total_budget?.amount
      ?? (req.packages?.reduce((sum, pkg) => sum + ((pkg as unknown as { budget: number }).budget || 0), 0));
    if (buyBudget !== undefined) {
      for (const plan of session.governancePlans.values()) {
        const remaining = plan.budget.total - plan.committedBudget;
        if (buyBudget > remaining) {
          const msg = `Buy budget $${buyBudget} exceeds governance plan "${plan.planId}" remaining budget $${remaining}. Call check_governance first.`;
          return {
            errors: [{
              code: 'GOVERNANCE_DENIED',
              message: msg,
              details: {
                findings: [{
                  category_id: 'budget_authority',
                  severity: 'critical',
                  explanation: msg,
                }],
                plan_id: plan.planId,
              },
            }] as TaskError[],
          };
        }
        const typeAllocation = plan.budget.allocations?.media_buy;
        if (typeAllocation?.amount !== undefined) {
          const typeCommitted = plan.committedByType?.media_buy ?? 0;
          const typeRemaining = typeAllocation.amount - typeCommitted;
          if (buyBudget > typeRemaining) {
            const msg = `Buy budget $${buyBudget} exceeds media_buy allocation $${typeRemaining} remaining in plan "${plan.planId}". Call check_governance first.`;
            return {
              errors: [{
                code: 'GOVERNANCE_DENIED',
                message: msg,
                details: {
                  findings: [{
                    category_id: 'budget_authority',
                    severity: 'critical',
                    explanation: msg,
                  }],
                  plan_id: plan.planId,
                },
              }] as TaskError[],
            };
          }
        }
      }
    }
  }

  const catalog = getCatalog();
  const productMap = new Map(catalog.map(cp => [cp.product.product_id, cp.product]));
  overlaySeededProducts(session, productMap);

  // Proposal-based creation: expand proposal allocations into packages
  if (req.proposal_id && !req.packages?.length) {
    // Check session proposals first (may have finalized versions), then global catalog
    const proposal = session.lastGetProductsContext?.proposals?.find(p => p.proposal_id === req.proposal_id)
      || getProposals().find(p => p.proposal_id === req.proposal_id);
    if (!proposal) {
      return {
        errors: [{ code: 'INVALID_REQUEST', message: `Proposal not found: ${req.proposal_id}` }] as TaskError[],
      };
    }

    // Enforce proposal lifecycle: draft proposals cannot be purchased directly
    const proposalStatus = proposalLifecycle(proposal).proposal_status;
    if (proposalStatus === 'draft') {
      return {
        errors: [{ code: 'PROPOSAL_NOT_COMMITTED', message: `Proposal "${req.proposal_id}" has draft status — finalize it first using get_products with buying_mode "refine" and action "finalize".` }] as TaskError[],
      };
    }

    // Enforce proposal expiry
    if (proposal.expires_at && new Date(proposal.expires_at) < new Date()) {
      return {
        errors: [{ code: 'PROPOSAL_EXPIRED', message: `Proposal "${req.proposal_id}" expired at ${proposal.expires_at}. Re-discover with get_products to get a fresh proposal.` }] as TaskError[],
      };
    }

    // Enforce IO acceptance when required
    const insertionOrder = proposalLifecycle(proposal).insertion_order;
    const ioAcceptance = (req as unknown as Record<string, unknown>).io_acceptance as { io_id: string; accepted_at: string; signatory: string } | undefined;
    if (insertionOrder?.requires_signature && !ioAcceptance) {
      return {
        errors: [{ code: 'IO_REQUIRED', message: `Proposal "${req.proposal_id}" requires a signed insertion order. Include io_acceptance with io_id "${insertionOrder.io_id}" on create_media_buy.` }] as TaskError[],
      };
    }
    if (ioAcceptance && insertionOrder && ioAcceptance.io_id !== insertionOrder.io_id) {
      return {
        errors: [{ code: 'INVALID_REQUEST', message: `io_acceptance.io_id "${ioAcceptance.io_id}" does not match proposal insertion order io_id "${insertionOrder.io_id}".` }] as TaskError[],
      };
    }

    const totalBudget = req.total_budget?.amount;
    if (!totalBudget) {
      return {
        errors: [{ code: 'INVALID_REQUEST', message: 'total_budget.amount is required when using proposal_id' }] as TaskError[],
      };
    }
    // Expand proposal allocations into packages
    (req as { packages?: unknown[] }).packages = proposal.allocations.map((alloc, i) => {
      const product = productMap.get(alloc.product_id);
      const pricingOptionId = alloc.pricing_option_id || product?.pricing_options[0]?.pricing_option_id || '';
      const pricing = product?.pricing_options.find(po => po.pricing_option_id === pricingOptionId);

      // Auction pricing needs a bid_price — use price_guidance p50 or floor_price
      let bidPrice: number | undefined;
      if (pricing && pricing.pricing_model !== 'cpa') {
        const po = pricing as AuctionPricingOption;
        const hasFixed = po.fixed_price !== undefined;
        if (!hasFixed) {
          bidPrice = po.price_guidance?.p50 ?? po.floor_price;
        }
      }

      return {
        product_id: alloc.product_id,
        pricing_option_id: pricingOptionId,
        budget: Math.round(totalBudget * alloc.allocation_percentage / 100),
        ...(bidPrice !== undefined && { bid_price: bidPrice }),
      };
    });
  }

  if (!req.packages?.length) {
    return {
      errors: [{ code: 'INVALID_REQUEST', message: 'packages array is required and must have at least one item' }] as TaskError[],
    };
  }

  if (req.packages.length > MAX_PACKAGES_PER_BUY) {
    return {
      errors: [{ code: 'LIMIT_EXCEEDED', message: `Too many packages: ${req.packages.length} (max ${MAX_PACKAGES_PER_BUY}).` }] as TaskError[],
    };
  }

  if (session.mediaBuys.size >= MAX_MEDIA_BUYS_PER_SESSION) {
    return {
      errors: [{ code: 'LIMIT_EXCEEDED', message: `Session limit reached (max ${MAX_MEDIA_BUYS_PER_SESSION} media buys). Start a new session.` }] as TaskError[],
    };
  }

  // Validate dates
  const buyStart = req.start_time;
  const buyEnd = req.end_time;
  if (buyStart !== 'asap' && isNaN(new Date(buyStart).getTime())) {
    return { errors: [{ code: 'INVALID_REQUEST', message: `Invalid start_time: "${buyStart}". Use ISO 8601 format or "asap".` }] as TaskError[] };
  }
  if (isNaN(new Date(buyEnd).getTime())) {
    return { errors: [{ code: 'INVALID_REQUEST', message: `Invalid end_time: "${buyEnd}". Use ISO 8601 format.` }] as TaskError[] };
  }
  if (buyStart !== 'asap' && new Date(buyStart) >= new Date(buyEnd)) {
    return { errors: [{ code: 'INVALID_REQUEST', message: 'start_time must be before end_time' }] as TaskError[] };
  }
  // NOTE: no past-start_time rejection. `schema_validation`'s
  // `temporal_validation` step asserts we reject 2020-dated starts — the
  // spec's "accept-and-adjust" branch is also conformant per the
  // storyboard's `any_of` on `past_start_handled`. Training-agent unit
  // tests (status derivation, delivery lookup, creative delivery)
  // intentionally use 2020 dates to exercise derivation logic against
  // past flights; rejecting those breaks ~6 test fixtures without a
  // clean bypass. The storyboard step closes as not-applicable for our
  // "accept-and-derive" branch; unit-test coverage is preserved.

  // Validate all packages and collect errors before returning
  const errors: TaskError[] = [];
  const createdPackages: PackageState[] = [];
  for (let i = 0; i < req.packages.length; i++) {
    const pkg = req.packages[i] as unknown as PackageInput;
    const pkgLabel = `Package ${i}`;

    // Check negative budget before product lookup (budget is always validatable)
    if (pkg.budget < 0) {
      errors.push({ code: 'BUDGET_TOO_LOW', message: `${pkgLabel}: Budget must be non-negative, got ${pkg.budget}` });
      continue;
    }

    const product = productMap.get(pkg.product_id);
    if (!product) {
      errors.push({ code: 'PRODUCT_NOT_FOUND', message: `${pkgLabel}: Product not found: ${pkg.product_id}` });
      continue;
    }

    // Enforce product expiry
    if (product.expires_at && new Date(product.expires_at) < new Date()) {
      errors.push({ code: 'PRODUCT_EXPIRED', message: `${pkgLabel}: Product "${pkg.product_id}" expired at ${product.expires_at}. Re-discover with get_products.` });
      continue;
    }

    const pricingOptions = product.pricing_options;
    const pricing = pricingOptions?.find(po => po.pricing_option_id === pkg.pricing_option_id);
    if (!pricing) {
      errors.push({
        code: 'INVALID_REQUEST',
        message: `${pkgLabel}: Pricing option not found: ${pkg.pricing_option_id}. Available: ${pricingOptions?.map(po => po.pricing_option_id).join(', ')}`,
      });
      continue;
    }

    // Reject unworkable measurement_terms (TERMS_REJECTED). Checked BEFORE
    // bid_price / other field validation so buyers see the terms-level
    // rejection first — correcting a one-sided measurement proposal is
    // typically an earlier-round concern than a missing bid_price.
    // Matches the `measurement_terms_rejected` storyboard's aggressive
    // baseline probe (max_variance_percent: 0, measurement_window: "c30").
    const terms = (pkg as unknown as { measurement_terms?: { billing_measurement?: { max_variance_percent?: number; measurement_window?: string } } }).measurement_terms;
    const bm = terms?.billing_measurement;
    if (bm) {
      if (typeof bm.max_variance_percent === 'number' && bm.max_variance_percent < 0.5) {
        errors.push({
          code: 'TERMS_REJECTED',
          message: `${pkgLabel}: measurement_terms.billing_measurement.max_variance_percent ${bm.max_variance_percent} is below our minimum of 0.5%. Third-party measurement variance can't be guaranteed tighter than 0.5%.`,
          field: `packages[${i}].measurement_terms.billing_measurement.max_variance_percent`,
          recovery: 'correctable',
        });
        continue;
      }
      if (bm.measurement_window === 'c30') {
        errors.push({
          code: 'TERMS_REJECTED',
          message: `${pkgLabel}: measurement_window "c30" is not supported. Use "c3" or "c7" for guaranteed windows.`,
          field: `packages[${i}].measurement_terms.billing_measurement.measurement_window`,
          recovery: 'correctable',
        });
        continue;
      }
    }

    // Check bid vs floor price (floor_price exists on all pricing models except CPA)
    const floorPrice = pricing.pricing_model !== 'cpa' ? pricing.floor_price : undefined;
    const isAuction = pricing.pricing_model !== 'cpa'
      && !('fixed_price' in pricing && (pricing as AuctionPricingOption).fixed_price !== undefined);

    if (isAuction && pkg.bid_price === undefined) {
      errors.push({
        code: 'INVALID_REQUEST',
        message: `${pkgLabel}: bid_price is required for auction pricing (pricing option ${pkg.pricing_option_id})`,
        field: `packages[${i}].bid_price`,
      } as TaskError);
    }

    if (floorPrice !== undefined && pkg.bid_price !== undefined && pkg.bid_price < floorPrice) {
      errors.push({
        code: 'INVALID_REQUEST',
        message: `${pkgLabel}: Bid price $${pkg.bid_price} is below floor price of $${floorPrice} for pricing option ${pkg.pricing_option_id}`,
      });
    }

    // Check min spend
    const minSpend = pricing.min_spend_per_package;
    if (minSpend && pkg.budget < minSpend) {
      errors.push({
        code: 'INVALID_REQUEST',
        message: `${pkgLabel}: Budget $${pkg.budget} is below minimum spend of $${minSpend} for pricing option ${pkg.pricing_option_id}`,
      });
    }

    const startTime = pkg.start_time || buyStart;
    const endTime = pkg.end_time || buyEnd;

    // Validate package-level dates if overridden
    if (pkg.start_time && startTime !== 'asap' && isNaN(new Date(startTime).getTime())) {
      errors.push({ code: 'INVALID_REQUEST', message: `${pkgLabel}: Invalid start_time: "${startTime}". Use ISO 8601 format or "asap".` });
    }
    if (pkg.end_time && isNaN(new Date(endTime).getTime())) {
      errors.push({ code: 'INVALID_REQUEST', message: `${pkgLabel}: Invalid end_time: "${endTime}". Use ISO 8601 format.` });
    }


    // Don't build package state if there are any validation errors (atomic create).
    // Spec field is `targeting_overlay`; `targeting` is an alias we accept for
    // backward compat with storyboards authored before the rename.
    const incomingTargeting = (pkg as unknown as { targeting_overlay?: unknown; targeting?: unknown }).targeting_overlay
      ?? pkg.targeting;
    const targetingResult = validateTargeting(incomingTargeting, `packages[${i}].targeting_overlay`);
    if (targetingResult.errors.length) {
      errors.push(...targetingResult.errors);
    }

    if (errors.length > 0) continue;

    const resolvedStart = startTime === 'asap' ? new Date().toISOString() : startTime;

    createdPackages.push({
      packageId: `pkg-${i}`,
      productId: pkg.product_id,
      budget: pkg.budget,
      pricingOptionId: pkg.pricing_option_id,
      bidPrice: pkg.bid_price,
      impressions: pkg.impressions,
      paused: pkg.paused || false,
      startTime: resolvedStart,
      endTime,
      formatIds: pkg.format_ids,
      creativeAssignments: [],
      targeting: targetingResult.targeting,
    });
  }

  if (errors.length > 0) {
    return { errors };
  }

  // Accept a buyer-supplied `media_buy_id` when present. Conformance
  // storyboards (sales_non_guaranteed, governance_delivery_monitor) hard-code
  // an id in the request and then query it on later steps; without this
  // the seller's auto-generated id wouldn't match the query.
  const requestedMediaBuyId = (req as unknown as { media_buy_id?: unknown }).media_buy_id;
  const mediaBuyId = typeof requestedMediaBuyId === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(requestedMediaBuyId)
    ? requestedMediaBuyId
    : `mb_${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const resolvedStart = buyStart === 'asap' ? now : buyStart;

  // Persist governance_context if provided (spec: sellers MUST persist and return on get_media_buys)
  const governanceContext = govCtx && govCtx.length <= 4096 ? govCtx : undefined;

  const mediaBuy: MediaBuyState = {
    mediaBuyId,
    accountRef: req.account,
    brandRef: req.brand,
    status: 'active',
    currency: 'USD',
    packages: createdPackages,
    startTime: resolvedStart,
    endTime: buyEnd,
    revision: 1,
    confirmedAt: now,
    ...(governanceContext && { governanceContext }),
    createdAt: now,
    updatedAt: now,
    history: [{ revision: 1, timestamp: now, actor: 'buyer', action: 'created', summary: `Media buy created with ${createdPackages.length} package(s)` }],
  };

  session.mediaBuys.set(mediaBuyId, mediaBuy);

  const status = deriveStatus(mediaBuy);
  return {
    media_buy_id: mediaBuyId,
    status,
    revision: mediaBuy.revision,
    confirmed_at: mediaBuy.confirmedAt,
    valid_actions: validActionsForStatus(status),
    packages: createdPackages.map(pkg => ({
      package_id: pkg.packageId,
      product_id: pkg.productId,
      budget: pkg.budget,
      pricing_option_id: pkg.pricingOptionId,
      ...(pkg.bidPrice !== undefined && { bid_price: pkg.bidPrice }),
      ...(pkg.impressions !== undefined && { impressions: pkg.impressions }),
      paused: pkg.paused,
      start_time: pkg.startTime,
      end_time: pkg.endTime,
      ...(pkg.formatIds && { format_ids: pkg.formatIds }),
      ...(pkg.targeting && { targeting_overlay: pkg.targeting }),
      creative_assignments: [],
    })),
  };
}

export async function handleGetMediaBuys(args: ToolArgs, ctx: TrainingContext) {
  const req = args as unknown as GetMediaBuysArgs;
  const session = await getSession(sessionKeyFromArgs(req, ctx.mode, ctx.userId, ctx.moduleId));
  const filterIds = req.media_buy_ids;

  let buys = Array.from(session.mediaBuys.values());
  if (filterIds?.length) {
    buys = buys.filter(b => filterIds.includes(b.mediaBuyId));
    // Media buy lookup is scoped to the caller's session (brand/account-derived).
    // Unknown IDs simply fall out of the filter — the response omits them.
  }

  // Apply status_filter (default to ['active'] when no IDs provided)
  const statusFilter = req.status_filter;
  if (!filterIds?.length) {
    const effectiveFilter = statusFilter || ['active'];
    buys = buys.filter(mb => effectiveFilter.includes(deriveStatus(mb)));
  } else if (statusFilter?.length) {
    buys = buys.filter(mb => statusFilter.includes(deriveStatus(mb)));
  }

  const includeSnapshot = req.include_snapshot === true;
  const includeHistory = Number(req.include_history) || 0;

  // Always emit a pagination block — per the cursor↔has_more invariant
  // (universal/get-media-buys-pagination-integrity, schema/core/pagination-response.json).
  // The SDK's storyboard request-builder injects `media_buy_ids: ["unknown"]`
  // whenever context.media_buy_id is empty, so a "broad list query" reaches
  // the agent as an ID-lookup. We honor the slice on broad queries (no
  // filterIds) and emit a terminal pagination block on ID lookups (where
  // pagination is semantically a no-op but a missing block is dishonest).
  // Cursor/max_results are ignored on ID-lookup paths — direct lookup wins.
  let pageBuys = buys;
  let paginationBlock: Record<string, unknown>;

  if (!filterIds?.length) {
    const requestedMax = req.pagination?.max_results;
    const maxResults = Math.min(typeof requestedMax === 'number' ? requestedMax : 50, 100);
    const offset = decodeOffsetCursor('media_buys', req.pagination?.cursor);
    if (offset === null) {
      return {
        errors: [{ code: 'INVALID_REQUEST', message: 'pagination.cursor is malformed' }] as TaskError[],
      };
    }
    const pageEnd = Math.min(offset + maxResults, buys.length);
    pageBuys = buys.slice(offset, pageEnd);
    const hasMore = pageEnd < buys.length;
    paginationBlock = {
      has_more: hasMore,
      total_count: buys.length,
      ...(hasMore && { cursor: encodeOffsetCursor('media_buys', pageEnd) }),
    };
  } else {
    // ID lookup: direct match, no pagination. Emit terminal block so the
    // wire shape is honest (`has_more: false`, no cursor).
    paginationBlock = { has_more: false, total_count: buys.length };
  }

  return {
    media_buys: pageBuys.map(mb => {
      const status = deriveStatus(mb);
      const totalBudget = mb.packages.reduce((sum, pkg) => sum + (pkg.budget || 0), 0);
      const buy = {
        media_buy_id: mb.mediaBuyId,
        status,
        revision: mb.revision,
        confirmed_at: mb.confirmedAt,
        created_at: mb.createdAt,
        updated_at: mb.updatedAt,
        valid_actions: validActionsForStatus(status),
        currency: mb.currency,
        total_budget: totalBudget,
        start_time: mb.startTime,
        end_time: mb.endTime,
        ...(mb.creativeDeadline && { creative_deadline: mb.creativeDeadline }),
        ...(mb.governanceContext && { governance_context: mb.governanceContext }),
        ...(mb.canceledAt && {
          cancellation: {
            canceled_at: mb.canceledAt,
            canceled_by: mb.canceledBy,
            reason: mb.cancellationReason,
          },
        }),
        packages: mb.packages.map(pkg => {
          const pkgData = {
            package_id: pkg.packageId,
            product_id: pkg.productId,
            budget: pkg.budget,
            pricing_option_id: pkg.pricingOptionId,
            paused: pkg.paused,
            start_time: pkg.startTime,
            end_time: pkg.endTime,
            creative_approvals: pkg.creativeAssignments.map(cid => ({
              creative_id: cid,
              approval_status: 'approved' as const,
            })),
            ...(pkg.targeting && { targeting_overlay: pkg.targeting }),
            ...(pkg.canceledAt && {
              cancellation: {
                canceled_at: pkg.canceledAt,
                canceled_by: pkg.canceledBy,
                reason: pkg.cancellationReason,
              },
            }),
            ...(includeSnapshot && { snapshot_unavailable_reason: 'SNAPSHOT_UNSUPPORTED' as const }),
          };
          return pkgData;
        }),
        ...(includeHistory > 0 && mb.history?.length && {
          history: mb.history.slice(-includeHistory).reverse().map(h => ({
          revision: h.revision,
          timestamp: h.timestamp,
          actor: h.actor,
          action: h.action,
          summary: h.summary,
          ...(h.packageId && { package_id: h.packageId }),
        })),
        }),
      };
      return buy;
    }),
    pagination: paginationBlock,
  };
}

export async function handleGetMediaBuyDelivery(args: ToolArgs, ctx: TrainingContext) {
  const req = args as unknown as GetMediaBuyDeliveryRequest & ToolArgs & { media_buy_id?: string };
  const session = await getSession(sessionKeyFromArgs(req, ctx.mode, ctx.userId, ctx.moduleId));
  const catalog = getCatalog();
  const productMap = new Map(catalog.map(cp => [cp.product.product_id, cp.product]));
  const mediaBuyId = req.media_buy_id || req.media_buy_ids?.[0] || '';
  const mb = session.mediaBuys.get(mediaBuyId);

  if (!mb) {
    return {
      errors: [{ code: 'MEDIA_BUY_NOT_FOUND', message: `Media buy not found: ${mediaBuyId}` }],
    };
  }

  const now = new Date();
  const start = new Date(mb.startTime);
  const end = new Date(mb.endTime);
  const durationMs = end.getTime() - start.getTime();
  const elapsed = durationMs > 0
    ? Math.max(0, Math.min(1, (now.getTime() - start.getTime()) / durationMs))
    : 0;

  // Build per-package metrics
  let totalImpressions = 0;
  let totalSpend = 0;
  let totalClicks = 0;
  let totalCompletedViews = 0;
  let totalViews = 0;
  let totalReach = 0;
  let totalReachUnit: string | undefined;

  const byPackage = mb.packages.map(pkg => {
    // Paused or canceled packages stop accruing delivery
    if (pkg.paused || pkg.canceled) {
      const { model, rate } = derivePricing(pkg, productMap);
      return {
        package_id: pkg.packageId,
        spend: 0,
        impressions: 0,
        clicks: 0,
        pricing_model: model,
        model, // #1525: alias for @adcp/client < 4.11.0
        rate,
        currency: mb.currency,
        paused: true,
        delivery_status: 'delivering' as const,
      };
    }

    const budget = pkg.budget;
    const spend = Math.round(budget * elapsed * 100) / 100;

    const { model: pricingModel, rate } = derivePricing(pkg, productMap);

    // Channel-appropriate CTR
    const product = productMap.get(pkg.productId);
    const channels = product?.channels;
    let ctr: number;
    if (channels?.some(c => ['social', 'influencer'].includes(c))) ctr = 0.012;
    else if (channels?.some(c => ['search'].includes(c))) ctr = 0.035;
    else if (channels?.some(c => ['retail_media'].includes(c))) ctr = 0.008;
    else if (channels?.some(c => ['ctv', 'linear_tv'].includes(c))) ctr = 0;
    else if (channels?.some(c => ['streaming_audio', 'podcast', 'radio'].includes(c))) ctr = 0.003;
    else if (channels?.some(c => ['print'].includes(c))) ctr = 0;
    else ctr = 0.001;

    const impressions = rate > 0 ? Math.round((spend / rate) * 1000) : 0;
    const clicks = Math.round(impressions * ctr);

    totalImpressions += impressions;
    totalSpend += spend;
    totalClicks += clicks;

    // Audio/video metrics — completion rates vary by channel
    // Accumulators for totals rollup are updated after audioMetrics is built
    const isAudioVideo = channels?.some(c =>
      ['streaming_audio', 'podcast', 'radio', 'ctv', 'linear_tv', 'olv'].includes(c),
    );
    let completionRate = 0.65;
    if (channels?.some(c => ['podcast'].includes(c))) completionRate = 0.87;
    else if (channels?.some(c => ['streaming_audio', 'radio'].includes(c))) completionRate = 0.72;
    else if (channels?.some(c => ['ctv', 'linear_tv'].includes(c))) completionRate = 0.82;

    const reachUnit = channels?.some(c => ['streaming_audio', 'podcast'].includes(c)) ? 'accounts' as const : 'devices' as const;
    const audioMetrics = isAudioVideo && impressions > 0
      ? {
        views: Math.round(impressions * 0.9),
        completed_views: Math.round(impressions * completionRate),
        completion_rate: completionRate,
        reach: Math.round(impressions * 0.72),
        reach_unit: reachUnit,
        frequency: +(impressions / Math.round(impressions * 0.72)).toFixed(1),
        ...(channels?.some(c => ['streaming_audio', 'podcast'].includes(c))
          ? {
            follows: Math.round(impressions * 0.002),
            conversions: Math.round(impressions * 0.006),
          }
          : {}),
      }
      : {};

    if (isAudioVideo && impressions > 0) {
      totalCompletedViews += Math.round(impressions * completionRate);
      totalViews += Math.round(impressions * 0.9);
      totalReach += Math.round(impressions * 0.72);
      if (!totalReachUnit) totalReachUnit = reachUnit;
      else if (totalReachUnit !== reachUnit) totalReachUnit = 'mixed';
    }

    return {
      package_id: pkg.packageId,
      spend,
      impressions,
      clicks,
      ...audioMetrics,
      pricing_model: pricingModel,
      model: pricingModel, // #1525: alias for @adcp/client < 4.11.0
      rate,
      currency: mb.currency,
      paused: false,
      delivery_status: elapsed >= 1 ? 'completed' as const : 'delivering' as const,
    };
  });

  // Add simulated delivery data from comply_test_controller
  const simDelivery = getDeliverySimulation(session, mb.mediaBuyId);
  if (simDelivery) {
    totalImpressions += simDelivery.impressions;
    totalClicks += simDelivery.clicks;
    totalSpend += simDelivery.reportedSpend.amount;
  }

  return {
    reporting_period: {
      start: mb.startTime,
      end: now.toISOString(),
    },
    currency: mb.currency,
    media_buy_deliveries: [{
      media_buy_id: mb.mediaBuyId,
      status: deriveStatus(mb),
      totals: {
        impressions: totalImpressions,
        spend: Math.round(totalSpend * 100) / 100,
        clicks: totalClicks,
        ...(totalCompletedViews > 0 ? {
          views: totalViews,
          completed_views: totalCompletedViews,
          completion_rate: +(totalCompletedViews / totalImpressions).toFixed(3),
        } : {}),
        ...(totalReach > 0 && totalReachUnit && totalReachUnit !== 'mixed' ? {
          reach: totalReach,
          reach_unit: totalReachUnit,
          frequency: +(totalImpressions / totalReach).toFixed(1),
        } : {}),
      },
      by_package: byPackage,
    }],
  };
}

function derivePricing(pkg: PackageState, productMap: Map<string, import('@adcp/client').Product>): { model: string; rate: number } {
  const product = productMap.get(pkg.productId);
  const pricing = product?.pricing_options.find(po => po.pricing_option_id === pkg.pricingOptionId);
  return {
    model: pricing?.pricing_model || 'cpm',
    rate: pricing?.fixed_price
      ?? (pricing && pricing.pricing_model !== 'cpa' ? pricing.floor_price : undefined)
      ?? 10,
  };
}

export async function handleSyncCreatives(args: ToolArgs, ctx: TrainingContext) {
  const req = args as unknown as SyncCreativesRequest & ToolArgs & { dry_run?: boolean };
  const session = await getSession(sessionKeyFromArgs(req, ctx.mode, ctx.userId, ctx.moduleId));
  const isDryRun = req.dry_run === true;

  if (!req.creatives?.length) {
    return {
      errors: [{ code: 'INVALID_REQUEST', message: 'creatives array is required' }] as TaskError[],
    };
  }

  if (!isDryRun && session.creatives.size + req.creatives.length > MAX_CREATIVES_PER_SESSION) {
    return {
      errors: [{ code: 'LIMIT_EXCEEDED', message: `Session limit reached (max ${MAX_CREATIVES_PER_SESSION} creatives). Start a new session.` }] as TaskError[],
    };
  }

  // Build a set of valid format IDs for validation
  const validFormatIds = new Set(getFormats().map(f => f.format_id.id));
  const ownAgentUrlCanonical = canonicalizeAgentUrl(getAgentUrl());

  const results: SyncCreativeResult[] = [];
  for (const creative of req.creatives) {
    if (!creative.creative_id) {
      return {
        errors: [{
          code: 'INVALID_REQUEST',
          message: 'creative_id is required on each creative. The buyer assigns creative IDs.',
        }],
      };
    }
    const creativeId = creative.creative_id;
    const formatId = creative.format_id as FormatID;

    // Reject clearly-malformed agent_urls before we persist them. Prevents
    // javascript:/data: or overlong URLs landing in JSONB via the pointer.
    if (formatId?.agent_url !== undefined) {
      if (typeof formatId.agent_url !== 'string' || formatId.agent_url.length === 0 || formatId.agent_url.length > MAX_URL_LEN) {
        return { errors: [{ code: 'INVALID_REQUEST', message: `format_id.agent_url: must be a non-empty string up to ${MAX_URL_LEN} chars` }] as TaskError[] };
      }
      if (!/^https?:\/\//i.test(formatId.agent_url)) {
        return { errors: [{ code: 'INVALID_REQUEST', message: 'format_id.agent_url: must use http:// or https://' }] as TaskError[] };
      }
    }

    // Validate format_id only when the format is claimed against this agent.
    // Cross-agent format references (e.g. creative.adcontextprotocol.org) are
    // resolved by the referenced creative agent at render time — the seller
    // just stores the pointer. Compare canonical forms so a trailing slash
    // or case variant of the local URL still counts as local.
    const isLocalFormat = !formatId?.agent_url
      || canonicalizeAgentUrl(formatId.agent_url) === ownAgentUrlCanonical;
    if (formatId?.id && isLocalFormat && !validFormatIds.has(formatId.id)) {
      return {
        errors: [{
          code: 'INVALID_REQUEST',
          message: `Unknown format_id "${formatId.id}". Use list_creative_formats to see available formats.`,
        }] as TaskError[],
      };
    }

    const existing = session.creatives.has(creativeId);

    if (!isDryRun) {
      session.creatives.set(creativeId, {
        creativeId,
        formatId,
        name: creative.name,
        status: 'approved',
        syncedAt: new Date().toISOString(),
        // manifest is a training-agent extension, not in SDK CreativeAsset type
        manifest: (creative as unknown as { manifest?: CreativeManifest }).manifest,
      });
    }

    results.push({
      creative_id: creativeId,
      action: existing ? 'updated' : 'created',
    });
  }

  // Process creative assignments
  const assignmentResults: AssignmentResult[] = [];
  if (req.assignments?.length && !isDryRun) {
    for (const assignment of req.assignments) {
      const mediaBuyId = (assignment as unknown as CreativeAssignmentInput).media_buy_id;
      const packageId = assignment.package_id;
      const creativeId = assignment.creative_id;

      const mb = session.mediaBuys.get(mediaBuyId);
      if (!mb) {
        assignmentResults.push({ creative_id: creativeId, package_id: packageId, status: 'error', message: `Media buy not found: ${mediaBuyId}` });
        continue;
      }
      const pkg = mb.packages.find(p => p.packageId === packageId);
      if (!pkg) {
        assignmentResults.push({ creative_id: creativeId, package_id: packageId, status: 'error', message: `Package not found: ${packageId}` });
        continue;
      }
      if (!session.creatives.has(creativeId)) {
        assignmentResults.push({ creative_id: creativeId, package_id: packageId, status: 'error', message: `Creative not found: ${creativeId}` });
        continue;
      }
      if (!pkg.creativeAssignments.includes(creativeId)) {
        pkg.creativeAssignments.push(creativeId);
      }
      assignmentResults.push({ creative_id: creativeId, package_id: packageId, status: 'assigned' });
    }
  }

  return {
    ...(isDryRun && { dry_run: true }),
    creatives: results,
    ...(assignmentResults.length > 0 && { assignments: assignmentResults }),
  };
}

export async function handleListCreatives(args: ToolArgs, ctx: TrainingContext) {
  const req = args as unknown as ListCreativesRequest & ToolArgs & { creative_ids?: string[]; include_pricing?: boolean; include_snapshot?: boolean };
  const session = await getSession(sessionKeyFromArgs(req, ctx.mode, ctx.userId, ctx.moduleId));
  const filterIds = req.creative_ids || req.filters?.creative_ids;

  let creatives = Array.from(session.creatives.values());
  if (filterIds?.length) {
    creatives = creatives.filter(c => filterIds.includes(c.creativeId));
  } else if (creatives.length === 0) {
    // Empty session falls back to compliance fixtures so storyboards that
    // reference stable IDs (e.g., campaign_hero_video in creative_ad_server)
    // resolve without the SDK's controller_seeding auto-fire. Sessions that
    // have synced their own creatives return only those — no mixing.
    creatives = getComplianceCreatives();
  }

  const totalMatching = creatives.length;
  // Schema declares max_results min=1, max=100, default=50. Honor the cap;
  // do not silently lift sub-1 values — those should surface as schema
  // violations through the SDK's request validator, not be quietly corrected.
  const requestedMax = req.pagination?.max_results;
  const maxResults = Math.min(typeof requestedMax === 'number' ? requestedMax : 50, 100);
  const offset = decodeCreativeCursor(req.pagination?.cursor);
  if (offset === null) {
    return {
      errors: [{ code: 'INVALID_REQUEST', message: 'pagination.cursor is malformed' }] as TaskError[],
    };
  }
  const pageEnd = Math.min(offset + maxResults, totalMatching);
  const pageCreatives = creatives.slice(offset, pageEnd);
  const hasMore = pageEnd < totalMatching;

  // Ad-server-capable sellers (creative.has_creative_library) quote per-
  // creative pricing whenever an account is present, independent of the
  // buyer setting include_pricing. Explicit `include_pricing: false` still
  // suppresses — matches the spec wording while letting callers that omit
  // the flag (e.g., SDK request builders that drop it) still receive pricing.
  // Spec today says "When false or omitted, pricing is not computed"; the
  // emission-on-omit behaviour here is deliberate per the has_creative_library
  // gate in #2847 and tracks the spec-side clarification referenced there.
  const emitPricing = Boolean(req.account) && req.include_pricing !== false;
  const agentUrl = getAgentUrl();

  return {
    query_summary: {
      total_matching: totalMatching,
      returned: pageCreatives.length,
    },
    pagination: {
      has_more: hasMore,
      total_count: totalMatching,
      // Cursor MUST be present iff has_more is true — see
      // static/schemas/source/core/pagination-response.json. Carrying a stale
      // cursor on a terminal page invites callers to follow it past the end
      // (caught by universal/pagination-integrity.yaml).
      ...(hasMore && { cursor: encodeCreativeCursor(pageEnd) }),
    },
    creatives: pageCreatives.map(c => {
      // Schema requires creatives[].name and creatives[].format_id.agent_url.
      // sync_creatives accepts payloads missing either (buyer may omit name,
      // SDK request builders occasionally drop agent_url), so stamp defaults
      // at emit time: creative_id stands in for name, own agent_url stands
      // in for format_id.agent_url. Keeps list_creatives response-schema
      // valid regardless of what was synced.
      const formatId = {
        ...(c.formatId ?? { id: 'unknown' }),
        agent_url: c.formatId?.agent_url ?? agentUrl,
      };
      const base: Record<string, unknown> = {
        creative_id: c.creativeId,
        format_id: formatId,
        name: c.name ?? c.creativeId,
        status: c.status,
        created_date: c.syncedAt,
        updated_date: c.syncedAt,
      };
      if (emitPricing && c.formatId?.id) {
        base.pricing_options = [getCreativePricing(req.account!, c)];
      }
      if (req.include_snapshot) {
        base.snapshot_unavailable_reason = 'SNAPSHOT_UNSUPPORTED';
      }
      return base;
    }),
  };
}

function encodeCreativeCursor(offset: number): string {
  return encodeOffsetCursor('creatives', offset);
}

function decodeCreativeCursor(cursor: string | undefined): number | null {
  return decodeOffsetCursor('creatives', cursor);
}

/** Sandbox rate card: returns CPM pricing based on account and creative format. */
function getCreativePricing(account: { account_id?: string }, creative: import('./types.js').CreativeState) {
  // Two sandbox rate cards: "premium" accounts get lower CPM
  const isPremium = account.account_id?.includes('premium');
  const isVideo = creative.formatId.id.includes('video') || creative.formatId.id.includes('vast');
  const cpm = isPremium
    ? (isVideo ? 0.25 : 0.10)
    : (isVideo ? 0.50 : 0.20);
  const pricingOptionId = `po_${creative.formatId.id}_cpm`;
  return {
    pricing_option_id: pricingOptionId,
    model: 'cpm',
    cpm,
    currency: 'USD',
  };
}

export async function handleUpdateMediaBuy(args: ToolArgs, ctx: TrainingContext) {
  const req = args as unknown as UpdateMediaBuyArgs;
  const session = await getSession(sessionKeyFromArgs(req, ctx.mode, ctx.userId, ctx.moduleId));
  const mediaBuyId = req.media_buy_id || '';
  const mb = session.mediaBuys.get(mediaBuyId);

  if (!mb) {
    return { errors: [{ code: 'MEDIA_BUY_NOT_FOUND', message: `Media buy not found: ${mediaBuyId}` }] };
  }

  // Terminal state check. Double-cancel returns NOT_CANCELLABLE —
  // media_buy_seller/invalid_transitions pins this error code explicitly.
  const currentStatus = deriveStatus(mb);
  if (['canceled', 'rejected', 'completed'].includes(currentStatus)) {
    const isRecancel = req.canceled === true && currentStatus === 'canceled';
    const code = isRecancel ? 'NOT_CANCELLABLE' : 'INVALID_STATE';
    const message = isRecancel
      ? `Media buy is already canceled and cannot be canceled again`
      : `Media buy is ${currentStatus} and cannot be updated`;
    return { errors: [{ code, message }] };
  }

  // Revision check for optimistic concurrency
  const reqRevision = req.revision;
  if (reqRevision !== undefined && reqRevision !== mb.revision) {
    return { errors: [{ code: 'CONFLICT', message: `Revision mismatch: expected ${mb.revision}, got ${reqRevision}` }] };
  }

  const now = new Date().toISOString();

  // Increment revision once before mutations
  mb.revision += 1;

  // Media buy cancellation
  const isCanceled = req.canceled === true;
  if (isCanceled) {
    if (mb.canceledAt) {
      return {
        errors: [{
          code: 'INVALID_STATE',
          message: `Media buy ${mb.mediaBuyId} is already canceled (canceled_at ${mb.canceledAt}) and cannot be canceled again.`,
        }],
      };
    }
    const reason = req.cancellation_reason;
    mb.canceledAt = now;
    mb.canceledBy = 'buyer';
    mb.cancellationReason = reason;
    mb.history.push({ revision: mb.revision, timestamp: now, actor: 'buyer', action: 'canceled', summary: reason || 'Media buy canceled by buyer' });
    mb.updatedAt = now;

    const status = deriveStatus(mb);
    return {
      media_buy_id: mb.mediaBuyId,
      status,
      revision: mb.revision,
      valid_actions: validActionsForStatus(status),
      cancellation: { canceled_at: mb.canceledAt, canceled_by: mb.canceledBy, reason: mb.cancellationReason },
    };
  }

  // Pause/resume at media buy level
  const pausedValue = req.paused;
  if (pausedValue === true) {
    mb.status = 'paused';
    mb.history.push({ revision: mb.revision, timestamp: now, actor: 'buyer', action: 'paused', summary: 'Media buy paused' });
  } else if (pausedValue === false && mb.status === 'paused') {
    mb.status = 'active';
    mb.history.push({ revision: mb.revision, timestamp: now, actor: 'buyer', action: 'resumed', summary: 'Media buy resumed' });
  }

  // Update end_time with validation
  if (req.end_time) {
    if (isNaN(new Date(req.end_time).getTime())) {
      return { errors: [{ code: 'VALIDATION_ERROR', message: `Invalid end_time: "${req.end_time}". Use ISO 8601 format.` }] };
    }
    const oldEnd = mb.endTime;
    mb.endTime = req.end_time;
    mb.history.push({ revision: mb.revision, timestamp: now, actor: 'buyer', action: 'end_time_updated', summary: `End time changed from ${oldEnd} to ${req.end_time}` });
  }

  // Update packages
  const warnings: string[] = [];
  if (req.packages?.length) {
    const knownPkgIds = new Set(mb.packages.map(p => p.packageId));

    // Pre-validate all creative_assignments across every package before
    // mutating anything, so a bad creative_id in pkg[N] doesn't leave
    // pkg[0..N-1] with partially-applied assignments.
    for (const update of req.packages as PackageUpdateExt[]) {
      const assignments = (update as PackageUpdate & { creative_assignments?: Array<{ creative_id: string }> }).creative_assignments;
      if (assignments === undefined) continue;
      const pkgId = update.package_id || '';
      for (const assignment of assignments) {
        const cid = assignment.creative_id;
        if (!cid) {
          return { errors: [{ code: 'VALIDATION_ERROR', message: `creative_assignments[].creative_id is required for package ${pkgId}`, field: `packages[${pkgId}].creative_assignments` }] };
        }
        if (!session.creatives.has(cid)) {
          return { errors: [{ code: 'CREATIVE_NOT_FOUND', message: `Creative not found: ${cid}. Sync the creative via sync_creatives before assigning.`, field: `packages[${pkgId}].creative_assignments` }] };
        }
      }
    }

    for (const update of req.packages as PackageUpdateExt[]) {
      const pkgId = update.package_id || '';
      const pkg = mb.packages.find(p => p.packageId === pkgId);
      if (!pkg) {
        return { errors: [{ code: 'PACKAGE_NOT_FOUND', message: `Package not found: ${pkgId}. Known packages: ${[...knownPkgIds].join(', ')}` }] };
      }

      // Package cancellation
      if ((update as PackageUpdateExt).canceled === true) {
        pkg.canceled = true;
        pkg.canceledAt = now;
        pkg.canceledBy = 'buyer';
        pkg.cancellationReason = (update as PackageUpdateExt).cancellation_reason;
        mb.history.push({ revision: mb.revision, timestamp: now, actor: 'buyer', action: 'package_canceled', summary: `Package ${pkgId} canceled`, packageId: pkgId });
        continue;
      }

      // Package pause/resume
      if (update.paused !== undefined && update.paused !== pkg.paused) {
        pkg.paused = update.paused;
        const action = update.paused ? 'package_paused' : 'package_resumed';
        mb.history.push({ revision: mb.revision, timestamp: now, actor: 'buyer', action, summary: `Package ${pkgId} ${update.paused ? 'paused' : 'resumed'}`, packageId: pkgId });
      }

      if (update.budget !== undefined) {
        if (update.budget < 0) {
          return { errors: [{ code: 'VALIDATION_ERROR', message: `Negative budget rejected for package ${pkgId}. Budget must be non-negative.` }] };
        }
        const oldBudget = pkg.budget;
        pkg.budget = update.budget;
        mb.history.push({ revision: mb.revision, timestamp: now, actor: 'buyer', action: 'budget_updated', summary: `Package ${pkgId} budget changed from ${oldBudget} to ${update.budget}`, packageId: pkgId });
      }

      if (update.end_time) {
        if (isNaN(new Date(update.end_time).getTime())) {
          warnings.push(`Invalid end_time for package ${pkgId}: "${update.end_time}". Skipped.`);
        } else {
          pkg.endTime = update.end_time;
        }
      }

      const updateTargeting = update.targeting_overlay ?? update.targeting;
      if (updateTargeting !== undefined) {
        const targetingResult = validateTargeting(updateTargeting, `packages[${pkgId}].targeting_overlay`);
        if (targetingResult.errors.length) {
          return { errors: targetingResult.errors };
        }
        const before = pkg.targeting;
        pkg.targeting = targetingResult.targeting;
        const changed = JSON.stringify(before ?? null) !== JSON.stringify(pkg.targeting ?? null);
        if (changed) {
          const action = pkg.targeting ? 'targeting_updated' : 'targeting_cleared';
          const summary = pkg.targeting ? `Package ${pkgId} targeting updated` : `Package ${pkgId} targeting cleared`;
          mb.history.push({ revision: mb.revision, timestamp: now, actor: 'buyer', action, summary, packageId: pkgId });
        }
      }

      // Replacement semantics: the provided array replaces pkg.creativeAssignments
      // entirely. An empty array clears assignments and may regress the buy to
      // pending_creatives. Validity of creative_ids was checked in the pre-pass.
      const creativeAssignments = (update as PackageUpdate & { creative_assignments?: Array<{ creative_id: string }> }).creative_assignments;
      if (creativeAssignments !== undefined) {
        const creativeIds = creativeAssignments.map(a => a.creative_id);
        pkg.creativeAssignments = creativeIds;
        mb.history.push({ revision: mb.revision, timestamp: now, actor: 'buyer', action: 'creative_assignments_updated', summary: `Package ${pkgId} creative assignments replaced (${creativeIds.length} creatives)`, packageId: pkgId });
      }
    }
  }

  // Add new packages
  const newPackages = req.new_packages;
  if (newPackages?.length) {
    if (mb.packages.length + newPackages.length > MAX_PACKAGES_PER_BUY) {
      return {
        errors: [{ code: 'LIMIT_EXCEEDED', message: `Adding ${newPackages.length} packages would exceed the per-buy limit of ${MAX_PACKAGES_PER_BUY}.` }] as TaskError[],
      };
    }
    const catalog = getCatalog();
    const productMap = new Map(catalog.map(cp => [cp.product.product_id, cp.product]));

    for (let i = 0; i < newPackages.length; i++) {
      const npkg = newPackages[i];
      const productId = npkg.product_id;
      const product = productMap.get(productId);
      if (!product) {
        return { errors: [{ code: 'PACKAGE_NOT_FOUND', message: `Product not found for new package: ${productId}` }] };
      }

      const pkgId = `pkg-${mb.packages.length + i}`;
      const newTargeting = npkg.targeting_overlay ?? npkg.targeting;
      const targetingResult = validateTargeting(newTargeting, `new_packages[${i}].targeting_overlay`);
      if (targetingResult.errors.length) {
        return { errors: targetingResult.errors };
      }
      const newPkg: PackageState = {
        packageId: pkgId,
        productId,
        budget: npkg.budget,
        pricingOptionId: npkg.pricing_option_id,
        bidPrice: npkg.bid_price,
        impressions: npkg.impressions,
        paused: npkg.paused || false,
        startTime: npkg.start_time || mb.startTime,
        endTime: npkg.end_time || mb.endTime,
        formatIds: npkg.format_ids,
        creativeAssignments: [],
        targeting: targetingResult.targeting,
      };
      mb.packages.push(newPkg);
      mb.history.push({ revision: mb.revision, timestamp: now, actor: 'buyer', action: 'package_added', summary: `New package ${pkgId} added (product: ${productId})`, packageId: pkgId });
    }
  }

  mb.updatedAt = now;

  const status = deriveStatus(mb);
  const result = {
    media_buy_id: mb.mediaBuyId,
    status,
    revision: mb.revision,
    valid_actions: validActionsForStatus(status),
    ...(mb.canceledAt && {
      cancellation: { canceled_at: mb.canceledAt, canceled_by: mb.canceledBy, reason: mb.cancellationReason },
    }),
    packages: mb.packages.map(pkg => ({
      package_id: pkg.packageId,
      product_id: pkg.productId,
      budget: pkg.budget,
      pricing_option_id: pkg.pricingOptionId,
      paused: pkg.paused,
      start_time: pkg.startTime,
      end_time: pkg.endTime,
      ...(pkg.targeting && { targeting_overlay: pkg.targeting }),
      ...(pkg.canceledAt && {
        cancellation: { canceled_at: pkg.canceledAt, canceled_by: pkg.canceledBy, reason: pkg.cancellationReason },
      }),
    })),
    ...(warnings.length > 0 && { warnings }),
  };
  return result;
}

export async function handleGetAdcpCapabilities(_args: ToolArgs, ctx: TrainingContext): Promise<Record<string, unknown>> {
  const tasks = TOOLS
    .map(t => t.name)
    .filter(name => name !== 'get_adcp_capabilities');
  const channels = [...new Set(PUBLISHERS.flatMap(p => p.channels))].sort();
  const publisherDomains = PUBLISHERS.map(p => p.domain);
  const signingCap = ctx.strict ? getStrictRequestSigningCapability() : getRequestSigningCapability();
  return {
    adcp: {
      major_versions: [...SUPPORTED_MAJOR_VERSIONS],
      idempotency: { supported: true, replay_ttl_seconds: 86400 },
    },
    supported_protocols: ['media_buy', 'creative', 'governance', 'signals', 'brand'],
    specialisms: ['signed-requests'],
    request_signing: {
      supported: signingCap.supported,
      covers_content_digest: signingCap.covers_content_digest,
      required_for: signingCap.required_for,
      ...(signingCap.supported_for && { supported_for: signingCap.supported_for }),
    },
    protocol_version: '3.0',
    tasks,
    media_buy: {
      features: {
        inline_creative_management: true,
        catalog_management: true,
      },
      portfolio: {
        publisher_domains: publisherDomains,
        primary_channels: channels,
      },
      content_standards: {
        supports_local_evaluation: true,
        supported_channels: channels,
        supports_webhook_delivery: false,
      },
      audience_targeting: {
        supported_identifier_types: ['hashed_email'],
        minimum_audience_size: 100,
      },
      conversion_tracking: {
        supported_event_types: ['purchase', 'add_to_cart', 'lead', 'page_view'],
        supported_hashed_identifiers: ['hashed_email'],
        supported_action_sources: ['website', 'app'],
      },
      execution: {
        targeting: {
          geo_countries: true,
          geo_regions: true,
          geo_metros: { nielsen_dma: true },
          geo_postal_areas: { us_zip: true },
          language: true,
          keyword_targets: { supported_match_types: ['broad', 'phrase', 'exact'] },
          negative_keywords: { supported_match_types: ['broad', 'phrase', 'exact'] },
        },
      },
    },
    creative: {
      supports_generation: true,
      supports_transformation: true,
      supports_compliance: false,
      has_creative_library: true,
    },
    account: {
      require_operator_auth: false,
      required_for_products: false,
      supported_billing: ['agent'],
      sandbox: true,
    },
    compliance_testing: {
      scenarios: [
        'force_creative_status',
        'force_account_status',
        'force_media_buy_status',
        'force_session_status',
        'simulate_delivery',
        'simulate_budget_spend',
      ],
    },
    agent: {
      name: 'AdCP Training Agent',
      description: 'Training agent for AdCP protocol testing and certification',
    },
  };
}

// ── Signal task handlers ──────────────────────────────────────────

const MAX_SIGNAL_RESULTS = 10;

export async function handleGetSignals(args: ToolArgs, ctx: TrainingContext) {
  const req = args as unknown as GetSignalsRequest & ToolArgs & {
    brief?: string;
    pagination?: { max_results?: number; cursor?: string };
  };
  // Accept both signal_spec (protocol) and brief (SDK test tool)
  const rawSpec = req.signal_spec || req.brief;
  const signalSpec = typeof rawSpec === 'string' ? rawSpec : undefined;
  // Pagination shape (pagination.max_results, schema cap 100) takes precedence
  // over the legacy top-level `max_results` (no schema cap; this handler
  // historically capped at 50 to keep semantic-search results focused). The two
  // forms have different caps because they have different contracts —
  // pagination.max_results is the standard envelope and matches the schema's
  // documented 100 cap; top-level max_results is the predecessor and we
  // preserve its tighter behavioral cap to avoid silently widening any caller
  // currently relying on the 50 ceiling. Spec ambiguity on which form wins
  // when both are present is tracked at adcontextprotocol/adcp#3113.
  let maxResults: number;
  const paginationMax = req.pagination?.max_results;
  if (typeof paginationMax === 'number' && paginationMax >= 1) {
    maxResults = Math.min(paginationMax, 100);
  } else if (typeof req.max_results === 'number' && req.max_results >= 1) {
    maxResults = Math.min(req.max_results, 50);
  } else {
    maxResults = MAX_SIGNAL_RESULTS;
  }
  const offset = decodeOffsetCursor('signals', req.pagination?.cursor);
  if (offset === null) {
    return {
      errors: [{ code: 'INVALID_REQUEST', message: 'pagination.cursor is malformed' }] as TaskError[],
    };
  }
  const session = await getSession(sessionKeyFromArgs(req, ctx.mode, ctx.userId, ctx.moduleId));

  const allSignals = getAllSignals();
  let results = allSignals;

  // Exact lookup by signal_ids
  if (req.signal_ids?.length) {
    const idSet = new Set(req.signal_ids.map(sid => sid.id));
    results = results.filter(s => idSet.has(s.signalAgentSegmentId));
  }

  // Natural language search via signal_spec
  const rawTerms = signalSpec ? signalSpec.toLowerCase().split(/\s+/) : [];
  if (signalSpec) {
    const expanded = new Set<string>();
    for (const t of rawTerms) {
      expanded.add(t);
      const synonyms = SYNONYM_MAP[t];
      if (synonyms) {
        for (const s of synonyms) expanded.add(s);
      }
    }
    const terms = [...expanded];
    const scored = results
      .map(s => {
        const text = `${s.name} ${s.description} ${s.tags.join(' ')} ${s.providerName}`.toLowerCase();
        const matchCount = terms.filter(t => text.includes(t)).length;
        return { signal: s, matchCount };
      })
      .filter(s => s.matchCount > 0 || req.signal_ids?.length) // keep exact matches even without keyword hit
      .sort((a, b) => b.matchCount - a.matchCount);
    results = scored.map(s => s.signal);
  }

  // Apply filters
  if (req.filters) {
    const maxCpm = (req.filters as SignalFilters & { max_cpm?: number }).max_cpm;
    if (maxCpm !== undefined) {
      results = results.filter(s =>
        s.pricingOptions.some(po => po.model === 'cpm' && po.cpm !== undefined && po.cpm <= maxCpm),
      );
    }
    if (req.filters.data_providers?.length) {
      const providerSet = new Set(req.filters.data_providers.map(d => d.toLowerCase()));
      results = results.filter(s => providerSet.has(s.providerName.toLowerCase()));
    }
    if (req.filters.catalog_types?.length) {
      const catalogTypes = req.filters.catalog_types as string[];
      results = results.filter(s => catalogTypes.includes(s.signalType));
    }
  }

  // Slice to the requested page after filters/sorts have settled. Iteration
  // order is stable across calls within a session because getAllSignals()
  // returns the static catalog and SYNONYM_MAP scoring is deterministic.
  const totalMatching = results.length;
  const pageEnd = Math.min(offset + maxResults, totalMatching);
  results = results.slice(offset, pageEnd);
  const hasMore = pageEnd < totalMatching;

  // Build the training agent URL for deployment targets
  const agentUrl = getAgentUrl();

  // Build response signals with deployments
  const signals: SignalResponse[] = results.map(s => {
    // Check if this signal has been activated in this session
    const activationKey = `${s.signalAgentSegmentId}:${agentUrl}`;
    const activation = session.signalActivations.get(activationKey);
    const isLive = activation?.isLive ?? false;

    const deployment = {
      type: 'agent' as const,
      agent_url: agentUrl,
      is_live: isLive,
      ...(isLive ? {
        activation_key: {
          type: 'key_value' as const,
          key: 'audience_segment',
          value: s.signalAgentSegmentId,
        },
        deployed_at: activation?.activatedAt,
      } : {
        estimated_activation_duration_minutes: 0, // sandbox: instant
      }),
    };

    const signal = {
      signal_agent_segment_id: s.signalAgentSegmentId,
      signal_id: {
        source: 'catalog' as const,
        data_provider_domain: s.providerDomain,
        id: s.signalAgentSegmentId,
      },
      name: s.name,
      description: s.description,
      value_type: s.valueType,
      signal_type: s.signalType,
      data_provider: s.providerName,
      coverage_percentage: s.coveragePercentage,
      deployments: [deployment],
      pricing_options: s.pricingOptions.map(po => ({
        pricing_option_id: po.pricingOptionId,
        model: po.model,
        currency: po.currency,
        ...(po.model === 'cpm' && { cpm: po.cpm }),
        ...(po.model === 'percent_of_media' && {
          percent: po.percent,
          ...(po.maxCpm !== undefined && { max_cpm: po.maxCpm }),
        }),
        ...(po.model === 'flat_fee' && { amount: po.amount, period: po.period }),
      })),
      ...(s.valueType === 'categorical' && s.categories ? { categories: s.categories } : {}),
      ...(s.valueType === 'numeric' && s.range ? { range: s.range } : {}),
    };

    return signal;
  });

  // Scope boundary note for identity resolution queries
  const identityTerms = ['identity', 'resolution', 'matching', 'graph', 'credit'];
  const hasIdentityTerm = rawTerms.some(t => identityTerms.includes(t));
  const response: {
    signals: SignalResponse[];
    pagination: { has_more: boolean; total_count: number; cursor?: string };
    note?: string;
  } = {
    signals,
    pagination: {
      has_more: hasMore,
      total_count: totalMatching,
      // Cursor MUST be present iff has_more is true — see
      // static/schemas/source/core/pagination-response.json. universal/
      // pagination-integrity catches stale tokens on terminal pages.
      ...(hasMore && { cursor: encodeOffsetCursor('signals', pageEnd) }),
    },
  };
  if (hasIdentityTerm) {
    const isCreditQuery = rawTerms.includes('credit');
    response.note = isCreditQuery
      ? 'AdCP signals support credit-derived audience segments (credit activity, income tiers) but not raw credit scores, FICO data, or credit risk models. Signals represent targeting segments, not underlying financial data. Credit-derived signals may carry additional regulatory obligations (FCRA).'
      : 'AdCP signals support identity-derived attributes (age, income, life stage) but not identity resolution itself. Identity graphs, match rates, and cross-publisher deduplication are outside the current protocol scope.';
  }
  return response;
}

export async function handleActivateSignal(args: ToolArgs, ctx: TrainingContext) {
  const req = args as unknown as ActivateSignalRequest & ToolArgs & {
    signal_id?: string;
    destination?: { type?: string; platform?: string; account?: string; account_id?: string; agent_url?: string };
  };
  // Accept both signal_agent_segment_id (protocol) and signal_id (SDK test tool)
  const segmentId = req.signal_agent_segment_id || req.signal_id || '';
  const action = req.action || 'activate';
  // Accept both destinations (array, protocol) and destination (singular, SDK test tool)
  let destinations: Destination[] = req.destinations || [];
  if (!destinations.length && req.destination) {
    const dest = req.destination;
    // SDK sends platform + account_id; normalize to protocol format
    if (dest.agent_url) {
      destinations = [{ type: 'agent', agent_url: dest.agent_url, account: dest.account || dest.account_id }];
    } else {
      destinations = [{ type: 'platform', platform: dest.platform || '', account: dest.account || dest.account_id }];
    }
  }
  const pricingOptionId = req.pricing_option_id;
  const rawGovCtx = (req as unknown as Record<string, unknown>).governance_context;
  const governanceContext = typeof rawGovCtx === 'string' && rawGovCtx.length <= 4096 ? rawGovCtx : undefined;
  const session = await getSession(sessionKeyFromArgs(req, ctx.mode, ctx.userId, ctx.moduleId));

  if (!segmentId) {
    return { errors: [{ code: 'INVALID_REQUEST', message: 'signal_agent_segment_id is required' }] };
  }
  if (!destinations?.length) {
    return { errors: [{ code: 'INVALID_REQUEST', message: 'destinations array is required' }] };
  }

  // Find the signal in our catalog
  const allSignals = getAllSignals();
  const signal = allSignals.find(s => s.signalAgentSegmentId === segmentId);
  if (!signal) {
    return {
      errors: [{
        code: 'SIGNAL_AGENT_SEGMENT_NOT_FOUND',
        message: `Signal not found: ${segmentId}. Use get_signals to discover available signals.`,
      }],
    };
  }

  // Validate pricing option if provided
  if (pricingOptionId) {
    const validPricing = signal.pricingOptions.find(po => po.pricingOptionId === pricingOptionId);
    if (!validPricing) {
      return {
        errors: [{
          code: 'INVALID_PRICING_MODEL',
          message: `Pricing option not found: ${pricingOptionId}. Available: ${signal.pricingOptions.map(po => po.pricingOptionId).join(', ')}`,
        }],
      };
    }
  }

  const agentUrl = getAgentUrl();
  const now = new Date().toISOString();

  const destId = (dest: Destination): string =>
    dest.type === 'agent' ? dest.agent_url : dest.platform || agentUrl;

  if (action === 'deactivate') {
    // Remove activations for this signal
    for (const dest of destinations) {
      const activationKey = `${segmentId}:${destId(dest)}`;
      session.signalActivations.delete(activationKey);
    }

    return {
      deployments: destinations.map(dest => ({
        type: dest.type,
        is_live: false,
        deployed_at: now,
        ...(dest.type === 'agent' ? { agent_url: dest.agent_url } : { platform: dest.platform }),
        ...(dest.account ? { account: dest.account } : {}),
      })),
      };
  }

  // Activate: store activation state and return deployment info
  const deployments = destinations.map(dest => {
    const id = destId(dest);
    const activationKey = `${segmentId}:${id}`;

    const activationState: SignalActivationState = {
      signalAgentSegmentId: segmentId,
      destinationType: dest.type,
      destinationId: id,
      account: dest.account,
      pricingOptionId,
      governanceContext,
      isLive: true,
      activatedAt: now,
    };
    session.signalActivations.set(activationKey, activationState);

    return {
      type: dest.type,
      is_live: true,
      activation_key: {
        type: 'key_value' as const,
        key: 'audience_segment',
        value: segmentId,
      },
      deployed_at: now,
      ...(dest.type === 'agent' ? { agent_url: dest.agent_url } : { platform: dest.platform }),
      ...(dest.account ? { account: dest.account } : {}),
    };
  });

  return {
    deployments,
    ...(governanceContext && { governance_context: governanceContext }),
  };
}

export async function handleGetCreativeDelivery(args: ToolArgs, ctx: TrainingContext) {
  const req = args as unknown as GetCreativeDeliveryRequest & ToolArgs;
  const session = await getSession(sessionKeyFromArgs(req, ctx.mode, ctx.userId, ctx.moduleId));
  const agentUrl = getAgentUrl();

  // Resolve media buy IDs from multiple input formats
  const mediaBuyIds = req.media_buy_ids;
  const creativeIds = req.creative_ids;
  const maxVariants = req.max_variants || 10;

  if (!mediaBuyIds?.length && !creativeIds?.length) {
    return {
      errors: [{ code: 'INVALID_REQUEST', message: 'At least one of media_buy_ids or creative_ids is required.' }],
    };
  }

  // Find matching media buys
  const matchingBuys: MediaBuyState[] = [];
  for (const mb of session.mediaBuys.values()) {
    if (mediaBuyIds?.includes(mb.mediaBuyId)) matchingBuys.push(mb);
  }

  // Collect assigned creatives from matching buys, tracking which buy each belongs to
  const relevantCreativeIds = new Set<string>();
  const creativeToBuy = new Map<string, string>();
  if (creativeIds?.length) {
    creativeIds.forEach(id => relevantCreativeIds.add(id));
  }
  for (const mb of matchingBuys) {
    for (const pkg of mb.packages) {
      pkg.creativeAssignments.forEach(id => {
        relevantCreativeIds.add(id);
        creativeToBuy.set(id, mb.mediaBuyId);
      });
    }
  }

  if (relevantCreativeIds.size === 0) {
    return {
      reporting_period: {
        start: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
        end: new Date().toISOString(),
        timezone: 'America/New_York',
      },
      currency: 'USD',
      creatives: [],
      };
  }

  const now = new Date();
  const creatives: CreativeDeliveryEntry[] = [];

  for (const cid of relevantCreativeIds) {
    const creative = session.creatives.get(cid);
    if (!creative) continue;

    // Generate deterministic variant-level delivery based on creative ID
    const variantCount = Math.min(maxVariants, 3);
    const idHash = Array.from(cid).reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
    const totalImpressions = 50000 + Math.abs(idHash % 100000);
    const totalSpend = Math.round(totalImpressions * 0.05 * 100) / 100;
    const totalClicks = Math.round(totalImpressions * 0.03);
    const variants: CreativeVariant[] = [];

    const topics = ['technology', 'lifestyle', 'finance', 'health', 'sports'];
    const devices = ['mobile', 'desktop', 'tablet'];

    for (let i = 0; i < variantCount; i++) {
      const share = i === 0 ? 0.5 : (0.5 / (variantCount - 1));
      const vImpressions = Math.round(totalImpressions * share);
      const vSpend = Math.round(totalSpend * share * 100) / 100;
      const vClicks = Math.round(totalClicks * share);

      variants.push({
        variant_id: `gen_${cid}_${i}`,
        generation_context: {
          context_type: 'web_page',
          topic: topics[i % topics.length],
          device_class: devices[i % devices.length],
        },
        manifest: {
          format_id: creative.formatId || { agent_url: agentUrl, id: 'display_300x250' },
          assets: {
            headline: { asset_type: 'text', content: `Generated variant ${i + 1} for ${creative.name || cid}` },
            hero_image: { asset_type: 'image', url: `https://cdn.example.com/generated/${cid}_v${i}.jpg`, width: 300, height: 250 },
          },
        },
        impressions: vImpressions,
        spend: vSpend,
        clicks: vClicks,
        ctr: vImpressions > 0 ? Math.round((vClicks / vImpressions) * 10000) / 10000 : 0,
      });
    }

    creatives.push({
      creative_id: cid,
      media_buy_id: creativeToBuy.get(cid) || matchingBuys[0]?.mediaBuyId,
      format_id: creative.formatId,
      totals: {
        impressions: totalImpressions,
        spend: totalSpend,
        clicks: totalClicks,
        ctr: totalImpressions > 0 ? Math.round((totalClicks / totalImpressions) * 10000) / 10000 : 0,
      },
      variant_count: variantCount,
      variants,
    });
  }

  return {
    reporting_period: {
      start: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      end: now.toISOString(),
      timezone: 'America/New_York',
    },
    currency: 'USD',
    creatives,
  };
}

// ── Build creative handler ──────────────────────────────────────

interface BuildCreativeArgs {
  account?: unknown;
  creative_id?: string;
  creative_manifest?: { format_id?: FormatID; assets?: Record<string, unknown> | Array<Record<string, unknown>> };
  target_format_id?: FormatID;
  target_format_ids?: FormatID[];
  brand?: { domain?: string };
  media_buy_id?: string;
  package_id?: string;
  quality?: 'draft' | 'production';
  message?: string;
}

function getDimensions(format: { renders: Array<Record<string, unknown>> } | undefined): { w: number; h: number } {
  const dims = format?.renders?.[0]?.dimensions as { width?: number; height?: number } | undefined;
  return { w: dims?.width || 300, h: dims?.height || 250 };
}

function buildHtmlAssets(html: string): AdcpCreativeManifest['assets'] {
  // HTMLAsset in @adcp/client ≥5.10 has `asset_type: 'html'` as a required
  // discriminator. Without it the union resolves ambiguously to MarkdownAsset
  // and tsc fails build.
  return { serving_tag: { asset_type: 'html', content: html } };
}

export async function handleBuildCreative(args: ToolArgs, ctx: TrainingContext): Promise<BuildCreativeResponse & { pricing_option_id?: string; vendor_cost?: number; currency?: string; consumption?: Record<string, unknown>; governance_context?: string }> {
  const req = args as unknown as BuildCreativeArgs;
  const session = await getSession(sessionKeyFromArgs(req as unknown as ToolArgs, ctx.mode, ctx.userId, ctx.moduleId));
  const agentUrl = getAgentUrl();
  const formats = getFormats();
  const rawGovCtx = (req as unknown as Record<string, unknown>).governance_context;
  const governanceContext = typeof rawGovCtx === 'string' && rawGovCtx.length <= 4096 ? rawGovCtx : undefined;
  const validFormatIds = new Map(formats.map(f => [f.format_id.id, f]));

  // Determine target formats (cap at 50 to prevent response amplification)
  const MAX_TARGET_FORMATS = 50;
  const targetIds: FormatID[] = req.target_format_ids?.length
    ? req.target_format_ids.slice(0, MAX_TARGET_FORMATS)
    : req.target_format_id
      ? [req.target_format_id]
      : [];

  // Mode 1: Library retrieval (creative_id)
  if (req.creative_id) {
    const creative = session.creatives.get(req.creative_id) ?? getComplianceCreative(req.creative_id);
    if (!creative) {
      return {
        errors: [{ code: 'NOT_FOUND', message: `Creative "${req.creative_id}" not found. Use sync_creatives to upload or list_creatives to browse.` }],
      };
    }

    const formatId = targetIds[0] || creative.formatId;
    const format = validFormatIds.get(formatId.id);
    const { w, h } = getDimensions(format);

    const base = {
      creative_manifest: {
        format_id: { agent_url: agentUrl, id: formatId.id },
        assets: buildHtmlAssets(`<!-- AdCP Training Agent tag for ${escapeHtmlAttr(req.creative_id!)} -->\n<div data-adcp-creative="${escapeHtmlAttr(req.creative_id!)}" data-format="${escapeHtmlAttr(formatId.id)}"${req.media_buy_id ? ` data-media-buy="${escapeHtmlAttr(req.media_buy_id)}"` : ''}${req.package_id ? ` data-package="${escapeHtmlAttr(req.package_id)}"` : ''} style="width:${w}px;height:${h}px;background:#f0f0f0;display:flex;align-items:center;justify-content:center;font-family:sans-serif;font-size:14px;color:#666;">Ad: ${escapeHtmlAttr(creative.name || req.creative_id!)}</div>`),
      },
      };

    // Return pricing when account is provided (paid creative agent mode)
    if (req.account) {
      const pricing = getCreativePricing(req.account, creative);
      creative.pricingOptionId = pricing.pricing_option_id;
      return {
        ...base,
        pricing_option_id: pricing.pricing_option_id,
        vendor_cost: 0, // CPM-priced: cost accrues at serve time
        currency: pricing.currency,
        consumption: {},
        ...(governanceContext && { governance_context: governanceContext }),
      };
    }

    return { ...base, ...(governanceContext && { governance_context: governanceContext }) };
  }

  // Mode 2: Stateless transformation (creative_manifest + target_format_id)
  if (req.creative_manifest) {
    const rawAssets = req.creative_manifest.assets;
    const inputAssetCount = Array.isArray(rawAssets) ? rawAssets.length : Object.keys(rawAssets || {}).length;

    if (targetIds.length === 0) {
      // Use the manifest's own format_id if no target specified
      const fmtId = req.creative_manifest.format_id;
      if (fmtId) targetIds.push(fmtId);
    }

    // Generate output for each target format
    if (targetIds.length > 1) {
      // Multi-format response
      const creative_manifests = targetIds.map(fmtId => {
        const format = validFormatIds.get(fmtId.id);
        const { w, h } = getDimensions(format);
        return {
          format_id: { agent_url: agentUrl, id: fmtId.id },
          assets: buildHtmlAssets(`<!-- AdCP Training Agent tag -->\n<div data-adcp-format="${escapeHtmlAttr(fmtId.id)}" style="width:${w}px;height:${h}px;background:linear-gradient(135deg,#1B5E20,#FF6F00);display:flex;align-items:center;justify-content:center;font-family:sans-serif;font-size:12px;color:#fff;border-radius:4px;">Built: ${escapeHtmlAttr(fmtId.id)} (${w}x${h})</div>`),
        };
      });

      return { creative_manifests, ...(governanceContext && { governance_context: governanceContext }) };
    }

    // Single format response
    const fmtId = targetIds[0] || { agent_url: agentUrl, id: 'display_300x250' };
    const format = validFormatIds.get(fmtId.id);
    const { w, h } = getDimensions(format);

    return {
      creative_manifest: {
        format_id: { agent_url: agentUrl, id: fmtId.id },
        assets: buildHtmlAssets(`<!-- AdCP Training Agent tag -->\n<div data-adcp-format="${escapeHtmlAttr(fmtId.id)}" data-input-assets="${inputAssetCount}" style="width:${w}px;height:${h}px;background:linear-gradient(135deg,#1B5E20,#FF6F00);display:flex;align-items:center;justify-content:center;font-family:sans-serif;font-size:12px;color:#fff;border-radius:4px;">Built: ${escapeHtmlAttr(fmtId.id)} (${w}x${h})</div>`),
      },
      ...(governanceContext && { governance_context: governanceContext }),
      };
  }

  // Mode 3: Generative build (target_format_id + message, no manifest or library creative)
  if (targetIds.length > 0) {
    if (targetIds.length > 1) {
      const creative_manifests = targetIds.map(fmtId => {
        const format = validFormatIds.get(fmtId.id);
        const { w, h } = getDimensions(format);
        return {
          format_id: { agent_url: agentUrl, id: fmtId.id },
          assets: buildHtmlAssets(`<!-- AdCP Training Agent generated -->\n<div data-adcp-format="${escapeHtmlAttr(fmtId.id)}" style="width:${w}px;height:${h}px;background:linear-gradient(135deg,#047857,#0d9488);display:flex;align-items:center;justify-content:center;font-family:sans-serif;font-size:12px;color:#fff;border-radius:4px;">Generated: ${escapeHtmlAttr(fmtId.id)} (${w}x${h})</div>`),
        };
      });
      return { creative_manifests, ...(governanceContext && { governance_context: governanceContext }) };
    }

    const fmtId = targetIds[0];
    const format = validFormatIds.get(fmtId.id);
    const { w, h } = getDimensions(format);

    return {
      creative_manifest: {
        format_id: { agent_url: agentUrl, id: fmtId.id },
        assets: buildHtmlAssets(`<!-- AdCP Training Agent generated -->\n<div data-adcp-format="${escapeHtmlAttr(fmtId.id)}" style="width:${w}px;height:${h}px;background:linear-gradient(135deg,#047857,#0d9488);display:flex;align-items:center;justify-content:center;font-family:sans-serif;font-size:12px;color:#fff;border-radius:4px;">Generated: ${escapeHtmlAttr(fmtId.id)} (${w}x${h})</div>`),
      },
      ...(governanceContext && { governance_context: governanceContext }),
      };
  }

  return {
    errors: [{ code: 'INVALID_REQUEST', message: 'Provide creative_id (library mode), creative_manifest (transformation mode), or target_format_id (generative mode).' }],
  };
}

// ── Preview creative handler ────────────────────────────────────

interface PreviewCreativeArgs {
  account?: unknown;
  request_type: 'single' | 'batch' | 'variant';
  creative_manifest?: { format_id?: FormatID; creative_id?: string; assets?: Record<string, unknown> };
  creative_id?: string;
  requests?: Array<{ format_id?: FormatID; creative_id?: string; assets?: Record<string, unknown> }>;
  variant_id?: string;
  output_format?: 'url' | 'html' | 'both';
  quality?: 'draft' | 'production';
  template_id?: string;
  item_limit?: number;
}

export async function handlePreviewCreative(args: ToolArgs, ctx: TrainingContext) {
  const req = args as unknown as PreviewCreativeArgs;
  const session = await getSession(sessionKeyFromArgs(req as unknown as ToolArgs, ctx.mode, ctx.userId, ctx.moduleId));
  const agentUrl = getAgentUrl();
  const formats = getFormats();
  const validFormatIds = new Map(formats.map(f => [f.format_id.id, f]));
  const outputFormat = req.output_format || 'url';
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  function buildPreview(manifest: { format_id?: FormatID; creative_id?: string; assets?: Record<string, unknown> }) {
    // Resolve format
    let formatId = manifest.format_id;
    let creativeName = 'Preview';

    // If creative_id provided, look up from library
    if (manifest.creative_id) {
      const creative = session.creatives.get(manifest.creative_id);
      if (creative) {
        formatId = creative.formatId;
        creativeName = creative.name || manifest.creative_id;
      }
    }

    const fmtId = formatId?.id || 'display_300x250';
    const format = validFormatIds.get(fmtId);
    if (!format && formatId?.id) {
      return null; // Signal invalid format to caller
    }
    const { w, h } = getDimensions(format);

    const previewHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Preview: ${escapeHtmlAttr(fmtId)}</title><style>body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#fafafa;font-family:sans-serif;}</style></head><body><div style="width:${w}px;height:${h}px;background:linear-gradient(135deg,#1B5E20,#FF6F00);display:flex;flex-direction:column;align-items:center;justify-content:center;border-radius:8px;color:#fff;"><div style="font-size:16px;font-weight:600;">${escapeHtmlAttr(creativeName)}</div><div style="font-size:12px;opacity:0.8;margin-top:4px;">${escapeHtmlAttr(fmtId)} (${w}x${h})</div><div style="font-size:10px;opacity:0.6;margin-top:8px;">AdCP Training Agent Preview</div></div></body></html>`;

    const render: Record<string, unknown> = {
      render_id: `preview_${fmtId}`,
      output_format: outputFormat,
      role: 'primary',
      dimensions: { width: w, height: h },
    };

    if (outputFormat === 'url' || outputFormat === 'both') {
      render.preview_url = `data:text/html;base64,${Buffer.from(previewHtml).toString('base64')}`;
    }
    if (outputFormat === 'html' || outputFormat === 'both') {
      render.preview_html = previewHtml;
    }

    return {
      preview_id: `preview_${fmtId}`,
      renders: [render],
      input: { name: creativeName },
    };
  }

  // Variant mode
  if (req.request_type === 'variant') {
    if (!req.variant_id) {
      return { errors: [{ code: 'INVALID_REQUEST', message: 'variant_id is required for variant mode.' }] };
    }
    return { errors: [{ code: 'NOT_SUPPORTED', message: 'Variant replay is not supported by the training agent. Use single or batch mode.' }] };
  }

  // Batch mode
  if (req.request_type === 'batch' && req.requests?.length) {
    return {
      response_type: 'batch',
      results: req.requests.map(c => ({
        success: true,
        creative_id: c.creative_id || 'unknown',
        response: {
          previews: [buildPreview(c)],
          expires_at: expiresAt,
        },
      })),
      };
  }

  // Single mode
  const manifest = req.creative_manifest || (req.creative_id ? { creative_id: req.creative_id } : null);
  if (!manifest) {
    return {
      errors: [{ code: 'INVALID_REQUEST', message: 'Provide creative_manifest (with inline assets) or creative_id (from library).' }],
    };
  }

  const preview = buildPreview(manifest);
  if (!preview) {
    const fmtId = manifest.format_id?.id || 'unknown';
    return {
      errors: [{ code: 'INVALID_FORMAT', message: `Format "${fmtId}" is not supported. Use list_creative_formats to discover available formats.` }],
    };
  }

  return {
    response_type: 'single',
    previews: [preview],
    expires_at: expiresAt,
  };
}

// ── report_usage handler ──────────────────────────────────────────

interface ReportUsageArgs extends ToolArgs {
  idempotency_key?: string;
  reporting_period: { start: string; end: string };
  usage: Array<{
    account: { account_id?: string; brand?: { domain: string }; operator?: string };
    creative_id?: string;
    signal_agent_segment_id?: string;
    pricing_option_id?: string;
    impressions?: number;
    media_spend?: number;
    vendor_cost: number;
    currency: string;
  }>;
}

export async function handleReportUsage(args: ToolArgs, ctx: TrainingContext) {
  const req = args as unknown as ReportUsageArgs;
  const session = await getSession(sessionKeyFromArgs(req, ctx.mode, ctx.userId, ctx.moduleId));

  if (!req.reporting_period || !req.usage?.length) {
    return { errors: [{ code: 'INVALID_USAGE_DATA', message: 'reporting_period and at least one usage record are required.' }] };
  }

  if (session.usageRecords.length + req.usage.length > MAX_USAGE_RECORDS_PER_SESSION) {
    return { errors: [{ code: 'LIMIT_EXCEEDED', message: `Usage record limit (${MAX_USAGE_RECORDS_PER_SESSION}) would be exceeded.` }] };
  }

  let accepted = 0;
  const errors: Array<{ code: string; message: string; field?: string }> = [];

  for (let i = 0; i < req.usage.length; i++) {
    const record = req.usage[i];

    // Validate required fields
    if (record.vendor_cost === undefined || record.vendor_cost === null) {
      errors.push({ code: 'INVALID_USAGE_DATA', message: 'vendor_cost is required.', field: `usage[${i}].vendor_cost` });
      continue;
    }
    if (record.vendor_cost < 0) {
      errors.push({ code: 'INVALID_USAGE_DATA', message: 'vendor_cost must be non-negative.', field: `usage[${i}].vendor_cost` });
      continue;
    }
    if (!record.currency) {
      errors.push({ code: 'INVALID_USAGE_DATA', message: 'currency is required.', field: `usage[${i}].currency` });
      continue;
    }
    if (!record.account) {
      errors.push({ code: 'INVALID_USAGE_DATA', message: 'account is required.', field: `usage[${i}].account` });
      continue;
    }
    if (record.impressions !== undefined && record.impressions < 0) {
      errors.push({ code: 'INVALID_USAGE_DATA', message: 'impressions must be non-negative.', field: `usage[${i}].impressions` });
      continue;
    }

    // Validate creative_id exists if provided
    if (record.creative_id) {
      const creative = session.creatives.get(record.creative_id) ?? getComplianceCreative(record.creative_id);
      if (!creative) {
        errors.push({ code: 'NOT_FOUND', message: `Creative "${record.creative_id}" not found in session.`, field: `usage[${i}].creative_id` });
        continue;
      }

      // Validate pricing_option_id matches if provided
      if (record.pricing_option_id && creative.pricingOptionId && record.pricing_option_id !== creative.pricingOptionId) {
        errors.push({
          code: 'INVALID_PRICING_OPTION',
          message: `pricing_option_id mismatch: expected ${creative.pricingOptionId}, received ${record.pricing_option_id}`,
          field: `usage[${i}].pricing_option_id`,
        });
        continue;
      }
    }

    // Validate signal_agent_segment_id exists if provided
    if (record.signal_agent_segment_id) {
      const activation = session.signalActivations.get(record.signal_agent_segment_id);
      if (!activation) {
        errors.push({ code: 'NOT_FOUND', message: `Signal "${record.signal_agent_segment_id}" not found in session. Use activate_signal first.`, field: `usage[${i}].signal_agent_segment_id` });
        continue;
      }
    }

    // Store the usage record
    session.usageRecords.push({
      account: record.account as import('./types.js').AccountRef,
      creativeId: record.creative_id,
      signalAgentSegmentId: record.signal_agent_segment_id,
      pricingOptionId: record.pricing_option_id,
      impressions: record.impressions,
      mediaSpend: record.media_spend,
      vendorCost: record.vendor_cost,
      currency: record.currency,
      reportedAt: new Date().toISOString(),
    });
    accepted++;
  }

  // Use 'rejected' instead of 'errors' for partial acceptance to avoid
  // the MCP server's error detection wrapping the response as an error.
  // When all records are rejected (accepted === 0), return as errors for
  // proper error signaling.
  if (accepted === 0 && errors.length) {
    return { accepted: 0, errors };
  }
  const result: Record<string, unknown> = { accepted };
  if (errors.length) result.rejected = errors;
  return result;
}

// ── Handler dispatch ──────────────────────────────────────────────

type ToolHandler = (args: ToolArgs, ctx: TrainingContext) => object | Promise<object>;

const HANDLER_MAP: Record<string, ToolHandler> = {
  get_products: handleGetProducts,
  list_creative_formats: handleListCreativeFormats,
  create_media_buy: handleCreateMediaBuy,
  get_media_buys: handleGetMediaBuys,
  get_media_buy_delivery: handleGetMediaBuyDelivery,
  get_creative_delivery: handleGetCreativeDelivery,
  sync_creatives: handleSyncCreatives,
  list_creatives: handleListCreatives,
  build_creative: handleBuildCreative,
  preview_creative: handlePreviewCreative,
  update_media_buy: handleUpdateMediaBuy,
  get_signals: handleGetSignals,
  activate_signal: handleActivateSignal,
  list_accounts: handleListAccounts,
  sync_accounts: handleSyncAccounts,
  sync_governance: handleSyncGovernance,
  sync_catalogs: handleSyncCatalogs,
  sync_event_sources: handleSyncEventSources,
  log_event: handleLogEvent,
  provide_performance_feedback: handleProvidePerformanceFeedback,
  sync_plans: handleSyncPlans,
  check_governance: handleCheckGovernance,
  report_plan_outcome: handleReportPlanOutcome,
  get_plan_audit_logs: handleGetPlanAuditLogs,
  get_brand_identity: handleGetBrandIdentity,
  get_rights: handleGetRights,
  acquire_rights: handleAcquireRights,
  update_rights: handleUpdateRights,
  creative_approval: handleCreativeApproval,
  create_property_list: handleCreatePropertyList,
  list_property_lists: handleListPropertyLists,
  get_property_list: handleGetPropertyList,
  update_property_list: handleUpdatePropertyList,
  delete_property_list: handleDeletePropertyList,
  validate_property_delivery: handleValidatePropertyDelivery,
  create_collection_list: handleCreateCollectionList,
  get_collection_list: handleGetCollectionList,
  update_collection_list: handleUpdateCollectionList,
  list_collection_lists: handleListCollectionLists,
  delete_collection_list: handleDeleteCollectionList,
  create_content_standards: handleCreateContentStandards,
  list_content_standards: handleListContentStandards,
  get_content_standards: handleGetContentStandards,
  update_content_standards: handleUpdateContentStandards,
  calibrate_content: handleCalibrateContent,
  validate_content_delivery: handleValidateContentDelivery,
  get_adcp_capabilities: handleGetAdcpCapabilities,
  report_usage: handleReportUsage,
  comply_test_controller: handleComplyTestController,
};

/**
 * Execute a training agent tool in-process (no HTTP round-trip).
 * Used by Addie's adcp-tools during certification demos.
 */
export async function executeTrainingAgentTool(
  toolName: string,
  args: ToolArgs,
  ctx: TrainingContext,
): Promise<{ success: boolean; data?: object; error?: string }> {
  const handler = HANDLER_MAP[toolName];
  if (!handler) {
    return { success: false, error: `Unknown tool: ${toolName}` };
  }
  try {
    const result = await Promise.resolve(handler(args, ctx));
    return { success: true, data: result };
  } catch (error) {
    logger.error({ error, tool: toolName }, 'Training agent in-process tool error');
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

// ── MCP Server factory ────────────────────────────────────────────

/**
 * Create a per-request MCP Server with training agent tools.
 */
export function createTrainingAgentServer(ctx: TrainingContext): Server {
  const taskStore = getTaskStore();
  const server = new Server(
    { name: 'adcp-training-agent', version: '1.0.0' },
    {
      capabilities: {
        tools: {},
        tasks: {
          list: {},
          cancel: {},
          requests: { tools: { call: {} } },
        },
      },
      taskStore,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    // Wrap handler execution + task storage in a per-request session context so
    // getSession() calls cache within the request and real mutations are flushed
    // at the end (solves cross-Fly-machine persistence). Flush only on clean
    // return from the handler — if the handler threw, discard any in-progress
    // session state rather than persisting half-mutated data.
    return runWithSessionContext(async () => {
      const { result, flushable } = await dispatchCallTool(request, extra);
      if (flushable) await flushDirtySessions();
      return result;
    });
  });

  async function dispatchCallTool(
    request: { params: { name: string; arguments?: unknown; task?: { ttl?: number } } },
    _extra: unknown,
  ): Promise<{ result: object; flushable: boolean }> {
    const { name, arguments: args } = request.params;

    // Extract and strip context before passing args to handlers (AdCP requirement:
    // echo caller's context object back unchanged in every response).
    const rawArgs = (args as Record<string, unknown> | undefined) ?? {};
    const { context: callerContext, ...handlerArgs } = rawArgs;

    const handler = HANDLER_MAP[name];

    if (!handler) {
      // Pre-handler validation failures don't touch session state, so flushing
      // is a no-op; leaving flushable=true keeps behaviour consistent for
      // requests whose handlers DO legitimately mutate before failing.
      return { result: adcpError('INVALID_REQUEST', { message: `Unknown tool: ${name}` }, callerContext), flushable: true };
    }

    const requestedVersion = (handlerArgs as { adcp_major_version?: unknown }).adcp_major_version;
    if (
      requestedVersion !== undefined
      && !(SUPPORTED_MAJOR_VERSIONS as readonly number[]).includes(requestedVersion as number)
    ) {
      return {
        result: adcpError('VERSION_UNSUPPORTED', {
          message: `AdCP major version ${String(requestedVersion)} is not supported`,
          details: { supported_major_versions: SUPPORTED_MAJOR_VERSIONS },
          field: 'adcp_major_version',
        }, callerContext),
        flushable: true,
      };
    }

    // Check for task-augmented request (explicit `task` field in params).
    // Dry-run requests always return synchronously — there's no reason to
    // async a dry-run operation, and clients expect immediate results.
    const taskField = (request.params as { task?: { ttl?: number } }).task;
    const isDryRun = rawArgs.dry_run === true;
    const isTaskRequest = taskField !== undefined && !isDryRun;
    if (isTaskRequest && !toolSupportsTask(name)) {
      throw new Error(`Tool "${name}" does not support task augmentation`);
    }

    // Idempotency enforcement for mutating tools (#2315, #2346).
    // Key presence + format are schema-level requirements; we check them
    // before the handler so a malformed key never touches the cache
    // (prevents key-format-accepting cache misses from leaking timing).
    const authPrincipal = ctx.principal ?? 'anonymous';
    // Partition the idempotency cache by caller-stated account scope so the
    // shared public sandbox token doesn't pool every buyer into one oracle
    // (security.mdx §"three-state response"). An attacker on the same auth
    // principal using a different account ref can still cross-probe, but
    // callers can already enumerate their own account's keys — so the
    // scoping adds no useful probing surface while closing the cross-caller
    // leak.
    const accountScope = deriveAccountScope(handlerArgs);
    const idempotencyPrincipal = scopedPrincipal(authPrincipal, accountScope);
    const idempotencyKey = (handlerArgs as { idempotency_key?: unknown }).idempotency_key;
    let toolResult: CallToolResult | null = null;
    let taskFailed = false;
    let handlerThrew = false;
    let cachableResponse: Record<string, unknown> | null = null;
    let skipHandler = false;
    let idempotencyPayloadHash: string | undefined;
    let idempotencyClaimed = false;

    if (isMutatingTool(name)) {
      if (idempotencyKey === undefined || idempotencyKey === null) {
        return {
          result: adcpError('INVALID_REQUEST', {
            message: `idempotency_key is required for ${name}. Generate a UUID v4 and include it on every mutating request; reuse the same key for network retries.`,
            field: 'idempotency_key',
            recovery: 'correctable',
          }, callerContext),
          flushable: true,
        };
      }
      if (!validateKeyFormat(idempotencyKey)) {
        return {
          result: adcpError('INVALID_REQUEST', {
            message: 'idempotency_key must match ^[A-Za-z0-9_.:-]{16,255}$ (UUID v4 recommended).',
            field: 'idempotency_key',
            recovery: 'correctable',
          }, callerContext),
          flushable: true,
        };
      }
      const store = getIdempotencyStore();
      const outcome = await store.check({
        principal: idempotencyPrincipal,
        key: idempotencyKey,
        payload: handlerArgs,
      });
      if (outcome.kind === 'expired') {
        return {
          result: adcpError('IDEMPOTENCY_EXPIRED', {
            message: 'idempotency_key is past the replay window. Generate a fresh UUID v4 and resend.',
            recovery: 'correctable',
          }, callerContext),
          flushable: true,
        };
      }
      if (outcome.kind === 'conflict') {
        // Error body carries code + message only — no `field` json-pointer,
        // no cached payload, no hash, no `recovery` hint. Any shape hint
        // turns key-reuse into a read oracle (security.mdx §IDEMPOTENCY_CONFLICT
        // response shape). The universal idempotency storyboard's
        // `idempotency.conflict_no_payload_leak` cross-step assertion
        // enforces the allowlist on this specific error's envelope.
        return {
          result: adcpError('IDEMPOTENCY_CONFLICT', {
            message: 'idempotency_key was used with a different payload within the replay window. Either resend the exact original payload (to return the cached response) or generate a fresh UUID v4 to submit this new payload.',
          }, callerContext),
          flushable: true,
        };
      }
      if (outcome.kind === 'in-flight') {
        // A parallel request with the same key is executing. Retries should
        // back off and see 'replay' once the in-flight handler saves. Return
        // a transient error so the caller retries after a brief delay.
        return {
          result: adcpError('RATE_LIMITED', {
            message: 'A concurrent request with this idempotency_key is already in progress. Retry after a short delay.',
            recovery: 'transient',
          }, callerContext),
          flushable: true,
        };
      }
      if (outcome.kind === 'replay') {
        // Cached inner response; envelope fields (`replayed`, `context`) are
        // produced fresh on every response per security.mdx. Replayed
        // responses bypass the handler entirely — no mutations, no flush.
        const body: Record<string, unknown> = { ...(outcome.response as Record<string, unknown>), replayed: true };
        if (callerContext !== undefined) body.context = callerContext;
        toolResult = {
          content: [{ type: 'text', text: JSON.stringify(body) }],
          structuredContent: body,
        };
        skipHandler = true;
      } else {
        // 'miss' → the store reserved the claim via putIfAbsent. We must
        // call save() on success or release() on any other path so the
        // placeholder doesn't leak.
        idempotencyPayloadHash = outcome.payloadHash;
        idempotencyClaimed = true;
      }
    }

    // Execute the tool handler. Structured AdCP errors (handler returns
    // { errors: [...] }) are well-formed responses — the task completes
    // successfully with an adcp_error envelope. Only thrown exceptions
    // mark the task as failed.
    if (skipHandler) {
      // toolResult already set from idempotency replay path above
    } else try {
      const result = await Promise.resolve(handler((handlerArgs as ToolArgs) || {}, ctx));
      const resultObj = result as { errors?: Array<{ code: string; message: string; field?: string; details?: unknown; recovery?: string }> };
      const hasErrors = resultObj.errors && resultObj.errors.length > 0;
      if (hasErrors) {
        // Error-in-body responses are errors from the buyer's POV — do NOT
        // cache (security.mdx rule 3). cachableResponse stays null so the
        // post-dispatch gate below never inserts this into the replay cache.
        const firstError = resultObj.errors![0];
        if (ERROR_IN_BODY_TOOLS.has(name)) {
          const body: Record<string, unknown> = { errors: resultObj.errors };
          if (callerContext !== undefined) body.context = callerContext;
          toolResult = {
            content: [{ type: 'text', text: JSON.stringify(body) }],
            structuredContent: body,
          };
        } else {
          toolResult = adcpError(firstError.code, {
            message: firstError.message,
            ...(firstError.field && { field: firstError.field }),
            ...(firstError.recovery && { recovery: firstError.recovery }),
            details: firstError.details !== undefined
              ? firstError.details
              : resultObj.errors!.length > 1
                ? { all_errors: resultObj.errors }
                : undefined,
          }, callerContext);
        }
      } else {
        // Inner response (what gets cached for replay). Per security.mdx:
        // "replayed: false" MAY be omitted on fresh executions and buyers
        // MUST treat omission as false. We emit it explicitly only on
        // create_media_buy because the universal idempotency storyboard's
        // `field_value allowed_values:[false]` check fails on omitted
        // fields — scoping to this tool keeps the signal without tripping
        // strict per-task response schemas on other tools (several SDK
        // schemas are not passthrough and reject the extra key).
        const inner = result as Record<string, unknown>;
        cachableResponse = inner;
        const envelope: Record<string, unknown> = {};
        if (name === 'create_media_buy') envelope.replayed = false;
        if (callerContext !== undefined) envelope.context = callerContext;
        const response = { ...inner, ...envelope };
        // `structuredContent` is authoritative on success so raw-probe
        // callers (storyboard runner's rawMcpProbe) can validate envelope
        // fields. `content` stays empty: the SDK unwrapper folds text
        // content into `_message` on the returned object, which trips
        // strict `additionalProperties: false` per-task response schemas.
        toolResult = {
          content: [],
          structuredContent: response,
        };
      }
    } catch (error) {
      logger.error({ error, tool: name }, 'Training agent tool error');
      taskFailed = true;
      handlerThrew = true;
      toolResult = adcpError('SERVICE_UNAVAILABLE', {
        message: error instanceof Error ? error.message : 'Unknown error',
        recovery: 'transient',
      }, callerContext);
    }

    // TypeScript: by this point toolResult is guaranteed set — either the
    // handler branch wrote it or the replay short-circuit did.
    if (!toolResult) {
      throw new Error('Internal error: toolResult missing after dispatch');
    }

    // Resolve the in-flight claim from check(). Cache only successful inner
    // responses (security.mdx rule 2+3); errors, structured { errors: [...] }
    // bodies, and exceptions all release the claim so a retry re-executes.
    if (idempotencyClaimed && typeof idempotencyKey === 'string') {
      const store = getIdempotencyStore();
      const shouldSave =
        cachableResponse !== null
        && !toolResult.isError
        && !handlerThrew;
      if (shouldSave && idempotencyPayloadHash) {
        await store.save({
          principal: idempotencyPrincipal,
          key: idempotencyKey,
          payloadHash: idempotencyPayloadHash,
          response: cachableResponse,
        });
      } else {
        await store.release({
          principal: idempotencyPrincipal,
          key: idempotencyKey,
        });
      }
    }

    // Fire completion webhook if the buyer supplied a push URL and the tool
    // mapped to a TaskType. Emission is fire-and-forget so the sync response
    // doesn't wait on the receiver; retries/backoff live inside the emitter.
    if (
      cachableResponse !== null
      && !toolResult.isError
      && !handlerThrew
    ) {
      maybeEmitCompletionWebhook({
        toolName: name,
        args: handlerArgs,
        response: cachableResponse,
        requestIdempotencyKey: typeof idempotencyKey === 'string' ? idempotencyKey : undefined,
      });
    }

    // If not task-augmented, return result directly.
    // flushable=!handlerThrew: if the handler threw, discard in-progress session
    // state. Structured { errors: [...] } responses still flush — they are
    // well-formed outcomes that legitimately mutate state.
    if (!isTaskRequest) {
      return { result: toolResult, flushable: !handlerThrew };
    }

    // Training agent tasks resolve immediately, so moderate TTLs suffice.
    // 15 minutes gives developers time to inspect tasks while debugging.
    // With the rate limiter (300 req/min) this caps live tasks at ~4,500.
    const MAX_TASK_TTL = 15 * 60 * 1000;      // 15 minutes
    const DEFAULT_TASK_TTL = 15 * 60 * 1000;  // 15 minutes
    const clampedTtl = Math.min(taskField?.ttl ?? DEFAULT_TASK_TTL, MAX_TASK_TTL);

    // Task-augmented: use the raw module-level task store directly.
    // The SDK's extra.taskStore wrapper sends notifications/tasks/status
    // after storing results, which fails in stateless HTTP mode (each
    // request uses a fresh transport). Using the raw store avoids this
    // while keeping tasks visible to subsequent tasks/get requests.
    const terminalStatus: 'completed' | 'failed' = taskFailed ? 'failed' : 'completed';
    const created = await taskStore.createTask(
      { ttl: clampedTtl },
      0,
      request as unknown as { method: string; params?: { _meta?: Record<string, unknown> } },
    );
    await taskStore.storeTaskResult(created.taskId, terminalStatus, toolResult);
    const task = await taskStore.getTask(created.taskId);
    if (!task) {
      throw new Error(`Task disappeared after creation for tool "${name}"`);
    }
    const errorCode = toolResult.isError
      ? (toolResult.structuredContent as { adcp_error?: { code?: string } } | undefined)?.adcp_error?.code
      : undefined;
    logger.info(
      { taskId: task.taskId, tool: name, status: terminalStatus, isError: !!toolResult.isError, ...(errorCode && { errorCode }) },
      'Created MCP task',
    );

    return { result: { task } as object, flushable: !handlerThrew };
  }

  // tasks/get, tasks/result, tasks/list, tasks/cancel are auto-registered
  // by the SDK when taskStore is provided to the Server constructor.

  return server;
}
