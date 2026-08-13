/**
 * Catalog and event tracking handlers for the training agent.
 *
 * Implements sync_catalogs, sync_event_sources, log_event,
 * and provide_performance_feedback per AdCP schemas.
 */

import { randomUUID } from 'node:crypto';
import type { TrainingContext, ToolArgs, AccountRef } from './types.js';
import { getSession, sessionKeyFromArgs, findMediaBuyAcrossSessions } from './state.js';

// ── Types ────────────────────────────────────────────────────────

interface SyncCatalogsInput extends ToolArgs {
  catalogs?: CatalogInput[];
  catalog_ids?: string[];
  delete_missing?: boolean;
  dry_run?: boolean;
  validation_mode?: string;
}

interface CatalogInput {
  catalog_id: string;
  type?: string;
  name?: string;
  url?: string;
  items?: CatalogItemInput[];
}

interface CatalogItemInput {
  item_id: string;
  title?: string;
  description?: string;
  url?: string;
  image_url?: string;
  price?: { amount: number; currency: string };
  [key: string]: unknown;
}

interface SyncEventSourcesInput extends ToolArgs {
  event_sources?: EventSourceInput[];
  delete_missing?: boolean;
}

interface EventSourceInput {
  event_source_id: string;
  name: string;
  event_types?: string[];
  allowed_domains?: string[];
}

interface LogEventInput extends ToolArgs {
  event_source_id: string;
  events: EventInput[];
  test_event_code?: string;
  idempotency_key?: string;
}

interface EventInput {
  event_id?: string;
  event_type: string;
  timestamp?: string;
  content_ids?: string[];
  value?: number;
  currency?: string;
  [key: string]: unknown;
}

interface PerformanceFeedbackInput extends ToolArgs {
  media_buy_id: string;
  measurement_period: { start: string; end: string };
  performance_index: number;
  package_id?: string;
  creative_id?: string;
  baseline?: string;
  metric?: Record<string, unknown>;
  metric_type?: string;
  feedback_source?: string;
  producer?: { domain: string; brand_id?: string };
  vendor?: { domain: string; brand_id?: string };
  methodology?: string;
  methodology_version?: string;
  study_ref?: string;
  evidence?: Record<string, unknown>;
  evidence_ref?: string;
  as_of?: string;
  final?: boolean;
  supersedes_feedback_id?: string;
  idempotency_key?: string;
}

// ── Session state ────────────────────────────────────────────────

interface CatalogState {
  catalogId: string;
  catalogType: string;
  name: string;
  itemCount: number;
  itemsApproved: number;
  itemsPending: number;
  itemsRejected: number;
  syncedAt: string;
}

interface EventSourceState {
  eventSourceId: string;
  name: string;
  sellerId: string;
  eventTypes: string[];
  allowedDomains: string[];
  action: string;
  createdAt: string;
}

interface PerformanceFeedbackState {
  feedbackId: string;
  sessionKey: string;
  receivedAt: string;
  assertion: PerformanceFeedbackInput;
}

const catalogStore = new Map<string, Map<string, CatalogState>>();
const eventSourceStore = new Map<string, Map<string, EventSourceState>>();
const performanceFeedbackStore = new Map<string, PerformanceFeedbackState>();

function getCatalogMap(sessionKey: string): Map<string, CatalogState> {
  let map = catalogStore.get(sessionKey);
  if (!map) {
    map = new Map();
    catalogStore.set(sessionKey, map);
  }
  return map;
}

function getEventSourceMap(sessionKey: string): Map<string, EventSourceState> {
  let map = eventSourceStore.get(sessionKey);
  if (!map) {
    map = new Map();
    eventSourceStore.set(sessionKey, map);
  }
  return map;
}

/** Look up an event source across every session. Some tools (log_event,
 *  provide_performance_feedback) carry an id the buyer synced earlier but
 *  drop the `account` context the SDK's request-builder strips against the
 *  published tool schema. Fall back to a global search so a synced source
 *  is still reachable from any session within the sandbox. */
export function findEventSourceAnywhere(eventSourceId: string): EventSourceState | undefined {
  for (const map of eventSourceStore.values()) {
    const hit = map.get(eventSourceId);
    if (hit) return hit;
  }
  return undefined;
}

/** Look up an event source in a specific session, falling back to global scan.
 *  Used by create_media_buy to validate that event-kind optimization_goals
 *  reference a previously-registered event_source_id rather than silently
 *  accepting phantom ids. */
export function findEventSourceInSession(sessionKey: string, eventSourceId: string): EventSourceState | undefined {
  return eventSourceStore.get(sessionKey)?.get(eventSourceId) ?? findEventSourceAnywhere(eventSourceId);
}

/** Exported for testing */
export function clearCatalogEventStores(): void {
  catalogStore.clear();
  eventSourceStore.clear();
  performanceFeedbackStore.clear();
}

// ── Shared schema fragment ───────────────────────────────────────

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

const PERFORMANCE_BASELINES = [
  'campaign_target', 'control_group', 'seller_history',
  'buyer_portfolio', 'market_benchmark', 'other',
] as const;

const STANDARD_PERFORMANCE_METRICS = [
  'impressions', 'spend', 'clicks', 'ctr', 'views', 'completed_views',
  'completion_rate', 'conversions', 'conversion_value', 'roas',
  'cost_per_acquisition', 'new_to_brand_rate', 'leads', 'reach', 'frequency',
  'grps', 'engagements', 'engagement_rate', 'follows', 'saves',
  'profile_visits', 'viewability', 'quartile_data', 'dooh_metrics',
  'cost_per_click', 'cost_per_completed_view', 'cpm', 'downloads',
  'units_sold', 'new_to_brand_units', 'plays', 'incremental_sales_lift',
  'brand_lift', 'foot_traffic', 'conversion_lift', 'brand_search_lift',
] as const;

const METRIC_QUALIFIER_SCHEMA = {
  type: 'object',
  properties: {
    viewability_standard: { type: 'string', enum: ['mrc', 'groupm'] },
    completion_source: { type: 'string', enum: ['seller_attested', 'vendor_attested'] },
    attribution_methodology: { type: 'string', enum: ['deterministic_purchase', 'probabilistic', 'panel_based', 'modeled'] },
    attribution_window: {
      type: 'object',
      properties: {
        interval: { type: 'integer', minimum: 1 },
        unit: { type: 'string', enum: ['seconds', 'minutes', 'hours', 'days', 'campaign'] },
      },
      required: ['interval', 'unit'],
      additionalProperties: false,
    },
    lift_dimension: { type: 'string', enum: ['awareness', 'consideration', 'favorability', 'purchase_intent', 'ad_recall'] },
  },
  additionalProperties: false,
};

const PERFORMANCE_FEEDBACK_METRIC_SCHEMA = {
  type: 'object',
  oneOf: [
    {
      properties: {
        scope: { type: 'string', const: 'standard' },
        metric_id: { type: 'string', enum: [...STANDARD_PERFORMANCE_METRICS] },
        qualifier: METRIC_QUALIFIER_SCHEMA,
      },
      required: ['scope', 'metric_id'],
      additionalProperties: false,
    },
    {
      properties: {
        scope: { type: 'string', const: 'vendor' },
        vendor: {
          type: 'object',
          properties: {
            domain: { type: 'string', pattern: '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$' },
            brand_id: { type: 'string', pattern: '^[a-z0-9_]+$' },
          },
          required: ['domain'],
          additionalProperties: true,
        },
        metric_id: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-z][a-z0-9_]*$' },
      },
      required: ['scope', 'vendor', 'metric_id'],
      additionalProperties: false,
    },
  ],
};

const PERFORMANCE_FEEDBACK_EVIDENCE_SCHEMA = {
  type: 'object',
  properties: {
    sample_size: { type: 'integer', minimum: 1 },
    confidence_interval: {
      type: 'object',
      properties: {
        lower: { type: 'number' },
        upper: { type: 'number' },
        level: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 },
      },
      required: ['lower', 'upper', 'level'],
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

// ── Tool definitions ─────────────────────────────────────────────

export const CATALOG_EVENT_TOOLS = [
  {
    name: 'sync_catalogs',
    description: 'Push product catalogs (feeds, items, inventory) for catalog-driven campaigns. Supports URL feeds for scheduled re-fetch and inline items for small catalogs. Returns per-item approval status. Omit catalogs to discover existing synced catalogs.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        account: ACCOUNT_REF_SCHEMA,
        catalogs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              catalog_id: { type: 'string' },
              type: { type: 'string', enum: ['product', 'offering', 'inventory', 'store', 'promotion', 'hotel', 'flight', 'job', 'vehicle', 'real_estate', 'education', 'destination'] },
              catalog_type: { type: 'string', enum: ['product', 'offering', 'inventory', 'store', 'promotion', 'hotel', 'flight', 'job', 'vehicle', 'real_estate', 'education', 'destination'] },
              name: { type: 'string' },
              feed_url: { type: 'string', format: 'uri' },
              url: { type: 'string', format: 'uri' },
              items: { type: 'array' },
            },
            required: ['catalog_id'],
          },
          maxItems: 50,
        },
        catalog_ids: { type: 'array', items: { type: 'string' }, maxItems: 50 },
        delete_missing: { type: 'boolean' },
        dry_run: { type: 'boolean' },
        validation_mode: { type: 'string', enum: ['strict', 'lenient'] },
      },
      required: ['account'],
    },
  },
  {
    name: 'sync_event_sources',
    description: 'Configure event sources for conversion tracking (website pixels, mobile SDKs, server-to-server). Returns setup snippets and integration instructions. Omit event_sources to discover existing sources.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    execution: { taskSupport: 'forbidden' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        account: ACCOUNT_REF_SCHEMA,
        event_sources: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              event_source_id: { type: 'string' },
              name: { type: 'string' },
              event_types: { type: 'array', items: { type: 'string' } },
              allowed_domains: { type: 'array', items: { type: 'string' } },
            },
            required: ['event_source_id', 'name'],
          },
        },
        delete_missing: { type: 'boolean' },
      },
      required: ['account'],
    },
  },
  {
    name: 'log_event',
    description: 'Send conversion and marketing events for attribution and campaign optimization. Events are attributed to media buys via content_ids matching catalog items. Supports batch submission (1-10000 events) with partial failure reporting.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    execution: { taskSupport: 'forbidden' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        event_source_id: { type: 'string' },
        events: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              event_id: { type: 'string' },
              event_type: { type: 'string' },
              timestamp: { type: 'string', format: 'date-time' },
              content_ids: { type: 'array', items: { type: 'string' } },
              value: { type: 'number' },
              currency: { type: 'string' },
            },
            required: ['event_type'],
          },
          minItems: 1,
          maxItems: 10000,
        },
        test_event_code: { type: 'string' },
        idempotency_key: { type: 'string' },
      },
      required: ['event_source_id', 'events'],
    },
  },
  {
    name: 'provide_performance_feedback',
    description: 'Submit one compact optimizer-ready assertion to the seller. Buyer orchestrators can identify the baseline, metric, producer, methodology, and supporting evidence without transporting a complete measurement dataset.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    execution: { taskSupport: 'forbidden' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        account: ACCOUNT_REF_SCHEMA,
        brand: { type: 'object', properties: { domain: { type: 'string' }, name: { type: 'string' } } },
        media_buy_id: { type: 'string' },
        measurement_period: {
          type: 'object',
          properties: {
            start: { type: 'string', format: 'date-time' },
            end: { type: 'string', format: 'date-time' },
          },
          required: ['start', 'end'],
        },
        performance_index: { type: 'number', minimum: 0 },
        package_id: { type: 'string' },
        creative_id: { type: 'string' },
        baseline: {
          type: 'string',
          enum: [...PERFORMANCE_BASELINES],
        },
        metric: PERFORMANCE_FEEDBACK_METRIC_SCHEMA,
        metric_type: { type: 'string', enum: ['overall_performance', 'conversion_rate', 'brand_lift', 'click_through_rate', 'completion_rate', 'viewability', 'brand_safety', 'cost_efficiency'] },
        feedback_source: { type: 'string', enum: ['buyer_attribution', 'third_party_measurement', 'platform_analytics', 'verification_partner'] },
        producer: { type: 'object', properties: { domain: { type: 'string', pattern: '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$' }, brand_id: { type: 'string', pattern: '^[a-z0-9_]+$' } }, required: ['domain'] },
        vendor: { type: 'object', properties: { domain: { type: 'string', pattern: '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$' }, brand_id: { type: 'string', pattern: '^[a-z0-9_]+$' } }, required: ['domain'] },
        methodology: { type: 'string', minLength: 1, maxLength: 100 },
        methodology_version: { type: 'string', minLength: 1, maxLength: 100 },
        study_ref: { type: 'string', minLength: 1, maxLength: 255 },
        evidence: PERFORMANCE_FEEDBACK_EVIDENCE_SCHEMA,
        evidence_ref: { type: 'string', format: 'uri' },
        as_of: { type: 'string', format: 'date-time' },
        final: { type: 'boolean' },
        supersedes_feedback_id: { type: 'string', minLength: 1 },
        idempotency_key: { type: 'string', minLength: 16, maxLength: 255, pattern: '^[A-Za-z0-9_.:-]{16,255}$' },
      },
      required: ['media_buy_id', 'measurement_period', 'performance_index'],
    },
  },
];

// ── Handler implementations ─────────────────────────────────────

const VALID_CATALOG_TYPES = ['product', 'offering', 'inventory', 'store', 'promotion', 'hotel', 'flight', 'job', 'vehicle', 'real_estate', 'education', 'destination'];

const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const BRAND_ID_PATTERN = /^[a-z0-9_]+$/;
const VENDOR_METRIC_ID_PATTERN = /^[a-z][a-z0-9_]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every(key => allowed.has(key));
}

function isBrandRef(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.domain !== 'string' || !DOMAIN_PATTERN.test(value.domain)) return false;
  return value.brand_id === undefined
    || (typeof value.brand_id === 'string' && BRAND_ID_PATTERN.test(value.brand_id));
}

function validateMetricQualifier(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const allowed = new Set([
    'viewability_standard', 'completion_source', 'attribution_methodology',
    'attribution_window', 'lift_dimension',
  ]);
  if (!hasOnlyKeys(value, allowed)) return false;
  if (value.viewability_standard !== undefined && !['mrc', 'groupm'].includes(value.viewability_standard as string)) return false;
  if (value.completion_source !== undefined && !['seller_attested', 'vendor_attested'].includes(value.completion_source as string)) return false;
  if (value.attribution_methodology !== undefined && !['deterministic_purchase', 'probabilistic', 'panel_based', 'modeled'].includes(value.attribution_methodology as string)) return false;
  if (value.lift_dimension !== undefined && !['awareness', 'consideration', 'favorability', 'purchase_intent', 'ad_recall'].includes(value.lift_dimension as string)) return false;
  if (value.attribution_window !== undefined) {
    const window = value.attribution_window;
    if (!isRecord(window) || !hasOnlyKeys(window, new Set(['interval', 'unit']))) return false;
    if (!Number.isInteger(window.interval) || (window.interval as number) < 1) return false;
    if (!['seconds', 'minutes', 'hours', 'days', 'campaign'].includes(window.unit as string)) return false;
    if (window.unit === 'campaign' && window.interval !== 1) return false;
  }
  return true;
}

function validatePerformanceMetric(value: unknown): boolean {
  if (!isRecord(value) || typeof value.scope !== 'string') return false;
  if (value.scope === 'standard') {
    if (!hasOnlyKeys(value, new Set(['scope', 'metric_id', 'qualifier']))) return false;
    if (!STANDARD_PERFORMANCE_METRICS.includes(value.metric_id as typeof STANDARD_PERFORMANCE_METRICS[number])) return false;
    return value.qualifier === undefined || validateMetricQualifier(value.qualifier);
  }
  if (value.scope === 'vendor') {
    if (!hasOnlyKeys(value, new Set(['scope', 'vendor', 'metric_id']))) return false;
    return isBrandRef(value.vendor)
      && typeof value.metric_id === 'string'
      && value.metric_id.length <= 64
      && VENDOR_METRIC_ID_PATTERN.test(value.metric_id);
  }
  return false;
}

function validatePerformanceEvidence(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['sample_size', 'confidence_interval']))) return false;
  if (value.sample_size !== undefined && (!Number.isInteger(value.sample_size) || (value.sample_size as number) < 1)) return false;
  if (value.confidence_interval !== undefined) {
    const interval = value.confidence_interval;
    if (!isRecord(interval) || !hasOnlyKeys(interval, new Set(['lower', 'upper', 'level']))) return false;
    if (typeof interval.lower !== 'number' || typeof interval.upper !== 'number' || typeof interval.level !== 'number') return false;
    if (!(interval.level > 0 && interval.level < 1)) return false;
  }
  return true;
}

function validateCompactPerformanceFeedback(req: PerformanceFeedbackInput): string | undefined {
  if (req.baseline !== undefined && !PERFORMANCE_BASELINES.includes(req.baseline as typeof PERFORMANCE_BASELINES[number])) {
    return 'baseline is not a recognized performance baseline';
  }
  if (req.metric !== undefined && !validatePerformanceMetric(req.metric)) {
    return 'metric must be a valid standard or vendor performance metric identity';
  }
  if (req.evidence !== undefined && !validatePerformanceEvidence(req.evidence)) {
    return 'evidence must contain a valid sample size and/or confidence interval';
  }
  if (req.producer !== undefined && !isBrandRef(req.producer)) {
    return 'producer must be a valid BrandRef';
  }
  if ((req.methodology !== undefined || req.methodology_version !== undefined) && req.producer === undefined) {
    return 'producer is required when methodology or methodology_version is present';
  }
  return undefined;
}

export async function handleSyncCatalogs(args: ToolArgs, ctx: TrainingContext) {
  const req = args as unknown as SyncCatalogsInput;

  if (!req.account) {
    return {
      errors: [{ code: 'INVALID_REQUEST', message: 'account is required' }],
    };
  }

  const sessionKey = sessionKeyFromArgs(req, ctx.mode, ctx.userId, ctx.moduleId);
  const catalogs = getCatalogMap(sessionKey);
  const now = new Date().toISOString();

  // Discovery mode — return existing catalogs
  if (!req.catalogs && !req.catalog_ids) {
    const existing = Array.from(catalogs.values()).map(c => ({
      catalog_id: c.catalogId,
      type: c.catalogType,
      name: c.name,
      item_count: c.itemCount,
      items_approved: c.itemsApproved,
      items_pending: c.itemsPending,
      items_rejected: c.itemsRejected,
      last_synced_at: c.syncedAt,
    }));
    return { catalogs: existing };
  }

  if (!req.catalogs || req.catalogs.length === 0) {
    return {
      errors: [{ code: 'INVALID_REQUEST', message: 'catalogs array is required for sync operations' }],
    };
  }

  const results: Record<string, unknown>[] = [];

  for (const input of req.catalogs) {
    if (!input.catalog_id) {
      results.push({
        catalog_id: 'unknown',
        action: 'failed',
        errors: [{ code: 'INVALID_REQUEST', message: 'catalog_id is required' }],
      });
      continue;
    }

    // Default to 'product' when omitted — the most common catalog type in
    // practice, and the spec allows inferring from feed content. Explicit
    // invalid values still fail fast.
    const catalogType = input.type ?? 'product';
    if (!VALID_CATALOG_TYPES.includes(catalogType)) {
      results.push({
        catalog_id: input.catalog_id,
        action: 'failed',
        errors: [{ code: 'INVALID_REQUEST', message: `catalog type must be one of: ${VALID_CATALOG_TYPES.join(', ')}` }],
      });
      continue;
    }

    const existing = catalogs.get(input.catalog_id);
    const feedUrl = input.url;
    const itemCount = input.items?.length || (feedUrl ? 50 : 0); // Simulate feed fetch
    // Small inline catalogs: approve all. Larger feeds: simulate realistic review rates.
    const itemsApproved = itemCount <= 10 ? itemCount : Math.floor(itemCount * 0.9);
    const itemsRejected = itemCount <= 10 ? 0 : Math.floor(itemCount * 0.02);
    const itemsPending = itemCount - itemsApproved - itemsRejected;

    if (req.dry_run) {
      results.push({
        catalog_id: input.catalog_id,
        action: existing ? 'updated' : 'created',
        item_count: itemCount,
        items_approved: itemsApproved,
        items_pending: itemsPending,
        items_rejected: itemsRejected,
      });
      continue;
    }

    const state: CatalogState = {
      catalogId: input.catalog_id,
      catalogType,
      name: input.name || input.catalog_id,
      itemCount,
      itemsApproved,
      itemsPending,
      itemsRejected,
      syncedAt: now,
    };

    catalogs.set(input.catalog_id, state);

    const result: Record<string, unknown> = {
      catalog_id: input.catalog_id,
      action: existing ? 'updated' : 'created',
      platform_id: `plat_${input.catalog_id}`,
      item_count: itemCount,
      items_approved: itemsApproved,
      items_pending: itemsPending,
      items_rejected: itemsRejected,
      last_synced_at: now,
    };

    // Simulate item-level issues for rejected items
    if (itemsRejected > 0 && input.items && input.items.length > 0) {
      result.item_issues = [{
        item_id: input.items[input.items.length - 1]?.item_id || 'unknown',
        status: 'rejected',
        reasons: ['Image resolution below minimum (500x500 required)'],
      }];
    }

    if (feedUrl) {
      result.next_fetch_at = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    }

    results.push(result);
  }

  return {
    ...(req.dry_run && { dry_run: true }),
    catalogs: results,
  };
}

export async function handleSyncEventSources(args: ToolArgs, ctx: TrainingContext) {
  const req = args as unknown as SyncEventSourcesInput;

  if (!req.account) {
    return {
      errors: [{ code: 'INVALID_REQUEST', message: 'account is required' }],
    };
  }

  const sessionKey = sessionKeyFromArgs(req, ctx.mode, ctx.userId, ctx.moduleId);
  const sources = getEventSourceMap(sessionKey);
  const now = new Date().toISOString();

  // Discovery mode
  if (!req.event_sources) {
    const existing = Array.from(sources.values()).map(s => ({
      event_source_id: s.eventSourceId,
      name: s.name,
      seller_id: s.sellerId,
      event_types: s.eventTypes,
      managed_by: 'buyer',
      action: 'unchanged',
    }));
    return { event_sources: existing };
  }

  const results: Record<string, unknown>[] = [];

  for (const input of req.event_sources) {
    if (!input.event_source_id || !input.name) {
      results.push({
        event_source_id: input.event_source_id || 'unknown',
        action: 'failed',
        errors: [{ code: 'INVALID_REQUEST', message: 'event_source_id and name are required' }],
      });
      continue;
    }

    const existing = sources.get(input.event_source_id);
    const sellerId = `es_${randomUUID().slice(0, 8)}`;

    const state: EventSourceState = {
      eventSourceId: input.event_source_id,
      name: input.name,
      sellerId: existing?.sellerId || sellerId,
      eventTypes: input.event_types || ['purchase', 'add_to_cart', 'page_view', 'lead'],
      allowedDomains: input.allowed_domains || [],
      action: existing ? 'updated' : 'created',
      createdAt: existing?.createdAt || now,
    };

    sources.set(input.event_source_id, state);

    results.push({
      event_source_id: state.eventSourceId,
      name: state.name,
      seller_id: state.sellerId,
      event_types: state.eventTypes,
      action_source: 'website',
      managed_by: 'buyer',
      setup: {
        snippet: `<!-- AdCP Event Pixel -->\n<script src="https://test-agent.adcontextprotocol.org/events/${state.sellerId}/pixel.js" async></script>`,
        snippet_type: 'javascript',
        instructions: `Add this snippet to every page where you want to track events. The pixel fires automatically for page_view events. For purchase and add_to_cart, call window.adcpEvent('${input.event_source_id}', { event_type: 'purchase', content_ids: ['item_123'], value: 29.99, currency: 'USD' }).`,
      },
      action: state.action,
    });
  }

  return { event_sources: results };
}

export async function handleLogEvent(args: ToolArgs, ctx: TrainingContext) {
  const req = args as unknown as LogEventInput;

  if (!req.event_source_id) {
    return {
      errors: [{ code: 'INVALID_REQUEST', message: 'event_source_id is required' }],
    };
  }

  if (!req.events || !Array.isArray(req.events) || req.events.length === 0) {
    return {
      errors: [{ code: 'INVALID_REQUEST', message: 'events array is required and must not be empty' }],
    };
  }

  // Validate event source exists. The request-level session key is fine when
  // the caller carries account/brand; when those are stripped by the SDK
  // against the published tool schema (log_event doesn't declare `account`),
  // the request hits `open:default` while sync_event_sources wrote under
  // `open:<brand.domain>`. Fall back to a global scan so a previously
  // synced source is still reachable.
  const sessionKey = sessionKeyFromArgs(req, ctx.mode, ctx.userId, ctx.moduleId);
  const sources = getEventSourceMap(sessionKey);
  // Session-key fallback: SDK-generated log_event schemas omit `account`,
  // so the request hits `open:default` while sync_event_sources wrote
  // under `open:<brand.domain>`. Cross-session scan first.
  // Sandbox permissiveness: if still not found, auto-register the source
  // so storyboards that don't call sync_event_sources first (e.g.
  // sales_social — buyer assumes the source was set up out-of-band) can
  // still grade the ingestion behaviour. Production agents reject the
  // unknown id; the training agent elides that step.
  if (!sources.has(req.event_source_id) && !findEventSourceAnywhere(req.event_source_id)) {
    const now = new Date().toISOString();
    sources.set(req.event_source_id, {
      eventSourceId: req.event_source_id,
      name: req.event_source_id,
      sellerId: 'sandbox-auto',
      eventTypes: ['page_view', 'purchase', 'add_to_cart', 'lead'],
      allowedDomains: [],
      action: 'auto_created',
      createdAt: now,
    });
  }

  // Validate each event has event_type
  const partialFailures: { event_id: string; code: string; message: string }[] = [];
  let processed = 0;

  for (let i = 0; i < req.events.length; i++) {
    const event = req.events[i];
    if (!event.event_type) {
      partialFailures.push({
        event_id: event.event_id || `event_${i}`,
        code: 'MISSING_EVENT_TYPE',
        message: 'event_type is required',
      });
      continue;
    }
    processed++;
  }

  const result: Record<string, unknown> = {
    events_received: req.events.length,
    events_processed: processed,
  };

  if (partialFailures.length > 0) {
    result.partial_failures = partialFailures;
  }

  // Simulate match quality based on whether content_ids are provided
  const hasContentIds = req.events.some(e => e.content_ids && e.content_ids.length > 0);
  result.match_quality = hasContentIds ? 0.85 : 0.42;

  if (req.test_event_code) {
    result.warnings = [`Test mode: events routed to test dashboard (code: ${req.test_event_code})`];
  }

  return result;
}

export async function handleProvidePerformanceFeedback(args: ToolArgs, ctx: TrainingContext) {
  const req = args as unknown as PerformanceFeedbackInput;

  if (!req.media_buy_id) {
    return {
      errors: [{ code: 'INVALID_REQUEST', message: 'media_buy_id is required' }],
    };
  }

  if (req.measurement_period == null || !req.measurement_period.start || !req.measurement_period.end) {
    return {
      errors: [{ code: 'INVALID_REQUEST', message: 'measurement_period with start and end is required' }],
    };
  }

  if (req.performance_index == null || req.performance_index < 0) {
    return {
      errors: [{ code: 'INVALID_REQUEST', message: 'performance_index must be >= 0' }],
    };
  }

  const compactValidationError = validateCompactPerformanceFeedback(req);
  if (compactValidationError) {
    return {
      errors: [{ code: 'INVALID_REQUEST', message: compactValidationError }],
    };
  }

  // Validate media buy exists. The request-level session key is fine when
  // the caller carries account/brand; when those are stripped by the SDK
  // against the published tool schema (framework's auto-generated
  // provide_performance_feedback schema omits `account`), the request hits
  // `open:default` while create_media_buy wrote under `open:<brand.domain>`.
  // Fall back to a global scan so the buy is still reachable.
  const sessionKey = sessionKeyFromArgs(req, ctx.mode, ctx.userId, ctx.moduleId);
  const session = await getSession(sessionKey);
  if (!session.mediaBuys.has(req.media_buy_id)) {
    const found = await findMediaBuyAcrossSessions(req.media_buy_id);
    if (!found) {
      return {
        errors: [{ code: 'MEDIA_BUY_NOT_FOUND', message: `Media buy '${req.media_buy_id}' not found. Create a media buy first via create_media_buy.` }],
      };
    }
  }

  const receivedAt = new Date().toISOString();
  const feedbackId = `fb_${randomUUID().replace(/-/g, '')}`;
  performanceFeedbackStore.set(feedbackId, {
    feedbackId,
    sessionKey,
    receivedAt,
    assertion: req,
  });

  return {
    success: true,
    feedback_id: feedbackId,
    application_status: 'accepted',
    received_at: receivedAt,
    media_buy_id: req.media_buy_id,
    measurement_period: req.measurement_period,
    performance_index: req.performance_index,
    ...(req.package_id && { package_id: req.package_id }),
    ...(req.creative_id && { creative_id: req.creative_id }),
    ...(req.baseline && { baseline: req.baseline }),
    ...(req.metric && { metric: req.metric }),
    ...(req.metric_type && { metric_type: req.metric_type }),
    ...(req.producer && { producer: req.producer }),
    ...(req.methodology && { methodology: req.methodology }),
    ...(req.study_ref && { study_ref: req.study_ref }),
  };
}
