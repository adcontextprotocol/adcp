/**
 * Smoke demo: stand up a tiny MCP server, connect to Addie via Socket
 * Mode, hold the connection until Ctrl-C.
 *
 * Uses the published `ConformanceClient` from `@adcp/sdk/server` (6.9+).
 *
 * Run:
 *   ADCP_CONFORMANCE_TOKEN=<token> \
 *   ADCP_CONFORMANCE_URL=ws://localhost:3000/conformance/connect \
 *     npx tsx examples/conformance-client/demo.ts
 *
 * Get a token from your Addie session by POSTing to /api/conformance/token
 * with your WorkOS session cookie.
 */

import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { ConformanceClient } from '@adcp/sdk/server';

const url = process.env.ADCP_CONFORMANCE_URL ?? 'ws://localhost:3000/conformance/connect';
const token = process.env.ADCP_CONFORMANCE_TOKEN;
if (!token) {
  console.error('ADCP_CONFORMANCE_TOKEN is required. POST /api/conformance/token to get one.');
  process.exit(1);
}

const server = new McpServer(
  { name: 'demo-adopter', version: '0.0.1' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'ping', description: 'health check', inputSchema: { type: 'object', properties: {} } },
    {
      name: 'echo',
      description: 'echoes the input',
      inputSchema: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'ping') {
    return { content: [{ type: 'text', text: 'pong' }] };
  }
  if (req.params.name === 'echo') {
    const msg = (req.params.arguments?.message as string | undefined) ?? '';
    return { content: [{ type: 'text', text: msg }] };
  }
  throw new Error(`unknown tool ${req.params.name}`);
});

const client = new ConformanceClient({
  url,
  token,
  server,
  onStatus: (status, detail) => {
    const attempt = detail?.attempt ? ` attempt=${detail.attempt}` : '';
    const error = detail?.error ? ` error=${detail.error.message}` : '';
    console.log(`[conformance] status=${status}${attempt}${error}`);
  },
});

await client.start();
console.log('Connected. Holding socket — press Ctrl-C to disconnect.');

const shutdown = async () => {
  console.log('Shutting down…');
  await client.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
