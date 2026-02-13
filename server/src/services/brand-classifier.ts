/**
 * Brand architecture classification via LLM
 *
 * Uses a single structured Sonnet call to classify a brand's position
 * in a corporate brand architecture (Keller model) given Brandfetch data.
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

Respond with ONLY valid JSON (no markdown fences):
{
  "keller_type": "master|sub_brand|endorsed|independent",
  "house_domain": "corporate parent domain or null",
  "parent_brand": "parent brand name or null",
  "canonical_domain": "primary consumer domain for this brand",
  "related_domains": ["other known domains for this entity"],
  "confidence": "high|medium|low",
  "reasoning": "one sentence explanation"
}`;

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
    const response = await getClient().messages.create({
      model: ModelConfig.primary,
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `${CLASSIFY_PROMPT}\n\nBrand data:\n${brandContext}`,
      }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const cleaned = text.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
    const parsed = JSON.parse(cleaned) as BrandClassification;

    // Validate keller_type
    const validTypes: KellerType[] = ['master', 'sub_brand', 'endorsed', 'independent'];
    if (!validTypes.includes(parsed.keller_type)) {
      logger.warn({ domain, keller_type: parsed.keller_type }, 'Invalid keller_type from classifier');
      return null;
    }

    logger.info(
      { domain, keller_type: parsed.keller_type, house_domain: parsed.house_domain, confidence: parsed.confidence },
      'Brand classified'
    );

    return {
      keller_type: parsed.keller_type,
      house_domain: parsed.house_domain || null,
      parent_brand: parsed.parent_brand || null,
      canonical_domain: parsed.canonical_domain || domain,
      related_domains: Array.isArray(parsed.related_domains) ? parsed.related_domains : [],
      confidence: parsed.confidence || 'low',
      reasoning: parsed.reasoning || '',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error({ err, domain }, 'Brand classification failed');
    return null;
  }
}
