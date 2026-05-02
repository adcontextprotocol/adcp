/**
 * Standalone runner for the training agent.
 *
 * Starts an Express server with just the training agent MCP endpoint
 * for local testing without the full adcp server.
 *
 * Usage: npx tsx server/src/training-agent/standalone.ts
 */

import express, { type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createTrainingAgentServer } from './task-handlers.js';
import { startSessionCleanup } from './state.js';
import type { TrainingContext } from './types.js';

const PORT = parseInt(process.env.PORT || '4100', 10);

const app = express();
app.use(express.json());

// CORS
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Type');
  next();
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'healthy', service: 'training-agent-standalone' });
});

// Mirror server/src/training-agent/index.ts:68 — any bearer matching
// `demo-<a-z0-9-+>-v\d+` is accepted and stamped as `static:demo:<token>`.
// Lets standalone exercise the per-buyer-agent billing gate locally
// without booting the full server's auth chain.
const DEMO_TEST_KIT_KEY_PATTERN = /^demo-[a-z0-9]+(?:-[a-z0-9]+)*-v\d+$/;

function extractPrincipalFromBearer(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (typeof authHeader !== 'string' || !authHeader.toLowerCase().startsWith('bearer ')) {
    return undefined;
  }
  const token = authHeader.slice(7).trim();
  if (!DEMO_TEST_KIT_KEY_PATTERN.test(token)) return undefined;
  return `static:demo:${token}`;
}

async function handleMcpRequest(req: Request, res: Response) {
  let server: ReturnType<typeof createTrainingAgentServer> | null = null;
  try {
    const principal = extractPrincipalFromBearer(req);
    const ctx: TrainingContext = principal ? { mode: 'open', principal } : { mode: 'open' };
    server = createTrainingAgentServer(ctx);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('Training agent error:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32603, message: 'Internal server error' },
      });
    }
  } finally {
    await server?.close().catch(() => {});
  }
}

app.post('/', handleMcpRequest);
app.post('/api/training-agent/mcp', handleMcpRequest);
app.post('/mcp', handleMcpRequest);

app.options('/', (_req, res) => res.status(204).end());
app.options('/api/training-agent/mcp', (_req, res) => res.status(204).end());
app.options('/mcp', (_req, res) => res.status(204).end());

startSessionCleanup();

app.listen(PORT, () => {
  console.log(`Training agent running at http://localhost:${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/api/training-agent/mcp`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
});
