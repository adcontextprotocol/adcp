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
import type { TrainingContext, CatalogProduct, MediaBuyState, PackageState, SignalActivationState, CreativeState } from './types.js';
import type {
  Product,
  FormatID,
  Format,
  CreateMediaBuyRequest,
  PackageRequest,
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
} from '@adcp/client';
import { adcpError } from '@adcp/client';

// Derive types from SDK request types that aren't re-exported from main entry
type PackageUpdate = NonNullable<UpdateMediaBuyRequest['packages']>[number];
type Destination = NonNullable<ActivateSignalRequest['destinations']>[number];
type SignalFilters = NonNullable<GetSignalsRequest['filters']>;
import { buildCatalog, buildShowsForProducts } from './product-factory.js';
import { buildFormats, FORMAT_CHANNEL_MAP } from './formats.js';
import { getAllSignals, SIGNAL_PROVIDERS } from './signal-providers.js';
import { getSession, getAllSessions, sessionKeyFromArgs, MAX_MEDIA_BUYS_PER_SESSION, MAX_CREATIVES_PER_SESSION } from './state.js';
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
  const now = new Date();
  if (mb.status === 'active') {
    if (new Date(mb.endTime) < now) return 'completed';
    if (new Date(mb.startTime) > now) return 'pending_activation';
  }
  return mb.status;
}

// ── Cached catalog and formats (built once at first use) ──────────
let cachedCatalog: CatalogProduct[] | null = null;
let cachedFormats: ReturnType<typeof buildFormats> | null = null;

function getCatalog(): CatalogProduct[] {
  if (!cachedCatalog) cachedCatalog = buildCatalog();
  return cachedCatalog;
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
        include_snapshot: { type: 'boolean', description: 'Include full media buy snapshot in response' },
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
        media_buy_ids: { type: 'array', items: { type: 'string' }, description: 'Plural form (SDK)' },
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
    description: 'Update an existing media buy. Supports changing package budget, paused state, and end_time. Cannot add new packages or change product_id/pricing_option_id — only update existing package fields. Not for creating new buys (use create_media_buy).',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: 'object' as const,
      properties: {
        account: ACCOUNT_REF_SCHEMA,
        media_buy_id: { type: 'string' },
        buyer_ref: { type: 'string' },
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
        account: ACCOUNT_REF_SCHEMA,
      },
      required: [] as const,
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

function handleGetProducts(args: Record<string, unknown>, ctx: TrainingContext): Record<string, unknown> {
  const req = args as unknown as GetProductsRequest;
  const buyingMode = req.buying_mode || 'brief';
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));

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

  // Brief mode: keyword matching
  if (buyingMode === 'brief' && req.brief) {
    const terms = req.brief.toLowerCase().split(/\s+/);
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
  if (buyingMode === 'refine' && req.refine) {
    const previousProducts = session.lastGetProductsContext?.products || products;
    const omitIds = new Set<string>();
    const includeIds = new Set<string>();

    for (const op of req.refine) {
      if (op.scope === 'product') {
        if (op.action === 'omit') omitIds.add(op.id);
        else if (op.action === 'include') includeIds.add(op.id);
        // more_like_this: include the product plus similar channel products
        else if (op.action === 'more_like_this') {
          includeIds.add(op.id);
          const source = previousProducts.find(p => p.product_id === op.id);
          if (source) {
            const sourceChannels = source.channels;
            for (const p of getCatalog()) {
              if (p.product.channels?.some(c => sourceChannels?.includes(c))) {
                includeIds.add(p.product.product_id);
              }
            }
          }
        }
      }
    }

    // Apply includes first (expand), then omits (filter)
    if (includeIds.size > 0) {
      products = getCatalog()
        .filter(cp => includeIds.has(cp.product.product_id))
        .map(cp => ({ ...cp.product }));
    }
    if (omitIds.size > 0) {
      products = products.filter(p => !omitIds.has(p.product_id));
    }
  }

  // Store context for refine
  session.lastGetProductsContext = { products };

  return { products, sandbox: true };
}

function handleListCreativeFormats(args: Record<string, unknown>, _ctx: TrainingContext): Record<string, unknown> {
  const req = args as unknown as ListCreativeFormatsRequest & { channels?: string[] };
  let formats = getFormats();

  // Filter by channels
  if (req.channels?.length) {
    const validIds = new Set<string>();
    for (const [fmtId, fmtChannels] of Object.entries(FORMAT_CHANNEL_MAP)) {
      if (fmtChannels.some(c => req.channels!.includes(c))) {
        validIds.add(fmtId);
      }
    }
    formats = formats.filter(f => validIds.has(f.format_id.id));
  }

  // Filter by format_ids
  if (req.format_ids?.length) {
    const requestedIds = new Set(req.format_ids.map(f => f.id));
    formats = formats.filter(f => requestedIds.has(f.format_id.id));
  }

  return { formats, sandbox: true };
}

function handleCreateMediaBuy(args: Record<string, unknown>, ctx: TrainingContext): Record<string, unknown> {
  const req = args as unknown as CreateMediaBuyRequest;
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));
  const catalog = getCatalog();
  const productMap = new Map(catalog.map(cp => [cp.product.product_id, cp.product]));

  if (!req.packages?.length) {
    return {
      errors: [{ code: 'INVALID_REQUEST', message: 'packages array is required and must have at least one item' }] as TaskError[],
    };
  }

  if (session.mediaBuys.size >= MAX_MEDIA_BUYS_PER_SESSION) {
    return {
      errors: [{ code: 'limit_exceeded', message: `Session limit reached (max ${MAX_MEDIA_BUYS_PER_SESSION} media buys). Start a new session.` }] as TaskError[],
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

  // Validate all packages and collect errors before returning
  const errors: TaskError[] = [];
  const createdPackages: PackageState[] = [];
  for (let i = 0; i < req.packages.length; i++) {
    const pkg: PackageRequest = req.packages[i];
    const pkgLabel = pkg.buyer_ref ? `Package "${pkg.buyer_ref}"` : `Package ${i}`;

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

    const pricingOptions = product.pricing_options;
    const pricing = pricingOptions?.find(po => po.pricing_option_id === pkg.pricing_option_id);
    if (!pricing) {
      errors.push({
        code: 'INVALID_REQUEST',
        message: `${pkgLabel}: Pricing option not found: ${pkg.pricing_option_id}. Available: ${pricingOptions?.map(po => po.pricing_option_id).join(', ')}`,
      });
      continue;
    }

    // Check bid vs floor price (floor_price exists on all pricing models except CPA)
    const floorPrice = pricing.pricing_model !== 'cpa' ? pricing.floor_price : undefined;
    const isAuction = pricing.pricing_model !== 'cpa'
      && !('fixed_price' in pricing && (pricing as unknown as Record<string, unknown>).fixed_price !== undefined);

    if (isAuction && pkg.bid_price === undefined) {
      errors.push({
        code: 'INVALID_REQUEST',
        message: `${pkgLabel}: bid_price is required for auction pricing (${pricing.pricing_model}, option ${pkg.pricing_option_id})`,
      });
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

    // Don't build package state if there are any validation errors (atomic create)
    if (errors.length > 0) continue;

    const resolvedStart = startTime === 'asap' ? new Date().toISOString() : startTime;

    createdPackages.push({
      packageId: `pkg_${randomUUID().slice(0, 8)}`,
      buyerRef: pkg.buyer_ref,
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
    });
  }

  if (errors.length > 0) {
    return { errors };
  }

  const mediaBuyId = `mb_${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const resolvedStart = buyStart === 'asap' ? now : buyStart;

  const mediaBuy: MediaBuyState = {
    mediaBuyId,
    buyerRef: req.buyer_ref,
    buyerCampaignRef: req.buyer_campaign_ref,
    accountRef: req.account,
    brandRef: req.brand,
    status: 'active',
    currency: 'USD',
    packages: createdPackages,
    startTime: resolvedStart,
    endTime: buyEnd,
    createdAt: now,
    updatedAt: now,
  };

  session.mediaBuys.set(mediaBuyId, mediaBuy);

  return {
    media_buy_id: mediaBuyId,
    buyer_ref: req.buyer_ref,
    buyer_campaign_ref: mediaBuy.buyerCampaignRef,
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

function handleGetMediaBuys(args: Record<string, unknown>, ctx: TrainingContext): Record<string, unknown> {
  const req = args as unknown as GetMediaBuysRequest;
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));
  const filterIds = req.media_buy_ids;

  let buys = Array.from(session.mediaBuys.values());
  if (filterIds?.length) {
    buys = buys.filter(b => filterIds.includes(b.mediaBuyId));
    // If explicit IDs requested but not found in this session, search all sessions.
    // Mirrors real seller behavior where media_buy_ids is a global lookup.
    if (buys.length < filterIds.length) {
      const foundIds = new Set(buys.map(b => b.mediaBuyId));
      const missing = filterIds.filter(id => !foundIds.has(id));
      for (const [, s] of getAllSessions()) {
        if (s === session) continue;
        for (const mb of s.mediaBuys.values()) {
          if (missing.includes(mb.mediaBuyId)) {
            buys.push(mb);
            missing.splice(missing.indexOf(mb.mediaBuyId), 1);
          }
        }
        if (missing.length === 0) break;
      }
    }
  }

  const includeSnapshot = (args as Record<string, unknown>).include_snapshot === true;

  return {
    media_buys: buys.map(mb => {
      const buy: Record<string, unknown> = {
        media_buy_id: mb.mediaBuyId,
        buyer_ref: mb.buyerRef,
        buyer_campaign_ref: mb.buyerCampaignRef,
        status: deriveStatus(mb),
        currency: mb.currency,
        start_time: mb.startTime,
        end_time: mb.endTime,
        packages: mb.packages.map(pkg => {
          const pkgData: Record<string, unknown> = {
            package_id: pkg.packageId,
            buyer_ref: pkg.buyerRef,
            product_id: pkg.productId,
            budget: pkg.budget,
            pricing_option_id: pkg.pricingOptionId,
            paused: pkg.paused,
            start_time: pkg.startTime,
            end_time: pkg.endTime,
            creative_approvals: pkg.creativeAssignments.map(cid => ({
              creative_id: cid,
              approval_status: 'approved',
            })),
          };
          if (includeSnapshot) {
            pkgData.snapshot_unavailable_reason = 'Sandbox training agent does not track real delivery';
          }
          return pkgData;
        }),
      };
      return buy;
    }),
    sandbox: true,
  };
}

function handleGetMediaBuyDelivery(args: Record<string, unknown>, ctx: TrainingContext): Record<string, unknown> {
  const req = args as unknown as GetMediaBuyDeliveryRequest & { media_buy_id?: string; buyer_ref?: string };
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));
  const catalog = getCatalog();
  const productMap = new Map(catalog.map(cp => [cp.product.product_id, cp.product]));
  // Accept singular media_buy_id/buyer_ref (backward compat) or plural from SDK
  const mediaBuyId = req.media_buy_id || req.buyer_ref || req.media_buy_ids?.[0] || '';
  let mb = session.mediaBuys.get(mediaBuyId) ||
    Array.from(session.mediaBuys.values()).find(b => b.buyerRef === mediaBuyId);

  // Cross-session fallback for explicit ID lookup
  if (!mb) {
    for (const [, s] of getAllSessions()) {
      if (s === session) continue;
      mb = s.mediaBuys.get(mediaBuyId) ||
        Array.from(s.mediaBuys.values()).find(b => b.buyerRef === mediaBuyId);
      if (mb) break;
    }
  }

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

function handleSyncCreatives(args: Record<string, unknown>, ctx: TrainingContext): Record<string, unknown> {
  const req = args as unknown as SyncCreativesRequest;
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));

  if (!req.creatives?.length) {
    return {
      errors: [{ code: 'INVALID_REQUEST', message: 'creatives array is required' }] as TaskError[],
    };
  }

  if (session.creatives.size + req.creatives.length > MAX_CREATIVES_PER_SESSION) {
    return {
      errors: [{ code: 'limit_exceeded', message: `Session limit reached (max ${MAX_CREATIVES_PER_SESSION} creatives). Start a new session.` }] as TaskError[],
    };
  }

  // Build a set of valid format IDs for validation
  const validFormatIds = new Set(getFormats().map(f => f.format_id.id));

  const results: Record<string, unknown>[] = [];
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

    // Validate format_id
    if (formatId?.id && !validFormatIds.has(formatId.id)) {
      return {
        errors: [{
          code: 'INVALID_REQUEST',
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
      // manifest is a training-agent extension, not in SDK CreativeAsset type
      manifest: (creative as unknown as Record<string, unknown>).manifest as CreativeState['manifest'],
    });

    results.push({
      creative_id: creativeId,
      action: existing ? 'updated' : 'created',
    });
  }

  // Process creative assignments
  const assignmentResults: Record<string, unknown>[] = [];
  if (req.assignments?.length) {
    for (const assignment of req.assignments) {
      const mediaBuyId = (assignment as Record<string, unknown>).media_buy_id as string;
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

function handleListCreatives(args: Record<string, unknown>, ctx: TrainingContext): Record<string, unknown> {
  const req = args as unknown as ListCreativesRequest & { creative_ids?: string[] };
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));
  const filterIds = req.creative_ids || req.filters?.creative_ids;

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

function handleUpdateMediaBuy(args: Record<string, unknown>, ctx: TrainingContext): Record<string, unknown> {
  const req = args as unknown as UpdateMediaBuyRequest;
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));
  const mediaBuyId = req.media_buy_id || req.buyer_ref || '';
  let mb = session.mediaBuys.get(mediaBuyId) ||
    Array.from(session.mediaBuys.values()).find(b => b.buyerRef === mediaBuyId);

  // Cross-session fallback for explicit ID lookup
  if (!mb) {
    for (const [, s] of getAllSessions()) {
      if (s === session) continue;
      mb = s.mediaBuys.get(mediaBuyId) ||
        Array.from(s.mediaBuys.values()).find(b => b.buyerRef === mediaBuyId);
      if (mb) break;
    }
  }

  if (!mb) {
    return {
      errors: [{ code: 'not_found', message: `Media buy not found: ${mediaBuyId}` }],
    };
  }

  // Update end_time with validation
  if (req.end_time) {
    if (isNaN(new Date(req.end_time).getTime())) {
      return { errors: [{ code: 'INVALID_REQUEST', message: `Invalid end_time: "${req.end_time}". Use ISO 8601 format.` }] };
    }
    mb.endTime = req.end_time;
  }

  // Update packages
  const warnings: string[] = [];
  if (req.packages?.length) {
    const knownPkgIds = new Set(mb.packages.map(p => p.packageId));
    for (const update of req.packages as PackageUpdate[]) {
      const pkgId = update.package_id || update.buyer_ref || '';
      const pkg = mb.packages.find(p => p.packageId === pkgId || p.buyerRef === pkgId);
      if (!pkg) {
        warnings.push(`Package not found: ${pkgId}. Known packages: ${[...knownPkgIds].join(', ')}`);
        continue;
      }
      if (update.budget !== undefined) {
        if (update.budget < 0) {
          return { errors: [{ code: 'INVALID_REQUEST', message: `Negative budget rejected for package ${pkgId}. Budget must be non-negative.` }] };
        }
        pkg.budget = update.budget;
      }
      if (update.paused !== undefined) pkg.paused = update.paused;
      if (update.end_time) {
        if (isNaN(new Date(update.end_time).getTime())) {
          warnings.push(`Invalid end_time for package ${pkgId}: "${update.end_time}". Skipped.`);
        } else {
          pkg.endTime = update.end_time;
        }
      }
    }
  }

  mb.updatedAt = new Date().toISOString();

  const result: { media_buy_id: string; buyer_ref: string; packages: unknown[]; sandbox: boolean; warnings?: string[] } = {
    media_buy_id: mb.mediaBuyId,
    buyer_ref: mb.buyerRef,
    packages: mb.packages.map(pkg => ({
      package_id: pkg.packageId,
      buyer_ref: pkg.buyerRef,
      product_id: pkg.productId,
      budget: pkg.budget,
      pricing_option_id: pkg.pricingOptionId,
      paused: pkg.paused,
      start_time: pkg.startTime,
      end_time: pkg.endTime,
    })),
    sandbox: true,
  };
  if (warnings.length) result.warnings = warnings;
  return result;
}

function handleGetAdcpCapabilities(_args: Record<string, unknown>, _ctx: TrainingContext): { adcp: { major_versions: number[] }; supported_protocols: string[]; protocol_version: string; tasks: string[]; media_buy: unknown; agent: { name: string; description: string } } {
  const tasks = TOOLS
    .map(t => t.name)
    .filter(name => name !== 'get_adcp_capabilities');
  const channels = [...new Set(PUBLISHERS.flatMap(p => p.channels))].sort();
  return {
    adcp: { major_versions: [3] },
    supported_protocols: ['media_buy', 'governance', 'signals'],
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

function handleGetSignals(args: Record<string, unknown>, ctx: TrainingContext): Record<string, unknown> {
  const req = args as unknown as GetSignalsRequest & { brief?: string };
  // Accept both signal_spec (protocol) and brief (SDK test tool)
  const signalSpec = req.signal_spec || req.brief;
  const maxResults = Math.min(Math.max(req.max_results || MAX_SIGNAL_RESULTS, 1), 50);
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));

  if (!signalSpec && !req.signal_ids?.length) {
    return {
      errors: [{ code: 'INVALID_REQUEST', message: 'Either signal_spec or signal_ids is required' }],
    };
  }

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
  const response: { signals: SignalResponse[]; sandbox: boolean; note?: string } = { signals, sandbox: true };
  if (hasIdentityTerm) {
    const isCreditQuery = rawTerms.includes('credit');
    response.note = isCreditQuery
      ? 'AdCP signals support credit-derived audience segments (credit activity, income tiers) but not raw credit scores, FICO data, or credit risk models. Signals represent targeting segments, not underlying financial data. Credit-derived signals may carry additional regulatory obligations (FCRA).'
      : 'AdCP signals support identity-derived attributes (age, income, life stage) but not identity resolution itself. Identity graphs, match rates, and cross-publisher deduplication are outside the current protocol scope.';
  }
  return response;
}

function handleActivateSignal(args: Record<string, unknown>, ctx: TrainingContext): Record<string, unknown> {
  const req = args as unknown as ActivateSignalRequest & {
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
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));

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
      sandbox: true,
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

  return { deployments, sandbox: true };
}

function handleGetCreativeDelivery(args: Record<string, unknown>, ctx: TrainingContext): Record<string, unknown> {
  const req = args as unknown as GetCreativeDeliveryRequest;
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));
  const agentUrl = getAgentUrl();

  // Resolve media buy IDs from multiple input formats
  const mediaBuyIds = req.media_buy_ids;
  const buyerRefs = req.media_buy_buyer_refs;
  const creativeIds = req.creative_ids;
  const maxVariants = req.max_variants || 10;

  if (!mediaBuyIds?.length && !buyerRefs?.length && !creativeIds?.length) {
    return {
      errors: [{ code: 'INVALID_REQUEST', message: 'At least one of media_buy_ids, media_buy_buyer_refs, or creative_ids is required.' }],
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
  const creatives: Array<Record<string, unknown>> = [];

  for (const cid of relevantCreativeIds) {
    const creative = session.creatives.get(cid);
    if (!creative) continue;

    // Generate deterministic variant-level delivery based on creative ID
    const variantCount = Math.min(maxVariants, 3);
    const idHash = Array.from(cid).reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
    const totalImpressions = 50000 + Math.abs(idHash % 100000);
    const totalSpend = Math.round(totalImpressions * 0.05 * 100) / 100;
    const totalClicks = Math.round(totalImpressions * 0.03);
    const variants: Array<Record<string, unknown>> = [];

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
      return adcpError('INVALID_REQUEST', { message: `Unknown tool: ${name}` });
    }

    try {
      const result = handler((args as Record<string, unknown>) || {}, ctx);
      const hasErrors = result && 'errors' in result && Array.isArray(result.errors) && result.errors.length > 0;
      if (hasErrors) {
        const firstError = (result as { errors: Array<{ code: string; message: string }> }).errors[0];
        return adcpError(firstError.code, {
          message: firstError.message,
          details: (result as { errors: Array<unknown> }).errors.length > 1
            ? { all_errors: (result as { errors: Array<unknown> }).errors }
            : undefined,
        });
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    } catch (error) {
      logger.error({ error, tool: name }, 'Training agent tool error');
      return adcpError('SERVICE_UNAVAILABLE', {
        message: error instanceof Error ? error.message : 'Unknown error',
        recovery: 'transient',
      });
    }
  });

  return server;
}
