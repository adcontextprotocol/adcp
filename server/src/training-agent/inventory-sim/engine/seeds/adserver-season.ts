/**
 * Season seed for a simulated ad server: two news and sports sites with
 * display, video and a homepage takeover, sold guaranteed and in auction.
 *
 * Scripted events:
 *  - `sports_hero_outage`: the sports hero unit serves a quarter of its
 *    traffic for five days, so a guarantee on it falls behind and has to
 *    catch up.
 *  - `election_spike`: news traffic nearly doubles for three days.
 */
import type { SeasonSeed } from '../types.js';

export const ADSERVER_SEASON: SeasonSeed = {
  seed_id: 'adserver-2027-lead-time',
  rng_seed: 'adserver-2027-v1',
  start_date: '2026-11-01',
  days: 730,
  currency: 'USD',
  regions: [
    { region_id: 'us_northeast', country: 'US', name: 'US Northeast', share: 0.3 },
    { region_id: 'us_south', country: 'US', name: 'US South', share: 0.3 },
    { region_id: 'us_west', country: 'US', name: 'US West', share: 0.25 },
    { region_id: 'ca', country: 'CA', name: 'Canada', share: 0.15 },
  ],
  audience_profiles: [
    { profile_id: 'young_urban', name: 'Young urban', share: 0.3, rate_multipliers: { click_rate: 1.3, conversion_rate: 0.8 } },
    { profile_id: 'families', name: 'Families', share: 0.25 },
    { profile_id: 'professionals', name: 'Professionals', share: 0.3, rate_multipliers: { viewability: 1.05, conversion_rate: 1.3 } },
    { profile_id: 'retirees', name: 'Retirees', share: 0.15, rate_multipliers: { click_rate: 0.7, completion_rate: 1.1 } },
  ],
  segments: [
    { segment_id: 'sports_fans', name: 'Sports fans', profile_ids: ['young_urban', 'professionals'] },
    { segment_id: 'household_decision_makers', name: 'Household decision makers', profile_ids: ['families', 'professionals'] },
    { segment_id: 'news_loyalists', name: 'News loyalists', profile_ids: ['professionals', 'retirees'] },
  ],
  properties: [
    { property_id: 'pinnacle_news', name: 'Pinnacle News', domain: 'pinnacle-news.example' },
    { property_id: 'summit_sports', name: 'Summit Sports', domain: 'summit-sports.example', traffic_multiplier: 0.6 },
  ],
  placements: [
    {
      placement_id: 'homepage_takeover',
      name: 'Homepage takeover',
      channel: 'display',
      property_ids: ['pinnacle_news'],
      formats: ['display_image'],
      base_daily_impressions: 60_000,
      floor_cpm: 12,
      rates: { viewability: 0.82, click_rate: 0.004, completion_rate: 0, conversion_rate: 0.03 },
      reporting_lag_days: 0,
    },
    {
      placement_id: 'leaderboard',
      name: 'Leaderboard',
      channel: 'display',
      property_ids: ['pinnacle_news', 'summit_sports'],
      formats: ['display_728x90'],
      base_daily_impressions: 120_000,
      floor_cpm: 2.5,
      rates: { viewability: 0.62, click_rate: 0.0012, completion_rate: 0, conversion_rate: 0.02 },
      reporting_lag_days: 0,
    },
    {
      placement_id: 'medium_rectangle',
      name: 'Medium rectangle',
      channel: 'display',
      property_ids: ['pinnacle_news', 'summit_sports'],
      formats: ['display_300x250'],
      base_daily_impressions: 150_000,
      floor_cpm: 2,
      rates: { viewability: 0.7, click_rate: 0.0015, completion_rate: 0, conversion_rate: 0.02 },
      reporting_lag_days: 0,
    },
    {
      placement_id: 'sports_hero',
      name: 'Sports hero unit',
      channel: 'display',
      property_ids: ['summit_sports'],
      formats: ['display_image'],
      base_daily_impressions: 15_000,
      floor_cpm: 8,
      rates: { viewability: 0.85, click_rate: 0.003, completion_rate: 0, conversion_rate: 0.025 },
      reporting_lag_days: 0,
    },
    {
      placement_id: 'instream_preroll',
      name: 'In-stream pre-roll',
      channel: 'olv',
      property_ids: ['pinnacle_news', 'summit_sports'],
      formats: ['video_preroll', 'video_30s'],
      base_daily_impressions: 40_000,
      floor_cpm: 9,
      rates: { viewability: 0.75, click_rate: 0.002, completion_rate: 0.7, conversion_rate: 0.02 },
      reporting_lag_days: 0,
    },
  ],
  products: [
    {
      product_id: 'homepage_takeover_daily',
      name: 'Pinnacle News homepage takeover',
      description: 'Every homepage impression for the booked days. Share of voice 100%.',
      delivery_type: 'guaranteed',
      placement_ids: ['homepage_takeover'],
      rate_cpm: 18,
      share_of_voice: 1,
    },
    {
      product_id: 'ros_display_guaranteed',
      name: 'Run of site display, guaranteed',
      description: 'Leaderboard and medium rectangle across both sites, with an impression goal.',
      delivery_type: 'guaranteed',
      placement_ids: ['leaderboard', 'medium_rectangle'],
      rate_cpm: 9,
    },
    {
      product_id: 'sports_hero_guaranteed',
      name: 'Summit Sports hero unit, guaranteed',
      description: 'The scarce hero unit on Summit Sports, with an impression goal.',
      delivery_type: 'guaranteed',
      placement_ids: ['sports_hero'],
      rate_cpm: 14,
    },
    {
      product_id: 'sports_fans_display_guaranteed',
      name: 'Sports fans display, guaranteed',
      description: 'Run of site display to the sports fans segment, with an impression goal.',
      delivery_type: 'guaranteed',
      placement_ids: ['leaderboard', 'medium_rectangle'],
      segment_id: 'sports_fans',
      rate_cpm: 12,
    },
    {
      product_id: 'preroll_guaranteed',
      name: 'Pre-roll video, guaranteed',
      description: 'In-stream pre-roll on both sites, with an impression goal.',
      delivery_type: 'guaranteed',
      placement_ids: ['instream_preroll'],
      rate_cpm: 22,
    },
    {
      product_id: 'ros_display_auction',
      name: 'Run of site display, auction',
      description: 'Leaderboard and medium rectangle that guarantees left unsold. First-price, above the floor.',
      delivery_type: 'non_guaranteed',
      placement_ids: ['leaderboard', 'medium_rectangle'],
    },
    {
      product_id: 'preroll_auction',
      name: 'Pre-roll video, auction',
      description: 'Pre-roll that guarantees left unsold. First-price, above the floor.',
      delivery_type: 'non_guaranteed',
      placement_ids: ['instream_preroll'],
    },
  ],
  traffic: {
    weekday_shape: [0.8, 1.05, 1.1, 1.1, 1.05, 1, 0.85],
    trend_per_day: 0.0002,
    truth_daily_sigma: 0.03,
  },
  // Assumed sizes, not measured: a 6% same-day spread for display and video, 5% cell noise at the median cell, -2% publisher
  // bias. Change them in the season file; to be recalibrated from real publisher data.
  forecast_error: {
    channel_sigma: { display: 0.06, olv: 0.06 },
    ar1_phi: 0.85,
    lead_time_tau_days: 14,
    lead_time_horizon_days: 60,
    log_clip: 0.6931471805599453,
    // 0.05 × √3799, the median cell-day expected impressions
    cell_kappa: 3.08,
    cell_min_impressions: 100,
    publishers: [
      { publisher_id: 'pinnacle_news', bias: -0.02 },
      { publisher_id: 'summit_sports', bias: -0.02 },
    ],
  },
  events: [
    {
      type: 'traffic_multiplier',
      event_id: 'sports_hero_outage',
      description: 'The sports hero unit serves a quarter of its traffic while a redesign rolls out.',
      start_date: '2027-01-08',
      end_date: '2027-01-12',
      multiplier: 0.25,
      placement_ids: ['sports_hero'],
    },
    {
      type: 'traffic_multiplier',
      event_id: 'election_spike',
      description: 'A breaking news story nearly doubles Pinnacle News traffic.',
      start_date: '2027-01-20',
      end_date: '2027-01-22',
      multiplier: 1.8,
      property_ids: ['pinnacle_news'],
    },
  ],
};
