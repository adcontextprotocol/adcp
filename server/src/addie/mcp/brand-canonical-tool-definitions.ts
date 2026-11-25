// BRAND_CANONICAL_TOOLS: the tool definitions of brand-canonical-tools.ts, moved here verbatim so that
// readers of the catalog (the router, tool sets, eval harnesses) do not load
// the handlers and their service, database and SDK dependencies.
import type { AddieTool } from '../types.js';

export const BRAND_CANONICAL_TOOLS: AddieTool[] = [
  {
    name: 'publish_brand_canonical_document',
    description:
      "Generate a Brand Canonical Document (brand.json variant 5) for a sub-brand team. Builds a JSON document with the brand's identity fields (logos/colors/tone/etc.), validates it against the brand.json schema, and returns the document plus the path where it should be hosted (https://{domain}/.well-known/brand.json). Returns validation errors instead of an invalid document. Does NOT upload — the operator hosts the returned JSON themselves.",
    usage_hints:
      "Use when a brand team wants to self-publish their identity at their own /.well-known/brand.json. Optionally takes a house_domain pointer up to a corporate house. After generation, suggest the user also call add_to_brand_refs on the house portfolio to complete the mutual-assertion edge.",
    input_schema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: "Brand's primary domain (where /.well-known/brand.json will be hosted).",
        },
        brand_id: {
          type: 'string',
          description:
            "Stable brand identifier (lowercase alphanumeric with underscores). Should match the brand_id the house uses in its brand_refs[] entry.",
        },
        names: {
          type: 'array',
          description:
            "Localized brand names. Each item is an object with one locale key, e.g. {\"en_US\": \"Converse\"}.",
          items: { type: 'object' },
        },
        house_domain: {
          type: 'string',
          description:
            "Optional pointer to the corporate house this brand belongs to. Omit for standalone brands. Mutual-assertion trust requires the named house's brand_refs[] to reciprocate.",
        },
        keller_type: {
          type: 'string',
          enum: ['master', 'sub_brand', 'endorsed', 'independent'],
          description: 'Brand architecture classification (Keller).',
        },
        parent_brand: { type: 'string', description: 'Parent brand_id for sub-brands/endorsed brands.' },
        tagline: { type: 'string', description: 'Brand tagline/slogan.' },
        description: { type: 'string', description: 'Free-text brand description.' },
        industries: {
          type: 'array',
          items: { type: 'string' },
          description: 'Industry classifications.',
        },
        logos: {
          type: 'array',
          description: 'Brand logo assets — array of objects with url (required), variant, tags, etc.',
        },
        colors: {
          type: 'object',
          description: 'Brand color palette (primary/secondary/accent/... — hex values).',
        },
        fonts: { type: 'object', description: 'Brand typography roles.' },
        tone: { type: 'object', description: 'Brand voice / dos / donts.' },
        visual_guidelines: { type: 'object', description: 'Visual-system rules for generative creative.' },
        trademarks: {
          type: 'array',
          description: 'Brand-level registered trademarks. Each: { registry, number, mark, ... }.',
        },
        properties: {
          type: 'array',
          description: 'Digital properties (websites, apps) owned/operated by this brand.',
        },
        contact: { type: 'object', description: 'Brand contact info.' },
        brand_agent: { type: 'object', description: 'Brand agent { url, id } — overrides identity fields when present.' },
        rights_agent: { type: 'object', description: 'Rights agent for licensing { url, id, available_uses, ... }.' },
        version: { type: 'string', description: "Document version. Defaults to '1.0'." },
        last_updated: { type: 'string', description: 'ISO 8601 timestamp.' },
        extra: {
          type: 'object',
          description:
            'Advanced: additional canonical-doc top-level fields not covered by the named parameters above. Only spec-allowed keys are kept; everything else is silently dropped.',
        },
      },
      required: ['domain', 'brand_id', 'names'],
    },
  },
  {
    name: 'add_to_brand_refs',
    description:
      "Append a portfolio_entry pointer to a House Portfolio's brand_refs[]. Either pass the house's brand.json directly (house_brand_json) or have the tool fetch it (house_domain). Enforces the cross-array uniqueness invariants from the spec: a brand_id MUST NOT appear in both brands[] and brand_refs[], and each brand_id/domain MUST be unique within brand_refs[]. Returns the updated brand.json or a clear validation error.",
    usage_hints:
      "Use when a house portfolio operator wants to add a child brand that publishes its own canonical document. Pair with publish_brand_canonical_document on the child side to complete the mutual-assertion edge.",
    input_schema: {
      type: 'object',
      properties: {
        house_brand_json: {
          type: 'object',
          description:
            "The house's current brand.json contents. Pass this when you already have the document in hand (e.g., the user pasted it). Mutually exclusive with house_domain.",
        },
        house_domain: {
          type: 'string',
          description:
            "Domain of the house. The tool fetches https://{house_domain}/.well-known/brand.json. Mutually exclusive with house_brand_json.",
        },
        child_domain: {
          type: 'string',
          description: "Where the child's canonical brand.json lives (e.g. 'converse.com').",
        },
        brand_id: {
          type: 'string',
          description:
            "Stable brand_id for the child within the house's portfolio. Must match what the child uses in its canonical document.",
        },
        managed_by: {
          type: 'string',
          description:
            "Optional domain of the entity that operationally manages this brand. House-declared. NOT a trust field — used for directory aggregation only.",
        },
        effective_at: {
          type: 'string',
          description: 'Optional ISO 8601 timestamp when the house established the ownership claim.',
        },
      },
      required: ['child_domain', 'brand_id'],
    },
  },
  {
    name: 'check_mutual_assertion',
    description:
      "Given a leaf brand's domain, fetch its canonical document and its claimed house's portfolio (following House Redirects on the house side, up to 3 hops, per the Conformance section). Classify the relationship trust into: mutual (both sides reciprocate), leaf_only (leaf claims house, house silent), house_only (house claims leaf, leaf silent — returned by checking the house if a different caller already has it), standalone (no house_domain), or unverifiable (one or both fetches failed). Returns the house's contact.email when present so the caller can pass it into notify_pending_verification on leaf_only edges.",
    usage_hints:
      "Use when a user asks 'does my brand.json connect properly to my house?' or 'is this leaf trusted by its parent?'. On a leaf_only result, the next step is usually notify_pending_verification.",
    input_schema: {
      type: 'object',
      properties: {
        leaf_domain: {
          type: 'string',
          description: "The leaf brand's domain (e.g. 'converse.com').",
        },
      },
      required: ['leaf_domain'],
    },
  },
  {
    name: 'notify_pending_verification',
    description:
      "Send the SHOULD-level notification email to the house's contact.email when a leaf_only edge is detected. Rate-limited to one notification per {leaf, house} pair per 24 hours, persisted in the brand_assertion_notifications table so concurrent callers can't double-send. Behind a feature flag (BRAND_ASSERTION_EMAIL_ENABLED) — defaults to log-only so operators can review the would-have-sent payload before enabling the live send path.",
    usage_hints:
      "Use after check_mutual_assertion returns tier=leaf_only with a house_contact_email. Don't call without first checking — the notification text assumes the leaf is actually claiming the house.",
    input_schema: {
      type: 'object',
      properties: {
        leaf_domain: { type: 'string', description: "Leaf brand's domain." },
        house_domain: {
          type: 'string',
          description: "House's domain (the value the leaf put in house_domain).",
        },
        house_contact_email: {
          type: 'string',
          description: "House's published contact.email — pulled from the house's brand.json.",
        },
        leaf_brand_id: {
          type: 'string',
          description:
            "Optional: the brand_id the leaf used in its canonical document. Included in the email so the house team knows which slot to reserve.",
        },
      },
      required: ['leaf_domain', 'house_domain', 'house_contact_email'],
    },
  },
];
