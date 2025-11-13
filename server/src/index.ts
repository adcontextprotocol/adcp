import { MCPServer } from "./mcp.js";
import { HTTPServer } from "./http.js";

// Check if running as MCP server (stdio) or HTTP server
const mode = process.env.MODE || "http";

if (mode === "mcp") {
  const mcpServer = new MCPServer();
  mcpServer.start().catch((error) => {
    console.error("Failed to start MCP server:", error);
    process.exit(1);
  });
} else {
  const httpServer = new HTTPServer();
  const port = parseInt(process.env.PORT || process.env.CONDUCTOR_PORT || "3000", 10);
  httpServer.start(port).catch((error) => {
    console.error("Failed to start HTTP server:", error);
    process.exit(1);
  });
}
