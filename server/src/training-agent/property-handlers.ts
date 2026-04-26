/**
 * Property governance tool definitions and handlers for the training agent.
 *
 * Implements create_property_list, list_property_lists, get_property_list,
 * update_property_list, delete_property_list, and validate_property_delivery.
 * All state is per-session and deterministic.
 */

import { randomUUID } from 'node:crypto';
import type { TrainingContext, ToolArgs, AccountRef, PropertyListState } from './types.js';
import { getSession, sessionKeyFromArgs, MAX_PROPERTY_LISTS_PER_SESSION } from './state.js';
import { ACCOUNT_REF_SCHEMA } from './account-handlers.js';
import { encodeOffsetCursor, decodeOffsetCursor } from './pagination.js';

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
        account: ACCOUNT_REF_SCHEMA,
        name: { type: 'string', description: 'Human-readable name for the list' },
        description: { type: 'string', description: 'Description of the list purpose' },
        list_type: { type: 'string', enum: ['inclusion', 'exclusion'], description: 'Type of property list' },
        base_properties: { type: 'array', description: 'Property sources to include' },
        filters: { type: 'object', description: 'Dynamic filters for list resolution' },
        brand: { type: 'object', properties: { domain: { type: 'string' } }, description: 'Brand reference for automatic rule application (campaign metadata, not identity)' },
        idempotency_key: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_property_lists',
    description: 'List property lists owned by the given account (or all accessible accounts when account is omitted).',
    annotations: { readOnlyHint: true, idempotentHint: true },
    execution: { taskSupport: 'forbidden' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        account: ACCOUNT_REF_SCHEMA,
        name_contains: { type: 'string', description: 'Filter to lists whose name contains this string' },
        pagination: {
          type: 'object',
          properties: {
            max_results: { type: 'integer', minimum: 1, maximum: 100, description: 'Max lists per page (default 50, cap 100).' },
            cursor: { type: 'string', description: 'Continuation token from a previous list_property_lists response.' },
          },
        },
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
        account: ACCOUNT_REF_SCHEMA,
        resolve: { type: 'boolean', description: 'When true, return the resolved properties alongside list metadata' },
      },
      required: ['list_id'],
    },
  },
  {
    name: 'update_property_list',
    description: 'Update a property list. base_properties is a complete replacement, not a patch.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        list_id: { type: 'string', description: 'Property list identifier' },
        account: ACCOUNT_REF_SCHEMA,
        name: { type: 'string', description: 'New name for the list' },
        description: { type: 'string', description: 'New description' },
        base_properties: { type: 'array', description: 'Complete replacement for the base properties list' },
        filters: { type: 'object', description: 'Complete replacement for the filters' },
        brand: { type: 'object', properties: { domain: { type: 'string' } }, description: 'Update brand reference (campaign metadata)' },
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
        account: ACCOUNT_REF_SCHEMA,
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
        account: ACCOUNT_REF_SCHEMA,
        records: {
          type: 'array',
          description: 'Delivery records to validate. Each record has an identifier ({type, value}) and impressions.',
          items: {
            type: 'object',
            properties: {
              identifier: { type: 'object', properties: { type: { type: 'string' }, value: { type: 'string' } }, required: ['type', 'value'] },
              impressions: { type: 'integer', minimum: 0 },
              record_id: { type: 'string' },
            },
            required: ['identifier', 'impressions'],
          },
        },
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
    ...(state.account ? { account: state.account } : {}),
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
  const domains: string[] = [];
  for (const p of properties) {
    if (typeof p === 'string') {
      domains.push(p);
      continue;
    }
    if (typeof p !== 'object' || p === null) continue;
    const obj = p as Record<string, unknown>;
    if (typeof obj.domain === 'string') {
      domains.push(obj.domain);
      continue;
    }
    // Property selection shape: { selection_type: 'identifiers', identifiers: [{ type, value }] }
    if (Array.isArray(obj.identifiers)) {
      for (const ident of obj.identifiers) {
        if (typeof ident === 'object' && ident !== null) {
          const identObj = ident as { type?: string; value?: unknown };
          if ((identObj.type === 'domain' || identObj.type === 'subdomain') && typeof identObj.value === 'string') {
            domains.push(identObj.value);
          }
        }
      }
    }
  }
  return domains;
}

// ── Handlers ─────────────────────────────────────────────────────

export async function handleCreatePropertyList(
  args: ToolArgs,
  ctx: TrainingContext,
) {
  const req = args as {
    name: string;
    description?: string;
    list_type?: string;
    base_properties?: unknown[];
    filters?: unknown;
    brand?: unknown;
  };

  const session = await getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));

  if (session.propertyLists.size >= MAX_PROPERTY_LISTS_PER_SESSION) {
    return { errors: [{ code: 'LIMIT_EXCEEDED', message: `Session limit reached (max ${MAX_PROPERTY_LISTS_PER_SESSION} property lists).` }] };
  }

  const now = new Date().toISOString();
  const listId = `pl_${randomUUID().slice(0, 8)}`;
  const authToken = `pat_sandbox_${listId}_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

  const baseProperties = req.base_properties || [];

  if (baseProperties.length > MAX_PROPERTIES_PER_LIST) {
    return { errors: [{ code: 'LIMIT_EXCEEDED', message: `Too many properties (max ${MAX_PROPERTIES_PER_LIST}).` }] };
  }

  const state: PropertyListState = {
    listId,
    name: req.name,
    description: req.description,
    listType: req.list_type,
    account: args.account,
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
  };
}

export async function handleListPropertyLists(
  args: ToolArgs,
  ctx: TrainingContext,
) {
  const req = args as {
    name_contains?: string;
    pagination?: { max_results?: number; cursor?: string };
  };
  const session = await getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));

  let lists = [...session.propertyLists.values()];

  if (req.name_contains) {
    const lowerFilter = req.name_contains.toLowerCase();
    lists = lists.filter(l => l.name.toLowerCase().includes(lowerFilter));
  }

  const totalMatching = lists.length;
  const requestedMax = req.pagination?.max_results;
  const maxResults = Math.min(typeof requestedMax === 'number' ? requestedMax : 50, 100);
  const offset = decodeOffsetCursor('property_lists', req.pagination?.cursor);
  if (offset === null) {
    return { errors: [{ code: 'INVALID_REQUEST', message: 'pagination.cursor is malformed' }] };
  }
  const pageEnd = Math.min(offset + maxResults, totalMatching);
  const pageLists = lists.slice(offset, pageEnd);
  const hasMore = pageEnd < totalMatching;

  return {
    lists: pageLists.map(toListResponse),
    pagination: {
      has_more: hasMore,
      total_count: totalMatching,
      ...(hasMore && { cursor: encodeOffsetCursor('property_lists', pageEnd) }),
    },
  };
}

export async function handleGetPropertyList(
  args: ToolArgs,
  ctx: TrainingContext,
) {
  const req = args as { list_id: string };
  const session = await getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));

  const state = session.propertyLists.get(req.list_id);
  if (!state) {
    return { errors: [{ code: 'REFERENCE_NOT_FOUND', message: 'Property list not found', field: 'list_id' }] };
  }

  const domains = extractDomains(state.baseProperties);
  const identifiers = domains.map(d => ({ type: 'domain', value: d }));

  return {
    list: toListResponse(state),
    identifiers,
    resolved_at: new Date().toISOString(),
    cache_valid_until: new Date(Date.now() + state.cacheDurationHours * 3600_000).toISOString(),
  };
}

export async function handleUpdatePropertyList(
  args: ToolArgs,
  ctx: TrainingContext,
) {
  const req = args as { list_id: string; name?: string; description?: string; base_properties?: unknown[]; filters?: unknown; brand?: unknown };
  const session = await getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));

  const state = session.propertyLists.get(req.list_id);
  if (!state) {
    return { errors: [{ code: 'REFERENCE_NOT_FOUND', message: 'Property list not found', field: 'list_id' }] };
  }

  if (req.name) {
    state.name = req.name;
  }

  if (req.description !== undefined) {
    state.description = req.description;
  }

  // Per spec: base_properties is a complete replacement, not a patch
  if (req.base_properties) {
    if (req.base_properties.length > MAX_PROPERTIES_PER_LIST) {
      return { errors: [{ code: 'LIMIT_EXCEEDED', message: `Update would exceed max properties per list (${MAX_PROPERTIES_PER_LIST}).` }] };
    }
    state.baseProperties = req.base_properties;
  }

  if (req.filters !== undefined) {
    state.filters = req.filters;
  }

  if (req.brand !== undefined) {
    state.brand = req.brand;
  }

  state.propertyCount = state.baseProperties.length;
  state.updatedAt = new Date().toISOString();

  return {
    list: toListResponse(state),
  };
}

export async function handleDeletePropertyList(
  args: ToolArgs,
  ctx: TrainingContext,
) {
  const req = args as { list_id: string };
  const session = await getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));

  const existed = session.propertyLists.delete(req.list_id);
  if (!existed) {
    return { errors: [{ code: 'REFERENCE_NOT_FOUND', message: 'Property list not found', field: 'list_id' }] };
  }

  return { list_id: req.list_id, deleted: true };
}

export async function handleValidatePropertyDelivery(
  args: ToolArgs,
  ctx: TrainingContext,
) {
  const req = args as {
    list_id: string;
    records: Array<{ identifier: { type: string; value: string }; impressions: number; record_id?: string }>;
  };

  const session = await getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));

  const state = session.propertyLists.get(req.list_id);
  if (!state) {
    return { errors: [{ code: 'REFERENCE_NOT_FOUND', message: 'Property list not found', field: 'list_id' }] };
  }

  const records = req.records || [];
  const listDomains = new Set(extractDomains(state.baseProperties));
  const isInclusion = state.listType !== 'exclusion';

  let compliantRecords = 0;
  let compliantImpressions = 0;
  let nonCompliantRecords = 0;
  let nonCompliantImpressions = 0;

  const results = records.map(record => {
    const domain = record.identifier?.value || '';
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

    // Per validation-result.json (additionalProperties: false), allowed
    // keys are identifier, record_id, status, impressions, features,
    // authorization, ext. Violations belong in `features[]` as the spec's
    // machine-readable channel — a "record:list_membership" feature with
    // status: failed carries the same signal.
    return {
      identifier: { type: 'domain', value: domain },
      ...(record.record_id ? { record_id: record.record_id } : {}),
      status: compliant ? 'compliant' : 'non_compliant',
      impressions,
      ...(!compliant ? {
        features: [{
          feature_id: 'record:list_membership',
          status: 'failed',
          explanation: isInclusion
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
  };
}
