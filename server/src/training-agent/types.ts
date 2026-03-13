/**
 * Internal types for the training agent.
 * Schema-level types (Product, Format, etc.) are used as plain objects
 * matching the JSON schemas in static/schemas/source/.
 */

export interface TrainingContext {
  mode: 'open' | 'training';
  userId?: string;
  moduleId?: string;
  trackId?: string;
  learnerLevel?: 'basics' | 'practitioner' | 'specialist';
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
  doohParameters?: Record<string, unknown>;
  /** For CPA: the event type that triggers billing */
  eventType?: string;
  /** For CPP: demographic targeting parameters */
  cppParameters?: { demographic: string };
  /** For CPV: view threshold parameters */
  cpvParameters?: { view_threshold: Record<string, unknown> };
  /** For time: the time unit and duration constraints */
  timeParameters?: { unit: string; min_duration: number; max_duration: number };
}

export interface CatalogProduct {
  product: Record<string, unknown>;
  publisherId: string;
  trainingTier: 'basics' | 'practitioner' | 'specialist';
  scenarioTags: string[];
}

export interface SessionState {
  mediaBuys: Map<string, MediaBuyState>;
  creatives: Map<string, CreativeState>;
  lastGetProductsContext?: {
    products: Record<string, unknown>[];
    proposals?: Record<string, unknown>[];
  };
  createdAt: Date;
  lastAccessedAt: Date;
}

export interface MediaBuyState {
  mediaBuyId: string;
  buyerRef: string;
  buyerCampaignRef?: string;
  accountRef: Record<string, unknown>;
  brandRef?: Record<string, unknown>;
  status: string;
  currency: string;
  packages: PackageState[];
  startTime: string;
  endTime: string;
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
  startTime: string;
  endTime: string;
  formatIds?: Record<string, unknown>[];
  creativeAssignments: string[];
}

export interface CreativeState {
  creativeId: string;
  formatId: { agent_url: string; id: string };
  name?: string;
  status: string;
  syncedAt: string;
  manifest?: Record<string, unknown>;
}
