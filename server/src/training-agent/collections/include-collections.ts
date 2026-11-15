/**
 * `include_collections` on `list_products`, `request_proposals` and
 * `refine_proposals` (experimental, `media_buy.collection_cards`,
 * #8094/#8141). See collections-and-installments.mdx, "Collections in
 * responses". The flag was withdrawn from the deprecated `get_products` in
 * 3.3 (adcp#8501): a `get_products` read still gets the `sample_content`
 * card projection below, but never the `collections` array or a cards-scoped
 * feed token.
 *
 * - Opt-in: `collections` is returned only when the request set
 *   `include_collections: true`, and only to a caller served 3.3 or later.
 *   Stable callers never see it, whatever they send.
 * - Scope: one card per `(publisher_domain, collection_id)` referenced by a
 *   returned product's `collections` selectors, only alongside `products`
 *   (never on a rejected or `unchanged` answer). A `fields` projection that
 *   drops product `collections` drops the array too.
 * - Feed versions: the flag is part of the `wholesale_feed_version` /
 *   `feed_version` scope. With it set, the token also covers the card copies,
 *   so a card change moves it; without it, cards are outside the version.
 *   The two settings never share a token, so a token presented under the
 *   other setting is a mismatch and gets the full payload.
 *
 * At the 3.3 wire, creator product cards also carry their samples with the
 * `sample_content` reference asset role, as a `url` asset built from the
 * collection card's `post_url`.
 */

import {
  cardFor,
  cardsDigest,
  creatorSamplePostUrls,
  keyOf,
  supportsCollections33,
  type CollectionCard,
} from './card-catalog.js';
import { buildCatalog } from '../product-factory.js';

export type CollectionReadTool = 'get_products' | 'list_products' | 'request_proposals' | 'refine_proposals';

interface CardsContext {
  servedAdcpVersion?: string;
  principal?: string;
}

/** Marks a token issued with `include_collections: true`. Tokens issued
 * without the flag never contain it. */
const CARDS_SCOPE_MARKER = '~cards.';

const CONDITIONAL_FIELD: Partial<Record<CollectionReadTool, string>> = {
  list_products: 'if_feed_version',
};

const VERSION_FIELD: Partial<Record<CollectionReadTool, string>> = {
  list_products: 'feed_version',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function collectionsRequested(
  args: Record<string, unknown>,
  ctx: CardsContext,
  tool?: CollectionReadTool,
): boolean {
  if (tool === 'get_products') return false;
  return supportsCollections33(ctx.servedAdcpVersion) && args.include_collections === true;
}

function cardsScopeSuffix(ctx: CardsContext): string {
  return `${CARDS_SCOPE_MARKER}${cardsDigest(ctx.principal)}`;
}

/**
 * Map the presented conditional token onto the product feed's own token.
 * With the flag, a token is current only when it was issued with the flag
 * over the current cards; anything else is forced to mismatch. Without the
 * flag, a token issued with it never matches, because product feed tokens
 * never carry the marker.
 */
export function prepareCollectionRead(
  tool: CollectionReadTool,
  args: Record<string, unknown>,
  ctx: CardsContext,
): Record<string, unknown> {
  const field = CONDITIONAL_FIELD[tool];
  if (!field || typeof args[field] !== 'string' || !collectionsRequested(args, ctx, tool)) return args;
  const presented = args[field] as string;
  const suffix = cardsScopeSuffix(ctx);
  return {
    ...args,
    [field]: presented.endsWith(suffix)
      ? presented.slice(0, -suffix.length)
      : `${presented}${CARDS_SCOPE_MARKER}mismatch`,
  };
}

function referencedKeys(products: unknown[]): Array<{ publisher_domain: string; collection_id: string }> {
  const seen = new Set<string>();
  const keys: Array<{ publisher_domain: string; collection_id: string }> = [];
  for (const product of products) {
    if (!isRecord(product) || !Array.isArray(product.collections)) continue;
    for (const selector of product.collections) {
      if (!isRecord(selector) || typeof selector.publisher_domain !== 'string') continue;
      if (!Array.isArray(selector.collection_ids)) continue;
      for (const id of selector.collection_ids) {
        if (typeof id !== 'string') continue;
        const key = { publisher_domain: selector.publisher_domain, collection_id: id };
        if (seen.has(keyOf(key))) continue;
        seen.add(keyOf(key));
        keys.push(key);
      }
    }
  }
  return keys;
}

/** The cards for the collections the given products reference, deduplicated
 * by key, in first-reference order. */
export function cardsForProducts(products: unknown[], principal: string | undefined): CollectionCard[] {
  return referencedKeys(products)
    .map(key => cardFor(principal, key))
    .filter((card): card is CollectionCard => card !== undefined);
}

/** Replaces, never mutates, product cards: products can share nested objects
 * with the cached catalog that stable callers read too. */
function projectSampleContentRole(products: unknown[]): void {
  for (const [index, product] of products.entries()) {
    if (!isRecord(product)) continue;
    const detailed = product.product_card_detailed;
    if (!isRecord(detailed) || !Array.isArray(detailed.reference_assets)) continue;
    const selector = Array.isArray(product.collections) ? product.collections.find(isRecord) : undefined;
    const showId = Array.isArray(selector?.collection_ids) ? selector.collection_ids[0] : undefined;
    const postUrls = typeof showId === 'string' ? creatorSamplePostUrls(showId) : [];
    if (postUrls.length === 0) continue;
    let sample = 0;
    const referenceAssets = detailed.reference_assets.map(asset => {
      if (!isRecord(asset) || asset.role !== 'other' || asset.role_label !== 'Sample content') return asset;
      const postUrl = postUrls[sample];
      sample += 1;
      if (!postUrl) return asset;
      const { role_label: _label, asset: _video, ...rest } = asset;
      return { ...rest, role: 'sample_content', asset: { asset_type: 'url', url: postUrl } };
    });
    products[index] = { ...product, product_card_detailed: { ...detailed, reference_assets: referenceAssets } };
  }
}

/**
 * Finish a product or proposal read for a 3.3 caller: the `sample_content`
 * role on creator product cards, the include_collections token scope, and
 * the top-level `collections` array. Mutates and returns `result`. A stable
 * caller's result is returned untouched.
 */
export function finishCollectionRead<T>(
  tool: CollectionReadTool,
  args: Record<string, unknown>,
  result: T,
  ctx: CardsContext,
): T {
  if (!isRecord(result) || !supportsCollections33(ctx.servedAdcpVersion)) return result;
  const record: Record<string, unknown> = result;
  const products = Array.isArray(record.products) ? record.products : undefined;
  if (products) projectSampleContentRole(products);
  if (!collectionsRequested(args, ctx, tool)) return result;
  const versionField = VERSION_FIELD[tool];
  if (versionField && typeof record[versionField] === 'string') {
    record[versionField] = `${record[versionField] as string}${cardsScopeSuffix(ctx)}`;
  }
  // Only alongside products: never on rejected or unchanged answers.
  if (!products || record.unchanged === true || record.outcome === 'unchanged' || record.outcome === 'rejected') {
    return result;
  }
  if (tool === 'request_proposals' || tool === 'refine_proposals') withCatalogSelectors(products);
  const cards = cardsForProducts(products, ctx.principal);
  if (cards.length > 0) record.collections = cards;
  else delete record.collections;
  return result;
}

let catalogSelectors: Map<string, unknown[]> | undefined;

/**
 * Proposal reads return minimal canonical products (`product_id`, `name`).
 * Cards are scoped by the returned products' `collections` selectors, so with
 * `include_collections` the products carry their catalog selectors and the
 * cards they reference can be joined to them.
 */
function withCatalogSelectors(products: unknown[]): void {
  catalogSelectors ??= new Map(buildCatalog()
    .filter(entry => Array.isArray(entry.product.collections) && entry.product.collections.length > 0)
    .map(entry => [entry.product.product_id, entry.product.collections as unknown[]]));
  for (const [index, product] of products.entries()) {
    if (!isRecord(product) || product.collections !== undefined || typeof product.product_id !== 'string') continue;
    const selectors = catalogSelectors.get(product.product_id);
    if (selectors) products[index] = { ...product, collections: structuredClone(selectors) };
  }
}

/** Run one product or proposal read with include_collections applied. */
export async function runCollectionRead<T>(
  tool: CollectionReadTool,
  args: Record<string, unknown>,
  ctx: CardsContext,
  run: (args: Record<string, unknown>) => Promise<T>,
): Promise<T> {
  const result = await run(prepareCollectionRead(tool, args, ctx));
  return finishCollectionRead(tool, args, result, ctx);
}
