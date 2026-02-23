/**
 * Property enhancement: WHOIS age check + AI site analysis + pending registry submission.
 *
 * For unknown domains in the assess bucket, this service determines whether a domain
 * looks like a real publisher, flags high-risk new domains (< 90 days old), and
 * submits a pending entry to the registry for Addie's review.
 */

import Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '../logger.js';
import { ModelConfig } from '../config/models.js';
import { AdAgentsManager } from '../adagents-manager.js';
import { PropertyDatabase } from '../db/property-db.js';
import { reviewNewRecord } from '../addie/mcp/registry-review.js';

const logger = createLogger('property-enhancement');

const adagentsManager = new AdAgentsManager();
const propertyDb = new PropertyDatabase();

let anthropicClient: Anthropic | null = null;
function getClient(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic();
  }
  return anthropicClient;
}

export interface PropertyAiAnalysis {
  is_publisher: boolean;
  likely_inventory_types: string[];
  structural_subdomain_note: string | null;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
}

export interface EnhancementResult {
  domain: string;
  has_adagents: boolean;
  risk: 'high' | 'normal' | 'unknown';
  domain_age_days: number | null;
  ai_analysis: PropertyAiAnalysis | null;
  submitted_to_registry: boolean;
  property_id: string | null;
  already_exists: boolean;
}

const DOMAIN_AGE_RISK_THRESHOLD_DAYS = 90;

/**
 * Attempt WHOIS lookup and return domain age in days.
 * Returns null if WHOIS data is unavailable or unparseable.
 */
async function getDomainAgeDays(domain: string): Promise<number | null> {
  try {
    const { whoisDomain } = await import('whoiser');
    const result = await whoisDomain(domain, { timeout: 8000 });

    // whoiser returns an object keyed by TLD server; find the first usable creation date
    for (const serverData of Object.values(result)) {
      if (!serverData || typeof serverData !== 'object') continue;

      const creationDateRaw: string | string[] | undefined =
        serverData['Creation Date'] ??
        serverData['Created Date'] ??
        serverData['creation_date'] ??
        serverData['Domain Registration Date'];

      if (!creationDateRaw) continue;

      const dateStr = Array.isArray(creationDateRaw) ? creationDateRaw[0] : creationDateRaw;
      if (!dateStr) continue;
      const date = new Date(dateStr);
      if (isNaN(date.getTime())) continue;

      return Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24));
    }
    return null;
  } catch (err) {
    logger.debug({ domain, err }, 'WHOIS lookup failed');
    return null;
  }
}

const ANALYZE_PROMPT = `You are analyzing a domain to determine if it is a real digital publisher with advertising inventory.

Given only the domain name, assess:
1. Is this likely a real publisher property (website, app, podcast, etc.)?
2. What inventory types would it likely carry (display, video, audio, ctv, etc.)?
3. If it appears to be a subdomain, is it likely a structural subdomain with distinct editorial identity (e.g., sports.example.com) or just a technical subdomain (e.g., cdn.example.com, api.example.com)?

Respond with ONLY valid JSON (no markdown fences):
{
  "is_publisher": true|false,
  "likely_inventory_types": ["display", "video", ...],
  "structural_subdomain_note": "explanation if subdomain, null if apex domain or not structural",
  "confidence": "high|medium|low",
  "reasoning": "one sentence"
}`;

async function analyzeProperty(domain: string): Promise<PropertyAiAnalysis | null> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return null;
  }

  try {
    const response = await getClient().messages.create({
      model: ModelConfig.fast,
      max_tokens: 256,
      messages: [{ role: 'user', content: `${ANALYZE_PROMPT}\n\nDomain: ${domain}` }],
    });

    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
    const cleaned = text.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
    const parsed = JSON.parse(cleaned) as PropertyAiAnalysis;

    const validConfidence = new Set<string>(['high', 'medium', 'low']);
    return {
      is_publisher: Boolean(parsed.is_publisher),
      likely_inventory_types: Array.isArray(parsed.likely_inventory_types)
        ? parsed.likely_inventory_types.filter((t): t is string => typeof t === 'string')
        : [],
      structural_subdomain_note: parsed.structural_subdomain_note || null,
      confidence: validConfidence.has(parsed.confidence) ? parsed.confidence as 'high' | 'medium' | 'low' : 'low',
      reasoning: parsed.reasoning || '',
    };
  } catch (err) {
    logger.debug({ domain, err }, 'Property AI analysis failed');
    return null;
  }
}

export async function enhanceProperty(
  domain: string,
  submitterUserId: string = 'system:addie',
  submitterEmail?: string
): Promise<EnhancementResult> {
  // Check if already in registry
  const existing = await propertyDb.getHostedPropertyByDomain(domain);
  if (existing) {
    return {
      domain,
      has_adagents: false,
      risk: 'unknown',
      domain_age_days: null,
      ai_analysis: null,
      submitted_to_registry: false,
      property_id: existing.id,
      already_exists: true,
    };
  }

  // Run checks in parallel
  const [adagentsValidation, domainAgeDays, aiAnalysis] = await Promise.all([
    adagentsManager.validateDomain(domain).catch(() => null),
    getDomainAgeDays(domain),
    analyzeProperty(domain),
  ]);

  const hasAdagents = adagentsValidation?.valid ?? false;

  let risk: 'high' | 'normal' | 'unknown';
  if (domainAgeDays === null) {
    risk = 'unknown';
  } else if (domainAgeDays < DOMAIN_AGE_RISK_THRESHOLD_DAYS) {
    risk = 'high';
  } else {
    risk = 'normal';
  }

  // Build a minimal adagents_json for the pending entry.
  // Metadata goes in the ext field for reference.
  const adagentsJson: Record<string, unknown> = {
    $schema: 'https://adcontextprotocol.org/schemas/v1/adagents.json',
    authorized_agents: [],
    properties: [],
    ext: {
      enhancement: {
        risk,
        domain_age_days: domainAgeDays,
        has_adagents: hasAdagents,
        ai_analysis: aiAnalysis,
        enhanced_at: new Date().toISOString(),
        enhanced_by: submitterUserId,
      },
    },
  };

  let propertyId: string | null = null;
  let submitted = false;

  try {
    const property = await propertyDb.createHostedProperty({
      publisher_domain: domain,
      adagents_json: adagentsJson,
      source_type: 'community',
      is_public: false,
      review_status: 'pending',
      created_by_user_id: submitterUserId,
      created_by_email: submitterEmail,
    });

    propertyId = property.id;
    submitted = true;

    // Trigger Addie's async review (fire-and-forget)
    reviewNewRecord({
      entity_type: 'property',
      domain,
      editor_user_id: submitterUserId,
      editor_email: submitterEmail,
      snapshot: adagentsJson,
    }).catch((err) => {
      logger.error({ err, domain }, 'Registry review failed for enhanced property');
    });
  } catch (err) {
    logger.error({ err, domain }, 'Failed to submit enhanced property to registry');
  }

  return {
    domain,
    has_adagents: hasAdagents,
    risk,
    domain_age_days: domainAgeDays,
    ai_analysis: aiAnalysis,
    submitted_to_registry: submitted,
    property_id: propertyId,
    already_exists: false,
  };
}
