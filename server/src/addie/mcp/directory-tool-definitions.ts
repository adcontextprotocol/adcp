// DIRECTORY_TOOLS: the tool definitions of directory-tools.ts, moved here verbatim so that
// readers of the catalog (the router, tool sets, eval harnesses) do not load
// the handlers and their service, database and SDK dependencies.
import type { AddieTool } from '../types.js';

/**
 * Directory tool definitions for Addie
 */
export const DIRECTORY_TOOLS: AddieTool[] = [
  {
    name: 'list_members',
    description: 'List visible AgenticAdvertising.org member organizations. Public profiles are always returned; API-tier callers also see organizations with members_only agents. Filter by offerings, markets, or search. Returns visibility-filtered agent details plus public/members-only registration counts; private registrations are excluded.',
    usage_hints: 'Use when asked about AgenticAdvertising.org members, member organizations, who is in the directory, or companies that offer specific services. Use agent_visibility_summary for registration counts and preserve visibility_scope when describing visible agent details.',
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
    description: 'Get an AgenticAdvertising.org member by slug. Returns visibility-filtered agent details plus public/members-only registration counts; private registrations are excluded.',
    usage_hints: 'Use when asked for details about a specific member organization. Use agent_visibility_summary for registration counts and preserve visibility_scope when describing visible agent details.',
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
    description: 'List AdCP agents visible to the caller. Public agents are always returned; callers on an API-access tier also receive members_only agents. Private agents are never returned. Can filter by agent type.',
    usage_hints: 'Use when asked about registered agents, what agents are available, or agents of a specific type. Preserve the visibility_scope qualification; this tool cannot establish the total number of private registrations.',
    input_schema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['brand', 'rights', 'measurement', 'governance', 'creative', 'sales', 'buying', 'signals'],
          description: 'Filter by agent type',
        },
      },
    },
  },
  {
    name: 'get_agent',
    description: 'Get details for a specific agent by URL when it is visible to the caller. Public agents are visible to everyone; members_only agents require an API-access tier; private agents are not returned.',
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
        force_refresh: {
          type: 'boolean',
          description: 'Bypass cache and fetch the publisher\'s adagents.json live (default: false). Use when the file was recently updated and a fresh result is needed.',
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
