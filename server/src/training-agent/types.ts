/**
 * Internal types for the training agent.
 * Schema-level types (Product, Format, etc.) come from @adcp/sdk.
 */
import type { Product, Proposal, BrandReference, FormatID, CreateMediaBuyRequest, EventType } from '@adcp/sdk';

// SpecialCategory for episodes (e.g., premiere, finale) — not yet in @adcp/sdk types
type SpecialCategory = 'premiere' | 'finale' | 'holiday' | 'awards' | 'reunion' | 'crossover' | 'championship';

/** Matches the talent-role.json enum in static/schemas/source/enums/ */
export const TALENT_ROLES = ['host', 'guest', 'creator', 'cast', 'narrator', 'producer', 'correspondent', 'commentator', 'analyst'] as const;
export type TalentRole = typeof TALENT_ROLES[number];

/** AccountReference from SDK — identifies an account on create_media_buy */
type AccountReference = CreateMediaBuyRequest['account'];

export interface TrainingContext {
  mode: 'open' | 'training';
  userId?: string;
  moduleId?: string;
  trackId?: string;
  learnerLevel?: 'basics' | 'practitioner' | 'specialist';
  /** Authenticated principal for idempotency cache scoping.
   *  Derived from the bearer token in the MCP route; defaults to `anonymous`
   *  when no auth is configured (dev / test). */
  principal?: string;
  /** Route is the grader-targeted `/mcp-strict` endpoint. Advertises
   *  `required_for: ['create_media_buy']` in capabilities and enforces
   *  presence-gated signing at the auth layer. Default `/mcp` leaves
   *  `required_for` empty so unsigned bearer callers keep working. */
  strict?: boolean;
  /**
   * `covers_content_digest` mode advertised by this route. Only meaningful
   * when `strict` is true. Defaults to `'either'` (the `/mcp-strict` route).
   * `/mcp-strict-required` uses `'required'`; `/mcp-strict-forbidden` uses `'forbidden'`.
   */
  digestMode?: 'either' | 'required' | 'forbidden';
}

export interface ShowSpecial {
  name: string;
  category?: SpecialCategory;
  starts?: string;
  ends?: string;
}

export interface ShowLimitedSeries {
  totalEpisodes?: number;
  starts?: string;
  ends?: string;
}

export interface ShowDefinition {
  showId: string;
  name: string;
  genre: string[];
  cadence: string;
  status: string;
  contentRatings?: Array<{ system: string; rating: string }>;
  talent?: Array<{ name: string; role: TalentRole }>;
  distribution?: Array<{ publisherDomain: string; identifiers: Array<{ type: string; value: string }> }>;
  description?: string;
  special?: ShowSpecial;
  limitedSeries?: ShowLimitedSeries;
  /** Channels this show's products should appear on */
  channels: string[];
  /** Episode templates to generate for this show */
  episodes?: Array<{
    episodeId: string;
    title: string;
    status: string;
    scheduledAt?: string;
    durationSeconds?: number;
    special?: ShowSpecial;
  }>;
}

export interface PublisherProfile {
  id: string;
  name: string;
  domain: string;
  description: string;
  channels: string[];
  deliveryTypes: ('guaranteed' | 'non_guaranteed')[];
  pricingTemplates: PricingTemplate[];
  measurementProvider: string;
  measurementNotes: string;
  properties: PropertyDefinition[];
  /** Optional: catalog types this publisher supports */
  catalogTypes?: string[];
  reportingFrequencies: string[];
  reportingMetrics: string[];
  /** Optional: vendor-defined metrics this publisher reports (Adelaide attention, Scope3 emissions, etc.) */
  vendorMetrics?: Array<{
    vendor: { domain: string; brand_id?: string };
    metric_id: string;
  }>;
  /** Optional: shows this publisher carries */
  shows?: ShowDefinition[];
  /** Hero image URL for product and proposal cards */
  heroImageUrl?: string;
  /** Audience summary for product cards */
  audienceSummary?: string;
  /** Monthly volume estimate for product cards */
  estimatedVolume?: string;
}

export interface PropertyDefinition {
  propertyId: string;
  name: string;
  identifierType: string;
  identifierValue: string;
  channels: string[];
  tags: string[];
}

export interface PricingTemplate {
  model: 'cpm' | 'vcpm' | 'cpc' | 'cpcv' | 'cpv' | 'flat_rate' | 'time' | 'cpa' | 'cpp';
  currency: string;
  fixedPrice?: number;
  floorPrice?: number;
  priceGuidance?: { suggested: number; range: { min: number; max: number } };
  minSpendPerPackage?: number;
  /** For DOOH flat_rate with parameters */
  doohParameters?: {
    type: 'dooh';
    sov_percentage?: number;
    loop_duration_seconds?: number;
    min_plays_per_hour?: number;
    venue_package?: string;
    duration_hours?: number;
    daypart?: string;
    estimated_impressions?: number;
  };
  /** For CPA: the event type that triggers billing */
  eventType?: EventType;
  /** For CPP: demographic targeting parameters */
  cppParameters?: { demographic: string };
  /** For CPV: view threshold parameters */
  cpvParameters?: { view_threshold: number | { duration_seconds: number } };
  /** For time: the time unit and duration constraints */
  timeParameters?: { time_unit: 'hour' | 'day' | 'week' | 'month'; min_duration: number; max_duration: number };
}

export interface CatalogProduct {
  product: import('@adcp/sdk').Product;
  publisherId: string;
  trainingTier: 'basics' | 'practitioner' | 'specialist';
  scenarioTags: string[];
}

/** Show data included in get_products responses (not part of the AdCP schema — supplementary data) */
export interface ShowResponse {
  show_id: string;
  name: string;
  genre: string[];
  cadence: string;
  status: string;
  description?: string;
  content_rating?: Array<{ system: string; rating: string }>;
  talent?: Array<{ name: string; role: TalentRole }>;
  distribution?: Array<{
    publisher_domain: string;
    identifiers: Array<{ type: string; value: string }>;
  }>;
}

export interface RightsGrantState {
  grantId: string;
  rightsId: string;
  brandId: string;
  buyerDomain: string;
  status: 'acquired' | 'pending_approval' | 'rejected';
  pricingOptionId: string;
  startDate: string;
  endDate: string;
  impressionCap?: number;
  paused: boolean;
  createdAt: string;
}

export interface ComplyDeliveryAccumulator {
  impressions: number;
  clicks: number;
  reportedSpend: { amount: number; currency: string };
  conversions: number;
  /** vendor_metric_values injected via comply_test_controller simulate_delivery. */
  vendorMetricValues?: unknown[];
}

export interface ComplyBudgetSimulation {
  spendPercentage: number;
  computedSpend: { amount: number; currency: string };
  budget: { amount: number; currency: string };
}

export interface ComplyExtensions {
  accountStatuses: Map<string, string>;
  siSessions: Map<string, { status: string; terminationReason?: string }>;
  deliverySimulations: Map<string, ComplyDeliveryAccumulator>;
  budgetSimulations: Map<string, ComplyBudgetSimulation>;
  /** Products seeded via comply_test_controller.seed_product. Session-scoped overlay
   * on the static catalog so storyboards can reference fixture IDs without
   * polluting the shared catalog. Merged into get_products output. */
  seededProducts: Map<string, Record<string, unknown>>;
  /** Pricing options seeded via seed_pricing_option, keyed by `<product_id>:<pricing_option_id>`. */
  seededPricingOptions: Map<string, Record<string, unknown>>;
  /** Creative formats seeded via comply_test_controller.seed_creative_format.
   * Replaces the static format catalog for list_creative_formats when non-empty,
   * giving storyboards a deterministic, size-controlled result set for
   * pagination-integrity assertions. Keyed by the format's id string. */
  seededCreativeFormats: Map<string, Record<string, unknown>>;
  /** Single-shot directive registered via comply_test_controller.force_create_media_buy_arm.
   * Consumed by the next create_media_buy call from this session and cleared. A second
   * force_create_media_buy_arm before consumption overwrites the directive. Buyer-side
   * idempotency_key replay still wins — the seller's request idempotency cache replays
   * the cached response without re-evaluating against an empty directive slot.
   *
   * Only `arm: 'submitted'` is modeled today. `arm: 'input-required'` is reserved in
   * the spec but cannot be expressed on a conformant create-media-buy response — there
   * is no INPUT_REQUIRED value in the canonical error-code enum (it's a task-status)
   * and the response schema has no fourth oneOf branch for an input-required envelope.
   * The controller rejects that arm with INVALID_PARAMS until the spec resolves it. */
  forcedCreateMediaBuyArm?: {
    arm: 'submitted';
    taskId: string;
    message?: string;
  };
}

export interface SessionState {
  mediaBuys: Map<string, MediaBuyState>;
  creatives: Map<string, CreativeState>;
  signalActivations: Map<string, SignalActivationState>;
  governancePlans: Map<string, GovernancePlanState>;
  governanceChecks: Map<string, GovernanceCheckState>;
  governanceOutcomes: Map<string, GovernanceOutcomeState>;
  propertyLists: Map<string, PropertyListState>;
  collectionLists: Map<string, CollectionListState>;
  contentStandards: Map<string, ContentStandardsState>;
  rightsGrants: Map<string, RightsGrantState>;
  usageRecords: UsageRecord[];
  /** Data set by comply_test_controller. Persisted so scenarios survive the
   * serialize/deserialize round trip that every request does, even in the
   * single-request case with the InMemoryStateStore. */
  complyExtensions: ComplyExtensions;
  lastGetProductsContext?: {
    /** Products are deterministic from the catalog — not persisted across requests.
     * After a cross-machine rehydration, this is undefined and callers must re-derive. */
    products?: Product[];
    proposals?: Proposal[];
  };
  createdAt: Date;
  lastAccessedAt: Date;
}

export interface CollectionListState {
  list_id: string;
  name: string;
  description?: string;
  base_collections?: unknown[];
  filters?: Record<string, unknown>;
  brand?: { domain: string };
  account?: AccountRef;
  webhook_url?: string;
  collection_count: number;
  created_at: string;
  updated_at: string;
}

export interface SignalActivationState {
  signalAgentSegmentId: string;
  destinationType: 'platform' | 'agent';
  destinationId: string;
  account?: string;
  pricingOptionId?: string;
  governanceContext?: string;
  isLive: boolean;
  activatedAt: string;
}

/** MCP tool args arrive as untyped JSON. Handlers cast to specific request types internally. */
export interface ToolArgs { account?: AccountRef; brand?: BrandRef }

export interface AccountRef {
  account_id?: string;
  brand?: { domain: string };
  operator?: string;
  sandbox?: boolean;
}

export interface BrandRef {
  domain: string;
  name?: string;
}

export interface MediaBuyHistoryEntry {
  revision: number;
  timestamp: string;
  actor: string;
  action: string;
  summary: string;
  packageId?: string;
}

export interface MediaBuyState {
  mediaBuyId: string;
  accountRef: AccountRef;
  brandRef?: BrandRef;
  status: string;
  currency: string;
  packages: PackageState[];
  startTime: string;
  endTime: string;
  revision: number;
  confirmedAt: string;
  canceledAt?: string;
  canceledBy?: string;
  cancellationReason?: string;
  creativeDeadline?: string;
  governanceContext?: string;
  createdAt: string;
  updatedAt: string;
  history: MediaBuyHistoryEntry[];
  /** Set by comply_test_controller after a forced status write. Consumed and
   * cleared on the first deriveStatus read so subsequent real-workflow reads
   * see the normal pending_creatives guard. Never set by production code paths. */
  complyControllerForced?: boolean;
}

export interface PackageState {
  packageId: string;
  productId: string;
  budget: number;
  pricingOptionId: string;
  bidPrice?: number;
  impressions?: number;
  paused: boolean;
  canceled?: boolean;
  canceledAt?: string;
  canceledBy?: string;
  cancellationReason?: string;
  startTime: string;
  endTime: string;
  formatIds?: FormatID[];
  creativeAssignments: string[];
  targeting?: PackageTargeting;
}

export interface ListReference {
  agent_url: string;
  list_id: string;
  auth_token?: string;
}

export interface PackageTargeting {
  property_list?: ListReference;
  collection_list?: ListReference;
  collection_list_exclude?: ListReference;
}

/** A single asset slot inside a creative manifest (e.g., headline, hero_image). */
export interface ManifestAsset {
  asset_type: string;
  content?: string;
  url?: string;
  width?: number;
  height?: number;
}

/** Creative manifest with format and named asset slots. */
export interface CreativeManifest {
  format_id: FormatID;
  assets: Record<string, ManifestAsset>;
}

export interface CreativeState {
  creativeId: string;
  formatId: FormatID;
  name?: string;
  status: string;
  syncedAt: string;
  manifest?: CreativeManifest;
  pricingOptionId?: string;
}

export interface UsageRecord {
  account: AccountRef;
  creativeId?: string;
  signalAgentSegmentId?: string;
  pricingOptionId?: string;
  impressions?: number;
  mediaSpend?: number;
  vendorCost: number;
  currency: string;
  reportedAt: string;
}

// ── Governance types ────────────────────────────────────────────

export interface GovernanceDelegation {
  agentUrl: string;
  authority: string;
  budgetLimit?: { amount: number; currency: string };
  markets?: string[];
  expiresAt?: string;
}

export interface GovernancePlanState {
  planId: string;
  version: number;
  status: 'active' | 'suspended' | 'completed';
  brand: BrandReference;
  objectives: string;
  budget: {
    total: number;
    currency: string;
    reallocationThreshold: number;
    reallocationUnlimited: boolean;
    perSellerMaxPct?: number;
    allocations?: Record<string, { amount?: number; maxPct?: number }>;
  };
  humanReviewRequired: boolean;
  humanReviewAutoFlippedBy: string[];
  humanOverride?: { reason: string; approver: string; approvedAt: string };
  policyCategories?: string[];
  revisionHistory: Array<{
    version: number;
    syncedAt: string;
    humanReviewRequired: boolean;
    humanReviewAutoFlippedBy: string[];
    humanOverride?: { reason: string; approver: string; approvedAt: string };
    mode: GovernancePlanState['mode'];
    reallocationThreshold: number;
    reallocationUnlimited: boolean;
    policyCategories?: string[];
    policyIds?: string[];
  }>;
  channels?: {
    required?: string[];
    allowed?: string[];
    mixTargets?: Record<string, { min_pct?: number; max_pct?: number }>;
  };
  flight: { start: string; end: string };
  countries?: string[];
  regions?: string[];
  delegations?: GovernanceDelegation[];
  approvedSellers?: string[] | null;
  policyIds?: string[];
  customPolicies?: Array<{
    policy_id?: string;
    policy: string;
    description?: string;
    enforcement?: 'must' | 'should' | 'may';
    requires_human_review?: boolean;
  }>;
  mode: 'enforce' | 'advisory' | 'audit';
  committedBudget: number;
  committedByType?: Record<string, number>;
  syncedAt: string;
}

export interface GovernanceCheckState {
  checkId: string;
  planId: string;
  governanceContext?: string;
  binding: 'proposed' | 'committed';
  status: 'approved' | 'denied' | 'conditions';
  caller: string;
  tool?: string;
  purchaseType?: string;
  phase?: string;
  findings: GovernanceFinding[];
  conditions?: GovernanceCondition[];
  explanation: string;
  mode: string;
  categoriesEvaluated: string[];
  policiesEvaluated: string[];
  timestamp: string;
  expiresAt?: string;
}

export interface GovernanceFinding {
  categoryId: string;
  severity: string;
  explanation: string;
  policyId?: string;
  confidence?: number;
  details?: { field?: string; expected?: unknown; actual?: unknown };
}

export interface GovernanceCondition {
  field: string;
  requiredValue?: unknown;
  reason: string;
}

export interface GovernanceOutcomeState {
  outcomeId: string;
  planId: string;
  checkId?: string;
  governanceContext?: string;
  purchaseType?: string;
  sellerReference?: string;
  outcomeType: 'completed' | 'failed' | 'delivery';
  committedBudget: number;
  findings: GovernanceFinding[];
  timestamp: string;
}

// ── Property governance types ─────────────────────────────────────

export interface PropertyListState {
  listId: string;
  name: string;
  description?: string;
  listType?: string;
  account?: AccountRef;
  baseProperties: unknown[];
  filters?: unknown;
  brand?: unknown;
  webhookUrl?: string;
  cacheDurationHours: number;
  propertyCount: number;
  authToken: string;
  createdAt: string;
  updatedAt: string;
}

// ── Content standards types ───────────────────────────────────────

export interface ContentStandardsState {
  standardsId: string;
  scope: {
    countriesAll?: string[];
    channelsAny?: string[];
    languagesAny?: string[];
    description?: string;
  };
  policy: string;
  calibrationExemplars?: { pass?: unknown[]; fail?: unknown[] };
  createdAt: string;
  updatedAt: string;
}
