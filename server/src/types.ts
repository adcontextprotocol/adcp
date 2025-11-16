export type AgentType = "creative" | "signals" | "sales";

export interface FormatInfo {
  name: string;
  dimensions?: string;
  aspect_ratio?: string;
  type?: string;
  description?: string;
}

export interface Agent {
  $schema?: string;
  name: string;
  url: string;
  type: AgentType;
  protocol?: "mcp" | "a2a";
  description: string;
  mcp_endpoint: string;
  contact: {
    name: string;
    email: string;
    website: string;
  };
  added_date: string;
}

export interface AgentHealth {
  online: boolean;
  checked_at: string;
  response_time_ms?: number;
  tools_count?: number;
  resources_count?: number;
  error?: string;
}

export interface AgentStats {
  property_count?: number;
  publisher_count?: number;
  publishers?: string[];
  creative_formats?: number;
}

export interface AgentCapabilities {
  tools_count: number;
  tools?: Array<{
    name: string;
    description: string;
    input_schema: any;
    verified_at: string;
  }>;
  standard_operations?: {
    can_search_inventory: boolean;
    can_get_availability: boolean;
    can_reserve_inventory: boolean;
    can_get_pricing: boolean;
    can_create_order: boolean;
    can_list_properties: boolean;
  };
  creative_capabilities?: {
    formats_supported: string[];
    can_generate: boolean;
    can_validate: boolean;
    can_preview: boolean;
  };
  signals_capabilities?: {
    audience_types: string[];
    can_match: boolean;
    can_activate: boolean;
    can_get_signals: boolean;
  };
}

export interface AgentWithStats extends Agent {
  health?: AgentHealth;
  stats?: AgentStats;
  capabilities?: AgentCapabilities;
  properties?: any[];
  propertiesError?: string;
}

// AdAgents.json Types - Based on AdCP v2.2.0 specification
export interface AuthorizedAgent {
  url: string;
  authorized_for: string;
  property_ids?: string[];
}

export interface AdAgentsJson {
  $schema?: string;
  authorized_agents: AuthorizedAgent[];
  properties?: Property[];
  last_updated?: string;
}

export interface Property {
  property_id?: string;
  property_type: PropertyType;
  name: string;
  identifiers: PropertyIdentifier[];
  tags?: string[];
  publisher_domain?: string;
}

export interface PropertyIdentifier {
  type: PropertyIdentifierType;
  value: string;
  include_subdomains?: boolean;
}

export type PropertyType = 'website' | 'mobile_app' | 'ctv_app' | 'dooh' | 'podcast' | 'radio' | 'streaming_audio';

export type PropertyIdentifierType =
  | 'domain'
  | 'subdomain'
  | 'ios_bundle'
  | 'android_package'
  | 'apple_app_store_id'
  | 'google_play_id'
  | 'amazon_app_store_id'
  | 'roku_channel_id'
  | 'samsung_app_id'
  | 'lg_channel_id'
  | 'vizio_app_id'
  | 'fire_tv_app_id'
  | 'dooh_venue_id'
  | 'podcast_rss_feed'
  | 'spotify_show_id'
  | 'apple_podcast_id'
  | 'iab_tech_lab_domain_id'
  | 'custom';

// Validation Types
export interface AdAgentsValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  domain: string;
  url: string;
  status_code?: number;
  raw_data?: any;
}

export interface ValidationError {
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface ValidationWarning {
  field: string;
  message: string;
  suggestion?: string;
}

export interface AgentCardValidationResult {
  agent_url: string;
  valid: boolean;
  status_code?: number;
  card_data?: any;
  card_endpoint?: string;
  errors: string[];
  response_time_ms?: number;
}

// API Request/Response Types for AdAgents Management
export interface ValidateAdAgentsRequest {
  domain: string;
}

export interface ValidateAdAgentsResponse {
  domain: string;
  found: boolean;
  validation: AdAgentsValidationResult;
  agent_cards?: AgentCardValidationResult[];
}

export interface CreateAdAgentsRequest {
  authorized_agents: AuthorizedAgent[];
  include_schema?: boolean;
  include_timestamp?: boolean;
}

export interface CreateAdAgentsResponse {
  success: boolean;
  adagents_json: string;
  validation: AdAgentsValidationResult;
}

// Legacy validation type (kept for backward compatibility)
export interface ValidationResult {
  authorized: boolean;
  domain: string;
  agent_url: string;
  checked_at: string;
  source?: string;
  error?: string;
}
