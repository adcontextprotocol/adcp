/**
 * Types for the deterministic inventory delivery engine.
 *
 * The engine has no imports from the rest of the training agent, so it can
 * move into `@adcp/sdk` later. Every type here is plain JSON: a season seed
 * is data a simulator can write by hand, and a simulation state is data a
 * host can persist between calls.
 */

/** Channels whose audience builds up after an installment is published. */
export type InstallmentChannel = 'podcast' | 'newsletter' | 'creator_video';

/** Every channel a placement can serve. */
export type PlacementChannel = 'display' | 'olv' | InstallmentChannel;

/** Per-impression rates a cell carries. Click and conversion rates are per
 * impression and per click respectively; completion applies to video and
 * audio. */
export interface CellRates {
  viewability: number;
  click_rate: number;
  completion_rate: number;
  conversion_rate: number;
}

export interface SeedRegion {
  region_id: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
  /** ISO 3166-2 subdivision, when the region is one. */
  subdivision?: string;
  name: string;
  /** Share of traffic. Region shares sum to 1. */
  share: number;
}

/** A non-overlapping slice of the audience. A reader is in exactly one. */
export interface SeedAudienceProfile {
  profile_id: string;
  name: string;
  /** Share of traffic. Profile shares sum to 1. */
  share: number;
  /** Multipliers on the placement's base rates. */
  rate_multipliers?: Partial<CellRates>;
}

/** A targetable segment: a set of profiles. Two segments that share a
 * profile overlap, and targeting both counts each reader once. */
export interface SeedSegment {
  segment_id: string;
  name: string;
  profile_ids: string[];
}

export interface SeedProperty {
  property_id: string;
  name: string;
  domain: string;
  /** Scales every placement's base traffic on this property. Default 1. */
  traffic_multiplier?: number;
  /** Groups properties into one publisher for the forecast error: a publisher's
   * properties share its bias, its spikes and its same-day and revision deviations. Default: the property's own id. */
  publisher_id?: string;
}

export interface SeedPlacement {
  placement_id: string;
  name: string;
  channel: PlacementChannel;
  property_ids: string[];
  /** Labels for the creative formats the placement serves; the host maps
   * them onto its own format catalogue. Format belongs to the placement; it
   * is not a targeting dimension. */
  formats: string[];
  /** Daily impressions per property before region, profile, weekday and
   * trend shaping. Absent for installment placements, whose traffic comes
   * from their collections. */
  base_daily_impressions?: number;
  /** Lowest CPM an auction bid must reach. */
  floor_cpm: number;
  rates: CellRates;
  /** Days after a day closes before its delivery is reported. 0 means the
   * next day. */
  reporting_lag_days: number;
}

export type SeedDeliveryType = 'guaranteed' | 'non_guaranteed';

export interface SeedProduct {
  product_id: string;
  name: string;
  description: string;
  delivery_type: SeedDeliveryType;
  placement_ids: string[];
  /** Narrows the placements' properties. Default: all of them. */
  property_ids?: string[];
  /** Restricts the product to one segment. Default: every profile. */
  segment_id?: string;
  /** Fixed CPM for guaranteed products. */
  rate_cpm?: number;
  /** Share of every covered cell a booking takes, for share-of-voice
   * products such as a takeover or an episode sponsorship. */
  share_of_voice?: number;
  /** Collections whose installments the product sells. */
  collection_ids?: string[];
}

export interface SeedCollection {
  collection_id: string;
  name: string;
  channel: InstallmentChannel;
  property_id: string;
  placement_id: string;
  /** First installment's date, `YYYY-MM-DD`. */
  first_date: string;
  cadence_days: number;
  count: number;
  /** Expected audience of one installment, over its whole curve. */
  expected_audience: number;
  /** Spread of an installment's actual audience around expected. No forecast knows it. */
  audience_sigma: number;
}

export interface TrafficMultiplierEvent {
  type: 'traffic_multiplier';
  event_id: string;
  description: string;
  start_date: string;
  /** Inclusive. */
  end_date: string;
  multiplier: number;
  placement_ids?: string[];
  property_ids?: string[];
  region_ids?: string[];
}

export interface InstallmentPostponedEvent {
  type: 'installment_postponed';
  event_id: string;
  description: string;
  installment_id: string;
  to_date: string;
}

export interface InstallmentCancelledEvent {
  type: 'installment_cancelled';
  event_id: string;
  description: string;
  installment_id: string;
}

export type SeasonEvent = TrafficMultiplierEvent | InstallmentPostponedEvent | InstallmentCancelledEvent;

export interface SeasonSeed {
  seed_id: string;
  /** Mixed into every random draw. Change it to get a different season
   * with the same shape. */
  rng_seed: string;
  /** First day of the season, `YYYY-MM-DD`, UTC. */
  start_date: string;
  days: number;
  currency: string;
  regions: SeedRegion[];
  audience_profiles: SeedAudienceProfile[];
  segments: SeedSegment[];
  properties: SeedProperty[];
  placements: SeedPlacement[];
  products: SeedProduct[];
  collections?: SeedCollection[];
  traffic: {
    /** Seven multipliers, Sunday first (`Date#getUTCDay`). */
    weekday_shape: number[];
    /** Linear growth per day of the season. Default 0. */
    trend_per_day?: number;
    /** Twelve multipliers on traffic by calendar month, January first, each above 0. Default all 1. */
    month_shape?: number[];
    /** Standard deviation of the log day-to-day variation of each placement. It is in actual traffic only: no forecast knows it. 0 or more. Default 0. */
    truth_daily_sigma?: number;
  };
  /**
   * How wrong forecasts are. The errors live in actual traffic: its deviation from the expected pattern is
   * made of a same-day publisher deviation, revisions revealed on the days before the target day and a cell
   * deviation. A forecast carries the publisher bias as an offset and knows the revisions revealed before
   * its day and the past same-day deviations, never the rest. The sizes below are assumptions, easy to
   * change and to be recalibrated from real publisher data.
   */
  forecast_error: {
    /** Standard deviation, per channel, of the log deviation a publisher's traffic has on a day (shared by its channels, scaled by `error_scale`); revisions add to it. 0 or more. Needed for every channel a placement uses. */
    channel_sigma: Partial<Record<PlacementChannel, number>>;
    /** Day-to-day correlation of a publisher's same-day deviation and of each revision's carry-over to later days, from 0 up to but not including 1. */
    ar1_phi: number;
    /** Sets how much the revisions weigh: each is scaled by 1 / sqrt(this), so the error's variance grows with min(lead time, horizon) / this. Above 0. */
    lead_time_tau_days: number;
    /** How many days ahead of a day its revisions are revealed, so the lead time beyond which the revision part of the error stops growing. A whole number from 0 to 366, within the season's build budget. */
    lead_time_horizon_days: number;
    /** Limit, in either direction, on the deviation of actual traffic and, separately, on the forecast's known part of it. The error is within twice this; the bias sits outside it. Above 0. */
    log_clip: number;
    /** Strength of the per-cell deviation, which is small on busy cells and large on thin ones. No forecast knows it. 0 or more. */
    cell_kappa: number;
    /** Impressions at which a cell counts as busy: a cell expecting fewer is treated as having this many when sizing its deviation. 1 or more. */
    cell_min_impressions: number;
    /** Per-publisher settings. A publisher left out has no bias, bias spread or scale change. */
    publishers?: Array<{
      /** A `publisher_id` that at least one property has. Listed once. */
      publisher_id: string;
      /** How far actual traffic sits from this publisher's forecasts, as a log offset: negative means actual comes in below the forecast. Forecasts carry -bias as an offset; they do not correct for it. */
      bias: number;
      /** Standard deviation of a per-publisher bias drawn around `bias`. 0 or more. Default 0. */
      bias_sigma?: number;
      /** Multiplier on this publisher's deviation. 0 or more. Default 1. */
      error_scale?: number;
    }>;
    /** Sudden surges and slumps in actual traffic that decay over days. A forecast knows a spike only once it has started. */
    spikes?: {
      /** Fewest spikes a publisher has over the season. A whole number, 0 or more. */
      per_publisher_min: number;
      /** Most spikes a publisher has over the season. A whole number, at least the minimum and at most `days`. */
      per_publisher_max: number;
      /** Smallest relative size of a spike, above -1 (-0.5 is a 50% slump). */
      size_min: number;
      /** Largest relative size of a spike, at least `size_min`. */
      size_max: number;
      /** Share of a spike left each day after it starts, from 0 up to but not including 1. */
      decay: number;
      /** Standard deviation of the log error with which forecasts see a spike's decay. 0 or more. */
      decay_forecast_sigma: number;
    };
  };
  events?: SeasonEvent[];
}

/** One region × property × placement × profile (× installment) column of
 * the traffic tables. A cell is a slot on a day. */
export interface CellSlot {
  index: number;
  region_id: string;
  property_id: string;
  placement_id: string;
  profile_id: string;
  installment_id?: string;
}

export interface Installment {
  installment_id: string;
  collection_id: string;
  /** 1-based position in the collection. */
  sequence: number;
  scheduled_date: string;
  scheduled_day: number;
  /** Day it actually runs, or undefined when cancelled. */
  actual_day?: number;
  outcome: 'runs' | 'postponed' | 'cancelled';
  expected_audience: number;
}

export type BookingKind = 'goal' | 'share_of_voice' | 'auction';

export type BookingStatus = 'active' | 'paused' | 'canceled';

export interface BookingTargeting {
  region_ids?: string[];
  segment_ids?: string[];
  installment_ids?: string[];
}

export interface DeliveryMetrics {
  impressions: number;
  spend: number;
  clicks: number;
  viewable_impressions: number;
  completed_views: number;
  conversions: number;
}

export interface BookingDay extends DeliveryMetrics {
  day: number;
  date: string;
  /** Daily target for goal bookings. */
  target?: number;
  /** Impressions per cell slot, as [slot index, impressions] pairs. */
  cells: Array<[number, number]>;
}

export interface Booking {
  booking_id: string;
  product_id: string;
  kind: BookingKind;
  status: BookingStatus;
  targeting: BookingTargeting;
  flight_start_day: number;
  /** Exclusive. */
  flight_end_day: number;
  /** Day the booking was confirmed on. It serves from the next day. */
  confirmed_day: number;
  impression_goal?: number;
  share_of_voice?: number;
  /** Price paid per thousand: the fixed rate, or the auction bid. */
  cpm: number;
  budget: number;
  delivered: DeliveryMetrics;
  /** Unrounded spend to date. Each day's spend is the change in its rounded
   * value, so daily rounding never drifts the total. Absent in states saved
   * before it existed; `delivered.spend` stands in. */
  spend_exact?: number;
  days: BookingDay[];
}

export interface DayLog {
  day: number;
  date: string;
  actual_impressions: number;
  sold_impressions: number;
  installments: Array<{ installment_id: string; outcome: 'ran' | 'postponed' | 'cancelled'; to_date?: string }>;
}

/** Everything a host persists for one simulated market. */
export interface SimulationState {
  seed_id: string;
  /** Days before this index have been run. */
  processed_through_day: number;
  bookings: Booking[];
  log: DayLog[];
}
