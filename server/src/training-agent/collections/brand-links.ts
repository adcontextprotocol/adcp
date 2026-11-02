/**
 * Creator identities on the /brand tenant and their collection links
 * (experimental `brand.collection_links`, #8141).
 *
 * A CreatorLoop collection's `talent[].brand_ref` names the creator's brand
 * identity under the CreatorLoop Talent house. `get_brand_identity` for that
 * brand returns, on the 3.3 wire, `collections`: the creator's channels as
 * `{publisher_domain, collection_id}` links. A `brand_ref` is confirmed only
 * when the identity lists the same key back
 * (get_brand_identity.mdx, "People behind collections"). The fixtures keep
 * one creator unconfirmed: the collection claims the identity, and the
 * identity lists a different channel.
 */

import { getAgentUrl } from '../config.js';
import { CREATOR_PUBLISHER } from '../creators.js';
import {
  CREATOR_CARD_FIXTURES,
  CREATOR_TALENT_HOUSE,
  OFF_PLATFORM_COLLECTION_LINKS,
} from './card-fixtures.js';
import { supportsCollections33 } from './card-catalog.js';

export interface CreatorBrandEntry {
  brand_id: string;
  house: { domain: string; name: string };
  names: Array<Record<string, string>>;
  description: string;
  industries: string[];
  keller_type: string;
  tagline: string;
  logos: Array<{ url: string; variant?: string }>;
  tone: { voice: string; attributes: string[]; dos: string[]; donts: string[] };
}

export interface CollectionLink {
  publisher_domain: string;
  collection_id: string;
  name: string;
  role?: string;
  seller_agent_url?: string;
}

function showFor(showId: string) {
  return CREATOR_PUBLISHER.shows?.find(show => show.showId === showId);
}

let entries: CreatorBrandEntry[] | undefined;

/** Brand identities for the creators whose collections carry a brand_ref. */
export function creatorBrandEntries(): CreatorBrandEntry[] {
  entries ??= CREATOR_CARD_FIXTURES.filter(fixture => fixture.brandRef).map(fixture => {
    const show = showFor(fixture.showId);
    const name = show?.talent?.find(person => person.role === 'creator')?.name ?? fixture.slug;
    return {
      brand_id: fixture.slug,
      house: { ...CREATOR_TALENT_HOUSE },
      names: [{ en: name }],
      description: fixture.bio,
      industries: [],
      keller_type: 'independent',
      tagline: '',
      // The person's picture: always public (get_brand_identity.mdx).
      logos: [{ url: `https://picsum.photos/seed/creatorloop-${fixture.slug}-avatar/800/800`, variant: 'primary' }],
      tone: { voice: '', attributes: [], dos: [], donts: [] },
    };
  });
  return entries;
}

/** The channels a creator identity lists, or undefined for other brands. */
export function collectionLinksFor(brandId: string): CollectionLink[] | undefined {
  const fixture = CREATOR_CARD_FIXTURES.find(candidate => candidate.slug === brandId && candidate.brandRef);
  if (!fixture) return undefined;
  if (!fixture.brandConfirms) {
    const offPlatform = OFF_PLATFORM_COLLECTION_LINKS[brandId];
    return offPlatform ? [{ ...offPlatform, role: 'creator' }] : [];
  }
  const show = showFor(fixture.showId);
  return [{
    publisher_domain: CREATOR_PUBLISHER.domain,
    collection_id: fixture.showId,
    name: show?.name ?? fixture.showId,
    role: 'creator',
    seller_agent_url: `${getAgentUrl()}/sales/mcp`,
  }];
}

/**
 * Add `collections` to a get_brand_identity response for a caller served 3.3
 * or later, when the request did not narrow `fields` to exclude it. Mutates
 * and returns the response.
 */
export function withCollectionLinks<T extends Record<string, unknown>>(
  response: T,
  brandId: string,
  fields: unknown,
  servedAdcpVersion: string | undefined,
): T {
  if (!supportsCollections33(servedAdcpVersion)) return response;
  if (Array.isArray(fields) && !fields.includes('collections')) return response;
  const links = collectionLinksFor(brandId);
  if (links && links.length > 0) (response as Record<string, unknown>).collections = links;
  return response;
}
