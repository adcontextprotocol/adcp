/**
 * The season's traffic, generated once from the seed: for every cell (one
 * day × region × property × placement × audience profile, and installment
 * for content placements), the impressions expected and the impressions that
 * actually arrive. Actual carries the forecast error: a deviation from the
 * expected traffic made of a same-day publisher shock, the revision shocks
 * of the lead-time window and a per-cell shock, plus a daily wobble, spikes
 * and scripted events. A forecast made on an as-of day knows only the part of
 * that deviation already revealed by the day, never scripted events, the
 * daily wobble or a spike before it starts. Every draw is a pure function of
 * its key, precomputed here so a forecast is arithmetic and lookups. Rates
 * per cell are drawn on demand from the same keys.
 */
import type { CellCounts } from './allocation.js';
import { SeasonCalendar } from './calendar.js';
import { audienceCurve } from './curves.js';
import { EngineError } from './errors.js';
import { standardNormal, uniform } from './rng.js';
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
  SeedProperty,
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
  /** Expected impressions per cell: rounded. */
  expected: CellCounts;
  /** Impressions that actually arrive per cell. */
  actual: CellCounts;
}

/** A spike in a publisher's traffic: a surge or slump that decays over days. */
interface Spike {
  day: number;
  size: number;
  decay: number;
  /** The decay the forecaster believes in once the spike has started. */
  estimatedDecay: number;
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

/** The most draws a season's forecast error may need at build: for each publisher, one revision
 * draw per target day and horizon step, `(days + H) × (H + 1)` with `H` the lead-time horizon. */
export const MAX_REVISION_DRAWS = 20_000_000;

/** The largest lead-time horizon, in days. */
const MAX_LEAD_TIME_HORIZON_DAYS = 366;

/** The most spikes a publisher may have: each forecast reads every spike of the publisher, so this bounds the work of a forecast. */
export const MAX_SPIKES_PER_PUBLISHER = 100;

/** The largest publisher bias, in either direction, as a log offset: `exp` of the offset stays far from overflow. */
const MAX_BIAS = 5;

/** The largest spread of a log-scale draw (`bias_sigma`, `channel_sigma`, `truth_daily_sigma`, `decay_forecast_sigma`): `exp` of a draw stays finite. */
const MAX_SIGMA = 5;

/** The largest per-publisher `error_scale`: with `channel_sigma` it bounds a publisher shock's spread before the clip. */
const MAX_ERROR_SCALE = 100;

/** The largest `cell_kappa`: with a cell's expected impressions it bounds the cell shock's spread. */
const MAX_CELL_KAPPA = 1000;

/** The largest `month_shape` entry: a month's multiplier keeps expected impressions finite. */
const MAX_MONTH_SHAPE = 100;

/** The smallest `lead_time_tau_days`: revision shocks are divided by its square root, so a tiny value would blow them up. */
const MIN_LEAD_TIME_TAU_DAYS = 0.01;

export interface SeedProblem {
  /** Dotted season-file path, `[i]` for array indices. */
  path: string;
  message: string;
}

/** Every problem with the traffic shape and forecast error of a seed, each with its season-file path.
 * Each check is positive, so a missing or NaN value fails instead of producing NaN forecasts. */
export function forecastErrorProblems(seed: SeasonSeed): SeedProblem[] {
  const problems: SeedProblem[] = [];
  const add = (path: string, message: string) => problems.push({ path, message });
  const { traffic, forecast_error: error } = seed;
  const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
  const whole = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x);
  const wholeAtLeastZero = (x: unknown) => whole(x) && x >= 0;
  const atMost = (path: string, x: unknown, max: number) => {
    if (finite(x) && x > max) add(path, `must be at most ${max}`);
  };
  if (traffic.month_shape !== undefined) {
    const shape = traffic.month_shape;
    if (!Array.isArray(shape)) {
      add('traffic.month_shape', 'needs twelve values, January first');
    } else {
      if (shape.length !== 12) add('traffic.month_shape', 'needs twelve values, January first');
      shape.forEach((x, i) => {
        if (!(finite(x) && x > 0)) add(`traffic.month_shape[${i}]`, 'must be above 0');
        atMost(`traffic.month_shape[${i}]`, x, MAX_MONTH_SHAPE);
      });
    }
  }
  if (traffic.truth_daily_sigma !== undefined && !(finite(traffic.truth_daily_sigma) && traffic.truth_daily_sigma >= 0)) {
    add('traffic.truth_daily_sigma', 'must be 0 or more');
  }
  atMost('traffic.truth_daily_sigma', traffic.truth_daily_sigma, MAX_SIGMA);
  if (!error || typeof error !== 'object') {
    add('forecast_error', 'is required');
    return problems;
  }
  const sigmas = error.channel_sigma;
  if (!sigmas || typeof sigmas !== 'object') {
    add('forecast_error.channel_sigma', 'is required');
  } else {
    for (const [name, sigma] of Object.entries(sigmas)) {
      if (!(finite(sigma) && sigma >= 0)) add(`forecast_error.channel_sigma.${name}`, 'must be 0 or more');
      atMost(`forecast_error.channel_sigma.${name}`, sigma, MAX_SIGMA);
    }
    const unsized = new Set<string>();
    for (const placement of seed.placements) {
      if (sigmas[placement.channel] === undefined && !unsized.has(placement.channel)) {
        unsized.add(placement.channel);
        add(`forecast_error.channel_sigma.${placement.channel}`, `needed by placement ${placement.placement_id}`);
      }
    }
  }
  if (!(finite(error.ar1_phi) && error.ar1_phi >= 0 && error.ar1_phi < 1)) add('forecast_error.ar1_phi', 'must be 0 or more and below 1');
  if (!(finite(error.lead_time_tau_days) && error.lead_time_tau_days >= MIN_LEAD_TIME_TAU_DAYS)) {
    add('forecast_error.lead_time_tau_days', `must be at least ${MIN_LEAD_TIME_TAU_DAYS}`);
  }
  const horizon = error.lead_time_horizon_days;
  const horizonUsable = wholeAtLeastZero(horizon) && (horizon as number) <= MAX_LEAD_TIME_HORIZON_DAYS;
  if (!horizonUsable) add('forecast_error.lead_time_horizon_days', `must be a whole number from 0 to ${MAX_LEAD_TIME_HORIZON_DAYS}`);
  if (!(finite(error.log_clip) && error.log_clip > 0)) add('forecast_error.log_clip', 'must be above 0');
  if (!(finite(error.cell_kappa) && error.cell_kappa >= 0)) add('forecast_error.cell_kappa', 'must be 0 or more');
  atMost('forecast_error.cell_kappa', error.cell_kappa, MAX_CELL_KAPPA);
  if (!(finite(error.cell_min_impressions) && error.cell_min_impressions >= 1)) add('forecast_error.cell_min_impressions', 'must be 1 or more');
  const publisherIds = new Set(seed.properties.map(p => p.publisher_id ?? p.property_id));
  const listed = new Set<string>();
  const entries = error.publishers ?? [];
  if (!Array.isArray(entries)) {
    add('forecast_error.publishers', 'must be a list');
  } else {
    entries.forEach((entry, i) => {
      const at = `forecast_error.publishers[${i}]`;
      if (!publisherIds.has(entry.publisher_id)) add(`${at}.publisher_id`, `unknown publisher ${entry.publisher_id}`);
      else if (listed.has(entry.publisher_id)) add(`${at}.publisher_id`, `publisher ${entry.publisher_id} is listed twice`);
      listed.add(entry.publisher_id);
      if (!finite(entry.bias)) add(`${at}.bias`, 'must be a number');
      else if (Math.abs(entry.bias) > MAX_BIAS) add(`${at}.bias`, `must be from -${MAX_BIAS} to ${MAX_BIAS}`);
      if (entry.bias_sigma !== undefined && !(finite(entry.bias_sigma) && entry.bias_sigma >= 0)) add(`${at}.bias_sigma`, 'must be 0 or more');
      atMost(`${at}.bias_sigma`, entry.bias_sigma, MAX_SIGMA);
      if (entry.error_scale !== undefined && !(finite(entry.error_scale) && entry.error_scale >= 0)) add(`${at}.error_scale`, 'must be 0 or more');
      atMost(`${at}.error_scale`, entry.error_scale, MAX_ERROR_SCALE);
    });
  }
  const spikes = error.spikes;
  if (spikes !== undefined) {
    const at = 'forecast_error.spikes';
    const minOk = wholeAtLeastZero(spikes.per_publisher_min);
    if (!minOk) add(`${at}.per_publisher_min`, 'must be a whole number, 0 or more');
    if (!wholeAtLeastZero(spikes.per_publisher_max)) {
      add(`${at}.per_publisher_max`, 'must be a whole number, 0 or more');
    } else if (minOk && spikes.per_publisher_max < spikes.per_publisher_min) {
      add(`${at}.per_publisher_max`, 'must be at least per_publisher_min');
    } else {
      if (spikes.per_publisher_max > seed.days) add(`${at}.per_publisher_max`, 'must be at most the number of days in the season');
      atMost(`${at}.per_publisher_max`, spikes.per_publisher_max, MAX_SPIKES_PER_PUBLISHER);
    }
    if (!(finite(spikes.size_min) && spikes.size_min > -1)) add(`${at}.size_min`, 'must be above -1');
    if (!(finite(spikes.size_max) && spikes.size_max >= spikes.size_min)) add(`${at}.size_max`, 'must be at least size_min');
    if (!(finite(spikes.decay) && spikes.decay >= 0 && spikes.decay < 1)) add(`${at}.decay`, 'must be 0 or more and below 1');
    if (!(finite(spikes.decay_forecast_sigma) && spikes.decay_forecast_sigma >= 0)) add(`${at}.decay_forecast_sigma`, 'must be 0 or more');
    atMost(`${at}.decay_forecast_sigma`, spikes.decay_forecast_sigma, MAX_SIGMA);
  }
  if (horizonUsable && whole(seed.days) && seed.days >= 1 && seed.days <= 1100) {
    const h = horizon as number;
    const draws = publisherIds.size * (seed.days + h) * (h + 1);
    if (draws > MAX_REVISION_DRAWS) {
      add(
        'forecast_error.lead_time_horizon_days',
        `${publisherIds.size} publishers × (${seed.days} days + ${h}) × ${h + 1} = ${draws} draws, over the budget of ${MAX_REVISION_DRAWS}; lower the horizon, the days or the publishers`,
      );
    }
  }
  return problems;
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
  /** Unrounded expected impressions `B` per cell-day; a cell with none is absent. */
  private readonly expectedRaw: Array<Map<number, number>> = [];
  private readonly publisherIds: string[] = [];
  private readonly slotPublisher: number[] = [];
  /** `a(c) = σ_ch · k_p` per slot. */
  private slotErrorScale!: Float64Array;
  /** `−bias_p` per publisher: the log offset of its forecasts. */
  private publisherBias!: Float64Array;
  /** `x_p` per publisher per day: the same-day shock, AR(1) across days with unit variance. */
  private readonly publisherX: Float64Array[] = [];
  /**
   * Per publisher with a nonzero error scale, `days × (H + 1)` prefix sums of the revision shocks
   * of each target day `t`, over its window `r = t−H .. t−1` in order of `r`: entry `j` is the sum of
   * the first `j` shocks, so the shocks revealed before as-of day `s` sum to entry
   * `clamp(s − (t − H), 0, H)` and the whole window to entry `H`.
   */
  private readonly publisherRevisions: Array<Float64Array | undefined> = [];
  /** `φ^n` for `n = 0 .. days + 1`. */
  private phiPowers!: Float64Array;
  private readonly publisherSpikes: Spike[][] = [];

  constructor(readonly seed: SeasonSeed) {
    if (!seed.seed_id) invalid('seed_id is required');
    if (!Number.isInteger(seed.days) || seed.days <= 0 || seed.days > 1100) invalid('days must be an integer from 1 to 1100');
    this.calendar = new SeasonCalendar(seed.start_date, seed.days);
    checkShares(seed.regions, 'region');
    checkShares(seed.audience_profiles, 'audience profile');
    if (seed.traffic.weekday_shape.length !== 7) invalid('traffic.weekday_shape needs seven values, Sunday first');
    const [forecastProblem] = forecastErrorProblems(seed);
    if (forecastProblem) invalid(`${forecastProblem.path}: ${forecastProblem.message}`);
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
    this.buildPublishers(properties);
    this.buildTables(properties);
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

  /** Publishers, their draws and spikes, and the error scale of every slot. */
  private buildPublishers(properties: Map<string, SeedProperty>): void {
    const { forecast_error: error } = this.seed;
    const rng = this.seed.rng_seed;
    const days = this.calendar.days;
    const configured = new Map((error.publishers ?? []).map(entry => [entry.publisher_id, entry]));
    const publisherOf = (propertyId: string) => {
      const property = properties.get(propertyId)!;
      return property.publisher_id ?? property.property_id;
    };
    const index = new Map<string, number>();
    for (const slot of this.slots) {
      const id = publisherOf(slot.property_id);
      if (!index.has(id)) {
        index.set(id, this.publisherIds.length);
        this.publisherIds.push(id);
      }
      this.slotPublisher.push(index.get(id)!);
    }
    this.publisherBias = new Float64Array(this.publisherIds.length);
    this.slotErrorScale = new Float64Array(this.slots.length);
    const active = new Array<boolean>(this.publisherIds.length).fill(false);
    for (const slot of this.slots) {
      const placement = this.placements.get(slot.placement_id)!;
      const entry = configured.get(publisherOf(slot.property_id));
      const scale = error.channel_sigma[placement.channel]! * (entry?.error_scale ?? 1);
      this.slotErrorScale[slot.index] = scale;
      if (scale > 0) active[this.slotPublisher[slot.index]] = true;
    }
    const phi = error.ar1_phi;
    this.phiPowers = new Float64Array(days + 2);
    this.phiPowers[0] = 1;
    for (let n = 1; n < this.phiPowers.length; n++) this.phiPowers[n] = this.phiPowers[n - 1] * phi;
    this.publisherIds.forEach((id, p) => {
      const entry = configured.get(id);
      this.publisherBias[p] = -((entry?.bias ?? 0) + (entry?.bias_sigma ?? 0) * standardNormal(`${rng}|fe-bias|${id}`));
      this.publisherX.push(this.drawSameDayShocks(id));
      this.publisherRevisions.push(active[p] ? this.drawRevisionShocks(id) : undefined);
      this.publisherSpikes.push(this.drawSpikes(id));
    });
  }

  /** `x_p(t)` for every day: an AR(1) chain from day 0 with unit variance. */
  private drawSameDayShocks(publisherId: string): Float64Array {
    const rng = this.seed.rng_seed;
    const phi = this.seed.forecast_error.ar1_phi;
    const innovation = Math.sqrt(1 - phi * phi);
    const draws = new Float64Array(this.calendar.days);
    for (let day = 0; day < draws.length; day++) {
      const fresh = standardNormal(`${rng}|fe-x|${publisherId}|${day}`);
      draws[day] = day === 0 ? fresh : phi * draws[day - 1] + innovation * fresh;
    }
    return draws;
  }

  /**
   * The prefix sums of the revision shocks `z_p(t, r)` of every target day (see `publisherRevisions`).
   * For a fixed `r`, `z_p(·, r)` is an AR(1) chain over `t = r+1 .. r+H`, started fresh with unit
   * variance; `r` runs from `−H` so the first days have a full window.
   */
  private drawRevisionShocks(publisherId: string): Float64Array {
    const { ar1_phi: phi, lead_time_horizon_days: horizon } = this.seed.forecast_error;
    const rng = this.seed.rng_seed;
    const days = this.calendar.days;
    const innovation = Math.sqrt(1 - phi * phi);
    const width = horizon + 1;
    const sums = new Float64Array(days * width);
    for (let r = -horizon; r <= days - 2; r++) {
      let z = 0;
      const last = Math.min(r + horizon, days - 1);
      for (let t = r + 1; t <= last; t++) {
        const fresh = standardNormal(`${rng}|fe-rev|${publisherId}|${t}|${r}`);
        z = t === r + 1 ? fresh : phi * z + innovation * fresh;
        if (t >= 0) sums[t * width + 1 + r - t + horizon] = z;
      }
    }
    for (let t = 0; t < days; t++) {
      for (let j = 1; j <= horizon; j++) sums[t * width + j] += sums[t * width + j - 1];
    }
    return sums;
  }

  private drawSpikes(publisherId: string): Spike[] {
    const spikes = this.seed.forecast_error.spikes;
    if (!spikes) return [];
    const rng = this.seed.rng_seed;
    const span = spikes.per_publisher_max - spikes.per_publisher_min + 1;
    const count = spikes.per_publisher_min + Math.floor(uniform(`${rng}|spike-count|${publisherId}`) * span);
    const drawn: Spike[] = [];
    for (let i = 0; i < count; i++) {
      drawn.push({
        day: Math.floor(uniform(`${rng}|spike-day|${publisherId}|${i}`) * this.calendar.days),
        size: spikes.size_min + uniform(`${rng}|spike-size|${publisherId}|${i}`) * (spikes.size_max - spikes.size_min),
        decay: spikes.decay,
        estimatedDecay: spikes.decay ** Math.exp(spikes.decay_forecast_sigma * standardNormal(`${rng}|spike-decay-est|${publisherId}|${i}`)),
      });
    }
    return drawn;
  }

  /** The true multiplier of a publisher's spikes on a day. */
  private trueTail(publisher: number, day: number): number {
    let tail = 1;
    for (const spike of this.publisherSpikes[publisher]) {
      if (spike.day <= day) tail *= 1 + spike.size * spike.decay ** (day - spike.day);
    }
    return tail;
  }

  /** The multiplier a forecast made on `asOfDay` expects of a publisher's spikes on `day`:
   * only spikes already started by both days, each with its estimated decay. */
  private knownTail(publisher: number, day: number, asOfDay: number, decaySigma?: number): number {
    let tail = 1;
    for (const spike of this.publisherSpikes[publisher]) {
      if (spike.day > asOfDay || spike.day > day) continue;
      const decay = decaySigma === undefined ? spike.estimatedDecay : spike.estimatedDecay ** Math.exp(decaySigma);
      tail *= 1 + spike.size * decay ** (day - spike.day);
    }
    return tail;
  }

  private buildTables(properties: Map<string, SeedProperty>): void {
    const days = this.calendar.days;
    const rng = this.seed.rng_seed;
    const actualRaw: Array<Map<number, number>> = [];
    for (let day = 0; day < days; day++) {
      this.expectedRaw.push(new Map());
      actualRaw.push(new Map());
    }
    const { weekday_shape: weekdayShape, trend_per_day: trend = 0, month_shape: monthShape, truth_daily_sigma: dailySigma = 0 } = this.seed.traffic;
    const monthFactors = Array.from({ length: days }, (_, day) => monthShape?.[this.calendar.month(day)] ?? 1);
    const inSeason = (day: number) => day >= 0 && day < days;
    // `e^u` per placement-day: the daily truth variation, which forecasts do not carry.
    const dailyFactor = new Map<string, Float64Array>();
    for (const id of this.placements.keys()) {
      const factors = new Float64Array(days);
      for (let day = 0; day < days; day++) factors[day] = Math.exp(dailySigma * standardNormal(`${rng}|truth-day|${day}|${id}`));
      dailyFactor.set(id, factors);
    }
    const truthTail = this.publisherSpikes.map((_, p) => {
      const tail = new Float64Array(days);
      for (let day = 0; day < days; day++) tail[day] = this.trueTail(p, day);
      return tail;
    });

    for (const slot of this.slots) {
      const region = this.regions.get(slot.region_id)!;
      const profile = this.profiles.get(slot.profile_id)!;
      const shares = region.share * profile.share;
      const factors = dailyFactor.get(slot.placement_id)!;
      const tail = truthTail[this.slotPublisher[slot.index]];
      if (slot.installment_id) {
        const installment = this.installmentsById.get(slot.installment_id)!;
        const collection = this.collections.get(installment.collection_id)!;
        const curve = audienceCurve(collection.channel);
        const audienceFactor = Math.max(
          0,
          1 + collection.audience_sigma * standardNormal(`${rng}|installment|${installment.installment_id}`),
        );
        curve.forEach((weight, k) => {
          const expectedDay = installment.scheduled_day + k;
          if (!inSeason(expectedDay)) return;
          const expected = installment.expected_audience * weight * shares * monthFactors[expectedDay];
          this.addTraffic(this.expectedRaw[expectedDay], expectedDay, slot, expected);
          if (installment.actual_day === undefined) return;
          const actualDay = installment.actual_day + k;
          if (!inSeason(actualDay)) return;
          // The deviation belongs to the scheduled day's traffic and travels with it when the episode moves.
          this.addTraffic(
            actualRaw[actualDay],
            actualDay,
            slot,
            installment.expected_audience * audienceFactor * weight * shares * monthFactors[actualDay]
              * Math.exp(this.truthDeviation(slot.index, expectedDay, expected))
              * factors[actualDay] * this.eventMultiplier(actualDay, slot) * tail[actualDay],
          );
        });
        continue;
      }
      const placement = this.placements.get(slot.placement_id)!;
      const base = placement.base_daily_impressions! * (properties.get(slot.property_id)?.traffic_multiplier ?? 1) * shares;
      for (let day = 0; day < days; day++) {
        const expected = base * weekdayShape[this.calendar.weekday(day)] * (1 + trend * day) * monthFactors[day];
        this.addTraffic(this.expectedRaw[day], day, slot, expected);
        this.addTraffic(
          actualRaw[day],
          day,
          slot,
          expected * Math.exp(this.truthDeviation(slot.index, day, expected)) * factors[day] * this.eventMultiplier(day, slot) * tail[day],
        );
      }
    }

    for (let day = 0; day < days; day++) {
      this.tables.push({ expected: roundCounts(this.expectedRaw[day]), actual: roundCounts(actualRaw[day]) });
    }
    this.checkTablesFinite();
  }

  /** Add traffic to a cell-day, refusing a value that is not finite: `addCount` would drop a NaN without a trace. */
  private addTraffic(counts: Map<number, number>, day: number, slot: CellSlot, value: number): void {
    if (!Number.isFinite(value)) this.notFinite(day, slot.index);
    addCount(counts, slot.index, value);
  }

  /** The last guard of the build: a value the bounds of `forecastErrorProblems` miss fails at load, never per request. */
  private checkTablesFinite(): void {
    this.tables.forEach(({ expected, actual }, day) => {
      for (const counts of [expected, actual]) {
        for (const [cell, value] of counts) if (!Number.isFinite(value)) this.notFinite(day, cell);
      }
    });
  }

  private notFinite(day: number, cell: number): never {
    return invalid(`Traffic is not finite on ${this.calendar.dateOf(day)} (day ${day}) for cell ${this.slotKeys[cell]}; check the traffic and forecast_error values`);
  }

  /** `σ_cell = κ / √max(B, N_min)`: the log spread of the cell shock of a cell expecting `expected`. */
  private cellSpread(expected: number): number {
    const { cell_kappa: kappa, cell_min_impressions: floor } = this.seed.forecast_error;
    return kappa / Math.sqrt(Math.max(expected, floor));
  }

  /**
   * `Δ(c, t)`: the log deviation of a cell's actual traffic from its expected traffic on day `t`,
   * independent of any as-of day: the publisher's same-day shock and revision shocks scaled by the
   * cell's error scale, plus the cell shock, clipped to `log_clip`.
   */
  private truthDeviation(cell: number, day: number, expected: number): number {
    const { forecast_error: error } = this.seed;
    const publisher = this.slotPublisher[cell];
    const scale = this.slotErrorScale[cell];
    let deviation = 0;
    if (scale > 0) {
      const revisions = this.publisherRevisions[publisher]!;
      const horizon = error.lead_time_horizon_days;
      deviation = scale * (this.publisherX[publisher][day] + revisions[day * (horizon + 1) + horizon] / Math.sqrt(error.lead_time_tau_days));
    }
    if (error.cell_kappa !== 0) {
      deviation += this.cellSpread(expected) * standardNormal(`${this.seed.rng_seed}|fe-cell|${day}|${this.slotKey(this.slots[cell])}`);
    }
    return Math.max(-error.log_clip, Math.min(error.log_clip, deviation));
  }

  /** Expected and actual impressions on a day. Empty outside the season. */
  day(day: number): DayTables {
    return this.tables[day] ?? { expected: new Map(), actual: new Map() };
  }

  /**
   * The forecast of a cell's impressions on `day`, as known on `asOfDay`,
   * unrounded: the expected traffic times the part of the truth deviation
   * revealed by `asOfDay` (the same-day shocks of the days before it and the
   * revision shocks of days before it, clipped to the season's `log_clip`),
   * times the publisher bias and the spikes already started. Zero outside
   * the season or where nothing is expected. It never contains the
   * unrevealed shocks, the cell shock, the daily wobble or scripted events.
   */
  forecastValue(day: number, cell: number, asOfDay: number): number {
    const expected = this.expectedRaw[day]?.get(cell);
    if (expected === undefined) return 0;
    const { forecast_error: error } = this.seed;
    const publisher = this.slotPublisher[cell];
    const scale = this.slotErrorScale[cell];
    let known = 0;
    if (scale > 0) {
      let sameDay = 0;
      if (day < asOfDay) sameDay = this.publisherX[publisher][day];
      else if (asOfDay >= 1) sameDay = this.phiPowers[day - asOfDay + 1] * this.publisherX[publisher][asOfDay - 1];
      const horizon = error.lead_time_horizon_days;
      const revealed = Math.min(horizon, Math.max(0, asOfDay - (day - horizon)));
      const revision = this.publisherRevisions[publisher]![day * (horizon + 1) + revealed];
      known = Math.max(-error.log_clip, Math.min(error.log_clip, scale * (sameDay + revision / Math.sqrt(error.lead_time_tau_days))));
    }
    const spikes = this.publisherSpikes[publisher];
    const tail = spikes.length === 0 ? 1 : this.knownTail(publisher, day, asOfDay);
    return expected * tail * Math.exp(known + this.publisherBias[publisher]);
  }

  /** `a(c) = σ_ch · k_p`: the log spread of the publisher shocks in a cell's traffic. */
  publisherScale(cell: number): number {
    return this.slotErrorScale[cell];
  }

  /** `σ_cell = κ / √max(B, N_min)`: the log spread of the cell shock of a cell on a day. */
  cellSigma(day: number, cell: number): number {
    return this.cellSpread(this.expectedRaw[day]?.get(cell) ?? 0);
  }

  /** The publisher a cell's forecast error is shared with: its property's `publisher_id`, else the property. */
  publisherOf(cell: number): string {
    return this.publisherIds[this.slotPublisher[cell]];
  }

  /** The placement a cell belongs to. */
  placementOf(cell: number): string {
    return this.slots[cell].placement_id;
  }

  /**
   * Half the log spread of the spike tail a forecast made on `asOfDay`
   * expects on `day`, between the fastest and slowest decay around each
   * spike's own estimate that `decay_forecast_sigma` allows. Zero when no
   * spike of the cell's publisher has started.
   */
  spikeTailSpread(day: number, cell: number, asOfDay: number): number {
    const publisher = this.slotPublisher[cell];
    if (this.publisherSpikes[publisher].length === 0) return 0;
    const sigma = this.seed.forecast_error.spikes!.decay_forecast_sigma;
    const slow = this.knownTail(publisher, day, asOfDay, -sigma);
    const fast = this.knownTail(publisher, day, asOfDay, sigma);
    return Math.abs(Math.log(slow) - Math.log(fast)) / 2;
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

  /** The rates a cell is centred on: the placement's base, scaled by the profile, without the seeded spread. */
  expectedRates(cell: number): CellRates {
    const slot = this.slots[cell];
    const base = this.placements.get(slot.placement_id)!.rates;
    const multipliers = this.profiles.get(slot.profile_id)!.rate_multipliers ?? {};
    // Validated multipliers are >= 0, so the lower bound only guards against bad library input.
    const centre = (metric: keyof CellRates) => Math.min(1, Math.max(0, base[metric] * (multipliers[metric] ?? 1)));
    return {
      viewability: centre('viewability'),
      click_rate: centre('click_rate'),
      completion_rate: centre('completion_rate'),
      conversion_rate: centre('conversion_rate'),
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
