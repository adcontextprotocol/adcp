/**
 * Property governance tool definitions and handlers for the training agent.
 *
 * Implements create_property_list, list_property_lists, get_property_list,
 * update_property_list, delete_property_list, and validate_property_delivery.
 * All state is per-session and deterministic.
 */

import { randomUUID } from 'node:crypto';
import type { TrainingContext, ToolArgs, PropertyListState } from './types.js';
import { getSession, sessionKeyFromArgs, MAX_PROPERTY_LISTS_PER_SESSION } from './state.js';

const MAX_PROPERTIES_PER_LIST = 10_000;

// ── Tool definitions ─────────────────────────────────────────────

export const PROPERTY_TOOLS = [
  {
    name: 'create_property_list',
    description: 'Create a brand safety property list (inclusion or exclusion). Returns the list metadata and an auth token for sharing with sellers.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Human-readable name for the list' },
        description: { type: 'string', description: 'Description of the list purpose' },
        list_type: { type: 'string', enum: ['inclusion', 'exclusion'], description: 'Type of property list' },
        base_properties: { type: 'array', description: 'Property sources to include' },
        properties: { type: 'array', description: 'Simple property list (array of {domain})' },
        filters: { type: 'object', description: 'Dynamic filters for list resolution' },
        brand: { type: 'object', description: 'Brand reference for automatic rule application' },
        idempotency_key: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_property_lists',
    description: 'List all property lists for the current account. Returns list metadata without resolved properties.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    execution: { taskSupport: 'forbidden' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        brand: { type: 'object', description: 'Filter by brand' },
        list_type: { type: 'string', enum: ['inclusion', 'exclusion'], description: 'Filter by list type' },
      },
    },
  },
  {
    name: 'get_property_list',
    description: 'Get a specific property list by ID, including its properties.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    execution: { taskSupport: 'forbidden' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        list_id: { type: 'string', description: 'Property list identifier' },
      },
      required: ['list_id'],
    },
  },
  {
    name: 'update_property_list',
    description: 'Update a property list — add or remove properties.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        list_id: { type: 'string', description: 'Property list identifier' },
        add: { type: 'array', description: 'Properties to add' },
        remove: { type: 'array', description: 'Properties to remove' },
        name: { type: 'string', description: 'New name for the list' },
      },
      required: ['list_id'],
    },
  },
  {
    name: 'delete_property_list',
    description: 'Delete a property list.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    execution: { taskSupport: 'forbidden' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        list_id: { type: 'string', description: 'Property list identifier' },
      },
      required: ['list_id'],
    },
  },
  {
    name: 'validate_property_delivery',
    description: 'Validate that ad delivery complied with a property list. Checks each delivery record against the inclusion/exclusion list.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        list_id: { type: 'string', description: 'Property list to validate against' },
        brand: { type: 'object', description: 'Brand reference' },
        records: { type: 'array', description: 'Delivery records to validate' },
        delivery: { type: 'array', description: 'Delivery records (alias for records)' },
      },
      required: ['list_id', 'records'],
    },
  },
];

// ── Helpers ───────────────────────────────────────────────────────

function toListResponse(state: PropertyListState) {
  return {
    list_id: state.listId,
    name: state.name,
    ...(state.description ? { description: state.description } : {}),
    ...(state.listType ? { list_type: state.listType } : {}),
    ...(state.principal ? { principal: state.principal } : {}),
    ...(state.baseProperties.length > 0 ? { base_properties: state.baseProperties } : {}),
    ...(state.filters ? { filters: state.filters } : {}),
    ...(state.brand ? { brand: state.brand } : {}),
    ...(state.webhookUrl ? { webhook_url: state.webhookUrl } : {}),
    cache_duration_hours: state.cacheDurationHours,
    property_count: state.propertyCount,
    created_at: state.createdAt,
    updated_at: state.updatedAt,
  };
}

function extractDomains(properties: unknown[]): string[] {
  return properties
    .map(p => {
      if (typeof p === 'string') return p;
      if (typeof p === 'object' && p !== null && 'domain' in p) return (p as { domain: string }).domain;
      return null;
    })
    .filter((d): d is string => d !== null);
}

// ── Handlers ─────────────────────────────────────────────────────

export function handleCreatePropertyList(
  args: ToolArgs,
  ctx: TrainingContext,
) {
  const req = args as {
    name: string;
    description?: string;
    list_type?: string;
    base_properties?: unknown[];
    properties?: unknown[];
    filters?: unknown;
    brand?: unknown;
  };

  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));

  if (session.propertyLists.size >= MAX_PROPERTY_LISTS_PER_SESSION) {
    return { errors: [{ code: 'LIMIT_EXCEEDED', message: `Session limit reached (max ${MAX_PROPERTY_LISTS_PER_SESSION} property lists).` }] };
  }

  const now = new Date().toISOString();
  const listId = `pl_${randomUUID().slice(0, 8)}`;
  const authToken = `pat_sandbox_${listId}_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

  // Accept either base_properties (schema) or properties (storyboard)
  const baseProperties = req.base_properties || req.properties || [];

  if (baseProperties.length > MAX_PROPERTIES_PER_LIST) {
    return { errors: [{ code: 'LIMIT_EXCEEDED', message: `Too many properties (max ${MAX_PROPERTIES_PER_LIST}).` }] };
  }

  const state: PropertyListState = {
    listId,
    name: req.name,
    description: req.description,
    listType: req.list_type,
    baseProperties,
    filters: req.filters,
    brand: req.brand,
    cacheDurationHours: 24,
    propertyCount: baseProperties.length,
    authToken,
    createdAt: now,
    updatedAt: now,
  };

  session.propertyLists.set(listId, state);

  return {
    list: toListResponse(state),
    auth_token: authToken,
    sandbox: true,
  };
}

export function handleListPropertyLists(
  args: ToolArgs,
  ctx: TrainingContext,
) {
  const req = args as { brand?: unknown; list_type?: string };
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));

  let lists = [...session.propertyLists.values()];

  if (req.list_type) {
    lists = lists.filter(l => l.listType === req.list_type);
  }

  return {
    lists: lists.map(toListResponse),
    sandbox: true,
  };
}

export function handleGetPropertyList(
  args: ToolArgs,
  ctx: TrainingContext,
) {
  const req = args as { list_id: string };
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));

  const state = session.propertyLists.get(req.list_id);
  if (!state) {
    return { errors: [{ code: 'not_found', message: `No property list with id '${req.list_id}'` }] };
  }

  const domains = extractDomains(state.baseProperties);
  const identifiers = domains.map(d => ({ type: 'domain', value: d }));

  return {
    list: toListResponse(state),
    identifiers,
    resolved_at: new Date().toISOString(),
    cache_valid_until: new Date(Date.now() + state.cacheDurationHours * 3600_000).toISOString(),
    sandbox: true,
  };
}

export function handleUpdatePropertyList(
  args: ToolArgs,
  ctx: TrainingContext,
) {
  const req = args as { list_id: string; add?: unknown[]; remove?: unknown[]; name?: string; description?: string; base_properties?: unknown[] };
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));

  const state = session.propertyLists.get(req.list_id);
  if (!state) {
    return { errors: [{ code: 'not_found', message: `No property list with id '${req.list_id}'` }] };
  }

  if (req.name) {
    state.name = req.name;
  }

  if (req.description !== undefined) {
    state.description = req.description;
  }

  // Replace mode: base_properties replaces entire list
  if (req.base_properties) {
    if (req.base_properties.length > MAX_PROPERTIES_PER_LIST) {
      return { errors: [{ code: 'LIMIT_EXCEEDED', message: `Update would exceed max properties per list (${MAX_PROPERTIES_PER_LIST}).` }] };
    }
    state.baseProperties = req.base_properties;
  } else {
    // Incremental mode: add/remove
    const existingDomains = new Set(extractDomains(state.baseProperties));

    if (req.add) {
      if (state.baseProperties.length + req.add.length > MAX_PROPERTIES_PER_LIST) {
        return { errors: [{ code: 'LIMIT_EXCEEDED', message: `Update would exceed max properties per list (${MAX_PROPERTIES_PER_LIST}).` }] };
      }
      for (const p of req.add) {
        const domain = typeof p === 'string' ? p : (p as { domain?: string }).domain;
        if (domain && !existingDomains.has(domain)) {
          state.baseProperties.push(p);
          existingDomains.add(domain);
        }
      }
    }

    if (req.remove) {
      const removeDomains = new Set(extractDomains(req.remove));
      state.baseProperties = state.baseProperties.filter(p => {
        const domain = typeof p === 'string' ? p : (p as { domain?: string }).domain;
        return !domain || !removeDomains.has(domain);
      });
    }
  }

  state.propertyCount = state.baseProperties.length;
  state.updatedAt = new Date().toISOString();

  return {
    list: toListResponse(state),
    sandbox: true,
  };
}

export function handleDeletePropertyList(
  args: ToolArgs,
  ctx: TrainingContext,
) {
  const req = args as { list_id: string };
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));

  const existed = session.propertyLists.delete(req.list_id);
  if (!existed) {
    return { errors: [{ code: 'not_found', message: `No property list with id '${req.list_id}'` }] };
  }

  return {
    list_id: req.list_id,
    deleted: true,
    sandbox: true,
  };
}

export function handleValidatePropertyDelivery(
  args: ToolArgs,
  ctx: TrainingContext,
) {
  const req = args as {
    list_id: string;
    brand?: unknown;
    records?: Array<{ property?: string; domain?: string; impressions?: number; record_id?: string }>;
    delivery?: Array<{ property?: string; domain?: string; impressions?: number; record_id?: string }>;
  };

  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));

  const state = session.propertyLists.get(req.list_id);
  if (!state) {
    return { errors: [{ code: 'not_found', message: `No property list with id '${req.list_id}'` }] };
  }

  // Accept both records (schema) and delivery (storyboard)
  const records = req.records || req.delivery || [];
  const listDomains = new Set(extractDomains(state.baseProperties));
  const isInclusion = state.listType !== 'exclusion';

  let compliantRecords = 0;
  let compliantImpressions = 0;
  let nonCompliantRecords = 0;
  let nonCompliantImpressions = 0;

  const results = records.map(record => {
    const domain = record.property || record.domain || '';
    const impressions = record.impressions || 0;
    const inList = listDomains.has(domain);
    const compliant = isInclusion ? inList : !inList;

    if (compliant) {
      compliantRecords++;
      compliantImpressions += impressions;
    } else {
      nonCompliantRecords++;
      nonCompliantImpressions += impressions;
    }

    return {
      identifier: { type: 'domain', value: domain },
      ...(record.record_id ? { record_id: record.record_id } : {}),
      status: compliant ? 'compliant' : 'non_compliant',
      impressions,
      ...(!compliant ? {
        violations: [{
          code: isInclusion ? 'not_in_inclusion_list' : 'in_exclusion_list',
          message: isInclusion
            ? `Property '${domain}' is not in inclusion list '${state.name}'`
            : `Property '${domain}' is in exclusion list '${state.name}'`,
        }],
      } : {}),
    };
  });

  const totalImpressions = compliantImpressions + nonCompliantImpressions;

  return {
    compliant: nonCompliantRecords === 0,
    list_id: req.list_id,
    summary: {
      total_records: records.length,
      total_impressions: totalImpressions,
      compliant_records: compliantRecords,
      compliant_impressions: compliantImpressions,
      non_compliant_records: nonCompliantRecords,
      non_compliant_impressions: nonCompliantImpressions,
      not_covered_records: 0,
      not_covered_impressions: 0,
      unidentified_records: 0,
      unidentified_impressions: 0,
    },
    results,
    validated_at: new Date().toISOString(),
    sandbox: true,
  };
}
