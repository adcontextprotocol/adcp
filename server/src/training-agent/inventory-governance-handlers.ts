/**
 * Inventory governance handlers for the training agent.
 *
 * Implements property list, collection list, and content standards CRUD
 * with in-memory session storage. These enable S4 governance certification
 * labs to exercise all three layers of brand safety.
 */

import { randomUUID } from 'node:crypto';
import type { TrainingContext, ToolArgs, PropertyListState, CollectionListState, ContentStandardState } from './types.js';
import { getSession, sessionKeyFromArgs } from './state.js';

const MAX_ARRAY_INPUT = 100;

// ── Tool definitions ─────────────────────────────────────────────

export const PROPERTY_LIST_TOOLS = [
  {
    name: 'create_property_list',
    description: 'Create a property list for brand safety and inventory targeting.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        base_properties: { type: 'array' },
        filters: { type: 'object' },
        brand: { type: 'object', properties: { domain: { type: 'string' } } },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_property_list',
    description: 'Retrieve a property list with optional resolution.',
    annotations: { readOnlyHint: true },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        list_id: { type: 'string' },
        resolve: { type: 'boolean' },
      },
      required: ['list_id'],
    },
  },
  {
    name: 'update_property_list',
    description: 'Modify an existing property list.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        list_id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        base_properties: { type: 'array' },
        filters: { type: 'object' },
        webhook_url: { type: 'string' },
      },
      required: ['list_id'],
    },
  },
  {
    name: 'list_property_lists',
    description: 'List property lists for the authenticated principal.',
    annotations: { readOnlyHint: true },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        name_contains: { type: 'string' },
      },
    },
  },
  {
    name: 'delete_property_list',
    description: 'Delete a property list.',
    annotations: { readOnlyHint: false, destructiveHint: true },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        list_id: { type: 'string' },
      },
      required: ['list_id'],
    },
  },
];

export const COLLECTION_LIST_TOOLS = [
  {
    name: 'create_collection_list',
    description: 'Create a collection list for program-level brand safety. Uses distribution identifiers for cross-publisher matching.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        base_collections: { type: 'array' },
        filters: { type: 'object' },
        brand: { type: 'object', properties: { domain: { type: 'string' } } },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_collection_list',
    description: 'Retrieve a collection list with optional resolution.',
    annotations: { readOnlyHint: true },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        list_id: { type: 'string' },
        resolve: { type: 'boolean' },
      },
      required: ['list_id'],
    },
  },
  {
    name: 'update_collection_list',
    description: 'Modify an existing collection list.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        list_id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        base_collections: { type: 'array' },
        filters: { type: 'object' },
        webhook_url: { type: 'string' },
      },
      required: ['list_id'],
    },
  },
  {
    name: 'list_collection_lists',
    description: 'List collection lists for the authenticated principal.',
    annotations: { readOnlyHint: true },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        name_contains: { type: 'string' },
      },
    },
  },
  {
    name: 'delete_collection_list',
    description: 'Delete a collection list.',
    annotations: { readOnlyHint: false, destructiveHint: true },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        list_id: { type: 'string' },
      },
      required: ['list_id'],
    },
  },
];

export const CONTENT_STANDARDS_TOOLS = [
  {
    name: 'create_content_standards',
    description: 'Create content standards for brand safety evaluation.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string' },
        countries_all: { type: 'array', items: { type: 'string' } },
        channels_any: { type: 'array', items: { type: 'string' } },
        languages_any: { type: 'array', items: { type: 'string' } },
        policy: { type: 'string' },
        calibration_exemplars: { type: 'array' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_content_standards',
    description: 'Retrieve a content standards configuration.',
    annotations: { readOnlyHint: true },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        standards_id: { type: 'string' },
      },
      required: ['standards_id'],
    },
  },
  {
    name: 'update_content_standards',
    description: 'Modify an existing content standards configuration.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        standards_id: { type: 'string' },
        name: { type: 'string' },
        policy: { type: 'string' },
        calibration_exemplars: { type: 'array' },
      },
      required: ['standards_id'],
    },
  },
  {
    name: 'list_content_standards',
    description: 'List content standards for the authenticated principal.',
    annotations: { readOnlyHint: true },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        name_contains: { type: 'string' },
      },
    },
  },
  {
    name: 'calibrate_content',
    description: 'Evaluate content against standards and return calibration results.',
    annotations: { readOnlyHint: true },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        standards_id: { type: 'string' },
        artifacts: { type: 'array' },
      },
      required: ['standards_id'],
    },
  },
  {
    name: 'validate_content_delivery',
    description: 'Validate that delivered content met content standards.',
    annotations: { readOnlyHint: true },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        standards_id: { type: 'string' },
        media_buy_id: { type: 'string' },
      },
      required: ['standards_id'],
    },
  },
];

// ── Input types ──────────────────────────────────────────────────

interface CreateListInput extends ToolArgs {
  name: string;
  description?: string;
  base_properties?: unknown[];
  base_collections?: unknown[];
  filters?: Record<string, unknown>;
  brand?: { domain: string };
}

interface GetListInput extends ToolArgs {
  list_id: string;
  resolve?: boolean;
}

interface UpdatePropertyListInput extends ToolArgs {
  list_id: string;
  name?: string;
  description?: string;
  base_properties?: unknown[];
  filters?: Record<string, unknown>;
  webhook_url?: string;
}

interface UpdateCollectionListInput extends ToolArgs {
  list_id: string;
  name?: string;
  description?: string;
  base_collections?: unknown[];
  filters?: Record<string, unknown>;
  webhook_url?: string;
}

interface ListInput extends ToolArgs {
  name_contains?: string;
}

interface DeleteInput extends ToolArgs {
  list_id: string;
}

interface CreateContentStandardsInput extends ToolArgs {
  name: string;
  countries_all?: string[];
  channels_any?: string[];
  languages_any?: string[];
  policy?: string;
  calibration_exemplars?: unknown[];
}

interface UpdateContentStandardsInput extends ToolArgs {
  standards_id: string;
  name?: string;
  policy?: string;
  calibration_exemplars?: unknown[];
}

interface CalibrateInput extends ToolArgs {
  standards_id: string;
  artifacts?: Array<{ url?: string; artifact_id?: string }>;
}

interface ValidateDeliveryInput extends ToolArgs {
  standards_id: string;
  media_buy_id?: string;
}

// ── Property list handlers ───────────────────────────────────────

export function handleCreatePropertyList(args: ToolArgs, ctx: TrainingContext) {
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));
  const input = args as CreateListInput;

  if (!input.name) {
    return { errors: [{ code: 'VALIDATION_ERROR', message: 'name is required' }] };
  }

  const now = new Date().toISOString();
  const listId = `pl_${randomUUID().slice(0, 8)}`;
  const baseProps = (input.base_properties ?? []).slice(0, MAX_ARRAY_INPUT);
  const state: PropertyListState = {
    list_id: listId,
    name: input.name,
    description: input.description,
    base_properties: baseProps,
    filters: input.filters,
    brand: input.brand,
    property_count: baseProps.length ? countSources(baseProps) : 0,
    created_at: now,
    updated_at: now,
  };

  session.propertyLists.set(listId, state);

  return {
    list: state,
    auth_token: `tok_${randomUUID().slice(0, 16)}`,
  };
}

export function handleGetPropertyList(args: ToolArgs, ctx: TrainingContext) {
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));
  const input = args as GetListInput;

  const list = session.propertyLists.get(input.list_id);
  if (!list) return { errors: [{ code: 'NOT_FOUND', message: `Property list ${input.list_id} not found` }] };

  const now = new Date().toISOString();
  return {
    list,
    identifiers: input.resolve ? generateSampleIdentifiers(list.property_count) : undefined,
    resolved_at: input.resolve ? now : undefined,
    cache_valid_until: input.resolve ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() : undefined,
  };
}

export function handleUpdatePropertyList(args: ToolArgs, ctx: TrainingContext) {
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));
  const input = args as UpdatePropertyListInput;

  const list = session.propertyLists.get(input.list_id);
  if (!list) return { errors: [{ code: 'NOT_FOUND', message: `Property list ${input.list_id} not found` }] };

  if (input.name !== undefined) list.name = input.name;
  if (input.description !== undefined) list.description = input.description;
  if (input.base_properties !== undefined) {
    const clamped = input.base_properties.slice(0, MAX_ARRAY_INPUT);
    list.base_properties = clamped;
    list.property_count = countSources(clamped);
  }
  if (input.filters !== undefined) list.filters = input.filters;
  if (input.webhook_url !== undefined) list.webhook_url = input.webhook_url === '' ? undefined : input.webhook_url;
  list.updated_at = new Date().toISOString();

  return { list };
}

export function handleListPropertyLists(args: ToolArgs, ctx: TrainingContext) {
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));
  const input = args as ListInput;
  const lists = Array.from(session.propertyLists.values());
  const filtered = input.name_contains
    ? lists.filter(l => l.name.toLowerCase().includes(input.name_contains!.toLowerCase()))
    : lists;
  return { lists: filtered, pagination: { has_more: false } };
}

export function handleDeletePropertyList(args: ToolArgs, ctx: TrainingContext) {
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));
  const input = args as DeleteInput;
  const deleted = session.propertyLists.delete(input.list_id);
  return { deleted, list_id: input.list_id };
}

// ── Collection list handlers ─────────────────────────────────────

export function handleCreateCollectionList(args: ToolArgs, ctx: TrainingContext) {
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));
  const input = args as CreateListInput;

  if (!input.name) {
    return { errors: [{ code: 'VALIDATION_ERROR', message: 'name is required' }] };
  }

  const now = new Date().toISOString();
  const listId = `cl_${randomUUID().slice(0, 8)}`;
  const baseColls = (input.base_collections ?? []).slice(0, MAX_ARRAY_INPUT);
  const state: CollectionListState = {
    list_id: listId,
    name: input.name,
    description: input.description,
    base_collections: baseColls,
    filters: input.filters,
    brand: input.brand,
    collection_count: baseColls.length ? countSources(baseColls) : 0,
    created_at: now,
    updated_at: now,
  };

  session.collectionLists.set(listId, state);

  return {
    list: state,
    auth_token: `tok_${randomUUID().slice(0, 16)}`,
  };
}

export function handleGetCollectionList(args: ToolArgs, ctx: TrainingContext) {
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));
  const input = args as GetListInput;

  const list = session.collectionLists.get(input.list_id);
  if (!list) return { errors: [{ code: 'NOT_FOUND', message: `Collection list ${input.list_id} not found` }] };

  const now = new Date().toISOString();
  return {
    list,
    collections: input.resolve ? generateSampleCollections(list.collection_count) : undefined,
    resolved_at: input.resolve ? now : undefined,
    cache_valid_until: input.resolve ? new Date(Date.now() + 168 * 60 * 60 * 1000).toISOString() : undefined,
  };
}

export function handleUpdateCollectionList(args: ToolArgs, ctx: TrainingContext) {
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));
  const input = args as UpdateCollectionListInput;

  const list = session.collectionLists.get(input.list_id);
  if (!list) return { errors: [{ code: 'NOT_FOUND', message: `Collection list ${input.list_id} not found` }] };

  if (input.name !== undefined) list.name = input.name;
  if (input.description !== undefined) list.description = input.description;
  if (input.base_collections !== undefined) {
    const clamped = input.base_collections.slice(0, MAX_ARRAY_INPUT);
    list.base_collections = clamped;
    list.collection_count = countSources(clamped);
  }
  if (input.filters !== undefined) list.filters = input.filters;
  if (input.webhook_url !== undefined) list.webhook_url = input.webhook_url === '' ? undefined : input.webhook_url;
  list.updated_at = new Date().toISOString();

  return { list };
}

export function handleListCollectionLists(args: ToolArgs, ctx: TrainingContext) {
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));
  const input = args as ListInput;
  const lists = Array.from(session.collectionLists.values());
  const filtered = input.name_contains
    ? lists.filter(l => l.name.toLowerCase().includes(input.name_contains!.toLowerCase()))
    : lists;
  return { lists: filtered, pagination: { has_more: false } };
}

export function handleDeleteCollectionList(args: ToolArgs, ctx: TrainingContext) {
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));
  const input = args as DeleteInput;
  const deleted = session.collectionLists.delete(input.list_id);
  return { deleted, list_id: input.list_id };
}

// ── Content standards handlers ───────────────────────────────────

export function handleCreateContentStandards(args: ToolArgs, ctx: TrainingContext) {
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));
  const input = args as CreateContentStandardsInput;

  if (!input.name) {
    return { errors: [{ code: 'VALIDATION_ERROR', message: 'name is required' }] };
  }

  const now = new Date().toISOString();
  const standardsId = `cs_${randomUUID().slice(0, 8)}`;
  const state: ContentStandardState = {
    standards_id: standardsId,
    name: input.name,
    countries_all: input.countries_all,
    channels_any: input.channels_any,
    languages_any: input.languages_any,
    policy: input.policy,
    calibration_exemplars: (input.calibration_exemplars ?? []).slice(0, MAX_ARRAY_INPUT),
    created_at: now,
    updated_at: now,
  };

  session.contentStandards.set(standardsId, state);

  return { standards: state };
}

export function handleGetContentStandards(args: ToolArgs, ctx: TrainingContext) {
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));
  const input = args as ToolArgs & { standards_id: string };

  const standards = session.contentStandards.get(input.standards_id);
  if (!standards) return { errors: [{ code: 'NOT_FOUND', message: `Content standards ${input.standards_id} not found` }] };

  return { standards };
}

export function handleUpdateContentStandards(args: ToolArgs, ctx: TrainingContext) {
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));
  const input = args as UpdateContentStandardsInput;

  const standards = session.contentStandards.get(input.standards_id);
  if (!standards) return { errors: [{ code: 'NOT_FOUND', message: `Content standards ${input.standards_id} not found` }] };

  if (input.name !== undefined) standards.name = input.name;
  if (input.policy !== undefined) standards.policy = input.policy;
  if (input.calibration_exemplars !== undefined) standards.calibration_exemplars = input.calibration_exemplars.slice(0, MAX_ARRAY_INPUT);
  standards.updated_at = new Date().toISOString();

  return { standards };
}

export function handleListContentStandards(args: ToolArgs, ctx: TrainingContext) {
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));
  const input = args as ListInput;
  const all = Array.from(session.contentStandards.values());
  const filtered = input.name_contains
    ? all.filter(s => s.name.toLowerCase().includes(input.name_contains!.toLowerCase()))
    : all;
  return { standards: filtered, pagination: { has_more: false } };
}

export function handleCalibrateContent(args: ToolArgs, ctx: TrainingContext) {
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));
  const input = args as CalibrateInput;

  const standards = session.contentStandards.get(input.standards_id);
  if (!standards) return { errors: [{ code: 'NOT_FOUND', message: `Content standards ${input.standards_id} not found` }] };

  const artifacts = (input.artifacts ?? []).slice(0, MAX_ARRAY_INPUT);
  const results = artifacts.map((artifact, i) => ({
    artifact_id: artifact.artifact_id ?? artifact.url ?? `artifact_${i}`,
    result: i % 3 === 0 ? 'fail' : 'pass',
    confidence: 0.85 + ((i * 7 + 3) % 15) / 100,
    explanation: i % 3 === 0
      ? 'Content does not meet the defined standards based on policy evaluation.'
      : 'Content meets the defined standards.',
  }));

  return { standards_id: input.standards_id, results };
}

export function handleValidateContentDelivery(args: ToolArgs, ctx: TrainingContext) {
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));
  const input = args as ValidateDeliveryInput;

  const standards = session.contentStandards.get(input.standards_id);
  if (!standards) return { errors: [{ code: 'NOT_FOUND', message: `Content standards ${input.standards_id} not found` }] };

  return {
    standards_id: input.standards_id,
    media_buy_id: input.media_buy_id,
    validation: {
      total_impressions: 125000,
      compliant_impressions: 121500,
      non_compliant_impressions: 3500,
      compliance_rate: 0.972,
      status: 'passed',
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────

function countSources(sources: unknown[]): number {
  let count = 0;
  for (const source of sources) {
    const s = source as Record<string, unknown>;
    if (Array.isArray(s.identifiers)) count += s.identifiers.length;
    else if (Array.isArray(s.property_ids)) count += s.property_ids.length;
    else if (Array.isArray(s.collection_ids)) count += s.collection_ids.length;
    else if (Array.isArray(s.tags)) count += 10;
    else if (Array.isArray(s.genres)) count += 5;
    else count += 1;
  }
  return count;
}

function generateSampleIdentifiers(count: number) {
  const n = Math.min(count || 5, 20);
  return Array.from({ length: n }, (_, i) => ({
    type: 'domain',
    value: `publisher-${i + 1}.example.com`,
  }));
}

function generateSampleCollections(count: number) {
  const n = Math.min(count || 5, 20);
  const genres = ['drama', 'comedy', 'news', 'sports', 'documentary', 'reality', 'animation'];
  const ratings = ['TV-G', 'TV-PG', 'TV-14', 'TV-MA'];
  return Array.from({ length: n }, (_, i) => ({
    name: `Program ${i + 1}`,
    distribution_ids: [{ type: 'imdb_id', value: `tt${String(9999900 + i).padStart(7, '0')}` }],
    content_rating: { system: 'tv_parental', rating: ratings[i % ratings.length] },
    genre: [genres[i % genres.length]],
    kind: 'series',
  }));
}
