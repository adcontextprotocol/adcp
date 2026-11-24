/**
 * One simulated market: a season's traffic, the bookings made against it,
 * and the delivery recorded day by day. All times are milliseconds on the
 * host's clock; the engine never reads the wall clock.
 *
 * Each simulated day runs, in order:
 *  1. Bookings confirmed by the end of day N serve from day N+1, or from
 *     their flight start if later.
 *  2. Read the day's actual traffic (events are already applied to it).
 *  3. Guaranteed first: share-of-voice bookings take their cells, then
 *     impression-goal bookings are served by the high-water mark method.
 *  4. Non-guaranteed bookings bid for what is left, first-price, above the
 *     placement floor, until each one's daily budget is spent.
 *  5. Installments scheduled for the day run, or are postponed or
 *     cancelled. One that runs builds its audience over its channel's
 *     curve, which the traffic tables already hold.
 *  6. Record delivery per booking and per cell.
 *
 * The same seed and the same calls always give the same results.
 */
import {
  allocateAuction,
  allocateHighWaterMark,
  supplyOf,
  takeShareOfVoice,
  type BidRequest,
  type CellCounts,
  type GoalRequest,
} from './allocation.js';
import { EngineError } from './errors.js';
import { trafficFor, isInstallmentChannel, type SeasonTraffic } from './traffic.js';
import type {
  Booking,
  BookingDay,
  BookingStatus,
  BookingTargeting,
  DayLog,
  DeliveryMetrics,
  Installment,
  SeasonSeed,
  SeedProduct,
  SimulationState,
} from './types.js';

/** z for a 10th–90th percentile forecast range. */
const RANGE_Z = 1.2816;

export interface BookRequest {
  booking_id: string;
  product_id: string;
  targeting?: BookingTargeting;
  flight_start_ms: number;
  flight_end_ms: number;
  budget: number;
  /** Guaranteed impression-goal products. Defaults to what the budget buys
   * at the product's rate. */
  impression_goal?: number;
  /** Non-guaranteed products. */
  bid_cpm?: number;
}

export interface BookingPatch {
  status?: BookingStatus;
  budget?: number;
  impression_goal?: number;
  bid_cpm?: number;
  flight_end_ms?: number;
}

export interface ForecastQuery {
  product_id: string;
  targeting?: BookingTargeting;
  flight_start_ms: number;
  flight_end_ms: number;
  budget?: number;
  bid_cpm?: number;
}

export interface ForecastResult extends DeliveryMetrics {
  product_id: string;
  currency: string;
  /** First day a booking made now could serve. */
  start_day: number;
  /** Exclusive. */
  end_day: number;
  /** Forecast impressions over the covered cells and days. */
  capacity: number;
  /** Of those, reserved by guaranteed bookings. */
  booked: number;
  available: number;
  /** Expected impressions: available, or what the budget buys if less.
   * Equal to `impressions`. */
  low: number;
  high: number;
  /** Price used for spend: the product's rate, or the bid. */
  cpm?: number;
  /** Relative spread used for low and high. */
  sigma: number;
}

export interface DeliveryReport {
  booking: Omit<Booking, 'days'>;
  /** Last day whose delivery is reported, inclusive. */
  reported_through_day?: number;
  totals: DeliveryMetrics;
  days: BookingDay[];
  /** Goal bookings: impressions an even pace against forecast traffic would
   * have delivered by the reported day. */
  expected_impressions?: number;
}

export type InstallmentState = 'scheduled' | 'published' | 'postponed' | 'cancelled';

export interface InstallmentStatus extends Installment {
  state: InstallmentState;
  /** Date it now runs on, once a postponement is known. */
  rescheduled_date?: string;
}

function zeroMetrics(): DeliveryMetrics {
  return { impressions: 0, spend: 0, clicks: 0, viewable_impressions: 0, completed_views: 0, conversions: 0 };
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function addMetrics(into: DeliveryMetrics, from: DeliveryMetrics): void {
  into.impressions += from.impressions;
  into.spend = roundMoney(into.spend + from.spend);
  into.clicks += from.clicks;
  into.viewable_impressions += from.viewable_impressions;
  into.completed_views += from.completed_views;
  into.conversions += from.conversions;
}

function positive(value: number | undefined, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new EngineError('INVALID_BOOKING', `${label} must be a positive number`);
  }
  return value;
}

function overlaps(a: readonly number[], b: ReadonlySet<number>): boolean {
  return a.some(cell => b.has(cell));
}

export class InventorySimulation {
  readonly traffic: SeasonTraffic;
  private readonly cellCache = new Map<string, number[]>();
  /** Per booking id, running totals of forecast impressions over the booking's
   * cells: entry d is the sum over days [0, d). Cells never change after
   * booking, so only the flight end is read live. An as-of forecast reader
   * has to key this by as-of day or bypass it. */
  private readonly forecastPrefix = new Map<string, Float64Array>();

  /** `products` are sold beside the seed's own, on its placements. */
  constructor(readonly seed: SeasonSeed, readonly state: SimulationState, products: readonly SeedProduct[] = []) {
    if (state.seed_id !== seed.seed_id) {
      throw new EngineError('INVALID_SEED', `State belongs to seed ${state.seed_id}, not ${seed.seed_id}`);
    }
    this.traffic = trafficFor(seed).withProducts(products);
  }

  /** A fresh market whose first unprocessed day is the day `nowMs` falls on. */
  static create(seed: SeasonSeed, nowMs: number, products: readonly SeedProduct[] = []): InventorySimulation {
    const traffic = trafficFor(seed);
    return new InventorySimulation(seed, {
      seed_id: seed.seed_id,
      processed_through_day: traffic.calendar.dayOf(nowMs),
      bookings: [],
      log: [],
    }, products);
  }

  today(nowMs: number): number {
    return this.traffic.calendar.dayOf(nowMs);
  }

  /** Run every day that has closed by `nowMs`. Earlier instants are a no-op. */
  advanceTo(nowMs: number): number[] {
    const today = this.today(nowMs);
    const ran: number[] = [];
    while (this.state.processed_through_day < today) {
      this.runDay(this.state.processed_through_day);
      ran.push(this.state.processed_through_day);
      this.state.processed_through_day += 1;
    }
    return ran;
  }

  booking(bookingId: string): Booking {
    const booking = this.state.bookings.find(candidate => candidate.booking_id === bookingId);
    if (!booking) throw new EngineError('BOOKING_NOT_FOUND', `Unknown booking ${bookingId}`);
    return booking;
  }

  private cellsFor(booking: Pick<Booking, 'booking_id' | 'product_id' | 'targeting'>): number[] {
    let cells = this.cellCache.get(booking.booking_id);
    if (!cells) {
      cells = this.traffic.eligibleCells(booking.product_id, booking.targeting);
      this.cellCache.set(booking.booking_id, cells);
    }
    return cells;
  }

  private flightDays(startMs: number, endMs: number): { start: number; end: number } {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      throw new EngineError('INVALID_BOOKING', 'The flight must end after it starts');
    }
    const { calendar } = this.traffic;
    return { start: calendar.dayOf(startMs), end: Math.ceil((endMs - calendar.startMs) / 86_400_000) };
  }

  book(request: BookRequest, nowMs: number): Booking {
    this.advanceTo(nowMs);
    if (this.state.bookings.some(booking => booking.booking_id === request.booking_id)) {
      throw new EngineError('DUPLICATE_BOOKING', `Booking ${request.booking_id} already exists`);
    }
    const product = this.traffic.requireProduct(request.product_id);
    const { start, end } = this.flightDays(request.flight_start_ms, request.flight_end_ms);
    const budget = positive(request.budget, 'budget');
    const targeting: BookingTargeting = structuredClone(request.targeting ?? {});
    const cells = this.traffic.eligibleCells(product.product_id, targeting);
    if (cells.length === 0) throw new EngineError('INVALID_TARGETING', 'The targeting leaves no inventory in this product');
    const booking: Booking = {
      booking_id: request.booking_id,
      product_id: product.product_id,
      kind: product.delivery_type === 'non_guaranteed' ? 'auction' : product.share_of_voice ? 'share_of_voice' : 'goal',
      status: 'active',
      targeting,
      flight_start_day: start,
      flight_end_day: end,
      confirmed_day: this.today(nowMs),
      cpm: 0,
      budget,
      delivered: zeroMetrics(),
      days: [],
    };
    if (booking.kind === 'auction') {
      booking.cpm = positive(request.bid_cpm, 'bid_cpm');
    } else {
      booking.cpm = product.rate_cpm!;
    }
    if (booking.kind === 'goal') {
      booking.impression_goal = Math.floor(request.impression_goal !== undefined
        ? positive(request.impression_goal, 'impression_goal')
        : (budget * 1000) / booking.cpm);
      if (booking.impression_goal <= 0) throw new EngineError('INVALID_BOOKING', 'The budget buys no impressions at this rate');
      this.requireAvailable(booking, cells, booking.impression_goal, nowMs);
    }
    if (booking.kind === 'share_of_voice') {
      booking.share_of_voice = product.share_of_voice!;
      const mine = new Set(cells);
      const sold = this.state.bookings
        .filter(other => other.kind === 'share_of_voice' && other.status !== 'canceled'
          && other.flight_start_day < end && start < other.flight_end_day
          && overlaps(this.cellsFor(other), mine))
        .reduce((sum, other) => sum + (other.share_of_voice ?? 0), 0);
      if (sold + booking.share_of_voice > 1 + 1e-9) {
        throw new EngineError('SOLD_OUT', `Product ${product.product_id} is already sold for part of this flight`);
      }
    }
    this.cellCache.set(booking.booking_id, cells);
    this.state.bookings.push(booking);
    return booking;
  }

  update(bookingId: string, patch: BookingPatch, nowMs: number): Booking {
    this.advanceTo(nowMs);
    const booking = this.booking(bookingId);
    if (booking.status === 'canceled') throw new EngineError('INVALID_BOOKING', `Booking ${bookingId} is canceled`);
    // The goal goes first, so a refused raise leaves the booking unchanged.
    if (patch.impression_goal !== undefined) {
      if (booking.kind !== 'goal') throw new EngineError('INVALID_BOOKING', 'Only goal bookings have an impression goal');
      const goal = Math.floor(positive(patch.impression_goal, 'impression_goal'));
      if (goal > (booking.impression_goal ?? 0)) this.requireAvailable(booking, this.cellsFor(booking), goal, nowMs);
      booking.impression_goal = goal;
    }
    if (patch.budget !== undefined) booking.budget = positive(patch.budget, 'budget');
    if (patch.bid_cpm !== undefined) {
      if (booking.kind !== 'auction') throw new EngineError('INVALID_BOOKING', 'Only non-guaranteed bookings bid');
      booking.cpm = positive(patch.bid_cpm, 'bid_cpm');
    }
    if (patch.flight_end_ms !== undefined) {
      const { end } = this.flightDays(this.traffic.calendar.startMs + booking.flight_start_day * 86_400_000, patch.flight_end_ms);
      booking.flight_end_day = end;
    }
    if (patch.status !== undefined) booking.status = patch.status;
    return booking;
  }

  private forecastTotals(booking: Pick<Booking, 'booking_id' | 'product_id' | 'targeting'>): Float64Array {
    let prefix = this.forecastPrefix.get(booking.booking_id);
    if (!prefix) {
      const cells = this.cellsFor(booking);
      const { days } = this.traffic.calendar;
      prefix = new Float64Array(days + 1);
      for (let d = 0; d < days; d++) prefix[d + 1] = prefix[d] + supplyOf(this.traffic.day(d).forecast, cells);
      this.forecastPrefix.set(booking.booking_id, prefix);
    }
    return prefix;
  }

  private runDay(day: number): void {
    const { calendar } = this.traffic;
    const tables = this.traffic.day(day);
    const remaining: CellCounts = new Map(tables.actual);
    const serving = this.state.bookings.filter(booking => booking.status === 'active'
      && day >= Math.max(booking.confirmed_day + 1, booking.flight_start_day)
      && day < booking.flight_end_day);
    const allocations = new Map<string, CellCounts>();
    const targets = new Map<string, number>();

    for (const booking of serving.filter(b => b.kind === 'share_of_voice').sort((a, b) => (a.booking_id < b.booking_id ? -1 : 1))) {
      allocations.set(booking.booking_id, takeShareOfVoice(remaining, tables.actual, this.cellsFor(booking), booking.share_of_voice ?? 0));
    }

    const goals: GoalRequest[] = [];
    for (const booking of serving.filter(b => b.kind === 'goal')) {
      const left = Math.max(0, (booking.impression_goal ?? 0) - booking.delivered.impressions);
      const affordable = Math.floor(((booking.budget - booking.delivered.spend) * 1000) / booking.cpm + 1e-9);
      // What is left is spread over the days [day, end) in proportion to forecast
      // traffic. The even split when the window has no forecast is defensive: no
      // seed reaches it, but installment cells can have none on days they serve.
      const prefix = this.forecastTotals(booking);
      const end = Math.min(booking.flight_end_day, calendar.days);
      const forecastToday = prefix[day + 1] - prefix[day];
      const sumF = prefix[end] - prefix[day];
      const planned = sumF > 0
        ? Math.ceil((left * forecastToday) / sumF - 1e-9)
        : Math.ceil(left / (booking.flight_end_day - day));
      const target = Math.max(0, Math.min(left, planned, affordable));
      targets.set(booking.booking_id, target);
      goals.push({ id: booking.booking_id, cells: this.cellsFor(booking), target });
    }
    for (const [id, taken] of allocateHighWaterMark(remaining, goals)) allocations.set(id, taken);

    const bids: BidRequest[] = serving.filter(b => b.kind === 'auction').map(booking => ({
      id: booking.booking_id,
      cells: this.cellsFor(booking),
      bid_cpm: booking.cpm,
      daily_budget: Math.max(0, booking.budget - booking.delivered.spend) / (booking.flight_end_day - day),
    }));
    for (const [id, taken] of allocateAuction(remaining, bids, cell => this.traffic.floorOf(cell))) allocations.set(id, taken);

    let sold = 0;
    for (const booking of serving) {
      const taken = allocations.get(booking.booking_id) ?? new Map<number, number>();
      const record = this.recordDay(booking, day, taken, targets.get(booking.booking_id));
      sold += record.impressions;
    }

    const installments: DayLog['installments'] = [];
    for (const installment of this.traffic.installments) {
      if (installment.scheduled_day === day && installment.outcome === 'cancelled') {
        installments.push({ installment_id: installment.installment_id, outcome: 'cancelled' });
      } else if (installment.scheduled_day === day && installment.outcome === 'postponed') {
        installments.push({ installment_id: installment.installment_id, outcome: 'postponed', to_date: calendar.dateOf(installment.actual_day!) });
      }
      if (installment.actual_day === day) installments.push({ installment_id: installment.installment_id, outcome: 'ran' });
    }
    this.state.log.push({
      day,
      date: calendar.dateOf(day),
      actual_impressions: supplyOf(tables.actual, [...tables.actual.keys()]),
      sold_impressions: sold,
      installments,
    });
  }

  private recordDay(booking: Booking, day: number, taken: CellCounts, target: number | undefined): BookingDay {
    let clicks = 0;
    let viewable = 0;
    let completed = 0;
    let conversions = 0;
    let impressions = 0;
    const cells: Array<[number, number]> = [];
    for (const [cell, count] of [...taken].sort((a, b) => a[0] - b[0])) {
      if (count <= 0) continue;
      const rates = this.traffic.rates(day, cell);
      impressions += count;
      clicks += count * rates.click_rate;
      viewable += count * rates.viewability;
      completed += count * rates.completion_rate;
      conversions += count * rates.click_rate * rates.conversion_rate;
      cells.push([cell, count]);
    }
    // Spend is the change in rounded cumulative spend, so the total is
    // always exact: 180,000 impressions at $14 CPM come to $2,520.00 however
    // they split across days, and a bid change mid-flight is priced from then.
    const exactBefore = booking.spend_exact ?? booking.delivered.spend;
    let exactAfter = exactBefore + (impressions * booking.cpm) / 1000;
    if (booking.kind === 'share_of_voice') exactAfter = Math.min(exactAfter, Math.max(exactBefore, booking.budget));
    booking.spend_exact = exactAfter;
    const spend = roundMoney(roundMoney(exactAfter) - booking.delivered.spend);
    const record: BookingDay = {
      day,
      date: this.traffic.calendar.dateOf(day),
      impressions,
      spend,
      clicks: Math.round(clicks),
      viewable_impressions: Math.round(viewable),
      completed_views: Math.round(completed),
      conversions: Math.round(conversions),
      ...(target !== undefined && { target }),
      cells,
    };
    booking.days.push(record);
    addMetrics(booking.delivered, record);
    return record;
  }

  /** The days a booking still serves, inside the season. `today` has not run
   * yet, so a booking confirmed before it serves it too. */
  private servingDays(booking: Pick<Booking, 'confirmed_day' | 'flight_start_day' | 'flight_end_day'>, today: number): { first: number; last: number } {
    return {
      first: Math.max(today, booking.confirmed_day + 1, booking.flight_start_day, 0),
      last: Math.min(booking.flight_end_day, this.traffic.calendar.days),
    };
  }

  /**
   * Reserved impressions per day and cell over the days [first, last), from
   * the guaranteed bookings still to serve, less `except`. A goal booking
   * spreads what is left of its goal over its own serving days wherever the
   * window starts, so a window that opens mid-flight holds only the part
   * that falls inside it.
   */
  private reservations(today: number, first: number, last: number, except?: string): Map<number, CellCounts> {
    const reserved = new Map<number, CellCounts>();
    const add = (day: number, cell: number, value: number) => {
      let counts = reserved.get(day);
      if (!counts) reserved.set(day, (counts = new Map()));
      counts.set(cell, (counts.get(cell) ?? 0) + value);
    };
    for (const booking of this.state.bookings) {
      if (booking.status === 'canceled' || booking.kind === 'auction' || booking.booking_id === except) continue;
      const own = this.servingDays(booking, today);
      const from = Math.max(first, own.first);
      const to = Math.min(last, own.last);
      const cells = this.cellsFor(booking);
      if (booking.kind === 'share_of_voice') {
        for (let day = from; day < to; day++) {
          const forecast = this.traffic.day(day).forecast;
          for (const cell of cells) add(day, cell, (booking.share_of_voice ?? 0) * (forecast.get(cell) ?? 0));
        }
        continue;
      }
      const left = Math.max(0, (booking.impression_goal ?? 0) - booking.delivered.impressions);
      let total = 0;
      for (let day = own.first; day < own.last; day++) total += supplyOf(this.traffic.day(day).forecast, cells);
      if (total === 0 || left === 0) continue;
      const share = Math.min(1, left / total);
      for (let day = from; day < to; day++) {
        const forecast = this.traffic.day(day).forecast;
        for (const cell of cells) add(day, cell, share * (forecast.get(cell) ?? 0));
      }
    }
    return reserved;
  }

  /**
   * Forecast impressions over `cells` and the days [first, last), and the
   * part of them guaranteed bookings other than `except` hold. `free` sees
   * each day and cell with impressions left over.
   */
  private netForecast(
    cells: readonly number[],
    first: number,
    last: number,
    today: number,
    except?: string,
    free?: (day: number, cell: number, impressions: number) => void,
  ): { capacity: number; booked: number; available: number } {
    const reserved = this.reservations(today, first, last, except);
    let capacity = 0;
    let booked = 0;
    for (let day = first; day < last; day++) {
      const forecast = this.traffic.day(day).forecast;
      const held = reserved.get(day);
      for (const cell of cells) {
        const value = forecast.get(cell) ?? 0;
        if (value === 0) continue;
        const taken = Math.min(value, held?.get(cell) ?? 0);
        capacity += value;
        booked += taken;
        if (value > taken) free?.(day, cell, value - taken);
      }
    }
    return { capacity, booked, available: Math.max(0, Math.round(capacity - booked)) };
  }

  /**
   * Refuse a goal whose undelivered part is more than the forecast leaves
   * the booking over its serving days, net of every other guaranteed
   * booking: the `available` a forecast for the same cells and flight
   * reports. A guarantee the market cannot cover is refused, never capped.
   */
  private requireAvailable(booking: Booking, cells: readonly number[], goal: number, nowMs: number): void {
    const today = this.today(nowMs);
    const { first, last } = this.servingDays(booking, today);
    const { available } = this.netForecast(cells, first, last, today, booking.booking_id);
    const left = goal - booking.delivered.impressions;
    if (left <= available) return;
    const delivered = booking.delivered.impressions > 0 ? ` (${left} still to deliver)` : '';
    throw new EngineError('INSUFFICIENT_INVENTORY',
      `Requested ${goal} impressions${delivered}, but only ${available} are available on ${booking.product_id} for this flight and targeting`);
  }

  /** Refuse a goal booking whose undelivered goal the forecast no longer
   * covers: the check `update` runs on a raise. A host that applies several
   * changes as one runs it on each goal they raised, once all are in. */
  requireGoalAvailable(bookingId: string, nowMs: number): void {
    this.advanceTo(nowMs);
    const booking = this.booking(bookingId);
    if (booking.kind !== 'goal' || booking.status === 'canceled') return;
    this.requireAvailable(booking, this.cellsFor(booking), booking.impression_goal ?? 0, nowMs);
  }

  /**
   * Forecast traffic over the cells a product covers, minus what guaranteed
   * bookings have reserved. Days start no earlier than tomorrow, the first
   * day a booking made now could serve.
   */
  forecast(query: ForecastQuery, nowMs: number): ForecastResult {
    this.advanceTo(nowMs);
    const product = this.traffic.requireProduct(query.product_id);
    const { start, end } = this.flightDays(query.flight_start_ms, query.flight_end_ms);
    const cells = this.traffic.eligibleCells(product.product_id, query.targeting);
    const today = this.today(nowMs);
    // The days a booking confirmed now would serve.
    const { first, last } = this.servingDays({ confirmed_day: today, flight_start_day: start, flight_end_day: end }, today);
    let clicks = 0;
    let viewable = 0;
    let completed = 0;
    let conversions = 0;
    const { capacity, booked, available } = this.netForecast(cells, first, last, today, undefined, (day, cell, free) => {
      const rates = this.traffic.rates(day, cell);
      clicks += free * rates.click_rate;
      viewable += free * rates.viewability;
      completed += free * rates.completion_rate;
      conversions += free * rates.click_rate * rates.conversion_rate;
    });
    const cpm = product.delivery_type === 'guaranteed' ? product.rate_cpm : query.bid_cpm;
    const affordable = query.budget !== undefined && cpm ? Math.floor((query.budget * 1000) / cpm) : Number.POSITIVE_INFINITY;
    const impressions = Math.min(available, affordable);
    const scale = available > 0 ? impressions / available : 0;
    const sigma = this.forecastSigma(product.product_id);
    return {
      product_id: product.product_id,
      currency: this.seed.currency,
      start_day: first,
      end_day: Math.max(first, end),
      capacity: Math.round(capacity),
      booked: Math.round(booked),
      available,
      impressions,
      low: Math.round(impressions * Math.max(0, 1 - RANGE_Z * sigma)),
      high: Math.round(impressions * (1 + RANGE_Z * sigma)),
      spend: cpm ? roundMoney((impressions * cpm) / 1000) : 0,
      clicks: Math.round(clicks * scale),
      viewable_impressions: Math.round(viewable * scale),
      completed_views: Math.round(completed * scale),
      conversions: Math.round(conversions * scale),
      ...(cpm !== undefined && { cpm }),
      sigma,
    };
  }

  private forecastSigma(productId: string): number {
    const product = this.traffic.requireProduct(productId);
    const sigmas = product.placement_ids.map(id => {
      const placement = this.traffic.placements.get(id)!;
      if (!isInstallmentChannel(placement.channel)) return this.seed.forecast_error.day_sigma;
      return Math.max(0, ...(product.collection_ids ?? []).map(cid => this.traffic.collections.get(cid)!.audience_sigma));
    });
    return Math.max(...sigmas);
  }

  /**
   * Delivery as reported at `nowMs`: each day is released once it has
   * closed and the product's reporting lag has passed.
   */
  delivery(bookingId: string, nowMs: number): DeliveryReport {
    this.advanceTo(nowMs);
    const booking = this.booking(bookingId);
    const lag = this.traffic.reportingLagDays(booking.product_id);
    const today = this.today(nowMs);
    const days = booking.days.filter(record => record.day + lag < today);
    const totals = zeroMetrics();
    for (const record of days) addMetrics(totals, record);
    const { days: _all, ...summary } = booking;
    const reportedThrough = days.length > 0 ? days[days.length - 1].day : undefined;
    let expected: number | undefined;
    if (booking.kind === 'goal' && reportedThrough !== undefined) {
      const firstServe = Math.max(booking.confirmed_day + 1, booking.flight_start_day);
      const span = booking.flight_end_day - firstServe;
      const prefix = this.forecastTotals(booking);
      const end = Math.min(booking.flight_end_day, this.traffic.calendar.days);
      const from = Math.min(Math.max(0, firstServe), end);
      const planned = prefix[end] - prefix[from];
      const through = prefix[Math.min(reportedThrough + 1, end)] - prefix[from];
      const fraction = planned > 0 ? through / planned : (reportedThrough + 1 - firstServe) / Math.max(1, span);
      expected = Math.round((booking.impression_goal ?? 0) * Math.min(1, fraction));
    }
    return {
      booking: structuredClone(summary),
      ...(reportedThrough !== undefined && { reported_through_day: reportedThrough }),
      totals,
      days: structuredClone(days),
      ...(expected !== undefined && { expected_impressions: expected }),
    };
  }

  /** What is known about each installment at `nowMs`: an outcome is known
   * from its scheduled day. */
  installmentStatuses(nowMs: number, productId?: string): InstallmentStatus[] {
    this.advanceTo(nowMs);
    const today = this.today(nowMs);
    const { calendar } = this.traffic;
    const installments = productId ? this.traffic.productInstallments(productId) : this.traffic.installments;
    return installments.map(installment => {
      const known = installment.scheduled_day <= today;
      let state: InstallmentState = 'scheduled';
      if (known && installment.outcome === 'cancelled') state = 'cancelled';
      else if (installment.actual_day !== undefined && installment.actual_day <= today) state = 'published';
      else if (known && installment.outcome === 'postponed') state = 'postponed';
      return {
        ...installment,
        state,
        ...(known && installment.outcome === 'postponed' && { rescheduled_date: calendar.dateOf(installment.actual_day!) }),
      };
    });
  }
}
