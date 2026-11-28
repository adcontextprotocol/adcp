/**
 * Season seed for a simulated content platform: a weekly podcast, a weekly
 * newsletter and a fortnightly creator series, each sold as exclusive
 * sponsorships of single installments.
 *
 * Scripted events:
 *  - `morning_brief_012_cancelled`: the 2027-01-18 podcast episode is
 *    cancelled, so its sponsor receives nothing.
 *  - `maker_studio_006_postponed`: the 2027-01-18 creator video moves to
 *    2027-01-23.
 */
import type { SeasonSeed } from '../types.js';

export const CONTENT_SEASON: SeasonSeed = {
  seed_id: 'content-2027-lead-time',
  rng_seed: 'content-2027-v1',
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
    { profile_id: 'young_urban', name: 'Young urban', share: 0.35, rate_multipliers: { click_rate: 1.3 } },
    { profile_id: 'families', name: 'Families', share: 0.2 },
    { profile_id: 'professionals', name: 'Professionals', share: 0.35, rate_multipliers: { conversion_rate: 1.3 } },
    { profile_id: 'retirees', name: 'Retirees', share: 0.1, rate_multipliers: { completion_rate: 1.05 } },
  ],
  segments: [
    { segment_id: 'commuters', name: 'Commuters', profile_ids: ['young_urban', 'professionals'] },
    { segment_id: 'makers', name: 'Makers and DIY', profile_ids: ['young_urban', 'families'] },
  ],
  properties: [
    { property_id: 'morning_brief_feed', name: 'The Morning Brief (podcast)', domain: 'morning-brief.example' },
    { property_id: 'weekly_dispatch_list', name: 'The Weekly Dispatch (newsletter)', domain: 'weekly-dispatch.example' },
    { property_id: 'maker_studio_channel', name: 'Maker Studio (creator channel)', domain: 'maker-studio.example' },
  ],
  placements: [
    {
      placement_id: 'podcast_midroll',
      name: 'Host-read mid-roll',
      channel: 'podcast',
      property_ids: ['morning_brief_feed'],
      formats: ['audio_spot'],
      floor_cpm: 20,
      rates: { viewability: 1, click_rate: 0.001, completion_rate: 0.86, conversion_rate: 0.03 },
      reporting_lag_days: 1,
    },
    {
      placement_id: 'newsletter_sponsor',
      name: 'Presenting sponsor block',
      channel: 'newsletter',
      property_ids: ['weekly_dispatch_list'],
      formats: ['email_sponsored'],
      floor_cpm: 25,
      rates: { viewability: 1, click_rate: 0.012, completion_rate: 0, conversion_rate: 0.02 },
      reporting_lag_days: 0,
    },
    {
      placement_id: 'creator_integration',
      name: 'Creator integration',
      channel: 'creator_video',
      property_ids: ['maker_studio_channel'],
      formats: ['creator_brief'],
      floor_cpm: 25,
      rates: { viewability: 0.95, click_rate: 0.004, completion_rate: 0.55, conversion_rate: 0.02 },
      reporting_lag_days: 1,
    },
  ],
  collections: [
    {
      collection_id: 'morning_brief',
      name: 'The Morning Brief',
      channel: 'podcast',
      property_id: 'morning_brief_feed',
      placement_id: 'podcast_midroll',
      first_date: '2026-11-02',
      cadence_days: 7,
      count: 100,
      expected_audience: 40_000,
      audience_sigma: 0.12,
    },
    {
      collection_id: 'weekly_dispatch',
      name: 'The Weekly Dispatch',
      channel: 'newsletter',
      property_id: 'weekly_dispatch_list',
      placement_id: 'newsletter_sponsor',
      first_date: '2026-11-05',
      cadence_days: 7,
      count: 100,
      expected_audience: 120_000,
      audience_sigma: 0.05,
    },
    {
      collection_id: 'maker_studio',
      name: 'Maker Studio',
      channel: 'creator_video',
      property_id: 'maker_studio_channel',
      placement_id: 'creator_integration',
      first_date: '2026-11-09',
      cadence_days: 14,
      count: 50,
      expected_audience: 250_000,
      audience_sigma: 0.25,
    },
  ],
  products: [
    {
      product_id: 'morning_brief_midroll',
      name: 'The Morning Brief, episode sponsorship',
      description: 'Exclusive host-read mid-roll in each booked episode. Listens build over 30 days.',
      delivery_type: 'guaranteed',
      placement_ids: ['podcast_midroll'],
      collection_ids: ['morning_brief'],
      rate_cpm: 25,
      share_of_voice: 1,
    },
    {
      product_id: 'weekly_dispatch_sponsor',
      name: 'The Weekly Dispatch, presenting sponsor',
      description: 'Exclusive presenting sponsor of each booked issue. Opens build over 3 days.',
      delivery_type: 'guaranteed',
      placement_ids: ['newsletter_sponsor'],
      collection_ids: ['weekly_dispatch'],
      rate_cpm: 30,
      share_of_voice: 1,
    },
    {
      product_id: 'maker_studio_integration',
      name: 'Maker Studio, creator integration',
      description: 'Exclusive integration in each booked video. Views build over six weeks.',
      delivery_type: 'guaranteed',
      placement_ids: ['creator_integration'],
      collection_ids: ['maker_studio'],
      rate_cpm: 35,
      share_of_voice: 1,
    },
  ],
  traffic: { weekday_shape: [1, 1, 1, 1, 1, 1, 1], truth_daily_sigma: 0.03 },
  // Assumed sizes, not measured: no same-day spread, 4% cell noise at the 100-impression floor, audience shocks of 12% for
  // podcast, 5% for newsletter and 25% for creator video, no publisher bias. Change them in the season file; to be recalibrated
  // from real publisher data.
  forecast_error: {
    channel_sigma: { podcast: 0, newsletter: 0, creator_video: 0 },
    ar1_phi: 0.85,
    lead_time_tau_days: 14,
    lead_time_horizon_days: 60,
    log_clip: 0.6931471805599453,
    // 0.04 × √100: the median cell-day (89 impressions) sits under the 100-impression floor
    cell_kappa: 0.4,
    cell_min_impressions: 100,
  },
  events: [
    {
      type: 'installment_cancelled',
      event_id: 'morning_brief_012_cancelled',
      description: 'The host is ill and the 2027-01-18 episode is cancelled.',
      installment_id: 'morning_brief_012',
    },
    {
      type: 'installment_postponed',
      event_id: 'maker_studio_006_postponed',
      description: 'A shoot overruns and the 2027-01-18 video moves to 2027-01-23.',
      installment_id: 'maker_studio_006',
      to_date: '2027-01-23',
    },
  ],
};
