/**
 * In-memory index of catalog collections.
 * Keyed by collection_rid, by publisher_domain:collection_id, and by
 * distribution publisher + identifier for fast cross-platform lookup.
 */

import { normalizeCollectionDistributionIdentifier } from '../services/collection-identifier-normalization.js';
import { canonicalizePublisherDomain } from '../services/publisher-domain.js';

export interface CatalogCollection {
  collection_rid: string;
  publisher_domain: string;
  collection_id?: string | null;
  name?: string | null;
  kind?: string | null;
  source?: string;
  status?: string;
  identifiers: Array<{ publisher_domain: string; type: string; value: string }>;
  collection?: Record<string, unknown>;
}

function canonicalKey(publisherDomain: string, collectionId: string): string {
  return `${canonicalizePublisherDomain(publisherDomain)}:${collectionId}`;
}

function identifierKey(publisherDomain: string, type: string, value: string): string {
  const normalized = normalizeCollectionDistributionIdentifier(type, value);
  return `${canonicalizePublisherDomain(publisherDomain)}:${normalized.type}:${normalized.value}`;
}

export class CatalogCollectionIndex {
  private byRid = new Map<string, CatalogCollection>();
  private byCanonical = new Map<string, CatalogCollection>();
  private byIdentifier = new Map<string, CatalogCollection>();
  private byPublisher = new Map<string, Set<string>>();

  upsert(collection: CatalogCollection): void {
    this.remove(collection.collection_rid);

    const indexedCollection = {
      ...collection,
      publisher_domain: canonicalizePublisherDomain(collection.publisher_domain),
      identifiers: collection.identifiers.map((id) => ({
        ...id,
        publisher_domain: canonicalizePublisherDomain(id.publisher_domain),
      })),
    };

    this.byRid.set(indexedCollection.collection_rid, indexedCollection);

    if (indexedCollection.collection_id) {
      this.byCanonical.set(
        canonicalKey(indexedCollection.publisher_domain, indexedCollection.collection_id),
        indexedCollection,
      );
    }

    let rids = this.byPublisher.get(indexedCollection.publisher_domain);
    if (!rids) {
      rids = new Set();
      this.byPublisher.set(indexedCollection.publisher_domain, rids);
    }
    rids.add(indexedCollection.collection_rid);

    for (const id of indexedCollection.identifiers) {
      this.byIdentifier.set(identifierKey(id.publisher_domain, id.type, id.value), indexedCollection);
    }
  }

  remove(collectionRid: string): boolean {
    const existing = this.byRid.get(collectionRid);
    if (!existing) return false;

    this.byRid.delete(collectionRid);
    if (existing.collection_id) {
      this.byCanonical.delete(canonicalKey(existing.publisher_domain, existing.collection_id));
    }

    const publisherRids = this.byPublisher.get(existing.publisher_domain);
    if (publisherRids) {
      publisherRids.delete(collectionRid);
      if (publisherRids.size === 0) this.byPublisher.delete(existing.publisher_domain);
    }

    for (const id of existing.identifiers) {
      this.byIdentifier.delete(identifierKey(id.publisher_domain, id.type, id.value));
    }
    return true;
  }

  getByRid(rid: string): CatalogCollection | undefined {
    return this.byRid.get(rid);
  }

  getByCollectionId(publisherDomain: string, collectionId: string): CatalogCollection | undefined {
    return this.byCanonical.get(canonicalKey(publisherDomain, collectionId));
  }

  getByDistributionIdentifier(
    publisherDomain: string,
    type: string,
    value: string,
  ): CatalogCollection | undefined {
    return this.byIdentifier.get(identifierKey(publisherDomain, type, value));
  }

  getByPublisherDomain(publisherDomain: string): CatalogCollection[] {
    const rids = this.byPublisher.get(canonicalizePublisherDomain(publisherDomain));
    if (!rids) return [];
    return [...rids].map((rid) => this.byRid.get(rid)!).filter(Boolean);
  }

  get size(): number {
    return this.byRid.size;
  }

  clear(): void {
    this.byRid.clear();
    this.byCanonical.clear();
    this.byIdentifier.clear();
    this.byPublisher.clear();
  }

  /**
   * Handle collection merge: alias_rid is redirected to canonical_rid.
   */
  handleMerge(aliasRid: string, canonicalRid: string): void {
    const alias = this.byRid.get(aliasRid);
    if (!alias) return;

    for (const id of alias.identifiers) {
      this.byIdentifier.delete(identifierKey(id.publisher_domain, id.type, id.value));
    }

    const canonical = this.byRid.get(canonicalRid);
    if (canonical) {
      for (const id of alias.identifiers) {
        this.byIdentifier.set(identifierKey(id.publisher_domain, id.type, id.value), canonical);
        if (!canonical.identifiers.some((cid) =>
          cid.publisher_domain === id.publisher_domain
          && cid.type === id.type
          && cid.value === id.value
        )) {
          canonical.identifiers.push(id);
        }
      }
    }

    this.byRid.delete(aliasRid);
    if (alias.collection_id) {
      this.byCanonical.delete(canonicalKey(alias.publisher_domain, alias.collection_id));
    }
    const publisherRids = this.byPublisher.get(alias.publisher_domain);
    if (publisherRids) {
      publisherRids.delete(aliasRid);
      if (publisherRids.size === 0) this.byPublisher.delete(alias.publisher_domain);
    }
  }
}
