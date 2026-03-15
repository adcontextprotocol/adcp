/**
 * Fictional signal provider profiles for the training agent.
 *
 * Each profile represents a different type of data company that provides
 * signals through AdCP. The signal handlers use these to generate
 * schema-compliant get_signals and activate_signal responses.
 */

export interface SignalDefinition {
  signalAgentSegmentId: string;
  name: string;
  description: string;
  valueType: 'binary' | 'categorical' | 'numeric';
  /** For categorical signals */
  categories?: string[];
  /** For numeric signals */
  range?: { min: number; max: number };
  signalType: 'marketplace' | 'custom' | 'owned';
  coveragePercentage: number;
  tags: string[];
  pricingOptions: SignalPricingOption[];
}

export interface SignalPricingOption {
  pricingOptionId: string;
  model: 'cpm' | 'percent_of_media' | 'flat_fee';
  cpm?: number;
  percent?: number;
  maxCpm?: number;
  amount?: number;
  period?: 'monthly' | 'quarterly' | 'annual' | 'campaign';
  currency: string;
}

export interface SignalProviderProfile {
  id: string;
  name: string;
  domain: string;
  description: string;
  providerType: 'data_provider' | 'retailer' | 'publisher' | 'identity' | 'geo' | 'cdp';
  signals: SignalDefinition[];
}

export const SIGNAL_PROVIDERS: SignalProviderProfile[] = [
  // ── Automotive data provider (Polk/IHS Markit analog) ────────────
  {
    id: 'trident_auto',
    name: 'Trident Auto Data',
    domain: 'tridentauto.example',
    description: 'Automotive data provider with vehicle ownership, service history, and purchase propensity models covering 280M US consumers.',
    providerType: 'data_provider',
    signals: [
      {
        signalAgentSegmentId: 'trident_likely_ev_buyers',
        name: 'Likely EV Buyers',
        description: 'Consumers modeled as likely to purchase an electric vehicle in the next 12 months based on vehicle registration, financial, and behavioral data.',
        valueType: 'binary',
        signalType: 'marketplace',
        coveragePercentage: 8,
        tags: ['automotive', 'purchase_intent', 'ev'],
        pricingOptions: [
          { pricingOptionId: 'po_trident_ev_cpm', model: 'cpm', cpm: 3.50, currency: 'USD' },
          { pricingOptionId: 'po_trident_ev_pom', model: 'percent_of_media', percent: 12, maxCpm: 4.00, currency: 'USD' },
        ],
      },
      {
        signalAgentSegmentId: 'trident_vehicle_ownership',
        name: 'Vehicle Ownership Category',
        description: 'Current vehicle category owned by the consumer, derived from registration data.',
        valueType: 'categorical',
        categories: ['luxury_ev', 'luxury_ice', 'midrange', 'economy', 'truck_suv', 'none'],
        signalType: 'marketplace',
        coveragePercentage: 65,
        tags: ['automotive', 'ownership'],
        pricingOptions: [
          { pricingOptionId: 'po_trident_own_cpm', model: 'cpm', cpm: 2.00, currency: 'USD' },
        ],
      },
      {
        signalAgentSegmentId: 'trident_purchase_propensity',
        name: 'Auto Purchase Propensity',
        description: 'Propensity score for purchasing any new vehicle in the next 6 months, based on lease expiration, mileage, and financial signals.',
        valueType: 'numeric',
        range: { min: 0, max: 1 },
        signalType: 'marketplace',
        coveragePercentage: 55,
        tags: ['automotive', 'purchase_intent'],
        pricingOptions: [
          { pricingOptionId: 'po_trident_prop_cpm', model: 'cpm', cpm: 4.00, currency: 'USD' },
        ],
      },
      {
        signalAgentSegmentId: 'trident_service_due',
        name: 'Service Due Soon',
        description: 'Vehicle owners whose estimated next service appointment is within 30 days based on mileage and maintenance history patterns.',
        valueType: 'binary',
        signalType: 'marketplace',
        coveragePercentage: 12,
        tags: ['automotive', 'service'],
        pricingOptions: [
          { pricingOptionId: 'po_trident_svc_cpm', model: 'cpm', cpm: 1.50, currency: 'USD' },
        ],
      },
      {
        signalAgentSegmentId: 'trident_service_history',
        name: 'Vehicle Service History',
        description: 'Vehicle service and maintenance history classification.',
        valueType: 'categorical',
        categories: ['regular_service', 'occasional_service', 'overdue_service', 'no_history'],
        signalType: 'marketplace',
        coveragePercentage: 30,
        tags: ['automotive', 'service', 'behavioral'],
        pricingOptions: [
          { pricingOptionId: 'po_trident_svchist_pom', model: 'percent_of_media', percent: 8, maxCpm: 3.00, currency: 'USD' },
        ],
      },
    ],
  },

  // ── Geo/mobility provider (Skyrise/Placer.ai analog) ─────────────
  {
    id: 'meridian_geo',
    name: 'Meridian Geo',
    domain: 'meridiangeo.example',
    description: 'Location intelligence provider with foot traffic, mobility patterns, and geofenced audience data from 150M opted-in mobile devices.',
    providerType: 'geo',
    signals: [
      {
        signalAgentSegmentId: 'meridian_competitor_visitors',
        name: 'Competitor Store Visitors',
        description: 'Consumers who visited a competitor retail location in the past 30 days, based on verified foot traffic data.',
        valueType: 'binary',
        signalType: 'marketplace',
        coveragePercentage: 6,
        tags: ['geo', 'retail', 'conquest'],
        pricingOptions: [
          { pricingOptionId: 'po_meridian_comp_cpm', model: 'cpm', cpm: 5.00, currency: 'USD' },
        ],
      },
      {
        signalAgentSegmentId: 'meridian_visit_frequency',
        name: 'Location Visit Frequency',
        description: 'Monthly visit count to a specified location category (QSR, grocery, gym, auto dealer, etc.).',
        valueType: 'numeric',
        range: { min: 0, max: 30 },
        signalType: 'marketplace',
        coveragePercentage: 40,
        tags: ['geo', 'frequency', 'behavioral'],
        pricingOptions: [
          { pricingOptionId: 'po_meridian_freq_cpm', model: 'cpm', cpm: 3.00, currency: 'USD' },
        ],
      },
      {
        signalAgentSegmentId: 'meridian_trade_area',
        name: 'Trade Area Residents',
        description: 'Consumers whose primary residence is within a specified trade area (defined by drive time or radius around a point of interest).',
        valueType: 'binary',
        signalType: 'marketplace',
        coveragePercentage: 15,
        tags: ['geo', 'proximity', 'residential'],
        pricingOptions: [
          { pricingOptionId: 'po_meridian_trade_cpm', model: 'cpm', cpm: 2.50, currency: 'USD' },
          { pricingOptionId: 'po_meridian_trade_flat', model: 'flat_fee', amount: 2000, period: 'monthly', currency: 'USD' },
        ],
      },
      {
        signalAgentSegmentId: 'meridian_commute_pattern',
        name: 'Commute Pattern',
        description: 'Categorized daily commute behavior based on observed travel patterns.',
        valueType: 'categorical',
        categories: ['urban_transit', 'suburban_driver', 'remote_worker', 'hybrid'],
        signalType: 'marketplace',
        coveragePercentage: 35,
        tags: ['geo', 'behavioral', 'commute'],
        pricingOptions: [
          { pricingOptionId: 'po_meridian_commute_cpm', model: 'cpm', cpm: 2.00, currency: 'USD' },
        ],
      },
      {
        signalAgentSegmentId: 'meridian_dwell_time',
        name: 'Location Dwell Time',
        description: 'Average dwell time at a location category. Measures minutes spent on-site, distinguishing drive-bys from intentional visits.',
        valueType: 'numeric',
        range: { min: 0, max: 120 },
        signalType: 'marketplace',
        coveragePercentage: 8,
        tags: ['geo', 'behavioral', 'dwell'],
        pricingOptions: [
          { pricingOptionId: 'po_meridian_dwell_cpm', model: 'cpm', cpm: 4.50, currency: 'USD' },
        ],
      },
      {
        signalAgentSegmentId: 'meridian_daypart_visitation',
        name: 'Day-Part Visitation Pattern',
        description: 'Day-part visitation pattern for a location category. Identifies when consumers typically visit specific venue types.',
        valueType: 'categorical',
        categories: ['morning_commute', 'midday', 'evening_commute', 'weekend_daytime', 'weekend_evening'],
        signalType: 'marketplace',
        coveragePercentage: 12,
        tags: ['geo', 'temporal', 'behavioral'],
        pricingOptions: [
          { pricingOptionId: 'po_meridian_daypart_cpm', model: 'cpm', cpm: 3.50, currency: 'USD' },
        ],
      },
    ],
  },

  // ── Retail media / purchase data (ShopGrid's signal side) ────────
  {
    id: 'shopgrid_data',
    name: 'ShopGrid Shopper Insights',
    domain: 'shopgrid.example',
    description: 'First-party purchase data from 200M monthly shoppers. Deterministic signals based on actual transactions, loyalty program membership, and browsing behavior.',
    providerType: 'retailer',
    signals: [
      {
        signalAgentSegmentId: 'shopgrid_category_buyer',
        name: 'Category Buyer',
        description: 'Consumers who purchased in a specified product category in the past 90 days. Categories include electronics, home, beauty, grocery, fashion, sports, toys.',
        valueType: 'categorical',
        categories: ['electronics', 'home', 'beauty', 'grocery', 'fashion', 'sports', 'toys', 'automotive', 'health'],
        signalType: 'marketplace',
        coveragePercentage: 45,
        tags: ['retail', 'purchase', 'category'],
        pricingOptions: [
          { pricingOptionId: 'po_shopgrid_cat_cpm', model: 'cpm', cpm: 4.50, currency: 'USD' },
          { pricingOptionId: 'po_shopgrid_cat_pom', model: 'percent_of_media', percent: 15, maxCpm: 5.00, currency: 'USD' },
        ],
      },
      {
        signalAgentSegmentId: 'shopgrid_loyalty_tier',
        name: 'Loyalty Program Tier',
        description: 'Shopper loyalty program membership level based on purchase frequency and lifetime value.',
        valueType: 'categorical',
        categories: ['platinum', 'gold', 'silver', 'bronze', 'non_member'],
        signalType: 'owned',
        coveragePercentage: 60,
        tags: ['retail', 'loyalty', 'value'],
        pricingOptions: [
          { pricingOptionId: 'po_shopgrid_loy_cpm', model: 'cpm', cpm: 3.00, currency: 'USD' },
        ],
      },
      {
        signalAgentSegmentId: 'shopgrid_basket_value',
        name: 'Average Basket Value',
        description: 'Average transaction value over the past 90 days, normalized to a 0-500 USD range.',
        valueType: 'numeric',
        range: { min: 0, max: 500 },
        signalType: 'owned',
        coveragePercentage: 55,
        tags: ['retail', 'purchase', 'value'],
        pricingOptions: [
          { pricingOptionId: 'po_shopgrid_basket_cpm', model: 'cpm', cpm: 3.50, currency: 'USD' },
        ],
      },
      {
        signalAgentSegmentId: 'shopgrid_new_to_brand',
        name: 'New to Brand',
        description: 'Consumers who have never purchased from a specified brand on the marketplace. Used for conquest and brand awareness campaigns.',
        valueType: 'binary',
        signalType: 'marketplace',
        coveragePercentage: 70,
        tags: ['retail', 'conquest', 'awareness'],
        pricingOptions: [
          { pricingOptionId: 'po_shopgrid_ntb_cpm', model: 'cpm', cpm: 5.00, currency: 'USD' },
        ],
      },
      {
        signalAgentSegmentId: 'shopgrid_purchase_frequency',
        name: 'Purchase Frequency',
        description: 'Monthly purchase count within a product category over the trailing 90 days.',
        valueType: 'numeric',
        range: { min: 0, max: 50 },
        signalType: 'marketplace',
        coveragePercentage: 20,
        tags: ['retail', 'frequency', 'behavioral'],
        pricingOptions: [
          { pricingOptionId: 'po_shopgrid_freq_cpm', model: 'cpm', cpm: 4.00, currency: 'USD' },
        ],
      },
      {
        signalAgentSegmentId: 'shopgrid_brand_affinity',
        name: 'Brand Affinity',
        description: 'Brand loyalty classification based on repeat purchase behavior within a category.',
        valueType: 'categorical',
        categories: ['loyal', 'occasional', 'switcher', 'lapsed'],
        signalType: 'marketplace',
        coveragePercentage: 15,
        tags: ['retail', 'brand', 'loyalty'],
        pricingOptions: [
          { pricingOptionId: 'po_shopgrid_affinity_cpm', model: 'cpm', cpm: 5.50, currency: 'USD' },
        ],
      },
    ],
  },

  // ── Identity resolution (Experian analog) ─────────────────────────
  {
    id: 'keystone_identity',
    name: 'Keystone Identity',
    domain: 'keystoneidentity.example',
    description: 'Identity resolution and consumer data company. Cross-device identity graph covering 250M individuals, plus demographic and financial signals derived from credit and public records.',
    providerType: 'identity',
    signals: [
      {
        signalAgentSegmentId: 'keystone_household_income',
        name: 'Household Income Tier',
        description: 'Estimated household income bracket based on credit-derived models and public records.',
        valueType: 'categorical',
        categories: ['under_50k', '50k_75k', '75k_100k', '100k_150k', '150k_250k', 'over_250k'],
        signalType: 'marketplace',
        coveragePercentage: 72,
        tags: ['demographic', 'income', 'financial'],
        pricingOptions: [
          { pricingOptionId: 'po_keystone_inc_cpm', model: 'cpm', cpm: 2.50, currency: 'USD' },
        ],
      },
      {
        signalAgentSegmentId: 'keystone_life_stage',
        name: 'Life Stage',
        description: 'Consumer life stage classification based on age, household composition, home ownership, and financial indicators.',
        valueType: 'categorical',
        categories: ['young_adult', 'early_career', 'established_family', 'empty_nester', 'retired'],
        signalType: 'marketplace',
        coveragePercentage: 68,
        tags: ['demographic', 'life_stage'],
        pricingOptions: [
          { pricingOptionId: 'po_keystone_life_cpm', model: 'cpm', cpm: 2.00, currency: 'USD' },
        ],
      },
      {
        signalAgentSegmentId: 'keystone_cross_device_reach',
        name: 'Cross-Device Household Reach',
        description: 'Number of identified devices (mobile, desktop, CTV) linked to a household via deterministic identity graph.',
        valueType: 'numeric',
        range: { min: 1, max: 12 },
        signalType: 'marketplace',
        coveragePercentage: 58,
        tags: ['identity', 'cross_device', 'household'],
        pricingOptions: [
          { pricingOptionId: 'po_keystone_xdev_cpm', model: 'cpm', cpm: 1.50, currency: 'USD' },
          { pricingOptionId: 'po_keystone_xdev_pom', model: 'percent_of_media', percent: 8, maxCpm: 3.00, currency: 'USD' },
        ],
      },
      {
        signalAgentSegmentId: 'keystone_credit_active',
        name: 'Active Credit Seeker',
        description: 'Consumers with recent credit inquiry activity suggesting they are actively shopping for financial products (auto loans, mortgages, credit cards).',
        valueType: 'binary',
        signalType: 'marketplace',
        coveragePercentage: 10,
        tags: ['financial', 'in_market', 'credit'],
        pricingOptions: [
          { pricingOptionId: 'po_keystone_credit_cpm', model: 'cpm', cpm: 6.00, currency: 'USD' },
        ],
      },
      {
        signalAgentSegmentId: 'keystone_household_composition',
        name: 'Household Composition',
        description: 'Household composition based on census and survey data.',
        valueType: 'categorical',
        categories: ['single', 'couple_no_children', 'family_young_children', 'family_teens', 'multigenerational'],
        signalType: 'marketplace',
        coveragePercentage: 60,
        tags: ['demographic', 'household', 'identity'],
        pricingOptions: [
          { pricingOptionId: 'po_keystone_household_cpm', model: 'cpm', cpm: 1.75, currency: 'USD' },
        ],
      },
    ],
  },

  // ── Publisher contextual signals (Pinnacle News Group's signal side)
  {
    id: 'pinnacle_signals',
    name: 'Pinnacle News Signals',
    domain: 'pinnaclenews.example',
    description: 'Contextual and first-party subscriber signals from Pinnacle News Group. Content classification, reader engagement, and subscriber data from 15M registered users.',
    providerType: 'publisher',
    signals: [
      {
        signalAgentSegmentId: 'pinnacle_content_category',
        name: 'Content Category',
        description: 'Page-level content classification based on NLP analysis of article text. Categories aligned with IAB Content Taxonomy 3.0.',
        valueType: 'categorical',
        categories: ['news_politics', 'business_finance', 'technology', 'sports', 'entertainment', 'lifestyle', 'health', 'science', 'travel', 'food'],
        signalType: 'owned',
        coveragePercentage: 95,
        tags: ['contextual', 'content', 'iab_taxonomy'],
        pricingOptions: [
          { pricingOptionId: 'po_pinnacle_ctx_cpm', model: 'cpm', cpm: 1.00, currency: 'USD' },
        ],
      },
      {
        signalAgentSegmentId: 'pinnacle_engaged_reader',
        name: 'Engaged Reader',
        description: 'Registered users who read 5+ articles per week and spend 3+ minutes per article on average. High-attention audience.',
        valueType: 'binary',
        signalType: 'owned',
        coveragePercentage: 18,
        tags: ['first_party', 'engagement', 'attention'],
        pricingOptions: [
          { pricingOptionId: 'po_pinnacle_engaged_cpm', model: 'cpm', cpm: 4.00, currency: 'USD' },
        ],
      },
      {
        signalAgentSegmentId: 'pinnacle_subscriber_tenure',
        name: 'Subscriber Tenure',
        description: 'Length of active digital subscription in months. Long-tenured subscribers correlate with higher ad engagement and brand recall.',
        valueType: 'numeric',
        range: { min: 0, max: 120 },
        signalType: 'owned',
        coveragePercentage: 22,
        tags: ['first_party', 'subscriber', 'loyalty'],
        pricingOptions: [
          { pricingOptionId: 'po_pinnacle_tenure_cpm', model: 'cpm', cpm: 3.00, currency: 'USD' },
        ],
      },
      {
        signalAgentSegmentId: 'pinnacle_sentiment',
        name: 'Article Sentiment',
        description: 'Real-time sentiment classification of the article being viewed. Enables brand safety decisions based on content tone.',
        valueType: 'categorical',
        categories: ['positive', 'neutral', 'negative', 'mixed'],
        signalType: 'owned',
        coveragePercentage: 90,
        tags: ['contextual', 'sentiment', 'brand_safety'],
        pricingOptions: [
          { pricingOptionId: 'po_pinnacle_sent_cpm', model: 'cpm', cpm: 0.50, currency: 'USD' },
        ],
      },
      {
        signalAgentSegmentId: 'pinnacle_page_type',
        name: 'Page Type',
        description: 'Classification of the page format: article, video, gallery, opinion, or live coverage. Enables format-aware creative selection.',
        valueType: 'categorical',
        categories: ['article', 'video', 'gallery', 'opinion', 'live'],
        signalType: 'owned',
        coveragePercentage: 95,
        tags: ['contextual', 'format'],
        pricingOptions: [
          { pricingOptionId: 'po_pinnacle_ptype_cpm', model: 'cpm', cpm: 0.25, currency: 'USD' },
        ],
      },
    ],
  },

  // ── CDP first-party data (Adobe analog) ──────────────────────────
  {
    id: 'prism_cdp',
    name: 'Prism CDP',
    domain: 'prismcdp.example',
    description: 'Customer data platform managing first-party audiences for brands. Signals represent brand-authorized audience segments built from CRM, web analytics, and transaction data.',
    providerType: 'cdp',
    signals: [
      {
        signalAgentSegmentId: 'prism_high_ltv',
        name: 'High Lifetime Value Customer',
        description: 'Brand-defined segment of customers in the top 20% by predicted lifetime value. Built from transaction history, engagement frequency, and retention models.',
        valueType: 'binary',
        signalType: 'custom',
        coveragePercentage: 5,
        tags: ['first_party', 'ltv', 'retention'],
        pricingOptions: [
          { pricingOptionId: 'po_prism_ltv_flat', model: 'flat_fee', amount: 5000, period: 'monthly', currency: 'USD' },
        ],
      },
      {
        signalAgentSegmentId: 'prism_cart_abandoner',
        name: 'Cart Abandoner',
        description: 'Users who added items to cart but did not complete purchase in the past 7 days. Real-time segment updated hourly from brand web analytics.',
        valueType: 'binary',
        signalType: 'custom',
        coveragePercentage: 3,
        tags: ['first_party', 'retargeting', 'commerce'],
        pricingOptions: [
          { pricingOptionId: 'po_prism_cart_cpm', model: 'cpm', cpm: 8.00, currency: 'USD' },
        ],
      },
      {
        signalAgentSegmentId: 'prism_engagement_score',
        name: 'Brand Engagement Score',
        description: 'Composite engagement score combining email opens, site visits, app usage, and purchase recency. Higher scores indicate warmer prospects.',
        valueType: 'numeric',
        range: { min: 0, max: 100 },
        signalType: 'custom',
        coveragePercentage: 8,
        tags: ['first_party', 'engagement', 'scoring'],
        pricingOptions: [
          { pricingOptionId: 'po_prism_engage_flat', model: 'flat_fee', amount: 3000, period: 'monthly', currency: 'USD' },
          { pricingOptionId: 'po_prism_engage_cpm', model: 'cpm', cpm: 6.00, currency: 'USD' },
        ],
      },
      {
        signalAgentSegmentId: 'prism_churn_risk',
        name: 'Churn Risk',
        description: 'Customers identified as at-risk of churning based on declining engagement patterns and purchase frequency drop-off.',
        valueType: 'categorical',
        categories: ['low_risk', 'moderate_risk', 'high_risk', 'churned'],
        signalType: 'custom',
        coveragePercentage: 6,
        tags: ['first_party', 'churn', 'retention'],
        pricingOptions: [
          { pricingOptionId: 'po_prism_churn_flat', model: 'flat_fee', amount: 4000, period: 'monthly', currency: 'USD' },
        ],
      },
      {
        signalAgentSegmentId: 'prism_cross_device',
        name: 'Cross-Device Identified',
        description: 'Consumer has been identified across multiple devices within the same household graph.',
        valueType: 'binary',
        signalType: 'custom',
        coveragePercentage: 25,
        tags: ['identity', 'cross_device', 'first_party'],
        pricingOptions: [
          { pricingOptionId: 'po_prism_xdev_cpm', model: 'cpm', cpm: 3.00, currency: 'USD' },
        ],
      },
    ],
  },
];

/** Lookup a signal provider by ID */
export function getSignalProvider(providerId: string): SignalProviderProfile | undefined {
  return SIGNAL_PROVIDERS.find(p => p.id === providerId);
}

/** Get all signals across all providers, optionally filtered */
export function getAllSignals(): Array<SignalDefinition & { providerId: string; providerName: string; providerDomain: string }> {
  return SIGNAL_PROVIDERS.flatMap(provider =>
    provider.signals.map(signal => ({
      ...signal,
      providerId: provider.id,
      providerName: provider.name,
      providerDomain: provider.domain,
    })),
  );
}
