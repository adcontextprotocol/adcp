/**
 * Property Tools for Addie
 *
 * Provides property research and registry management capabilities.
 * Allows Addie to validate adagents.json files, resolve publisher identities,
 * and create synthetic hosted properties for publishers that don't self-host.
 */

import type { AddieTool } from '../types.js';
import { AdAgentsManager } from '../../adagents-manager.js';
import { PropertyDatabase } from '../../db/property-db.js';

const adagentsManager = new AdAgentsManager();
const propertyDb = new PropertyDatabase();

/**
 * Property tool definitions for Addie
 */
export const PROPERTY_TOOLS: AddieTool[] = [
  {
    name: 'validate_adagents',
    description: 'Validate a domain\'s /.well-known/adagents.json file. Returns validation results including any errors or warnings.',
    usage_hints: 'Use when asked to check if a publisher has set up adagents.json, or to validate a domain\'s agent authorizations.',
    input_schema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'Publisher domain to validate (e.g., "nytimes.com")',
        },
      },
      required: ['domain'],
    },
  },
  {
    name: 'resolve_property',
    description: 'Resolve a publisher domain to its property information. Checks hosted properties, discovered properties, and live adagents.json.',
    usage_hints: 'Use when asked about a publisher\'s property setup, authorized agents, or inventory.',
    input_schema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'Publisher domain to resolve (e.g., "cnn.com")',
        },
      },
      required: ['domain'],
    },
  },
  {
    name: 'save_property',
    description: 'Save a synthetic adagents.json for a publisher that doesn\'t self-host. Creates a hosted property in the registry.',
    usage_hints: 'Use to create a hosted property for a publisher. Requires publisher_domain and adagents_json content.',
    input_schema: {
      type: 'object',
      properties: {
        publisher_domain: {
          type: 'string',
          description: 'Publisher domain',
        },
        authorized_agents: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              url: { type: 'string' },
              authorized_for: { type: 'string' },
            },
          },
          description: 'Array of authorized agents with their URLs and scopes',
        },
        properties: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string' },
              name: { type: 'string' },
            },
          },
          description: 'Array of properties (inventory types)',
        },
        contact: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            email: { type: 'string' },
          },
          description: 'Contact information',
        },
        source_type: {
          type: 'string',
          enum: ['community', 'enriched'],
          description: 'Source type - "community" for manually contributed',
        },
      },
      required: ['publisher_domain'],
    },
  },
  {
    name: 'list_properties',
    description: 'List publisher properties in the registry. Can filter by source type and search by domain.',
    usage_hints: 'Use when asked about publishers in the registry, or to find properties by domain.',
    input_schema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          enum: ['adagents_json', 'hosted', 'discovered'],
          description: 'Filter by source type',
        },
        search: {
          type: 'string',
          description: 'Search term for publisher domain',
        },
        limit: {
          type: 'number',
          description: 'Maximum results (default: 20)',
        },
      },
    },
  },
];

/**
 * Create handlers for property tools
 */
export function createPropertyToolHandlers(): Map<string, (args: Record<string, unknown>) => Promise<string>> {
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<string>>();

  handlers.set('validate_adagents', async (args) => {
    const domain = args.domain as string;
    if (!domain) {
      return JSON.stringify({ error: 'domain is required' });
    }

    const result = await adagentsManager.validateDomain(domain);

    return JSON.stringify({
      domain: result.domain,
      url: result.url,
      valid: result.valid,
      status_code: result.status_code,
      errors: result.errors,
      warnings: result.warnings,
      agent_count: result.raw_data?.authorized_agents?.length || 0,
      property_count: result.raw_data?.properties?.length || 0,
      has_contact: !!result.raw_data?.contact,
    }, null, 2);
  });

  handlers.set('resolve_property', async (args) => {
    const domain = args.domain as string;
    if (!domain) {
      return JSON.stringify({ error: 'domain is required' });
    }

    // Check hosted first
    const hosted = await propertyDb.getHostedPropertyByDomain(domain);
    if (hosted && hosted.is_public) {
      const adagents = hosted.adagents_json as Record<string, unknown>;
      return JSON.stringify({
        source: 'hosted',
        publisher_domain: hosted.publisher_domain,
        verified: hosted.domain_verified,
        authorized_agents: (adagents.authorized_agents as unknown[])?.length || 0,
        properties: (adagents.properties as unknown[])?.length || 0,
        has_contact: !!adagents.contact,
        hint: 'This is a synthetic adagents.json we host for this publisher',
      }, null, 2);
    }

    // Check discovered
    const discovered = await propertyDb.getDiscoveredPropertiesByDomain(domain);
    if (discovered.length > 0) {
      const agents = await propertyDb.getAgentAuthorizationsForDomain(domain);
      return JSON.stringify({
        source: 'adagents_json',
        publisher_domain: domain,
        verified: true,
        authorized_agents: [...new Set(agents.map(a => a.agent_url))].length,
        agent_urls: [...new Set(agents.map(a => a.agent_url))],
        properties: discovered.length,
        property_types: [...new Set(discovered.map(p => p.property_type))],
      }, null, 2);
    }

    // Try live validation
    const validation = await adagentsManager.validateDomain(domain);
    if (validation.valid && validation.raw_data) {
      return JSON.stringify({
        source: 'adagents_json',
        publisher_domain: domain,
        verified: true,
        authorized_agents: validation.raw_data.authorized_agents?.length || 0,
        agent_urls: validation.raw_data.authorized_agents?.map((a: { url: string }) => a.url) || [],
        properties: validation.raw_data.properties?.length || 0,
        has_contact: !!validation.raw_data.contact,
      }, null, 2);
    }

    return JSON.stringify({
      error: 'Property not found',
      domain,
      hint: 'No adagents.json found at /.well-known/adagents.json and not in registry. Use save_property to create a synthetic entry.',
    });
  });

  handlers.set('save_property', async (args) => {
    const publisherDomain = args.publisher_domain as string;
    if (!publisherDomain) {
      return JSON.stringify({ error: 'publisher_domain is required' });
    }

    const authorizedAgents = args.authorized_agents as Array<{ url: string; authorized_for?: string }> || [];
    const properties = args.properties as Array<{ type: string; name: string }> || [];
    const contact = args.contact as { name?: string; email?: string } | undefined;
    const sourceType = (args.source_type as string) || 'community';

    const adagentsJson: Record<string, unknown> = {
      $schema: 'https://adcontextprotocol.org/schemas/v1/adagents.json',
      authorized_agents: authorizedAgents,
      properties: properties,
    };

    if (contact) {
      adagentsJson.contact = contact;
    }

    const saved = await propertyDb.createHostedProperty({
      publisher_domain: publisherDomain,
      adagents_json: adagentsJson,
      source_type: sourceType as 'community' | 'enriched',
    });

    return JSON.stringify({
      success: true,
      message: `Hosted property created for ${publisherDomain}`,
      id: saved.id,
      redirect_json: {
        note: 'Publisher can place this at /.well-known/adagents.json to redirect to hosted version',
        content: {
          $schema: 'https://adcontextprotocol.org/schemas/v1/adagents.json',
          authoritative_location: `https://adcontextprotocol.org/property/${saved.id}/adagents.json`,
        },
      },
    }, null, 2);
  });

  handlers.set('list_properties', async (args) => {
    const source = args.source as 'adagents_json' | 'hosted' | 'discovered' | undefined;
    const search = args.search as string | undefined;
    const rawLimit = typeof args.limit === 'number' ? args.limit : 20;
    const limit = Math.min(Math.max(1, rawLimit), 100);

    const properties = await propertyDb.getAllPropertiesForRegistry({
      search,
      limit,
    });

    // Filter by source if specified
    let filtered = properties;
    if (source) {
      filtered = properties.filter(p => p.source === source);
    }

    if (filtered.length === 0) {
      return source
        ? `No ${source} properties found.`
        : 'No properties found in the registry.';
    }

    const result = filtered.map(p => ({
      domain: p.domain,
      source: p.source,
      property_count: p.property_count,
      agent_count: p.agent_count,
      verified: p.verified,
    }));

    return JSON.stringify({ properties: result, count: result.length }, null, 2);
  });

  return handlers;
}
