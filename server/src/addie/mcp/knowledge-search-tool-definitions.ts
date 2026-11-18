// KNOWLEDGE_TOOLS: the tool definitions of knowledge-search.ts, moved here verbatim so that
// readers of the catalog (the router, tool sets, eval harnesses) do not load
// the handlers and their service, database and SDK dependencies.
import type { AddieTool } from '../types.js';

/**
 * Tool definitions for Claude
 *
 * We provide search tools and a bookmark tool:
 * 1. search_docs - Search our Mintlify documentation (fast, local, authoritative for AdCP)
 * 2. search_repos - Search external GitHub repos (sales-agent, client libraries)
 * 3. search_slack - Search community discussions (real-world context)
 * 4. search_resources - Search curated external resources with Addie's analysis
 * 5. bookmark_resource - Save useful web content to knowledge base for future reference
 *
 * Web search is provided by Claude's built-in tool for external sources.
 */
export const KNOWLEDGE_TOOLS: AddieTool[] = [
  {
    name: 'search_docs',
    replaySafety: 'pure_local',
    description:
      'Search official AdCP docs, extracted schema facts, and working group documents. Protocol results are isolated by release and always name their version. Pass version when the user names one; omission means stable, never beta. Website and working group results are version-independent. Use one specific query. Verify exact fields and enums with get_schema at the same version, use list_schemas for schema availability, and use get_doc for full content.',
    usage_hints: 'use for learning, understanding concepts, "how does X work?", "what is X?", "explain X", brand guidelines, working group documents',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query - use specific keywords (e.g., "media buy workflow" not "how does buying work")',
        },
        category: {
          type: 'string',
          description: 'Optional category filter. Protocol docs: media-buy, signals, creative, intro, reference. Working group docs: "working group: <name>" (e.g., "working group: marketing").',
        },
        version: {
          type: 'string',
          description: 'Protocol docs version. Omission means stable 3.2; pass 3.1 or 3.0 for an earlier stable release. Explicit channel and exact frozen snapshot selectors are also accepted.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 5,
          description: 'Maximum results (default 3, max 5). Use fewer results for simple questions.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_doc',
    replaySafety: 'pure_local',
    description:
      'Get the full content of a specific documentation page by ID. Canonical IDs returned by search_docs already include the version. For a legacy unversioned ID, pass version; omitted version means stable default.',
    usage_hints: 'use after search_docs to read complete doc details',
    input_schema: {
      type: 'object',
      properties: {
        doc_id: {
          type: 'string',
          description: 'The document ID from search_docs results',
        },
        version: {
          type: 'string',
          description: 'Optional protocol version for legacy unversioned IDs. Omission means stable 3.2.',
        },
      },
      required: ['doc_id'],
    },
  },
  {
    name: 'search_repos',
    description:
      'Search indexed external GitHub repositories for ad tech specifications and protocols. Includes: ' +
      'AdCP (core protocol spec, sales agent, signals agent, JS/Python/Go clients), ' +
      'A2A (Google Agent-to-Agent protocol and samples), ' +
      'MCP (Model Context Protocol spec, TypeScript/Python SDKs, reference servers), ' +
      'IAB Tech Lab specs (OpenRTB 2.x/3.0, AdCOM, OpenDirect, ARTF, UCP, GPP, TCF, US Privacy, UID2, VAST, ads.cert), ' +
      'Prebid (full documentation site with configuration guides, bidder adapter docs, ad ops workflows, GAM integration, troubleshooting, Prebid Mobile, and video; plus Prebid.js source with module docs, and Prebid Server source), ' +
      'and LangGraph. ' +
      'Use this for protocol details, spec comparisons, implementation examples, and SDK usage.',
    usage_hints:
      'use for: OpenRTB questions, A2A protocol, MCP implementation, IAB specs, Prebid configuration/adapters/troubleshooting/GAM, TCF/GPP consent, UID2, salesagent setup, SDK usage',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query - use relevant keywords from the question',
        },
        repo_id: {
          type: 'string',
          description:
            'Optional filter to search only a specific repo: adcp, salesagent, signals-agent, adcp-client, adcp-client-python, adcp-go, a2a, a2a-samples, mcp-spec, mcp-typescript-sdk, mcp-python-sdk, mcp-servers, iab-artf, iab-ucp, iab-openrtb2, iab-openrtb3, iab-adcom, iab-opendirect, iab-gpp, iab-tcf, iab-usprivacy, iab-uid2-docs, iab-vast, iab-adscert, prebid-js, prebid-server, prebid-docs, langgraph',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default 3)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_slack',
    description:
      'Search Slack messages from public channels in the AAO workspace. Use this when you need community discussions, Q&A threads, or real-world implementation examples. When asked about a specific channel or working group (e.g., "Governance working group"), use the channel parameter to filter results. When asked to summarize discussions, search for relevant keywords then synthesize the results. Cite the Slack permalink when using information from results.',
    usage_hints: 'use for community Q&A, "what did someone say about X?", channel summaries, working group discussions',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query - keywords or phrases to find in Slack messages. Use broad terms when summarizing a channel (e.g., "governance" for governance discussions).',
        },
        channel: {
          type: 'string',
          description: 'Optional channel name to filter results (e.g., "technical-standards-wg", "general"). Partial matches work.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default 10, max 25 for summaries)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_channel_activity',
    description:
      'Get recent messages from a specific Slack channel. Use this when asked to summarize channel activity, see what a working group has been discussing, or get an overview of conversations in a channel. Returns messages sorted by recency. After getting results, synthesize them into a summary for the user.',
    usage_hints: 'use for "summarize the governance channel", "what has the X working group been discussing?", channel overviews',
    input_schema: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          description: 'Channel name to get activity from (e.g., "technical-standards-wg", "general"). Partial matches work.',
        },
        days: {
          type: 'number',
          description: 'How many days back to look (default 30, max 90)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of messages to return (default 25, max 50)',
        },
      },
      required: ['channel'],
    },
  },
  {
    name: 'search_resources',
    description:
      'Search curated external resources (articles, blog posts, industry content) that have been indexed with summaries and contextual analysis. Use this for industry trends, competitor info, and external perspectives on agentic advertising.',
    usage_hints: 'use for industry trends, competitor info, external perspectives on agentic advertising',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query - keywords or phrases',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by relevance tags (e.g., mcp, a2a, industry-trend, competitor)',
        },
        min_quality: {
          type: 'number',
          description: 'Minimum quality score 1-5 (default: no filter)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default 5)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'bookmark_resource',
    description:
      'Save a useful web resource to the knowledge base for future reference. Use this when you find valuable external content during web search that would be helpful for future questions. The content will be fetched, summarized, and indexed.',
    usage_hints: 'use when finding useful external content to save for future reference',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL of the resource to bookmark',
        },
        title: {
          type: 'string',
          description: 'Title of the resource',
        },
        reason: {
          type: 'string',
          description: 'Brief explanation of why this resource is valuable (helps with categorization)',
        },
      },
      required: ['url', 'title', 'reason'],
    },
  },
  {
    name: 'get_recent_news',
    description:
      'Get recent news and articles about ad tech and agentic advertising from curated industry feeds. Returns articles sorted by recency with summaries and analysis. Use this when users ask "what\'s happening in the news?", "what\'s new in ad tech?", or "what have we learned lately?"',
    usage_hints: 'use for recent news, "what\'s happening?", "what\'s new?", industry updates, trending topics',
    input_schema: {
      type: 'object',
      properties: {
        days: {
          type: 'number',
          description: 'How many days back to look (default 7, max 30)',
        },
        topic: {
          type: 'string',
          description: 'Optional topic filter (e.g., "agentic advertising", "CTV", "retail media")',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by relevance tags (e.g., mcp, a2a, industry-trend, competitor)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of articles (default 10, max 20)',
        },
      },
      required: [],
    },
  },
];
