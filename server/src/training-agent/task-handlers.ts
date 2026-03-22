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
import { createLogger } from '../logger.js';
import type {
  Product,
  FormatID,
  Format,
  GetProductsRequest,
  CreateMediaBuyRequest,
  UpdateMediaBuyRequest,
  SyncCreativesRequest,
  GetMediaBuyDeliveryRequest,
  GetSignalsRequest,
  ActivateSignalRequest,
  ListCreativeFormatsRequest,
  ListCreativesRequest,
  GetAdCPCapabilitiesRequest,
  GetMediaBuysRequest,
  GetCreativeDeliveryRequest,
} from '@adcp/client';
import type { TrainingContext, CatalogProduct, MediaBuyState, PackageState, SignalActivationState, AccountRef, BrandRef } from './types.js';
import { buildCatalog } from './product-factory.js';
import { buildFormats, FORMAT_CHANNEL_MAP } from './formats.js';
import { getAllSignals, SIGNAL_PROVIDERS } from './signal-providers.js';
import { getSession, sessionKeyFromArgs, MAX_MEDIA_BUYS_PER_SESSION, MAX_CREATIVES_PER_SESSION } from './state.js';
import { getAgentUrl } from './config.js';
import {
  GOVERNANCE_TOOLS,
  handleSyncPlans,
  handleCheckGovernance,
  handleReportPlanOutcome,
  handleGetPlanAuditLogs,
} from './governance-handlers.js';
import { PUBLISHERS } from './publishers.js';

/** Wire-format error shared by all training agent responses. */
interface TaskError {
  code: string;
  message: string;
  field?: string;
  suggestion?: string;
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
  buyer_ref: string;
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
  manifest: { format_id: FormatID; assets: Record<string, unknown> };
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
function deriveStatus(mb: MediaBuyState): string {
  // Terminal states — no transitions out
  if (mb.status === 'canceled' || mb.status === 'rejected' || mb.status === 'completed') {
    return mb.status;
  }
  const now = new Date();
  if (mb.status === 'active') {
    if (new Date(mb.endTime) < now) return 'completed';
    if (new Date(mb.startTime) > now) return 'pending_activation';
  }
  return mb.status;
}

function validActionsForStatus(status: string): string[] {
  switch (status) {
    case 'pending_activation': return ['cancel', 'sync_creatives'];
    case 'active': return ['pause', 'cancel', 'update_budget', 'update_dates', 'update_packages', 'sync_creatives'];
    case 'paused': return ['resume', 'cancel', 'update_budget', 'update_dates', 'update_packages', 'sync_creatives'];
    default: return [];
  }
}

// ── Cached catalog and formats (built once at first use) ──────────
let cachedCatalog: CatalogProduct[] | null = null;
let cachedFormats: Partial<Format>[] | null = null;

function getCatalog(): CatalogProduct[] {
  if (!cachedCatalog) cachedCatalog = buildCatalog();
  return cachedCatalog;
}

function getFormats(): Partial<Format>[] {
  if (!cachedFormats) {
    cachedFormats = buildFormats(getAgentUrl()) as Partial<Format>[];
  }
  return cachedFormats;
}

/** Invalidate cached catalog/formats (for tests or hot-reload) */
export function invalidateCache(): void {
  cachedCatalog = null;
  cachedFormats = null;
}

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

// ── Tool definitions ──────────────────────────────────────────────

const TOOLS = [
  {
    name: 'get_products',
    description: 'Discover available advertising products. Supports brief (curated discovery), wholesale (raw catalog), and refine (iterate on previous results) buying modes. Use this before create_media_buy to find valid product_id and pricing_option_id values. Not for checking delivery or managing existing buys. Returns sandbox catalog data.',
    annotations: { readOnlyHint: true, idempotentHint: true },
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
        buyer_campaign_ref: { type: 'string' },
      },
      required: ['buying_mode'],
    },
  },
  {
    name: 'list_creative_formats',
    description: 'List supported creative formats with asset requirements, dimensions, and rendering specifications. Filter by channels to see formats relevant to specific media types. Not for uploading creatives (use sync_creatives) or checking creative status.',
    annotations: { readOnlyHint: true, idempotentHint: true },
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
    inputSchema: {
      type: 'object' as const,
      properties: {
        buyer_ref: { type: 'string' },
        buyer_campaign_ref: { type: 'string' },
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
              buyer_ref: { type: 'string' },
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
      },
      required: ['buyer_ref', 'account', 'brand', 'start_time', 'end_time'],
    },
  },
  {
    name: 'get_media_buys',
    description: 'List media buys for the current session/account. Returns buy configuration and status only — not delivery metrics (use get_media_buy_delivery for that). Only returns buys created in the current session; buys from other sessions are not visible.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object' as const,
      properties: {
        account: ACCOUNT_REF_SCHEMA,
        media_buy_ids: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'get_media_buy_delivery',
    description: 'Get delivery metrics for a media buy including impressions, spend, and clicks by package. Requires a media_buy_id from create_media_buy. Returns simulated metrics proportional to elapsed flight time. Not for creating or updating buys.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object' as const,
      properties: {
        account: ACCOUNT_REF_SCHEMA,
        media_buy_id: { type: 'string' },
        buyer_ref: { type: 'string' },
      },
      required: ['media_buy_id'] as const,
    },
  },
  {
    name: 'sync_creatives',
    description: 'Upload or update creative assets and optionally assign them to packages. Validates format_id against list_creative_formats. Not for listing existing creatives (use list_creatives). Creative content is not validated — only format_id is checked.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: 'object' as const,
      properties: {
        account: ACCOUNT_REF_SCHEMA,
        creatives: { type: 'array' },
        assignments: { type: 'array' },
      },
      required: ['account', 'creatives'],
    },
  },
  {
    name: 'list_creatives',
    description: 'List creative assets for the current session. Filter by creative_ids or media_buy_id to narrow results. Not for uploading or updating creatives (use sync_creatives). Only returns creatives from the current session.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object' as const,
      properties: {
        account: ACCOUNT_REF_SCHEMA,
        creative_ids: { type: 'array', items: { type: 'string' } },
        media_buy_id: { type: 'string' },
      },
    },
  },
  {
    name: 'get_creative_delivery',
    description: 'Get variant-level creative delivery data including what was generated, manifests, and per-variant metrics. Call this to see what creatives were actually served and how each variant performed. Requires at least one of media_buy_ids, media_buy_buyer_refs, or creative_ids.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object' as const,
      properties: {
        account: ACCOUNT_REF_SCHEMA,
        media_buy_ids: { type: 'array', items: { type: 'string' } },
        media_buy_buyer_refs: { type: 'array', items: { type: 'string' } },
        creative_ids: { type: 'array', items: { type: 'string' } },
        max_variants: { type: 'number' },
      },
    },
  },
  {
    name: 'update_media_buy',
    description: 'Update an existing media buy. Supports pause/resume, cancellation (media buy or individual packages), budget, end_time, and optimistic concurrency via revision. Cannot add new packages or change product_id/pricing_option_id.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: 'object' as const,
      properties: {
        account: ACCOUNT_REF_SCHEMA,
        media_buy_id: { type: 'string' },
        buyer_ref: { type: 'string' },
        revision: { type: 'integer', description: 'Expected revision for optimistic concurrency. Seller rejects with CONFLICT on mismatch.' },
        paused: { type: 'boolean', description: 'Pause (true) or resume (false) the entire media buy' },
        canceled: { type: 'boolean', description: 'Cancel the entire media buy (irreversible, must be true)' },
        cancellation_reason: { type: 'string', description: 'Reason for cancellation' },
        packages: { type: 'array' },
        end_time: { type: 'string' },
      },
      required: ['media_buy_id'] as const,
    },
  },
  {
    name: 'get_signals',
    description: 'Discover signals matching campaign criteria. Supports natural language discovery via signal_spec or exact lookup via signal_ids. Returns signals with deployment status, pricing, and activation keys. Use this to find targetable audiences, contextual categories, geographic regions, and other data attributes.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object' as const,
      properties: {
        signal_spec: { type: 'string', description: 'Natural language description of desired signals' },
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
    inputSchema: {
      type: 'object' as const,
      properties: {
        signal_agent_segment_id: { type: 'string' },
        action: { type: 'string', enum: ['activate', 'deactivate'] },
        destinations: { type: 'array', items: { type: 'object' } },
        pricing_option_id: { type: 'string' },
        account: ACCOUNT_REF_SCHEMA,
      },
      required: ['signal_agent_segment_id', 'destinations'] as const,
    },
  },
  ...GOVERNANCE_TOOLS,
  {
    name: 'get_adcp_capabilities',
    description: 'Discover the capabilities of this AdCP agent — supported tasks, features, and protocol version. Call once per session; capabilities are static.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
];

// ── Task handler implementations ──────────────────────────────────

function handleGetProducts(args: Record<string, unknown>, ctx: TrainingContext): { products: Partial<Product>[]; sandbox: boolean } {
  const request = args as unknown as Partial<GetProductsRequest>;
  const buyingMode = args.buying_mode as string || 'brief';
  const brief = args.brief as string | undefined;
  const filters = args.filters as { channels?: string[]; delivery_type?: string } | undefined;
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));

  let products: Partial<Product>[] = getCatalog().map(cp => ({ ...cp.product }));

  // Apply filters
  if (filters) {
    const channelFilter = filters.channels;
    if (channelFilter?.length) {
      products = products.filter(p => {
        return p.channels?.some(c => channelFilter.includes(c));
      });
    }
    const deliveryTypeFilter = filters.delivery_type;
    if (deliveryTypeFilter) {
      products = products.filter(p => p.delivery_type === deliveryTypeFilter);
    }
  }

  // Brief mode: keyword matching
  if (buyingMode === 'brief' && brief) {
    const terms = brief.toLowerCase().split(/\s+/);
    const scored = products
      .map(p => {
        const text = `${p.name} ${p.description} ${p.channels?.join(' ')}`.toLowerCase();
        const matchCount = terms.filter(t => text.includes(t)).length;
        return matchCount > 0 ? { product: p, matchCount } : null;
      })
      .filter((s): s is NonNullable<typeof s> => s !== null)
      .sort((a, b) => b.matchCount - a.matchCount);

    // Cap at top 5 most relevant products so learners see brief mode as curated discovery
    const MAX_BRIEF_RESULTS = 5;
    products = scored.slice(0, MAX_BRIEF_RESULTS).map(s => ({
      ...s.product,
      brief_relevance: `Matches ${s.matchCount} of ${terms.length} brief terms. ${s.product.description}`,
    }));

    // If no keyword matches, return top products as suggestions
    if (products.length === 0) {
      products = getCatalog().slice(0, MAX_BRIEF_RESULTS).map(cp => ({
        ...cp.product,
        brief_relevance: 'Suggested product — no direct keyword match with your brief.',
      }));
    }
  }

  // Refine mode: apply include/omit/more_like_this
  if (buyingMode === 'refine' && args.refine) {
    const refineOps = args.refine as Array<{ scope?: string; action?: string; id?: string }>;
    const previousProducts = session.lastGetProductsContext?.products || products;
    const omitIds = new Set<string>();
    const includeIds = new Set<string>();

    for (const op of refineOps) {
      if (op.scope === 'product') {
        if (op.action === 'omit' && op.id) omitIds.add(op.id);
        else if (op.action === 'include' && op.id) includeIds.add(op.id);
        // more_like_this: include the product plus similar channel products
        else if (op.action === 'more_like_this' && op.id) {
          includeIds.add(op.id);
          const source = previousProducts.find(p => p.product_id === op.id);
          if (source) {
            const sourceChannels = source.channels;
            for (const p of getCatalog()) {
              if (p.product.channels?.some(c => sourceChannels?.includes(c))) {
                if (p.product.product_id) includeIds.add(p.product.product_id);
              }
            }
          }
        }
      }
    }

    // Apply includes first (expand), then omits (filter)
    if (includeIds.size > 0) {
      products = getCatalog()
        .filter(cp => cp.product.product_id && includeIds.has(cp.product.product_id))
        .map(cp => ({ ...cp.product }));
    }
    if (omitIds.size > 0) {
      products = products.filter(p => !p.product_id || !omitIds.has(p.product_id));
    }
  }

  // Store context for refine
  session.lastGetProductsContext = { products };

  return { products, sandbox: true };
}

function handleListCreativeFormats(args: Record<string, unknown>, _ctx: TrainingContext): { formats: Partial<Format>[]; sandbox: boolean } {
  const request = args as unknown as Partial<ListCreativeFormatsRequest>;
  let formats = getFormats();

  // Filter by channels
  const channels = args.channels as string[] | undefined;
  if (channels?.length) {
    const validIds = new Set<string>();
    for (const [fmtId, fmtChannels] of Object.entries(FORMAT_CHANNEL_MAP)) {
      if (fmtChannels.some(c => channels.includes(c))) {
        validIds.add(fmtId);
      }
    }
    formats = formats.filter(f => f.format_id?.id && validIds.has(f.format_id.id));
  }

  // Filter by format_ids
  const formatIdFilter = args.format_ids as Array<{ id: string }> | undefined;
  if (formatIdFilter?.length) {
    const requestedIds = new Set(formatIdFilter.map(f => f.id));
    formats = formats.filter(f => f.format_id?.id && requestedIds.has(f.format_id.id));
  }

  return { formats, sandbox: true };
}

/** Input shape for a package in create_media_buy. */
interface PackageInput {
  product_id: string;
  pricing_option_id: string;
  budget: number;
  buyer_ref?: string;
  bid_price?: number;
  impressions?: number;
  paused?: boolean;
  start_time?: string;
  end_time?: string;
  format_ids?: FormatID[];
}

function handleCreateMediaBuy(args: Record<string, unknown>, ctx: TrainingContext): { media_buy_id: string; buyer_ref: string; status: string; confirmed_at: string; creative_deadline: string; revision: number; packages: unknown[]; sandbox: boolean; buyer_campaign_ref?: string } | { errors: TaskError[] } {
  const request = args as unknown as Partial<CreateMediaBuyRequest>;
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));
  const catalog = getCatalog();
  const productMap = new Map(catalog.map(cp => [cp.product.product_id!, cp.product]));

  const buyerRef = args.buyer_ref as string;
  const packages = args.packages as PackageInput[] | undefined;

  if (!packages?.length) {
    return {
      errors: [{ code: 'validation_error', message: 'packages array is required and must have at least one item' }] as TaskError[],
    };
  }

  if (session.mediaBuys.size >= MAX_MEDIA_BUYS_PER_SESSION) {
    return {
      errors: [{ code: 'limit_exceeded', message: `Session limit reached (max ${MAX_MEDIA_BUYS_PER_SESSION} media buys). Start a new session.` }] as TaskError[],
    };
  }

  // Validate dates
  const buyStart = args.start_time as string;
  const buyEnd = args.end_time as string;
  if (buyStart !== 'asap' && isNaN(new Date(buyStart).getTime())) {
    return { errors: [{ code: 'validation_error', message: `Invalid start_time: "${buyStart}". Use ISO 8601 format or "asap".` }] as TaskError[] };
  }
  if (isNaN(new Date(buyEnd).getTime())) {
    return { errors: [{ code: 'validation_error', message: `Invalid end_time: "${buyEnd}". Use ISO 8601 format.` }] as TaskError[] };
  }
  if (buyStart !== 'asap' && new Date(buyStart) >= new Date(buyEnd)) {
    return { errors: [{ code: 'validation_error', message: 'start_time must be before end_time' }] as TaskError[] };
  }

  // Validate all packages and collect errors before returning
  const errors: TaskError[] = [];
  const createdPackages: PackageState[] = [];
  for (let i = 0; i < packages.length; i++) {
    const pkg = packages[i];
    const pkgLabel = pkg.buyer_ref ? `Package "${pkg.buyer_ref}"` : `Package ${i}`;

    const productId = pkg.product_id;
    const product = productMap.get(productId);
    if (!product) {
      errors.push({ code: 'validation_error', message: `${pkgLabel}: Product not found: ${productId}` });
      continue;
    }

    const pricingOptionId = pkg.pricing_option_id;
    const pricingOptions = product.pricing_options as Array<{ pricing_option_id: string; floor_price?: number; min_spend_per_package?: number }> | undefined;
    const pricing = pricingOptions?.find(po => po.pricing_option_id === pricingOptionId);
    if (!pricing) {
      errors.push({
        code: 'validation_error',
        message: `${pkgLabel}: Pricing option not found: ${pricingOptionId}. Available: ${pricingOptions?.map(po => po.pricing_option_id).join(', ')}`,
      });
      continue;
    }

    const budget = pkg.budget;

    // Check negative budget
    if (budget < 0) {
      errors.push({ code: 'validation_error', message: `${pkgLabel}: Budget must be non-negative, got ${budget}` });
    }

    // Check bid vs floor price
    const floorPrice = pricing.floor_price;
    const bidPrice = pkg.bid_price;
    if (floorPrice !== undefined && bidPrice !== undefined && bidPrice < floorPrice) {
      errors.push({
        code: 'validation_error',
        message: `${pkgLabel}: Bid price $${bidPrice} is below floor price of $${floorPrice} for pricing option ${pricingOptionId}`,
      });
    }

    // Check min spend
    const minSpend = pricing.min_spend_per_package;
    if (minSpend && budget < minSpend) {
      errors.push({
        code: 'validation_error',
        message: `${pkgLabel}: Budget $${budget} is below minimum spend of $${minSpend} for pricing option ${pricingOptionId}`,
      });
    }

    const startTime = (pkg.start_time || args.start_time) as string;
    const endTime = (pkg.end_time || args.end_time) as string;

    // Validate package-level dates if overridden
    if (pkg.start_time && startTime !== 'asap' && isNaN(new Date(startTime).getTime())) {
      errors.push({ code: 'validation_error', message: `${pkgLabel}: Invalid start_time: "${startTime}". Use ISO 8601 format or "asap".` });
    }
    if (pkg.end_time && isNaN(new Date(endTime).getTime())) {
      errors.push({ code: 'validation_error', message: `${pkgLabel}: Invalid end_time: "${endTime}". Use ISO 8601 format.` });
    }

    // Don't build package state if there are any validation errors (atomic create)
    if (errors.length > 0) continue;

    const resolvedStart = startTime === 'asap' ? new Date().toISOString() : startTime;

    createdPackages.push({
      packageId: `pkg_${randomUUID().slice(0, 8)}`,
      buyerRef: pkg.buyer_ref || '',
      productId,
      budget,
      pricingOptionId,
      bidPrice: pkg.bid_price,
      impressions: pkg.impressions,
      paused: pkg.paused || false,
      startTime: resolvedStart,
      endTime,
      formatIds: pkg.format_ids,
      creativeAssignments: [],
    });
  }

  if (errors.length > 0) {
    return { errors };
  }

  const mediaBuyId = `mb_${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const resolvedStart = args.start_time === 'asap' ? now : args.start_time as string;
  // Creative deadline: 7 days before end or 3 days from now, whichever is earlier
  const endDate = new Date(args.end_time as string);
  const sevenBeforeEnd = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);
  const threeDaysFromNow = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  const creativeDeadline = (sevenBeforeEnd < threeDaysFromNow ? sevenBeforeEnd : threeDaysFromNow).toISOString();

  const mediaBuy: MediaBuyState = {
    mediaBuyId,
    buyerRef,
    buyerCampaignRef: args.buyer_campaign_ref as string | undefined,
    accountRef: args.account as AccountRef,
    brandRef: args.brand as BrandRef | undefined,
    status: 'active',
    currency: 'USD',
    packages: createdPackages,
    startTime: resolvedStart,
    endTime: args.end_time as string,
    confirmedAt: now,
    revision: 1,
    creativeDeadline,
    createdAt: now,
    updatedAt: now,
  };

  session.mediaBuys.set(mediaBuyId, mediaBuy);

  return {
    media_buy_id: mediaBuyId,
    buyer_ref: buyerRef,
    buyer_campaign_ref: mediaBuy.buyerCampaignRef,
    confirmed_at: now,
    creative_deadline: creativeDeadline,
    revision: 1,
    status: deriveStatus(mediaBuy),
    packages: createdPackages.map(pkg => ({
      package_id: pkg.packageId,
      buyer_ref: pkg.buyerRef,
      product_id: pkg.productId,
      budget: pkg.budget,
      pricing_option_id: pkg.pricingOptionId,
      ...(pkg.bidPrice !== undefined && { bid_price: pkg.bidPrice }),
      ...(pkg.impressions !== undefined && { impressions: pkg.impressions }),
      paused: pkg.paused,
      start_time: pkg.startTime,
      end_time: pkg.endTime,
      ...(pkg.formatIds && { format_ids: pkg.formatIds }),
      creative_assignments: [],
    })),
    sandbox: true,
  };
}

function handleGetMediaBuys(args: Record<string, unknown>, ctx: TrainingContext): { media_buys: unknown[]; sandbox: boolean } {
  const request = args as unknown as Partial<GetMediaBuysRequest>;
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));
  const filterIds = args.media_buy_ids as string[] | undefined;

  let buys = Array.from(session.mediaBuys.values());
  if (filterIds?.length) {
    buys = buys.filter(b => filterIds.includes(b.mediaBuyId));
  }

  return {
    media_buys: buys.map(mb => {
      const status = deriveStatus(mb);
      return {
        media_buy_id: mb.mediaBuyId,
        buyer_ref: mb.buyerRef,
        buyer_campaign_ref: mb.buyerCampaignRef,
        status,
        currency: mb.currency,
        total_budget: mb.packages.reduce((sum, p) => sum + p.budget, 0),
        start_time: mb.startTime,
        end_time: mb.endTime,
        confirmed_at: mb.confirmedAt,
        revision: mb.revision,
        ...(mb.creativeDeadline && { creative_deadline: mb.creativeDeadline }),
        ...(mb.canceledAt && { canceled_at: mb.canceledAt }),
        ...(mb.canceledBy && { canceled_by: mb.canceledBy }),
        ...(mb.cancellationReason && { cancellation_reason: mb.cancellationReason }),
        valid_actions: validActionsForStatus(status),
        packages: mb.packages.map(pkg => ({
          package_id: pkg.packageId,
          buyer_ref: pkg.buyerRef,
          product_id: pkg.productId,
          budget: pkg.budget,
          pricing_option_id: pkg.pricingOptionId,
          paused: pkg.paused,
          ...(pkg.canceled && { canceled: pkg.canceled }),
          ...(pkg.canceledAt && { canceled_at: pkg.canceledAt }),
          ...(pkg.canceledBy && { canceled_by: pkg.canceledBy }),
          ...(pkg.cancellationReason && { cancellation_reason: pkg.cancellationReason }),
          ...(pkg.creativeDeadline && { creative_deadline: pkg.creativeDeadline }),
          start_time: pkg.startTime,
          end_time: pkg.endTime,
          creative_approvals: pkg.creativeAssignments.map(cid => ({
            creative_id: cid,
            approval_status: 'approved',
          })),
        })),
      };
    }),
    sandbox: true,
  };
}

function handleGetMediaBuyDelivery(args: Record<string, unknown>, ctx: TrainingContext): { reporting_period: { start: string; end: string }; currency: string; media_buy_deliveries: unknown[]; sandbox: boolean } | { errors: TaskError[] } {
  const request = args as unknown as Partial<GetMediaBuyDeliveryRequest>;
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));
  const catalog = getCatalog();
  const productMap = new Map(catalog.map(cp => [cp.product.product_id!, cp.product]));
  const mediaBuyId = (args.media_buy_id || args.buyer_ref) as string;
  const mb = session.mediaBuys.get(mediaBuyId) ||
    Array.from(session.mediaBuys.values()).find(b => b.buyerRef === mediaBuyId);

  if (!mb) {
    return {
      errors: [{ code: 'not_found', message: `Media buy not found: ${mediaBuyId}` }],
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

  const byPackage = mb.packages.map(pkg => {
    // Paused packages stop accruing delivery
    if (pkg.paused) {
      const { model, rate } = derivePricing(pkg, productMap);
      return {
        package_id: pkg.packageId,
        buyer_ref: pkg.buyerRef,
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

    return {
      package_id: pkg.packageId,
      buyer_ref: pkg.buyerRef,
      spend,
      impressions,
      clicks,
      pricing_model: pricingModel,
      model: pricingModel, // #1525: alias for @adcp/client < 4.11.0
      rate,
      currency: mb.currency,
      paused: false,
      delivery_status: elapsed >= 1 ? 'completed' as const : 'delivering' as const,
    };
  });

  return {
    reporting_period: {
      start: mb.startTime,
      end: now.toISOString(),
    },
    currency: mb.currency,
    media_buy_deliveries: [{
      media_buy_id: mb.mediaBuyId,
      buyer_ref: mb.buyerRef,
      status: deriveStatus(mb),
      totals: {
        impressions: totalImpressions,
        spend: Math.round(totalSpend * 100) / 100,
        clicks: totalClicks,
      },
      by_package: byPackage,
    }],
    sandbox: true,
  };
}

function derivePricing(pkg: PackageState, productMap: Map<string, Partial<Product>>): { model: string; rate: number } {
  const product = productMap.get(pkg.productId);
  const pricingOptions = product?.pricing_options as Array<{ pricing_option_id: string; pricing_model: string; fixed_price?: number; floor_price?: number }> | undefined;
  const pricing = pricingOptions?.find(po => po.pricing_option_id === pkg.pricingOptionId);
  return {
    model: pricing?.pricing_model || 'cpm',
    rate: pricing?.fixed_price || pricing?.floor_price || 10,
  };
}

/** Input shape for a creative in sync_creatives. */
interface CreativeInput {
  creative_id?: string;
  format_id: FormatID;
  name?: string;
  manifest?: { format_id: FormatID; assets: Record<string, unknown> };
}

function handleSyncCreatives(args: Record<string, unknown>, ctx: TrainingContext): { creatives: SyncCreativeResult[]; assignments?: AssignmentResult[]; sandbox: boolean } | { errors: TaskError[] } {
  const request = args as unknown as Partial<SyncCreativesRequest>;
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));
  const creatives = args.creatives as CreativeInput[];

  if (!creatives?.length) {
    return {
      errors: [{ code: 'validation_error', message: 'creatives array is required' }] as TaskError[],
    };
  }

  if (session.creatives.size + creatives.length > MAX_CREATIVES_PER_SESSION) {
    return {
      errors: [{ code: 'limit_exceeded', message: `Session limit reached (max ${MAX_CREATIVES_PER_SESSION} creatives). Start a new session.` }] as TaskError[],
    };
  }

  // Build a set of valid format IDs for validation
  const validFormatIds = new Set(getFormats().map(f => f.format_id?.id).filter(Boolean));

  const results: SyncCreativeResult[] = [];
  for (const creative of creatives) {
    const creativeId = creative.creative_id || `cr_${randomUUID().slice(0, 8)}`;
    const formatId = creative.format_id;

    // Validate format_id
    if (formatId?.id && !validFormatIds.has(formatId.id)) {
      return {
        errors: [{
          code: 'validation_error',
          message: `Unknown format_id "${formatId.id}". Use list_creative_formats to see available formats.`,
        }] as TaskError[],
      };
    }

    const existing = session.creatives.has(creativeId);

    session.creatives.set(creativeId, {
      creativeId,
      formatId,
      name: creative.name,
      status: 'approved',
      syncedAt: new Date().toISOString(),
      manifest: creative.manifest,
    });

    results.push({
      creative_id: creativeId,
      action: existing ? 'updated' : 'created',
    });
  }

  // Process creative assignments
  const assignments = args.assignments as Array<{ media_buy_id: string; package_id: string; creative_id: string }> | undefined;
  const assignmentResults: AssignmentResult[] = [];
  if (assignments?.length) {
    for (const assignment of assignments) {
      const mediaBuyId = assignment.media_buy_id;
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
    creatives: results,
    ...(assignmentResults.length > 0 && { assignments: assignmentResults }),
    sandbox: true,
  };
}

function handleListCreatives(args: Record<string, unknown>, ctx: TrainingContext): { creatives: unknown[]; sandbox: boolean } {
  const request = args as unknown as Partial<ListCreativesRequest>;
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));
  const filterIds = args.creative_ids as string[] | undefined;

  let creatives = Array.from(session.creatives.values());
  if (filterIds?.length) {
    creatives = creatives.filter(c => filterIds.includes(c.creativeId));
  }

  return {
    creatives: creatives.map(c => ({
      creative_id: c.creativeId,
      format_id: c.formatId,
      name: c.name,
      status: c.status,
      synced_at: c.syncedAt,
    })),
    sandbox: true,
  };
}

/** Input shape for a package update in update_media_buy. */
interface PackageUpdate {
  package_id?: string;
  buyer_ref?: string;
  budget?: number;
  paused?: boolean;
  canceled?: boolean;
  cancellation_reason?: string;
  end_time?: string;
}

function handleUpdateMediaBuy(args: Record<string, unknown>, ctx: TrainingContext): { media_buy_id: string; buyer_ref: string; revision: number; sandbox: boolean; status?: string; implementation_date?: string; affected_packages?: unknown[] } | { errors: TaskError[] } {
  const request = args as unknown as Partial<UpdateMediaBuyRequest>;
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));
  const mediaBuyId = (args.media_buy_id || args.buyer_ref) as string;
  const mb = session.mediaBuys.get(mediaBuyId) ||
    Array.from(session.mediaBuys.values()).find(b => b.buyerRef === mediaBuyId);

  if (!mb) {
    return {
      errors: [{ code: 'MEDIA_BUY_NOT_FOUND', message: `Media buy not found: ${mediaBuyId}` }],
    };
  }

  // Terminal state check
  const currentStatus = deriveStatus(mb);
  if (currentStatus === 'completed' || currentStatus === 'rejected' || currentStatus === 'canceled') {
    return {
      errors: [{ code: 'INVALID_STATE', message: `Media buy ${mb.mediaBuyId} is in terminal state '${currentStatus}' and cannot be modified` }],
    };
  }

  // Optimistic concurrency check
  const requestRevision = args.revision as number | undefined;
  if (requestRevision !== undefined && requestRevision !== mb.revision) {
    return {
      errors: [{ code: 'CONFLICT', message: `Revision mismatch: expected ${requestRevision}, current is ${mb.revision}. Re-read via get_media_buys and retry.` }],
    };
  }

  // Handle media buy cancellation — takes precedence over all other fields
  if (args.canceled === true) {
    const now = new Date().toISOString();
    mb.status = 'canceled';
    mb.canceledAt = now;
    mb.canceledBy = 'buyer';
    mb.cancellationReason = (args.cancellation_reason as string) || undefined;
    mb.revision++;
    mb.updatedAt = now;
    return {
      media_buy_id: mb.mediaBuyId,
      buyer_ref: mb.buyerRef,
      status: 'canceled' as const,
      revision: mb.revision,
      implementation_date: now,
      affected_packages: [],
      sandbox: true,
    };
  }

  // Handle pause/resume
  if (args.paused !== undefined) {
    mb.status = args.paused ? 'paused' : 'active';
  }

  // Update end_time with validation
  if (args.end_time) {
    const newEnd = args.end_time as string;
    if (isNaN(new Date(newEnd).getTime())) {
      return { errors: [{ code: 'VALIDATION_ERROR', message: `Invalid end_time: "${newEnd}". Use ISO 8601 format.` }] };
    }
    mb.endTime = newEnd;
  }

  // Update packages
  const packageUpdates = args.packages as PackageUpdate[] | undefined;
  const affectedPackages: unknown[] = [];
  if (packageUpdates?.length) {
    const knownPkgIds = new Set(mb.packages.map(p => p.packageId));
    for (const update of packageUpdates) {
      const pkgId = (update.package_id || update.buyer_ref) as string;
      const pkg = mb.packages.find(p => p.packageId === pkgId || p.buyerRef === pkgId);
      if (!pkg) {
        return { errors: [{ code: 'PACKAGE_NOT_FOUND', message: `Package not found: ${pkgId}. Known packages: ${[...knownPkgIds].join(', ')}` }] };
      }

      // Check if package is already canceled
      if (pkg.canceled) {
        return { errors: [{ code: 'INVALID_STATE', message: `Package ${pkgId} is canceled and cannot be modified` }] };
      }

      // Package cancellation takes precedence
      if (update.canceled === true) {
        const now = new Date().toISOString();
        pkg.canceled = true;
        pkg.canceledAt = now;
        pkg.canceledBy = 'buyer';
        pkg.cancellationReason = (update.cancellation_reason as string) || undefined;
        affectedPackages.push({
          package_id: pkg.packageId,
          buyer_ref: pkg.buyerRef,
          canceled: true,
          canceled_at: now,
          canceled_by: 'buyer',
          ...(pkg.cancellationReason && { cancellation_reason: pkg.cancellationReason }),
        });
        continue;
      }

      if (update.budget !== undefined) {
        if (update.budget < 0) {
          return { errors: [{ code: 'VALIDATION_ERROR', message: `Negative budget rejected for package ${pkgId}. Budget must be non-negative.` }] };
        }
        pkg.budget = update.budget;
      }
      if (update.paused !== undefined) pkg.paused = update.paused;
      if (update.end_time) {
        if (isNaN(new Date(update.end_time).getTime())) {
          return { errors: [{ code: 'VALIDATION_ERROR', message: `Invalid end_time for package ${pkgId}: "${update.end_time}".` }] };
        }
        pkg.endTime = update.end_time;
      }
      affectedPackages.push({
        package_id: pkg.packageId,
        buyer_ref: pkg.buyerRef,
        product_id: pkg.productId,
        budget: pkg.budget,
        paused: pkg.paused,
        start_time: pkg.startTime,
        end_time: pkg.endTime,
      });
    }
  }

  const now = new Date().toISOString();
  mb.revision++;
  mb.updatedAt = now;

  return {
    media_buy_id: mb.mediaBuyId,
    buyer_ref: mb.buyerRef,
    ...(args.paused !== undefined || args.canceled !== undefined ? { status: deriveStatus(mb) } : {}),
    revision: mb.revision,
    implementation_date: now,
    affected_packages: affectedPackages,
    sandbox: true,
  };
}

function handleGetAdcpCapabilities(_args: Record<string, unknown>, _ctx: TrainingContext): { adcp: { major_versions: number[] }; supported_protocols: string[]; protocol_version: string; tasks: string[]; media_buy: unknown; agent: { name: string; description: string } } {
  const tasks = TOOLS
    .map(t => t.name)
    .filter(name => name !== 'get_adcp_capabilities');
  const channels = [...new Set(PUBLISHERS.flatMap(p => p.channels))].sort();
  return {
    adcp: { major_versions: [3] },
    supported_protocols: ['media_buy', 'governance'],
    protocol_version: '3.0',
    tasks,
    media_buy: {
      features: {
        inline_creative_management: true,
      },
      portfolio: {
        channels,
      },
    },
    agent: {
      name: 'AdCP Training Agent',
      description: 'Training agent for AdCP protocol testing and certification',
    },
  };
}

// ── Signal task handlers ──────────────────────────────────────────

const MAX_SIGNAL_RESULTS = 10;

/** Filters for get_signals. */
interface SignalFilters {
  max_cpm?: number;
  data_providers?: string[];
  catalog_types?: string[];
}

function handleGetSignals(args: Record<string, unknown>, ctx: TrainingContext): { signals: SignalResponse[]; sandbox: boolean; note?: string } | { errors: TaskError[] } {
  const request = args as unknown as Partial<GetSignalsRequest>;
  // Accept both signal_spec (protocol) and brief (SDK test tool)
  const signalSpec = (args.signal_spec || args.brief) as string | undefined;
  const signalIds = args.signal_ids as Array<{ id: string }> | undefined;
  const filters = args.filters as SignalFilters | undefined;
  const maxResults = Math.min(Math.max((args.max_results as number) || MAX_SIGNAL_RESULTS, 1), 50);
  const destinations = args.destinations as Array<{ type?: string; agent_url?: string }> | undefined;
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));

  if (!signalSpec && !signalIds?.length) {
    return {
      errors: [{ code: 'validation_error', message: 'Either signal_spec or signal_ids is required' }],
    };
  }

  const allSignals = getAllSignals();
  let results = allSignals;

  // Exact lookup by signal_ids
  if (signalIds?.length) {
    const idSet = new Set(signalIds.map(sid => sid.id));
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
      .filter(s => s.matchCount > 0 || signalIds?.length) // keep exact matches even without keyword hit
      .sort((a, b) => b.matchCount - a.matchCount);
    results = scored.map(s => s.signal);
  }

  // Apply filters
  if (filters) {
    if (filters.max_cpm !== undefined) {
      const maxCpm = filters.max_cpm;
      results = results.filter(s =>
        s.pricingOptions.some(po => po.model === 'cpm' && po.cpm !== undefined && po.cpm <= maxCpm),
      );
    }
    if (filters.data_providers?.length) {
      const providerSet = new Set(filters.data_providers.map(d => d.toLowerCase()));
      results = results.filter(s => providerSet.has(s.providerName.toLowerCase()));
    }
    if (filters.catalog_types?.length) {
      const catalogTypes = filters.catalog_types;
      results = results.filter(s => catalogTypes.includes(s.signalType));
    }
  }

  // Cap results
  results = results.slice(0, maxResults);

  // Build the training agent URL for deployment targets
  const agentUrl = getAgentUrl();

  // Build response signals with deployments
  const signals: SignalResponse[] = results.map(s => {
    // Check if this signal has been activated in this session
    const activationKey = `${s.signalAgentSegmentId}:${agentUrl}`;
    const activation = session.signalActivations.get(activationKey);
    const isLive = activation?.isLive ?? false;

    const deployment: SignalDeployment = {
      type: 'agent',
      agent_url: agentUrl,
      is_live: isLive,
    };

    // Include activation key when live
    if (isLive) {
      deployment.activation_key = {
        type: 'key_value',
        key: 'audience_segment',
        value: s.signalAgentSegmentId,
      };
      deployment.deployed_at = activation?.activatedAt;
    } else {
      deployment.estimated_activation_duration_minutes = 0; // sandbox: instant
    }

    const signal: SignalResponse = {
      signal_agent_segment_id: s.signalAgentSegmentId,
      signal_id: {
        source: 'catalog',
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
      pricing_options: s.pricingOptions.map(po => {
        const option: SignalPricingOption = {
          pricing_option_id: po.pricingOptionId,
          model: po.model,
          currency: po.currency,
        };
        if (po.model === 'cpm') option.cpm = po.cpm;
        if (po.model === 'percent_of_media') {
          option.percent = po.percent;
          if (po.maxCpm !== undefined) option.max_cpm = po.maxCpm;
        }
        if (po.model === 'flat_fee') {
          option.amount = po.amount;
          option.period = po.period;
        }
        return option;
      }),
    };

    // Include value type metadata
    if (s.valueType === 'categorical' && s.categories) {
      signal.categories = s.categories;
    }
    if (s.valueType === 'numeric' && s.range) {
      signal.range = s.range;
    }

    return signal;
  });

  // Scope boundary note for identity resolution queries
  const identityTerms = ['identity', 'resolution', 'matching', 'graph', 'credit'];
  const hasIdentityTerm = rawTerms.some(t => identityTerms.includes(t));
  const response: { signals: SignalResponse[]; sandbox: boolean; note?: string } = { signals, sandbox: true };
  if (hasIdentityTerm) {
    const isCreditQuery = rawTerms.includes('credit');
    response.note = isCreditQuery
      ? 'AdCP signals support credit-derived audience segments (credit activity, income tiers) but not raw credit scores, FICO data, or credit risk models. Signals represent targeting segments, not underlying financial data. Credit-derived signals may carry additional regulatory obligations (FCRA).'
      : 'AdCP signals support identity-derived attributes (age, income, life stage) but not identity resolution itself. Identity graphs, match rates, and cross-publisher deduplication are outside the current protocol scope.';
  }
  return response;
}

/** Destination shape for activate_signal. */
interface ActivationDestination {
  type?: 'platform' | 'agent';
  platform?: string;
  account?: string;
  account_id?: string;
  agent_url?: string;
}

function handleActivateSignal(args: Record<string, unknown>, ctx: TrainingContext): { deployments: SignalDeployment[]; sandbox: boolean } | { errors: TaskError[] } {
  const request = args as unknown as Partial<ActivateSignalRequest>;
  // Accept both signal_agent_segment_id (protocol) and signal_id (SDK test tool)
  const segmentId = (args.signal_agent_segment_id || args.signal_id) as string;
  const action = (args.action as string) || 'activate';
  // Accept both destinations (array, protocol) and destination (singular, SDK test tool)
  let destinations = args.destinations as ActivationDestination[] | undefined;
  if (!destinations?.length && args.destination) {
    const dest = args.destination as ActivationDestination;
    // SDK sends platform + account_id; normalize to protocol format
    destinations = [{
      type: dest.type || 'platform',
      platform: dest.platform,
      account: dest.account || dest.account_id,
      ...(dest.agent_url ? { agent_url: dest.agent_url } : {}),
    }];
  }
  const pricingOptionId = args.pricing_option_id as string | undefined;
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));

  if (!segmentId) {
    return { errors: [{ code: 'validation_error', message: 'signal_agent_segment_id is required' }] };
  }
  if (!destinations?.length) {
    return { errors: [{ code: 'validation_error', message: 'destinations array is required' }] };
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

  if (action === 'deactivate') {
    // Remove activations for this signal
    for (const dest of destinations) {
      const destId = dest.agent_url || dest.platform || agentUrl;
      const activationKey = `${segmentId}:${destId}`;
      session.signalActivations.delete(activationKey);
    }

    return {
      deployments: destinations.map(dest => {
        const d: SignalDeployment = {
          type: (dest.type as 'agent' | 'platform') || 'agent',
          is_live: false,
          deployed_at: now,
        };
        if (dest.agent_url) d.agent_url = dest.agent_url;
        if (dest.platform) d.platform = dest.platform;
        if (dest.account) d.account = dest.account;
        return d;
      }),
      sandbox: true,
    };
  }

  // Activate: store activation state and return deployment info
  const deployments: SignalDeployment[] = destinations.map(dest => {
    const destId = dest.agent_url || dest.platform || agentUrl;
    const activationKey = `${segmentId}:${destId}`;

    const activationState: SignalActivationState = {
      signalAgentSegmentId: segmentId,
      destinationType: dest.type || 'agent',
      destinationId: destId,
      account: dest.account,
      pricingOptionId,
      isLive: true,
      activatedAt: now,
    };
    session.signalActivations.set(activationKey, activationState);

    const d: SignalDeployment = {
      type: (dest.type as 'agent' | 'platform') || 'agent',
      is_live: true,
      activation_key: {
        type: 'key_value',
        key: 'audience_segment',
        value: segmentId,
      },
      deployed_at: now,
    };
    if (dest.agent_url) d.agent_url = dest.agent_url;
    if (dest.platform) d.platform = dest.platform;
    if (dest.account) d.account = dest.account;
    return d;
  });

  return { deployments, sandbox: true };
}

function handleGetCreativeDelivery(args: Record<string, unknown>, ctx: TrainingContext): { reporting_period: { start: string; end: string; timezone: string }; currency: string; creatives: CreativeDeliveryEntry[]; sandbox: boolean } | { errors: TaskError[] } {
  const request = args as unknown as Partial<GetCreativeDeliveryRequest>;
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));
  const agentUrl = getAgentUrl();

  // Resolve media buy IDs from multiple input formats
  const mediaBuyIds = args.media_buy_ids as string[] | undefined;
  const buyerRefs = args.media_buy_buyer_refs as string[] | undefined;
  const creativeIds = args.creative_ids as string[] | undefined;
  const maxVariants = (args.max_variants as number) || 10;

  if (!mediaBuyIds?.length && !buyerRefs?.length && !creativeIds?.length) {
    return {
      errors: [{ code: 'validation_error', message: 'At least one of media_buy_ids, media_buy_buyer_refs, or creative_ids is required.' }],
    };
  }

  // Find matching media buys
  const matchingBuys: MediaBuyState[] = [];
  for (const mb of session.mediaBuys.values()) {
    if (mediaBuyIds?.includes(mb.mediaBuyId)) matchingBuys.push(mb);
    else if (buyerRefs?.includes(mb.buyerRef)) matchingBuys.push(mb);
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
      sandbox: true,
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
    sandbox: true,
  };
}

// ── Handler dispatch ──────────────────────────────────────────────

type ToolHandler = (args: Record<string, unknown>, ctx: TrainingContext) => Record<string, unknown>;

const HANDLER_MAP: Record<string, ToolHandler> = {
  get_products: handleGetProducts,
  list_creative_formats: handleListCreativeFormats,
  create_media_buy: handleCreateMediaBuy,
  get_media_buys: handleGetMediaBuys,
  get_media_buy_delivery: handleGetMediaBuyDelivery,
  get_creative_delivery: handleGetCreativeDelivery,
  sync_creatives: handleSyncCreatives,
  list_creatives: handleListCreatives,
  update_media_buy: handleUpdateMediaBuy,
  get_signals: handleGetSignals,
  activate_signal: handleActivateSignal,
  sync_plans: handleSyncPlans,
  check_governance: handleCheckGovernance,
  report_plan_outcome: handleReportPlanOutcome,
  get_plan_audit_logs: handleGetPlanAuditLogs,
  get_adcp_capabilities: handleGetAdcpCapabilities,
};

/**
 * Execute a training agent tool in-process (no HTTP round-trip).
 * Used by Addie's adcp-tools during certification demos.
 */
export function executeTrainingAgentTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: TrainingContext,
): { success: boolean; data?: Record<string, unknown>; error?: string } {
  const handler = HANDLER_MAP[toolName];
  if (!handler) {
    return { success: false, error: `Unknown tool: ${toolName}` };
  }
  try {
    const result = handler(args, ctx);
    return { success: true, data: result as Record<string, unknown> };
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
  const server = new Server(
    { name: 'adcp-training-agent', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request: { params: { name: string; arguments?: Record<string, unknown> } }) => {
    const { name, arguments: args } = request.params;
    const handler = HANDLER_MAP[name];

    if (!handler) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
        isError: true,
      };
    }

    try {
      const result = handler((args as Record<string, unknown>) || {}, ctx);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    } catch (error) {
      logger.error({ error, tool: name }, 'Training agent tool error');
      return {
        content: [{ type: 'text', text: JSON.stringify({
          error: error instanceof Error ? error.message : 'Unknown error',
        }) }],
        isError: true,
      };
    }
  });

  return server;
}
