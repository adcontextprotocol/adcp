// URL_TOOLS: the tool definitions of url-tools.ts, moved here verbatim so that
// readers of the catalog (the router, tool sets, eval harnesses) do not load
// the handlers and their service, database and SDK dependencies.
import type { AddieTool } from '../types.js';

/**
 * Tool definitions for URL/file fetching
 */
export const URL_TOOLS: AddieTool[] = [
  {
    name: 'fetch_url',
    description:
      'Fetch and read the content of a web URL. Use this when a user shares a link and asks about it, or when you need to read external content. Returns the text content of the page. Note: Does not work for pages requiring authentication.',
    usage_hints: 'use when user shares a link and asks "what is this?", "can you read this?", "summarize this article"',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to fetch (must be http:// or https://)',
        },
        extract_type: {
          type: 'string',
          enum: ['text', 'html', 'markdown'],
          description: 'How to extract content: text (plain text), html (raw HTML), markdown (converted to markdown). Default: text',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'read_slack_file',
    description:
      'Download and read a file that was shared in Slack. PROACTIVELY use this whenever a user shares a file (PDF, document, text file, image, etc.) - don\'t wait to be asked. Users expect you to see what they shared. Provide the file URL from the shared file info.',
    usage_hints: 'use IMMEDIATELY when you see "[Shared files]" in a message - read the file proactively',
    input_schema: {
      type: 'object',
      properties: {
        file_url: {
          type: 'string',
          description: 'The url_private or permalink from the Slack file share',
        },
        file_name: {
          type: 'string',
          description: 'The file name (helps with parsing)',
        },
      },
      required: ['file_url'],
    },
  },
];
