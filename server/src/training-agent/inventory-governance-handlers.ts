/**
 * Collection list handlers for the training agent.
 *
 * Implements collection list CRUD with in-memory session storage.
 * Property list and content standards handlers are in property-handlers.ts
 * and content-standards-handlers.ts respectively.
 */

import { randomUUID } from 'node:crypto';
import type { TrainingContext, ToolArgs, CollectionListState } from './types.js';
import { getSession, sessionKeyFromArgs, findInAnySessions, getVisibleSessions } from './state.js';

const MAX_ARRAY_INPUT = 100;

// ── Tool definitions ─────────────────────────────────────────────

export const COLLECTION_LIST_TOOLS = [
  {
    name: 'create_collection_list',
    description: 'Create a collection list for program-level brand safety. Uses distribution identifiers for cross-publisher matching.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
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
    annotations: { readOnlyHint: true, idempotentHint: true },
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
    annotations: { readOnlyHint: true, idempotentHint: true },
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
    description: 'Delete a collection list. Cannot be undone.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
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

// ── Input types ──────────────────────────────────────────────────

interface CreateCollectionListInput extends ToolArgs {
  name: string;
  description?: string;
  base_collections?: unknown[];
  filters?: Record<string, unknown>;
  brand?: { domain: string };
}

interface GetCollectionListInput extends ToolArgs {
  list_id: string;
  resolve?: boolean;
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

// ── Handlers ─────────────────────────────────────────────────────

export function handleCreateCollectionList(args: ToolArgs, ctx: TrainingContext) {
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));
  const input = args as CreateCollectionListInput;

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
  const input = args as GetCollectionListInput;

  let list = session.collectionLists.get(input.list_id);
  if (!list) {
    const found = findInAnySessions(s => s.collectionLists, input.list_id, ctx.mode, ctx.userId);
    if (!found) return { errors: [{ code: 'NOT_FOUND', message: `Collection list ${input.list_id} not found` }] };
    list = found.resource;
  }

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

  let list = session.collectionLists.get(input.list_id);
  if (!list) {
    const found = findInAnySessions(s => s.collectionLists, input.list_id, ctx.mode, ctx.userId);
    if (!found) return { errors: [{ code: 'NOT_FOUND', message: `Collection list ${input.list_id} not found` }] };
    list = found.resource;
  }

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

  // Aggregate across sessions to handle key mismatches
  const seen = new Set<string>();
  const allLists: CollectionListState[] = [];
  for (const state of session.collectionLists.values()) {
    seen.add(state.list_id);
    allLists.push(state);
  }
  for (const other of getVisibleSessions(ctx.mode, ctx.userId)) {
    if (other === session) continue;
    for (const state of other.collectionLists.values()) {
      if (!seen.has(state.list_id)) {
        seen.add(state.list_id);
        allLists.push(state);
      }
    }
  }

  const filtered = input.name_contains
    ? allLists.filter(l => l.name.toLowerCase().includes(input.name_contains!.toLowerCase()))
    : allLists;
  return { lists: filtered, pagination: { has_more: false } };
}

export function handleDeleteCollectionList(args: ToolArgs, ctx: TrainingContext) {
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));
  const input = args as DeleteInput;

  if (session.collectionLists.delete(input.list_id)) {
    return { deleted: true, list_id: input.list_id };
  }

  const found = findInAnySessions(s => s.collectionLists, input.list_id, ctx.mode, ctx.userId);
  if (found) {
    found.session.collectionLists.delete(input.list_id);
    return { deleted: true, list_id: input.list_id };
  }

  return { deleted: false, list_id: input.list_id };
}

// ── Helpers ──────────────────────────────────────────────────────

function countSources(sources: unknown[]): number {
  let count = 0;
  for (const source of sources) {
    const s = source as Record<string, unknown>;
    if (Array.isArray(s.identifiers)) count += s.identifiers.length;
    else if (Array.isArray(s.collection_ids)) count += s.collection_ids.length;
    else if (Array.isArray(s.genres)) count += 5;
    else count += 1;
  }
  return count;
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
