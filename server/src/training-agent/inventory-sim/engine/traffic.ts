/**
 * The season's traffic, generated once from the seed: for every cell (one
 * day × region × property × placement × audience profile, and installment
 * for content placements), the impressions forecast and the impressions that
 * actually arrive. Actual differs from forecast by seeded noise and scripted
 * events. Rates per cell are drawn on demand from the same keys.
 */
import type { CellCounts } from './allocation.js';
import { SeasonCalendar } from './calendar.js';
import { audienceCurve } from './curves.js';
import { EngineError } from './errors.js';
import { standardNormal } from './rng.js';
import type {
  BookingTargeting,
  CellRates,
  CellSlot,
  Installment,
  InstallmentChannel,
  SeasonSeed,
  SeedAudienceProfile,
  SeedCollection,
  SeedPlacement,
  SeedProduct,
  SeedRegion,
  TrafficMultiplierEvent,
} from './types.js';

const INSTALLMENT_CHANNELS: readonly string[] = ['podcast', 'newsletter', 'creator_video'];
const SHARE_TOLERANCE = 1e-6;
/** Per-cell spread of the drawn rates around the placement's base rates. */
const RATE_SIGMA = 0.05;

export function isInstallmentChannel(channel: string): channel is InstallmentChannel {
  return INSTALLMENT_CHANNELS.includes(channel);
}

export interface DayTables {
  forecast: CellCounts;
  actual: CellCounts;
}

function invalid(message: string): never {
  throw new EngineError('INVALID_SEED', message);
}

function indexBy<T, K extends keyof T>(items: readonly T[], key: K, label: string): Map<T[K], T> {
  const map = new Map<T[K], T>();
  for (const item of items) {
    if (map.has(item[key])) invalid(`Duplicate ${label} ${String(item[key])}`);
    map.set(item[key], item);
  }
  return map;
}

function checkShares(items: ReadonlyArray<{ share: number }>, label: string): void {
  if (items.length === 0) invalid(`A seed needs at least one ${label}`);
  if (items.some(item => !(item.share > 0))) invalid(`Every ${label} share must be positive`);
  const total = items.reduce((sum, item) => sum + item.share, 0);
  if (Math.abs(total - 1) > SHARE_TOLERANCE) invalid(`${label} shares sum to ${total}, not 1`);
}

function addCount(counts: CellCounts, cell: number, value: number): void {
  if (value > 0) counts.set(cell, (counts.get(cell) ?? 0) + value);
}

function roundCounts(raw: Map<number, number>): CellCounts {
  const rounded: CellCounts = new Map();
  for (const [cell, value] of raw) {
    const whole = Math.round(value);
    if (whole > 0) rounded.set(cell, whole);
  }
  return rounded;
}

export class SeasonTraffic {
  readonly calendar: SeasonCalendar;
  readonly slots: CellSlot[] = [];
  readonly installments: Installment[] = [];
  readonly regions: Map<string, SeedRegion>;
  readonly profiles: Map<string, SeedAudienceProfile>;
  readonly placements: Map<string, SeedPlacement>;
  readonly products: Map<string, SeedProduct>;
  readonly collections: Map<string, SeedCollection>;
  private readonly segmentProfiles = new Map<string, Set<string>>();
  private readonly installmentsById = new Map<string, Installment>();
  private readonly tables: DayTables[] = [];
  private readonly slotKeys: string[] = [];
  private trafficEvents: Array<{ event: TrafficMultiplierEvent; first: number; last: number }> = [];

  constructor(readonly seed: SeasonSeed) {
    if (!seed.seed_id) invalid('seed_id is required');
    if (!Number.isInteger(seed.days) || seed.days <= 0 || seed.days > 1100) invalid('days must be an integer from 1 to 1100');
    this.calendar = new SeasonCalendar(seed.start_date, seed.days);
    checkShares(seed.regions, 'region');
    checkShares(seed.audience_profiles, 'audience profile');
    if (seed.traffic.weekday_shape.length !== 7) invalid('traffic.weekday_shape needs seven values, Sunday first');
    this.regions = indexBy(seed.regions, 'region_id', 'region');
    this.profiles = indexBy(seed.audience_profiles, 'profile_id', 'audience profile');
    const properties = indexBy(seed.properties, 'property_id', 'property');
    this.placements = indexBy(seed.placements, 'placement_id', 'placement');
    this.products = indexBy(seed.products, 'product_id', 'product');
    this.collections = indexBy(seed.collections ?? [], 'collection_id', 'collection');
    for (const segment of seed.segments) {
      if (this.segmentProfiles.has(segment.segment_id)) invalid(`Duplicate segment ${segment.segment_id}`);
      for (const id of segment.profile_ids) if (!this.profiles.has(id)) invalid(`Segment ${segment.segment_id} names unknown profile ${id}`);
      this.segmentProfiles.set(segment.segment_id, new Set(segment.profile_ids));
    }
    for (const placement of seed.placements) {
      for (const id of placement.property_ids) if (!properties.has(id)) invalid(`Placement ${placement.placement_id} names unknown property ${id}`);
      const installment = isInstallmentChannel(placement.channel);
      if (!installment && !(placement.base_daily_impressions! > 0)) {
        invalid(`Placement ${placement.placement_id} needs base_daily_impressions`);
      }
    }
    for (const product of seed.products) {
      if (product.placement_ids.length === 0) invalid(`Product ${product.product_id} has no placements`);
      for (const id of product.placement_ids) if (!this.placements.has(id)) invalid(`Product ${product.product_id} names unknown placement ${id}`);
      if (product.segment_id && !this.segmentProfiles.has(product.segment_id)) invalid(`Product ${product.product_id} names unknown segment ${product.segment_id}`);
      for (const id of product.collection_ids ?? []) if (!this.collections.has(id)) invalid(`Product ${product.product_id} names unknown collection ${id}`);
      if (product.delivery_type === 'guaranteed' && !(product.rate_cpm! > 0)) invalid(`Guaranteed product ${product.product_id} needs rate_cpm`);
    }
    this.buildInstallments();
    this.buildSlots();
    this.buildTables();
  }

  private buildInstallments(): void {
    for (const collection of this.collections.values()) {
      const placement = this.placements.get(collection.placement_id);
      if (!placement) invalid(`Collection ${collection.collection_id} names unknown placement ${collection.placement_id}`);
      if (placement.channel !== collection.channel) invalid(`Collection ${collection.collection_id} is ${collection.channel} but its placement is ${placement.channel}`);
      if (!placement.property_ids.includes(collection.property_id)) invalid(`Collection ${collection.collection_id} property is not on its placement`);
      const first = this.calendar.dayOfDate(collection.first_date);
      for (let n = 1; n <= collection.count; n++) {
        const day = first + (n - 1) * collection.cadence_days;
        const installment: Installment = {
          installment_id: `${collection.collection_id}_${String(n).padStart(3, '0')}`,
          collection_id: collection.collection_id,
          sequence: n,
          scheduled_date: this.calendar.dateOf(day),
          scheduled_day: day,
          actual_day: day,
          outcome: 'runs',
          expected_audience: collection.expected_audience,
        };
        this.installments.push(installment);
        this.installmentsById.set(installment.installment_id, installment);
      }
    }
    for (const event of this.seed.events ?? []) {
      if (event.type === 'traffic_multiplier') {
        if (!(event.multiplier >= 0)) invalid(`Event ${event.event_id} needs a non-negative multiplier`);
        const first = this.calendar.dayOfDate(event.start_date);
        const last = this.calendar.dayOfDate(event.end_date);
        if (last < first) invalid(`Event ${event.event_id} ends before it starts`);
        this.trafficEvents.push({ event, first, last });
        continue;
      }
      const installment = this.installmentsById.get(event.installment_id);
      if (!installment) invalid(`Event ${event.event_id} names unknown installment ${event.installment_id}`);
      if (installment.outcome !== 'runs') invalid(`Installment ${event.installment_id} has two scripted events`);
      if (event.type === 'installment_cancelled') {
        installment.outcome = 'cancelled';
        delete installment.actual_day;
      } else {
        const to = this.calendar.dayOfDate(event.to_date);
        if (to <= installment.scheduled_day) invalid(`Event ${event.event_id} must postpone to a later date`);
        installment.outcome = 'postponed';
        installment.actual_day = to;
      }
    }
  }

  private buildSlots(): void {
    const push = (slot: Omit<CellSlot, 'index'>) => {
      this.slots.push({ index: this.slots.length, ...slot });
      this.slotKeys.push(`${slot.region_id}/${slot.property_id}/${slot.placement_id}/${slot.profile_id}/${slot.installment_id ?? ''}`);
    };
    for (const placement of this.placements.values()) {
      if (isInstallmentChannel(placement.channel)) {
        for (const installment of this.installments) {
          const collection = this.collections.get(installment.collection_id)!;
          if (collection.placement_id !== placement.placement_id) continue;
          for (const region of this.regions.values()) {
            for (const profile of this.profiles.values()) {
              push({
                region_id: region.region_id,
                property_id: collection.property_id,
                placement_id: placement.placement_id,
                profile_id: profile.profile_id,
                installment_id: installment.installment_id,
              });
            }
          }
        }
        continue;
      }
      for (const propertyId of placement.property_ids) {
        for (const region of this.regions.values()) {
          for (const profile of this.profiles.values()) {
            push({ region_id: region.region_id, property_id: propertyId, placement_id: placement.placement_id, profile_id: profile.profile_id });
          }
        }
      }
    }
  }

  private slotKey(slot: CellSlot): string {
    return this.slotKeys[slot.index];
  }

  private eventMultiplier(day: number, slot: CellSlot): number {
    let multiplier = 1;
    for (const { event, first, last } of this.trafficEvents) {
      if (day < first || day > last || !this.eventCovers(event, slot)) continue;
      multiplier *= event.multiplier;
    }
    return multiplier;
  }

  private eventCovers(event: TrafficMultiplierEvent, slot: CellSlot): boolean {
    return (!event.placement_ids || event.placement_ids.includes(slot.placement_id))
      && (!event.property_ids || event.property_ids.includes(slot.property_id))
      && (!event.region_ids || event.region_ids.includes(slot.region_id));
  }

  private noiseFactor(day: number, slot: CellSlot): number {
    const { bias = 0, day_sigma, cell_sigma } = this.seed.forecast_error;
    const rng = this.seed.rng_seed;
    const dayNoise = day_sigma * standardNormal(`${rng}|day|${day}|${slot.placement_id}`);
    const cellNoise = cell_sigma * standardNormal(`${rng}|cell|${day}|${this.slotKey(slot)}`);
    return Math.max(0, 1 + bias + dayNoise + cellNoise);
  }

  private buildTables(): void {
    const forecastRaw: Array<Map<number, number>> = [];
    const actualRaw: Array<Map<number, number>> = [];
    for (let day = 0; day < this.calendar.days; day++) {
      forecastRaw.push(new Map());
      actualRaw.push(new Map());
    }
    const { weekday_shape: weekdayShape, trend_per_day: trend = 0 } = this.seed.traffic;
    const properties = new Map(this.seed.properties.map(property => [property.property_id, property]));
    const inSeason = (day: number) => day >= 0 && day < this.calendar.days;

    for (const slot of this.slots) {
      const region = this.regions.get(slot.region_id)!;
      const profile = this.profiles.get(slot.profile_id)!;
      const shares = region.share * profile.share;
      if (slot.installment_id) {
        const installment = this.installmentsById.get(slot.installment_id)!;
        const collection = this.collections.get(installment.collection_id)!;
        const curve = audienceCurve(collection.channel);
        const audienceFactor = Math.max(
          0,
          1 + collection.audience_sigma * standardNormal(`${this.seed.rng_seed}|installment|${installment.installment_id}`),
        );
        curve.forEach((weight, k) => {
          const forecastDay = installment.scheduled_day + k;
          if (inSeason(forecastDay)) addCount(forecastRaw[forecastDay], slot.index, installment.expected_audience * weight * shares);
          if (installment.actual_day === undefined) return;
          const actualDay = installment.actual_day + k;
          if (!inSeason(actualDay)) return;
          const cellFactor = Math.max(
            0,
            1 + this.seed.forecast_error.cell_sigma * standardNormal(`${this.seed.rng_seed}|cell|${actualDay}|${this.slotKey(slot)}`),
          );
          addCount(
            actualRaw[actualDay],
            slot.index,
            installment.expected_audience * audienceFactor * weight * shares * cellFactor * this.eventMultiplier(actualDay, slot),
          );
        });
        continue;
      }
      const placement = this.placements.get(slot.placement_id)!;
      const base = placement.base_daily_impressions! * (properties.get(slot.property_id)?.traffic_multiplier ?? 1) * shares;
      for (let day = 0; day < this.calendar.days; day++) {
        const forecast = base * weekdayShape[this.calendar.weekday(day)] * (1 + trend * day);
        addCount(forecastRaw[day], slot.index, forecast);
        addCount(actualRaw[day], slot.index, forecast * this.noiseFactor(day, slot) * this.eventMultiplier(day, slot));
      }
    }
    for (let day = 0; day < this.calendar.days; day++) {
      this.tables.push({ forecast: roundCounts(forecastRaw[day]), actual: roundCounts(actualRaw[day]) });
    }
  }

  /** Forecast and actual impressions on a day. Empty outside the season. */
  day(day: number): DayTables {
    return this.tables[day] ?? { forecast: new Map(), actual: new Map() };
  }

  installment(installmentId: string): Installment | undefined {
    return this.installmentsById.get(installmentId);
  }

  floorOf(cell: number): number {
    return this.placements.get(this.slots[cell].placement_id)!.floor_cpm;
  }

  /** Rates for a cell: the placement's base, scaled by the profile, with a
   * small seeded spread. */
  rates(day: number, cell: number): CellRates {
    const slot = this.slots[cell];
    const base = this.placements.get(slot.placement_id)!.rates;
    const multipliers = this.profiles.get(slot.profile_id)!.rate_multipliers ?? {};
    const draw = (metric: keyof CellRates) => {
      const value = base[metric] * (multipliers[metric] ?? 1)
        * (1 + RATE_SIGMA * standardNormal(`${this.seed.rng_seed}|rate|${metric}|${day}|${this.slotKey(slot)}`));
      return Math.min(1, Math.max(0, value));
    };
    return {
      viewability: draw('viewability'),
      click_rate: draw('click_rate'),
      completion_rate: draw('completion_rate'),
      conversion_rate: draw('conversion_rate'),
    };
  }

  /** Reporting delay of a product: its slowest placement. */
  reportingLagDays(productId: string): number {
    const product = this.requireProduct(productId);
    return Math.max(...product.placement_ids.map(id => this.placements.get(id)!.reporting_lag_days));
  }

  /**
   * This season's traffic, also selling `extra` products. Products only name
   * placements, so the view shares every cell and day table: nothing is
   * regenerated.
   */
  withProducts(extra: readonly SeedProduct[]): SeasonTraffic {
    if (extra.length === 0) return this;
    const products = new Map(this.products);
    for (const product of extra) {
      if (products.has(product.product_id)) invalid(`Duplicate product ${product.product_id}`);
      if (product.placement_ids.length === 0) invalid(`Product ${product.product_id} has no placements`);
      for (const id of product.placement_ids) if (!this.placements.has(id)) invalid(`Product ${product.product_id} names unknown placement ${id}`);
      for (const id of product.collection_ids ?? []) if (!this.collections.has(id)) invalid(`Product ${product.product_id} names unknown collection ${id}`);
      if (product.delivery_type === 'guaranteed' && !(product.rate_cpm! > 0)) invalid(`Guaranteed product ${product.product_id} needs rate_cpm`);
      products.set(product.product_id, product);
    }
    const view = Object.create(this) as SeasonTraffic;
    Object.defineProperty(view, 'products', { value: products });
    return view;
  }

  requireProduct(productId: string): SeedProduct {
    const product = this.products.get(productId);
    if (!product) throw new EngineError('UNKNOWN_PRODUCT', `Unknown product ${productId}`);
    return product;
  }

  /** Installments a product sells: those of its collections. */
  productInstallments(productId: string): Installment[] {
    const collections = new Set(this.requireProduct(productId).collection_ids ?? []);
    return this.installments.filter(installment => collections.has(installment.collection_id));
  }

  /**
   * Cells a product covers under the given targeting, as sorted slot
   * indices. Segments are unions of profiles, so a profile in two targeted
   * segments is counted once.
   */
  eligibleCells(productId: string, targeting: BookingTargeting = {}): number[] {
    const product = this.requireProduct(productId);
    for (const id of targeting.region_ids ?? []) {
      if (!this.regions.has(id)) throw new EngineError('INVALID_TARGETING', `Unknown region ${id}`);
    }
    let profiles: Set<string> | undefined;
    if (targeting.segment_ids && targeting.segment_ids.length > 0) {
      profiles = new Set();
      for (const id of targeting.segment_ids) {
        const members = this.segmentProfiles.get(id);
        if (!members) throw new EngineError('INVALID_TARGETING', `Unknown segment ${id}`);
        for (const profile of members) profiles.add(profile);
      }
    }
    const productProfiles = product.segment_id ? this.segmentProfiles.get(product.segment_id)! : undefined;
    const productInstallments = new Set(this.productInstallments(productId).map(installment => installment.installment_id));
    for (const id of targeting.installment_ids ?? []) {
      if (!productInstallments.has(id)) throw new EngineError('INVALID_TARGETING', `Product ${productId} does not sell installment ${id}`);
    }
    const regions = targeting.region_ids && targeting.region_ids.length > 0 ? new Set(targeting.region_ids) : undefined;
    const installments = targeting.installment_ids && targeting.installment_ids.length > 0 ? new Set(targeting.installment_ids) : undefined;
    const placements = new Set(product.placement_ids);
    const propertyIds = product.property_ids ? new Set(product.property_ids) : undefined;
    return this.slots
      .filter(slot => placements.has(slot.placement_id)
        && (!propertyIds || propertyIds.has(slot.property_id))
        && (!productProfiles || productProfiles.has(slot.profile_id))
        && (!profiles || profiles.has(slot.profile_id))
        && (!regions || regions.has(slot.region_id))
        && (!slot.installment_id || (productInstallments.has(slot.installment_id)
          && (!installments || installments.has(slot.installment_id)))))
      .map(slot => slot.index);
  }
}

const trafficCache = new WeakMap<SeasonSeed, SeasonTraffic>();

/** The traffic for a seed, generated on first use and reused after. */
export function trafficFor(seed: SeasonSeed): SeasonTraffic {
  let traffic = trafficCache.get(seed);
  if (!traffic) {
    traffic = new SeasonTraffic(seed);
    trafficCache.set(seed, traffic);
  }
  return traffic;
}
