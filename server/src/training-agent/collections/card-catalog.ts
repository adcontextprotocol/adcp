/**
 * The training agent's collection card catalog (experimental, #8181).
 *
 * One card per collection the sales tenant sells, keyed by
 * `(publisher_domain, collection_id)`. The same copy is served by
 * `include_collections` on product and proposal reads, by `list_collections`,
 * and in `collection_card.updated` webhooks
 * (list_collections.mdx, "Consistency with include_collections").
 *
 * Authority (collections-and-installments.mdx, "Collections in responses"):
 * the agent's adagents.json declares every collection with its anchored
 * fields (`declaredCollections`), and a card is that declaration plus the
 * closed list the seller owns: `images`, `sample_content`, `url`,
 * `description`, `season`, `cadence` and `distribution[].followers`. Card
 * changes (the `seed_collection` controller scenario) touch only the closed
 * list, so a copy never restates an anchored fact differently from the
 * declaration.
 *
 * Sandbox scope: card changes are kept per caller principal, like the rest of
 * the training agent's sandbox state, so one caller's edits never change the
 * cards another caller sees. Within one principal every account sees the same
 * card for a key; no card is account-scoped, so every read and event is
 * `cache_scope: "public"`.
 */

import { createHash } from 'node:crypto';
import { PUBLISHERS } from '../publishers.js';
import type { PublisherProfile, ShowDefinition } from '../types.js';
import { atLeastAdcpVersion } from '../types.js';
import { sourceSchemaDocument } from '../source-schema.js';
import {
  CREATOR_CARD_FIXTURE_BY_SHOW,
  CREATOR_TALENT_HOUSE,
  type CreatorCardFixture,
} from './card-fixtures.js';

export const COLLECTION_CARDS_FEATURE = 'media_buy.collection_cards';
export const COLLECTION_CATALOG_FEATURE = 'media_buy.collection_catalog';
export const BRAND_COLLECTION_LINKS_FEATURE = 'brand.collection_links';

export const COLLECTION_CARD_EVENT_TYPES = [
  'collection_card.updated',
  'collection_card.removed',
  'collection_catalog.bulk_change',
] as const;
export type CollectionCardEventType = typeof COLLECTION_CARD_EVENT_TYPES[number];

export function isCollectionCardEventType(value: unknown): value is CollectionCardEventType {
  return typeof value === 'string' && (COLLECTION_CARD_EVENT_TYPES as readonly string[]).includes(value);
}

/** Fields a seller's copy wins on, besides `distribution[].followers`. */
export const CLOSED_LIST_FIELDS = ['images', 'sample_content', 'url', 'description', 'season', 'cadence'] as const;
export type ClosedListField = typeof CLOSED_LIST_FIELDS[number];

/** First wire checkpoint carrying the experimental 3.3 collection surfaces
 * (`media_buy.collection_cards`, `media_buy.collection_catalog`,
 * `brand.collection_links`). Stable callers (3.2 and below) never see them. */
export const COLLECTIONS_33_ADCP_VERSION = '3.3-beta' as const;

export function supportsCollections33(servedVersion: string | undefined): boolean {
  return atLeastAdcpVersion(servedVersion, COLLECTIONS_33_ADCP_VERSION);
}

export type CollectionCard = Record<string, unknown> & {
  publisher_domain: string;
  collection_id: string;
  name: string;
};

export interface CollectionKey {
  publisher_domain: string;
  collection_id: string;
}

export interface AudienceSize {
  lower_bound: number;
  upper_bound: number;
  precision: 'exact' | 'approximate';
  as_of?: string;
}

export function keyOf(card: CollectionKey): string {
  return `${card.publisher_domain}\u0000${card.collection_id}`;
}

/** Canonical JSON with sorted object keys. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort()
      .filter(key => record[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: string, length: number): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

const CADENCES = new Set(['daily', 'weekly', 'monthly', 'seasonal', 'event', 'irregular']);
const STATUSES = new Set(['active', 'hiatus', 'ended', 'upcoming']);
const RATING_SYSTEMS = new Set(['tv_parental', 'mpaa', 'podcast', 'esrb', 'bbfc', 'fsk', 'acb', 'chvrs', 'csa', 'pegi', 'custom']);

// ── Declarations (adagents.json) ─────────────────────────────────────

function creatorTalent(fixture: CreatorCardFixture | undefined, talent: NonNullable<ShowDefinition['talent']>): Array<Record<string, unknown>> {
  return talent.map(person => ({
    role: person.role,
    name: person.name,
    ...(fixture?.brandRef && person.role === 'creator' && {
      brand_ref: { domain: CREATOR_TALENT_HOUSE.domain, brand_id: fixture.slug },
    }),
  }));
}

/** Identifier types the show fixtures predate, under their 3.x names. */
const IDENTIFIER_RENAMES: Readonly<Record<string, string>> = { spotify_show_id: 'spotify_collection_id' };
let identifierTypes: Set<string> | undefined;

function wireIdentifiers(identifiers: Array<{ type: string; value: string }>): Array<{ type: string; value: string }> {
  identifierTypes ??= new Set((sourceSchemaDocument('enums/distribution-identifier-type.json') as { enum?: string[] }).enum ?? []);
  return identifiers
    .map(id => ({ type: IDENTIFIER_RENAMES[id.type] ?? id.type, value: id.value }))
    .filter(id => identifierTypes!.has(id.type));
}

function declaredDistribution(show: ShowDefinition, fixture: CreatorCardFixture | undefined): Array<Record<string, unknown>> {
  const entries = (show.distribution ?? [])
    .map(entry => ({ publisher_domain: entry.publisherDomain, identifiers: wireIdentifiers(entry.identifiers) }))
    .filter(entry => entry.identifiers.length > 0);
  if (fixture?.crossPost) {
    entries.push({
      publisher_domain: fixture.crossPost.publisherDomain,
      identifiers: [{ type: fixture.crossPost.identifierType, value: fixture.crossPost.identifierValue }],
    });
  }
  return entries;
}

/** The publisher's declaration of one show: the anchored facts, plus the
 * declared `description` and `cadence` a card may refresh. */
function declarationFor(pub: PublisherProfile, show: ShowDefinition): CollectionCard {
  const fixture = CREATOR_CARD_FIXTURE_BY_SHOW.get(show.showId);
  const rating = show.contentRatings?.find(entry => RATING_SYSTEMS.has(entry.system));
  const distribution = declaredDistribution(show, fixture);
  return {
    publisher_domain: pub.domain,
    collection_id: show.showId,
    name: show.name,
    ...(show.kind && { kind: show.kind }),
    ...(show.genre.length > 0 && { genre: [...show.genre] }),
    ...(show.language && { language: show.language }),
    ...(rating && { content_rating: { system: rating.system, rating: rating.rating } }),
    ...(CADENCES.has(show.cadence) && { cadence: show.cadence }),
    ...(STATUSES.has(show.status) && { status: show.status }),
    ...(show.description && { description: show.description }),
    ...(show.talent?.length && { talent: creatorTalent(fixture, show.talent) }),
    ...(distribution.length > 0 && { distribution }),
  };
}

function showsBySeller(): Array<{ pub: PublisherProfile; show: ShowDefinition }> {
  return PUBLISHERS.flatMap(pub => (pub.shows ?? []).map(show => ({ pub, show })));
}

let declarationCache: CollectionCard[] | undefined;

/** Every collection the agent's adagents.json declares, as the `collections`
 * array of that file (publisher_domain is required in a cross-origin shared
 * document). */
export function declaredCollections(): CollectionCard[] {
  declarationCache ??= showsBySeller().map(({ pub, show }) => declarationFor(pub, show));
  return structuredClone(declarationCache);
}

/** The collection-scoped selectors that authorize the sales agent, in bulk
 * form: every collection each publisher declares. */
export function collectionAuthorizationSelectors(): Array<{ publisher_domain: string }> {
  return [...new Set(showsBySeller().map(({ pub }) => pub.domain))].sort().map(publisher_domain => ({ publisher_domain }));
}

// ── Base cards ───────────────────────────────────────────────────────

function creatorCardExtras(pub: PublisherProfile, show: ShowDefinition, fixture: CreatorCardFixture): Record<string, unknown> {
  const primary = show.distribution?.[0];
  const platformDomain = primary?.publisherDomain ?? pub.domain;
  const shortForm = primary?.identifiers.some(id => id.type === 'tiktok_id') === true;
  const samples = show.offer?.sampleContent ?? [];
  return {
    url: `https://${pub.domain}/creators/${fixture.slug.replace(/_/g, '-')}`,
    images: [
      {
        asset_type: 'image',
        url: `https://picsum.photos/seed/creatorloop-${fixture.slug}-avatar/800/800`,
        width: 800,
        height: 800,
        alt_text: `${show.name} channel avatar`,
      },
      {
        asset_type: 'image',
        url: `https://picsum.photos/seed/creatorloop-${fixture.slug}-banner/1280/720`,
        width: 1280,
        height: 720,
        alt_text: `${show.name} channel banner`,
      },
    ],
    sample_content: samples.slice(0, 2).map((sample, i) => ({
      asset_type: 'published_post',
      post_url: samplePostUrl(platformDomain, fixture.slug, i, shortForm),
      platform: platformDomain,
      platform_post_id: `${fixture.slug}-${i + 1}`,
      published_at: fixture.samplePublishedAt[i],
      identity_ref: { handle: fixture.handle },
    })),
  };
}

function samplePostUrl(platformDomain: string, slug: string, index: number, shortForm: boolean): string {
  return `https://${platformDomain}/${shortForm ? 'v' : 'watch'}/${slug.replace(/_/g, '-')}-${index + 1}`;
}

/** The `sample_content` post URLs of a creator offer, in order, so product
 * cards can carry the same samples as the collection card. */
export function creatorSamplePostUrls(showId: string): string[] {
  for (const { pub, show } of showsBySeller()) {
    if (show.showId !== showId) continue;
    const fixture = CREATOR_CARD_FIXTURE_BY_SHOW.get(showId);
    if (!fixture) return [];
    const samples = (creatorCardExtras(pub, show, fixture).sample_content as Array<{ post_url: string }>);
    return samples.map(sample => sample.post_url);
  }
  return [];
}

function baseCardFor(pub: PublisherProfile, show: ShowDefinition): CollectionCard {
  const card = declarationFor(pub, show);
  const fixture = CREATOR_CARD_FIXTURE_BY_SHOW.get(show.showId);
  if (fixture) {
    Object.assign(card, creatorCardExtras(pub, show, fixture));
    const distribution = card.distribution as Array<Record<string, unknown>> | undefined;
    for (const entry of distribution ?? []) {
      const count = fixture.followers.find(f => f.publisherDomain === entry.publisher_domain);
      if (count) {
        entry.followers = {
          lower_bound: count.lowerBound,
          upper_bound: count.upperBound,
          precision: 'approximate',
          as_of: count.asOf,
        };
      }
    }
  } else {
    card.url = `https://${pub.domain}/shows/${show.showId.replace(/_/g, '-')}`;
    if (pub.heroImageUrl) {
      card.images = [{
        asset_type: 'image',
        url: pub.heroImageUrl,
        width: 600,
        height: 300,
        alt_text: `${show.name} key art`,
      }];
    }
  }
  return card;
}

let baseCache: Map<string, CollectionCard> | undefined;

function baseCards(): Map<string, CollectionCard> {
  baseCache ??= new Map(showsBySeller()
    .map(({ pub, show }) => baseCardFor(pub, show))
    .sort(compareCards)
    .map(card => [keyOf(card), card]));
  return baseCache;
}

function compareCards(a: CollectionKey, b: CollectionKey): number {
  return a.publisher_domain.localeCompare(b.publisher_domain) || a.collection_id.localeCompare(b.collection_id);
}

// ── Per-principal sandbox state ──────────────────────────────────────

interface CardOverlay {
  /** Closed-list field values that replace the base card's; `null` removes. */
  patches: Map<string, Partial<Record<ClosedListField, unknown>>>;
  /** key → distribution publisher_domain → follower count. */
  followers: Map<string, Map<string, AudienceSize>>;
  /** key → removal reason, for cards this seller no longer offers. */
  removed: Map<string, string>;
}

const MAX_OVERLAYS = 1000;
const overlays = new Map<string, CardOverlay>();

function principalKey(principal: string | undefined): string {
  return principal && principal.length > 0 ? principal : 'anonymous';
}

function overlayFor(principal: string | undefined, create: true): CardOverlay;
function overlayFor(principal: string | undefined, create?: false): CardOverlay | undefined;
function overlayFor(principal: string | undefined, create = false): CardOverlay | undefined {
  const key = principalKey(principal);
  let overlay = overlays.get(key);
  if (!overlay && create) {
    if (overlays.size >= MAX_OVERLAYS) {
      const oldest = overlays.keys().next().value;
      if (oldest !== undefined) overlays.delete(oldest);
    }
    overlay = { patches: new Map(), followers: new Map(), removed: new Map() };
    overlays.set(key, overlay);
  }
  return overlay;
}

/** Test and reset hook: forget every principal's card changes. */
export function clearCollectionCardState(principal?: string): void {
  if (principal === undefined) overlays.clear();
  else overlays.delete(principalKey(principal));
}

function applyOverlay(base: CollectionCard, overlay: CardOverlay | undefined): CollectionCard {
  const card = structuredClone(base);
  if (!overlay) return card;
  const key = keyOf(base);
  const patch = overlay.patches.get(key);
  if (patch) {
    for (const [field, value] of Object.entries(patch)) {
      if (value === null) delete card[field];
      else card[field] = structuredClone(value);
    }
  }
  const followers = overlay.followers.get(key);
  if (followers && Array.isArray(card.distribution)) {
    for (const entry of card.distribution as Array<Record<string, unknown>>) {
      const count = followers.get(entry.publisher_domain as string);
      if (count) entry.followers = structuredClone(count);
    }
  }
  return card;
}

/** Every card this seller offers the principal, in catalog order
 * (publisher_domain, then collection_id). */
export function cardsFor(principal: string | undefined): CollectionCard[] {
  const overlay = overlayFor(principal);
  const out: CollectionCard[] = [];
  for (const [key, base] of baseCards()) {
    if (overlay?.removed.has(key)) continue;
    out.push(applyOverlay(base, overlay));
  }
  return out;
}

/** The card for one key, or undefined when the seller does not offer it. */
export function cardFor(principal: string | undefined, key: CollectionKey): CollectionCard | undefined {
  const base = baseCards().get(keyOf(key));
  if (!base) return undefined;
  const overlay = overlayFor(principal);
  if (overlay?.removed.has(keyOf(key))) return undefined;
  return applyOverlay(base, overlay);
}

/** Whether the catalog has ever had a card for this key (offered or removed). */
export function catalogHasKey(key: CollectionKey): boolean {
  return baseCards().has(keyOf(key));
}

export function catalogSize(principal: string | undefined): number {
  return cardsFor(principal).length;
}

// ── Versions ─────────────────────────────────────────────────────────

export interface CatalogScope {
  collections?: Array<{ publisher_domain: string; collection_ids?: string[] }>;
  filters?: Record<string, unknown>;
}

/** Selectors and filters with set semantics; the cursor is never part of it. */
function canonicalScope(scope: CatalogScope): string {
  const selectors = scope.collections
    ? [...new Set(scope.collections.map(s => canonicalJson({
      publisher_domain: s.publisher_domain,
      ...(s.collection_ids ? { collection_ids: [...new Set(s.collection_ids)].sort() } : {}),
    })))].sort()
    : null;
  const filters = scope.filters && Object.keys(scope.filters).length > 0
    ? Object.fromEntries(Object.entries(scope.filters).map(([name, value]) => [
      name,
      Array.isArray(value) ? [...new Set(value.map(canonicalJson))].sort() : value,
    ]))
    : null;
  return canonicalJson({ selectors, filters });
}

/** `collections_version` for a selection: changes when any selected copy
 * changes or the selected set changes, and differs between selections. */
export function collectionsVersion(scope: CatalogScope, selected: readonly CollectionCard[]): string {
  return `cc_${digest(`${canonicalScope(scope)}\u0001${canonicalJson(selected)}`, 24)}`;
}

/** The unfiltered catalog's version: the one webhooks carry and a mirror
 * bootstraps from. */
export function unfilteredCollectionsVersion(principal: string | undefined): string {
  return collectionsVersion({}, cardsFor(principal));
}

/** Digest of every card the principal is offered, for the include_collections
 * scope of product feed versions. */
export function cardsDigest(principal: string | undefined): string {
  return digest(canonicalJson(cardsFor(principal)), 16);
}

// ── Mutations (seed_collection) ──────────────────────────────────────

export interface CardMutationResult {
  key: CollectionKey;
  /** Closed-list fields whose value changed. */
  changedFields: string[];
  /** The card was removed and enters the catalog again. */
  reentered: boolean;
}

/** Replace closed-list fields on one card. Returns the fields whose value
 * changed, or an empty list when the card is unchanged. */
export function patchCard(
  principal: string | undefined,
  key: CollectionKey,
  patch: Partial<Record<ClosedListField, unknown>>,
): CardMutationResult | undefined {
  const base = baseCards().get(keyOf(key));
  if (!base) return undefined;
  const overlay = overlayFor(principal, true);
  const wasRemoved = overlay.removed.has(keyOf(key));
  const before = applyOverlay(base, overlay);
  const current = { ...(overlay.patches.get(keyOf(key)) ?? {}) };
  for (const field of CLOSED_LIST_FIELDS) {
    if (!(field in patch)) continue;
    const value = patch[field];
    // A value equal to the publisher's (base) copy needs no override.
    if (value !== null && canonicalJson(value) === canonicalJson(base[field])) delete current[field];
    else if (value === null && base[field] === undefined) delete current[field];
    else current[field] = structuredClone(value);
  }
  if (Object.keys(current).length > 0) overlay.patches.set(keyOf(key), current);
  else overlay.patches.delete(keyOf(key));
  overlay.removed.delete(keyOf(key));
  const after = applyOverlay(base, overlay);
  const changedFields = CLOSED_LIST_FIELDS.filter(field => canonicalJson(before[field]) !== canonicalJson(after[field]));
  // A removed card that comes back re-enters the catalog: an upsert.
  return { key, changedFields, reentered: wasRemoved };
}

/** Record one follower refresh. A refresh that leaves the bounds and
 * precision unchanged is not a change: it keeps the earlier `as_of` and
 * returns false (collections-and-installments.mdx, "Follower counts"). */
export function refreshFollowers(
  principal: string | undefined,
  key: CollectionKey,
  distributionPublisherDomain: string,
  count: AudienceSize,
  nowIso: string,
): boolean | undefined {
  const base = baseCards().get(keyOf(key));
  if (!base) return undefined;
  const overlay = overlayFor(principal, true);
  const current = applyOverlay(base, overlay);
  const entry = (current.distribution as Array<Record<string, unknown>> | undefined)
    ?.find(candidate => candidate.publisher_domain === distributionPublisherDomain);
  if (!entry) return undefined;
  const previous = entry.followers as AudienceSize | undefined;
  if (
    previous
    && previous.lower_bound === count.lower_bound
    && previous.upper_bound === count.upper_bound
    && previous.precision === count.precision
  ) return false;
  let followers = overlay.followers.get(keyOf(key));
  if (!followers) {
    followers = new Map();
    overlay.followers.set(keyOf(key), followers);
  }
  followers.set(distributionPublisherDomain, {
    lower_bound: count.lower_bound,
    upper_bound: count.upper_bound,
    precision: count.precision,
    as_of: count.as_of ?? nowIso,
  });
  return true;
}

/** Stop offering one card. Returns false when it was already removed. */
export function removeCard(principal: string | undefined, key: CollectionKey, reason: string): boolean | undefined {
  if (!baseCards().has(keyOf(key))) return undefined;
  const overlay = overlayFor(principal, true);
  if (overlay.removed.has(keyOf(key))) return false;
  overlay.removed.set(keyOf(key), reason);
  return true;
}
