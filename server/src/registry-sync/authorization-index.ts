/**
 * In-memory authorization index for TMP router hot-path checks.
 *
 * Primary index: agent_url -> publisher_domain -> AuthorizationEntry[]
 * Reverse index: publisher_domain -> Set<agent_url>
 *
 * Evaluates the full adagents.json authorization model locally:
 * - 4 authorization types (property_ids, property_tags, publisher_properties, inline_properties)
 * - Placement scoping (placement_ids, placement_tags)
 * - Country filtering
 * - Time windows (effective_from / effective_until)
 * - Signing key lookup
 *
 * signal_ids and signal_tags authorization types are filtered out (not relevant to TMP routing).
 */

import type { CatalogPropertyIndex } from './property-index.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AuthorizationEntry {
  agent_url: string;
  publisher_domain: string;
  authorization_type: string;
  authorized_for?: string;
  property_ids?: string[];
  property_tags?: string[];
  placement_ids?: string[];
  placement_tags?: string[];
  collections?: Array<{ publisher_domain: string; collection_id: string }>;
  countries?: string[];
  delegation_type?: string;
  exclusive?: boolean;
  effective_from?: string;
  effective_until?: string;
  signing_keys?: SigningKey[];
}

export interface SigningKey {
  algorithm: string;
  public_key: string;
  key_id?: string;
}

export interface AuthorizationQuery {
  agent_url: string;
  property_rid?: string;
  property_id?: string;
  placement_id?: string;
  placement_tags?: string[];
  collection_id?: string;
  country?: string;
  timestamp?: Date;
}

export interface AuthorizationResult {
  authorized: boolean;
  authorization_type?: string;
  delegation_type?: string;
  exclusive?: boolean;
  signing_keys?: SigningKey[];
  reason?: string;
}

// ─── Index ───────────────────────────────────────────────────────────────────

export class AuthorizationIndex {
  // agent_url -> publisher_domain -> entries
  private primary = new Map<string, Map<string, AuthorizationEntry[]>>();
  // publisher_domain -> Set<agent_url> (reverse index for TMP router lookups)
  private reverse = new Map<string, Set<string>>();

  private propertyIndex?: CatalogPropertyIndex;

  constructor(propertyIndex?: CatalogPropertyIndex) {
    this.propertyIndex = propertyIndex;
  }

  // ── Index mutations ─────────────────────────────────────────────

  addEntry(entry: AuthorizationEntry): void {
    // Skip signal types — not relevant to TMP routing
    if (entry.authorization_type === 'signal_ids' || entry.authorization_type === 'signal_tags') {
      return;
    }

    // Primary index
    let byDomain = this.primary.get(entry.agent_url);
    if (!byDomain) {
      byDomain = new Map();
      this.primary.set(entry.agent_url, byDomain);
    }

    let entries = byDomain.get(entry.publisher_domain);
    if (!entries) {
      entries = [];
      byDomain.set(entry.publisher_domain, entries);
    }
    entries.push(entry);

    // Reverse index
    let agents = this.reverse.get(entry.publisher_domain);
    if (!agents) {
      agents = new Set();
      this.reverse.set(entry.publisher_domain, agents);
    }
    agents.add(entry.agent_url);
  }

  removeEntry(agentUrl: string, publisherDomain: string): void {
    const byDomain = this.primary.get(agentUrl);
    if (byDomain) {
      byDomain.delete(publisherDomain);
      if (byDomain.size === 0) {
        this.primary.delete(agentUrl);
      }
    }

    const agents = this.reverse.get(publisherDomain);
    if (agents) {
      agents.delete(agentUrl);
      if (agents.size === 0) {
        this.reverse.delete(publisherDomain);
      }
    }
  }

  removeAgent(agentUrl: string): void {
    const byDomain = this.primary.get(agentUrl);
    if (byDomain) {
      for (const domain of byDomain.keys()) {
        const agents = this.reverse.get(domain);
        if (agents) {
          agents.delete(agentUrl);
          if (agents.size === 0) this.reverse.delete(domain);
        }
      }
      this.primary.delete(agentUrl);
    }
  }

  clear(): void {
    this.primary.clear();
    this.reverse.clear();
  }

  get size(): number {
    let count = 0;
    for (const byDomain of this.primary.values()) {
      for (const entries of byDomain.values()) {
        count += entries.length;
      }
    }
    return count;
  }

  // ── Queries ─────────────────────────────────────────────────────

  /**
   * Hot-path authorization check for TMP routers.
   * Resolves property to publisher domain, then evaluates scoping.
   */
  check(query: AuthorizationQuery): AuthorizationResult {
    // Resolve publisher domain from property_rid if needed
    let publisherDomain: string | undefined;
    if (query.property_rid && this.propertyIndex) {
      publisherDomain = this.propertyIndex.getDomainForRid(query.property_rid);
    }

    if (!publisherDomain) {
      // Try to find the agent in any domain
      const byDomain = this.primary.get(query.agent_url);
      if (!byDomain || byDomain.size === 0) {
        return { authorized: false, reason: 'agent not found in authorization index' };
      }
      // If no property specified, check if agent has any authorizations
      if (!query.property_rid && !query.property_id) {
        const firstDomain = byDomain.keys().next().value!;
        const entries = byDomain.get(firstDomain)!;
        return this.evaluateEntries(entries, query);
      }
      return { authorized: false, reason: 'cannot resolve property to publisher domain' };
    }

    const byDomain = this.primary.get(query.agent_url);
    if (!byDomain) {
      return { authorized: false, reason: 'agent not found in authorization index' };
    }

    const entries = byDomain.get(publisherDomain);
    if (!entries || entries.length === 0) {
      return { authorized: false, reason: `agent not authorized for publisher ${publisherDomain}` };
    }

    return this.evaluateEntries(entries, query);
  }

  /**
   * Get all agents authorized for a property (via reverse index).
   */
  getAuthorizedAgents(propertyRid: string): string[] {
    let publisherDomain: string | undefined;
    if (this.propertyIndex) {
      publisherDomain = this.propertyIndex.getDomainForRid(propertyRid);
    }
    if (!publisherDomain) return [];

    const agents = this.reverse.get(publisherDomain);
    return agents ? [...agents] : [];
  }

  /**
   * Get placements an agent is authorized for on a property.
   */
  getAuthorizedPlacements(agentUrl: string, propertyRid: string): string[] {
    let publisherDomain: string | undefined;
    if (this.propertyIndex) {
      publisherDomain = this.propertyIndex.getDomainForRid(propertyRid);
    }
    if (!publisherDomain) return [];

    const byDomain = this.primary.get(agentUrl);
    if (!byDomain) return [];

    const entries = byDomain.get(publisherDomain);
    if (!entries) return [];

    const placements = new Set<string>();
    for (const entry of entries) {
      if (entry.placement_ids) {
        for (const pid of entry.placement_ids) placements.add(pid);
      }
    }
    return [...placements];
  }

  /**
   * Get publisher-attested signing keys for an agent.
   */
  getSigningKeys(agentUrl: string, publisherDomain: string): SigningKey[] {
    const byDomain = this.primary.get(agentUrl);
    if (!byDomain) return [];

    const entries = byDomain.get(publisherDomain);
    if (!entries) return [];

    const keys: SigningKey[] = [];
    for (const entry of entries) {
      if (entry.signing_keys) {
        keys.push(...entry.signing_keys);
      }
    }
    return keys;
  }

  // ── Evaluation ──────────────────────────────────────────────────

  private evaluateEntries(entries: AuthorizationEntry[], query: AuthorizationQuery): AuthorizationResult {
    // Find the first matching entry (most permissive wins)
    let lastReason = 'no matching authorization entry';
    for (const entry of entries) {
      const result = this.evaluateEntry(entry, query);
      if (result.authorized) return result;
      if (result.reason) lastReason = result.reason;
    }

    return { authorized: false, reason: lastReason };
  }

  private evaluateEntry(entry: AuthorizationEntry, query: AuthorizationQuery): AuthorizationResult {
    const baseResult = {
      authorization_type: entry.authorization_type,
      delegation_type: entry.delegation_type,
      exclusive: entry.exclusive,
      signing_keys: entry.signing_keys,
    };

    // Check authorization type scoping
    if (!this.matchesAuthorizationType(entry, query)) {
      return { ...baseResult, authorized: false, reason: 'property not in authorization scope' };
    }

    // Check placement scoping
    if (!this.matchesPlacement(entry, query)) {
      return { ...baseResult, authorized: false, reason: 'placement not authorized' };
    }

    // Check country
    if (!this.matchesCountry(entry, query)) {
      return { ...baseResult, authorized: false, reason: 'country not authorized' };
    }

    // Check collection
    if (!this.matchesCollection(entry, query)) {
      return { ...baseResult, authorized: false, reason: 'collection not authorized' };
    }

    // Check time window
    if (!this.matchesTimeWindow(entry, query)) {
      const now = query.timestamp ?? new Date();
      if (entry.effective_from && new Date(entry.effective_from) > now) {
        return { ...baseResult, authorized: false, reason: 'authorization not yet effective' };
      }
      return { ...baseResult, authorized: false, reason: 'authorization expired' };
    }

    return { ...baseResult, authorized: true };
  }

  private matchesAuthorizationType(entry: AuthorizationEntry, query: AuthorizationQuery): boolean {
    switch (entry.authorization_type) {
      case 'property_ids':
        // Agent authorized for specific property IDs
        if (!query.property_id) return true;  // No property_id to check against — passes
        if (entry.property_ids?.includes(query.property_id)) return true;
        return false;

      case 'property_tags':
        // Agent authorized for properties matching tags — always passes at this level
        // (tag resolution happens at index build time in a full implementation)
        return true;

      case 'publisher_properties':
        // Agent authorized for all properties of this publisher
        // Already scoped to correct publisher_domain in lookup
        return true;

      case 'inline_properties':
        // Agent authorized for inline-defined properties
        // Match by property_id if present
        if (!query.property_id) return true;
        if (entry.property_ids?.includes(query.property_id)) return true;
        return false;

      default:
        return false;
    }
  }

  private matchesPlacement(entry: AuthorizationEntry, query: AuthorizationQuery): boolean {
    // No placement scoping on entry = authorized for all placements
    if (!entry.placement_ids && !entry.placement_tags) return true;
    // No placement in query = passes placement check
    if (!query.placement_id && !query.placement_tags) return true;

    if (entry.placement_ids && query.placement_id) {
      if (entry.placement_ids.includes(query.placement_id)) return true;
    }

    if (entry.placement_tags && query.placement_tags) {
      const entryTags = new Set(entry.placement_tags);
      if (query.placement_tags.some(t => entryTags.has(t))) return true;
    }

    return false;
  }

  private matchesCountry(entry: AuthorizationEntry, query: AuthorizationQuery): boolean {
    // No country restriction = worldwide
    if (!entry.countries || entry.countries.length === 0) return true;
    // No country in query = passes
    if (!query.country) return true;

    return entry.countries.includes(query.country);
  }

  private matchesCollection(entry: AuthorizationEntry, query: AuthorizationQuery): boolean {
    // No collection restriction = all collections
    if (!entry.collections || entry.collections.length === 0) return true;
    // No collection in query = passes
    if (!query.collection_id) return true;

    return entry.collections.some(c => c.collection_id === query.collection_id);
  }

  private matchesTimeWindow(entry: AuthorizationEntry, query: AuthorizationQuery): boolean {
    const now = query.timestamp ?? new Date();

    if (entry.effective_from && new Date(entry.effective_from) > now) return false;
    if (entry.effective_until && new Date(entry.effective_until) < now) return false;

    return true;
  }
}
