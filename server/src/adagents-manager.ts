import axios from 'axios';

export interface ValidationError {
  field: string;
  message: string;
  severity: 'error';
}

export interface ValidationWarning {
  field: string;
  message: string;
  suggestion?: string;
}

export interface AdAgentsValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  domain: string;
  url: string;
  status_code?: number;
  raw_data?: any;
}

export interface AuthorizedAgent {
  url: string;
  authorized_for: string;
  property_ids?: string[];
}

export interface AgentCardValidationResult {
  agent_url: string;
  valid: boolean;
  errors: string[];
  status_code?: number;
  response_time_ms?: number;
  card_data?: any;
  card_endpoint?: string;
  oauth_required?: boolean;
}

export interface AdAgentsJsonInline {
  $schema?: string;
  authorized_agents: AuthorizedAgent[];
  properties?: any[];
  tags?: Record<string, { name: string; description: string }>;
  contact?: {
    name: string;
    email?: string;
    domain?: string;
    seller_id?: string;
    tag_id?: string;
  };
  last_updated?: string;
}

export interface AdAgentsJsonReference {
  $schema?: string;
  authoritative_location: string;
  last_updated?: string;
}

export type AdAgentsJson = AdAgentsJsonInline | AdAgentsJsonReference;

export class AdAgentsManager {
  
  /**
   * Validates a domain's adagents.json file
   */
  async validateDomain(domain: string): Promise<AdAgentsValidationResult> {
    // Normalize domain - remove protocol and trailing slash
    const normalizedDomain = domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const url = `https://${normalizedDomain}/.well-known/adagents.json`;
    
    const result: AdAgentsValidationResult = {
      valid: false,
      errors: [],
      warnings: [],
      domain: normalizedDomain,
      url
    };

    try {
      // Fetch the adagents.json file
      const response = await axios.get(url, {
        timeout: 10000,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'AdCP-Testing-Framework/1.0'
        },
        validateStatus: () => true // Don't throw on non-2xx status codes
      });

      result.status_code = response.status;

      // Check HTTP status
      if (response.status !== 200) {
        const statusMessage = response.status === 404
          ? `File not found at ${url}`
          : `HTTP ${response.status} error fetching ${url}`;
        result.errors.push({
          field: 'http_status',
          message: statusMessage,
          severity: 'error'
        });
        // Don't include raw HTML error pages - they're not useful for validation
        return result;
      }

      // Only include raw data for successful responses
      result.raw_data = response.data;

      // Parse and validate JSON structure
      let adagentsData = response.data;

      // Check if this is a URL reference
      if (this.isUrlReference(adagentsData)) {
        // Follow the reference to get the authoritative file
        const authoritativeData = await this.fetchAuthoritativeFile(
          adagentsData.authoritative_location,
          result
        );

        if (authoritativeData) {
          adagentsData = authoritativeData;
        } else {
          // Error already added to result by fetchAuthoritativeFile
          return result;
        }
      }

      this.validateStructure(adagentsData, result);
      this.validateContent(adagentsData, result);

      // If no errors, mark as valid
      result.valid = result.errors.length === 0;

    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
          result.errors.push({
            field: 'connection',
            message: `Cannot connect to ${normalizedDomain}`,
            severity: 'error'
          });
        } else if (error.code === 'ECONNABORTED') {
          result.errors.push({
            field: 'timeout',
            message: 'Request timed out after 10 seconds',
            severity: 'error'
          });
        } else {
          result.errors.push({
            field: 'network',
            message: error.message,
            severity: 'error'
          });
        }
      } else {
        result.errors.push({
          field: 'unknown',
          message: 'Unknown error occurred',
          severity: 'error'
        });
      }
    }

    return result;
  }

  /**
   * Type guard to check if data is a URL reference
   */
  private isUrlReference(data: any): data is AdAgentsJsonReference {
    return (
      typeof data === 'object' &&
      data !== null &&
      'authoritative_location' in data &&
      typeof data.authoritative_location === 'string'
    );
  }

  /**
   * Fetches the authoritative adagents.json file from a URL reference
   */
  private async fetchAuthoritativeFile(
    url: string,
    result: AdAgentsValidationResult
  ): Promise<AdAgentsJsonInline | null> {
    try {
      // Validate URL format
      try {
        const parsedUrl = new URL(url);
        if (!parsedUrl.protocol.startsWith('https:')) {
          result.errors.push({
            field: 'authoritative_location',
            message: 'Authoritative location must use HTTPS',
            severity: 'error'
          });
          return null;
        }
      } catch {
        result.errors.push({
          field: 'authoritative_location',
          message: 'authoritative_location must be a valid URL',
          severity: 'error'
        });
        return null;
      }

      // Fetch the authoritative file
      const response = await axios.get(url, {
        timeout: 10000,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'AdCP-Testing-Framework/1.0'
        },
        validateStatus: () => true
      });

      if (response.status !== 200) {
        const statusMessage = response.status === 404
          ? `File not found at ${url}`
          : `HTTP ${response.status} error fetching ${url}`;
        result.errors.push({
          field: 'authoritative_location',
          message: statusMessage,
          severity: 'error'
        });
        return null;
      }

      const authData = response.data;

      // Ensure the authoritative file is not also a reference (prevent infinite loops)
      if (this.isUrlReference(authData)) {
        result.errors.push({
          field: 'authoritative_location',
          message: 'Authoritative file cannot be another URL reference (nested references not allowed)',
          severity: 'error'
        });
        return null;
      }

      return authData;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        result.errors.push({
          field: 'authoritative_location',
          message: `Failed to fetch authoritative file: ${error.message}`,
          severity: 'error'
        });
      } else {
        result.errors.push({
          field: 'authoritative_location',
          message: 'Unknown error fetching authoritative file',
          severity: 'error'
        });
      }
      return null;
    }
  }

  /**
   * Validates the structure of adagents.json
   */
  private validateStructure(data: any, result: AdAgentsValidationResult): void {
    if (typeof data !== 'object' || data === null) {
      result.errors.push({
        field: 'root',
        message: 'adagents.json must be a valid JSON object',
        severity: 'error'
      });
      return;
    }

    // Check required fields
    if (!data.authorized_agents) {
      result.errors.push({
        field: 'authorized_agents',
        message: 'authorized_agents field is required',
        severity: 'error'
      });
      return;
    }

    if (!Array.isArray(data.authorized_agents)) {
      result.errors.push({
        field: 'authorized_agents',
        message: 'authorized_agents must be an array',
        severity: 'error'
      });
      return;
    }

    // Validate each agent
    data.authorized_agents.forEach((agent: any, index: number) => {
      this.validateAgent(agent, index, result);
    });

    // Check optional fields
    if (data.$schema && typeof data.$schema !== 'string') {
      result.errors.push({
        field: '$schema',
        message: '$schema must be a string',
        severity: 'error'
      });
    }

    if (data.last_updated) {
      if (typeof data.last_updated !== 'string') {
        result.errors.push({
          field: 'last_updated',
          message: 'last_updated must be an ISO 8601 timestamp string',
          severity: 'error'
        });
      } else {
        // Validate ISO 8601 format
        const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
        if (!isoRegex.test(data.last_updated)) {
          result.warnings.push({
            field: 'last_updated',
            message: 'last_updated should be in ISO 8601 format (YYYY-MM-DDTHH:mm:ssZ)',
            suggestion: 'Use new Date().toISOString() format'
          });
        }
      }
    }

    // Recommendations
    if (!data.$schema) {
      result.warnings.push({
        field: '$schema',
        message: 'Consider adding $schema field for validation',
        suggestion: 'Add "$schema": "https://adcontextprotocol.org/schemas/v2/adagents.json"'
      });
    }

    if (!data.last_updated) {
      result.warnings.push({
        field: 'last_updated',
        message: 'Consider adding last_updated timestamp',
        suggestion: 'Add "last_updated": "' + new Date().toISOString() + '"'
      });
    }
  }

  /**
   * Validates an individual agent entry
   */
  private validateAgent(agent: any, index: number, result: AdAgentsValidationResult): void {
    const prefix = `authorized_agents[${index}]`;

    if (typeof agent !== 'object' || agent === null) {
      result.errors.push({
        field: prefix,
        message: 'Each agent must be an object',
        severity: 'error'
      });
      return;
    }

    // Required fields
    if (!agent.url) {
      result.errors.push({
        field: `${prefix}.url`,
        message: 'url field is required',
        severity: 'error'
      });
    } else if (typeof agent.url !== 'string') {
      result.errors.push({
        field: `${prefix}.url`,
        message: 'url must be a string',
        severity: 'error'
      });
    } else {
      // Validate URL format
      try {
        new URL(agent.url);
        
        // Check HTTPS requirement
        if (!agent.url.startsWith('https://')) {
          result.errors.push({
            field: `${prefix}.url`,
            message: 'Agent URL must use HTTPS',
            severity: 'error'
          });
        }
      } catch {
        result.errors.push({
          field: `${prefix}.url`,
          message: 'url must be a valid URL',
          severity: 'error'
        });
      }
    }

    if (!agent.authorized_for) {
      result.errors.push({
        field: `${prefix}.authorized_for`,
        message: 'authorized_for field is required',
        severity: 'error'
      });
    } else if (typeof agent.authorized_for !== 'string') {
      result.errors.push({
        field: `${prefix}.authorized_for`,
        message: 'authorized_for must be a string',
        severity: 'error'
      });
    } else {
      // Validate length constraints
      if (agent.authorized_for.length < 1) {
        result.errors.push({
          field: `${prefix}.authorized_for`,
          message: 'authorized_for cannot be empty',
          severity: 'error'
        });
      } else if (agent.authorized_for.length > 500) {
        result.errors.push({
          field: `${prefix}.authorized_for`,
          message: 'authorized_for must be 500 characters or less',
          severity: 'error'
        });
      }
    }

    // Optional property_ids must be an array
    if (agent.property_ids !== undefined && !Array.isArray(agent.property_ids)) {
      result.errors.push({
        field: `${prefix}.property_ids`,
        message: 'property_ids must be an array',
        severity: 'error'
      });
    }
  }

  /**
   * Validates business logic and content
   */
  private validateContent(data: any, result: AdAgentsValidationResult): void {
    if (!data.authorized_agents || !Array.isArray(data.authorized_agents)) {
      return; // Structure validation should have caught this
    }

    // Check for duplicate agent URLs
    const seenUrls = new Set<string>();
    data.authorized_agents.forEach((agent: any, index: number) => {
      if (agent.url && typeof agent.url === 'string') {
        if (seenUrls.has(agent.url)) {
          result.warnings.push({
            field: `authorized_agents[${index}].url`,
            message: 'Duplicate agent URL found',
            suggestion: 'Remove duplicate entries or consolidate authorization scopes'
          });
        }
        seenUrls.add(agent.url);
      }
    });

    // Check if no agents are defined
    if (data.authorized_agents.length === 0) {
      result.warnings.push({
        field: 'authorized_agents',
        message: 'No authorized agents defined',
        suggestion: 'Add at least one authorized agent'
      });
    }
  }

  /**
   * Validates agent cards for all agents in adagents.json
   */
  async validateAgentCards(agents: AuthorizedAgent[]): Promise<AgentCardValidationResult[]> {
    const results: AgentCardValidationResult[] = [];
    
    // Validate each agent in parallel
    const validationPromises = agents.map(agent => this.validateSingleAgentCard(agent.url));
    const validationResults = await Promise.allSettled(validationPromises);
    
    validationResults.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        results.push(result.value);
      } else {
        results.push({
          agent_url: agents[index].url,
          valid: false,
          errors: [`Validation failed: ${result.reason}`]
        });
      }
    });

    return results;
  }

  /**
   * Validates a single agent's card endpoint (supports both A2A and MCP protocols)
   */
  private async validateSingleAgentCard(agentUrl: string): Promise<AgentCardValidationResult> {
    const result: AgentCardValidationResult = {
      agent_url: agentUrl,
      valid: false,
      errors: []
    };

    const startTime = Date.now();

    // Try A2A first (agent-card.json endpoints)
    const a2aResult = await this.tryA2AValidation(agentUrl, startTime);
    if (a2aResult.valid) {
      return a2aResult;
    }

    // If A2A failed, try MCP protocol
    const mcpResult = await this.tryMCPValidation(agentUrl, startTime);
    if (mcpResult.valid) {
      return mcpResult;
    }

    // Both failed - return combined errors
    result.response_time_ms = Date.now() - startTime;
    result.errors = [
      'Agent not reachable via A2A or MCP protocols',
      ...a2aResult.errors.map(e => `A2A: ${e}`),
      ...mcpResult.errors.map(e => `MCP: ${e}`)
    ];

    return result;
  }

  /**
   * Try A2A protocol validation (agent-card.json)
   */
  private async tryA2AValidation(agentUrl: string, startTime: number): Promise<AgentCardValidationResult> {
    const result: AgentCardValidationResult = {
      agent_url: agentUrl,
      valid: false,
      errors: []
    };

    // Try to fetch agent card (A2A standard and root fallback)
    const cardEndpoints = [
      `${agentUrl}/.well-known/agent-card.json`, // A2A protocol standard
      agentUrl // Sometimes the main URL returns the card
    ];

    for (const endpoint of cardEndpoints) {
      try {
        const response = await axios.get(endpoint, {
          timeout: 3000, // Keep short for responsive UX
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'AdCP-Testing-Framework/1.0'
          },
          validateStatus: () => true
        });

        result.response_time_ms = Date.now() - startTime;
        result.status_code = response.status;

        if (response.status === 200) {
          result.card_data = response.data;
          result.card_endpoint = endpoint;

          // Check content-type header
          const contentType = response.headers['content-type'] || '';
          const isJsonContentType = contentType.includes('application/json');

          // Basic validation of card structure
          if (typeof response.data === 'object' && response.data !== null) {
            if (!isJsonContentType) {
              result.errors.push(`Endpoint returned JSON data but with content-type: ${contentType}. Should be application/json`);
              result.valid = false;
            } else {
              result.valid = true;
            }
          } else {
            if (contentType.includes('text/html')) {
              result.errors.push('Agent card endpoint returned HTML instead of JSON. This appears to be a website, not an agent card endpoint.');
            } else {
              result.errors.push(`Agent card is not a valid JSON object (content-type: ${contentType})`);
            }
          }
          return result;
        }
      } catch (endpointError) {
        // Try next endpoint
        continue;
      }
    }

    result.errors.push('No agent card found at /.well-known/agent-card.json or root URL');
    return result;
  }

  /**
   * Try MCP protocol validation (streamable HTTP)
   */
  private async tryMCPValidation(agentUrl: string, startTime: number): Promise<AgentCardValidationResult> {
    const result: AgentCardValidationResult = {
      agent_url: agentUrl,
      valid: false,
      errors: []
    };

    const MCP_TIMEOUT_MS = 5000; // Match timeout used in health.ts

    // First, do a preflight HTTP check to detect 401 errors
    // The @adcp/client library wraps 401s in generic errors, so we need to detect them directly
    try {
      const preflightResponse = await axios.post(agentUrl,
        { jsonrpc: '2.0', method: 'initialize', params: {}, id: 1 },
        {
          timeout: 3000,
          headers: { 'Content-Type': 'application/json' },
          validateStatus: () => true // Accept all status codes
        }
      );

      if (preflightResponse.status === 401) {
        result.response_time_ms = Date.now() - startTime;
        result.oauth_required = true;
        result.valid = true; // Agent is reachable, just needs auth
        result.status_code = 401;
        result.card_endpoint = agentUrl;
        result.card_data = {
          protocol: 'mcp',
          requires_auth: true,
        };
        return result;
      }
    } catch (preflightError) {
      // Preflight failed (network error, DNS issue, etc.) - continue to try full MCP connection
      // This is expected for agents that don't respond to raw HTTP POST
    }

    try {
      const { AdCPClient, is401Error } = await import('@adcp/client');
      const multiClient = new AdCPClient([{
        id: 'health-check',
        name: 'Health Checker',
        agent_uri: agentUrl,
        protocol: 'mcp',
      }]);
      const client = multiClient.agent('health-check');

      // Add timeout to prevent hanging on slow/unresponsive agents
      const agentInfo = await Promise.race([
        client.getAgentInfo(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('MCP connection timed out')), MCP_TIMEOUT_MS)
        ),
      ]);

      result.response_time_ms = Date.now() - startTime;
      result.valid = true;
      result.card_endpoint = agentUrl;
      result.card_data = {
        name: agentInfo.name,
        protocol: 'mcp',
        tools: agentInfo.tools?.map(t => t.name) || [],
        tools_count: agentInfo.tools?.length || 0,
      };
    } catch (error) {
      result.response_time_ms = Date.now() - startTime;

      // Check if this is an OAuth/authentication error - agent is reachable but requires auth
      // Note: We use is401Error() rather than instanceof check because dynamic imports
      // create separate module instances, making instanceof unreliable
      const { is401Error } = await import('@adcp/client');
      if (is401Error(error)) {
        result.oauth_required = true;
        result.valid = true; // Agent is reachable, just needs auth
        result.card_endpoint = agentUrl;
        result.card_data = {
          protocol: 'mcp',
          requires_auth: true,
        };
        return result;
      }

      const message = error instanceof Error ? error.message : 'Unknown error';
      result.errors.push(`MCP connection failed: ${message}`);
    }

    return result;
  }

  /**
   * Creates a properly formatted adagents.json file
   */
  createAdAgentsJson(
    agents: AuthorizedAgent[],
    includeSchema: boolean = true,
    includeTimestamp: boolean = true,
    properties?: any[]
  ): string {
    const adagents: AdAgentsJson = {
      authorized_agents: agents
    };

    if (properties && properties.length > 0) {
      adagents.properties = properties;
    }

    if (includeSchema) {
      adagents.$schema = 'https://adcontextprotocol.org/schemas/v2/adagents.json';
    }

    if (includeTimestamp) {
      adagents.last_updated = new Date().toISOString();
    }

    return JSON.stringify(adagents, null, 2);
  }

  /**
   * Validates a proposed adagents.json structure before creation
   */
  validateProposed(agents: AuthorizedAgent[]): AdAgentsValidationResult {
    const mockData = {
      $schema: 'https://adcontextprotocol.org/schemas/v2/adagents.json',
      authorized_agents: agents,
      last_updated: new Date().toISOString()
    };

    const result: AdAgentsValidationResult = {
      valid: false,
      errors: [],
      warnings: [],
      domain: 'proposed',
      url: 'proposed'
    };

    this.validateStructure(mockData, result);
    this.validateContent(mockData, result);

    result.valid = result.errors.length === 0;
    return result;
  }
}