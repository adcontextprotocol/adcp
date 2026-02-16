/**
 * Shared baseline tool registration for all Addie channels (Slack, Web, etc.)
 *
 * Registers context-free tools that don't require per-user or per-channel state.
 * Both bolt-app.ts (Slack) and addie-chat.ts (Web) call this to stay in sync.
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
} from "./mcp/knowledge-search.js";
import {
  BILLING_TOOLS,
  createBillingToolHandlers,
} from "./mcp/billing-tools.js";
import {
  SCHEMA_TOOLS,
  createSchemaToolHandlers,
} from "./mcp/schema-tools.js";
import {
  DIRECTORY_TOOLS,
  createDirectoryToolHandlers,
} from "./mcp/directory-tools.js";
import {
  BRAND_TOOLS,
  createBrandToolHandlers,
} from "./mcp/brand-tools.js";
import {
  PROPERTY_TOOLS,
  createPropertyToolHandlers,
} from "./mcp/property-tools.js";

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
 * Register all context-free baseline tools on a ClaudeClient instance.
 * Call this during initialization for any channel.
 */
export async function registerBaselineTools(client: AddieClaudeClient): Promise<void> {
  await initializeKnowledgeSearch();

  registerToolsFromMap(client, KNOWLEDGE_TOOLS, createKnowledgeToolHandlers());
  registerToolsFromMap(client, BILLING_TOOLS, createBillingToolHandlers());
  registerToolsFromMap(client, SCHEMA_TOOLS, createSchemaToolHandlers());
  registerToolsFromMap(client, DIRECTORY_TOOLS, createDirectoryToolHandlers());
  registerToolsFromMap(client, BRAND_TOOLS, createBrandToolHandlers());
  registerToolsFromMap(client, PROPERTY_TOOLS, createPropertyToolHandlers());
}
