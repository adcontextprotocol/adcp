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

export interface AdAgentsJson {
  $schema?: string;
  authorized_agents: Array<{
    url: string;
    authorized_for?: string;
  }>;
  last_updated?: string;
}

export interface ValidationResult {
  authorized: boolean;
  domain: string;
  agent_url: string;
  checked_at: string;
  source?: string;
  error?: string;
}
