/**
 * AdCP Discovery Client
 * 
 * Simple client for discovering AdCP agent endpoints
 * using the .well-known/adcp.json endpoint.
 */

import { isDiscoveryDocument, type DiscoveryDocument, type DiscoveryResult } from '../types/discovery';

/**
 * Discovers AdCP agents at a given domain
 */
export async function discoverAgents(
  domain: string,
  options: RequestInit = {}
): Promise<DiscoveryResult> {
  // Ensure domain has protocol
  const url = domain.startsWith('http') 
    ? `${domain}/.well-known/adcp.json`
    : `https://${domain}/.well-known/adcp.json`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        ...options.headers,
      },
      ...options,
    });

    if (!response.ok) {
      return {
        success: false,
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    const data = await response.json();
    
    if (!isDiscoveryDocument(data)) {
      return {
        success: false,
        error: 'Invalid discovery document format',
      };
    }

    return {
      success: true,
      endpoints: data,
    };

  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Example usage
 */
export async function example() {
  // Discover Scope3's agents
  const result = await discoverAgents('scope3.com');
  
  if (result.success === true) {
    if (result.endpoints.signals) {
      console.log(`Scope3 signals agent: ${result.endpoints.signals}`);
      // Now connect to the MCP endpoint directly
    }
  } else {
    console.error(`Discovery failed: ${result.error}`);
  }
  
  // Discover multiple domains
  const domains = ['scope3.com', 'publisher.example.com'];
  
  for (const domain of domains) {
    const result = await discoverAgents(domain);
    if (result.success) {
      console.log(`${domain} agents:`, result.endpoints);
    }
  }
}