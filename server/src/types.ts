export type AgentType = "creative" | "signals" | "sales" | "governance" | "si" | "unknown";

/**
 * Valid agent type values for runtime validation
 */
export const VALID_AGENT_TYPES: readonly AgentType[] = ["creative", "signals", "sales", "governance", "si", "unknown"] as const;

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
  discovery_error?: string;
  oauth_required?: boolean;
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

export interface AuthorizationResult {
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

/**
 * Valid organization roles for runtime validation
 */
export const VALID_ORGANIZATION_ROLES: readonly CompanyUserRole[] = ['owner', 'admin', 'member'] as const;

/**
 * Roles that can be assigned to new members (excludes owner)
 */
export const VALID_ASSIGNABLE_ROLES: readonly ('admin' | 'member')[] = ['admin', 'member'] as const;

/**
 * Legal document types
 */
export type LegalDocumentType = 'terms_of_service' | 'privacy_policy' | 'membership' | 'bylaws' | 'ip_policy';

/**
 * Valid legal document types for runtime validation
 */
export const VALID_LEGAL_DOCUMENT_TYPES: readonly LegalDocumentType[] = [
  'terms_of_service',
  'privacy_policy',
  'membership',
  'bylaws',
  'ip_policy',
] as const;

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
  | 'si_agent'
  | 'governance_agent'
  | 'publisher'
  | 'data_provider'
  | 'consulting'
  | 'other';

/**
 * Valid member offering values for runtime validation
 */
export const VALID_MEMBER_OFFERINGS: readonly MemberOffering[] = [
  'buyer_agent',
  'sales_agent',
  'creative_agent',
  'signals_agent',
  'si_agent',
  'governance_agent',
  'publisher',
  'data_provider',
  'consulting',
  'other',
] as const;

/**
 * Type guard to check if a string is a valid MemberOffering
 */
export function isValidMemberOffering(value: string | undefined | null): value is MemberOffering {
  return typeof value === 'string' && VALID_MEMBER_OFFERINGS.includes(value as MemberOffering);
}

/**
 * Agent configuration stored in member profiles
 * Each agent has a URL and visibility settings
 */
export interface AgentConfig {
  url: string;
  is_public: boolean;
  // Cached info from discovery (optional, refreshed periodically)
  name?: string;
  type?: AgentType | 'buyer';
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

/**
 * Brand architecture type from Keller's theory
 */
export type KellerType = 'master' | 'sub_brand' | 'endorsed' | 'independent';

/**
 * Brand configuration stored in member profiles
 * Each brand has a canonical domain and visibility settings
 */
export interface BrandConfig {
  canonical_domain: string;
  is_public: boolean;
  // Cached info from validation (optional, refreshed periodically)
  name?: string;
  keller_type?: KellerType;
  house_domain?: string;
  last_validated?: string;
}

/**
 * Localized name entry (language code → name)
 */
export interface LocalizedName {
  [languageCode: string]: string;
}

/**
 * Brand property (digital touchpoint owned by a brand)
 */
export interface BrandProperty {
  type: 'website' | 'mobile_app' | 'ctv_app' | 'desktop_app' | 'dooh' | 'podcast' | 'radio' | 'streaming_audio';
  identifier: string;
  store?: 'apple' | 'google' | 'amazon' | 'roku' | 'samsung' | 'lg' | 'other';
  region?: string;
  primary?: boolean;
}

/**
 * Brand definition within a house portfolio
 */
export interface BrandDefinition {
  id: string;
  names: LocalizedName[];
  keller_type?: KellerType;
  parent_brand?: string;
  properties?: BrandProperty[];
  brand_standards?: string;
  brand_manifest?: Record<string, unknown> | string;
}

/**
 * House definition (corporate entity that owns brands)
 */
export interface HouseDefinition {
  domain: string;
  name: string;
  names?: LocalizedName[];
  architecture?: 'branded_house' | 'house_of_brands' | 'hybrid';
}

/**
 * Brand agent configuration
 */
export interface BrandAgentConfig {
  url: string;
  id: string;
  capabilities?: string[];
}

/**
 * Hosted brand record
 */
export interface HostedBrand {
  id: string;
  workos_organization_id?: string;
  created_by_user_id?: string;
  created_by_email?: string;
  brand_domain: string;
  brand_json: Record<string, unknown>;
  domain_verified: boolean;
  verification_token?: string;
  is_public: boolean;
  created_at: Date;
  updated_at: Date;
}

/**
 * Discovered brand record
 */
export interface DiscoveredBrand {
  id: string;
  domain: string;
  canonical_domain?: string;
  house_domain?: string;
  brand_name?: string;
  brand_names?: LocalizedName[];
  keller_type?: KellerType;
  parent_brand?: string;
  brand_agent_url?: string;
  brand_agent_capabilities?: string[];
  has_brand_manifest: boolean;
  brand_manifest?: Record<string, unknown>;
  source_type: 'brand_json' | 'community' | 'enriched';
  review_status?: 'pending' | 'approved';
  discovered_at: Date;
  last_validated?: Date;
  expires_at?: Date;
}

/**
 * Resolved brand identity (result of resolving a domain to a brand)
 */
export interface ResolvedBrand {
  canonical_id: string;  // e.g., "nike.com" or "nike.com#air-jordan"
  canonical_domain: string;
  brand_name: string;
  names?: LocalizedName[];
  keller_type?: KellerType;
  parent_brand?: string;
  house_domain?: string;
  house_name?: string;
  brand_agent_url?: string;
  brand_manifest?: Record<string, unknown>;
  source: 'brand_json' | 'community' | 'enriched';
}

/**
 * Hosted property record (synthetic adagents.json we manage)
 */
export interface HostedProperty {
  id: string;
  workos_organization_id?: string;
  created_by_user_id?: string;
  created_by_email?: string;
  publisher_domain: string;
  adagents_json: Record<string, unknown>;
  domain_verified: boolean;
  verification_token?: string;
  is_public: boolean;
  source_type: 'community' | 'enriched';
  review_status?: 'pending' | 'approved';
  created_at: Date;
  updated_at: Date;
}

/**
 * Resolved property (result of resolving a domain to property info)
 */
export interface ResolvedProperty {
  publisher_domain: string;
  source: 'adagents_json' | 'hosted' | 'discovered';
  authorized_agents?: Array<{
    url: string;
    authorized_for?: string;
  }>;
  properties?: Array<{
    id?: string;
    type: string;
    name: string;
    identifiers?: Array<{ type: string; value: string }>;
    tags?: string[];
  }>;
  contact?: {
    name: string;
    email?: string;
  };
  verified: boolean;
}

/**
 * Registry revision record (snapshot of a brand or property at a point in time)
 */
export interface RegistryRevision {
  id: string;
  domain: string;
  revision_number: number;
  snapshot: Record<string, unknown>;
  editor_user_id: string;
  editor_email?: string;
  editor_name?: string;
  edit_summary: string;
  is_rollback: boolean;
  rolled_back_to?: number;
  created_at: Date;
}

/**
 * Ban record (platform-wide or registry-scoped)
 */
export interface Ban {
  id: string;
  ban_type: 'user' | 'organization' | 'api_key';
  entity_id: string;
  scope: 'platform' | 'registry_brand' | 'registry_property';
  scope_target?: string;
  banned_by_user_id: string;
  banned_by_email?: string;
  banned_email?: string;
  reason: string;
  expires_at?: Date;
  created_at: Date;
}

/**
 * Data provider configuration stored in member profiles
 * Each data provider has a domain where their signal catalog is hosted via adagents.json
 */
export interface DataProviderConfig {
  domain: string;
  is_public: boolean;
  // Cached info from validation (optional, refreshed periodically)
  signal_count?: number;
  categories?: string[];  // e.g., ["automotive", "demographics", "purchase_intent"]
  last_validated?: string;
}

export interface MemberBrandInfo {
  domain: string;
  logo_url?: string;
  brand_color?: string;
  verified: boolean;
}

export interface MemberProfile {
  id: string;
  workos_organization_id: string;
  display_name: string;
  slug: string;
  tagline?: string;
  description?: string;
  primary_brand_domain?: string;
  resolved_brand?: MemberBrandInfo;
  contact_email?: string;
  contact_website?: string;
  contact_phone?: string;
  linkedin_url?: string;
  twitter_url?: string;
  offerings: MemberOffering[];
  agents: AgentConfig[];
  publishers: PublisherConfig[]; // Publishers with adagents.json
  brands: BrandConfig[]; // Brands managed by this member
  data_providers: DataProviderConfig[]; // Data providers with signal catalogs
  headquarters?: string; // City, Country (e.g., "Singapore", "New York, USA")
  markets: string[]; // Regions/markets served (e.g., ["APAC", "North America"])
  metadata: Record<string, unknown>;
  tags: string[];
  is_public: boolean;
  show_in_carousel: boolean;
  featured: boolean;
  is_founding_member: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface CreateMemberProfileInput {
  workos_organization_id: string;
  display_name: string;
  slug: string;
  tagline?: string;
  description?: string;
  primary_brand_domain?: string;
  contact_email?: string;
  contact_website?: string;
  contact_phone?: string;
  linkedin_url?: string;
  twitter_url?: string;
  offerings?: MemberOffering[];
  agents?: AgentConfig[];
  publishers?: PublisherConfig[];
  brands?: BrandConfig[];
  data_providers?: DataProviderConfig[];
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
  primary_brand_domain?: string;
  contact_email?: string;
  contact_website?: string;
  contact_phone?: string;
  linkedin_url?: string;
  twitter_url?: string;
  offerings?: MemberOffering[];
  agents?: AgentConfig[];
  publishers?: PublisherConfig[];
  brands?: BrandConfig[];
  data_providers?: DataProviderConfig[];
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
  timezone?: string;
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
  canonical_user_id: string; // WorkOS user ID if Slack user is mapped, else user_id
  name?: string;
  org_name?: string;
  created_at: Date;
}

/**
 * Topic within a working group for filtering meetings/docs
 */
export interface WorkingGroupTopic {
  slug: string;
  name: string;
  description?: string;
  slack_channel_id?: string;
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
  // Topics for filtering meetings/docs
  topics?: WorkingGroupTopic[];
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
  topics?: WorkingGroupTopic[];
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
  slug?: string;
  description?: string;
  slack_channel_url?: string;
  slack_channel_id?: string;
  leader_user_ids?: string[];
  is_private?: boolean;
  status?: WorkingGroupStatus;
  display_order?: number;
  committee_type?: CommitteeType;
  region?: string;
  topics?: WorkingGroupTopic[];
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

// Committee Documents Types

export type CommitteeDocumentType = 'google_doc' | 'google_sheet' | 'external_link' | 'pdf' | 'other';
export type DocumentIndexStatus = 'pending' | 'success' | 'access_denied' | 'error' | 'disabled';

export interface CommitteeDocument {
  id: string;
  working_group_id: string;
  title: string;
  description?: string;
  document_url: string;
  document_type: CommitteeDocumentType;
  display_order: number;
  is_featured: boolean;
  content_hash?: string;
  last_content?: string;
  last_indexed_at?: Date;
  last_modified_at?: Date;
  document_summary?: string;
  summary_generated_at?: Date;
  index_status: DocumentIndexStatus;
  index_error?: string;
  added_by_user_id?: string;
  created_at: Date;
  updated_at: Date;
}

export interface CreateCommitteeDocumentInput {
  working_group_id: string;
  title: string;
  description?: string;
  document_url: string;
  document_type?: CommitteeDocumentType;
  display_order?: number;
  is_featured?: boolean;
  added_by_user_id?: string;
}

export interface UpdateCommitteeDocumentInput {
  title?: string;
  description?: string;
  document_url?: string;
  document_type?: CommitteeDocumentType;
  display_order?: number;
  is_featured?: boolean;
}

export type CommitteeSummaryType = 'activity' | 'overview' | 'changes';

export interface CommitteeSummary {
  id: string;
  working_group_id: string;
  summary_type: CommitteeSummaryType;
  summary_text: string;
  time_period_start?: Date;
  time_period_end?: Date;
  input_sources: Array<{ type: string; id: string; title: string }>;
  generated_at: Date;
  generated_by: string;
  is_current: boolean;
  superseded_by?: string;
  superseded_at?: Date;
}

export type DocumentActivityType = 'indexed' | 'content_changed' | 'access_lost' | 'access_restored' | 'error';

export interface CommitteeDocumentActivity {
  id: string;
  document_id: string;
  working_group_id: string;
  activity_type: DocumentActivityType;
  content_hash_before?: string;
  content_hash_after?: string;
  change_summary?: string;
  detected_at: Date;
}

// Federated Discovery Types

/**
 * An agent in the federated view (registered or discovered)
 */
export interface FederatedAgent {
  url: string;
  name?: string;
  type?: AgentType | 'buyer';
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

// =====================================================
// Meeting Types
// =====================================================

export type MeetingStatus = 'draft' | 'scheduled' | 'in_progress' | 'completed' | 'cancelled';
export type MeetingSeriesStatus = 'active' | 'paused' | 'archived';
export type MeetingInviteMode = 'all_members' | 'topic_subscribers' | 'slack_channel' | 'manual';
export type RsvpStatus = 'pending' | 'accepted' | 'declined' | 'tentative';
export type MeetingInviteSource = 'auto' | 'manual' | 'request';

/**
 * Recurrence rule for meeting series (iCal RRULE-style)
 */
export interface RecurrenceRule {
  freq: 'daily' | 'weekly' | 'monthly';
  interval?: number;  // every N freq (default 1)
  byDay?: string[];   // ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
  count?: number;     // stop after N occurrences
  until?: string;     // stop after this date (ISO string)
}

/**
 * Meeting series - recurring meeting template
 */
export interface MeetingSeries {
  id: string;
  working_group_id: string;
  title: string;
  description?: string;
  topic_slugs: string[];
  recurrence_rule?: RecurrenceRule;
  default_start_time?: string;  // TIME as string "14:00:00"
  duration_minutes: number;
  timezone: string;
  zoom_meeting_id?: string;
  zoom_join_url?: string;
  zoom_passcode?: string;
  google_calendar_id?: string;
  google_event_series_id?: string;
  invite_mode: MeetingInviteMode;
  invite_slack_channel_id?: string;
  status: MeetingSeriesStatus;
  created_by_user_id?: string;
  created_at: Date;
  updated_at: Date;
}

export interface CreateMeetingSeriesInput {
  working_group_id: string;
  title: string;
  description?: string;
  topic_slugs?: string[];
  recurrence_rule?: RecurrenceRule;
  default_start_time?: string;
  duration_minutes?: number;
  timezone?: string;
  invite_mode?: MeetingInviteMode;
  invite_slack_channel_id?: string;
  created_by_user_id?: string;
}

export interface UpdateMeetingSeriesInput {
  title?: string;
  description?: string;
  topic_slugs?: string[];
  recurrence_rule?: RecurrenceRule;
  default_start_time?: string;
  duration_minutes?: number;
  timezone?: string;
  zoom_meeting_id?: string;
  zoom_join_url?: string;
  zoom_passcode?: string;
  google_calendar_id?: string;
  google_event_series_id?: string;
  invite_mode?: MeetingInviteMode;
  invite_slack_channel_id?: string;
  status?: MeetingSeriesStatus;
}

/**
 * Individual meeting occurrence
 */
export interface Meeting {
  id: string;
  series_id?: string;
  working_group_id: string;
  title: string;
  description?: string;
  agenda?: string;
  topic_slugs: string[];
  start_time: Date;
  end_time?: Date;
  timezone: string;
  zoom_meeting_id?: string;
  zoom_join_url?: string;
  zoom_passcode?: string;
  google_calendar_event_id?: string;
  recording_url?: string;
  transcript_url?: string;
  transcript_text?: string;
  summary?: string;
  status: MeetingStatus;
  slack_channel_id?: string;
  slack_thread_ts?: string;
  slack_announcement_ts?: string;
  created_by_user_id?: string;
  created_at: Date;
  updated_at: Date;
}

export interface CreateMeetingInput {
  series_id?: string;
  working_group_id: string;
  title: string;
  description?: string;
  agenda?: string;
  topic_slugs?: string[];
  start_time: Date;
  end_time?: Date;
  timezone?: string;
  status?: MeetingStatus;
  created_by_user_id?: string;
}

export interface UpdateMeetingInput {
  title?: string;
  description?: string;
  agenda?: string;
  topic_slugs?: string[];
  start_time?: Date;
  end_time?: Date;
  timezone?: string;
  zoom_meeting_id?: string;
  zoom_join_url?: string;
  zoom_passcode?: string;
  google_calendar_event_id?: string;
  recording_url?: string;
  transcript_url?: string;
  transcript_text?: string;
  summary?: string;
  status?: MeetingStatus;
  slack_channel_id?: string;
  slack_thread_ts?: string;
  slack_announcement_ts?: string;
}

export interface ListMeetingsOptions {
  working_group_id?: string;
  working_group_ids?: string[]; // Filter by multiple working groups
  series_id?: string;
  status?: MeetingStatus;
  topic_slugs?: string[];
  upcoming_only?: boolean;
  past_only?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * Meeting attendee with RSVP and attendance info
 */
export interface MeetingAttendee {
  id: string;
  meeting_id: string;
  workos_user_id?: string;
  email?: string;
  name?: string;
  rsvp_status: RsvpStatus;
  rsvp_at?: Date;
  rsvp_note?: string;
  attended?: boolean;
  joined_at?: Date;
  left_at?: Date;
  invite_source: MeetingInviteSource;
  created_at: Date;
  updated_at: Date;
}

export interface CreateMeetingAttendeeInput {
  meeting_id: string;
  workos_user_id?: string;
  email?: string;
  name?: string;
  rsvp_status?: RsvpStatus;
  invite_source?: MeetingInviteSource;
}

export interface UpdateMeetingAttendeeInput {
  rsvp_status?: RsvpStatus;
  rsvp_note?: string;
  attended?: boolean;
  joined_at?: Date;
  left_at?: Date;
}

/**
 * Topic subscription for a member within a working group
 */
export interface WorkingGroupTopicSubscription {
  id: string;
  working_group_id: string;
  workos_user_id: string;
  topic_slugs: string[];
  created_at: Date;
  updated_at: Date;
}

export interface UpdateTopicSubscriptionInput {
  working_group_id: string;
  workos_user_id: string;
  topic_slugs: string[];
}

/**
 * Meeting with working group info (for list views)
 */
export interface MeetingWithGroup extends Meeting {
  working_group_name: string;
  working_group_slug: string;
  committee_type: CommitteeType;
  series_title?: string;
  accepted_count?: number;
  invited_count?: number;
}

/**
 * Member's view of upcoming meetings
 */
export interface MemberMeeting {
  workos_user_id: string;
  rsvp_status: RsvpStatus;
  meeting_id: string;
  title: string;
  start_time: Date;
  end_time?: Date;
  timezone: string;
  zoom_join_url?: string;
  working_group_id: string;
  working_group_name: string;
  working_group_slug: string;
}
