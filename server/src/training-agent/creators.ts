/**
 * CreatorLoop — a fictional creator marketplace for the training agent.
 *
 * Each creator is a `kind: channel` collection sold as its own guaranteed
 * flat-rate product. Installments are upcoming sponsored video slots with the
 * material deadlines a creator integration needs (talking points, then script,
 * then a draft cut for review). Audience composition is declared by the
 * platform itself; see `audienceEvidence` for the evidence shape.
 *
 * Slot and deadline dates are computed once, relative to process start (the
 * catalog is also built once), so a redeploy refreshes them; a process that
 * outlives the 60-day first-slot lead serves slots in the past. Audience
 * evidence is an immutable snapshot, so its dates are fixed.
 */

import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { PublisherProfile, ShowDefinition } from './types.js';

const PUBLISHER_DOMAIN = 'creatorloop.example';
const EVIDENCE_PROVIDER = { domain: PUBLISHER_DOMAIN };
const EVIDENCE_VERSION = '2026-Q3';
const EVIDENCE_BASELINE = {
  system: `https://${PUBLISHER_DOMAIN}/audience/baselines`,
  population_id: 'creatorloop_active_viewers_90d',
  version: EVIDENCE_VERSION,
  description: 'Viewers who watched at least one video on the channel in the trailing 90 days.',
};
// Gender is not a canonical dimension yet, so it is declared as a provider-scoped
// HTTPS dimension.
const GENDER_DIMENSION = `https://${PUBLISHER_DOMAIN}/dimensions/gender`;

const DAY_MS = 24 * 60 * 60 * 1000;
const SLOT_CADENCE_DAYS = 14;
const FIRST_SLOT_LEAD_DAYS = 60;

type Platform = 'youtube' | 'tiktok';

interface CreatorSeed {
  slug: string;
  creator: string;
  channelName: string;
  platform: Platform;
  channelId: string;
  genre: string[];
  tagline: string;
  /** Flat fee for one sponsored integration, USD. */
  rate: number;
  /** Views per installment: low / mid / high. */
  views: [number, number, number];
  /** Declared share of active viewers aged 18-24, 25-34, 35-44. */
  ageShares: [number, number, number];
  /** Declared share of active viewers who are women. */
  femaleShare: number;
  sampleTitles: [string, string];
  slotTopics: [string, string, string];
}

const SEEDS: CreatorSeed[] = [
  {
    slug: 'juniper_vale', creator: 'Juniper Vale', channelName: 'Juniper Vale Cooks', platform: 'youtube',
    channelId: 'UCcl0juniperVale7Kq2mXa1', genre: ['food', 'cooking'],
    tagline: 'Weeknight dinners for people who hate washing up.',
    rate: 6500, views: [180_000, 240_000, 310_000], ageShares: [0.22, 0.38, 0.21], femaleShare: 0.64,
    sampleTitles: ['One-pan pasta, three ways', 'The 20-minute pantry challenge'],
    slotTopics: ['Sheet-pan dinners', 'Meal prep Sunday', 'Holiday leftovers'],
  },
  {
    slug: 'tobias_quill', creator: 'Tobias Quill', channelName: 'Quill Tech Teardown', platform: 'youtube',
    channelId: 'UCcl0tobiasQuill9Hd4rTb3', genre: ['technology', 'gadgets'],
    tagline: 'Honest teardowns of the gadgets on your wish list.',
    rate: 9800, views: [310_000, 420_000, 560_000], ageShares: [0.24, 0.41, 0.2], femaleShare: 0.27,
    sampleTitles: ['Is the budget laptop actually good?', 'Five desk upgrades under $50'],
    slotTopics: ['Desk setup refresh', 'Smart home starter kit', 'Travel tech'],
  },
  {
    slug: 'nadia_ferro', creator: 'Nadia Ferro', channelName: 'Nadia Ferro Fitness', platform: 'tiktok',
    channelId: 'nadiaferro.cl0', genre: ['fitness', 'wellness'],
    tagline: 'Short, sweaty routines that fit between meetings.',
    rate: 5200, views: [420_000, 650_000, 900_000], ageShares: [0.34, 0.36, 0.14], femaleShare: 0.71,
    sampleTitles: ['10-minute desk-break circuit', 'What I eat before a morning run'],
    slotTopics: ['New-year routine reset', 'Recovery day', 'Gym bag essentials'],
  },
  {
    slug: 'kenji_arden', creator: 'Kenji Arden', channelName: 'Arden Trail Notes', platform: 'youtube',
    channelId: 'UCcl0kenjiArden3Fz8wLc5p', genre: ['outdoor', 'travel'],
    tagline: 'Long hikes, honest gear reviews, and very good snacks.',
    rate: 7200, views: [150_000, 210_000, 290_000], ageShares: [0.15, 0.37, 0.27], femaleShare: 0.41,
    sampleTitles: ['Three days on a coastal trail', 'Ultralight pack: what I cut'],
    slotTopics: ['Winter layering', 'Trail snacks', 'Campsite cooking'],
  },
  {
    slug: 'sol_marquez', creator: 'Sol Marquez', channelName: 'Sol Marquez Plays', platform: 'youtube',
    channelId: 'UCcl0solMarquez1Pn6vYd2k', genre: ['gaming', 'entertainment'],
    tagline: 'Cozy co-op runs and speedrun disasters.',
    rate: 8400, views: [260_000, 380_000, 520_000], ageShares: [0.39, 0.34, 0.1], femaleShare: 0.38,
    sampleTitles: ['We tried to speedrun a farming sim', 'Co-op night with chat'],
    slotTopics: ['Launch-week playthrough', 'Subscriber game night', 'Peripheral review'],
  },
  {
    slug: 'priya_halden', creator: 'Priya Halden', channelName: 'Halden Home Studio', platform: 'tiktok',
    channelId: 'haldenhomestudio', genre: ['home', 'diy'],
    tagline: 'Rental-friendly makeovers under a weekend and a budget.',
    rate: 4800, views: [380_000, 560_000, 780_000], ageShares: [0.2, 0.43, 0.2], femaleShare: 0.74,
    sampleTitles: ['Renter-friendly entryway reset', 'Thrifted shelf, three finishes'],
    slotTopics: ['Small-space storage', 'Weekend paint refresh', 'Holiday table styling'],
  },
  {
    slug: 'dex_okafor', creator: 'Dex Okafor', channelName: 'Dex Okafor Money Minute', platform: 'tiktok',
    channelId: 'dexmoneyminute', genre: ['personal_finance', 'education'],
    tagline: 'One money idea a day, explained in sixty seconds.',
    rate: 5600, views: [300_000, 480_000, 700_000], ageShares: [0.28, 0.42, 0.17], femaleShare: 0.44,
    sampleTitles: ['Emergency fund in four steps', 'Reading a pay stub'],
    slotTopics: ['First-job budgeting', 'Tax season prep', 'Saving for travel'],
  },
  {
    slug: 'lena_brightwater', creator: 'Lena Brightwater', channelName: 'Brightwater Beauty Lab', platform: 'youtube',
    channelId: 'UCcl0lenaBrightw4Ye9sNm8', genre: ['beauty', 'lifestyle'],
    tagline: 'Ingredient-first skincare and low-effort makeup.',
    rate: 11000, views: [340_000, 470_000, 640_000], ageShares: [0.29, 0.4, 0.18], femaleShare: 0.86,
    sampleTitles: ['A five-product morning routine', 'Drugstore dupes, tested'],
    slotTopics: ['Sunscreen deep-dive', 'Travel skincare kit', 'Night routine'],
  },
  {
    slug: 'ravi_castellan', creator: 'Ravi Castellan', channelName: 'Castellan Garage', platform: 'youtube',
    channelId: 'UCcl0raviCastel6Wb3tHj9q', genre: ['automotive', 'diy'],
    tagline: 'Weekend wrenching and honest used-car buying advice.',
    rate: 7800, views: [200_000, 290_000, 390_000], ageShares: [0.12, 0.33, 0.3], femaleShare: 0.19,
    sampleTitles: ['What to check before buying used', 'Brake pads in an afternoon'],
    slotTopics: ['Winter tire swap', 'Garage organization', 'Road-trip prep'],
  },
  {
    slug: 'odette_moreau', creator: 'Odette Moreau', channelName: 'Odette Moreau Studio Diaries', platform: 'tiktok',
    channelId: 'odettestudiodiaries', genre: ['fashion', 'lifestyle'],
    tagline: 'Capsule wardrobes and small-studio daily life.',
    rate: 7500, views: [450_000, 620_000, 850_000], ageShares: [0.31, 0.37, 0.15], femaleShare: 0.81,
    sampleTitles: ['Ten pieces, thirty outfits', 'A day in the studio'],
    slotTopics: ['Seasonal capsule', 'Gift guide', 'Closet reset'],
  },
];

const PLATFORM = {
  youtube: {
    propertyId: 'creatorloop_video',
    domain: `video.${PUBLISHER_DOMAIN}`,
    identifierType: 'youtube_channel_id',
    width: 1920,
    height: 1080,
    label: 'long-form video',
  },
  tiktok: {
    propertyId: 'creatorloop_short_video',
    domain: `shorts.${PUBLISHER_DOMAIN}`,
    identifierType: 'tiktok_id',
    width: 1080,
    height: 1920,
    label: 'short-form video',
  },
} as const;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Evidence is immutable and content-addressed: the digest covers the JCS
 * canonical form of the object without `content_digest` and `attestation_refs`.
 */
function evidence(
  seed: CreatorSeed,
  key: string,
  audience: Record<string, unknown>,
  value: number,
): Record<string, unknown> {
  const evidenceId = `creatorloop_${seed.slug}_${key}`;
  const core = {
    evidence_id: evidenceId,
    snapshot_id: `${evidenceId}_${EVIDENCE_VERSION.toLowerCase()}`,
    version: EVIDENCE_VERSION,
    audience,
    relationship: 'composition',
    value,
    unit: 'fraction',
    baseline: { ...EVIDENCE_BASELINE },
    evidence_type: 'seller_declared',
    methodology: 'declared',
    subject_type: 'individual',
    provider: EVIDENCE_PROVIDER,
    measurement_window: { start: '2026-06-01', end: '2026-08-31' },
    last_updated: '2026-09-15T00:00:00Z',
  };
  const canonical = canonicalize(core);
  if (canonical === undefined) throw new Error(`Cannot canonicalize audience evidence ${evidenceId}`);
  return { ...core, content_digest: `sha256:${createHash('sha256').update(canonical).digest('hex')}` };
}

function audienceEvidence(seed: CreatorSeed): Array<Record<string, unknown>> {
  const bands = [[18, 24], [25, 34], [35, 44]] as const;
  return [
    ...bands.map(([min, max], i) => evidence(
      seed,
      `age_${min}_${max}`,
      { dimension: 'age', range: { min, max }, label: `Ages ${min}-${max}` },
      seed.ageShares[i],
    )),
    evidence(
      seed,
      'gender_female',
      {
        dimension: GENDER_DIMENSION,
        value: 'female',
        label: 'Women',
        taxonomy: { system: GENDER_DIMENSION, version: '1', value_id: 'female' },
      },
      seed.femaleShare,
    ),
  ];
}

function slots(seed: CreatorSeed): NonNullable<ShowDefinition['episodes']> {
  const anchor = Math.floor(Date.now() / DAY_MS) * DAY_MS + FIRST_SLOT_LEAD_DAYS * DAY_MS;
  return seed.slotTopics.map((topic, i) => {
    const at = anchor + i * SLOT_CADENCE_DAYS * DAY_MS;
    const before = (days: number) => iso(at - days * DAY_MS);
    return {
      episodeId: `${seed.slug}_slot_${i + 1}`,
      title: `${seed.channelName}: ${topic} (sponsored integration)`,
      // The last slot depends on the creator's content calendar.
      status: i === seed.slotTopics.length - 1 ? 'tentative' : 'scheduled',
      validUntil: before(42),
      scheduledAt: iso(at),
      durationSeconds: seed.platform === 'tiktok' ? 60 : 720,
      deadlines: {
        // booking <= cancellation <= every material due date <= scheduled_at.
        bookingDeadline: before(42),
        cancellationDeadline: before(35),
        // Seller-defined stages, in order: talking points, then the creator's
        // script, then a draft cut for review.
        materialDeadlines: [
          { stage: 'talking_points', dueAt: before(28), label: 'Talking points and brand guidelines' },
          { stage: 'script', dueAt: before(14), label: 'Creator script for brand approval' },
          { stage: 'draft', dueAt: before(7), label: 'Draft cut for final review' },
        ],
      },
    };
  });
}

function creatorShow(seed: CreatorSeed): ShowDefinition {
  const platform = PLATFORM[seed.platform];
  const description = `${seed.tagline} ${seed.creator} publishes ${platform.label}; sponsored integrations are booked per video slot.`;
  return {
    showId: `creatorloop_channel_${seed.slug}`,
    name: seed.channelName,
    // A creator's channel is a persistent programmed stream whose installments
    // are its scheduled video slots.
    kind: 'channel',
    genre: seed.genre,
    cadence: 'weekly',
    status: 'active',
    language: 'en',
    description,
    talent: [{ name: seed.creator, role: 'creator' }],
    distribution: [{
      publisherDomain: platform.domain,
      identifiers: [{ type: platform.identifierType, value: seed.channelId }],
    }],
    channels: ['influencer'],
    episodes: slots(seed),
    offer: {
      productSuffix: `creator_${seed.slug}`,
      name: `${seed.channelName} sponsored video`,
      description: `Guaranteed sponsored ${platform.label} integration with creator ${seed.creator} on ${seed.channelName}. ${seed.tagline} One flat fee per booked video slot.`,
      pricing: { model: 'flat_rate', currency: 'USD', fixedPrice: seed.rate, minSpendPerPackage: seed.rate },
      propertyId: platform.propertyId,
      heroImageUrl: `https://picsum.photos/seed/creatorloop-${seed.slug}/600/300`,
      sampleContent: seed.sampleTitles.map((title, i) => ({
        title,
        url: `https://${platform.domain}/samples/${seed.slug}-${i + 1}.mp4`,
        width: platform.width,
        height: platform.height,
        durationMs: seed.platform === 'tiktok' ? 45_000 : 480_000,
      })),
      audienceEvidence: audienceEvidence(seed),
      estimatedViews: { low: seed.views[0], mid: seed.views[1], high: seed.views[2] },
    },
  };
}

export const CREATOR_PUBLISHER: PublisherProfile = {
  id: 'creatorloop',
  name: 'CreatorLoop',
  domain: PUBLISHER_DOMAIN,
  description: 'Creator marketplace representing ten independent long-form and short-form video channels for guaranteed sponsored-video integrations.',
  heroImageUrl: 'https://picsum.photos/seed/creatorloop-marketplace/600/300',
  audienceSummary: 'Ten creator channels, audiences concentrated at 18-44',
  // Pinned to the sum of the seeds' mid views; update with them.
  estimatedVolume: '~4M video views per sponsored slot across the roster',
  channels: ['influencer'],
  deliveryTypes: ['guaranteed'],
  productPerShow: true,
  // Roster-level floor; each creator product carries its own flat rate.
  pricingTemplates: [
    { model: 'flat_rate', currency: 'USD', fixedPrice: 4800, minSpendPerPackage: 4800 },
  ],
  measurementProvider: 'CreatorLoop platform analytics',
  measurementNotes: 'Views and engagement are reported from each platform\'s own channel analytics after publication. Audience composition is seller-declared from the platform\'s trailing 90-day viewer data.',
  reportingFrequencies: ['daily'],
  reportingMetrics: ['impressions', 'spend', 'views', 'engagement_rate', 'reach'],
  properties: [
    {
      propertyId: PLATFORM.youtube.propertyId,
      name: 'CreatorLoop long-form video channels',
      identifierType: 'domain',
      identifierValue: PLATFORM.youtube.domain,
      channels: ['influencer'],
      tags: ['creator', 'video', 'long_form'],
    },
    {
      propertyId: PLATFORM.tiktok.propertyId,
      name: 'CreatorLoop short-form video channels',
      identifierType: 'domain',
      identifierValue: PLATFORM.tiktok.domain,
      channels: ['influencer'],
      tags: ['creator', 'video', 'short_form'],
    },
  ],
  shows: SEEDS.map(creatorShow),
};
