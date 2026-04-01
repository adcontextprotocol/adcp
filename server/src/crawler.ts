import type { Agent } from "./types.js";
import { PropertyCrawler, getPropertyIndex, type AgentInfo, type CrawlResult } from "@adcp/client";
import { FederatedIndexService } from "./federated-index.js";
import { AdAgentsManager } from "./adagents-manager.js";
import { BrandManager } from "./brand-manager.js";
import { BrandDatabase } from "./db/brand-db.js";
import { MemberDatabase } from "./db/member-db.js";
import { CapabilityDiscovery } from "./capabilities.js";
import { AAO_HOST } from "./config/aao.js";
import { createLogger } from "./logger.js";
import type { CatalogEventsDatabase, WriteEventInput } from "./db/catalog-events-db.js";
import type { AgentInventoryProfilesDatabase, ProfileUpsertInput } from "./db/agent-inventory-profiles-db.js";

const log = createLogger('crawler');

export class CrawlerService {
  private crawler: PropertyCrawler;
  private crawling: boolean = false;
  private lastCrawl: Date | null = null;
  private lastResult: CrawlResult | null = null;
  private intervalId: NodeJS.Timeout | null = null;
  private federatedIndex: FederatedIndexService;
  private adAgentsManager: AdAgentsManager;
  private brandManager: BrandManager;
  private brandDb: BrandDatabase;
  private memberDb: MemberDatabase;
  private capabilityDiscovery: CapabilityDiscovery;
  private eventsDb?: CatalogEventsDatabase;
  private profilesDb?: AgentInventoryProfilesDatabase;

  constructor(options?: { eventsDb?: CatalogEventsDatabase; profilesDb?: AgentInventoryProfilesDatabase }) {
    this.crawler = new PropertyCrawler({ logLevel: (process.env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error') || 'error' });
    this.federatedIndex = new FederatedIndexService();
    this.adAgentsManager = new AdAgentsManager();
    this.brandManager = new BrandManager();
    this.brandDb = new BrandDatabase();
    this.memberDb = new MemberDatabase();
    this.capabilityDiscovery = new CapabilityDiscovery();
    this.eventsDb = options?.eventsDb;
    this.profilesDb = options?.profilesDb;
  }

  async crawlAllAgents(agents: Agent[]): Promise<CrawlResult> {
    if (this.crawling) {
      log.debug('Crawl already in progress, skipping');
      return this.lastResult || this.emptyResult();
    }

    this.crawling = true;
    log.info({ agentCount: agents.length }, 'Starting crawl');

    // Convert our Agent type to AgentInfo for the crawler
    const agentInfos: AgentInfo[] = agents.map((agent) => ({
      agent_url: agent.url,
      protocol: agent.protocol || "mcp", // Use agent's protocol, default to MCP
      publisher_domain: this.extractDomain(agent.url),
    }));

    try {
      const result = await this.crawler.crawlAgents(agentInfos);

      this.lastCrawl = new Date();
      this.lastResult = result;
      this.crawling = false;

      log.info({
        totalProperties: result.totalProperties,
        successfulAgents: result.successfulAgents,
        totalAgents: agents.length,
        publisherDomains: result.totalPublisherDomains,
      }, 'Crawl complete');

      if (result.failedAgents > 0) {
        log.warn({ failedAgents: result.failedAgents }, 'Some agents failed (no adagents.json)');
      }

      if (result.errors.length > 0) {
        const errorsByDomain: Record<string, string[]> = {};
        for (const err of result.errors) {
          (errorsByDomain[err.agent_url] ??= []).push(err.error);
        }
        log.warn({ errorsByDomain }, 'Crawl errors');
      }

      if (result.warnings && result.warnings.length > 0) {
        log.warn({ warnings: result.warnings }, 'Crawl warnings');
      }

      // Snapshot pre-crawl state for diffing
      const preCrawlAgents = await this.snapshotAgentState();

      // Populate federated index from PropertyIndex and adagents.json files
      const crawledDomains = await this.populateFederatedIndex(agents);

      // Build and upsert inventory profiles
      const builtProfiles = await this.buildInventoryProfiles();

      // Diff and produce events (after profiles are built so discovery events include profile data)
      await this.produceEventsFromDiff(preCrawlAgents, builtProfiles);

      // Scan brand.json for all crawled domains + all hosted brand domains
      const hostedDomains = await this.brandDb.listAllHostedBrandDomains();
      const brandDomains = [...new Set([...crawledDomains, ...hostedDomains])];
      await this.scanBrandsForDomains(brandDomains);

      return result;
    } catch (error) {
      log.error({ err: error }, 'Crawl failed');
      this.crawling = false;
      throw error;
    }
  }

  startPeriodicCrawl(agents: Agent[], intervalMinutes: number = 60) {
    // Initial crawl
    this.crawlAllAgents(agents);

    // Periodic crawl
    this.intervalId = setInterval(() => {
      this.crawlAllAgents(agents);
    }, intervalMinutes * 60 * 1000);

    log.info({ intervalMinutes }, 'Periodic crawl started');
  }

  stopPeriodicCrawl() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      log.info('Periodic crawl stopped');
    }
  }

  getStatus() {
    const index = getPropertyIndex();
    const stats = index.getStats();
    return {
      crawling: this.crawling,
      lastCrawl: this.lastCrawl?.toISOString() || null,
      lastResult: this.lastResult,
      indexStats: stats,
    };
  }

  private extractDomain(url: string): string {
    try {
      const parsed = new URL(url);
      return parsed.hostname;
    } catch {
      return url;
    }
  }

  private emptyResult(): CrawlResult {
    return {
      totalProperties: 0,
      totalPublisherDomains: 0,
      successfulAgents: 0,
      failedAgents: 0,
      errors: [],
      warnings: [],
    };
  }

  /**
   * Scan brand.json for each domain. Verifies pointer files pointing back to AAO
   * (setting domain_verified on hosted_brands) and upserts live authoritative
   * brand.json files into discovered_brands.
   */
  private async scanBrandsForDomains(domains: string[]): Promise<void> {
    const CONCURRENCY = 5;
    log.debug({ domainCount: domains.length }, 'Scanning brand.json');
    let verified = 0;
    let discovered = 0;

    const scanOne = async (domain: string): Promise<void> => {
      try {
        const result = await this.brandManager.validateDomain(domain, { skipCache: true });
        if (!result.valid || !result.raw_data) return;

        if (result.variant === 'authoritative_location') {
          const data = result.raw_data as { authoritative_location: string };
          try {
            const url = new URL(data.authoritative_location);
            if (url.hostname === AAO_HOST &&
                url.pathname === `/brands/${domain}/brand.json`) {
              const hosted = await this.brandDb.getHostedBrandByDomain(domain);
              if (hosted && !hosted.domain_verified) {
                await this.brandDb.updateHostedBrand(hosted.id, { domain_verified: true });
                verified++;
                log.debug({ domain }, 'Brand verified');
              }
            }
          } catch {
            // Invalid URL in authoritative_location — skip
          }
        } else if (result.variant === 'house_portfolio' ||
                   result.variant === 'brand_agent' ||
                   result.variant === 'house_redirect') {
          const brandName = this.extractBrandName(result.raw_data, domain);
          await this.brandDb.upsertDiscoveredBrand({
            domain,
            brand_name: brandName,
            has_brand_manifest: result.variant === 'house_portfolio',
            brand_manifest: result.variant === 'house_portfolio'
              ? result.raw_data as Record<string, unknown>
              : undefined,
            source_type: 'brand_json',
          });
          discovered++;
        }
      } catch (err) {
        log.warn({ domain, err: err instanceof Error ? err.message : err }, 'Brand scan failed');
      }
    };

    // Process in batches of CONCURRENCY
    for (let i = 0; i < domains.length; i += CONCURRENCY) {
      await Promise.all(domains.slice(i, i + CONCURRENCY).map(scanOne));
    }

    log.info({ verified, discovered }, 'Brand scan complete');
  }

  private extractBrandName(data: unknown, fallback: string): string {
    const obj = data as Record<string, unknown>;
    if (typeof obj?.house === 'object' && obj.house !== null) {
      const house = obj.house as Record<string, unknown>;
      if (typeof house.name === 'string') return house.name;
    }
    return fallback;
  }

  /**
   * Populate the federated index with discovered agents and publishers.
   * This is called after the PropertyCrawler finishes to persist data to PostgreSQL.
   * Returns the set of domains that were crawled (for brand scanning).
   */
  private async populateFederatedIndex(agents: Agent[]): Promise<Set<string>> {
    log.debug('Populating federated index');
    const index = getPropertyIndex();

    // Track domains we've already processed to avoid duplicates
    const processedDomains = new Set<string>();

    // 1. Crawl registered publishers' adagents.json files
    const profiles = await this.memberDb.listProfiles({ is_public: true });
    const registeredPublisherDomains: string[] = [];
    for (const profile of profiles) {
      for (const pubConfig of profile.publishers || []) {
        if (pubConfig.is_public && pubConfig.domain) {
          registeredPublisherDomains.push(pubConfig.domain);
        }
      }
    }
    log.debug({ count: registeredPublisherDomains.length }, 'Crawling registered publishers');

    for (const profile of profiles) {
      for (const pubConfig of profile.publishers || []) {
        if (!pubConfig.is_public || !pubConfig.domain) continue;
        if (processedDomains.has(pubConfig.domain)) continue;

        try {
          const validation = await this.adAgentsManager.validateDomain(pubConfig.domain);
          processedDomains.add(pubConfig.domain);

          if (validation.valid && validation.raw_data?.authorized_agents) {
            const agentCount = validation.raw_data.authorized_agents.length;
            const propCount = validation.raw_data.properties?.length || 0;
            log.debug({ domain: pubConfig.domain, agentCount, propCount }, 'Domain crawled');

            // Record agents
            for (const authorizedAgent of validation.raw_data.authorized_agents) {
              if (!authorizedAgent.url) continue;

              await this.federatedIndex.recordAgentFromAdagentsJson(
                authorizedAgent.url,
                pubConfig.domain,
                authorizedAgent.authorized_for,
                authorizedAgent.property_ids
              );

              // Record properties and link to this agent
              await this.recordPropertiesForAgent(
                validation.raw_data.properties || [],
                pubConfig.domain,
                authorizedAgent.url,
                authorizedAgent.authorized_for,
                authorizedAgent.property_ids
              );
            }
          } else {
            log.debug({ domain: pubConfig.domain }, 'No valid adagents.json');
          }
        } catch (err) {
          log.warn({ domain: pubConfig.domain, err: err instanceof Error ? err.message : err }, 'Publisher crawl failed');
        }
      }
    }

    // 2. Record publishers discovered from each sales agent's list_authorized_properties
    log.debug('Processing sales agent discovered publishers');
    for (const agent of agents) {
      if (agent.type !== "sales") continue;

      const auth = index.getAgentAuthorizations(agent.url);
      if (!auth || auth.publisher_domains.length === 0) continue;

      for (const domain of auth.publisher_domains) {
        try {
          // Check if domain has valid adagents.json
          const validation = await this.adAgentsManager.validateDomain(domain);
          await this.federatedIndex.recordPublisherFromAgent(
            domain,
            agent.url,
            validation.valid
          );

          // If valid and not already processed, record agents and properties from adagents.json
          if (validation.valid && validation.raw_data?.authorized_agents && !processedDomains.has(domain)) {
            await this.federatedIndex.markPublisherHasValidAdagents(domain);
            processedDomains.add(domain);

            for (const authorizedAgent of validation.raw_data.authorized_agents) {
              if (!authorizedAgent.url) continue;

              await this.federatedIndex.recordAgentFromAdagentsJson(
                authorizedAgent.url,
                domain,
                authorizedAgent.authorized_for,
                authorizedAgent.property_ids
              );

              // Record properties and link to this agent
              await this.recordPropertiesForAgent(
                validation.raw_data.properties || [],
                domain,
                authorizedAgent.url,
                authorizedAgent.authorized_for,
                authorizedAgent.property_ids
              );
            }
          }
        } catch (err) {
          log.error({ domain, err }, 'Failed to process domain');
        }
      }
    }

    // Log stats
    try {
      const stats = await this.federatedIndex.getStats();
      log.info({
        agents: stats.discovered_agents,
        publishers: stats.discovered_publishers,
        properties: stats.discovered_properties,
        propertiesByType: stats.properties_by_type,
        authorizations: stats.authorizations,
        verified: stats.authorizations_by_source.adagents_json,
        claims: stats.authorizations_by_source.agent_claim,
      }, 'Federated index populated');
    } catch {
      // Stats are optional
    }

    // 3. Probe all agents to discover and save their types
    await this.probeAndUpdateAgentTypes(agents);

    return processedDomains;
  }

  /**
   * Probe agents to discover their capabilities and infer their type.
   * Updates the database with the inferred type for each agent.
   *
   * Type indicators:
   * - Sales: get_products, create_media_buy, list_authorized_properties
   * - Creative: list_creative_formats, build_creative, generate_creative, validate_creative
   * - Signals: get_signals, list_signals, match_audience, activate_signal, activate_audience
   *
   * Returns 'unknown' if no type-specific tools found or multiple types detected (hybrid agent).
   */
  private async probeAndUpdateAgentTypes(agents: Agent[]): Promise<void> {
    log.debug('Probing agents to discover types');

    // Get all unique agent URLs (from both registered and discovered)
    const allAgents = await this.federatedIndex.listAllAgents();

    // Build a map of known types to skip already-typed agents
    const knownTypes = new Map<string, string>();
    for (const a of allAgents) {
      if (a.type && a.type !== 'unknown') {
        knownTypes.set(a.url, a.type);
      }
    }

    const agentUrls = new Set([
      ...agents.map(a => a.url),
      ...allAgents.map(a => a.url),
    ]);

    // Filter out agents that already have a type
    const urlsToProbe = Array.from(agentUrls).filter(url => !knownTypes.has(url));

    if (urlsToProbe.length === 0) {
      log.debug('All agents already typed, skipping probe');
      return;
    }

    log.debug({ toProbe: urlsToProbe.length, alreadyTyped: knownTypes.size }, 'Probing agents for type');

    // Probe agents in parallel with concurrency limit
    const CONCURRENCY = 5;
    const PROBE_TIMEOUT_MS = 10000;
    let updated = 0;
    let failed = 0;

    // Process in batches for controlled concurrency
    for (let i = 0; i < urlsToProbe.length; i += CONCURRENCY) {
      const batch = urlsToProbe.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (url) => {
          const agent: Agent = {
            name: url,
            url,
            type: 'unknown',
            protocol: 'mcp',
            description: '',
            mcp_endpoint: url,
            contact: { name: '', email: '', website: '' },
            added_date: new Date().toISOString().split('T')[0],
          };

          // Add timeout to prevent hanging on unresponsive agents
          const profile = await Promise.race([
            this.capabilityDiscovery.discoverCapabilities(agent),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('Probe timeout')), PROBE_TIMEOUT_MS)
            ),
          ]);

          // Infer type from capabilities
          const inferredType = this.capabilityDiscovery.inferTypeFromProfile(profile);

          if (inferredType !== 'unknown') {
            await this.federatedIndex.updateAgentMetadata(url, {
              agent_type: inferredType,
              protocol: profile.protocol,
            });
            return 'updated';
          }
          return 'skipped';
        })
      );

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value === 'updated') {
          updated++;
        } else if (result.status === 'rejected') {
          failed++;
        }
      }
    }

    log.info({ updated, unreachable: failed }, 'Agent type discovery complete');
  }

  /**
   * Get the federated index service (for API access)
   */
  getFederatedIndex(): FederatedIndexService {
    return this.federatedIndex;
  }

  /**
   * Record properties from adagents.json and link them to an agent.
   * If the agent has property_ids specified, only record those specific properties.
   */
  private async recordPropertiesForAgent(
    properties: Array<{
      property_id?: string;
      property_type: string;
      name: string;
      identifiers: Array<{ type: string; value: string }>;
      tags?: string[];
      publisher_domain?: string;
    }>,
    publisherDomain: string,
    agentUrl: string,
    authorizedFor?: string,
    limitToPropertyIds?: string[]
  ): Promise<void> {
    for (const prop of properties) {
      // If agent has specific property_ids, only record those
      if (limitToPropertyIds && limitToPropertyIds.length > 0) {
        if (!prop.property_id || !limitToPropertyIds.includes(prop.property_id)) {
          continue;
        }
      }

      await this.federatedIndex.recordProperty(
        {
          property_id: prop.property_id,
          publisher_domain: prop.publisher_domain || publisherDomain,
          property_type: prop.property_type,
          name: prop.name,
          identifiers: prop.identifiers,
          tags: prop.tags,
        },
        agentUrl,
        authorizedFor
      );
    }
  }

  // ── State Snapshot & Diffing ─────────────────────────────────────

  private async snapshotAgentState(): Promise<Map<string, { domains: Set<string> }>> {
    const snapshot = new Map<string, { domains: Set<string> }>();
    const agents = await this.federatedIndex.listAllAgents();

    for (const agent of agents) {
      const domains = await this.federatedIndex.getDomainsForAgent(agent.url);
      snapshot.set(agent.url, {
        domains: new Set(domains),
      });
    }

    return snapshot;
  }

  private async produceEventsFromDiff(
    preCrawlAgents: Map<string, { domains: Set<string> }>,
    profiles: Map<string, ProfileUpsertInput>
  ): Promise<void> {
    if (!this.eventsDb) return;

    const events: WriteEventInput[] = [];
    const postCrawlAgents = await this.snapshotAgentState();

    // Detect new agents — include full profile in the event so RegistrySync
    // clients get a complete agent without waiting for next bootstrap
    for (const [url] of postCrawlAgents) {
      if (!preCrawlAgents.has(url)) {
        const profile = profiles.get(url);
        events.push({
          event_type: 'agent.discovered',
          entity_type: 'agent',
          entity_id: url,
          payload: {
            agent_url: url,
            ...(profile ? {
              channels: profile.channels,
              property_types: profile.property_types,
              markets: profile.markets,
              categories: profile.categories,
              tags: profile.tags,
              delivery_types: profile.delivery_types,
              property_count: profile.property_count,
              publisher_count: profile.publisher_count,
              has_tmp: profile.has_tmp,
            } : {}),
          },
          actor: 'pipeline:crawler',
        });
      }
    }

    // Detect removed agents (global aggregation: gone from ALL publishers)
    for (const [url] of preCrawlAgents) {
      if (!postCrawlAgents.has(url)) {
        events.push({
          event_type: 'agent.removed',
          entity_type: 'agent',
          entity_id: url,
          payload: { agent_url: url },
          actor: 'pipeline:crawler',
        });
      }
    }

    // Detect authorization changes per agent
    for (const [url, postState] of postCrawlAgents) {
      const preState = preCrawlAgents.get(url);
      const preDomains = preState?.domains ?? new Set<string>();

      // New authorizations
      for (const domain of postState.domains) {
        if (!preDomains.has(domain)) {
          events.push({
            event_type: 'authorization.granted',
            entity_type: 'authorization',
            entity_id: `${url}:${domain}`,
            payload: { agent_url: url, publisher_domain: domain },
            actor: 'pipeline:crawler',
          });
        }
      }

      // Revoked authorizations
      for (const domain of preDomains) {
        if (!postState.domains.has(domain)) {
          events.push({
            event_type: 'authorization.revoked',
            entity_type: 'authorization',
            entity_id: `${url}:${domain}`,
            payload: { agent_url: url, publisher_domain: domain },
            actor: 'pipeline:crawler',
          });
        }
      }
    }

    if (events.length > 0) {
      await this.eventsDb.writeEvents(events);
      log.info({ eventCount: events.length }, 'Catalog events produced from crawl diff');
    }
  }

  // ── Inventory Profile Building ───────────────────────────────────

  private async buildInventoryProfiles(): Promise<Map<string, ProfileUpsertInput>> {
    const profileMap = new Map<string, ProfileUpsertInput>();
    if (!this.profilesDb) return profileMap;

    const agents = await this.federatedIndex.listAllAgents();
    const profiles: ProfileUpsertInput[] = [];

    for (const agent of agents) {
      const domains = await this.federatedIndex.getDomainsForAgent(agent.url);
      if (domains.length === 0) continue;

      const markets = new Set<string>();
      const propertyTypes = new Set<string>();
      const tags = new Set<string>();
      const deliveryTypes = new Set<string>();
      const publisherDomains = new Set<string>(domains);
      let propertyCount = 0;

      // Get properties for this agent
      const properties = await this.federatedIndex.getPropertiesForAgent(agent.url);
      for (const prop of properties) {
        propertyCount++;
        if (prop.property_type) propertyTypes.add(prop.property_type);
        if (prop.tags) prop.tags.forEach(t => tags.add(t));
      }

      // Derive channels from property types
      const channels = new Set<string>();
      if (propertyTypes.has('website')) channels.add('display');
      if (propertyTypes.has('ctv_app')) channels.add('ctv');
      if (propertyTypes.has('mobile_app')) channels.add('mobile');
      if (propertyTypes.has('audio_stream') || propertyTypes.has('podcast')) channels.add('audio');
      if (propertyTypes.has('dooh_screen')) channels.add('dooh');

      const profile: ProfileUpsertInput = {
        agent_url: agent.url,
        channels: [...channels],
        property_types: [...propertyTypes],
        markets: [...markets],
        categories: [],  // Populated when collections have genre_taxonomy
        tags: [...tags],
        delivery_types: [...deliveryTypes],
        property_count: propertyCount,
        publisher_count: publisherDomains.size,
        has_tmp: false,  // Updated when TMP registration data is available
      };
      profiles.push(profile);
      profileMap.set(agent.url, profile);
    }

    if (profiles.length > 0) {
      await this.profilesDb.upsertProfiles(profiles);
      const currentUrls = profiles.map(p => p.agent_url);
      const staleDeleted = await this.profilesDb.deleteStaleProfiles(currentUrls);
      if (staleDeleted > 0) {
        log.info({ deleted: staleDeleted }, 'Stale inventory profiles cleaned up');
      }
      log.info({ profileCount: profiles.length }, 'Inventory profiles updated');
    }

    return profileMap;
  }

  // ── Single Domain Crawl ──────────────────────────────────────────

  async crawlSingleDomain(domain: string): Promise<void> {
    if (this.crawling) {
      log.warn({ domain }, 'Full crawl in progress, skipping single domain crawl');
      return;
    }

    log.info({ domain }, 'Single domain crawl requested');

    try {
      const validation = await this.adAgentsManager.validateDomain(domain);

      if (!validation.valid || !validation.raw_data?.authorized_agents) {
        log.warn({ domain }, 'No valid adagents.json for domain');
        return;
      }

      // Record agents and properties
      for (const authorizedAgent of validation.raw_data.authorized_agents) {
        if (!authorizedAgent.url) continue;

        await this.federatedIndex.recordAgentFromAdagentsJson(
          authorizedAgent.url,
          domain,
          authorizedAgent.authorized_for,
          authorizedAgent.property_ids
        );

        await this.recordPropertiesForAgent(
          validation.raw_data.properties || [],
          domain,
          authorizedAgent.url,
          authorizedAgent.authorized_for,
          authorizedAgent.property_ids
        );
      }

      // Produce per-domain events
      if (this.eventsDb) {
        await this.eventsDb.writeEvent({
          event_type: 'publisher.adagents_changed',
          entity_type: 'publisher',
          entity_id: domain,
          payload: {
            publisher_domain: domain,
            agent_count: validation.raw_data.authorized_agents.length,
            property_count: validation.raw_data.properties?.length ?? 0,
          },
          actor: 'api:crawl-request',
        });
      }

      // Rebuild profiles for affected agents
      await this.buildInventoryProfiles();

      log.info({ domain }, 'Single domain crawl complete');
    } catch (err) {
      log.error({ domain, err }, 'Single domain crawl failed');
      throw err;
    }
  }
}
