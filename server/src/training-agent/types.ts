/**
 * Internal types for the training agent.
 * Schema-level types (Product, Format, etc.) come from @adcp/client.
 */

import type { Product, FormatID } from '@adcp/client';

export interface TrainingContext {
  mode: 'open' | 'training';
  userId?: string;
  moduleId?: string;
  trackId?: string;
  learnerLevel?: 'basics' | 'practitioner' | 'specialist';
}

export interface ShowSpecial {
  name: string;
  category?: string;
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
  talent?: Array<{ name: string; role: string }>;
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
  /** Optional: reporting capabilities */
  reportingFrequencies?: string[];
  reportingMetrics?: string[];
  /** Optional: shows this publisher carries */
  shows?: ShowDefinition[];
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
  doohParameters?: { type: 'dooh'; sov_percentage?: number; loop_duration_seconds?: number; min_plays_per_hour?: number; venue_package?: string; duration_hours?: number; daypart?: string; estimated_impressions?: number };
  /** For CPA: the event type that triggers billing */
  eventType?: string;
  /** For CPP: demographic targeting parameters */
  cppParameters?: { demographic: string };
  /** For CPV: view threshold parameters */
  cpvParameters?: { view_threshold: number | { type: string; value: number; unit: string } };
  /** For time: the time unit and duration constraints */
  timeParameters?: { unit: string; min_duration: number; max_duration: number };
}

export interface CatalogProduct {
  product: Partial<Product>;
  publisherId: string;
  trainingTier: 'basics' | 'practitioner' | 'specialist';
  scenarioTags: string[];
}

export interface SessionState {
  mediaBuys: Map<string, MediaBuyState>;
  creatives: Map<string, CreativeState>;
  signalActivations: Map<string, SignalActivationState>;
  governancePlans: Map<string, GovernancePlanState>;
  governanceChecks: Map<string, GovernanceCheckState>;
  governanceOutcomes: Map<string, GovernanceOutcomeState>;
  lastGetProductsContext?: {
    products: Partial<Product>[];
    proposals?: Partial<Product>[];
  };
  createdAt: Date;
  lastAccessedAt: Date;
}

export interface SignalActivationState {
  signalAgentSegmentId: string;
  destinationType: 'platform' | 'agent';
  destinationId: string;
  account?: string;
  pricingOptionId?: string;
  isLive: boolean;
  activatedAt: string;
}

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

export interface MediaBuyState {
  mediaBuyId: string;
  buyerRef: string;
  buyerCampaignRef?: string;
  accountRef: AccountRef;
  brandRef?: BrandRef;
  status: string;
  currency: string;
  packages: PackageState[];
  startTime: string;
  endTime: string;
  confirmedAt: string;
  revision: number;
  canceledAt?: string;
  canceledBy?: 'buyer' | 'seller';
  cancellationReason?: string;
  creativeDeadline?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PackageState {
  packageId: string;
  buyerRef: string;
  productId: string;
  budget: number;
  pricingOptionId: string;
  bidPrice?: number;
  impressions?: number;
  paused: boolean;
  canceled?: boolean;
  canceledAt?: string;
  canceledBy?: 'buyer' | 'seller';
  cancellationReason?: string;
  creativeDeadline?: string;
  startTime: string;
  endTime: string;
  formatIds?: FormatID[];
  creativeAssignments: string[];
}

export interface CreativeState {
  creativeId: string;
  formatId: FormatID;
  name?: string;
  status: string;
  syncedAt: string;
  manifest?: { format_id: FormatID; assets: Record<string, unknown> };
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
  brand: BrandRef;
  objectives: string;
  budget: {
    total: number;
    currency: string;
    authorityLevel: string;
    perSellerMaxPct?: number;
    reallocationThreshold?: number;
  };
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
  customPolicies?: string[];
  mode: 'enforce' | 'advisory' | 'audit';
  committedBudget: number;
  syncedAt: string;
}

export interface GovernanceCheckState {
  checkId: string;
  planId: string;
  buyerCampaignRef: string;
  binding: 'proposed' | 'committed';
  status: 'approved' | 'denied' | 'conditions' | 'escalated';
  caller: string;
  tool?: string;
  phase?: string;
  findings: GovernanceFinding[];
  conditions?: GovernanceCondition[];
  escalation?: { reason: string; action?: string };
  explanation: string;
  mode: string;
  categoriesEvaluated: string[];
  policiesEvaluated: string[];
  mediaBuyId?: string;
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
  buyerCampaignRef: string;
  outcomeType: 'completed' | 'failed' | 'delivery';
  committedBudget: number;
  mediaBuyId?: string;
  findings: GovernanceFinding[];
  timestamp: string;
}
