/**
 * Brand Property Import Tools for Addie
 *
 * Two-tool flow for importing publisher domains / app bundles into a
 * brand's manifest, mirroring the smart-paste flow in the brand builder UI.
 *
 *   parse_brand_properties — preview only. Runs the same LLM extraction +
 *     output filter as the HTTP route (DNS 253 cap, type allowlist,
 *     lowercase, MAX_PROPERTIES) and returns the candidate list. Addie is
 *     expected to show the preview to the user and wait for explicit
 *     confirmation before calling import_brand_properties.
 *
 *   import_brand_properties — commit. Takes the user-confirmed property
 *     list and merges it into the brand manifest by identifier.
 *
 * Both tools enforce the same ownership check as the HTTP route via
 * getBrandForEdit — the calling user's primary org must own the brand
 * domain (organization_domains or member_profiles.primary_brand_domain).
 */

import type { AddieTool } from '../types.js';
import type { MemberContext } from '../member-context.js';
import { BrandDatabase } from '../../db/brand-db.js';
import {
  parsePropertyInputForBrand,
  mergeBrandProperties,
  VALID_PROPERTY_TYPES,
  VALID_RELATIONSHIPS,
  type Relationship,
} from '../../services/brand-property-parse.js';

const brandDb = new BrandDatabase();

/**
 * Strip protocol, paths, query strings, and trailing slashes from a
 * domain — operators paste in URLs sometimes.
 */
function normalizeDomain(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/[/?#].*$/, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

export const BRAND_PROPERTY_TOOLS: AddieTool[] = [
  {
    name: 'parse_brand_properties',
    description:
      "Preview a smart-paste import for a brand the operator owns. Takes pasted text (a list of domains and app bundles) or a URL whose body should be fetched, and returns the structured property list that would be imported. The user MUST confirm before you call import_brand_properties — show them the parsed list first. Caller's organization must own the brand domain.",
    usage_hints:
      'Use when an operator says "import these domains for my-brand.com: cnn.com, ..." or shares a URL with a property list. Returns a preview only — never imports. After showing the parsed list to the user and getting confirmation, call import_brand_properties with the same property objects.',
    input_schema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: "The brand domain to import properties into (e.g. 'paste-demo.example'). Caller's org must own it.",
        },
        input: {
          type: 'string',
          description: 'Either pasted text containing domains/bundle IDs, or an https:// URL to fetch (set input_type accordingly).',
        },
        input_type: {
          type: 'string',
          enum: ['text', 'url'],
          description: "'text' for pasted lists, 'url' to fetch and parse a remote document. Defaults to 'text'.",
        },
        relationship: {
          type: 'string',
          enum: [...VALID_RELATIONSHIPS],
          description: "Stamped onto each parsed property. Defaults to 'delegated'.",
        },
      },
      required: ['domain', 'input'],
    },
  },
  {
    name: 'import_brand_properties',
    description:
      "Commit a previewed property import. Takes a property list (typically the output of parse_brand_properties, possibly trimmed by the user) and merges it into the brand manifest by identifier — existing entries are updated in place, new entries are added. ONLY call after the user has explicitly confirmed the list from parse_brand_properties. Caller's organization must own the brand domain.",
    usage_hints:
      'Use after parse_brand_properties when the user confirms they want the listed properties imported. Pass the properties array straight through (or filtered by the user). Returns counts of added / updated / skipped.',
    input_schema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'The brand domain to import properties into.',
        },
        properties: {
          type: 'array',
          description: 'Property objects to merge. Each must have identifier (string) and type (one of the property type allowlist). relationship is optional but recommended.',
          items: {
            type: 'object',
            properties: {
              identifier: { type: 'string' },
              type: { type: 'string', enum: [...VALID_PROPERTY_TYPES] },
              relationship: { type: 'string', enum: [...VALID_RELATIONSHIPS] },
            },
            required: ['identifier', 'type'],
          },
        },
      },
      required: ['domain', 'properties'],
    },
  },
];

/**
 * Build handlers for the two property-import tools, scoped to the calling
 * member. Both tools refuse outright if the caller is not signed in (no
 * memberContext) or has no WorkOS user id — without one we can't run the
 * ownership check.
 */
export function createBrandPropertyToolHandlers(
  memberContext: MemberContext | null,
): Map<string, (args: Record<string, unknown>) => Promise<string>> {
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<string>>();
  const userId = memberContext?.workos_user?.workos_user_id ?? null;

  handlers.set('parse_brand_properties', async (args) => {
    if (!userId) {
      return JSON.stringify({
        error: 'You must be signed in to import properties for a brand.',
      });
    }
    const rawDomain = args.domain;
    const input = args.input;
    if (typeof rawDomain !== 'string' || rawDomain.trim().length === 0) {
      return JSON.stringify({ error: 'domain is required' });
    }
    if (typeof input !== 'string' || input.trim().length === 0) {
      return JSON.stringify({ error: 'input is required' });
    }
    const domain = normalizeDomain(rawDomain);
    const inputType = (args.input_type as string) ?? 'text';
    const relationship = args.relationship as Relationship | undefined;

    const result = await parsePropertyInputForBrand({
      brandDb,
      domain,
      userId,
      input,
      inputType: inputType as 'text' | 'url',
      relationship,
    });

    if (!result.ok) {
      return JSON.stringify({ error: result.error, status: result.status });
    }

    return JSON.stringify(
      {
        domain,
        preview: true,
        count: result.count,
        properties: result.properties,
        truncated: result.truncated || undefined,
        warning: result.warning,
        next_step:
          result.count > 0
            ? 'Show this list to the user. After they confirm, call import_brand_properties with the same domain and properties.'
            : 'No properties extracted. Ask the user to share the list directly or check the URL.',
      },
      null,
      2,
    );
  });

  handlers.set('import_brand_properties', async (args) => {
    if (!userId) {
      return JSON.stringify({
        error: 'You must be signed in to import properties for a brand.',
      });
    }
    const rawDomain = args.domain;
    const properties = args.properties;
    if (typeof rawDomain !== 'string' || rawDomain.trim().length === 0) {
      return JSON.stringify({ error: 'domain is required' });
    }
    if (!Array.isArray(properties)) {
      return JSON.stringify({ error: 'properties array is required' });
    }
    const domain = normalizeDomain(rawDomain);

    const result = await mergeBrandProperties({
      brandDb,
      domain,
      userId,
      properties: properties as Array<Record<string, unknown>>,
    });

    if (!result.ok) {
      return JSON.stringify({ error: result.error, status: result.status });
    }

    return JSON.stringify(
      {
        domain,
        ...result.report,
      },
      null,
      2,
    );
  });

  return handlers;
}
