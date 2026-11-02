/**
 * Collection card fixtures (#8093, #8181): the display facts a selling agent
 * serves on its copy of a collection (experimental `media_buy.collection_cards`)
 * and the creator identities behind CreatorLoop's channels (experimental
 * `brand.collection_links`).
 *
 * The collections themselves come from the publishers' shows (creators.ts and
 * publishers.ts). This module adds only what a card needs on top of them:
 *
 * - `images`, `sample_content` and `url`: the closed-list display copies the
 *   seller owns and refreshes without touching the publisher's declaration;
 * - `distribution[].followers`: platform-reported follower counts, with
 *   `as_of` the last time a count changed;
 * - extra `distribution` entries for creators who cross-post (anchored, so
 *   they are declared in adagents.json too);
 * - `talent[].brand_ref`: the typed link to each creator's brand identity,
 *   which the /brand tenant links back through `get_brand_identity`
 *   `collections`.
 *
 * Follower counts are rounded the way video platforms display them, so each
 * one is an `approximate` interval: a displayed "1.23M" is 1,230,000 to
 * 1,239,999.
 */

/** Talent agency house that represents the CreatorLoop creators' identities. */
export const CREATOR_TALENT_HOUSE = Object.freeze({
  domain: 'creatorlooptalent.example',
  name: 'CreatorLoop Talent',
});

export interface FollowerFixture {
  /** The distribution entry this count belongs to, by its publisher_domain. */
  publisherDomain: string;
  lowerBound: number;
  upperBound: number;
  asOf: string;
}

export interface CreatorCardFixture {
  /** CreatorLoop show id (`creatorloop_channel_<slug>`). */
  showId: string;
  slug: string;
  /** Display handle on the creator's platforms. */
  handle: string;
  followers: FollowerFixture[];
  /** A second platform the creator cross-posts to (anchored). */
  crossPost?: {
    publisherDomain: string;
    identifierType: 'youtube_channel_id' | 'tiktok_id';
    identifierValue: string;
  };
  /** Publication dates of the two sample posts, oldest first. */
  samplePublishedAt: [string, string];
  /** Whether the collection names the creator's brand identity. */
  brandRef: boolean;
  /** Whether the creator's brand identity links back to this collection.
   * When false, the collection's brand_ref is the publisher's unconfirmed
   * claim (collections-and-installments.mdx, "Collection cards"). */
  brandConfirms: boolean;
  /** Short creator bio for the brand identity. */
  bio: string;
}

const VIDEO = 'video.creatorloop.example';
const SHORTS = 'shorts.creatorloop.example';

function approx(publisherDomain: string, displayed: number, unit: 'K' | 'M', asOf: string): FollowerFixture {
  // A displayed "1.23M" covers [1,230,000, 1,239,999]; "865K" covers
  // [865,000, 865,999]; "3.8M" covers [3,800,000, 3,899,999].
  const scale = unit === 'M' ? 1_000_000 : 1_000;
  const decimals = (String(displayed).split('.')[1] ?? '').length;
  const step = scale / 10 ** decimals;
  const lowerBound = Math.round(displayed * scale);
  return { publisherDomain, lowerBound, upperBound: lowerBound + step - 1, asOf };
}

export const CREATOR_CARD_FIXTURES: readonly CreatorCardFixture[] = Object.freeze([
  {
    showId: 'creatorloop_channel_juniper_vale', slug: 'juniper_vale', handle: '@junipervalecooks',
    followers: [approx(VIDEO, 1.23, 'M', '2026-10-12T00:00:00Z')],
    samplePublishedAt: ['2026-09-18T15:00:00Z', '2026-10-09T15:00:00Z'],
    brandRef: true, brandConfirms: true,
    bio: 'Home cook and recipe developer behind Juniper Vale Cooks.',
  },
  {
    showId: 'creatorloop_channel_tobias_quill', slug: 'tobias_quill', handle: '@quilltechteardown',
    followers: [approx(VIDEO, 2.41, 'M', '2026-10-05T00:00:00Z')],
    samplePublishedAt: ['2026-09-21T17:00:00Z', '2026-10-14T17:00:00Z'],
    brandRef: true, brandConfirms: true,
    bio: 'Hardware reviewer who takes gadgets apart on camera.',
  },
  {
    showId: 'creatorloop_channel_nadia_ferro', slug: 'nadia_ferro', handle: '@nadiaferro',
    followers: [
      approx(SHORTS, 3.8, 'M', '2026-10-15T00:00:00Z'),
      approx(VIDEO, 412, 'K', '2026-10-01T00:00:00Z'),
    ],
    crossPost: { publisherDomain: VIDEO, identifierType: 'youtube_channel_id', identifierValue: 'UCcl0nadiaFerro2Lm7pQe4w' },
    samplePublishedAt: ['2026-10-02T12:00:00Z', '2026-10-16T12:00:00Z'],
    brandRef: true, brandConfirms: true,
    bio: 'Certified trainer making ten-minute workouts for desk workers.',
  },
  {
    showId: 'creatorloop_channel_kenji_arden', slug: 'kenji_arden', handle: '@ardentrailnotes',
    followers: [approx(VIDEO, 865, 'K', '2026-09-28T00:00:00Z')],
    samplePublishedAt: ['2026-08-30T14:00:00Z', '2026-09-27T14:00:00Z'],
    brandRef: true, brandConfirms: true,
    bio: 'Long-distance hiker and gear reviewer.',
  },
  {
    showId: 'creatorloop_channel_sol_marquez', slug: 'sol_marquez', handle: '@solmarquezplays',
    followers: [approx(VIDEO, 1.57, 'M', '2026-10-11T00:00:00Z')],
    samplePublishedAt: ['2026-09-25T20:00:00Z', '2026-10-10T20:00:00Z'],
    brandRef: true, brandConfirms: true,
    bio: 'Variety gamer known for cozy co-op streams.',
  },
  {
    showId: 'creatorloop_channel_priya_halden', slug: 'priya_halden', handle: '@haldenhomestudio',
    followers: [approx(SHORTS, 2.2, 'M', '2026-10-08T00:00:00Z')],
    samplePublishedAt: ['2026-09-20T16:00:00Z', '2026-10-04T16:00:00Z'],
    brandRef: true, brandConfirms: true,
    bio: 'Renter-friendly interiors on a budget.',
  },
  {
    // No brand_ref: the publisher has not linked this creator's identity.
    showId: 'creatorloop_channel_dex_okafor', slug: 'dex_okafor', handle: '@dexmoneyminute',
    followers: [approx(SHORTS, 1.9, 'M', '2026-10-03T00:00:00Z')],
    samplePublishedAt: ['2026-09-29T13:00:00Z', '2026-10-13T13:00:00Z'],
    brandRef: false, brandConfirms: false,
    bio: 'Personal-finance explainer.',
  },
  {
    showId: 'creatorloop_channel_lena_brightwater', slug: 'lena_brightwater', handle: '@brightwaterbeautylab',
    followers: [
      approx(VIDEO, 3.12, 'M', '2026-10-14T00:00:00Z'),
      approx(SHORTS, 1.4, 'M', '2026-10-14T00:00:00Z'),
    ],
    crossPost: { publisherDomain: SHORTS, identifierType: 'tiktok_id', identifierValue: 'brightwaterbeautylab' },
    samplePublishedAt: ['2026-09-24T18:00:00Z', '2026-10-15T18:00:00Z'],
    brandRef: true, brandConfirms: true,
    bio: 'Cosmetic chemist reviewing skincare ingredients.',
  },
  {
    // The publisher claims this brand_ref, but the creator's identity does
    // not list the channel back: an unconfirmed link.
    showId: 'creatorloop_channel_ravi_castellan', slug: 'ravi_castellan', handle: '@castellangarage',
    followers: [approx(VIDEO, 742, 'K', '2026-09-30T00:00:00Z')],
    samplePublishedAt: ['2026-09-06T15:00:00Z', '2026-10-04T15:00:00Z'],
    brandRef: true, brandConfirms: false,
    bio: 'Mechanic and used-car buying advisor.',
  },
  {
    showId: 'creatorloop_channel_odette_moreau', slug: 'odette_moreau', handle: '@odettestudiodiaries',
    followers: [approx(SHORTS, 4.4, 'M', '2026-10-16T00:00:00Z')],
    samplePublishedAt: ['2026-10-01T11:00:00Z', '2026-10-15T11:00:00Z'],
    brandRef: true, brandConfirms: true,
    bio: 'Fashion designer documenting her studio and capsule wardrobes.',
  },
]);

export const CREATOR_CARD_FIXTURE_BY_SHOW = new Map(CREATOR_CARD_FIXTURES.map(f => [f.showId, f]));

/** Channels a creator's brand identity names that this seller does not sell
 * (the unconfirmed creator above lists only this one). */
export const OFF_PLATFORM_COLLECTION_LINKS: Readonly<Record<string, { publisher_domain: string; collection_id: string; name: string }>> = Object.freeze({
  ravi_castellan: {
    publisher_domain: 'garagenights.example',
    collection_id: 'garage_nights',
    name: 'Garage Nights',
  },
});
