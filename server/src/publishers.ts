import type { Agent } from "./types.js";

export interface PublisherIssue {
  severity: "error" | "warning";
  message: string;
  fix: string;
}

export interface PublisherStatus {
  domain: string;
  deployment_status: "deployed" | "schema_outdated" | "missing" | "error";
  adagents_file_url: string;
  last_checked: string;
  issues: PublisherIssue[];
  authorized_agents: string[];
  expected_agents: string[]; // Based on agent claims
  coverage_percentage: number;
  raw_content?: any;
}

export class PublisherTracker {
  private cache: Map<string, PublisherStatus> = new Map();
  private readonly CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

  async checkPublisher(domain: string, expectedAgents: string[]): Promise<PublisherStatus> {
    const cached = this.cache.get(domain);
    if (cached && Date.now() - new Date(cached.last_checked).getTime() < this.CACHE_TTL_MS) {
      return cached;
    }

    const url = `https://${domain}/.well-known/adagents.json`;
    const status: PublisherStatus = {
      domain,
      deployment_status: "missing",
      adagents_file_url: url,
      last_checked: new Date().toISOString(),
      issues: [],
      authorized_agents: [],
      expected_agents: expectedAgents,
      coverage_percentage: 0,
    };

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        status.deployment_status = "missing";
        status.issues.push({
          severity: "error",
          message: `File not found (HTTP ${response.status})`,
          fix: `Deploy a valid adagents.json file to ${url}. See: https://adcontextprotocol.org/docs/authorization`,
        });
        this.cache.set(domain, status);
        return status;
      }

      const contentType = response.headers.get("content-type");
      if (!contentType?.includes("application/json")) {
        status.deployment_status = "error";
        status.issues.push({
          severity: "error",
          message: `Wrong content-type: ${contentType}. Expected application/json`,
          fix: "Configure your web server to serve .json files with content-type: application/json",
        });
        this.cache.set(domain, status);
        return status;
      }

      const content: any = await response.json();
      status.raw_content = content;

      // Validate schema
      const validation = this.validateSchema(content);
      status.issues.push(...validation.issues);

      if (validation.isValid) {
        status.deployment_status = "deployed";
      } else if (validation.hasOldSchema) {
        status.deployment_status = "schema_outdated";
      } else {
        status.deployment_status = "error";
      }

      // Extract authorized agents
      if (content.authorized_agents) {
        status.authorized_agents = content.authorized_agents.map((a: any) => a.url || a);
      }

      // Calculate coverage
      if (expectedAgents.length > 0) {
        const matchCount = expectedAgents.filter((expected) =>
          status.authorized_agents.includes(expected)
        ).length;
        status.coverage_percentage = Math.round((matchCount / expectedAgents.length) * 100);
      }

      // Check for missing expected agents
      const missingAgents = expectedAgents.filter(
        (expected) => !status.authorized_agents.includes(expected)
      );
      if (missingAgents.length > 0) {
        status.issues.push({
          severity: "warning",
          message: `Missing ${missingAgents.length} expected agent(s): ${missingAgents.join(", ")}`,
          fix: "Add these agents to the authorized_agents array if they should represent this publisher",
        });
      }

      this.cache.set(domain, status);
      return status;
    } catch (error: any) {
      status.deployment_status = "error";
      status.issues.push({
        severity: "error",
        message: `Failed to fetch: ${error.message}`,
        fix: "Ensure the file is accessible over HTTPS and CORS is enabled",
      });
      this.cache.set(domain, status);
      return status;
    }
  }

  private validateSchema(content: any): { isValid: boolean; hasOldSchema: boolean; issues: PublisherIssue[] } {
    const issues: PublisherIssue[] = [];
    let isValid = true;
    let hasOldSchema = false;

    // Check for required fields
    if (!content.$schema) {
      issues.push({
        severity: "warning",
        message: "Missing $schema field",
        fix: 'Add "$schema": "https://adcontextprotocol.org/schemas/v1/adagents.json"',
      });
    }

    if (!content.authorized_agents || !Array.isArray(content.authorized_agents)) {
      issues.push({
        severity: "error",
        message: "Missing or invalid authorized_agents array",
        fix: 'Add "authorized_agents": [{"url": "https://agent.example.com", "authorized_for": "Description"}]',
      });
      isValid = false;
    } else {
      // Check if agents have proper structure
      for (const agent of content.authorized_agents) {
        if (typeof agent === "string") {
          hasOldSchema = true;
          issues.push({
            severity: "warning",
            message: "Using old string format for authorized_agents",
            fix: 'Update to object format: {"url": "https://....", "authorized_for": "Description"}',
          });
          break;
        }
        if (!agent.url) {
          issues.push({
            severity: "error",
            message: "Agent missing required 'url' field",
            fix: 'Each agent must have: {"url": "https://agent.example.com", "authorized_for": "Description"}',
          });
          isValid = false;
        }
      }
    }

    // Check for properties array (new protocol)
    if (!content.properties) {
      hasOldSchema = true;
      issues.push({
        severity: "warning",
        message: "Missing 'properties' array (new AdCP v2 protocol)",
        fix: `Add "properties": [{"type": "domain", "identifier": "${content.domain || 'example.com'}", "tags": ["tag1"], "publisher_domains": ["${content.domain || 'example.com'}"]}]`,
      });
    } else if (!Array.isArray(content.properties)) {
      issues.push({
        severity: "error",
        message: "'properties' must be an array",
        fix: 'Change properties to an array: "properties": [...]',
      });
      isValid = false;
    }

    if (!content.last_updated) {
      issues.push({
        severity: "warning",
        message: "Missing 'last_updated' field",
        fix: 'Add "last_updated": "2025-01-22T12:00:00Z" with current ISO 8601 timestamp',
      });
    }

    return { isValid: isValid && !hasOldSchema, hasOldSchema, issues };
  }

  async trackPublishers(agents: Agent[]): Promise<Map<string, PublisherStatus>> {
    const publisherMap = new Map<string, string[]>();

    // Build map of publisher domain -> expected agents
    for (const agent of agents) {
      if (agent.type !== "sales") continue;

      // Extract domain from agent URL
      const domain = this.extractDomain(agent.url);
      if (!domain) continue;

      if (!publisherMap.has(domain)) {
        publisherMap.set(domain, []);
      }
      publisherMap.get(domain)!.push(agent.url);
    }

    const statuses = new Map<string, PublisherStatus>();

    await Promise.all(
      Array.from(publisherMap.entries()).map(async ([domain, expectedAgents]) => {
        const status = await this.checkPublisher(domain, expectedAgents);
        statuses.set(domain, status);
      })
    );

    return statuses;
  }

  private extractDomain(url: string): string | null {
    try {
      const parsed = new URL(url);
      return parsed.hostname;
    } catch {
      return null;
    }
  }

  getPublisherStatus(domain: string): PublisherStatus | undefined {
    return this.cache.get(domain);
  }

  getAllPublishers(): PublisherStatus[] {
    return Array.from(this.cache.values());
  }

  getDeploymentStats(): {
    total: number;
    deployed: number;
    schema_outdated: number;
    missing: number;
    error: number;
  } {
    const statuses = this.getAllPublishers();
    return {
      total: statuses.length,
      deployed: statuses.filter((s) => s.deployment_status === "deployed").length,
      schema_outdated: statuses.filter((s) => s.deployment_status === "schema_outdated").length,
      missing: statuses.filter((s) => s.deployment_status === "missing").length,
      error: statuses.filter((s) => s.deployment_status === "error").length,
    };
  }
}
