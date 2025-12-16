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

// Billing & Company Types

export type SubscriptionStatus =
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'trialing'
  | 'incomplete'
  | 'incomplete_expired'
  | 'unpaid';

export type SubscriptionTier = 'basic' | 'professional' | 'enterprise';

export type CompanyUserRole = 'owner' | 'admin' | 'member';

export interface Company {
  id: string;
  slug: string;
  name: string;
  domain?: string;
  stripe_customer_id?: string;
  stripe_subscription_id?: string;
  subscription_status?: SubscriptionStatus;
  subscription_tier?: SubscriptionTier;
  agreement_signed_at?: Date;
  agreement_version?: string;
  created_at: Date;
  updated_at: Date;
}

export interface CompanyUser {
  id: string;
  company_id: string;
  user_id: string;
  email: string;
  role: CompanyUserRole;
  invited_by?: string;
  joined_at: Date;
}

export interface Agreement {
  id: string;
  version: string;
  text: string;
  effective_date: Date;
  created_at: Date;
}

export interface WorkOSUser {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  emailVerified: boolean;
  createdAt: string;
  updatedAt: string;
}

// Member Profile Types

export type MemberOffering =
  | 'buyer_agent'
  | 'sales_agent'
  | 'creative_agent'
  | 'signals_agent'
  | 'consulting'
  | 'other';

/**
 * Agent configuration stored in member profiles
 * Each agent has a URL and visibility settings
 */
export interface AgentConfig {
  url: string;
  is_public: boolean;
  // Cached info from discovery (optional, refreshed periodically)
  name?: string;
  type?: 'sales' | 'creative' | 'signals' | 'buyer' | 'unknown';
}

export interface MemberProfile {
  id: string;
  workos_organization_id: string;
  display_name: string;
  slug: string;
  tagline?: string;
  description?: string;
  logo_url?: string;
  logo_light_url?: string;
  logo_dark_url?: string;
  brand_color?: string;
  contact_email?: string;
  contact_website?: string;
  contact_phone?: string;
  linkedin_url?: string;
  twitter_url?: string;
  offerings: MemberOffering[];
  agents: AgentConfig[];
  headquarters?: string; // City, Country (e.g., "Singapore", "New York, USA")
  markets: string[]; // Regions/markets served (e.g., ["APAC", "North America"])
  metadata: Record<string, unknown>;
  tags: string[];
  is_public: boolean;
  show_in_carousel: boolean;
  featured: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface CreateMemberProfileInput {
  workos_organization_id: string;
  display_name: string;
  slug: string;
  tagline?: string;
  description?: string;
  logo_url?: string;
  logo_light_url?: string;
  logo_dark_url?: string;
  brand_color?: string;
  contact_email?: string;
  contact_website?: string;
  contact_phone?: string;
  linkedin_url?: string;
  twitter_url?: string;
  offerings?: MemberOffering[];
  agents?: AgentConfig[];
  headquarters?: string;
  markets?: string[];
  metadata?: Record<string, unknown>;
  tags?: string[];
  is_public?: boolean;
  show_in_carousel?: boolean;
}

export interface UpdateMemberProfileInput {
  display_name?: string;
  tagline?: string;
  description?: string;
  logo_url?: string;
  logo_light_url?: string;
  logo_dark_url?: string;
  brand_color?: string;
  contact_email?: string;
  contact_website?: string;
  contact_phone?: string;
  linkedin_url?: string;
  twitter_url?: string;
  offerings?: MemberOffering[];
  agents?: AgentConfig[];
  headquarters?: string;
  markets?: string[];
  metadata?: Record<string, unknown>;
  tags?: string[];
  is_public?: boolean;
  show_in_carousel?: boolean;
}

export interface ListMemberProfilesOptions {
  is_public?: boolean;
  show_in_carousel?: boolean;
  offerings?: MemberOffering[];
  markets?: string[];
  featured?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
}
