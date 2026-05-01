import type { Agent } from "./types.js";
import { PropertyCrawler, getPropertyIndex, type AgentInfo, type CrawlResult } from "@adcp/sdk";
import { sanitizeAdagentsProperty } from "./discovery/property-index-guard.js";
import { FederatedIndexService } from "./federated-index.js";
import { AdAgentsManager } from "./adagents-manager.js";
import { BrandManager } from "./brand-manager.js";
import { BrandDatabase } from "./db/brand-db.js";
import { PublisherDatabase, type AdagentsManifest } from "./db/publisher-db.js";
import { MemberDatabase } from "./db/member-db.js";
import { CapabilityDiscovery } from "./capabilities.js";
import { HealthChecker } from "./health.js";
import { AgentSnapshotDatabase } from "./db/agent-snapshot-db.js";
import { AAO_HOST } from "./config/aao.js";
import { AAO_UA_DISCOVERY } from "./config/user-agents.js";
import { createLogger } from "./logger.js";
import type { CatalogEventsDatabase, WriteEventInput } from "./db/catalog-events-db.js";
import type { AgentInventoryProfilesDatabase, ProfileUpsertInput } from "./db/agent-inventory-profiles-db.js";
import { query } from "./db/client.js";
import { insertTypeReclassification } from "./db/type-reclassification-log-db.js";

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
  private publisherDb: PublisherDatabase;
  private memberDb: MemberDatabase;
  private capabilityDiscovery: CapabilityDiscovery;
  private healthChecker: HealthChecker;
  private snapshotDb: AgentSnapshotDatabase;
  private eventsDb?: CatalogEventsDatabase;
  private profilesDb?: AgentInventoryProfilesDatabase;

  constructor(options?: { eventsDb?: CatalogEventsDatabase; profilesDb?: AgentInventoryProfilesDatabase }) {
    this.crawler = new PropertyCrawler({ logLevel: (process.env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error') || 'error', userAgent: AAO_UA_DISCOVERY });
    this.federatedIndex = new FederatedIndexService();
    this.adAgentsManager = new AdAgentsManager();
    this.brandManager = new BrandManager();
    this.brandDb = new BrandDatabase();
    this.publisherDb = new PublisherDatabase();
    this.memberDb = new MemberDatabase();
    this.capabilityDiscovery = new CapabilityDiscovery();
    this.healthChecker = new HealthChecker();
    this.snapshotDb = new AgentSnapshotDatabase();
    this.eventsDb = options?.eventsDb;
    this.profilesDb = options?.profilesDb;
  }

  async crawlAllAgents(agents: Agent[]): Promise<CrawlResult> {
    if (this.crawling) {
      log.debug('Crawl already in progress, skipping');
      return this.lastResult || this.emptyResult();
    }

    this.crawling = true;

    // Filter out agents whose owners have paused monitoring
    const pausedUrls = await this.getPausedAgentUrls();
    const activeAgents = agents.filter(a => !pausedUrls.has(a.url));
    if (activeAgents.length < agents.length) {
      log.info({ paused: agents.length - activeAgents.length, active: activeAgents.length }, 'Skipping paused agents');
    }
    log.info({ agentCount: activeAgents.length }, 'Starting crawl');

    // Convert our Agent type to AgentInfo for the crawler
    const agentInfos: AgentInfo[] = activeAgents.map((agent) => ({
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

  private async getPausedAgentUrls(): Promise<Set<string>> {
    try {
      const result = await query(
        `SELECT agent_url FROM agent_registry_metadata WHERE monitoring_paused = TRUE`,
      );
      return new Set(result.rows.map((r: { agent_url: string }) => r.agent_url));
    } catch (err) {
      log.warn({ err }, 'Failed to fetch paused agents, treating all as active');
      return new Set();
    }
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
   * (setting domain_verified on brands) and upserts live authoritative
   * brand.json files into brands.
   */
  /**
   * Scan a single domain for brand.json and upsert discovered/verified brand data.
   */
  async scanBrandForDomain(domain: string): Promise<void> {
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

      // Extract properties from brand.json and upsert into catalog
      if (result.variant === 'house_portfolio') {
        await this.upsertBrandProperties(domain, result.raw_data as Record<string, unknown>);
      }
    }
  }

  /**
   * Extract properties from brand.json and upsert them into the property catalog.
   * brand.json = "what I own" — the brand declares its properties.
   */
  private async upsertBrandProperties(domain: string, brandJson: Record<string, unknown>): Promise<void> {
    const brands = Array.isArray(brandJson.brands) ? brandJson.brands as Array<Record<string, unknown>> : [];
    // Also check top-level properties (for simple brand.json without brands array)
    const topProperties = Array.isArray(brandJson.properties) ? brandJson.properties as Array<Record<string, unknown>> : [];

    const allProperties: Array<{ type: string; identifier: string }> = [];
    for (const brand of brands) {
      const props = Array.isArray(brand.properties) ? brand.properties as Array<Record<string, unknown>> : [];
      for (const p of props) {
        if (typeof p.identifier === 'string' && typeof p.type === 'string') {
          allProperties.push({ type: p.type, identifier: p.identifier.toLowerCase() });
        }
      }
    }
    for (const p of topProperties) {
      if (typeof p.identifier === 'string' && typeof p.type === 'string') {
        allProperties.push({ type: p.type, identifier: p.identifier.toLowerCase() });
      }
    }

    if (allProperties.length === 0) return;

    // Map brand.json property types to catalog identifier types
    const typeMap: Record<string, string> = {
      website: 'domain',
      mobile_app: 'bundle_id',
      ctv_app: 'bundle_id',
      desktop_app: 'bundle_id',
      dooh: 'domain',
      podcast: 'domain',
      radio: 'domain',
      streaming_audio: 'domain',
    };

    try {
      const { uuidv7 } = await import('./db/uuid.js');
      for (const prop of allProperties) {
        const identifierType = typeMap[prop.type] || 'domain';

        // Check if this identifier already exists in the catalog
        const existing = await query<{ property_rid: string }>(
          'SELECT property_rid FROM catalog_identifiers WHERE identifier_type = $1 AND identifier_value = $2',
          [identifierType, prop.identifier]
        );

        if (existing.rows.length > 0) {
          // Property already in catalog — just update the source timestamp
          await query(
            'UPDATE catalog_properties SET source_updated_at = NOW(), updated_at = NOW() WHERE property_rid = $1',
            [existing.rows[0].property_rid]
          );
        } else {
          // New property — insert into catalog
          const rid = uuidv7();
          await query(
            `INSERT INTO catalog_properties (property_rid, classification, source, status, created_by)
             VALUES ($1, 'property', 'contributed', 'active', $2)`,
            [rid, `brand_json:${domain}`]
          );
          await query(
            `INSERT INTO catalog_identifiers (id, property_rid, identifier_type, identifier_value, evidence, confidence)
             VALUES ($1, $2, $3, $4, 'brand_json', 'strong')
             ON CONFLICT (identifier_type, identifier_value) DO NOTHING`,
            [uuidv7(), rid, identifierType, prop.identifier]
          );
        }
      }
      log.debug({ domain, propertyCount: allProperties.length }, 'Upserted brand.json properties to catalog');
    } catch (err) {
      log.warn({ domain, err: err instanceof Error ? err.message : err }, 'Failed to upsert brand properties to catalog');
    }
  }

  private async scanBrandsForDomains(domains: string[]): Promise<void> {
    const CONCURRENCY = 5;
    log.debug({ domainCount: domains.length }, 'Scanning brand.json');

    for (let i = 0; i < domains.length; i += CONCURRENCY) {
      await Promise.all(domains.slice(i, i + CONCURRENCY).map(async (domain) => {
        try {
          await this.scanBrandForDomain(domain);
        } catch (err) {
          log.warn({ domain, err: err instanceof Error ? err.message : err }, 'Brand scan failed');
        }
      }));
    }

    log.info({ domainCount: domains.length }, 'Brand scan complete');
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

            await this.cacheAdagentsManifest(pubConfig.domain, validation.raw_data as AdagentsManifest);

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

            await this.cacheAdagentsManifest(domain, validation.raw_data as AdagentsManifest);

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

    // 3. Probe all agents to discover capabilities+health, write snapshots,
    //    and update type for any still-unknown agents.
    await this.refreshAgentSnapshots(agents);

    return processedDomains;
  }

  /**
   * Probe every known agent to refresh capability + health snapshots in the DB,
   * and fill in agent type for any that are still `unknown`. The registry
   * page reads these snapshot tables instead of calling agents live, so this
   * pass is the materialization step that keeps the public API fast.
   *
   * Type indicators (SALES_TOOLS / CREATIVE_TOOLS / SIGNALS_TOOLS) live in
   * CapabilityDiscovery; inferTypeFromProfile collapses them to one.
   */
  private async refreshAgentSnapshots(agents: Agent[]): Promise<void> {
    log.debug('Refreshing agent health + capability snapshots');

    const allAgents = await this.federatedIndex.listAllAgents();
    const knownTypes = new Map<string, string>();
    for (const a of allAgents) {
      if (a.type && a.type !== 'unknown') {
        knownTypes.set(a.url, a.type);
      }
    }

    // Build one probe entry per unique URL; prefer registered-agent metadata
    // (name/protocol) when we have it, else derive from URL.
    const pausedUrls = await this.getPausedAgentUrls();
    const seen = new Set<string>();
    const toProbe: Agent[] = [];
    for (const src of [...agents, ...allAgents.map(a => ({
      name: a.name || a.url,
      url: a.url,
      type: (a.type as Agent['type']) || 'unknown',
      protocol: (a.protocol as 'mcp' | 'a2a') || 'mcp',
      description: '',
      mcp_endpoint: a.url,
      contact: { name: '', email: '', website: '' },
      added_date: new Date().toISOString().split('T')[0],
    } satisfies Agent))]) {
      if (seen.has(src.url) || pausedUrls.has(src.url)) continue;
      seen.add(src.url);
      toProbe.push(src);
    }

    if (toProbe.length === 0) {
      log.debug('No agents to probe');
      return;
    }

    const CONCURRENCY = 5;
    const PROBE_TIMEOUT_MS = 10000;
    let typesUpdated = 0;
    let snapshotsWritten = 0;
    let failed = 0;

    for (let i = 0; i < toProbe.length; i += CONCURRENCY) {
      const batch = toProbe.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (agent) => {
          const profile = await Promise.race([
            this.capabilityDiscovery.discoverCapabilities(agent),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('Probe timeout')), PROBE_TIMEOUT_MS)
            ),
          ]);

          const inferredType = this.capabilityDiscovery.inferTypeFromProfile(profile);
          const effectiveType = knownTypes.get(agent.url) || inferredType;
          const agentForHealth: Agent = { ...agent, type: effectiveType as Agent['type'], protocol: profile.protocol };

          const [health, stats] = await Promise.all([
            Promise.race([
              this.healthChecker.checkHealth(agentForHealth),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('Health timeout')), PROBE_TIMEOUT_MS)
              ),
            ]).catch((err): import('./types.js').AgentHealth => ({
              online: false,
              checked_at: new Date().toISOString(),
              error: err instanceof Error ? err.message : 'health check failed',
            })),
            Promise.race([
              this.healthChecker.getStats(agentForHealth),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('Stats timeout')), PROBE_TIMEOUT_MS)
              ),
            ]).catch((): import('./types.js').AgentStats => ({})),
          ]);

          await Promise.all([
            this.snapshotDb.upsertCapabilities(profile, inferredType === 'unknown' ? null : inferredType),
            this.snapshotDb.upsertHealth(agent.url, health, stats),
          ]);

          // Type-update policy:
          //   - No stored type or stored 'unknown' + probe gave a non-unknown type → promote.
          //   - Stored non-unknown disagrees with probe → log; do NOT auto-flip.
          //     Operator runs the backfill script to flip explicitly. Single
          //     probes can be wrong; auto-flipping would corrupt good rows on
          //     a transient bad probe. See #3538.
          const knownType = knownTypes.get(agent.url);
          const canPromote = inferredType !== 'unknown' && (!knownType || knownType === 'unknown');
          const isDisagreement =
            !!knownType && knownType !== 'unknown' && inferredType !== 'unknown' && knownType !== inferredType;

          if (isDisagreement) {
            log.warn(
              { url: agent.url, knownType, inferredType },
              'Agent type disagreement: stored vs probed. Run backfill to reconcile.'
            );
            // The disagreement event itself is what the audit log captures —
            // we deliberately do NOT auto-flip here (see #3538). Failure to
            // log is swallowed by the helper; no try/catch needed.
            await insertTypeReclassification({
              agentUrl: agent.url,
              oldType: knownType ?? null,
              newType: inferredType,
              source: 'crawler_promote',
              notes: { decision: 'logged_only_no_promote' },
            });
          }

          if (canPromote) {
            await this.federatedIndex.updateAgentMetadata(agent.url, {
              agent_type: inferredType,
              protocol: profile.protocol,
            });
            return 'type_updated';
          }
          return 'snapshot_only';
        })
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          snapshotsWritten++;
          if (result.value === 'type_updated') typesUpdated++;
        } else {
          failed++;
        }
      }
    }

    log.info(
      { snapshotsWritten, typesUpdated, unreachable: failed, probed: toProbe.length },
      'Agent snapshots refreshed',
    );
  }

  /**
   * Get the federated index service (for API access)
   */
  getFederatedIndex(): FederatedIndexService {
    return this.federatedIndex;
  }

  /**
   * Cache a validated adagents.json manifest into the publishers overlay and
   * project its properties into the property catalog. The writer runs as one
   * transaction with per-property savepoints, so a malformed property is
   * skipped without losing the rest of the manifest.
   *
   * Failure of the entire transaction is logged but does not abort the crawl:
   * the legacy discovered_properties / agent_property_authorizations writes
   * happen separately via recordPropertiesForAgent and remain authoritative
   * until catalog readers take over.
   */
  private async cacheAdagentsManifest(domain: string, manifest: AdagentsManifest): Promise<void> {
    try {
      await this.publisherDb.upsertAdagentsCache({ domain, manifest });
    } catch (err) {
      log.warn({ domain, err: err instanceof Error ? err.message : err }, 'Publisher cache write failed');
    }
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
    for (const rawProp of properties) {
      const prop = sanitizeAdagentsProperty(rawProp, { publisherDomain, agentUrl });
      if (!prop) continue;

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
    // Single query for all agent→domain pairs instead of O(N) per-agent queries
    const agentDomains = await this.federatedIndex.getAllAgentDomainPairs();
    const snapshot = new Map<string, { domains: Set<string> }>();
    for (const [agentUrl, domains] of agentDomains) {
      snapshot.set(agentUrl, { domains });
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

      await this.cacheAdagentsManifest(domain, validation.raw_data as AdagentsManifest);

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

      // Scan brand.json for this domain
      try {
        await this.scanBrandForDomain(domain);
      } catch (err) {
        log.warn({ domain, err: err instanceof Error ? err.message : err }, 'Brand scan during single domain crawl failed');
      }

      // Rebuild profiles for affected agents
      await this.buildInventoryProfiles();

      log.info({ domain }, 'Single domain crawl complete');
    } catch (err) {
      log.error({ domain, err }, 'Single domain crawl failed');
      throw err;
    }
  }

  // ── Catalog Domain Crawl ──────────────────────────────────────

  private catalogCrawlIntervalId: NodeJS.Timeout | null = null;
  private catalogCrawling = false;

  startPeriodicCatalogCrawl(intervalMinutes: number = 30) {
    // Don't run immediately — let the main crawl finish first
    this.catalogCrawlIntervalId = setInterval(() => {
      this.crawlCatalogDomains();
    }, intervalMinutes * 60 * 1000);

    log.info({ intervalMinutes }, 'Periodic catalog domain crawl started');
  }

  async crawlCatalogDomains(): Promise<{ checked: number; found: number }> {
    if (this.catalogCrawling || this.crawling) {
      log.debug('Crawl already in progress, skipping catalog crawl');
      return { checked: 0, found: 0 };
    }

    this.catalogCrawling = true;
    const BATCH_SIZE = 100;
    const CONCURRENCY = 20;

    try {
      // Pull domains from queue, oldest requests first, respecting backoff
      const rows = await query<{ identifier_type: string; identifier_value: string }>(
        `SELECT identifier_type, identifier_value
         FROM catalog_crawl_queue
         WHERE identifier_type = 'domain'
           AND next_crawl_after <= NOW()
           AND found_adagents = FALSE
         ORDER BY crawl_requested_at ASC
         LIMIT $1`,
        [BATCH_SIZE]
      );

      if (rows.rows.length === 0) {
        this.catalogCrawling = false;
        return { checked: 0, found: 0 };
      }

      log.info({ count: rows.rows.length }, 'Catalog domain crawl batch');

      let found = 0;
      const domains = rows.rows.map(r => r.identifier_value);

      // Process with concurrency limit
      const results = await this.processWithConcurrency(
        domains,
        CONCURRENCY,
        async (domain) => {
          try {
            const validation = await this.adAgentsManager.validateDomain(domain);
            return { domain, valid: validation.valid && !!validation.raw_data?.authorized_agents };
          } catch {
            return { domain, valid: false };
          }
        }
      );

      for (const { domain, valid } of results) {
        if (valid) {
          found++;
          // Run full single-domain crawl to record agents/properties
          try {
            await this.crawlSingleDomainForCatalog(domain);
          } catch (err) {
            log.error({ domain, err }, 'Catalog domain crawl failed for domain');
          }

          // Mark as found in queue
          await query(
            `UPDATE catalog_crawl_queue
             SET found_adagents = TRUE, last_crawled_at = NOW()
             WHERE identifier_type = 'domain' AND identifier_value = $1`,
            [domain]
          );

          // Upgrade catalog property source to discovered
          await query(
            `UPDATE catalog_properties SET source = 'authoritative', updated_at = NOW()
             WHERE property_rid IN (
               SELECT property_rid FROM catalog_identifiers
               WHERE identifier_type = 'domain' AND identifier_value = $1
             ) AND source = 'contributed'`,
            [domain]
          );
        } else {
          // Exponential backoff: 1 day, 1 week, 1 month
          await query(
            `UPDATE catalog_crawl_queue
             SET last_crawled_at = NOW(),
                 next_crawl_after = NOW() + CASE
                   WHEN last_crawled_at IS NULL THEN INTERVAL '1 day'
                   WHEN last_crawled_at > NOW() - INTERVAL '2 days' THEN INTERVAL '7 days'
                   ELSE INTERVAL '30 days'
                 END
             WHERE identifier_type = 'domain' AND identifier_value = $1`,
            [domain]
          );
        }
      }

      log.info({ checked: domains.length, found }, 'Catalog domain crawl batch complete');
      return { checked: domains.length, found };
    } finally {
      this.catalogCrawling = false;
    }
  }

  private async crawlSingleDomainForCatalog(domain: string): Promise<void> {
    const validation = await this.adAgentsManager.validateDomain(domain);
    if (!validation.valid || !validation.raw_data?.authorized_agents) return;

    await this.cacheAdagentsManifest(domain, validation.raw_data as AdagentsManifest);

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

    if (this.eventsDb) {
      await this.eventsDb.writeEvent({
        event_type: 'publisher.adagents_discovered',
        entity_type: 'publisher',
        entity_id: domain,
        payload: {
          publisher_domain: domain,
          agent_count: validation.raw_data.authorized_agents.length,
          property_count: validation.raw_data.properties?.length ?? 0,
          source: 'catalog_crawl',
        },
        actor: 'pipeline:catalog_crawl',
      });
    }
  }

  private async processWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    fn: (item: T) => Promise<R>
  ): Promise<R[]> {
    const results: R[] = [];
    let index = 0;

    async function worker() {
      while (index < items.length) {
        const i = index++;
        results[i] = await fn(items[i]);
      }
    }

    const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
    await Promise.all(workers);
    return results;
  }
}
