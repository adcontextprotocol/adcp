/**
 * `list_collections` (experimental, `media_buy.collection_catalog`, #8183):
 * the sales tenant's catalog of collection cards, by key or with filters,
 * with its own `collections_version` conditional fetch. It returns the same
 * copies `include_collections` adds to product and proposal reads, and never
 * products, pricing or availability. Side-effect free.
 *
 * See docs/media-buy/task-reference/list_collections.mdx.
 */

import { TOOL_INPUT_SHAPES } from '@adcp/sdk/schemas';
import { decodeOffsetCursor, encodeOffsetCursor } from '../pagination.js';
import type { ToolArgs, TrainingContext } from '../types.js';
import { customToolFor } from '../tenants/custom-tool-helper.js';
import {
  cardsFor,
  collectionsVersion,
  supportsCollections33,
  type CatalogScope,
  type CollectionCard,
} from './card-catalog.js';

interface Selector {
  publisher_domain: string;
  collection_ids?: string[];
}

interface Filters {
  kinds?: string[];
  genres_include?: string[];
  genres_exclude?: string[];
  genre_taxonomy?: string;
  statuses?: string[];
  languages?: string[];
  talent?: Array<{ domain: string; brand_id?: string }>;
  platforms?: string[];
  name_contains?: string;
}

interface ListCollectionsArgs {
  collections?: Selector[];
  filters?: Filters;
  pagination?: { max_results?: number; cursor?: string };
  account?: unknown;
  if_collections_version?: string;
}

const MAX_COLLECTION_IDS = 100;
const DEFAULT_PAGE = 50;
const MAX_PAGE = 100;

function failure(code: string, message: string, field?: string): { errors: Array<Record<string, unknown>> } {
  return { errors: [{ code, message, ...(field && { field }), recovery: 'correctable' }] };
}

function selectorMatches(card: CollectionCard, selectors: Selector[] | undefined): boolean {
  if (!selectors) return true;
  return selectors.some(selector => (
    selector.publisher_domain === card.publisher_domain
    && (!selector.collection_ids || selector.collection_ids.includes(card.collection_id))
  ));
}

/** RFC 4647 basic filtering, case-insensitive: `en` matches `en-US`. */
export function languageRangeMatches(range: string, tag: unknown): boolean {
  if (typeof tag !== 'string' || tag.length === 0) return false;
  const [r, t] = [range.toLowerCase(), tag.toLowerCase()];
  return r === '*' || t === r || t.startsWith(`${r}-`);
}

/** Values within one filter are alternatives (OR); filters combine with AND. */
export function filterMatches(card: CollectionCard, filters: Filters | undefined): boolean {
  if (!filters) return true;
  const kind = typeof card.kind === 'string' ? card.kind : 'series';
  if (filters.kinds && !filters.kinds.includes(kind)) return false;
  if (filters.statuses && !filters.statuses.includes(card.status as string)) return false;
  if (filters.languages && !filters.languages.some(range => languageRangeMatches(range, card.language))) return false;
  const genres = Array.isArray(card.genre) ? card.genre as string[] : [];
  // Genre values are compared within one taxonomy: a filter that names a
  // taxonomy matches only cards declared in it.
  const taxonomyOk = !filters.genre_taxonomy || filters.genre_taxonomy === card.genre_taxonomy;
  if (filters.genres_include && !(taxonomyOk && filters.genres_include.some(g => genres.includes(g)))) return false;
  if (filters.genres_exclude && taxonomyOk && filters.genres_exclude.some(g => genres.includes(g))) return false;
  if (filters.talent) {
    const talent = Array.isArray(card.talent) ? card.talent as Array<{ brand_ref?: { domain?: string; brand_id?: string } }> : [];
    const matched = filters.talent.some(wanted => talent.some(person => (
      person.brand_ref?.domain === wanted.domain
      && (!wanted.brand_id || person.brand_ref.brand_id === wanted.brand_id)
    )));
    if (!matched) return false;
  }
  if (filters.platforms) {
    const distribution = Array.isArray(card.distribution) ? card.distribution as Array<{ publisher_domain?: string }> : [];
    if (!filters.platforms.some(domain => distribution.some(entry => entry.publisher_domain === domain))) return false;
  }
  if (filters.name_contains && !String(card.name).toLowerCase().includes(filters.name_contains.toLowerCase())) return false;
  return true;
}

/** The cards a request selects, before pagination. */
export function selectCards(principal: string | undefined, scope: CatalogScope): CollectionCard[] {
  return cardsFor(principal).filter(card => (
    selectorMatches(card, scope.collections as Selector[] | undefined)
    && filterMatches(card, scope.filters as Filters | undefined)
  ));
}

export async function handleListCollections(args: ToolArgs, ctx: TrainingContext): Promise<object> {
  if (!supportsCollections33(ctx.servedAdcpVersion)) {
    return failure(
      'UNSUPPORTED_FEATURE',
      'list_collections is an experimental AdCP 3.3 task (media_buy.collection_catalog).',
      'adcp_version',
    );
  }
  const request = args as unknown as ListCollectionsArgs;
  const idCount = (request.collections ?? []).reduce((sum, selector) => sum + (selector.collection_ids?.length ?? 0), 0);
  if (idCount > MAX_COLLECTION_IDS) {
    return failure(
      'VALIDATION_ERROR',
      `At most ${MAX_COLLECTION_IDS} collection IDs in total across all selectors; this request names ${idCount}.`,
      'collections',
    );
  }
  const offset = decodeOffsetCursor('list_collections', request.pagination?.cursor);
  if (offset === null) return failure('INVALID_REQUEST', 'pagination.cursor is malformed.', 'pagination.cursor');

  const scope: CatalogScope = {
    ...(request.collections && { collections: request.collections }),
    ...(request.filters && Object.keys(request.filters).length > 0 && { filters: request.filters as Record<string, unknown> }),
  };
  const selected = selectCards(ctx.principal, scope);
  const version = collectionsVersion(scope, selected);
  // No card is account-scoped, so every answer is the public layer, with or
  // without an account.
  const cacheScope = 'public';
  if (request.if_collections_version !== undefined && request.if_collections_version === version) {
    return { status: 'completed', outcome: 'unchanged', collections_version: version, cache_scope: cacheScope };
  }
  const maxResults = Math.min(Math.max(request.pagination?.max_results ?? DEFAULT_PAGE, 1), MAX_PAGE);
  const page = selected.slice(offset, offset + maxResults);
  const next = offset + page.length;
  const hasMore = next < selected.length;
  return {
    status: 'completed',
    outcome: 'listed',
    collections: page,
    pagination: {
      has_more: hasMore,
      ...(hasMore && { cursor: encodeOffsetCursor('list_collections', next) }),
      total_count: selected.length,
    },
    collections_version: version,
    cache_scope: cacheScope,
  };
}

/** The sales tenant's `list_collections` custom tool. Registered only where
 * the 3.3 wire is served (the hosted preview's registry, candidate mode and
 * the identity route); the handler refuses a caller below 3.3 itself. */
export function listCollectionsTool() {
  return customToolFor(
    'list_collections',
    'List this seller\'s collection cards (shows, creators, podcasts) by key or with filters, without products. Experimental (media_buy.collection_catalog).',
    TOOL_INPUT_SHAPES.list_collections!,
    handleListCollections,
    {
      annotations: { readOnlyHint: true, idempotentHint: true },
      gatesOwnRelease: true,
      responseSummary: result => (
        result.outcome === 'unchanged'
          ? 'Collection catalog unchanged.'
          : `Listed ${Array.isArray(result.collections) ? result.collections.length : 0} collection cards.`
      ),
    },
  );
}
