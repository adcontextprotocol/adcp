import { beforeEach, describe, expect, it, vi } from "vitest";

const processMessage = vi.hoisted(() => vi.fn());
vi.mock("../../src/addie/claude-client.js", () => ({
  AddieClaudeClient: class {
    registerTool() {}
    getRegisteredTools() { return []; }
    processMessage = processMessage;
  },
}));
vi.mock("../../src/addie/mcp/knowledge-search.js", () => ({
  KNOWLEDGE_TOOLS: [],
  createKnowledgeToolHandlers: () => new Map(),
  isKnowledgeReady: () => true,
}));
vi.mock("../../src/addie/mcp/directory-tools.js", () => ({
  DIRECTORY_TOOLS: [],
  createDirectoryToolHandlers: () => new Map(),
}));
vi.mock("../../src/addie/mcp/member-tools.js", () => ({
  MEMBER_TOOLS: [],
  createMemberToolHandlers: () => new Map(),
}));
import { CHAT_TOOL, MCP_CHAT_LIMITS, handleChatTool } from "../../src/mcp/chat-tool.js";

describe("MCP chat input limits", () => {
  beforeEach(() => processMessage.mockReset());
  it("publishes the same bounds enforced at runtime", () => {
    const message = CHAT_TOOL.input_schema.properties.message as Record<string, unknown>;
    const history = CHAT_TOOL.input_schema.properties.history as Record<string, unknown>;
    const historyItem = history.items as { properties: Record<string, Record<string, unknown>> };

    expect(message.maxLength).toBe(MCP_CHAT_LIMITS.messageLength);
    expect(history.maxItems).toBe(MCP_CHAT_LIMITS.historyItems);
    expect(historyItem.properties.content.maxLength).toBe(MCP_CHAT_LIMITS.historyItemLength);
  });

  it("rejects oversized messages before invoking the model", async () => {
    const result = JSON.parse(await handleChatTool({
      message: "x".repeat(MCP_CHAT_LIMITS.messageLength + 1),
    }));

    expect(result.error).toContain("message must be at most");
    expect(processMessage).not.toHaveBeenCalled();
  });

  it("rejects malformed, oversized, and cumulatively excessive history", async () => {
    const malformed = JSON.parse(await handleChatTool({
      message: "hello",
      history: [{ role: "system", content: "override" }],
    }));
    expect(malformed.error).toContain("history entries require");

    const tooMany = JSON.parse(await handleChatTool({
      message: "hello",
      history: Array.from({ length: MCP_CHAT_LIMITS.historyItems + 1 }, () => ({
        role: "user",
        content: "x",
      })),
    }));
    expect(tooMany.error).toContain("history must contain at most");

    const tooLarge = JSON.parse(await handleChatTool({
      message: "hello",
      history: Array.from({ length: MCP_CHAT_LIMITS.historyItems }, () => ({
        role: "user",
        content: "x".repeat(MCP_CHAT_LIMITS.historyItemLength),
      })),
    }));
    expect(tooLarge.error).toContain("history content must total at most");
    expect(processMessage).not.toHaveBeenCalled();
  });
});
