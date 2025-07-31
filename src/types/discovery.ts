/**
 * AdCP Agent Discovery Protocol Types
 * 
 * Simple types for the .well-known/adcp discovery document
 * that maps agent types to their MCP endpoints.
 */

export type AgentType = 'sales' | 'curation' | 'signals';

/**
 * Discovery document - simple mapping of agent types to MCP endpoints
 */
export type DiscoveryDocument = {
  [K in AgentType]?: string;
};

/**
 * Result of a discovery attempt
 */
export interface DiscoverySuccess {
  success: true;
  endpoints: DiscoveryDocument;
}

export interface DiscoveryError {
  success: false;
  error: string;
}

export type DiscoveryResult = DiscoverySuccess | DiscoveryError;

/**
 * Type guard for discovery documents
 */
export function isDiscoveryDocument(value: unknown): value is DiscoveryDocument {
  if (typeof value !== 'object' || value === null) return false;
  
  const validTypes: AgentType[] = ['sales', 'curation', 'signals'];
  
  return Object.entries(value).every(([key, val]) => 
    validTypes.includes(key as AgentType) && typeof val === 'string'
  );
}

/**
 * Type guard for error results
 */
export function isDiscoveryError(result: DiscoveryResult): result is DiscoveryError {
  return !result.success;
}