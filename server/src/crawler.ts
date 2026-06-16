import type { Agent } from "./types.js";
import { PropertyCrawler, getPropertyIndex, type AgentInfo, type CrawlResult } from "@adcp/sdk";
import { sanitizeAdagentsProperty } from "./discovery/property-index-guard.js";
import { FederatedIndexService } from "./federated-index.js";
import type { DiscoveredAgent } from "./db/federated-index-db.js";
import { AdAgentsManager, type AdAgentsValidationResult } from "./adagents-manager.js";
import { BrandManager } from "./brand-manager.js";
import { BrandDatabase } from "./db/brand-db.js";
import { PublisherDatabase, canonicalizeAgentUrl, type AdagentsManifest, type AdagentsAuthorizedAgent } from "./db/publisher-db.js";
import { canonicalizePublisherDomain } from "./services/publisher-domain.js";
import { MemberDatabase } from "./db/member-db.js";
import { CapabilityDiscovery } from "./capabilities.js";
import { HealthChecker } from "./health.js";
import { AgentSnapshotDatabase, type AgentCapabilitiesSnapshotRow } from "./db/agent-snapshot-db.js";
import { AgentContextDatabase } from "./db/agent-context-db.js";
import { AAO_HOST } from "./config/aao.js";
import { AAO_UA_DISCOVERY } from "./config/user-agents.js";
import { createLogger } from "./logger.js";
import type { CatalogEventsDatabase, WriteEventInput } from "./db/catalog-events-db.js";
import type { AgentInventoryProfilesDatabase, ProfileUpsertInput } from "./db/agent-inventory-profiles-db.js";
import { query } from "./db/client.js";
import { insertTypeReclassification } from "./db/type-reclassification-log-db.js";
import { resolveUserAgentAuth } from "./routes/helpers/resolve-user-agent-auth.js";
import { adaptAuthForSdk, type SdkAuth } from "./services/sdk-auth-adapter.js";

const log = createLogger('crawler');

function unknownClassificationProbeDue(
  snapshot: AgentCapabilitiesSnapshotRow | undefined,
  now: Date = new Date(),
): boolean {
  if (!snapshot) return true;
  if (snapshot.inferred_type !== null) return true;
  if (snapshot.probe_terminal_state) return false;
  if (!snapshot.next_probe_after) return true;
  return new Date(snapshot.next_probe_after).getTime() <= now.getTime();
}

/**
 * Compare a freshly-fetched adagents.json against the previously-cached
 * body for the same domain. Returns true when the contributory fields
 * differ — `authorized_agents`, `properties`, and `collections` — so manager fan-out
 * is gated on actual change rather than firing on every routine
 * 60-minute crawl. Top-level keys outside that subset (`$schema`,
 * `last_updated`, comments) are intentionally ignored. Arrays compare
 * positionally; nested object keys are sorted so two semantically
 * identical manifests with different key insertion order match.
 */
export function manifestContentChanged(
  previous: AdagentsManifest | null,
  next: AdagentsManifest,
): boolean {
  if (!previous) return true;
  const subset = (m: AdagentsManifest) => ({
    authorized_agents: Array.isArray(m.authorized_agents) ? m.authorized_agents : [],
    properties: Array.isArray(m.properties) ? m.properties : [],
    collections: Array.isArray(m.collections) ? m.collections : [],
  });
  return stableStringify(subset(previous)) !== stableStringify(subset(next));
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

export interface PublisherAdagentsRevalidationResult {
  domain: string;
  adagents_valid: boolean;
  checked_at: string;
  error?: string;
  issues?: {
    errors: AdAgentsValidationResult['errors'];
    warnings: AdAgentsValidationResult['warnings'];
  };
  properties_count?: number;
  authorized_agents_count?: number;
  status_code?: number;
  response_bytes?: number;
  resolved_url?: string;
  discovery_method?: AdAgentsValidationResult['discovery_method'];
  manager_domain?: string;
}

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
  private agentContextDb: AgentContextDatabase;
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
    this.agentContextDb = new AgentContextDatabase();
    this.eventsDb = options?.eventsDb;
    this.profilesDb = options?.profilesDb;
  }

  /**
   * Resolve any saved owner auth for an agent URL so probes don't get 401'd
   * by agents that gate discovery/health behind authentication. Returns
   * `undefined` when no org has registered credentials for the URL, which
   * preserves the historical anonymous-probe behavior for purely external
   * agents. Errors are swallowed and logged: a credential lookup failure
   * must never block a heartbeat.
   */
  private async resolveProbeAuth(agentUrl: string): Promise<SdkAuth | undefined> {
    try {
      const ownerOrgId = await this.agentContextDb.findOrgWithSavedAuth(agentUrl);
      if (!ownerOrgId) return undefined;
      const auth = await resolveUserAgentAuth(this.agentContextDb, ownerOrgId, agentUrl, log);
      return await adaptAuthForSdk(auth, { tokenEndpointLabel: `crawler:${agentUrl}` });
    } catch (err) {
      log.warn({ err, agentUrl }, 'Failed to resolve owner auth for periodic probe; falling back to anonymous');
      return undefined;
    }
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

    // Convert our Agent type to AgentInfo for the crawler, starting with config-seeded agents
    const seenAgentUrls = new Set<string>(activeAgents.map(a => a.url));
    const agentInfos: AgentInfo[] = activeAgents.map((agent) => ({
      agent_url: agent.url,
      protocol: agent.protocol || "mcp",
    }));

    // Merge in DB-discovered sales agents from prior crawl cycles so their
    // list_authorized_properties is called by the PropertyCrawler and their
    // publisher claims enter the PropertyIndex for step 2 (adcp#4849).
    try {
      const discoveredSales = await this.federatedIndex.listDiscoveredAgents('sales');
      let added = 0;
      for (const da of discoveredSales) {
        if (seenAgentUrls.has(da.agent_url) || pausedUrls.has(da.agent_url)) continue;
        seenAgentUrls.add(da.agent_url);
        agentInfos.push({
          agent_url: da.agent_url,
          protocol: (da.protocol as 'mcp' | 'a2a') || 'mcp',
        });
        added++;
      }
      if (added > 0) {
        log.debug({ count: added }, 'Including discovered sales agents in PropertyCrawler pass');
      }
    } catch (err) {
      log.warn({ err }, 'Failed to fetch discovered sales agents; proceeding with config agents only');
    }

    // Fetch sales_candidate agents discovered via publisher_properties fan-out.
    // These get included in the same crawlAgents call so the SDK probes their
    // list_authorized_properties alongside registered and confirmed sales agents.
    let salesCandidates: DiscoveredAgent[] = [];
    try {
      salesCandidates = await this.federatedIndex.getSalesCandidatesForProbe();
      let added = 0;
      for (const candidate of salesCandidates) {
        if (seenAgentUrls.has(candidate.agent_url) || pausedUrls.has(candidate.agent_url)) continue;
        seenAgentUrls.add(candidate.agent_url);
        agentInfos.push({
          agent_url: candidate.agent_url,
          protocol: (candidate.protocol as 'mcp' | 'a2a') || 'mcp',
        });
        added++;
      }
      if (added > 0) {
        log.debug({ count: added }, 'Including sales_candidate agents in PropertyCrawler pass');
      }
    } catch (err) {
      log.warn({ err }, 'Failed to fetch sales_candidate agents; proceeding without candidate probes');
    }

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

      // Populate federated index from PropertyIndex and adagents.json files,
      // including any publisher-domain claims returned by sales_candidate probes.
      const crawledDomains = await this.populateFederatedIndex(agents);

      // Promote or back off sales_candidates based on positive PropertyIndex evidence.
      // Absence of an error is not sufficient — the agent must have returned publisher-domain
      // authorizations (non-empty publisher_domains) to earn promotion to 'sales'.
      if (salesCandidates.length > 0) {
        const index = getPropertyIndex();
        for (const candidate of salesCandidates) {
          const auth = index.getAgentAuthorizations(candidate.agent_url);
          try {
            if (auth && auth.publisher_domains.length > 0) {
              await this.federatedIndex.promoteSalesCandidateToSales(candidate.agent_url);
              log.debug({ agentUrl: candidate.agent_url }, 'sales_candidate promoted to sales');
            } else {
              await this.federatedIndex.recordSalesCandidateProbeFailure(candidate.agent_url);
            }
          } catch (err) {
            log.warn(
              { agentUrl: candidate.agent_url, err: err instanceof Error ? err.message : err },
              'sales_candidate probe outcome recording failed',
            );
          }
        }
      }

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

  startPeriodicCrawl(getAgents: () => Promise<Agent[]>, intervalMinutes: number = 60) {
    const run = () =>
      getAgents()
        .then(agents => this.crawlAllAgents(agents))
        .catch(err => log.error({ err }, 'Periodic crawl failed'));

    run();
    this.intervalId = setInterval(run, intervalMinutes * 60 * 1000);
    // Background loop; never block process (or a vitest worker) exit.
    this.intervalId?.unref();

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

    // 1. Crawl registered publishers' adagents.json files. Walk every
    // profile — the publisher-level `pubConfig.is_public` flag below is
    // the gate; `member_profiles.is_public` is the member-directory
    // listing flag and shouldn't gate publisher discovery.
    const profiles = await this.memberDb.listProfiles({});
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

            await this.cacheAdagentsManifest(
              pubConfig.domain,
              validation.raw_data as AdagentsManifest,
              {
                statusCode: validation.status_code,
                responseBytes: validation.response_bytes,
                resolvedUrl: validation.resolved_url,
                discoveryMethod: validation.discovery_method,
                managerDomain: validation.manager_domain,
              },
            );

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

              // Fan out publisher_properties[].publisher_domains[] into
              // per-child rows so the AAO directory inverse-lookup
              // (adcp#4823) returns one row per represented publisher
              // instead of one row for the manager. See adcp#4825 for the
              // inline-resolution rule this implements.
              //
              // Skip when the crawl source is a delegating child (the
              // file lives at the manager via ads.txt MANAGERDOMAIN). In
              // that case the manager's own crawl handles fan-out with
              // correct attribution; firing fan-out here would overwrite
              // siblings' manager_domain with the delegating child's name.
              if (validation.discovery_method !== 'ads_txt_managerdomain') {
                await this.fanOutPublisherPropertiesAuthorizations(
                  authorizedAgent,
                  pubConfig.domain,
                );
              }
            }
            await this.reconcileLegacyAdagentsAgents(pubConfig.domain, validation.raw_data as AdagentsManifest);
          } else {
            log.debug({ domain: pubConfig.domain }, 'No valid adagents.json');
            // Record failed-fetch metadata so the verifier UI can show
            // "Last attempted at <ts> · HTTP <code>" even when no
            // manifest was cached. validation.status_code is set even
            // for non-200 responses; missing only when a network error
            // prevented any HTTP response (recordFailedAdagentsFetch
            // accepts undefined and writes NULL).
            await this.recordFailedAdagentsFetch(pubConfig.domain, {
              statusCode: validation.status_code,
              responseBytes: validation.response_bytes,
              resolvedUrl: validation.resolved_url,
            });
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

            await this.cacheAdagentsManifest(
              domain,
              validation.raw_data as AdagentsManifest,
              {
                statusCode: validation.status_code,
                responseBytes: validation.response_bytes,
                resolvedUrl: validation.resolved_url,
                discoveryMethod: validation.discovery_method,
                managerDomain: validation.manager_domain,
              },
            );

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

              // Skip fan-out when the source publisher delegates via
              // ads.txt MANAGERDOMAIN — see L482 for rationale.
              if (validation.discovery_method !== 'ads_txt_managerdomain') {
                await this.fanOutPublisherPropertiesAuthorizations(authorizedAgent, domain);
              }
            }
            await this.reconcileLegacyAdagentsAgents(domain, validation.raw_data as AdagentsManifest);
          }
        } catch (err) {
          log.error({ domain, err }, 'Failed to process domain');
        }
      }
    }

    // 2b. Walk DB-discovered agents through the PropertyIndex. The type filter
    //     is intentionally absent — `index.getAgentAuthorizations` acts as the gate:
    //     confirmed sales agents and due sales_candidates included in the
    //     PropertyCrawler pass have publisher_domains; others are skipped.
    log.debug('Processing DB-discovered agents via PropertyIndex');
    try {
      const discoveredSalesAgents = await this.federatedIndex.listDiscoveredAgents();
      for (const da of discoveredSalesAgents) {
        const auth = index.getAgentAuthorizations(da.agent_url);
        if (!auth || auth.publisher_domains.length === 0) continue;

        for (const domain of auth.publisher_domains) {
          try {
            const validation = await this.adAgentsManager.validateDomain(domain);
            // Always write the agent_claim row so this discovered agent's authorization
            // edge is recorded even when the domain was already processed by step 1/2.
            await this.federatedIndex.recordPublisherFromAgent(domain, da.agent_url, validation.valid);
            if (processedDomains.has(domain)) continue;

            if (validation.valid && validation.raw_data?.authorized_agents) {
              await this.federatedIndex.markPublisherHasValidAdagents(domain);
              processedDomains.add(domain);

              await this.cacheAdagentsManifest(domain, validation.raw_data as AdagentsManifest, {
                statusCode: validation.status_code,
                responseBytes: validation.response_bytes,
                resolvedUrl: validation.resolved_url,
                discoveryMethod: validation.discovery_method,
                managerDomain: validation.manager_domain,
              });

              for (const authorizedAgent of validation.raw_data.authorized_agents) {
                if (!authorizedAgent.url) continue;
                await this.federatedIndex.recordAgentFromAdagentsJson(
                  authorizedAgent.url, domain,
                  authorizedAgent.authorized_for, authorizedAgent.property_ids
                );
                await this.recordPropertiesForAgent(
                  validation.raw_data.properties || [], domain,
                  authorizedAgent.url, authorizedAgent.authorized_for, authorizedAgent.property_ids
                );
                // Skip fan-out when the source publisher delegates via
                // ads.txt MANAGERDOMAIN — see step 1/2 guards for rationale.
                if (validation.discovery_method !== 'ads_txt_managerdomain') {
                  await this.fanOutPublisherPropertiesAuthorizations(authorizedAgent, domain);
                }
              }
              // Safe to reconcile here: the `processedDomains.has(domain)` guard above
              // ensures each domain is handled exactly once across steps 1, 2, and 2b.
              await this.reconcileLegacyAdagentsAgents(domain, validation.raw_data as AdagentsManifest);
            }
          } catch (err) {
            log.error({ domain, agentUrl: da.agent_url, err }, 'Failed to process DB-discovered sales agent domain');
          }
        }
      }
    } catch (err) {
      log.warn({ err }, 'Failed to process DB-discovered sales agents; skipping step 2b');
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

    // listAllProbeableAgents unions member-profile registrations with
    // adagents_json-sourced discovered_agents so manager-file-only agents
    // (e.g., interchange.io, named only in cafemedia.com's selector with
    // no seed-set registration of its own) still get periodic probes.
    // Excludes agent_claim (list_authorized_properties) discoveries
    // intentionally — those are unverified peer claims. (adcp#4849)
    const allAgents = await this.federatedIndex.listAllProbeableAgents();
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

    const existingSnapshots = await this.snapshotDb.bulkGetCapabilities(toProbe.map(a => a.url));
    const now = new Date();
    const dueToProbe: Agent[] = [];
    let skippedBackoff = 0;
    let skippedTerminal = 0;

    for (const agent of toProbe) {
      const knownType = knownTypes.get(agent.url);
      if (knownType && knownType !== 'unknown') {
        dueToProbe.push(agent);
        continue;
      }

      const snapshot = existingSnapshots.get(agent.url);
      if (unknownClassificationProbeDue(snapshot, now)) {
        dueToProbe.push(agent);
      } else if (snapshot?.probe_terminal_state) {
        skippedTerminal++;
      } else {
        skippedBackoff++;
      }
    }

    if (dueToProbe.length === 0) {
      log.info(
        { skippedBackoff, skippedTerminal, probed: 0, candidates: toProbe.length },
        'No agents due for snapshot refresh',
      );
      return;
    }

    const CONCURRENCY = 5;
    const PROBE_TIMEOUT_MS = 10000;
    let typesUpdated = 0;
    let snapshotsWritten = 0;
    let failed = 0;
    let unknownFailuresRecorded = 0;

    for (let i = 0; i < dueToProbe.length; i += CONCURRENCY) {
      const batch = dueToProbe.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (agent) => {
          // Use saved owner credentials when the agent has any — keeps the
          // snapshot's `oauth_required` consistent with what the owner sees
          // after /connect, instead of clobbering it back to `true` on every
          // anonymous heartbeat. Falls back to anonymous for purely external
          // agents with no registered credentials.
          const auth = await this.resolveProbeAuth(agent.url);

          const profile = await Promise.race([
            this.capabilityDiscovery.discoverCapabilities(agent, auth),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('Probe timeout')), PROBE_TIMEOUT_MS)
            ),
          ]);

          const inferredType = this.capabilityDiscovery.inferTypeFromProfile(profile);
          const effectiveType = knownTypes.get(agent.url) || inferredType;
          const agentForHealth: Agent = { ...agent, type: effectiveType as Agent['type'], protocol: profile.protocol };
          const knownType = knownTypes.get(agent.url);
          const trackUnknownProbe = !knownType || knownType === 'unknown';

          const [health, stats] = await Promise.all([
            Promise.race([
              this.healthChecker.checkHealth(agentForHealth, auth),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('Health timeout')), PROBE_TIMEOUT_MS)
              ),
            ]).catch((err): import('./types.js').AgentHealth => ({
              online: false,
              checked_at: new Date().toISOString(),
              error: err instanceof Error ? err.message : 'health check failed',
            })),
            Promise.race([
              this.healthChecker.getStats(agentForHealth, auth),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('Stats timeout')), PROBE_TIMEOUT_MS)
              ),
            ]).catch((): import('./types.js').AgentStats => ({})),
          ]);

          await Promise.all([
            this.snapshotDb.upsertCapabilities(
              profile,
              inferredType === 'unknown' ? null : inferredType,
              { trackUnknownProbe },
            ),
            this.snapshotDb.upsertHealth(agent.url, health, stats),
          ]);

          // Type-update policy:
          //   - No stored type or stored 'unknown' + probe gave a non-unknown type → promote.
          //   - Stored non-unknown disagrees with probe → log; do NOT auto-flip.
          //     Operator runs the backfill script to flip explicitly. Single
          //     probes can be wrong; auto-flipping would corrupt good rows on
          //     a transient bad probe. See #3538.
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

      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        if (result.status === 'fulfilled') {
          snapshotsWritten++;
          if (result.value === 'type_updated') typesUpdated++;
        } else {
          failed++;
          const agent = batch[j];
          const knownType = agent ? knownTypes.get(agent.url) : undefined;
          if (agent && (!knownType || knownType === 'unknown')) {
            const error = result.reason instanceof Error ? result.reason.message : String(result.reason);
            await this.snapshotDb.recordUnknownProbeFailure(
              agent.url,
              (agent.protocol as 'mcp' | 'a2a') || 'mcp',
              error,
            );
            unknownFailuresRecorded++;
          }
        }
      }
    }

    log.info(
      {
        snapshotsWritten,
        typesUpdated,
        unreachable: failed,
        unknownFailuresRecorded,
        skippedBackoff,
        skippedTerminal,
        probed: dueToProbe.length,
        candidates: toProbe.length,
      },
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
   * Probe one agent and refresh both snapshot tables (health + capabilities)
   * for it. Used by `POST /api/registry/agents/{encodedUrl}/refresh` so an
   * owner can pull a fresh online/tools/type readout without waiting for the
   * 60-min periodic crawl.
   *
   * Mirrors the per-agent block of `refreshAgentSnapshots`: same 10s probe
   * timeout, same type-promotion policy (only promote when stored is unknown
   * — disagreement is logged, not auto-flipped, see #3538).
   *
   * Returns the resulting snapshot fields the caller needs to render the
   * registry row. Throws on probe failure with a descriptive message — the
   * route handler maps that to a 502 so the user sees why the refresh
   * couldn't happen (timeout, DNS, OAuth wall, etc).
   */
  async refreshSingleAgent(agentUrl: string, options: { auth?: SdkAuth } = {}): Promise<{
    online: boolean;
    tools_count: number | null;
    response_time_ms: number | null;
    inferred_type: string;
    type_promoted: boolean;
    oauth_required: boolean;
    checked_at: string;
    error?: string;
  }> {
    const PROBE_TIMEOUT_MS = 10000;
    const { auth } = options;

    const pausedUrls = await this.getPausedAgentUrls();
    if (pausedUrls.has(agentUrl)) {
      throw new Error('Monitoring paused for this agent');
    }

    // `includeMembersOnly: true` — owners can refresh their own private /
    // members-only agents (the route-level ownership check already gated
    // who got here). `refreshAgentSnapshots` uses public-only because the
    // periodic crawl probes everything in the federated index regardless.
    const allAgents = await this.federatedIndex.listAllAgents(undefined, { includeMembersOnly: true });
    const known = allAgents.find(a => a.url === agentUrl);
    const knownType = known?.type && known.type !== 'unknown' ? known.type : undefined;

    const agent: Agent = {
      name: known?.name || agentUrl,
      url: agentUrl,
      type: (known?.type as Agent['type']) || 'unknown',
      protocol: (known?.protocol as 'mcp' | 'a2a') || 'mcp',
      description: '',
      mcp_endpoint: agentUrl,
      contact: { name: '', email: '', website: '' },
      added_date: new Date().toISOString().split('T')[0],
    };

    const profile = await Promise.race([
      this.capabilityDiscovery.discoverCapabilities(agent, auth),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Probe timeout')), PROBE_TIMEOUT_MS)
      ),
    ]);

    const inferredType = this.capabilityDiscovery.inferTypeFromProfile(profile);
    const effectiveType = knownType || inferredType;
    const agentForHealth: Agent = { ...agent, type: effectiveType as Agent['type'], protocol: profile.protocol };

    const [health, stats] = await Promise.all([
      Promise.race([
        this.healthChecker.checkHealth(agentForHealth, auth),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Health timeout')), PROBE_TIMEOUT_MS)
        ),
      ]).catch((err): import('./types.js').AgentHealth => ({
        online: false,
        checked_at: new Date().toISOString(),
        error: err instanceof Error ? err.message : 'health check failed',
      })),
      Promise.race([
        this.healthChecker.getStats(agentForHealth, auth),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Stats timeout')), PROBE_TIMEOUT_MS)
        ),
      ]).catch((): import('./types.js').AgentStats => ({})),
    ]);

    await Promise.all([
      this.snapshotDb.upsertCapabilities(
        profile,
        inferredType === 'unknown' ? null : inferredType,
        { trackUnknownProbe: !knownType },
      ),
      this.snapshotDb.upsertHealth(agentUrl, health, stats),
    ]);

    // Same type-promotion policy as refreshAgentSnapshots: promote when
    // stored is unknown; log disagreement without auto-flipping (see #3538).
    const canPromote = inferredType !== 'unknown' && !knownType;
    const isDisagreement =
      !!knownType && inferredType !== 'unknown' && knownType !== inferredType;

    if (isDisagreement) {
      log.warn(
        { url: agentUrl, knownType, inferredType },
        'Agent type disagreement: stored vs probed. Run backfill to reconcile.'
      );
      await insertTypeReclassification({
        agentUrl,
        oldType: knownType ?? null,
        newType: inferredType,
        source: 'crawler_promote',
        notes: { decision: 'logged_only_no_promote', triggered_by: 'manual_refresh' },
      });
    }

    let typePromoted = false;
    if (canPromote) {
      await this.federatedIndex.updateAgentMetadata(agentUrl, {
        agent_type: inferredType,
        protocol: profile.protocol,
      });
      typePromoted = true;
    }

    return {
      online: health.online,
      tools_count: health.tools_count ?? null,
      response_time_ms: health.response_time_ms ?? null,
      inferred_type: inferredType,
      type_promoted: typePromoted,
      oauth_required: profile.oauth_required ?? false,
      checked_at: health.checked_at,
      error: health.error,
    };
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
  private async cacheAdagentsManifest(
    domain: string,
    manifest: AdagentsManifest,
    meta?: { statusCode?: number; responseBytes?: number; resolvedUrl?: string; discoveryMethod?: string; managerDomain?: string },
  ): Promise<void> {
    try {
      // Read the existing cached body before the upsert so we can
      // compute whether content actually changed. Used to gate
      // manager → publishers fan-out: re-validation only fans out when
      // the manager's authorized_agents or properties shape moved, not
      // on every routine 60-minute crawl.
      const previous = await this.publisherDb.getCachedAdagentsJson(domain);

      await this.publisherDb.upsertAdagentsCache({
        domain,
        manifest,
        statusCode: meta?.statusCode,
        responseBytes: meta?.responseBytes,
        resolvedUrl: meta?.resolvedUrl,
        discoveryMethod: meta?.discoveryMethod,
        managerDomain: meta?.managerDomain,
        eventsDb: this.eventsDb,
        collectionEventActor: meta?.discoveryMethod === 'ads_txt_managerdomain'
          ? 'pipeline:manager_revalidation'
          : 'pipeline:catalog_crawl',
      });

      // Manager fan-out: when the just-written manifest belongs to a
      // domain that other publishers delegate to via ads.txt
      // MANAGERDOMAIN, queue those publishers for re-validation. The
      // worker (processManagerRevalidationQueue) drains the queue at a
      // bounded rate so a Raptive-scale rotation doesn't saturate
      // crawler concurrency. Intentionally outside upsertAdagentsCache's
      // transaction: if the enqueue fails the cache write has already
      // committed, but the next routine 60-min crawl re-detects drift
      // and re-enqueues, so silent fan-out loss self-heals.
      if (manifestContentChanged(previous, manifest)) {
        try {
          const enqueued = await this.publisherDb.enqueueManagerRevalidation(domain);
          if (enqueued > 0) {
            log.info(
              { managerDomain: domain, enqueued },
              'Manager adagents.json changed; enqueued delegating publishers for re-validation',
            );
          }
        } catch (err) {
          log.warn(
            { domain, err: err instanceof Error ? err.message : err },
            'Failed to enqueue manager revalidation fan-out',
          );
        }
      }
    } catch (err) {
      log.warn({ domain, err: err instanceof Error ? err.message : err }, 'Publisher cache write failed');
    }
  }

  /**
   * Record a failed fetch on the publishers row so the verifier UI can
   * show "Last attempted: <ts> · HTTP <code>" even when no manifest
   * was cached. Best-effort — a failure to record metadata must not
   * abort the rest of the crawl.
   */
  private async recordFailedAdagentsFetch(
    domain: string,
    meta: { statusCode?: number; responseBytes?: number; resolvedUrl?: string },
  ): Promise<void> {
    try {
      await this.publisherDb.recordFailedAdagentsFetch({ domain, ...meta });
    } catch (err) {
      log.warn({ domain, err: err instanceof Error ? err.message : err }, 'Publisher failed-fetch record failed');
    }
  }

  /**
   * Reconcile legacy adagents_json authorization rows for a publisher
   * after a successful crawl: agents that were in a prior manifest but
   * are no longer in the freshly-fetched one get hard-deleted from the
   * legacy table. The catalog-side reconcile happens inside
   * upsertAdagentsCache. agent_claim rows are untouched. Best-effort —
   * a reconcile failure must not abort the rest of the crawl.
   */
  private async reconcileLegacyAdagentsAgents(domain: string, manifest: AdagentsManifest): Promise<void> {
    const entries = Array.isArray(manifest.authorized_agents) ? manifest.authorized_agents : [];
    const canonical = entries
      .map(e => (e?.url && typeof e.url === 'string' ? canonicalizeAgentUrl(e.url) : null))
      .filter((c): c is string => !!c);
    try {
      await this.federatedIndex.reconcileAdagentsAuthorizations(domain, canonical);
    } catch (err) {
      log.warn({ domain, err: err instanceof Error ? err.message : err }, 'Adagents legacy reconcile failed');
    }
  }

  private validationIssues(validation: AdAgentsValidationResult): {
    errors: AdAgentsValidationResult['errors'];
    warnings: AdAgentsValidationResult['warnings'];
  } {
    return {
      errors: validation.errors,
      warnings: validation.warnings,
    };
  }

  private isTransientPublisherAdagentsFailure(validation: AdAgentsValidationResult): boolean {
    // Network fetch failures come from classifySafeFetchError in
    // utils/url-security.ts. Keep every known transport bucket
    // non-destructive: only completed publisher-origin negatives may clear
    // cached adagents-derived projections.
    const hasTransientError = validation.errors.some((error) =>
      error.field === 'timeout'
      || error.field === 'connection'
      || error.field === 'network'
      || error.field === 'unknown'
      || /HTTP (401|403|408|429|451|5\d\d)\b/i.test(error.message)
      || /Redirect \(HTTP 3\d\d\)/i.test(error.message)
      || /timed out|timeout|Cannot connect|ECONN|ENOTFOUND|EAI_/i.test(error.message)
    );
    if (hasTransientError) return true;

    if (validation.status_code !== undefined) {
      return validation.status_code !== 200
        && validation.status_code !== 404
        && validation.status_code !== 410;
    }

    return false;
  }

  private summarizePublisherAdagentsRevalidation(
    domain: string,
    validation: AdAgentsValidationResult,
    checkedAt: Date,
  ): PublisherAdagentsRevalidationResult {
    const manifest = validation.raw_data as AdagentsManifest | undefined;
    const valid = validation.valid && Array.isArray(manifest?.authorized_agents);
    const error = validation.errors[0]?.message;
    const hasIssues = !valid || validation.warnings.length > 0;
    return {
      domain,
      adagents_valid: valid,
      checked_at: checkedAt.toISOString(),
      ...(valid ? {} : { error: error ?? 'Invalid adagents.json' }),
      ...(hasIssues ? { issues: this.validationIssues(validation) } : {}),
      properties_count: Array.isArray(manifest?.properties) ? manifest.properties.length : 0,
      authorized_agents_count: Array.isArray(manifest?.authorized_agents) ? manifest.authorized_agents.length : 0,
      ...(validation.status_code !== undefined ? { status_code: validation.status_code } : {}),
      ...(validation.response_bytes !== undefined ? { response_bytes: validation.response_bytes } : {}),
      ...(validation.resolved_url ? { resolved_url: validation.resolved_url } : {}),
      discovery_method: validation.discovery_method,
      ...(validation.manager_domain ? { manager_domain: validation.manager_domain } : {}),
    };
  }

  private async persistPublisherAdagentsValidation(
    domain: string,
    validation: AdAgentsValidationResult,
    actor: string,
  ): Promise<{ valid: boolean; affectedAgentUrls: Set<string> }> {
    const affectedAgentUrls = new Set<string>();
    const existingAuthorizations = await this.federatedIndex.getAuthorizationsForDomain(domain);
    for (const auth of existingAuthorizations) {
      if (auth.source !== 'adagents_json') continue;
      affectedAgentUrls.add(canonicalizeAgentUrl(auth.agent_url) ?? auth.agent_url);
    }

    if (!validation.valid || !Array.isArray(validation.raw_data?.authorized_agents)) {
      if (this.isTransientPublisherAdagentsFailure(validation)) {
        await this.publisherDb.recordFailedAdagentsFetch({
          domain,
          statusCode: validation.status_code,
          responseBytes: validation.response_bytes,
          resolvedUrl: validation.resolved_url,
        });
        return { valid: false, affectedAgentUrls: new Set() };
      }

      // Authoritative-negative revalidation is intentionally destructive:
      // it changes the registry's cached publisher-origin verdict, then
      // reconciles legacy indexes to match. The writes are ordered so stale
      // public auth/property projections are removed only after the failed
      // verdict is durably recorded.
      await this.publisherDb.recordAdagentsValidationFailure({
        domain,
        statusCode: validation.status_code,
        responseBytes: validation.response_bytes,
        resolvedUrl: validation.resolved_url,
        error: validation.errors[0]?.message,
        issues: this.validationIssues(validation),
      });
      return { valid: false, affectedAgentUrls };
    }

    const manifest = validation.raw_data as AdagentsManifest;
    await this.cacheAdagentsManifest(
      domain,
      manifest,
      {
        statusCode: validation.status_code,
        responseBytes: validation.response_bytes,
        resolvedUrl: validation.resolved_url,
        discoveryMethod: validation.discovery_method,
        managerDomain: validation.manager_domain,
      },
    );
    await this.federatedIndex.markPublisherHasValidAdagents(domain);

    for (const authorizedAgent of manifest.authorized_agents ?? []) {
      if (!authorizedAgent.url) continue;
      affectedAgentUrls.add(canonicalizeAgentUrl(authorizedAgent.url) ?? authorizedAgent.url);

      await this.federatedIndex.recordAgentFromAdagentsJson(
        authorizedAgent.url,
        domain,
        authorizedAgent.authorized_for,
        authorizedAgent.property_ids,
      );

      await this.recordPropertiesForAgent(
        (manifest.properties || []) as any,
        domain,
        authorizedAgent.url,
        authorizedAgent.authorized_for,
        authorizedAgent.property_ids,
      );

      if (validation.discovery_method !== 'ads_txt_managerdomain') {
        await this.fanOutPublisherPropertiesAuthorizations(authorizedAgent, domain);
      }
    }
    await this.reconcileLegacyAdagentsAgents(domain, manifest);

    if (this.eventsDb) {
      await this.eventsDb.writeEvent({
        event_type: 'publisher.adagents_changed',
        entity_type: 'publisher',
        entity_id: domain,
        payload: {
          publisher_domain: domain,
          agent_count: manifest.authorized_agents?.length ?? 0,
          property_count: manifest.properties?.length ?? 0,
          collection_count: manifest.collections?.length ?? 0,
          discovery_method: validation.discovery_method,
          manager_domain: validation.manager_domain,
        },
        actor,
      });
    }

    return { valid: true, affectedAgentUrls };
  }

  async revalidatePublisherAdagents(
    domain: string,
    _options: { force?: boolean } = {},
  ): Promise<PublisherAdagentsRevalidationResult> {
    const normalizedDomain = canonicalizePublisherDomain(domain);
    const checkedAt = new Date();
    const validation = await this.adAgentsManager.validateDomain(normalizedDomain);
    const persisted = await this.persistPublisherAdagentsValidation(
      normalizedDomain,
      validation,
      'api:adagents-revalidate',
    );

    try {
      await this.scanBrandForDomain(normalizedDomain);
    } catch (err) {
      log.warn({ domain: normalizedDomain, err: err instanceof Error ? err.message : err }, 'Brand scan during adagents revalidation failed');
    }

    if (persisted.affectedAgentUrls.size > 0) {
      await this.buildInventoryProfiles({
        agentUrls: [...persisted.affectedAgentUrls],
        deleteStale: false,
      });
    }

    return this.summarizePublisherAdagentsRevalidation(normalizedDomain, validation, checkedAt);
  }

  /**
   * Record properties from adagents.json and link them to an agent.
   * If the agent has property_ids specified, only record those specific properties.
   */
  /**
   * Fan publisher_properties[].publisher_domains[] out into per-child
   * rows so the AAO directory inverse-lookup endpoint
   * (GET /v1/agents/{agent_url}/publishers, adcp#4823) returns one row
   * per represented publisher, not one row per manager file.
   *
   * For a manager file like cafemedia's 6,800-publisher network, the
   * `authorized_agents[*].publisher_properties[*]` selector lists every
   * represented publisher. Without this fan-out the manager-only row in
   * `agent_publisher_authorizations` is the only edge the directory sees,
   * and `properties_total / properties_authorized` come out as 0 because
   * the cafemedia properties carry child `publisher_domain` values.
   *
   * Writes:
   *   - one `agent_publisher_authorizations` row per child publisher
   *     (source='adagents_json' — the manager file IS the authoritative
   *     declaration per adcp#4825 inline resolution rule)
   *   - one `publishers` row per child with discovery_method=
   *     'adagents_authoritative' and manager_domain=<host>. NO blob
   *     cached — the child's own origin was never fetched.
   *
   * Idempotent. The `by_id` selector form is intentionally excluded
   * (property IDs are publisher-scoped, so the compact `publisher_domains[]`
   * form is invalid for it per the publisher-property-selector schema).
   */
  private async fanOutPublisherPropertiesAuthorizations(
    authorizedAgent: AdagentsAuthorizedAgent,
    managerDomain: string,
  ): Promise<void> {
    if (authorizedAgent.authorization_type !== 'publisher_properties') return;
    if (!Array.isArray(authorizedAgent.publisher_properties)) return;
    const agentUrl = authorizedAgent.url;
    if (!agentUrl) return;

    const childDomains = new Set<string>();
    for (const selector of authorizedAgent.publisher_properties) {
      if (!selector || typeof selector !== 'object') continue;

      const hasSingular = typeof selector.publisher_domain === 'string';
      const hasPlural = Array.isArray(selector.publisher_domains)
        && selector.publisher_domains.length > 0;

      // XOR enforcement: schema requires exactly one of publisher_domain /
      // publisher_domains[]. Both-present is malformed; mirrors the catalog
      // projection's refuse-both invariant. Skip the whole selector entry
      // rather than synthesize a hybrid fan-out from an ambiguous shape.
      if (hasSingular && hasPlural) continue;
      if (!hasSingular && !hasPlural) continue;

      if (hasSingular) {
        childDomains.add(selector.publisher_domain as string);
      }

      // Defense-in-depth against a malformed manager file: the schema
      // rejects `by_id` with the compact `publisher_domains[]` form
      // (property IDs are publisher-scoped, so fanning a fixed ID set
      // across N publishers silently cross-authorizes whichever inventory
      // shares an ID — the cross-publisher ID-collision attack). The
      // hand-rolled validator in adagents-manager.ts does not yet enforce
      // this; refuse to fan out `by_id` + `publisher_domains[]` here so a
      // malformed file slipping past upstream validation can't synthesize
      // wrong authz rows. The singular `publisher_domain` form on `by_id`
      // stays honored above — that's the schema-conformant shape.
      if (selector.selection_type === 'by_id') continue;
      if (hasPlural) {
        for (const d of selector.publisher_domains as string[]) {
          if (typeof d === 'string') childDomains.add(d);
        }
      }
    }

    // Drop the manager domain from the child set — a manager that lists
    // itself in publisher_domains[] is just declaring its own inventory
    // (covered by the host-level authz row already written above).
    const managerCanonical = canonicalizePublisherDomain(managerDomain);
    for (const child of childDomains) {
      const childCanonical = canonicalizePublisherDomain(child);
      if (childCanonical === managerCanonical) continue;
      try {
        await this.publisherDb.recordChildPublisherFromManager({
          childDomain: childCanonical,
          managerDomain: managerCanonical,
        });
        await this.federatedIndex.recordAgentFromAdagentsJson(
          agentUrl,
          childCanonical,
          authorizedAgent.authorized_for,
          undefined, // property_ids: managed-network children authorize via tags, not IDs
        );
        // Catalog projection (#4841) — partner sync endpoints read
        // catalog_agent_authorizations, not the legacy edge table.
        // Without this row they miss the manager-asserted child.
        await this.publisherDb.recordCatalogFanoutAuthorization({
          agentUrl,
          childDomain: childCanonical,
          authorizedFor: authorizedAgent.authorized_for,
        });
      } catch (err) {
        // Per-child failures must not abort the rest of the fan-out —
        // partial progress beats silent total failure on a 6,800-domain
        // network. Logged so a poisoned row doesn't get lost.
        log.warn(
          { managerDomain, childDomain: childCanonical, agentUrl, err: err instanceof Error ? err.message : err },
          'publisher_properties fan-out: per-child write failed',
        );
      }
    }

    // Register the declaring agent as a sales_candidate so the next periodic
    // crawl probes it via list_authorized_properties. Only takes effect when
    // the agent has no confirmed type yet — upsertSalesCandidate will not
    // downgrade a row already classified as 'sales', 'creative', etc.
    if (childDomains.size > 0) {
      try {
        await this.federatedIndex.upsertSalesCandidate(agentUrl, managerCanonical);
      } catch (err) {
        log.warn(
          { agentUrl, managerDomain: managerCanonical, err: err instanceof Error ? err.message : err },
          'publisher_properties fan-out: sales_candidate registration failed',
        );
      }
    }
  }

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

  private async buildInventoryProfiles(
    options: { agentUrls?: string[]; deleteStale?: boolean } = {},
  ): Promise<Map<string, ProfileUpsertInput>> {
    const profileMap = new Map<string, ProfileUpsertInput>();
    if (!this.profilesDb) return profileMap;

    const agents = await this.federatedIndex.listAllAgents();
    const agentUrlFilter = options.agentUrls ? new Set(options.agentUrls) : null;
    const profiles: ProfileUpsertInput[] = [];
    const emptyAgentUrls: string[] = [];

    for (const agent of agents) {
      if (agentUrlFilter && !agentUrlFilter.has(agent.url)) continue;

      const domains = await this.federatedIndex.getDomainsForAgent(agent.url);
      if (domains.length === 0) {
        if (agentUrlFilter) emptyAgentUrls.push(agent.url);
        continue;
      }

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
      if (options.deleteStale !== false && !agentUrlFilter) {
        const currentUrls = profiles.map(p => p.agent_url);
        const staleDeleted = await this.profilesDb.deleteStaleProfiles(currentUrls);
        if (staleDeleted > 0) {
          log.info({ deleted: staleDeleted }, 'Stale inventory profiles cleaned up');
        }
      }
      log.info({ profileCount: profiles.length }, 'Inventory profiles updated');
    }
    if (agentUrlFilter && emptyAgentUrls.length > 0) {
      const deleted = await this.profilesDb.deleteProfiles(emptyAgentUrls);
      if (deleted > 0) {
        log.info({ deleted }, 'Empty inventory profiles cleaned up');
      }
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
        await this.recordFailedAdagentsFetch(domain, {
          statusCode: validation.status_code,
          responseBytes: validation.response_bytes,
          resolvedUrl: validation.resolved_url,
        });
        return;
      }

      await this.cacheAdagentsManifest(
        domain,
        validation.raw_data as AdagentsManifest,
        {
          statusCode: validation.status_code,
          responseBytes: validation.response_bytes,
          resolvedUrl: validation.resolved_url,
          discoveryMethod: validation.discovery_method,
          managerDomain: validation.manager_domain,
        },
      );

      const affectedAgentUrls = new Set<string>();
      const existingAuthorizations = await this.federatedIndex.getAuthorizationsForDomain(domain);
      for (const auth of existingAuthorizations) {
        if (auth.source !== 'adagents_json') continue;
        affectedAgentUrls.add(canonicalizeAgentUrl(auth.agent_url) ?? auth.agent_url);
      }

      // Record agents and properties
      for (const authorizedAgent of validation.raw_data.authorized_agents) {
        if (!authorizedAgent.url) continue;
        affectedAgentUrls.add(canonicalizeAgentUrl(authorizedAgent.url) ?? authorizedAgent.url);

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

        // Skip fan-out when the source publisher delegates via ads.txt
        // MANAGERDOMAIN — the manager's own crawl handles the fan-out.
        if (validation.discovery_method !== 'ads_txt_managerdomain') {
          await this.fanOutPublisherPropertiesAuthorizations(authorizedAgent, domain);
        }
      }
      await this.reconcileLegacyAdagentsAgents(domain, validation.raw_data as AdagentsManifest);

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
            collection_count: validation.raw_data.collections?.length ?? 0,
            discovery_method: validation.discovery_method,
            manager_domain: validation.manager_domain,
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
      await this.buildInventoryProfiles({
        agentUrls: [...affectedAgentUrls],
        deleteStale: false,
      });

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
    this.catalogCrawlIntervalId?.unref();

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

  // ── Manager Re-validation Queue ───────────────────────────────
  //
  // When a manager domain rotates its adagents.json, every publisher
  // delegating via ads.txt MANAGERDOMAIN needs to be re-validated so
  // their authorized_agents view stays in sync. Inline fan-out from
  // cacheAdagentsManifest() would saturate crawler concurrency at
  // managed-network scale (Raptive ≈ 6K publishers), so we persist
  // the work in manager_revalidation_queue (migration 471) and drain
  // it at a bounded rate per tick here.

  private managerRevalidationIntervalId: NodeJS.Timeout | null = null;
  private managerRevalidationProcessing = false;

  startPeriodicManagerRevalidation(intervalMinutes: number = 5) {
    this.managerRevalidationIntervalId = setInterval(() => {
      this.processManagerRevalidationQueue().catch((err) => {
        log.error({ err }, 'Manager revalidation tick failed');
      });
    }, intervalMinutes * 60 * 1000);
    this.managerRevalidationIntervalId?.unref();

    log.info({ intervalMinutes }, 'Periodic manager revalidation queue started');
  }

  async processManagerRevalidationQueue(): Promise<{ processed: number; succeeded: number; failed: number }> {
    if (this.managerRevalidationProcessing) {
      log.debug('Manager revalidation already in progress, skipping tick');
      return { processed: 0, succeeded: 0, failed: 0 };
    }

    this.managerRevalidationProcessing = true;
    // Bounded per-tick batch — caps concurrency budget regardless of
    // queue depth. Keep concurrent full domain crawls below the default
    // database pool size so background revalidation leaves headroom for
    // health checks and foreground requests.
    const BATCH_SIZE = 50;
    const CONCURRENCY = 4;

    try {
      const rows = await this.publisherDb.dequeueRevalidationBatch(BATCH_SIZE);
      if (rows.length === 0) {
        return { processed: 0, succeeded: 0, failed: 0 };
      }

      log.info({ count: rows.length }, 'Manager revalidation batch');

      const results = await this.processWithConcurrency(
        rows,
        CONCURRENCY,
        async (row) => {
          try {
            // Full single-domain crawl re-runs adagents validation
            // (which will hit the managerdomain fallback again) and
            // refreshes the publisher's catalog projection.
            await this.crawlSingleDomain(row.publisher_domain);
            return { row, ok: true as const };
          } catch (err) {
            return {
              row,
              ok: false as const,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        },
      );

      let succeeded = 0;
      let failed = 0;
      for (const result of results) {
        if (result.ok) {
          await this.publisherDb.markRevalidationSucceeded(result.row.publisher_domain);
          succeeded++;
        } else {
          await this.publisherDb.markRevalidationFailed(result.row.publisher_domain, result.error);
          failed++;
        }
      }

      log.info(
        { processed: rows.length, succeeded, failed },
        'Manager revalidation batch complete',
      );
      return { processed: rows.length, succeeded, failed };
    } finally {
      this.managerRevalidationProcessing = false;
    }
  }

  private async crawlSingleDomainForCatalog(domain: string): Promise<void> {
    const validation = await this.adAgentsManager.validateDomain(domain);
    if (!validation.valid || !validation.raw_data?.authorized_agents) {
      await this.recordFailedAdagentsFetch(domain, {
        statusCode: validation.status_code,
        responseBytes: validation.response_bytes,
        resolvedUrl: validation.resolved_url,
      });
      return;
    }

    await this.cacheAdagentsManifest(
      domain,
      validation.raw_data as AdagentsManifest,
      {
        statusCode: validation.status_code,
        responseBytes: validation.response_bytes,
        resolvedUrl: validation.resolved_url,
        discoveryMethod: validation.discovery_method,
        managerDomain: validation.manager_domain,
      },
    );

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

      // Skip fan-out when the source publisher delegates via ads.txt
      // MANAGERDOMAIN — the manager's own crawl handles the fan-out.
      if (validation.discovery_method !== 'ads_txt_managerdomain') {
        await this.fanOutPublisherPropertiesAuthorizations(authorizedAgent, domain);
      }
    }
    await this.reconcileLegacyAdagentsAgents(domain, validation.raw_data as AdagentsManifest);

    if (this.eventsDb) {
      await this.eventsDb.writeEvent({
        event_type: 'publisher.adagents_discovered',
        entity_type: 'publisher',
        entity_id: domain,
        payload: {
          publisher_domain: domain,
          agent_count: validation.raw_data.authorized_agents.length,
          property_count: validation.raw_data.properties?.length ?? 0,
          collection_count: validation.raw_data.collections?.length ?? 0,
          source: 'catalog_crawl',
          discovery_method: validation.discovery_method,
          manager_domain: validation.manager_domain,
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
