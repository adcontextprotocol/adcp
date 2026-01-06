export type AgentType = "creative" | "signals" | "sales" | "unknown";

/**
 * Valid agent type values for runtime validation
 */
export const VALID_AGENT_TYPES: readonly AgentType[] = ["creative", "signals", "sales", "unknown"] as const;

/**
 * Type guard to check if a string is a valid AgentType
 */
export function isValidAgentType(value: string | undefined | null): value is AgentType {
  return typeof value === 'string' && VALID_AGENT_TYPES.includes(value as AgentType);
}

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

/**
 * Summary of an agent's property inventory (counts, not full list)
 * Full property list available via /api/registry/agents/:id/properties
 */
export interface PropertySummary {
  total_count: number;
  count_by_type: Record<string, number>; // e.g., { "website": 50, "mobile_app": 20 }
  tags: string[]; // All unique tags across properties
  publisher_count: number;
}

export interface AgentWithStats extends Agent {
  health?: AgentHealth;
  stats?: AgentStats;
  capabilities?: AgentCapabilities;
  propertiesError?: string;
  // Property summary (counts, not full list to avoid millions of records)
  publisher_domains?: string[];
  property_summary?: PropertySummary;
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

/**
 * Impersonator information when a session is impersonated via WorkOS
 */
export interface Impersonator {
  email: string;
  reason: string | null;
}

export interface WorkOSUser {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  emailVerified: boolean;
  createdAt: string;
  updatedAt: string;
  /** Present when this session is being impersonated by an admin */
  impersonator?: Impersonator;
}

// Member Profile Types

export type MemberOffering =
  | 'buyer_agent'
  | 'sales_agent'
  | 'creative_agent'
  | 'signals_agent'
  | 'publisher'
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

/**
 * Publisher configuration stored in member profiles
 * Each publisher has a domain/URL where adagents.json is hosted
 */
export interface PublisherConfig {
  domain: string;
  is_public: boolean;
  // Cached info from validation (optional, refreshed periodically)
  agent_count?: number;
  last_validated?: string;
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
  publishers: PublisherConfig[]; // Publishers with adagents.json
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
  publishers?: PublisherConfig[];
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
  publishers?: PublisherConfig[];
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

// User Location Types

export type LocationSource = 'manual' | 'outreach' | 'inferred';

export interface UserLocation {
  city?: string;
  country?: string;
  location_source?: LocationSource;
  location_updated_at?: Date;
}

export interface UpdateUserLocationInput {
  workos_user_id: string;
  city?: string;
  country?: string;
  location_source: LocationSource;
}

// Working Group Types

export type WorkingGroupStatus = 'active' | 'inactive' | 'archived';
export type WorkingGroupMembershipStatus = 'active' | 'inactive';
export type CommitteeType = 'working_group' | 'council' | 'chapter' | 'governance' | 'industry_gathering';

export const VALID_COMMITTEE_TYPES: readonly CommitteeType[] = [
  'working_group',
  'council',
  'chapter',
  'governance',
  'industry_gathering',
] as const;

export const COMMITTEE_TYPE_LABELS: Record<CommitteeType, string> = {
  working_group: 'Working Group',
  council: 'Industry Council',
  chapter: 'Regional Chapter',
  governance: 'Governance',
  industry_gathering: 'Industry Gathering',
};

export interface WorkingGroupLeader {
  user_id: string;
  name?: string;
  org_name?: string;
  created_at: Date;
}

export interface WorkingGroup {
  id: string;
  name: string;
  slug: string;
  description?: string;
  slack_channel_url?: string;
  slack_channel_id?: string;
  is_private: boolean;
  status: WorkingGroupStatus;
  display_order: number;
  committee_type: CommitteeType;
  region?: string;
  // Industry gathering fields
  linked_event_id?: string;
  event_start_date?: Date;
  event_end_date?: Date;
  event_location?: string;
  auto_archive_after_event?: boolean;
  logo_url?: string;
  website_url?: string;
  created_at: Date;
  updated_at: Date;
  leaders?: WorkingGroupLeader[];
}

export type EventInterestLevel = 'maybe' | 'interested' | 'attending' | 'attended' | 'not_attending';
export type EventInterestSource = 'outreach' | 'registration' | 'manual' | 'slack_join';

export interface WorkingGroupMembership {
  id: string;
  working_group_id: string;
  workos_user_id: string;
  user_email?: string;
  user_name?: string;
  user_org_name?: string;
  workos_organization_id?: string;
  status: WorkingGroupMembershipStatus;
  added_by_user_id?: string;
  // Event interest tracking
  interest_level?: EventInterestLevel;
  interest_source?: EventInterestSource;
  joined_at: Date;
  updated_at: Date;
}

export interface CreateWorkingGroupInput {
  name: string;
  slug: string;
  description?: string;
  slack_channel_url?: string;
  slack_channel_id?: string;
  leader_user_ids?: string[];
  is_private?: boolean;
  status?: WorkingGroupStatus;
  display_order?: number;
  committee_type?: CommitteeType;
  region?: string;
  // Industry gathering fields
  linked_event_id?: string;
  event_start_date?: Date;
  event_end_date?: Date;
  event_location?: string;
  auto_archive_after_event?: boolean;
  logo_url?: string;
  website_url?: string;
}

export interface UpdateWorkingGroupInput {
  name?: string;
  description?: string;
  slack_channel_url?: string;
  slack_channel_id?: string;
  leader_user_ids?: string[];
  is_private?: boolean;
  status?: WorkingGroupStatus;
  display_order?: number;
  committee_type?: CommitteeType;
  region?: string;
  // Industry gathering fields
  linked_event_id?: string;
  event_start_date?: Date;
  event_end_date?: Date;
  event_location?: string;
  auto_archive_after_event?: boolean;
  logo_url?: string;
  website_url?: string;
}

export interface WorkingGroupWithMemberCount extends WorkingGroup {
  member_count: number;
}

export interface WorkingGroupWithDetails extends WorkingGroup {
  member_count: number;
  memberships?: WorkingGroupMembership[];
}

export interface AddWorkingGroupMemberInput {
  working_group_id: string;
  workos_user_id: string;
  user_email?: string;
  user_name?: string;
  user_org_name?: string;
  workos_organization_id?: string;
  added_by_user_id?: string;
}

// Federated Discovery Types

/**
 * An agent in the federated view (registered or discovered)
 */
export interface FederatedAgent {
  url: string;
  name?: string;
  type?: AgentType | 'buyer' | 'unknown';
  protocol?: 'mcp' | 'a2a';
  source: 'registered' | 'discovered';
  // For registered agents
  member?: {
    slug: string;
    display_name: string;
  };
  // For discovered agents
  discovered_from?: {
    publisher_domain: string;
    authorized_for?: string;
  };
  discovered_at?: string;
}

/**
 * A publisher in the federated view (registered or discovered)
 */
export interface FederatedPublisher {
  domain: string;
  source: 'registered' | 'discovered';
  // For registered publishers
  member?: {
    slug: string;
    display_name: string;
  };
  agent_count?: number;
  last_validated?: string;
  // For discovered publishers
  discovered_from?: {
    agent_url: string;
  };
  has_valid_adagents?: boolean;
  discovered_at?: string;
}

/**
 * Result of a domain lookup showing all agents authorized for that domain
 */
export interface DomainLookupResult {
  domain: string;
  // Agents authorized via adagents.json (verified)
  authorized_agents: Array<{
    url: string;
    authorized_for?: string;
    source: 'registered' | 'discovered';
    member?: { slug: string; display_name: string };
  }>;
  // Sales agents that claim to sell this domain (may not be verified)
  sales_agents_claiming: Array<{
    url: string;
    source: 'registered' | 'discovered';
    member?: { slug: string; display_name: string };
  }>;
}

// =====================================================
// Events Types
// =====================================================

export type EventType = 'summit' | 'meetup' | 'webinar' | 'workshop' | 'conference' | 'other';
export type EventFormat = 'in_person' | 'virtual' | 'hybrid';
export type EventStatus = 'draft' | 'published' | 'cancelled' | 'completed';
export type RegistrationStatus = 'registered' | 'waitlisted' | 'cancelled' | 'no_show';
export type RegistrationSource = 'direct' | 'luma' | 'import' | 'admin';
export type SponsorshipPaymentStatus = 'pending' | 'paid' | 'refunded' | 'cancelled';

export interface SponsorshipTier {
  tier_id: string;
  name: string;
  price_cents: number;
  currency?: string;
  benefits: string[];
  max_sponsors?: number;
}

export interface Event {
  id: string;
  slug: string;
  title: string;
  description?: string;
  short_description?: string;
  event_type: EventType;
  event_format: EventFormat;
  start_time: Date;
  end_time?: Date;
  timezone?: string;
  venue_name?: string;
  venue_address?: string;
  venue_city?: string;
  venue_state?: string;
  venue_country?: string;
  venue_lat?: number;
  venue_lng?: number;
  virtual_url?: string;
  virtual_platform?: string;
  luma_event_id?: string;
  luma_url?: string;
  external_registration_url?: string;
  is_external_event?: boolean;
  featured_image_url?: string;
  sponsorship_enabled: boolean;
  sponsorship_tiers: SponsorshipTier[];
  stripe_product_id?: string;
  status: EventStatus;
  published_at?: Date;
  max_attendees?: number;
  created_by_user_id?: string;
  organization_id?: string;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface CreateEventInput {
  slug: string;
  title: string;
  description?: string;
  short_description?: string;
  event_type?: EventType;
  event_format?: EventFormat;
  start_time: Date;
  end_time?: Date;
  timezone?: string;
  venue_name?: string;
  venue_address?: string;
  venue_city?: string;
  venue_state?: string;
  venue_country?: string;
  venue_lat?: number;
  venue_lng?: number;
  virtual_url?: string;
  virtual_platform?: string;
  luma_event_id?: string;
  luma_url?: string;
  external_registration_url?: string;
  is_external_event?: boolean;
  featured_image_url?: string;
  sponsorship_enabled?: boolean;
  sponsorship_tiers?: SponsorshipTier[];
  stripe_product_id?: string;
  status?: EventStatus;
  max_attendees?: number;
  created_by_user_id?: string;
  organization_id?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateEventInput {
  title?: string;
  description?: string;
  short_description?: string;
  event_type?: EventType;
  event_format?: EventFormat;
  start_time?: Date;
  end_time?: Date;
  timezone?: string;
  venue_name?: string;
  venue_address?: string;
  venue_city?: string;
  venue_state?: string;
  venue_country?: string;
  venue_lat?: number;
  venue_lng?: number;
  virtual_url?: string;
  virtual_platform?: string;
  luma_event_id?: string;
  luma_url?: string;
  external_registration_url?: string;
  is_external_event?: boolean;
  featured_image_url?: string;
  sponsorship_enabled?: boolean;
  sponsorship_tiers?: SponsorshipTier[];
  stripe_product_id?: string;
  status?: EventStatus;
  published_at?: Date;
  max_attendees?: number;
  metadata?: Record<string, unknown>;
}

export interface ListEventsOptions {
  status?: EventStatus;
  statuses?: EventStatus[];  // Query multiple statuses at once
  event_type?: EventType;
  event_format?: EventFormat;
  upcoming_only?: boolean;
  past_only?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface EventRegistration {
  id: string;
  event_id: string;
  workos_user_id?: string;
  email_contact_id?: string;
  email?: string;
  name?: string;
  registration_status: RegistrationStatus;
  attended: boolean;
  checked_in_at?: Date;
  luma_guest_id?: string;
  registration_source: RegistrationSource;
  organization_id?: string;
  ticket_type?: string;
  ticket_code?: string;
  registration_data: Record<string, unknown>;
  registered_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface CreateEventRegistrationInput {
  event_id: string;
  workos_user_id?: string;
  email_contact_id?: string;
  email?: string;
  name?: string;
  registration_status?: RegistrationStatus;
  registration_source?: RegistrationSource;
  organization_id?: string;
  ticket_type?: string;
  registration_data?: Record<string, unknown>;
  luma_guest_id?: string;  // Luma guest ID if synced from Luma
}

export interface EventSponsorship {
  id: string;
  event_id: string;
  organization_id: string;
  purchased_by_user_id?: string;
  tier_id: string;
  tier_name?: string;
  amount_cents: number;
  currency: string;
  payment_status: SponsorshipPaymentStatus;
  stripe_checkout_session_id?: string;
  stripe_payment_intent_id?: string;
  stripe_invoice_id?: string;
  benefits_delivered: Record<string, unknown>;
  display_order: number;
  show_logo: boolean;
  logo_url?: string;
  notes?: string;
  paid_at?: Date;
  created_at: Date;
  updated_at: Date;
}

export interface CreateEventSponsorshipInput {
  event_id: string;
  organization_id: string;
  purchased_by_user_id?: string;
  tier_id: string;
  tier_name?: string;
  amount_cents: number;
  currency?: string;
  stripe_checkout_session_id?: string;
  logo_url?: string;
  notes?: string;
}

export interface EventWithCounts extends Event {
  registration_count?: number;
  attendance_count?: number;
  sponsor_count?: number;
  sponsorship_revenue_cents?: number;
}

export interface EventSponsorDisplay {
  event_id: string;
  tier_id: string;
  tier_name?: string;
  display_order: number;
  logo_url?: string;
  organization_id: string;
  organization_name: string;
  display_logo_url?: string;
  organization_website?: string;
}
