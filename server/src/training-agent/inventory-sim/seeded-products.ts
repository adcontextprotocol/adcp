/**
 * Products and pricing options a caller seeds with the comply_test_controller
 * (`seed_product`, `seed_pricing_option`), kept in the caller's market so
 * `reset_state` discards them. A caller that never seeds sells only the
 * season's own products.
 *
 * A seeded product is sold on the season's existing placements, so the engine
 * forecasts, books and delivers it like any other: a video fixture on the
 * video placements, an audio fixture on the audio ones, anything else on
 * display. A season without that channel uses the nearest installment
 * placement: creator video for video, the podcast for audio, the newsletter
 * otherwise. The product's wire shape is the fixture's own (name, channels,
 * formats, pricing), so a storyboard sees what it seeded.
 */
import type { PlacementChannel, SeasonSeed, SeedPlacement, SeedProduct } from './engine/index.js';

export interface SeededProductRecord {
  product_id: string;
  fixture: Record<string, unknown>;
}

export interface SeededPricingRecord {
  product_id: string;
  pricing_option_id: string;
  fixture: Record<string, unknown>;
}

/** What a caller has seeded on one tenant. */
export interface SeededCatalog {
  products?: SeededProductRecord[];
  pricing_options?: SeededPricingRecord[];
}

type MediaKind = 'video' | 'audio' | 'display';

/** Placement channels that carry each kind of media, best first. */
const CHANNELS_FOR: Record<MediaKind, PlacementChannel[]> = {
  video: ['olv', 'creator_video'],
  audio: ['podcast'],
  display: ['display', 'newsletter'],
};
const NEAREST: PlacementChannel[] = ['newsletter', 'creator_video', 'podcast'];

const VIDEO_CHANNELS = new Set(['olv', 'ctv', 'linear_tv']);
const AUDIO_CHANNELS = new Set(['streaming_audio', 'podcast', 'radio']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatOptions(fixture: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(fixture.format_options) ? fixture.format_options.filter(isRecord) : [];
}

function mediaKind(fixture: Record<string, unknown>): MediaKind {
  const kinds = formatOptions(fixture).map(option => String(option.format_kind ?? ''));
  if (kinds.some(kind => kind.startsWith('video'))) return 'video';
  if (kinds.some(kind => kind.startsWith('audio'))) return 'audio';
  const channels = Array.isArray(fixture.channels) ? fixture.channels.map(String) : [];
  if (channels.some(channel => VIDEO_CHANNELS.has(channel))) return 'video';
  if (channels.some(channel => AUDIO_CHANNELS.has(channel))) return 'audio';
  return 'display';
}

/** `display_<w>x<h>` labels the fixture's image formats ask for. */
function sizeLabels(fixture: Record<string, unknown>): Set<string> {
  const labels = new Set<string>();
  for (const option of formatOptions(fixture)) {
    const params = isRecord(option.params) ? option.params : {};
    if (typeof params.width === 'number' && typeof params.height === 'number') labels.add(`display_${params.width}x${params.height}`);
  }
  return labels;
}

/** The season placements a seeded product sells. Display avoids the
 * placements the season sells exclusively (a takeover), unless nothing else
 * serves display. */
function placementsFor(seed: SeasonSeed, fixture: Record<string, unknown>): SeedPlacement[] {
  const kind = mediaKind(fixture);
  const channel = [...CHANNELS_FOR[kind], ...NEAREST].find(candidate => seed.placements.some(placement => placement.channel === candidate))!;
  let placements = seed.placements.filter(placement => placement.channel === channel);
  const exclusive = new Set(seed.products.filter(product => product.share_of_voice).flatMap(product => product.placement_ids));
  const shared = placements.filter(placement => !exclusive.has(placement.placement_id));
  if (shared.length > 0) placements = shared;
  const sizes = sizeLabels(fixture);
  const sized = placements.filter(placement => placement.formats.some(format => sizes.has(format)));
  return sized.length > 0 ? sized : placements;
}

/** Every pricing option a seeded product carries: those inline on its fixture,
 * then those seeded for it, a later one replacing an earlier one with the
 * same id. */
export function seededPricing(catalog: SeededCatalog, productId: string): SeededPricingRecord[] {
  const options = new Map<string, SeededPricingRecord>();
  const product = catalog.products?.find(record => record.product_id === productId);
  for (const option of Array.isArray(product?.fixture.pricing_options) ? product.fixture.pricing_options.filter(isRecord) : []) {
    if (typeof option.pricing_option_id === 'string') {
      options.set(option.pricing_option_id, { product_id: productId, pricing_option_id: option.pricing_option_id, fixture: option });
    }
  }
  for (const option of catalog.pricing_options ?? []) {
    if (option.product_id === productId) options.set(option.pricing_option_id, option);
  }
  return [...options.values()];
}

function price(option: SeededPricingRecord, key: 'fixed_price' | 'floor_price'): number | undefined {
  const value = option.fixture[key];
  return typeof value === 'number' && value > 0 ? value : undefined;
}

/** A seeded pricing option's fixed price, the rate a guaranteed booking pays. */
export function fixedPrice(option: SeededPricingRecord): number | undefined {
  return price(option, 'fixed_price');
}

/** A seeded pricing option's floor, the lowest bid an auction booking places. */
export function floorPrice(option: SeededPricingRecord): number | undefined {
  return price(option, 'floor_price');
}

/** The engine product a seeded product sells as, on the season's placements. */
export function engineProduct(seed: SeasonSeed, catalog: SeededCatalog, record: SeededProductRecord): SeedProduct {
  const { fixture } = record;
  const placements = placementsFor(seed, fixture);
  const placementIds = new Set(placements.map(placement => placement.placement_id));
  const collections = (seed.collections ?? []).filter(collection => placementIds.has(collection.placement_id));
  const guaranteed = fixture.delivery_type === 'guaranteed';
  const rate = seededPricing(catalog, record.product_id).map(fixedPrice).find(value => value !== undefined)
    ?? Math.max(...placements.map(placement => placement.floor_cpm));
  return {
    product_id: record.product_id,
    name: typeof fixture.name === 'string' ? fixture.name : record.product_id,
    description: typeof fixture.description === 'string' ? fixture.description : `Seeded product ${record.product_id}`,
    delivery_type: guaranteed ? 'guaranteed' : 'non_guaranteed',
    placement_ids: [...placementIds],
    ...(collections.length > 0 && { collection_ids: collections.map(collection => collection.collection_id) }),
    ...(guaranteed && { rate_cpm: rate }),
  };
}

/** The engine products for everything a caller has seeded. */
export function engineProducts(seed: SeasonSeed, catalog: SeededCatalog | undefined): SeedProduct[] {
  return (catalog?.products ?? []).map(record => engineProduct(seed, catalog!, record));
}

/** The wire pricing option for a seeded one: the fixture as given, with the
 * season's currency and CPM when it names none. */
export function wirePricing(option: SeededPricingRecord, currency: string): Record<string, unknown> {
  const { product_id: _productId, ...fixture } = option.fixture;
  return {
    ...fixture,
    pricing_option_id: option.pricing_option_id,
    pricing_model: typeof fixture.pricing_model === 'string' ? fixture.pricing_model : 'cpm',
    currency: typeof fixture.currency === 'string' ? fixture.currency : currency,
  };
}

/** Product fields a seeded fixture sets on the wire in place of the ones the
 * season derives. */
const WIRE_FIELDS = ['name', 'description', 'channels', 'format_options', 'publisher_properties'] as const;

export function wireOverrides(record: SeededProductRecord): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};
  for (const field of WIRE_FIELDS) {
    if (record.fixture[field] !== undefined) overrides[field] = structuredClone(record.fixture[field]);
  }
  return overrides;
}
