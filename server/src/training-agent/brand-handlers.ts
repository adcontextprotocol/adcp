/**
 * Brand protocol tool definitions and handlers for the training agent.
 *
 * Implements get_brand_identity, get_rights, acquire_rights, and
 * update_rights using fictional talent seed data from Loti Entertainment.
 * Responses are deterministic — built from in-memory data, not LLM calls.
 */

import { randomUUID } from 'node:crypto';
import type { TrainingContext, ToolArgs, RightsGrantState } from './types.js';
import { getSession, sessionKeyFromArgs, MAX_RIGHTS_GRANTS_PER_SESSION } from './state.js';

// ── Types ─────────────────────────────────────────────────────────

interface LocalizedName {
  [lang: string]: string;
}

interface House {
  domain: string;
  name: string;
}

interface Logo {
  url: string;
  variant?: string;
}

interface Tone {
  voice: string;
  attributes: string[];
  dos: string[];
  donts: string[];
}

interface VoiceSynthesisSettings {
  stability?: number;
  language?: string;
}

interface GenerationCredential {
  provider: string;
  rights_key: string;
  uses: string[];
  expires_at: string;
}

interface VoiceSynthesis {
  provider: string;
  voice_id: string;
  settings: VoiceSynthesisSettings;
}

interface PhotographyGuidelines {
  realism: string;
  lighting: string;
  framing: string[];
}

interface VisualGuidelines {
  photography: PhotographyGuidelines;
  restrictions: string[];
}

interface PricingOption {
  pricing_option_id: string;
  model: 'cpm' | 'flat_rate';
  price: number;
  currency: string;
  uses: string[];
  description: string;
  period?: string;
  impression_cap?: number;
  overage_cpm?: number;
}

interface RightsOffering {
  rights_id: string;
  right_type: string;
  available_uses: string[];
  countries: string[];
  exclusivity_status: { available: boolean; existing_exclusives: string[] };
  pricing_options: PricingOption[];
  content_restrictions: string[];
  preview_assets: { url: string; usage: string }[];
}

interface RejectionRule {
  reason: string;
  suggestions?: string[];
}

interface AcquireBehavior {
  auto_approve: string[];
  pending_approval: string[];
  rejected: Record<string, string | RejectionRule>;
}

interface TalentEntry {
  brand_id: string;
  house: House;
  names: LocalizedName[];
  description: string;
  industries: string[];
  keller_type: string;
  tagline: string;
  logos: Logo[];
  colors?: Record<string, string>;
  fonts?: Record<string, string | { family: string; files?: Array<{ url: string; weight?: number; weight_range?: [number, number]; style?: string }>; opentype_features?: string[]; fallbacks?: string[] }>;
  tone: Tone;
  voice_synthesis?: VoiceSynthesis;
  visual_guidelines?: VisualGuidelines;
  rights: {
    available_uses: string[];
    countries: string[];
    exclusivity_model: string;
    content_restrictions: string[];
  };
  rights_offerings: RightsOffering[];
  acquire_behavior: AcquireBehavior;
  exclusion_reasons?: Record<string, string | { reason: string; suggestions?: string[] }>;
}

/** Advertiser brand — brand identity with optional brand asset rights */
interface BrandEntry {
  brand_id: string;
  house: House;
  names: LocalizedName[];
  description: string;
  industries: string[];
  keller_type: string;
  tagline: string;
  logos: Logo[];
  colors?: Record<string, string>;
  fonts?: Record<string, string | { family: string; files?: Array<{ url: string; weight?: number; weight_range?: [number, number]; style?: string }>; opentype_features?: string[]; fallbacks?: string[] }>;
  tone: Tone;
  voice_synthesis?: VoiceSynthesis;
  visual_guidelines?: VisualGuidelines;
  rights?: {
    available_uses: string[];
    countries: string[];
    exclusivity_model: string;
    content_restrictions: string[];
  };
  rights_offerings?: RightsOffering[];
  acquire_behavior?: AcquireBehavior;
}

type AnyBrand = TalentEntry | BrandEntry;

// ── Seed data ─────────────────────────────────────────────────────

const HOUSE: House = {
  domain: 'lotientertainment.com',
  name: 'Loti Entertainment',
};

const TALENT: TalentEntry[] = [
  {
    brand_id: 'daan_janssen',
    house: HOUSE,
    names: [{ en: 'Daan Janssen' }],
    description: 'Dutch Olympic speed skater, 2x gold medalist',
    industries: ['sports'],
    keller_type: 'independent',
    tagline: 'Speed is a choice',
    logos: [
      { url: 'https://cdn.lotientertainment.com/janssen/headshot.jpg', variant: 'primary' },
    ],
    colors: { primary: '#FF6600', secondary: '#1A1A2E', accent: '#FBA007' },
    fonts: { primary: 'Montserrat', secondary: 'Open Sans' },
    tone: {
      voice: 'enthusiastic, warm, competitive',
      attributes: ['athletic', 'Dutch pride', 'approachable'],
      dos: ['Reference athletic achievements', 'Use Dutch cultural touchpoints'],
      donts: ['No injury references', 'No competitor comparisons'],
    },
    voice_synthesis: {
      provider: 'elevenlabs',
      voice_id: 'janssen_v2',
      settings: { stability: 0.7 },
    },
    visual_guidelines: {
      photography: { realism: 'natural', lighting: 'bright, natural', framing: ['medium shot', 'action shot'] },
      restrictions: ['Never place text over the athlete', 'No competitor brand logos in frame'],
    },
    rights: {
      available_uses: ['likeness', 'voice', 'name', 'endorsement'],
      countries: ['NL', 'BE', 'DE'],
      exclusivity_model: 'category',
      content_restrictions: ['approval_required'],
    },
    rights_offerings: [
      {
        rights_id: 'janssen_likeness_voice',
        right_type: 'talent',
        available_uses: ['likeness', 'voice', 'name', 'endorsement'],
        countries: ['NL', 'BE', 'DE'],
        exclusivity_status: { available: true, existing_exclusives: ['sportswear (NL) — through 2026-12-31'] },
        pricing_options: [
          {
            pricing_option_id: 'cpm_endorsement',
            model: 'cpm',
            price: 3.50,
            currency: 'EUR',
            uses: ['likeness'],
            description: 'Per-impression royalty for AI-generated creatives using likeness',
          },
          {
            pricing_option_id: 'monthly_exclusive',
            model: 'flat_rate',
            price: 350,
            currency: 'EUR',
            period: 'monthly',
            uses: ['likeness', 'voice'],
            impression_cap: 100000,
            overage_cpm: 4.00,
            description: 'Monthly exclusive license for likeness + voice, up to 100K impressions',
          },
        ],
        content_restrictions: ['approval_required'],
        preview_assets: [
          { url: 'https://cdn.lotientertainment.com/janssen/headshot.jpg', usage: 'preview_only' },
        ],
      },
    ],
    acquire_behavior: {
      auto_approve: ['food', 'restaurant', 'fitness', 'travel'],
      pending_approval: ['alcohol', 'gambling', 'pharmaceutical'],
      rejected: {
        sportswear: {
          reason: 'Active exclusivity with another brand for sportswear in NL through 2026-12-31',
          suggestions: ['Available for sportswear in BE and DE markets', 'Available in NL after 2027-01-01'],
        },
      },
    },
  },
  {
    brand_id: 'sofia_reyes',
    house: HOUSE,
    names: [{ en: 'Sofia Reyes' }, { es: 'Sofia Reyes' }],
    description: 'Mexican freestyle swimmer, Pan American gold medalist',
    industries: ['sports'],
    keller_type: 'independent',
    tagline: 'Every stroke counts',
    logos: [
      { url: 'https://cdn.lotientertainment.com/reyes/headshot.jpg', variant: 'primary' },
    ],
    tone: {
      voice: 'determined, joyful, bilingual',
      attributes: ['aquatic', 'Latin American pride', 'resilient'],
      dos: ['Reference water/swimming metaphors', 'Bilingual content welcome'],
      donts: ['No weight/body references', 'No rival athlete comparisons'],
    },
    rights: {
      available_uses: ['likeness', 'name', 'endorsement'],
      countries: ['MX', 'US', 'CO', 'AR'],
      exclusivity_model: 'category',
      content_restrictions: ['approval_required'],
    },
    rights_offerings: [
      {
        rights_id: 'reyes_likeness',
        right_type: 'talent',
        available_uses: ['likeness', 'name', 'endorsement'],
        countries: ['MX', 'US', 'CO', 'AR'],
        exclusivity_status: { available: true, existing_exclusives: [] },
        pricing_options: [
          {
            pricing_option_id: 'cpm_likeness',
            model: 'cpm',
            price: 2.80,
            currency: 'USD',
            uses: ['likeness'],
            description: 'Per-impression royalty for AI-generated creatives using likeness',
          },
          {
            pricing_option_id: 'quarterly_bundle',
            model: 'flat_rate',
            price: 900,
            currency: 'USD',
            period: 'quarterly',
            uses: ['likeness', 'name', 'endorsement'],
            impression_cap: 250000,
            overage_cpm: 3.50,
            description: 'Quarterly license for likeness + name + endorsement, up to 250K impressions',
          },
        ],
        content_restrictions: ['approval_required'],
        preview_assets: [
          { url: 'https://cdn.lotientertainment.com/reyes/headshot.jpg', usage: 'preview_only' },
        ],
      },
    ],
    acquire_behavior: {
      auto_approve: ['food', 'beverage', 'fitness', 'health'],
      pending_approval: ['alcohol', 'fashion'],
      rejected: {},
    },
  },
  {
    brand_id: 'pieter_van_dijk',
    house: HOUSE,
    names: [{ en: 'Pieter van Dijk' }, { nl: 'Pieter van Dijk' }],
    description: 'Dutch professional cyclist and vegan lifestyle advocate',
    industries: ['sports'],
    keller_type: 'independent',
    tagline: 'Fueled by plants',
    logos: [
      { url: 'https://cdn.lotientertainment.com/vandijk/headshot.jpg', variant: 'primary' },
    ],
    tone: {
      voice: 'calm, principled, educational',
      attributes: ['endurance', 'sustainability', 'plant-based'],
      dos: ['Reference sustainability and endurance', 'Plant-based nutrition'],
      donts: ['No meat/dairy promotion', 'No fast food'],
    },
    rights: {
      available_uses: ['likeness', 'name', 'endorsement'],
      countries: ['NL', 'BE', 'DE', 'FR'],
      exclusivity_model: 'category',
      content_restrictions: ['approval_required', 'vegan_lifestyle_compatible_only'],
    },
    rights_offerings: [
      {
        rights_id: 'vandijk_likeness',
        right_type: 'talent',
        available_uses: ['likeness', 'name', 'endorsement'],
        countries: ['NL', 'BE', 'DE', 'FR'],
        exclusivity_status: { available: true, existing_exclusives: ['cycling equipment (EU) — through 2027-03-31'] },
        pricing_options: [
          {
            pricing_option_id: 'cpm_likeness',
            model: 'cpm',
            price: 2.00,
            currency: 'EUR',
            uses: ['likeness'],
            description: 'Per-impression royalty for AI-generated creatives',
          },
          {
            pricing_option_id: 'monthly_standard',
            model: 'flat_rate',
            price: 275,
            currency: 'EUR',
            period: 'monthly',
            uses: ['likeness', 'name'],
            impression_cap: 75000,
            overage_cpm: 3.00,
            description: 'Monthly license for likeness + name, up to 75K impressions',
          },
        ],
        content_restrictions: ['approval_required', 'vegan_lifestyle_compatible_only'],
        preview_assets: [
          { url: 'https://cdn.lotientertainment.com/vandijk/headshot.jpg', usage: 'preview_only' },
        ],
      },
    ],
    acquire_behavior: {
      auto_approve: ['cycling', 'fitness', 'plant_based_food', 'sustainability'],
      pending_approval: ['fashion', 'technology'],
      rejected: {
        meat: 'This conflicts with our talent lifestyle guidelines',
        dairy: 'This conflicts with our talent lifestyle guidelines',
        fast_food: 'This conflicts with our talent lifestyle guidelines',
        cycling_equipment: {
          reason: 'Active exclusivity with another brand for cycling equipment in EU through 2027-03-31',
          suggestions: ['Available for cycling equipment outside EU', 'Available in EU after 2027-04-01'],
        },
      },
    },
    exclusion_reasons: {
      steakhouse: { reason: 'Dietary lifestyle conflict with steakhouse brand', suggestions: ['Available for plant-based and health food brands'] },
      steak: { reason: 'Dietary lifestyle conflict with steakhouse brand', suggestions: ['Available for plant-based and health food brands'] },
      meat: { reason: 'Dietary lifestyle conflict with meat brand', suggestions: ['Available for plant-based and health food brands'] },
      burger: { reason: 'Dietary lifestyle conflict with meat brand', suggestions: ['Available for plant-based and health food brands'] },
      bbq: { reason: 'Dietary lifestyle conflict with meat brand', suggestions: ['Available for plant-based and health food brands'] },
    },
  },
  {
    brand_id: 'yuki_tanaka',
    house: HOUSE,
    names: [{ en: 'Yuki Tanaka' }, { ja: '田中ゆき' }],
    description: 'Japanese figure skater, World Championship silver medalist',
    industries: ['sports'],
    keller_type: 'independent',
    tagline: 'Grace under pressure',
    logos: [
      { url: 'https://cdn.lotientertainment.com/tanaka/headshot.jpg', variant: 'primary' },
    ],
    tone: {
      voice: 'graceful, precise, inspiring',
      attributes: ['elegance', 'discipline', 'Japanese aesthetics'],
      dos: ['Reference artistry and discipline', 'Seasonal/nature imagery'],
      donts: ['No aggressive language', 'No direct competitor mentions'],
    },
    voice_synthesis: {
      provider: 'elevenlabs',
      voice_id: 'tanaka_v1',
      settings: { stability: 0.8, language: 'ja' },
    },
    rights: {
      available_uses: ['likeness', 'voice', 'name', 'endorsement'],
      countries: ['JP', 'KR', 'US'],
      exclusivity_model: 'category',
      content_restrictions: ['approval_required'],
    },
    rights_offerings: [
      {
        rights_id: 'tanaka_likeness_voice',
        right_type: 'talent',
        available_uses: ['likeness', 'voice', 'name', 'endorsement'],
        countries: ['JP', 'KR', 'US'],
        exclusivity_status: {
          available: false,
          existing_exclusives: ['cosmetics (JP) — through 2027-06-30'],
        },
        pricing_options: [
          {
            pricing_option_id: 'cpm_voice',
            model: 'cpm',
            price: 5.00,
            currency: 'USD',
            uses: ['voice'],
            description: 'Per-impression royalty for AI-generated voice content',
          },
          {
            pricing_option_id: 'monthly_full',
            model: 'flat_rate',
            price: 500,
            currency: 'USD',
            period: 'monthly',
            uses: ['likeness', 'voice', 'name'],
            impression_cap: 80000,
            overage_cpm: 6.00,
            description: 'Monthly license for full likeness + voice + name, up to 80K impressions',
          },
        ],
        content_restrictions: ['approval_required'],
        preview_assets: [
          { url: 'https://cdn.lotientertainment.com/tanaka/headshot.jpg', usage: 'preview_only' },
        ],
      },
    ],
    acquire_behavior: {
      auto_approve: ['food', 'beverage', 'travel', 'luxury'],
      pending_approval: ['fashion', 'technology', 'entertainment'],
      rejected: {
        cosmetics: {
          reason: 'Active exclusivity with another brand for cosmetics in JP through 2027-06-30',
          suggestions: ['Available for cosmetics outside JP', 'Available in JP after 2027-07-01'],
        },
      },
    },
  },
];

const TALENT_MAP = new Map(TALENT.map(t => [t.brand_id, t]));

// ── Advertiser brand seed data ───────────────────────────────────
// These are fictional brands from the storyboard test kits.
// They have brand identity data but no talent rights.

const ADVERTISER_BRANDS: BrandEntry[] = [
  {
    brand_id: 'acme_outdoor',
    house: { domain: 'acme-outdoor.example.com', name: 'Acme Outdoor' },
    names: [{ en: 'Acme Outdoor' }],
    description: 'Premium outdoor gear for every adventure. From trail to summit, we make gear that performs.',
    industries: ['retail'],
    keller_type: 'master',
    tagline: 'Built for the Trail',
    logos: [
      { url: 'https://test-assets.adcontextprotocol.org/acme-outdoor/logo-primary.png', variant: 'primary' },
      { url: 'https://test-assets.adcontextprotocol.org/acme-outdoor/logo-icon.png', variant: 'icon' },
    ],
    colors: { primary: '#1B5E20', secondary: '#FF6F00', accent: '#FDD835', background: '#FAFAFA', text: '#212121' },
    fonts: { heading: 'Montserrat', body: 'Open Sans' },
    tone: {
      voice: 'Confident and adventurous, but never pretentious. We talk to people who do things, not people who buy things.',
      attributes: ['active', 'direct', 'warm'],
      dos: ['Use action verbs', 'Reference real outdoor activities', 'Keep it short'],
      donts: ['Use superlatives without evidence', 'Talk down to the reader', 'Use corporate jargon'],
    },
    rights: {
      available_uses: ['ai_generated_image', 'ai_generated_copy', 'brand_assets'],
      countries: ['US', 'CA', 'GB', 'DE', 'FR'],
      exclusivity_model: 'non_exclusive',
      content_restrictions: ['approval_required'],
    },
    rights_offerings: [
      {
        rights_id: 'acme_brand_assets',
        right_type: 'brand',
        available_uses: ['ai_generated_image', 'ai_generated_copy', 'brand_assets'],
        countries: ['US', 'CA', 'GB', 'DE', 'FR'],
        exclusivity_status: { available: true, existing_exclusives: [] },
        pricing_options: [
          {
            pricing_option_id: 'standard_monthly',
            model: 'flat_rate' as const,
            price: 500,
            currency: 'USD',
            period: 'monthly',
            uses: ['ai_generated_image', 'ai_generated_copy', 'brand_assets'],
            impression_cap: 500000,
            overage_cpm: 2.00,
            description: 'Monthly license for AI-generated brand content, up to 500K impressions',
          },
          {
            pricing_option_id: 'per_impression',
            model: 'cpm' as const,
            price: 1.50,
            currency: 'USD',
            uses: ['ai_generated_image'],
            description: 'Per-impression rate for AI-generated image creatives',
          },
        ],
        content_restrictions: ['approval_required'],
        preview_assets: [
          { url: 'https://test-assets.adcontextprotocol.org/acme-outdoor/logo-primary.png', usage: 'preview_only' },
        ],
      },
    ],
    acquire_behavior: {
      auto_approve: ['outdoor', 'fitness', 'travel', 'adventure', 'advertising'],
      pending_approval: ['food', 'beverage'],
      rejected: {},
    },
  },
];

const BRAND_MAP = new Map<string, AnyBrand>([
  ...TALENT.map(t => [t.brand_id, t] as [string, AnyBrand]),
  ...ADVERTISER_BRANDS.map(b => [b.brand_id, b] as [string, AnyBrand]),
]);

// Fields that are always returned (public, not selectable)
const PUBLIC_FIELDS = ['description', 'industries', 'keller_type', 'logos', 'tagline'] as const;
const AUTHORIZED_FIELDS = ['colors', 'fonts', 'visual_guidelines', 'tone', 'voice_synthesis', 'assets', 'rights'] as const;
const ALL_FIELDS = [...PUBLIC_FIELDS, ...AUTHORIZED_FIELDS] as const;

// ── Tool definitions ──────────────────────────────────────────────

export const BRAND_TOOLS = [
  {
    name: 'get_brand_identity',
    description: 'Get brand identity data. Returns public data by default. Set authorized=true to simulate a linked account and see all fields (colors, fonts, tone, voice synthesis, rights). Available brands: daan_janssen, sofia_reyes, pieter_van_dijk, yuki_tanaka, acme_outdoor.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    execution: { taskSupport: 'forbidden' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        brand_id: { type: 'string', description: 'Brand identifier (e.g., daan_janssen, sofia_reyes)' },
        fields: { type: 'array', items: { type: 'string' }, description: 'Sections to include: description, industries, keller_type, logos, colors, fonts, visual_guidelines, tone, tagline, voice_synthesis, assets, rights. Omit for all.' },
        use_case: { type: 'string', description: 'Intended use case: endorsement, voice_synthesis, likeness, creative_production, media_planning' },
        authorized: { type: 'boolean', description: 'Simulate authorized caller (linked via sync_accounts). Default false.' },
      },
      required: ['brand_id'],
    },
  },
  {
    name: 'get_rights',
    description: 'Search for licensable talent rights. Returns matches with pricing options. Supports natural language queries — interprets intent, budget, and geography. Set include_excluded=true to see filtered-out talent with reasons.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Natural language description of desired rights' },
        uses: { type: 'array', items: { type: 'string' }, description: 'Rights uses: likeness, voice, name, endorsement' },
        buyer_brand: { type: 'object', description: 'Buyer brand for compatibility filtering' },
        countries: { type: 'array', items: { type: 'string' }, description: 'Countries where rights are needed (ISO 3166-1 alpha-2)' },
        brand_id: { type: 'string', description: 'Search within a specific brand only' },
        include_excluded: { type: 'boolean', description: 'Include filtered-out results with reasons. Default false.' },
      },
      required: ['query', 'uses'],
    },
  },
  {
    name: 'acquire_rights',
    description: 'Acquire rights from the talent roster. Returns acquired (with generation credentials), pending_approval, or rejected based on campaign category and existing contracts.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        rights_id: { type: 'string', description: 'Rights offering identifier from get_rights' },
        pricing_option_id: { type: 'string', description: 'Selected pricing option' },
        buyer: {
          type: 'object',
          properties: { domain: { type: 'string' }, brand_id: { type: 'string' } },
          required: ['domain'],
          description: 'Buyer brand identity',
        },
        campaign: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            uses: { type: 'array', items: { type: 'string' } },
            countries: { type: 'array', items: { type: 'string' } },
            estimated_impressions: { type: 'integer' },
            start_date: { type: 'string' },
            end_date: { type: 'string' },
          },
          required: ['description', 'uses'],
          description: 'Campaign details for rights clearance',
        },
      },
      required: ['rights_id', 'pricing_option_id', 'buyer', 'campaign'],
    },
  },
  {
    name: 'update_rights',
    description: 'Update an existing rights grant — extend dates, adjust impression caps, or pause/resume.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        rights_id: { type: 'string', description: 'Rights grant identifier from acquire_rights' },
        end_date: { type: 'string', description: 'New end date (must be >= current end date)' },
        impression_cap: { type: 'number', description: 'New impression cap (must be >= current)' },
        paused: { type: 'boolean', description: 'Pause or resume the grant' },
      },
      required: ['rights_id'],
    },
  },
  {
    name: 'creative_approval',
    description: 'Submit a generated creative for brand approval. The brand agent reviews the creative against identity guidelines and rights grant terms. Returns approved, rejected, or pending_review.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        rights_id: { type: 'string', description: 'Rights grant this creative was produced under' },
        rights_grant_id: { type: 'string', description: 'Alias for rights_id' },
        creative_url: { type: 'string', description: 'URL where the creative asset can be retrieved for review' },
        creative_id: { type: 'string', description: 'Buyer-assigned creative identifier' },
        creative_format: { type: 'string', description: 'Format of the creative being submitted' },
        creative: {
          type: 'object',
          description: 'Creative object with creative_id, format, and assets',
          properties: {
            creative_id: { type: 'string' },
            format: { type: 'string' },
            assets: { type: 'array' },
          },
        },
        description: { type: 'string', description: 'Description of the creative for reviewer context' },
        metadata: { type: 'object', description: 'Additional creative metadata' },
        idempotency_key: { type: 'string', description: 'Client-generated key for safe retries' },
      },
      required: ['rights_id', 'creative_url'],
    },
  },
];

// ── Handlers ──────────────────────────────────────────────────────

export function handleGetBrandIdentity(
  args: ToolArgs,
  _ctx: TrainingContext,
) {
  const req = args as { brand_id: string; fields?: string[]; authorized?: boolean };
  const brandId = req.brand_id;
  const fields = req.fields;
  const authorized = req.authorized ?? false;

  const talent = BRAND_MAP.get(brandId);
  if (!talent) {
    return { errors: [{ code: 'brand_not_found', message: `No brand with id '${brandId}'` }] };
  }

  // Dynamic field access by name — TalentEntry has no index signature
  const talentRecord = talent as unknown as { [key: string]: unknown };
  const response: { [key: string]: unknown } = {
    brand_id: talent.brand_id,
    house: talent.house,
    names: talent.names,
    sandbox: true,
  };

  const requested = fields ?? [...ALL_FIELDS];
  const withheld: string[] = [];

  for (const field of requested) {
    if ((PUBLIC_FIELDS as readonly string[]).includes(field)) {
      const value = talentRecord[field];
      if (value !== undefined) {
        response[field] = value;
      }
    } else if ((AUTHORIZED_FIELDS as readonly string[]).includes(field)) {
      if (authorized) {
        const value = talentRecord[field];
        if (value !== undefined) {
          response[field] = value;
        }
      } else {
        const value = talentRecord[field];
        if (value !== undefined) {
          withheld.push(field);
        }
      }
    }
  }

  if (withheld.length > 0) {
    response.available_fields = withheld;
  }

  return response;
}

function computeMatchScore(
  talent: TalentEntry,
  queryLower: string,
  requestedUses: string[],
  requestedCountries?: string[],
): number {
  let score = 0.2;

  if (requestedCountries && requestedCountries.length > 0) {
    const overlap = requestedCountries.filter(c => talent.rights.countries.includes(c));
    if (overlap.length > 0) score += 0.3;
  } else {
    const countryHints: Record<string, string[]> = {
      NL: ['dutch', 'netherlands', 'amsterdam', 'rotterdam', 'nl'],
      MX: ['mexican', 'mexico', 'mx'],
      JP: ['japanese', 'japan', 'tokyo', 'jp'],
      US: ['american', 'usa', 'us', 'united states'],
    };
    for (const [code, hints] of Object.entries(countryHints)) {
      if (hints.some(h => queryLower.includes(h)) && talent.rights.countries.includes(code)) {
        score += 0.3;
        break;
      }
    }
  }

  const availableUses = talent.rights.available_uses;
  const useOverlap = requestedUses.filter(u => availableUses.includes(u));
  if (requestedUses.length > 0) {
    score += 0.3 * (useOverlap.length / requestedUses.length);
  }

  const budgetMatch = queryLower.match(/(\d+)\s*(eur|usd|€|\$)/);
  if (budgetMatch) {
    const budget = parseInt(budgetMatch[1], 10);
    const flatRate = talent.rights_offerings[0]?.pricing_options.find(p => p.model === 'flat_rate');
    if (flatRate && flatRate.price <= budget) {
      score += 0.2;
    }
  }

  return Math.min(score, 1.0);
}

function buildMatchReasons(
  talent: TalentEntry,
  queryLower: string,
  requestedUses: string[],
): string[] {
  const reasons: string[] = [];

  const countries = talent.rights.countries.join(', ');
  if (queryLower.includes('dutch') || queryLower.includes('netherlands') || queryLower.includes('amsterdam')) {
    if (talent.rights.countries.includes('NL')) {
      reasons.push(`Available in the Netherlands (${countries})`);
    }
  } else if (queryLower.includes('japan') || queryLower.includes('japanese')) {
    if (talent.rights.countries.includes('JP')) {
      reasons.push(`Available in Japan (${countries})`);
    }
  } else {
    reasons.push(`Available in ${countries}`);
  }

  const availableUses = talent.rights.available_uses;
  const matched = requestedUses.filter(u => availableUses.includes(u));
  if (matched.length > 0) {
    reasons.push(`Supports requested uses: ${matched.join(', ')}`);
  }

  const budgetMatch = queryLower.match(/(\d+)\s*(eur|usd|€|\$)/);
  if (budgetMatch) {
    const budget = parseInt(budgetMatch[1], 10);
    const flatRate = talent.rights_offerings[0]?.pricing_options.find(p => p.model === 'flat_rate');
    if (flatRate && flatRate.price <= budget) {
      reasons.push(`Within budget at ${flatRate.price} ${flatRate.currency}/${flatRate.period}`);
    }
  }

  if (queryLower.includes('restaurant') || queryLower.includes('food') || queryLower.includes('steakhouse')) {
    reasons.push('Available for food/restaurant brands');
  }
  if (queryLower.includes('athlete') || queryLower.includes('sport')) {
    reasons.push(`${talent.industries.join('/')} talent`);
  }

  return reasons;
}

type RightsHolder = TalentEntry | (BrandEntry & { rights: NonNullable<BrandEntry['rights']>; rights_offerings: RightsOffering[] });

function isTalentEntry(brand: AnyBrand): brand is TalentEntry {
  return TALENT_MAP.has(brand.brand_id);
}

/** Find a session grant by grant ID or by offering rights_id */
function findSessionGrant(session: { rightsGrants: Map<string, import('./types.js').RightsGrantState> }, id: string): import('./types.js').RightsGrantState | undefined {
  const direct = session.rightsGrants.get(id);
  if (direct) return direct;
  // Agent may have passed the offering rights_id; find the grant for it
  for (const g of session.rightsGrants.values()) {
    if (g.rightsId === id) return g;
  }
  return undefined;
}

/** Get all brands that have rights offerings (talent + advertiser brands with rights) */
function getRightsHolders(): RightsHolder[] {
  const holders: RightsHolder[] = [...TALENT];
  for (const brand of ADVERTISER_BRANDS) {
    if (brand.rights && brand.rights_offerings && brand.rights_offerings.length > 0) {
      holders.push(brand as BrandEntry & { rights: NonNullable<BrandEntry['rights']>; rights_offerings: RightsOffering[] });
    }
  }
  return holders;
}

function getBrandName(brand: AnyBrand): string {
  return brand.names[0]?.[Object.keys(brand.names[0])[0]] || brand.brand_id;
}

export function handleGetRights(
  args: ToolArgs,
  _ctx: TrainingContext,
) {
  const req = args as { query?: string; uses?: string[]; countries?: string[]; brand_id?: string; include_excluded?: boolean; buyer_brand?: { domain?: string; brand_id?: string } };
  const query = req.query || '';
  const uses = req.uses || [];
  const countries = req.countries;
  const brandId = req.brand_id;
  const includeExcluded = req.include_excluded ?? false;

  const queryLower = query.toLowerCase();

  const allHolders = getRightsHolders();
  let candidates = brandId ? allHolders.filter(t => t.brand_id === brandId) : allHolders;

  if (countries && countries.length > 0) {
    candidates = candidates.filter(t =>
      countries.some(c => t.rights.countries.includes(c))
    );
  }

  if (uses.length > 0) {
    candidates = candidates.filter(t =>
      uses.some(u => t.rights.available_uses.includes(u))
    );
  }

  const rights: Array<RightsOffering & { brand_id: string; name: string; description: string; match_score: number; match_reasons: string[] }> = [];
  const excluded: Array<{ brand_id: string; name: string; reason: string; suggestions?: string[] }> = [];

  for (const holder of candidates) {
    // Only TalentEntry has exclusion_reasons
    const talentHolder = holder as TalentEntry;
    let excludeRule: { reason: string; suggestions?: string[] } | null = null;
    if (talentHolder.exclusion_reasons) {
      for (const [keyword, rule] of Object.entries(talentHolder.exclusion_reasons)) {
        if (queryLower.includes(keyword)) {
          excludeRule = typeof rule === 'object' ? rule : { reason: rule };
          break;
        }
      }
    }

    if (excludeRule) {
      if (includeExcluded) {
        excluded.push({
          brand_id: holder.brand_id,
          name: getBrandName(holder),
          reason: excludeRule.reason,
          ...(excludeRule.suggestions ? { suggestions: excludeRule.suggestions } : {}),
        });
      }
      continue;
    }

    // Use talent-specific scoring for TalentEntry, simplified scoring for BrandEntry
    const matchScore = isTalentEntry(holder)
      ? computeMatchScore(holder, queryLower, uses, countries)
      : computeBrandMatchScore(holder, uses, countries);
    const matchReasons = isTalentEntry(holder)
      ? buildMatchReasons(holder, queryLower, uses)
      : buildBrandMatchReasons(holder, uses);

    for (const offering of holder.rights_offerings) {
      rights.push({
        rights_id: offering.rights_id,
        brand_id: holder.brand_id,
        name: getBrandName(holder),
        description: holder.description,
        right_type: offering.right_type,
        match_score: Math.round(matchScore * 100) / 100,
        match_reasons: matchReasons,
        available_uses: offering.available_uses,
        countries: offering.countries,
        exclusivity_status: offering.exclusivity_status,
        pricing_options: offering.pricing_options,
        content_restrictions: offering.content_restrictions,
        preview_assets: offering.preview_assets,
      });
    }
  }

  rights.sort((a, b) => b.match_score - a.match_score);

  return {
    rights,
    sandbox: true,
    ...(includeExcluded && excluded.length > 0 && { excluded }),
  };
}

function computeBrandMatchScore(
  brand: AnyBrand & { rights: { available_uses: string[]; countries: string[] } },
  requestedUses: string[],
  requestedCountries?: string[],
): number {
  let score = 0.5;
  if (requestedCountries && requestedCountries.length > 0) {
    const overlap = requestedCountries.filter(c => brand.rights.countries.includes(c));
    if (overlap.length > 0) score += 0.3;
  }
  if (requestedUses.length > 0) {
    const useOverlap = requestedUses.filter(u => brand.rights.available_uses.includes(u));
    score += 0.2 * (useOverlap.length / requestedUses.length);
  }
  return Math.min(score, 1.0);
}

function buildBrandMatchReasons(
  brand: AnyBrand & { rights: { available_uses: string[]; countries: string[] } },
  requestedUses: string[],
): string[] {
  const reasons: string[] = [];
  reasons.push(`Available in ${brand.rights.countries.join(', ')}`);
  const matched = requestedUses.filter(u => brand.rights.available_uses.includes(u));
  if (matched.length > 0) {
    reasons.push(`Supports requested uses: ${matched.join(', ')}`);
  }
  reasons.push(`Brand asset licensing from ${getBrandName(brand)}`);
  return reasons;
}

interface AcquireRightsArgs {
  rights_id: string;
  pricing_option_id: string;
  buyer?: { domain: string; brand_id?: string };
  campaign: {
    description: string;
    uses: string[];
    countries?: string[];
    estimated_impressions?: number;
    start_date?: string;
    end_date?: string;
  };
}

/** Find a rights offering across all brands (talent + advertiser) */
function findRightsOffering(rightsId: string): { brand: AnyBrand; offering: RightsOffering; behavior: AcquireBehavior } | null {
  for (const t of TALENT) {
    const o = t.rights_offerings.find(r => r.rights_id === rightsId);
    if (o) return { brand: t, offering: o, behavior: t.acquire_behavior };
  }
  for (const b of ADVERTISER_BRANDS) {
    const o = b.rights_offerings?.find(r => r.rights_id === rightsId);
    if (o && b.acquire_behavior) return { brand: b, offering: o, behavior: b.acquire_behavior };
  }
  return null;
}

export function handleAcquireRights(
  args: ToolArgs,
  ctx: TrainingContext,
) {
  const req = args as AcquireRightsArgs;
  const rightsId = req.rights_id;
  const pricingOptionId = req.pricing_option_id;
  const buyer = req.buyer;
  const campaign = req.campaign;

  if (!buyer) {
    return { errors: [{ code: 'invalid_request', message: 'buyer is required' }] };
  }

  const found = findRightsOffering(rightsId);
  if (!found) {
    return { errors: [{ code: 'rights_not_found', message: `No rights offering with id '${rightsId}'` }] };
  }

  const { brand: talent, offering, behavior } = found;

  const pricingOption = offering.pricing_options.find(p => p.pricing_option_id === pricingOptionId);
  if (!pricingOption) {
    return { errors: [{ code: 'invalid_pricing_option', message: `No pricing option '${pricingOptionId}' in offering '${rightsId}'` }] };
  }

  if (!campaign?.description) {
    return { errors: [{ code: 'invalid_request', message: 'campaign.description is required' }] };
  }

  const descLower = campaign.description.toLowerCase();

  for (const [keyword, rule] of Object.entries(behavior.rejected)) {
    if (descLower.includes(keyword)) {
      const isStructured = typeof rule === 'object';
      return {
        rights_id: rightsId,
        status: 'rejected',
        brand_id: talent.brand_id,
        reason: isStructured ? rule.reason : rule,
        ...(isStructured && rule.suggestions ? { suggestions: rule.suggestions } : {}),
        sandbox: true,
      };
    }
  }

  for (const keyword of behavior.pending_approval) {
    if (descLower.includes(keyword)) {
      const brandName = getBrandName(talent);
      return {
        rights_id: rightsId,
        status: 'pending_approval',
        brand_id: talent.brand_id,
        detail: `${brandName}'s management requires review for ${keyword} category campaigns. Request submitted for approval.`,
        estimated_response_time: '48h',
        sandbox: true,
      };
    }
  }

  const brandName = getBrandName(talent);
  const startDate = campaign.start_date || '2026-04-01';
  const endDate = campaign.end_date || '2026-06-30';
  const grantId = `rg_${randomUUID().slice(0, 8)}`;

  const generationCredentials: GenerationCredential[] = [];
  const campaignUses = campaign.uses || pricingOption.uses;

  if (campaignUses.includes('likeness') || campaignUses.includes('ai_generated_image')) {
    generationCredentials.push({
      provider: 'midjourney',
      rights_key: `rk_mj_sandbox_${talent.brand_id}_${Date.now().toString(36)}`,
      uses: campaignUses.filter(u => ['likeness', 'ai_generated_image'].includes(u)),
      expires_at: `${endDate}T23:59:59Z`,
    });
  }

  if (campaignUses.includes('voice') && isTalentEntry(talent) && talent.voice_synthesis) {
    generationCredentials.push({
      provider: 'elevenlabs',
      rights_key: `rk_el_sandbox_${talent.brand_id}_${Date.now().toString(36)}`,
      uses: ['voice'],
      expires_at: `${endDate}T23:59:59Z`,
    });
  }

  // Store the grant in session for creative_approval validation
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));
  if (session.rightsGrants.size >= MAX_RIGHTS_GRANTS_PER_SESSION) {
    return { errors: [{ code: 'LIMIT_EXCEEDED', message: `Session limit reached (max ${MAX_RIGHTS_GRANTS_PER_SESSION} rights grants).` }] };
  }
  session.rightsGrants.set(grantId, {
    grantId,
    rightsId,
    brandId: talent.brand_id,
    buyerDomain: buyer.domain,
    status: 'acquired',
    pricingOptionId,
    startDate,
    endDate,
    impressionCap: pricingOption.impression_cap,
    paused: false,
    createdAt: new Date().toISOString(),
  });

  return {
    rights_id: rightsId,
    rights_grant_id: grantId,
    status: 'acquired',
    brand_id: talent.brand_id,
    terms: {
      pricing_option_id: pricingOptionId,
      amount: pricingOption.price,
      currency: pricingOption.currency,
      ...(pricingOption.period ? { period: pricingOption.period } : {}),
      uses: pricingOption.uses,
      ...(pricingOption.impression_cap ? { impression_cap: pricingOption.impression_cap } : {}),
      ...(pricingOption.overage_cpm ? { overage_cpm: pricingOption.overage_cpm } : {}),
      start_date: startDate,
      end_date: endDate,
      exclusivity: {
        scope: `Licensee for ${brandName} in ${(campaign.countries || offering.countries).join(', ')} for requested campaign category`,
        countries: campaign.countries || offering.countries,
      },
    },
    generation_credentials: generationCredentials,
    restrictions: [
      'All generated creatives must be submitted for approval before distribution',
      'No modification of brand assets beyond approved AI generation parameters',
    ],
    disclosure: {
      required: true,
      text: `Features AI-generated content using ${brandName} brand assets, used under license`,
    },
    rights_constraint: {
      rights_id: rightsId,
      rights_agent: { url: `https://${talent.house.domain}/mcp`, id: talent.house.domain },
      valid_from: `${startDate}T00:00:00Z`,
      valid_until: `${endDate}T23:59:59Z`,
      uses: campaignUses,
      countries: campaign.countries || offering.countries,
      ...(pricingOption.impression_cap ? { impression_cap: pricingOption.impression_cap } : {}),
      approval_status: 'approved',
      verification_url: `https://sandbox.${talent.house.domain}/rights/${rightsId}/verify`,
    },
    approval_webhook: {
      url: `https://sandbox.${talent.house.domain}/rights/${grantId}/approve`,
      authentication: {
        schemes: ['Bearer'],
        credentials: `rk_approve_sandbox_${grantId}_token_min_32_chars`,
      },
    },
    usage_reporting_url: `https://sandbox.${talent.house.domain}/rights/${grantId}/usage`,
    sandbox: true,
  };
}

export function handleUpdateRights(
  args: ToolArgs,
  ctx: TrainingContext,
) {
  const req = args as { rights_id?: string; rights_grant_id?: string; end_date?: string; impression_cap?: number; paused?: boolean; updates?: { end_date?: string; impression_cap?: number } };
  const rightsId = req.rights_id || req.rights_grant_id;
  const endDate = req.end_date ?? req.updates?.end_date;
  const impressionCap = req.impression_cap ?? req.updates?.impression_cap;
  const paused = req.paused;

  if (!rightsId) {
    return { errors: [{ code: 'invalid_request', message: 'rights_id or rights_grant_id is required' }] };
  }

  // First check session grants (from acquire_rights)
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));
  const grant = findSessionGrant(session, rightsId);

  const offeringRightsId = grant ? grant.rightsId : rightsId;

  const found = findRightsOffering(offeringRightsId);
  if (!found) {
    return { errors: [{ code: 'rights_not_found', message: `No active grant with id '${rightsId}'` }] };
  }

  const { brand: talent, offering } = found;

  const currentEndDate = grant?.endDate || '2026-06-30';
  const currentStartDate = grant?.startDate || '2026-04-01';
  if (endDate && endDate < currentEndDate) {
    return { errors: [{ code: 'invalid_update', message: 'New end_date must be >= current end_date' }] };
  }

  const deliveredImpressions = 50000;
  if (impressionCap !== undefined && impressionCap < deliveredImpressions) {
    return { errors: [{ code: 'invalid_update', message: `New impression_cap (${impressionCap}) must be >= impressions already delivered (${deliveredImpressions})` }] };
  }

  const pricingOption = offering.pricing_options[0];
  const effectiveEndDate = endDate || currentEndDate;
  const effectiveImpressionCap = impressionCap ?? pricingOption.impression_cap;

  const brandName = getBrandName(talent);
  const campaignUses = pricingOption.uses;

  const generationCredentials: GenerationCredential[] = [];

  if (campaignUses.includes('likeness') || campaignUses.includes('ai_generated_image')) {
    generationCredentials.push({
      provider: 'midjourney',
      rights_key: `rk_mj_sandbox_${talent.brand_id}_${Date.now().toString(36)}`,
      uses: campaignUses.filter(u => ['likeness', 'ai_generated_image'].includes(u)),
      expires_at: `${effectiveEndDate}T23:59:59Z`,
    });
  }

  if (campaignUses.includes('voice') && isTalentEntry(talent) && talent.voice_synthesis) {
    generationCredentials.push({
      provider: 'elevenlabs',
      rights_key: `rk_el_sandbox_${talent.brand_id}_${Date.now().toString(36)}`,
      uses: ['voice'],
      expires_at: `${effectiveEndDate}T23:59:59Z`,
    });
  }

  // Update grant in session if it exists
  if (grant) {
    if (endDate) grant.endDate = endDate;
    if (impressionCap !== undefined) grant.impressionCap = impressionCap;
    if (paused !== undefined) grant.paused = paused;
  }

  return {
    rights_id: offeringRightsId,
    rights_grant_id: grant?.grantId || rightsId,
    terms: {
      pricing_option_id: pricingOption.pricing_option_id,
      amount: pricingOption.price,
      currency: pricingOption.currency,
      ...(pricingOption.period ? { period: pricingOption.period } : {}),
      uses: pricingOption.uses,
      ...(effectiveImpressionCap ? { impression_cap: effectiveImpressionCap } : {}),
      ...(pricingOption.overage_cpm ? { overage_cpm: pricingOption.overage_cpm } : {}),
      start_date: currentStartDate,
      end_date: effectiveEndDate,
      exclusivity: {
        scope: `Licensee for ${brandName} in ${offering.countries.join(', ')} for requested campaign category`,
        countries: offering.countries,
      },
    },
    generation_credentials: generationCredentials,
    rights_constraint: {
      rights_id: offeringRightsId,
      rights_agent: { url: `https://${talent.house.domain}/mcp`, id: talent.house.domain },
      valid_from: `${currentStartDate}T00:00:00Z`,
      valid_until: `${effectiveEndDate}T23:59:59Z`,
      uses: campaignUses,
      countries: offering.countries,
      ...(effectiveImpressionCap ? { impression_cap: effectiveImpressionCap } : {}),
      approval_status: 'approved',
      verification_url: `https://sandbox.${talent.house.domain}/rights/${offeringRightsId}/verify`,
    },
    implementation_date: new Date().toISOString(),
    ...(paused !== undefined && { paused }),
    sandbox: true,
  };
}

export function handleCreativeApproval(
  args: ToolArgs,
  ctx: TrainingContext,
) {
  const req = args as {
    rights_id?: string;
    rights_grant_id?: string;
    creative_url?: string;
    creative_id?: string;
    creative_format?: string;
    creative?: { creative_id?: string; format?: string; assets?: Array<{ asset_type?: string; url?: string }> };
    description?: string;
  };

  const rightsId = req.rights_id || req.rights_grant_id;
  if (!rightsId) {
    return { errors: [{ code: 'invalid_request', message: 'rights_id or rights_grant_id is required' }] };
  }

  // Validate that the grant exists in the session
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));
  const grant = findSessionGrant(session, rightsId);

  // Also check if it's a known rights offering ID (for direct rights_id usage)
  const isKnownOffering = findRightsOffering(rightsId) !== null;

  if (!grant && !isKnownOffering) {
    return { errors: [{ code: 'rights_not_found', message: `No active rights grant with id '${rightsId}'. Acquire rights first using acquire_rights.` }] };
  }

  const creativeUrl = req.creative_url || req.creative?.assets?.[0]?.url;
  if (!creativeUrl) {
    return { errors: [{ code: 'invalid_request', message: 'creative_url or creative.assets[].url is required' }] };
  }

  const creativeId = req.creative_id || req.creative?.creative_id || 'sandbox_creative';
  const creativeFormat = req.creative_format || req.creative?.format;

  return {
    status: 'approved',
    decision: 'approved',
    rights_id: grant?.rightsId || rightsId,
    rights_grant_id: grant?.grantId || rightsId,
    creative_id: creativeId,
    creative_url: creativeUrl,
    ...(creativeFormat ? { creative_format: creativeFormat } : {}),
    approved_at: new Date().toISOString(),
    conditions: ['Sandbox approval — not valid for production distribution'],
    sandbox: true,
  };
}
