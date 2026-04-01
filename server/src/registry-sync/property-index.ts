/**
 * In-memory index of catalog properties.
 * Keyed by property_rid and by type:value identifier for fast lookups.
 */

export interface CatalogProperty {
  property_rid: string;
  identifiers: Array<{ type: string; value: string }>;
  classification: string;
  publisher_domain?: string;
  source?: string;
}

export class CatalogPropertyIndex {
  private byRid = new Map<string, CatalogProperty>();
  private byIdentifier = new Map<string, CatalogProperty>();  // "type:value" -> property
  private byDomain = new Map<string, Set<string>>();           // domain -> Set<rid>

  upsert(property: CatalogProperty): void {
    this.byRid.set(property.property_rid, property);

    for (const id of property.identifiers) {
      this.byIdentifier.set(`${id.type}:${id.value}`, property);
    }

    if (property.publisher_domain) {
      let rids = this.byDomain.get(property.publisher_domain);
      if (!rids) {
        rids = new Set();
        this.byDomain.set(property.publisher_domain, rids);
      }
      rids.add(property.property_rid);
    }
  }

  remove(propertyRid: string): boolean {
    const existing = this.byRid.get(propertyRid);
    if (!existing) return false;

    this.byRid.delete(propertyRid);
    for (const id of existing.identifiers) {
      this.byIdentifier.delete(`${id.type}:${id.value}`);
    }
    if (existing.publisher_domain) {
      const rids = this.byDomain.get(existing.publisher_domain);
      if (rids) {
        rids.delete(propertyRid);
        if (rids.size === 0) this.byDomain.delete(existing.publisher_domain);
      }
    }
    return true;
  }

  getByRid(rid: string): CatalogProperty | undefined {
    return this.byRid.get(rid);
  }

  getByIdentifier(type: string, value: string): CatalogProperty | undefined {
    return this.byIdentifier.get(`${type}:${value}`);
  }

  getByDomain(domain: string): CatalogProperty[] {
    const rids = this.byDomain.get(domain);
    if (!rids) return [];
    return [...rids].map(rid => this.byRid.get(rid)!).filter(Boolean);
  }

  getDomainForRid(rid: string): string | undefined {
    return this.byRid.get(rid)?.publisher_domain;
  }

  get size(): number {
    return this.byRid.size;
  }

  clear(): void {
    this.byRid.clear();
    this.byIdentifier.clear();
    this.byDomain.clear();
  }

  /**
   * Handle property merge: alias_rid is redirected to canonical_rid.
   */
  handleMerge(aliasRid: string, canonicalRid: string): void {
    const alias = this.byRid.get(aliasRid);
    if (!alias) return;

    const canonical = this.byRid.get(canonicalRid);

    // Move identifiers from alias to canonical
    if (canonical) {
      for (const id of alias.identifiers) {
        this.byIdentifier.set(`${id.type}:${id.value}`, canonical);
        if (!canonical.identifiers.some(cid => cid.type === id.type && cid.value === id.value)) {
          canonical.identifiers.push(id);
        }
      }
    }

    // Remove alias from rid and domain indexes only (identifiers already redirected)
    this.byRid.delete(aliasRid);
    if (alias.publisher_domain) {
      const rids = this.byDomain.get(alias.publisher_domain);
      if (rids) {
        rids.delete(aliasRid);
        if (rids.size === 0) this.byDomain.delete(alias.publisher_domain);
      }
    }
  }
}
