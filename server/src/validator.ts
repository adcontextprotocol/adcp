import type {
  AdAgentsJson,
  AuthorizationResult,
  AuthorizationScope,
  AuthorizedAgentEntry,
  CollectionSelector,
  PlacementDefinition,
  PlacementTagDefinition,
  PropertyDefinition,
  PublisherPropertySelector,
} from "./types.js";
import { Cache } from "./cache.js";

interface FetchResult {
  data?: AdAgentsJson;
  source?: string;
  error?: string;
}

interface NormalizedScope {
  property_id?: string;
  property_tags?: string[];
  collection_ids?: string[];
  placement_ids?: string[];
  placement_tags?: string[];
  country?: string;
  at?: string;
}

export class AgentValidator {
  private cache: Cache<AuthorizationResult>;

  constructor(cacheTtlMinutes: number = 15) {
    this.cache = new Cache<AuthorizationResult>(cacheTtlMinutes);
  }

  async validate(
    domain: string,
    agentUrl: string,
    scope?: AuthorizationScope
  ): Promise<AuthorizationResult> {
    const normalizedDomain = this.normalizeDomain(domain);
    const normalizedAgentUrl = this.normalizeUrl(agentUrl);
    const normalizedScope = this.normalizeScope(scope);
    const cacheKey = JSON.stringify({
      domain: normalizedDomain,
      agent_url: normalizedAgentUrl,
      scope: normalizedScope,
    });
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const result = await this.fetchAndValidate(
      normalizedDomain,
      agentUrl,
      normalizedAgentUrl,
      normalizedScope
    );
    this.cache.set(cacheKey, result);
    return result;
  }

  private async fetchAndValidate(
    normalizedDomain: string,
    agentUrl: string,
    normalizedAgentUrl: string,
    scope: NormalizedScope
  ): Promise<AuthorizationResult> {
    const adagentsUrl = this.buildAdAgentsUrl(normalizedDomain);

    try {
      const fetched = await this.fetchAdAgentsJson(adagentsUrl, normalizedDomain);
      if (!fetched.data) {
        return {
          authorized: false,
          domain: normalizedDomain,
          agent_url: agentUrl,
          checked_at: new Date().toISOString(),
          error: fetched.error || "Unknown error",
          source: fetched.source,
        };
      }

      const data = fetched.data;
      if (!data.authorized_agents || !Array.isArray(data.authorized_agents)) {
        return {
          authorized: false,
          domain: normalizedDomain,
          agent_url: agentUrl,
          checked_at: new Date().toISOString(),
          error: "Invalid adagents.json format: missing authorized_agents array",
          source: fetched.source,
        };
      }

      const matchedAuthorization = data.authorized_agents.find((agent) =>
        this.matchesAuthorization(
          agent,
          normalizedDomain,
          normalizedAgentUrl,
          scope,
          data.properties || [],
          data.placements || [],
          data.placement_tags || {}
        )
      );

      return {
        authorized: !!matchedAuthorization,
        domain: normalizedDomain,
        agent_url: agentUrl,
        checked_at: new Date().toISOString(),
        source: fetched.source || adagentsUrl.toString(),
        matched_authorization: matchedAuthorization
          ? {
              authorization_type: matchedAuthorization.authorization_type,
              delegation_type: matchedAuthorization.delegation_type,
              exclusive: matchedAuthorization.exclusive,
              countries: matchedAuthorization.countries,
              collection_ids: this.flattenCollectionIds(matchedAuthorization.collections, normalizedDomain),
              placement_ids: matchedAuthorization.placement_ids,
              placement_tags: matchedAuthorization.placement_tags,
              effective_from: matchedAuthorization.effective_from,
              effective_until: matchedAuthorization.effective_until,
              signing_keys: matchedAuthorization.signing_keys,
            }
          : undefined,
      };
    } catch (error) {
      let errorMsg = "Unknown error";
      if (error instanceof Error) {
        if (error.message.includes("Unexpected token")) {
          errorMsg = "File does not exist or is not valid JSON";
        } else if (error.name === "AbortError") {
          errorMsg = "Request timed out";
        } else {
          errorMsg = error.message;
        }
      }

      return {
        authorized: false,
        domain: normalizedDomain,
        agent_url: agentUrl,
        checked_at: new Date().toISOString(),
        error: errorMsg,
      };
    }
  }

  private async fetchAdAgentsJson(url: URL, expectedDomain: string, followedRedirect = false): Promise<FetchResult> {
    const normalizedExpectedDomain = this.normalizeDomain(expectedDomain);
    const normalizedHost = this.normalizeDomain(url.hostname);
    const source = url.toString();

    if (
      url.protocol !== "https:" ||
      Boolean(url.username) ||
      Boolean(url.password) ||
      (url.port !== "" && url.port !== "443") ||
      (
        normalizedHost !== normalizedExpectedDomain &&
        !normalizedHost.endsWith(`.${normalizedExpectedDomain}`)
      )
    ) {
      return {
        error: "URL must use HTTPS on the same hostname",
        source,
      };
    }

    url.hash = "";

    // codeql[js/request-forgery] -- URL is restricted above to HTTPS on the requested hostname or its subdomains only.
    const response = await fetch(url, {
      headers: { "User-Agent": "AdCP-Registry/1.0" },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return {
        error: `HTTP ${response.status}`,
        source,
      };
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      return {
        error: `File does not exist or returns ${contentType} instead of JSON`,
        source,
      };
    }

    const data = await response.json() as AdAgentsJson;
    if (data.authoritative_location && !followedRedirect) {
      const authoritativeUrl = this.validateAuthoritativeLocation(data.authoritative_location, expectedDomain);
      if (!authoritativeUrl) {
        return {
          error: "authoritative_location must use HTTPS on the same hostname",
          source,
        };
      }
      return this.fetchAdAgentsJson(authoritativeUrl, expectedDomain, true);
    }

    return {
      data,
      source,
    };
  }

  private matchesAuthorization(
    agent: AuthorizedAgentEntry,
    normalizedDomain: string,
    normalizedAgentUrl: string,
    scope: NormalizedScope,
    topLevelProperties: PropertyDefinition[],
    topLevelPlacements: PlacementDefinition[],
    placementTagDefinitions: Record<string, PlacementTagDefinition>
  ): boolean {
    if (this.normalizeUrl(agent.url) !== normalizedAgentUrl) {
      return false;
    }

    if (!this.matchesCountry(agent, scope)) {
      return false;
    }

    if (!this.matchesTimeWindow(agent, scope)) {
      return false;
    }

    if (!this.matchesCollections(agent.collections, normalizedDomain, scope.collection_ids)) {
      return false;
    }

    const authorizedProperties = this.resolveAuthorizedProperties(
      agent,
      normalizedDomain,
      scope,
      topLevelProperties
    );

    switch (agent.authorization_type) {
      case "property_ids":
      case "property_tags":
      case "inline_properties":
      case "publisher_properties":
        if (authorizedProperties.length === 0) {
          return false;
        }
        break;
      case "signal_ids":
      case "signal_tags":
        return false;
      case undefined:
        break;
      default:
        return false;
    }

    return this.matchesPlacements(
      agent,
      normalizedDomain,
      scope,
      authorizedProperties,
      topLevelPlacements,
      placementTagDefinitions
    );
  }

  private matchesCollections(
    selectors: CollectionSelector[] | undefined,
    normalizedDomain: string,
    collectionIds: string[] | undefined
  ): boolean {
    if (!selectors?.length) {
      return true;
    }

    if (!collectionIds?.length) {
      return false;
    }

    return selectors.some((selector) =>
      this.normalizeDomain(selector.publisher_domain) === normalizedDomain &&
      this.hasIntersection(selector.collection_ids, collectionIds)
    );
  }

  private resolveAuthorizedProperties(
    agent: AuthorizedAgentEntry,
    normalizedDomain: string,
    scope: NormalizedScope,
    properties: PropertyDefinition[]
  ): PropertyDefinition[] {
    switch (agent.authorization_type) {
      case "property_ids":
        if (!agent.property_ids?.length) {
          return [];
        }
        return this.resolveScopedTopLevelProperties(normalizedDomain, scope, properties).filter((property) =>
          !!property.property_id && agent.property_ids?.includes(property.property_id)
        );
      case "property_tags":
        if (!agent.property_tags?.length) {
          return [];
        }
        return this.resolveScopedTopLevelProperties(normalizedDomain, scope, properties).filter((property) =>
          this.hasIntersection(agent.property_tags || [], property.tags || [])
        );
      case "inline_properties":
        if (!agent.properties?.length) {
          return [];
        }
        return this.resolveScopedProperties(normalizedDomain, scope, agent.properties);
      case "publisher_properties":
        return this.resolveAuthorizedPublisherProperties(
          agent.publisher_properties,
          normalizedDomain,
          scope,
          properties
        );
      case undefined:
        return this.resolveScopedTopLevelProperties(normalizedDomain, scope, properties);
      default:
        return [];
    }
  }

  private resolveAuthorizedPublisherProperties(
    selectors: PublisherPropertySelector[] | undefined,
    normalizedDomain: string,
    scope: NormalizedScope,
    properties: PropertyDefinition[]
  ): PropertyDefinition[] {
    if (!selectors?.length) {
      return [];
    }

    const matchedProperties = this.resolveScopedTopLevelProperties(normalizedDomain, scope, properties);
    return matchedProperties.filter((property) =>
      selectors.some((selector) => {
        if (this.normalizeDomain(selector.publisher_domain) !== normalizedDomain) {
          return false;
        }

        switch (selector.selection_type) {
          case "all":
            return true;
          case "by_id":
            return !!property.property_id && selector.property_ids?.includes(property.property_id);
          case "by_tag":
            return this.hasIntersection(selector.property_tags || [], property.tags || []);
          default:
            return false;
        }
      })
    );
  }

  private matchesPlacements(
    agent: AuthorizedAgentEntry,
    normalizedDomain: string,
    scope: NormalizedScope,
    authorizedProperties: PropertyDefinition[],
    placements: PlacementDefinition[],
    placementTagDefinitions: Record<string, PlacementTagDefinition>
  ): boolean {
    const hasAgentPlacementScope = !!agent.placement_ids?.length || !!agent.placement_tags?.length;
    const hasRequestedPlacementScope = !!scope.placement_ids?.length || !!scope.placement_tags?.length;

    if (!hasAgentPlacementScope && !hasRequestedPlacementScope) {
      return true;
    }

    const requestedPlacements = this.resolveRequestedPlacements(
      normalizedDomain,
      scope,
      placements,
      placementTagDefinitions
    );
    if (requestedPlacements.length === 0) {
      return false;
    }

    const scopedPlacements = requestedPlacements.filter((placement) =>
      this.placementMatchesAuthorizedScope(placement, authorizedProperties, scope)
    );
    if (scopedPlacements.length === 0) {
      return false;
    }

    if (agent.placement_ids?.length) {
      const agentPlacementIds = new Set(agent.placement_ids);
      if (!scopedPlacements.some((placement) => agentPlacementIds.has(placement.placement_id))) {
        return false;
      }
    }

    if (agent.placement_tags?.length) {
      const scopedTags = new Set(scopedPlacements.flatMap((placement) => placement.tags || []));
      if (scopedTags.size === 0) {
        return false;
      }
      if (!agent.placement_tags.some((tag) => scopedTags.has(tag))) {
        return false;
      }
    }

    return true;
  }

  private matchesCountry(agent: AuthorizedAgentEntry, scope: NormalizedScope): boolean {
    if (!agent.countries?.length) {
      return true;
    }

    return !!scope.country && agent.countries.includes(scope.country);
  }

  private matchesTimeWindow(agent: AuthorizedAgentEntry, scope: NormalizedScope): boolean {
    if (!agent.effective_from && !agent.effective_until) {
      return true;
    }

    const timestamp = Date.parse(scope.at || new Date().toISOString());
    if (Number.isNaN(timestamp)) {
      return false;
    }

    if (agent.effective_from) {
      const effectiveFrom = Date.parse(agent.effective_from);
      if (Number.isNaN(effectiveFrom) || timestamp < effectiveFrom) {
        return false;
      }
    }

    if (agent.effective_until) {
      const effectiveUntil = Date.parse(agent.effective_until);
      if (Number.isNaN(effectiveUntil) || timestamp > effectiveUntil) {
        return false;
      }
    }

    return true;
  }

  private resolveScopedTopLevelProperties(
    normalizedDomain: string,
    scope: NormalizedScope,
    properties: PropertyDefinition[]
  ): PropertyDefinition[] {
    return this.resolveScopedProperties(normalizedDomain, scope, properties);
  }

  private resolveScopedProperties(
    normalizedDomain: string,
    scope: NormalizedScope,
    properties: PropertyDefinition[]
  ): PropertyDefinition[] {
    return properties.filter((property) => this.propertyMatchesScope(property, normalizedDomain, scope));
  }

  private propertyMatchesScope(
    property: PropertyDefinition,
    normalizedDomain: string,
    scope: NormalizedScope
  ): boolean {
    if (scope.property_id) {
      return property.property_id === scope.property_id;
    }

    if (scope.property_tags?.length) {
      return this.hasIntersection(property.tags || [], scope.property_tags);
    }

    return this.propertyMatchesDomain(property, normalizedDomain);
  }

  private propertyMatchesDomain(property: PropertyDefinition, normalizedDomain: string): boolean {
    if (property.publisher_domain && this.normalizeDomain(property.publisher_domain) === normalizedDomain) {
      return true;
    }

    return (property.identifiers || []).some((identifier) => {
      if (identifier.type !== "domain") {
        return false;
      }

      const identifierValue = this.normalizeDomain(identifier.value);
      if (identifierValue.startsWith("*.")) {
        const baseDomain = identifierValue.slice(2);
        return normalizedDomain.endsWith(`.${baseDomain}`) && normalizedDomain !== baseDomain;
      }

      if (identifierValue === normalizedDomain) {
        return true;
      }

      return !identifierValue.includes(".") ?
        false :
        this.matchesBaseDomain(identifierValue, normalizedDomain);
    });
  }

  private matchesBaseDomain(identifierValue: string, normalizedDomain: string): boolean {
    if (identifierValue === normalizedDomain) {
      return true;
    }

    return (
      normalizedDomain === `www.${identifierValue}` ||
      normalizedDomain === `m.${identifierValue}`
    );
  }

  private normalizeDomain(value: string): string {
    let normalized = value.trim().toLowerCase();
    if (normalized.startsWith("https://")) {
      normalized = normalized.slice("https://".length);
    } else if (normalized.startsWith("http://")) {
      normalized = normalized.slice("http://".length);
    }
    while (normalized.endsWith("/")) {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  }

  private normalizeUrl(value: string): string {
    let normalized = value;
    while (normalized.endsWith("/")) {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  }

  private buildAdAgentsUrl(normalizedDomain: string): URL {
    const domain = this.normalizeDomain(normalizedDomain);
    if (!domain || domain.includes("/") || domain.includes("?") || domain.includes("#")) {
      throw new Error("Invalid domain");
    }
    return new URL(`https://${domain}/.well-known/adagents.json`);
  }

  private validateAuthoritativeLocation(url: string, expectedDomain: string): URL | null {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") {
        return null;
      }

      const normalizedHost = this.normalizeDomain(parsed.hostname);
      if (
        normalizedHost !== expectedDomain &&
        !normalizedHost.endsWith(`.${expectedDomain}`)
      ) {
        return null;
      }

      if (parsed.username || parsed.password || (parsed.port !== "" && parsed.port !== "443")) {
        return null;
      }

      parsed.hash = "";
      return parsed;
    } catch {
      return null;
    }
  }

  private normalizeScope(scope?: AuthorizationScope): NormalizedScope {
    if (!scope) {
      return {};
    }

    return {
      property_id: scope.property_id,
      property_tags: scope.property_tags ? [...new Set(scope.property_tags)] : undefined,
      collection_ids: scope.collection_ids ? [...new Set(scope.collection_ids)] : undefined,
      placement_ids: scope.placement_ids ? [...new Set(scope.placement_ids)] : undefined,
      placement_tags: scope.placement_tags ? [...new Set(scope.placement_tags)] : undefined,
      country: scope.country?.toUpperCase(),
      at: scope.at,
    };
  }

  private hasIntersection(left: string[], right: string[]): boolean {
    const rightSet = new Set(right);
    return left.some((value) => rightSet.has(value));
  }

  private flattenCollectionIds(
    selectors: CollectionSelector[] | undefined,
    normalizedDomain: string
  ): string[] | undefined {
    if (!selectors?.length) {
      return undefined;
    }

    return [
      ...new Set(
        selectors
          .filter((selector) => this.normalizeDomain(selector.publisher_domain) === normalizedDomain)
          .flatMap((selector) => selector.collection_ids)
      ),
    ];
  }

  private resolveRequestedPlacements(
    normalizedDomain: string,
    scope: NormalizedScope,
    placements: PlacementDefinition[],
    placementTagDefinitions: Record<string, PlacementTagDefinition>
  ): PlacementDefinition[] {
    const placementIds = scope.placement_ids ? new Set(scope.placement_ids) : null;
    const placementTags = scope.placement_tags ? new Set(scope.placement_tags) : null;

    if (placementTags) {
      const definedTagIds = new Set([
        ...Object.keys(placementTagDefinitions || {}),
        ...placements.flatMap((placement) => placement.tags || []),
      ]);
      for (const tag of placementTags) {
        if (!definedTagIds.has(tag)) {
          return [];
        }
      }
    }

    return placements.filter((placement) => {
      if (placement.publisher_domain && this.normalizeDomain(placement.publisher_domain) !== normalizedDomain) {
        return false;
      }
      if (placementIds && !placementIds.has(placement.placement_id)) {
        return false;
      }
      if (placementTags && !this.hasIntersection(placement.tags || [], [...placementTags])) {
        return false;
      }
      return true;
    });
  }

  private placementMatchesAuthorizedScope(
    placement: PlacementDefinition,
    authorizedProperties: PropertyDefinition[],
    scope: NormalizedScope
  ): boolean {
    if (!this.placementMatchesAuthorizedProperties(placement, authorizedProperties)) {
      return false;
    }

    if (scope.collection_ids?.length && placement.collection_ids?.length) {
      return this.hasIntersection(placement.collection_ids || [], scope.collection_ids);
    }

    return true;
  }

  private placementMatchesAuthorizedProperties(
    placement: PlacementDefinition,
    authorizedProperties: PropertyDefinition[]
  ): boolean {
    if (authorizedProperties.length === 0) {
      return false;
    }

    const authorizedPropertyIds = new Set(
      authorizedProperties.flatMap((property) => (property.property_id ? [property.property_id] : []))
    );
    const authorizedPropertyTags = new Set(
      authorizedProperties.flatMap((property) => property.tags || [])
    );

    const byId =
      !!placement.property_ids?.length &&
      placement.property_ids.some((propertyId) => authorizedPropertyIds.has(propertyId));
    const byTag =
      !!placement.property_tags?.length &&
      placement.property_tags.some((tag) => authorizedPropertyTags.has(tag));

    return byId || byTag;
  }

  getCacheStats(): { size: number } {
    return { size: this.cache.size() };
  }

  clearCache(): void {
    this.cache.clear();
  }
}
