import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const registerTool = vi.fn();

vi.mock('../../src/addie/mcp/knowledge-search.js', () => ({
  initializeKnowledgeSearch: vi.fn().mockResolvedValue(undefined),
  KNOWLEDGE_TOOLS: [
    { name: 'search_docs', input_schema: {} },
    { name: 'search_slack', input_schema: {} },
    { name: 'get_channel_activity', input_schema: {} },
  ],
  createKnowledgeToolHandlers: () => new Map([
    ['search_docs', vi.fn()],
    ['search_slack', vi.fn()],
    ['get_channel_activity', vi.fn()],
  ]),
  isSlackKnowledgeTool: (tool: { name: string }) =>
    tool.name === 'search_slack' || tool.name === 'get_channel_activity',
}));

vi.mock('../../src/addie/mcp/billing-tools.js', () => ({ BILLING_TOOLS: [], createBillingToolHandlers: () => new Map() }));
vi.mock('../../src/addie/mcp/schema-tools.js', () => ({ SCHEMA_TOOLS: [], createSchemaToolHandlers: () => new Map() }));
vi.mock('../../src/addie/mcp/directory-tools.js', () => ({ DIRECTORY_TOOLS: [], createDirectoryToolHandlers: () => new Map() }));
vi.mock('../../src/addie/mcp/brand-tools.js', () => ({ BRAND_TOOLS: [], createBrandToolHandlers: () => new Map() }));
vi.mock('../../src/addie/mcp/brand-canonical-tools.js', () => ({ BRAND_CANONICAL_TOOLS: [], createBrandCanonicalToolHandlers: () => new Map() }));
vi.mock('../../src/addie/mcp/property-tools.js', () => ({ PROPERTY_TOOLS: [], createPropertyToolHandlers: () => new Map() }));

import type { AddieClaudeClient } from '../../src/addie/claude-client.js';
import { registerBaselineTools } from '../../src/addie/register-baseline-tools.js';

describe('Slack knowledge global registration', () => {
  it('does not install Slack search or activity on the shared baseline client', async () => {
    const client = { registerTool } as unknown as AddieClaudeClient;
    await registerBaselineTools(client);

    const registeredNames = registerTool.mock.calls.map(([tool]) => tool.name);
    expect(registeredNames).toContain('search_docs');
    expect(registeredNames).not.toContain('search_slack');
    expect(registeredNames).not.toContain('get_channel_activity');
  });

  it('keeps every shared-client registration site structurally scoped', () => {
    const baseline = readFileSync(new URL('../../src/addie/register-baseline-tools.ts', import.meta.url), 'utf8');
    const legacy = readFileSync(new URL('../../src/addie/handler.ts', import.meta.url), 'utf8');
    const web = readFileSync(new URL('../../src/routes/addie-chat.ts', import.meta.url), 'utf8');
    const voice = readFileSync(new URL('../../src/routes/tavus.ts', import.meta.url), 'utf8');

    expect(baseline).toContain('KNOWLEDGE_TOOLS.filter((tool) => !isSlackKnowledgeTool(tool))');
    expect(legacy).toContain('KNOWLEDGE_TOOLS.filter((tool) => !isSlackKnowledgeTool(tool))');
    expect(web).toContain('if (isSlackKnowledgeTool(tool)) continue;');
    expect(voice).toContain('KNOWLEDGE_TOOLS.filter((tool) => !isSlackKnowledgeTool(tool))');
    expect(web).toContain('const slackKnowledge = createSlackKnowledgeRequestTools(');
    expect(web).toContain("? { kind: 'slack-user', slackUserId: linkedSlackUserId }");
    expect(web).toContain("  : { kind: 'public-only' }");
    expect(web).toContain('allTools.push(...slackKnowledge.tools);');
    expect(voice).toContain('const slackKnowledge = createSlackKnowledgeRequestTools(');
    expect(voice).toContain("? { kind: 'slack-user', slackUserId: linkedSlackUserId }");
    expect(voice).toContain("  : { kind: 'public-only' }");
    expect(voice).toContain('allTools.push(...slackKnowledge.tools);');
  });
});
