import type { Agent } from "./types.js";
import { PropertyCrawler, getPropertyIndex, type AgentInfo, type CrawlResult } from "@adcp/client";
import { FederatedIndexService } from "./federated-index.js";
import { AdAgentsManager } from "./adagents-manager.js";
import { MemberDatabase } from "./db/member-db.js";

export class CrawlerService {
  private crawler: PropertyCrawler;
  private crawling: boolean = false;
  private lastCrawl: Date | null = null;
  private lastResult: CrawlResult | null = null;
  private intervalId: NodeJS.Timeout | null = null;
  private federatedIndex: FederatedIndexService;
  private adAgentsManager: AdAgentsManager;
  private memberDb: MemberDatabase;

  constructor() {
    this.crawler = new PropertyCrawler({ logLevel: 'debug' });
    this.federatedIndex = new FederatedIndexService();
    this.adAgentsManager = new AdAgentsManager();
    this.memberDb = new MemberDatabase();
  }

  async crawlAllAgents(agents: Agent[]): Promise<CrawlResult> {
    if (this.crawling) {
      console.log("Crawl already in progress, skipping...");
      return this.lastResult || this.emptyResult();
    }

    this.crawling = true;
    console.log(`Starting crawl of ${agents.length} agents...`);

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

      console.log(
        `Crawl complete: ${result.totalProperties} properties from ${result.successfulAgents}/${agents.length} agents, checked ${result.totalPublisherDomains} publisher domains`
      );

      if (result.failedAgents > 0) {
        console.log(`Note: ${result.failedAgents} agent(s) failed (domains without adagents.json files)`);
      }

      if (result.errors.length > 0) {
        console.log(`\nCrawl errors by domain:`);
        const errorsByDomain = new Map<string, string[]>();
        for (const err of result.errors) {
          const domain = err.agent_url;
          if (!errorsByDomain.has(domain)) {
            errorsByDomain.set(domain, []);
          }
          errorsByDomain.get(domain)!.push(err.error);
        }
        for (const [domain, errors] of errorsByDomain) {
          console.log(`  ${domain}: ${errors.join('; ')}`);
        }
      }

      if (result.warnings && result.warnings.length > 0) {
        console.log(`\nCrawl warnings:`);
        for (const warning of result.warnings) {
          console.log(`  ${warning.domain}: ${warning.message}`);
        }
      }

      // Populate federated index from PropertyIndex and adagents.json files
      await this.populateFederatedIndex(agents);

      return result;
    } catch (error) {
      console.error("Crawl failed:", error);
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

    console.log(`Periodic crawl started (every ${intervalMinutes} minutes)`);
  }

  stopPeriodicCrawl() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log("Periodic crawl stopped");
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
   * Populate the federated index with discovered agents and publishers.
   * This is called after the PropertyCrawler finishes to persist data to PostgreSQL.
   */
  private async populateFederatedIndex(agents: Agent[]): Promise<void> {
    console.log("Populating federated index...");
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
    console.log(`Crawling ${registeredPublisherDomains.length} registered publishers: ${registeredPublisherDomains.join(', ') || '(none)'}`);

    for (const profile of profiles) {
      for (const pubConfig of profile.publishers || []) {
        if (!pubConfig.is_public || !pubConfig.domain) continue;
        if (processedDomains.has(pubConfig.domain)) continue;

        try {
          const validation = await this.adAgentsManager.validateDomain(pubConfig.domain);
          processedDomains.add(pubConfig.domain);

          if (validation.valid && validation.raw_data?.authorized_agents) {
            console.log(`  ${pubConfig.domain}: found ${validation.raw_data.authorized_agents.length} authorized agents`);
            for (const authorizedAgent of validation.raw_data.authorized_agents) {
              if (!authorizedAgent.url) continue;

              await this.federatedIndex.recordAgentFromAdagentsJson(
                authorizedAgent.url,
                pubConfig.domain,
                authorizedAgent.authorized_for,
                authorizedAgent.property_ids
              );
            }
          } else {
            console.log(`  ${pubConfig.domain}: no valid adagents.json`);
          }
        } catch (err) {
          console.error(`  ${pubConfig.domain}: failed -`, err instanceof Error ? err.message : err);
        }
      }
    }

    // 2. Record publishers discovered from each sales agent's list_authorized_properties
    console.log("Processing sales agent discovered publishers...");
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

          // If valid and not already processed, record agents from adagents.json
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
            }
          }
        } catch (err) {
          console.error(`Failed to process domain ${domain}:`, err);
        }
      }
    }

    // Log stats
    try {
      const stats = await this.federatedIndex.getStats();
      console.log(
        `Federated index populated: ${stats.discovered_agents} discovered agents, ` +
        `${stats.discovered_publishers} discovered publishers, ` +
        `${stats.authorizations} authorizations ` +
        `(${stats.authorizations_by_source.adagents_json} verified, ${stats.authorizations_by_source.agent_claim} claims)`
      );
    } catch {
      // Stats are optional
    }
  }

  /**
   * Get the federated index service (for API access)
   */
  getFederatedIndex(): FederatedIndexService {
    return this.federatedIndex;
  }
}
