/**
 * In-memory index of agent inventory profiles.
 * Mirrors the server-side search logic for local queries without network roundtrips.
 */

export interface AgentProfile {
  agent_url: string;
  name?: string;
  agent_type?: string;
  protocol?: string;
  channels: string[];
  property_types: string[];
  markets: string[];
  categories: string[];
  tags: string[];
  delivery_types: string[];
  format_ids: unknown[];
  property_count: number;
  publisher_count: number;
  has_tmp: boolean;
  category_taxonomy: string | null;
  updated_at: string;
  member?: { slug: string; display_name: string };
}

export interface AgentSearchQuery {
  channels?: string[];
  property_types?: string[];
  markets?: string[];
  categories?: string[];
  tags?: string[];
  delivery_types?: string[];
  has_tmp?: boolean;
  min_properties?: number;
  limit?: number;
}

export interface AgentSearchResult extends AgentProfile {
  relevance_score: number;
  matched_filters: string[];
}

const ARRAY_FILTER_KEYS = [
  'channels', 'property_types', 'markets', 'categories', 'tags', 'delivery_types',
] as const;

type ArrayFilterKey = typeof ARRAY_FILTER_KEYS[number];

export class AgentIndex {
  private agents = new Map<string, AgentProfile>();

  upsert(profile: AgentProfile): void {
    this.agents.set(profile.agent_url, profile);
  }

  remove(agentUrl: string): boolean {
    return this.agents.delete(agentUrl);
  }

  get(agentUrl: string): AgentProfile | undefined {
    return this.agents.get(agentUrl);
  }

  list(): AgentProfile[] {
    return [...this.agents.values()];
  }

  getForDomain(_domain: string): AgentProfile[] {
    throw new Error('Not implemented: requires AuthorizationIndex for domain-to-agent mapping');
  }

  get size(): number {
    return this.agents.size;
  }

  clear(): void {
    this.agents.clear();
  }

  /**
   * Search profiles with the same scoring formula as the server SQL.
   * OR within each filter dimension, AND across dimensions.
   *
   * score = matched_dimensions / total_query_dimensions + ln(property_count+1) * 0.1 + (has_tmp ? 0.05 : 0)
   */
  search(query: AgentSearchQuery): AgentSearchResult[] {
    const limit = Math.min(Math.max(1, query.limit ?? 50), 200);

    // Determine active filter dimensions
    const activeFilters: ArrayFilterKey[] = [];
    for (const key of ARRAY_FILTER_KEYS) {
      const values = query[key];
      if (values && values.length > 0) {
        activeFilters.push(key);
      }
    }

    // Pre-create Sets for filter dimensions (avoid recreating per agent)
    const filterSets = new Map<ArrayFilterKey, Set<string>>();
    for (const key of activeFilters) {
      filterSets.set(key, new Set(query[key]!));
    }

    const results: AgentSearchResult[] = [];

    for (const profile of this.agents.values()) {
      // Apply boolean and numeric filters first (cheap)
      if (query.has_tmp !== undefined && profile.has_tmp !== query.has_tmp) continue;
      if (query.min_properties !== undefined && profile.property_count < query.min_properties) continue;

      // Check array overlap (AND across dimensions)
      let passesAllFilters = true;
      const matchedFilters: string[] = [];

      for (const key of activeFilters) {
        const queryValues = filterSets.get(key)!;
        const profileValues = profile[key] as string[];
        const overlaps = profileValues.some(v => queryValues.has(v));

        if (!overlaps) {
          passesAllFilters = false;
          break;
        }
        matchedFilters.push(key);
      }

      if (!passesAllFilters) continue;

      // Compute relevance score (same formula as server SQL)
      const totalDimensions = activeFilters.length || 1;
      const matchedDimensionCount = matchedFilters.length;
      const relevanceScore =
        matchedDimensionCount / totalDimensions +
        Math.log(profile.property_count + 1) * 0.1 +
        (profile.has_tmp ? 0.05 : 0);

      results.push({
        ...profile,
        relevance_score: relevanceScore,
        matched_filters: matchedFilters,
      });
    }

    // Sort by relevance descending, then agent_url ascending for deterministic tiebreak
    results.sort((a, b) => {
      if (b.relevance_score !== a.relevance_score) {
        return b.relevance_score - a.relevance_score;
      }
      return a.agent_url.localeCompare(b.agent_url);
    });

    return results.slice(0, limit);
  }
}
