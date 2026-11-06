/**
 * Capability declarations for the experimental 3.3 collection surfaces, added
 * only when the caller is served 3.3 or later:
 *
 * - /sales: `media_buy.collection_cards` (cards in product and proposal
 *   reads), `media_buy.collection_catalog` (list_collections and the card
 *   webhooks), and the three card event types in
 *   `wholesale_feed_webhooks.event_types`.
 * - /brand: `brand.collection_links` (`collections` on get_brand_identity).
 */

import {
  BRAND_COLLECTION_LINKS_FEATURE,
  COLLECTION_CARD_EVENT_TYPES,
  COLLECTION_CARDS_FEATURE,
  COLLECTION_CATALOG_FEATURE,
  supportsCollections33,
} from './card-catalog.js';

interface CapabilitiesShape {
  experimental_features?: unknown;
  wholesale_feed_webhooks?: Record<string, unknown>;
}

function addFeatures(structured: CapabilitiesShape, features: readonly string[]): void {
  const current = Array.isArray(structured.experimental_features)
    ? structured.experimental_features.filter((feature): feature is string => typeof feature === 'string')
    : [];
  for (const feature of features) if (!current.includes(feature)) current.push(feature);
  structured.experimental_features = current;
}

export function projectCollectionCapabilities(
  structured: CapabilitiesShape,
  tenantId: string,
  servedVersion: string | undefined,
): void {
  if (!supportsCollections33(servedVersion)) return;
  if (tenantId === 'sales') {
    addFeatures(structured, [COLLECTION_CARDS_FEATURE, COLLECTION_CATALOG_FEATURE]);
    const webhooks = structured.wholesale_feed_webhooks;
    if (webhooks && Array.isArray(webhooks.event_types)) {
      webhooks.event_types = [...new Set([...(webhooks.event_types as string[]), ...COLLECTION_CARD_EVENT_TYPES])];
    }
  } else if (tenantId === 'brand') {
    addFeatures(structured, [BRAND_COLLECTION_LINKS_FEATURE]);
  }
}
