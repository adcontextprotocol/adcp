/**
 * Brand architecture classification via LLM
 *
 * Uses a single structured Sonnet call to classify a brand's position
 * in a corporate brand architecture (Keller model) given Brandfetch data.
 *
 * SECURITY: `house_domain` and `confidence` from this classifier are
 * authorization-relevant — autoLinkByVerifiedDomain (membership-db.ts) walks
 * brands.house_domain to inherit child-brand employees into a paying parent
 * org's WorkOS membership, gated on `confidence='high'`. Today the input
 * fields (brandData.* below) come from Brandfetch + crawled homepage
 * metadata, which we treat as trusted-but-third-party. If a less-trusted
 * source is ever added (user-submitted manifests, scraped competitor sites,
 * untrusted enrichment APIs), reassess prompt-injection exposure: the
 * classifier's house_domain output decides which paying org's membership a
 * new user gets. The brand_html_summary, company.industries, and
 * raw.links fields are the most attacker-controllable surfaces.
 */

import Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '../logger.js';
import { ModelConfig } from '../config/models.js';
import type { KellerType } from '../types.js';
import type { BrandfetchEnrichmentResult } from './brandfetch.js';

const logger = createLogger('brand-classifier');

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic();
  }
  return client;
}

export interface BrandClassification {
  keller_type: KellerType;
  house_domain: string | null;
  parent_brand: string | null;
  canonical_domain: string;
  related_domains: string[];
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
}

const CLASSIFY_PROMPT = `You are classifying a brand's position in a corporate brand architecture (Keller model).

Definitions:
- "master": Top-level corporate/house brand (e.g., Apple at apple.com, Nike at nikeinc.com)
- "sub_brand": Product brand under a house (e.g., Fanta under The Coca-Cola Company, Disney+ under Disney)
- "endorsed": Independent brand backed by a house (e.g., GEICO backed by Berkshire Hathaway)
- "independent": Standalone brand with no known parent

Key distinctions:
- house_domain is the CORPORATE parent's domain, not the consumer brand domain. Nike's house is nikeinc.com (corporate), not nike.com (consumer). Coca-Cola Company's corporate domain is coca-colacompany.com or ko.com.
- canonical_domain is the primary consumer-facing domain for THIS brand specifically.
- related_domains lists other known domains for the same brand entity (regional variants, corporate sites, redirects). Include both consumer and corporate domains where known.
- A brand that IS the top-level house should have house_domain = null and keller_type = "master".
- If you're unsure about the corporate domain, set confidence to "medium" or "low".

Call classify_brand with your assessment.`;

const VALID_KELLER_TYPES: ReadonlyArray<KellerType> = ['master', 'sub_brand', 'endorsed', 'independent'];
const VALID_CONFIDENCE: ReadonlyArray<'high' | 'medium' | 'low'> = ['high', 'medium', 'low'];

/**
 * Classify a brand's architecture using Sonnet.
 * Returns null if classification fails (enrichment can still proceed without it).
 */
export async function classifyBrand(
  domain: string,
  brandData: BrandfetchEnrichmentResult
): Promise<BrandClassification | null> {
  if (!process.env.ANTHROPIC_API_KEY) {
    logger.warn('ANTHROPIC_API_KEY not configured, skipping brand classification');
    return null;
  }

  const brandContext = JSON.stringify({
    domain,
    name: brandData.manifest?.name,
    description: brandData.manifest?.description,
    company: brandData.company,
    social_links: brandData.raw?.links,
  }, null, 2);

  try {
    // Anthropic tool_use with input_schema: the model emits typed args matching
    // the schema rather than free-form JSON text. Confidence + keller_type are
    // auth-relevant (autoLinkByVerifiedDomain gates membership inheritance on
    // confidence='high'), so the schema enum + the runtime allowlist below are
    // both load-bearing.
    const response = await getClient().messages.create({
      model: ModelConfig.primary,
      max_tokens: 300,
      tools: [
        {
          name: 'classify_brand',
          description: 'Record the brand architecture classification.',
          input_schema: {
            type: 'object',
            properties: {
              keller_type: { type: 'string', enum: VALID_KELLER_TYPES as unknown as string[] },
              house_domain: {
                type: ['string', 'null'],
                description: 'Corporate parent domain or null',
              },
              parent_brand: {
                type: ['string', 'null'],
                description: 'Parent brand name or null',
              },
              canonical_domain: {
                type: 'string',
                description: 'Primary consumer domain for this brand',
              },
              related_domains: {
                type: 'array',
                items: { type: 'string' },
                description: 'Other known domains for this entity',
              },
              confidence: { type: 'string', enum: VALID_CONFIDENCE as unknown as string[] },
              reasoning: { type: 'string', description: 'One sentence explanation' },
            },
            required: ['keller_type', 'canonical_domain', 'confidence', 'reasoning'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'classify_brand' },
      messages: [{
        role: 'user',
        content: `${CLASSIFY_PROMPT}\n\nBrand data:\n${brandContext}`,
      }],
    });

    const toolUse = response.content.find(
      (block) => block.type === 'tool_use' && block.name === 'classify_brand',
    );
    if (!toolUse || toolUse.type !== 'tool_use') {
      logger.warn({ domain }, 'Brand classifier: model did not invoke classify_brand');
      return null;
    }
    const parsed = toolUse.input as Partial<BrandClassification>;

    // Validate keller_type. Schema enum should prevent this at the SDK layer
    // but the runtime allowlist is the load-bearing defense (auth-relevant).
    if (!parsed.keller_type || !VALID_KELLER_TYPES.includes(parsed.keller_type)) {
      logger.warn({ domain, keller_type: parsed.keller_type }, 'Invalid keller_type from classifier');
      return null;
    }

    logger.info(
      { domain, keller_type: parsed.keller_type, house_domain: parsed.house_domain, confidence: parsed.confidence },
      'Brand classified'
    );

    // Whitelist confidence — it's auth-relevant (gates brand-hierarchy
    // inheritance in autoLinkByVerifiedDomain). A prompt-injected response
    // setting "confidence": "extreme" or any other unexpected value should
    // collapse to 'low' rather than be persisted as-is.
    const confidence: 'high' | 'medium' | 'low' = VALID_CONFIDENCE.includes(parsed.confidence as never)
      ? (parsed.confidence as 'high' | 'medium' | 'low')
      : 'low';

    return {
      keller_type: parsed.keller_type,
      house_domain: parsed.house_domain || null,
      parent_brand: parsed.parent_brand || null,
      canonical_domain: parsed.canonical_domain || domain,
      related_domains: Array.isArray(parsed.related_domains) ? parsed.related_domains : [],
      confidence,
      reasoning: parsed.reasoning || '',
    };
  } catch (err) {
    logger.error({ err, domain }, 'Brand classification failed');
    return null;
  }
}
