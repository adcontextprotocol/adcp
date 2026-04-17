/**
 * Catalog and event tracking handlers for the training agent.
 *
 * Implements sync_catalogs, sync_event_sources, log_event,
 * and provide_performance_feedback per AdCP schemas.
 */

import { randomUUID } from 'node:crypto';
import type { TrainingContext, ToolArgs, AccountRef } from './types.js';
import { getSession, sessionKeyFromArgs } from './state.js';

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
  catalog_type: string;
  name?: string;
  feed_url?: string;
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
  metric_type?: string;
  feedback_source?: string;
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

const catalogStore = new Map<string, Map<string, CatalogState>>();
const eventSourceStore = new Map<string, Map<string, EventSourceState>>();

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

/** Exported for testing */
export function clearCatalogEventStores(): void {
  catalogStore.clear();
  eventSourceStore.clear();
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
              catalog_type: { type: 'string', enum: ['product', 'offering', 'inventory', 'store', 'promotion', 'hotel', 'flight', 'job', 'vehicle', 'real_estate', 'education', 'destination'] },
              name: { type: 'string' },
              feed_url: { type: 'string', format: 'uri' },
              items: { type: 'array' },
            },
            required: ['catalog_id', 'catalog_type'],
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
    description: 'Submit optimization signals to the seller. Performance index: 0.0 = no value, 1.0 = meeting expectations, >1.0 = exceeding. Scope to a specific package or creative, or provide overall buy-level feedback.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    execution: { taskSupport: 'forbidden' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
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
        metric_type: { type: 'string', enum: ['overall_performance', 'conversion_rate', 'roas', 'cpa', 'engagement_rate'] },
        feedback_source: { type: 'string', enum: ['buyer_attribution', 'third_party_measurement', 'blended'] },
        feedback: { type: 'object', description: 'Structured feedback object (alternative to flat fields)' },
        idempotency_key: { type: 'string' },
      },
      required: ['media_buy_id', 'measurement_period', 'performance_index'],
    },
  },
];

// ── Handler implementations ─────────────────────────────────────

const VALID_CATALOG_TYPES = ['product', 'offering', 'inventory', 'store', 'promotion', 'hotel', 'flight', 'job', 'vehicle', 'real_estate', 'education', 'destination'];

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
      catalog_type: c.catalogType,
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

    if (!input.catalog_type || !VALID_CATALOG_TYPES.includes(input.catalog_type)) {
      results.push({
        catalog_id: input.catalog_id,
        action: 'failed',
        errors: [{ code: 'INVALID_REQUEST', message: `catalog_type must be one of: ${VALID_CATALOG_TYPES.join(', ')}` }],
      });
      continue;
    }

    const existing = catalogs.get(input.catalog_id);
    const itemCount = input.items?.length || (input.feed_url ? 50 : 0); // Simulate feed fetch
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
      catalogType: input.catalog_type,
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

    if (input.feed_url) {
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

  // Validate event source exists in session
  const sessionKey = sessionKeyFromArgs(req, ctx.mode, ctx.userId, ctx.moduleId);
  const sources = getEventSourceMap(sessionKey);
  if (!sources.has(req.event_source_id)) {
    return {
      errors: [{ code: 'EVENT_SOURCE_NOT_FOUND', message: `Event source '${req.event_source_id}' not found. Call sync_event_sources first to configure the event source.` }],
    };
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

  // Validate media buy exists in session
  const sessionKey = sessionKeyFromArgs(req, ctx.mode, ctx.userId, ctx.moduleId);
  const session = await getSession(sessionKey);
  if (!session.mediaBuys.has(req.media_buy_id)) {
    return {
      errors: [{ code: 'MEDIA_BUY_NOT_FOUND', message: `Media buy '${req.media_buy_id}' not found. Create a media buy first via create_media_buy.` }],
    };
  }

  return {
    success: true,
    media_buy_id: req.media_buy_id,
    measurement_period: req.measurement_period,
    performance_index: req.performance_index,
    ...(req.package_id && { package_id: req.package_id }),
    ...(req.metric_type && { metric_type: req.metric_type }),
  };
}
