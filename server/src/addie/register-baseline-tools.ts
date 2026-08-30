/**
 * Shared baseline tool registration for all Addie channels (Slack, Web, etc.)
 *
 * Registers context-free tools intentionally retained on every request.
 * Route-scoped domains are registered by each channel as request tools.
 *
 * Channel-specific tools (URL fetching with Slack token, Google Docs, etc.)
 * are registered separately by each channel handler.
 */

import type { AddieClaudeClient } from "./claude-client.js";
import type { AddieTool } from "./types.js";
import {
  initializeKnowledgeSearch,
  KNOWLEDGE_TOOLS,
  createKnowledgeToolHandlers,
  isSlackKnowledgeTool,
} from "./mcp/knowledge-search.js";
import {
  SCHEMA_TOOLS,
  createSchemaToolHandlers,
} from "./mcp/schema-tools.js";
import {
  DIRECTORY_TOOLS,
  createDirectoryToolHandlers,
} from "./mcp/directory-tools.js";

function registerToolsFromMap(
  client: AddieClaudeClient,
  tools: AddieTool[],
  handlers: Map<string, (args: Record<string, unknown>) => Promise<string>>
): void {
  for (const tool of tools) {
    const handler = handlers.get(tool.name);
    if (handler) {
      client.registerTool(tool, handler);
    }
  }
}

/**
 * Register the shared baseline tools that remain global on a ClaudeClient.
 * Call this during initialization for any channel.
 */
export async function registerBaselineTools(client: AddieClaudeClient): Promise<void> {
  await initializeKnowledgeSearch();

  // Slack history is request-scoped because private-channel visibility depends
  // on the current caller. Never install these handlers on the shared client.
  registerToolsFromMap(
    client,
    KNOWLEDGE_TOOLS.filter((tool) => !isSlackKnowledgeTool(tool)),
    createKnowledgeToolHandlers({ slackAccess: { kind: 'public-only' } }),
  );
  registerToolsFromMap(client, SCHEMA_TOOLS, createSchemaToolHandlers());
  registerToolsFromMap(client, DIRECTORY_TOOLS, createDirectoryToolHandlers());
}
