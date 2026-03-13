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
import type { TrainingContext, CatalogProduct, MediaBuyState, PackageState } from './types.js';
import { buildCatalog } from './product-factory.js';
import { buildFormats, FORMAT_CHANNEL_MAP } from './formats.js';
import { getSession, sessionKeyFromArgs, MAX_MEDIA_BUYS_PER_SESSION, MAX_CREATIVES_PER_SESSION } from './state.js';
import { getAgentUrl } from './config.js';

const logger = createLogger('training-agent');

// ── Cached catalog and formats (built once at first use) ──────────
let cachedCatalog: CatalogProduct[] | null = null;
let cachedFormats: Record<string, unknown>[] | null = null;

function getCatalog(): CatalogProduct[] {
  if (!cachedCatalog) cachedCatalog = buildCatalog();
  return cachedCatalog;
}

function getFormats(): Record<string, unknown>[] {
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

// ── Tool definitions ──────────────────────────────────────────────

const TOOLS = [
  {
    name: 'get_products',
    description: 'Discover available advertising products. Supports brief (curated discovery), wholesale (raw catalog), and refine (iterate on previous results) buying modes.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object' as const,
      properties: {
        buying_mode: { type: 'string', enum: ['brief', 'wholesale', 'refine'] },
        brief: { type: 'string' },
        refine: { type: 'array' },
        account: { type: 'object' },
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
    description: 'List supported creative formats with asset requirements, dimensions, and rendering specifications.',
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
    description: 'Create a media buy with one or more packages targeting specific products.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: {
      type: 'object' as const,
      properties: {
        buyer_ref: { type: 'string' },
        buyer_campaign_ref: { type: 'string' },
        account: { type: 'object' },
        brand: { type: 'object' },
        packages: { type: 'array' },
        proposal_id: { type: 'string' },
        total_budget: { type: 'object' },
        start_time: { type: 'string', description: 'ISO 8601 date-time or "asap"' },
        end_time: { type: 'string' },
      },
      required: ['buyer_ref', 'account', 'brand', 'start_time', 'end_time'],
    },
  },
  {
    name: 'get_media_buys',
    description: 'List media buys for the current session/account.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object' as const,
      properties: {
        account: { type: 'object' },
        media_buy_ids: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'get_media_buy_delivery',
    description: 'Get delivery metrics for a media buy. Requires a media_buy_id from create_media_buy.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object' as const,
      properties: {
        account: { type: 'object' },
        media_buy_id: { type: 'string' },
        buyer_ref: { type: 'string' },
      },
      required: ['media_buy_id'] as const,
    },
  },
  {
    name: 'sync_creatives',
    description: 'Upload or update creative assets and optionally assign them to packages.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: 'object' as const,
      properties: {
        account: { type: 'object' },
        creatives: { type: 'array' },
        assignments: { type: 'array' },
      },
      required: ['account', 'creatives'],
    },
  },
  {
    name: 'list_creatives',
    description: 'List creative assets for the current account.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object' as const,
      properties: {
        account: { type: 'object' },
        creative_ids: { type: 'array', items: { type: 'string' } },
        media_buy_id: { type: 'string' },
      },
    },
  },
  {
    name: 'update_media_buy',
    description: 'Update an existing media buy (budget, flight dates, pause/resume packages). Cannot add new packages — only update existing ones.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: 'object' as const,
      properties: {
        account: { type: 'object' },
        media_buy_id: { type: 'string' },
        buyer_ref: { type: 'string' },
        packages: { type: 'array' },
        end_time: { type: 'string' },
      },
      required: ['media_buy_id'] as const,
    },
  },
];

// ── Task handler implementations ──────────────────────────────────

function handleGetProducts(args: Record<string, unknown>, ctx: TrainingContext): Record<string, unknown> {
  const buyingMode = args.buying_mode as string || 'brief';
  const brief = args.brief as string | undefined;
  const filters = args.filters as Record<string, unknown> | undefined;
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));

  let products = getCatalog().map(cp => ({ ...cp.product }));

  // Apply filters
  if (filters) {
    const channelFilter = filters.channels as string[] | undefined;
    if (channelFilter?.length) {
      products = products.filter(p => {
        const pChannels = p.channels as string[];
        return pChannels?.some(c => channelFilter.includes(c));
      });
    }
    const deliveryTypeFilter = filters.delivery_type as string | undefined;
    if (deliveryTypeFilter) {
      products = products.filter(p => p.delivery_type === deliveryTypeFilter);
    }
  }

  // Brief mode: keyword matching
  if (buyingMode === 'brief' && brief) {
    const terms = brief.toLowerCase().split(/\s+/);
    const scored = products
      .map(p => {
        const text = `${p.name} ${p.description} ${(p.channels as string[])?.join(' ')}`.toLowerCase();
        const matchCount = terms.filter(t => text.includes(t)).length;
        return matchCount > 0 ? { product: p, matchCount } : null;
      })
      .filter((s): s is NonNullable<typeof s> => s !== null)
      .sort((a, b) => b.matchCount - a.matchCount);

    products = scored.map(s => ({
      ...s.product,
      brief_relevance: `Matches ${s.matchCount} of ${terms.length} brief terms. ${s.product.description}`,
    }));

    // If no keyword matches, return top products as suggestions
    if (products.length === 0) {
      products = getCatalog().slice(0, 5).map(cp => ({
        ...cp.product,
        brief_relevance: 'Suggested product — no direct keyword match with your brief.',
      }));
    }
  }

  // Refine mode: apply include/omit/more_like_this
  if (buyingMode === 'refine' && args.refine) {
    const refineOps = args.refine as Array<Record<string, unknown>>;
    const previousProducts = session.lastGetProductsContext?.products || products;
    const omitIds = new Set<string>();
    const includeIds = new Set<string>();

    for (const op of refineOps) {
      if (op.scope === 'product') {
        if (op.action === 'omit') omitIds.add(op.id as string);
        else if (op.action === 'include') includeIds.add(op.id as string);
        // more_like_this: include the product plus similar channel products
        else if (op.action === 'more_like_this') {
          includeIds.add(op.id as string);
          const source = previousProducts.find(p => p.product_id === op.id);
          if (source) {
            const sourceChannels = source.channels as string[];
            for (const p of getCatalog()) {
              const pc = p.product.channels as string[];
              if (pc?.some(c => sourceChannels?.includes(c))) {
                includeIds.add(p.product.product_id as string);
              }
            }
          }
        }
      }
    }

    // Apply includes first (expand), then omits (filter)
    if (includeIds.size > 0) {
      products = getCatalog()
        .filter(cp => includeIds.has(cp.product.product_id as string))
        .map(cp => ({ ...cp.product }));
    }
    if (omitIds.size > 0) {
      products = products.filter(p => !omitIds.has(p.product_id as string));
    }
  }

  // Store context for refine
  session.lastGetProductsContext = { products };

  return { products, sandbox: true };
}

function handleListCreativeFormats(args: Record<string, unknown>, _ctx: TrainingContext): Record<string, unknown> {
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
    formats = formats.filter(f => {
      const fid = f.format_id as { id: string };
      return validIds.has(fid.id);
    });
  }

  // Filter by format_ids
  const formatIdFilter = args.format_ids as Array<Record<string, unknown>> | undefined;
  if (formatIdFilter?.length) {
    const requestedIds = new Set(formatIdFilter.map(f => f.id as string));
    formats = formats.filter(f => {
      const fid = f.format_id as { id: string };
      return requestedIds.has(fid.id);
    });
  }

  return { formats, sandbox: true };
}

function handleCreateMediaBuy(args: Record<string, unknown>, ctx: TrainingContext): Record<string, unknown> {
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));
  const catalog = getCatalog();
  const productMap = new Map(catalog.map(cp => [cp.product.product_id as string, cp.product]));

  const buyerRef = args.buyer_ref as string;
  const packages = args.packages as Array<Record<string, unknown>> | undefined;

  if (!packages?.length) {
    return {
      errors: [{ code: 'validation_error', message: 'packages array is required and must have at least one item' }],
    };
  }

  if (session.mediaBuys.size >= MAX_MEDIA_BUYS_PER_SESSION) {
    return {
      errors: [{ code: 'limit_exceeded', message: `Session limit reached (max ${MAX_MEDIA_BUYS_PER_SESSION} media buys). Start a new session.` }],
    };
  }

  // Validate dates
  const buyStart = args.start_time as string;
  const buyEnd = args.end_time as string;
  if (buyStart !== 'asap' && isNaN(new Date(buyStart).getTime())) {
    return { errors: [{ code: 'validation_error', message: `Invalid start_time: "${buyStart}". Use ISO 8601 format or "asap".` }] };
  }
  if (isNaN(new Date(buyEnd).getTime())) {
    return { errors: [{ code: 'validation_error', message: `Invalid end_time: "${buyEnd}". Use ISO 8601 format.` }] };
  }
  if (buyStart !== 'asap' && new Date(buyStart) >= new Date(buyEnd)) {
    return { errors: [{ code: 'validation_error', message: 'start_time must be before end_time' }] };
  }

  // Validate packages
  const createdPackages: PackageState[] = [];
  for (const pkg of packages) {
    const productId = pkg.product_id as string;
    const product = productMap.get(productId);
    if (!product) {
      return {
        errors: [{ code: 'validation_error', message: `Product not found: ${productId}` }],
      };
    }

    const pricingOptionId = pkg.pricing_option_id as string;
    const pricingOptions = product.pricing_options as Array<Record<string, unknown>>;
    const pricing = pricingOptions?.find(po => po.pricing_option_id === pricingOptionId);
    if (!pricing) {
      return {
        errors: [{
          code: 'validation_error',
          message: `Pricing option not found: ${pricingOptionId}. Available: ${pricingOptions?.map(po => po.pricing_option_id).join(', ')}`,
        }],
      };
    }

    // Check bid vs floor price
    const floorPrice = pricing.floor_price as number | undefined;
    const bidPrice = pkg.bid_price as number | undefined;
    if (floorPrice !== undefined && bidPrice !== undefined && bidPrice < floorPrice) {
      return {
        errors: [{
          code: 'validation_error',
          message: `Bid price $${bidPrice} is below floor price of $${floorPrice} for pricing option ${pricingOptionId}`,
        }],
      };
    }

    // Check min spend
    const minSpend = pricing.min_spend_per_package as number | undefined;
    const budget = pkg.budget as number;
    if (minSpend && budget < minSpend) {
      return {
        errors: [{
          code: 'validation_error',
          message: `Budget $${budget} is below minimum spend of $${minSpend} for pricing option ${pricingOptionId}`,
        }],
      };
    }

    const startTime = (pkg.start_time || args.start_time) as string;
    const endTime = (pkg.end_time || args.end_time) as string;
    const resolvedStart = startTime === 'asap' ? new Date().toISOString() : startTime;

    createdPackages.push({
      packageId: `pkg_${randomUUID().slice(0, 8)}`,
      buyerRef: pkg.buyer_ref as string,
      productId,
      budget,
      pricingOptionId,
      bidPrice: pkg.bid_price as number | undefined,
      impressions: pkg.impressions as number | undefined,
      paused: (pkg.paused as boolean) || false,
      startTime: resolvedStart,
      endTime,
      formatIds: pkg.format_ids as Record<string, unknown>[] | undefined,
      creativeAssignments: [],
    });
  }

  const mediaBuyId = `mb_${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const resolvedStart = args.start_time === 'asap' ? now : args.start_time as string;

  const mediaBuy: MediaBuyState = {
    mediaBuyId,
    buyerRef,
    buyerCampaignRef: args.buyer_campaign_ref as string | undefined,
    accountRef: args.account as Record<string, unknown>,
    brandRef: args.brand as Record<string, unknown> | undefined,
    status: 'active',
    currency: 'USD',
    packages: createdPackages,
    startTime: resolvedStart,
    endTime: args.end_time as string,
    createdAt: now,
    updatedAt: now,
  };

  session.mediaBuys.set(mediaBuyId, mediaBuy);

  return {
    media_buy_id: mediaBuyId,
    buyer_ref: buyerRef,
    buyer_campaign_ref: mediaBuy.buyerCampaignRef,
    status: 'active',
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
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));
  const filterIds = args.media_buy_ids as string[] | undefined;

  let buys = Array.from(session.mediaBuys.values());
  if (filterIds?.length) {
    buys = buys.filter(b => filterIds.includes(b.mediaBuyId));
  }

  const now = new Date();
  return {
    media_buys: buys.map(mb => {
      // Derive lifecycle state from dates
      let status = mb.status;
      const endDate = new Date(mb.endTime);
      const startDate = new Date(mb.startTime);
      if (status === 'active' && endDate < now) {
        status = 'completed';
      } else if (status === 'active' && startDate > now) {
        status = 'scheduled';
      }
      return {
      media_buy_id: mb.mediaBuyId,
      buyer_ref: mb.buyerRef,
      buyer_campaign_ref: mb.buyerCampaignRef,
      status,
      currency: mb.currency,
      start_time: mb.startTime,
      end_time: mb.endTime,
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
    };
    }),
    sandbox: true,
  };
}

function handleGetMediaBuyDelivery(args: Record<string, unknown>, ctx: TrainingContext): Record<string, unknown> {
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));
  const catalog = getCatalog();
  const productMap = new Map(catalog.map(cp => [cp.product.product_id as string, cp.product]));
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

  return {
    media_buy_id: mb.mediaBuyId,
    buyer_ref: mb.buyerRef,
    currency: mb.currency,
    reporting_period: {
      start_date: mb.startTime,
      end_date: now.toISOString(),
    },
    media_buy_deliveries: mb.packages.map(pkg => {
      // Paused packages stop accruing delivery
      if (pkg.paused) {
        return {
          package_id: pkg.packageId,
          product_id: pkg.productId,
          impressions: 0,
          spend: 0,
          clicks: 0,
          ctr: 0,
          paused: true,
        };
      }

      const budget = pkg.budget;
      const spend = Math.round(budget * elapsed * 100) / 100;

      // Derive CPM from the product's actual pricing
      const product = productMap.get(pkg.productId);
      const pricingOptions = product?.pricing_options as Array<Record<string, unknown>> | undefined;
      const pricing = pricingOptions?.find(po => po.pricing_option_id === pkg.pricingOptionId);
      const cpm = (pricing?.fixed_price as number)
        || (pricing?.floor_price as number)
        || 10;

      // Channel-appropriate CTR
      const channels = product?.channels as string[] | undefined;
      let ctr: number;
      if (channels?.some(c => ['social', 'influencer'].includes(c))) ctr = 0.012;
      else if (channels?.some(c => ['search'].includes(c))) ctr = 0.035;
      else if (channels?.some(c => ['retail_media'].includes(c))) ctr = 0.008;
      else if (channels?.some(c => ['ctv', 'linear_tv'].includes(c))) ctr = 0;
      else if (channels?.some(c => ['streaming_audio', 'podcast', 'radio'].includes(c))) ctr = 0.003;
      else if (channels?.some(c => ['print'].includes(c))) ctr = 0;
      else ctr = 0.001;

      const impressions = cpm > 0 ? Math.round((spend / cpm) * 1000) : 0;
      const clicks = Math.round(impressions * ctr);
      return {
        package_id: pkg.packageId,
        product_id: pkg.productId,
        impressions,
        spend,
        clicks,
        ctr: impressions > 0 ? Math.round((clicks / impressions) * 10000) / 10000 : 0,
      };
    }),
    sandbox: true,
  };
}

function handleSyncCreatives(args: Record<string, unknown>, ctx: TrainingContext): Record<string, unknown> {
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));
  const creatives = args.creatives as Array<Record<string, unknown>>;

  if (!creatives?.length) {
    return {
      errors: [{ code: 'validation_error', message: 'creatives array is required' }],
    };
  }

  if (session.creatives.size + creatives.length > MAX_CREATIVES_PER_SESSION) {
    return {
      errors: [{ code: 'limit_exceeded', message: `Session limit reached (max ${MAX_CREATIVES_PER_SESSION} creatives). Start a new session.` }],
    };
  }

  // Build a set of valid format IDs for validation
  const validFormatIds = new Set(getFormats().map(f => (f.format_id as { id: string }).id));

  const results: Record<string, unknown>[] = [];
  for (const creative of creatives) {
    const creativeId = (creative.creative_id as string) || `cr_${randomUUID().slice(0, 8)}`;
    const formatId = creative.format_id as { agent_url: string; id: string };

    // Validate format_id
    if (formatId?.id && !validFormatIds.has(formatId.id)) {
      return {
        errors: [{
          code: 'validation_error',
          message: `Unknown format_id "${formatId.id}". Use list_creative_formats to see available formats.`,
        }],
      };
    }

    const existing = session.creatives.has(creativeId);

    session.creatives.set(creativeId, {
      creativeId,
      formatId,
      name: creative.name as string | undefined,
      status: 'active',
      syncedAt: new Date().toISOString(),
      manifest: creative.manifest as Record<string, unknown> | undefined,
    });

    results.push({
      creative_id: creativeId,
      action: existing ? 'updated' : 'created',
      status: 'active',
    });
  }

  // Process creative assignments
  const assignments = args.assignments as Array<Record<string, unknown>> | undefined;
  const assignmentResults: Record<string, unknown>[] = [];
  if (assignments?.length) {
    for (const assignment of assignments) {
      const mediaBuyId = assignment.media_buy_id as string;
      const packageId = assignment.package_id as string;
      const creativeId = assignment.creative_id as string;

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

function handleUpdateMediaBuy(args: Record<string, unknown>, ctx: TrainingContext): Record<string, unknown> {
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));
  const mediaBuyId = (args.media_buy_id || args.buyer_ref) as string;
  const mb = session.mediaBuys.get(mediaBuyId) ||
    Array.from(session.mediaBuys.values()).find(b => b.buyerRef === mediaBuyId);

  if (!mb) {
    return {
      errors: [{ code: 'not_found', message: `Media buy not found: ${mediaBuyId}` }],
    };
  }

  // Update end_time
  if (args.end_time) {
    mb.endTime = args.end_time as string;
  }

  // Update packages
  const packageUpdates = args.packages as Array<Record<string, unknown>> | undefined;
  const warnings: string[] = [];
  if (packageUpdates?.length) {
    const knownPkgIds = new Set(mb.packages.map(p => p.packageId));
    for (const update of packageUpdates) {
      const pkgId = (update.package_id || update.buyer_ref) as string;
      const pkg = mb.packages.find(p => p.packageId === pkgId || p.buyerRef === pkgId);
      if (!pkg) {
        warnings.push(`Package not found: ${pkgId}. Known packages: ${[...knownPkgIds].join(', ')}`);
        continue;
      }
      if (update.budget !== undefined) pkg.budget = update.budget as number;
      if (update.paused !== undefined) pkg.paused = update.paused as boolean;
      if (update.end_time) pkg.endTime = update.end_time as string;
    }
  }

  mb.updatedAt = new Date().toISOString();

  const result: Record<string, unknown> = {
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

// ── Handler dispatch ──────────────────────────────────────────────

type ToolHandler = (args: Record<string, unknown>, ctx: TrainingContext) => Record<string, unknown>;

const HANDLER_MAP: Record<string, ToolHandler> = {
  get_products: handleGetProducts,
  list_creative_formats: handleListCreativeFormats,
  create_media_buy: handleCreateMediaBuy,
  get_media_buys: handleGetMediaBuys,
  get_media_buy_delivery: handleGetMediaBuyDelivery,
  sync_creatives: handleSyncCreatives,
  list_creatives: handleListCreatives,
  update_media_buy: handleUpdateMediaBuy,
};

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
