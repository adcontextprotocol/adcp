/**
 * Directory Tools for Addie
 *
 * Provides access to the AAO member directory, agent registry, and publisher index.
 * These are the same capabilities as the MCP Directory server, but formatted for Addie.
 */

import type { AddieTool } from '../types.js';
import { MemberDatabase } from '../../db/member-db.js';
import { AgentService } from '../../agent-service.js';
import { AgentValidator } from '../../validator.js';
import { FederatedIndexService } from '../../federated-index.js';
import type { AgentType, MemberOffering, Agent } from '../../types.js';

const memberDb = new MemberDatabase();
const agentService = new AgentService();
const validator = new AgentValidator();
const federatedIndex = new FederatedIndexService();

/**
 * Directory tool definitions for Addie
 */
export const DIRECTORY_TOOLS: AddieTool[] = [
  {
    name: 'list_members',
    description: 'List AgenticAdvertising.org member organizations. Can filter by offerings (buyer_agent, sales_agent, creative_agent, signals_agent, si_agent, governance_agent, publisher, consulting), markets (North America, EMEA, APAC, LATAM, Global), or search term.',
    usage_hints: 'Use when asked about AAO members, member organizations, who is in the directory, or companies that offer specific services.',
    input_schema: {
      type: 'object',
      properties: {
        offerings: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['buyer_agent', 'sales_agent', 'creative_agent', 'signals_agent', 'si_agent', 'governance_agent', 'publisher', 'consulting', 'other'],
          },
          description: 'Filter by member offerings',
        },
        markets: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by markets served',
        },
        search: {
          type: 'string',
          description: 'Search term to filter by name, description, or tags',
        },
        limit: {
          type: 'number',
          description: 'Maximum results (default: 20)',
        },
      },
    },
  },
  {
    name: 'get_member',
    description: 'Get detailed information about a specific AAO member by their slug identifier.',
    usage_hints: 'Use when asked for details about a specific member organization.',
    input_schema: {
      type: 'object',
      properties: {
        slug: {
          type: 'string',
          description: 'Member slug (e.g., "pubmatic", "yahoo")',
        },
      },
      required: ['slug'],
    },
  },
  {
    name: 'list_agents',
    description: 'List all public AdCP agents from member organizations. Can filter by type: creative (asset generation), signals (audience data), sales (media buying), governance (property lists and content standards), or si (sponsored intelligence/conversational commerce).',
    usage_hints: 'Use when asked about registered agents, what agents are available, or agents of a specific type.',
    input_schema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['creative', 'signals', 'sales', 'governance', 'si'],
          description: 'Filter by agent type',
        },
      },
    },
  },
  {
    name: 'get_agent',
    description: 'Get details for a specific agent by its URL.',
    usage_hints: 'Use when asked about a specific agent.',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Agent URL (e.g., "https://sales.example.com")',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'validate_agent',
    description: 'Validate if an agent is authorized for a publisher domain by checking their /.well-known/adagents.json file.',
    usage_hints: 'Use when asked if an agent can sell for a publisher, or to verify agent authorization.',
    input_schema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'Publisher domain (e.g., "nytimes.com")',
        },
        agent_url: {
          type: 'string',
          description: 'Agent URL to validate',
        },
      },
      required: ['domain', 'agent_url'],
    },
  },
  {
    name: 'lookup_domain',
    description: 'Find all agents authorized for a specific publisher domain. Shows both verified agents (from adagents.json) and claimed agents (from agent registrations).',
    usage_hints: 'Use when asked which agents can sell inventory for a domain, or who represents a publisher.',
    input_schema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'Publisher domain (e.g., "nytimes.com")',
        },
      },
      required: ['domain'],
    },
  },
  {
    name: 'list_publishers',
    description: 'List all publishers that have published a /.well-known/adagents.json file, indicating they support AdCP.',
    usage_hints: 'Use when asked which publishers support AdCP, or who has set up adagents.json.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
];

/**
 * Create handlers for directory tools
 */
export function createDirectoryToolHandlers(): Map<string, (args: Record<string, unknown>) => Promise<string>> {
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<string>>();

  handlers.set('list_members', async (args) => {
    const offerings = args.offerings as MemberOffering[] | undefined;
    const markets = args.markets as string[] | undefined;
    const search = args.search as string | undefined;
    // Validate limit: default 20, max 100
    const rawLimit = typeof args.limit === 'number' ? args.limit : 20;
    const limit = Math.min(Math.max(1, rawLimit), 100);

    const members = await memberDb.getPublicProfiles({
      offerings,
      markets,
      search,
      limit,
    });

    if (members.length === 0) {
      return 'No members found matching the criteria.';
    }

    const result = members.map((m) => ({
      name: m.display_name,
      slug: m.slug,
      tagline: m.tagline,
      offerings: m.offerings,
      headquarters: m.headquarters,
      markets: m.markets,
      website: m.contact_website,
      agents: m.agents.filter((a) => a.is_public).map((a) => ({
        name: a.name,
        type: a.type,
        url: a.url,
      })),
    }));

    return JSON.stringify({ members: result, count: result.length }, null, 2);
  });

  handlers.set('get_member', async (args) => {
    const slug = args.slug as string;
    if (!slug) {
      return JSON.stringify({ error: 'slug is required' });
    }

    const member = await memberDb.getProfileBySlug(slug);
    if (!member || !member.is_public) {
      return JSON.stringify({ error: `Member "${slug}" not found or not public` });
    }

    return JSON.stringify({
      name: member.display_name,
      slug: member.slug,
      tagline: member.tagline,
      description: member.description,
      offerings: member.offerings,
      headquarters: member.headquarters,
      markets: member.markets,
      website: member.contact_website,
      logo: member.resolved_brand?.logo_url,
      agents: member.agents.filter((a) => a.is_public).map((a) => ({
        name: a.name,
        type: a.type,
        url: a.url,
      })),
    }, null, 2);
  });

  handlers.set('list_agents', async (args) => {
    const agentType = args.type as AgentType | undefined;
    const agents = await agentService.listAgents(agentType);

    if (agents.length === 0) {
      return agentType
        ? `No ${agentType} agents found.`
        : 'No agents found.';
    }

    const result = agents.map((a: Agent) => ({
      name: a.name,
      type: a.type,
      url: a.url,
      description: a.description,
      contact: a.contact,
    }));

    return JSON.stringify({ agents: result, count: result.length }, null, 2);
  });

  handlers.set('get_agent', async (args) => {
    const url = args.url as string;
    if (!url) {
      return JSON.stringify({ error: 'url is required' });
    }

    const agent = await agentService.getAgentByUrl(url);
    if (!agent) {
      return JSON.stringify({ error: `Agent "${url}" not found` });
    }

    return JSON.stringify({
      name: agent.name,
      type: agent.type,
      url: agent.url,
      description: agent.description,
      contact: agent.contact,
      mcp_endpoint: agent.mcp_endpoint,
    }, null, 2);
  });

  handlers.set('validate_agent', async (args) => {
    const domain = args.domain as string;
    const agentUrl = args.agent_url as string;

    if (!domain || !agentUrl) {
      return JSON.stringify({ error: 'domain and agent_url are required' });
    }

    const result = await validator.validate(domain, agentUrl);
    return JSON.stringify(result, null, 2);
  });

  handlers.set('lookup_domain', async (args) => {
    const domain = args.domain as string;
    if (!domain) {
      return JSON.stringify({ error: 'domain is required' });
    }

    const result = await federatedIndex.lookupDomain(domain);
    return JSON.stringify(result, null, 2);
  });

  handlers.set('list_publishers', async () => {
    const publishers = await federatedIndex.listAllPublishers();
    return JSON.stringify({ publishers, count: publishers.length }, null, 2);
  });

  return handlers;
}
