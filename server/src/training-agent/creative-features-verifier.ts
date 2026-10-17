/**
 * Public conformance verifier for provenance truth-of-claim storyboards.
 *
 * Serves exactly one tool, `get_creative_features`, at
 * `/governance/creative-features/mcp` so a seller under test has a real,
 * callable verifier on its `accepted_verifiers` allowlist (adcp#8199).
 *
 * - No bearer: the route is a deterministic fixture oracle with no account
 *   state, so there is nothing to protect. It is per-IP rate limited instead.
 * - Fixture-keyed: verdicts come from `handleGetCreativeFeatures` (asset URL
 *   substrings, then the claimed `digital_source_type`). Nothing is stored.
 * - Single tool: every other tool name is rejected as unknown. The route does
 *   not touch session state, accounts, or any tenant registry.
 */
import type { Request, Response, Router } from 'express';
import rateLimit from 'express-rate-limit';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from '../logger.js';
import { adcpError, handleGetCreativeFeatures } from './task-handlers.js';
import type { ToolArgs, TrainingContext } from './types.js';

const logger = createLogger('training-agent-creative-features-verifier');

import { CREATIVE_FEATURES_VERIFIER_PATH } from './creative-features-verifier-path.js';

export { CREATIVE_FEATURES_VERIFIER_PATH };
export const CREATIVE_FEATURES_VERIFIER_URL = `https://test-agent.adcontextprotocol.org${CREATIVE_FEATURES_VERIFIER_PATH}`;

/** Per-IP ceiling, separate from the authenticated MCP routes' bucket. */
const VERIFIER_RATE_LIMIT_PER_MINUTE = 300;
const MAX_ECHOED_TOOL_NAME = 64;

const TOOL_NAME = 'get_creative_features';

const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description:
    'Conformance verifier for provenance truth-of-claim storyboards. Returns deterministic, fixture-keyed ai_generated results: true for asset URLs containing "ai-generated-true", false for "ai-generated-false", otherwise derived from the claimed digital_source_type.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      creative_manifest: { type: 'object' as const, description: 'Creative manifest to evaluate.' },
      feature_ids: { type: 'array' as const, items: { type: 'string' as const }, minItems: 1 },
      idempotency_key: { type: 'string' as const },
      context: { type: 'object' as const },
    },
    required: ['creative_manifest'],
    additionalProperties: true,
  },
};

function createVerifierServer(): Server {
  const server = new Server(
    { name: 'adcp-training-agent-creative-features-verifier', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [TOOL_DEFINITION] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const rawArgs = (args as Record<string, unknown> | undefined) ?? {};
    const { context: callerContext, ...handlerArgs } = rawArgs;
    if (name !== TOOL_NAME) {
      return adcpError('INVALID_REQUEST', { message: `Unknown tool: ${String(name).slice(0, MAX_ECHOED_TOOL_NAME)}` }, callerContext);
    }
    if (!handlerArgs.creative_manifest || typeof handlerArgs.creative_manifest !== 'object') {
      return adcpError('INVALID_REQUEST', {
        message: 'creative_manifest is required',
        field: 'creative_manifest',
        recovery: 'correctable',
      }, callerContext);
    }
    const featureIds = handlerArgs.feature_ids;
    if (featureIds !== undefined && (!Array.isArray(featureIds) || featureIds.some(id => typeof id !== 'string'))) {
      return adcpError('INVALID_REQUEST', {
        message: 'feature_ids must be an array of strings',
        field: 'feature_ids',
        recovery: 'correctable',
      }, callerContext);
    }
    const result = await handleGetCreativeFeatures(handlerArgs as ToolArgs, {} as TrainingContext);
    // Audit observations name the governance agent that produced them; over
    // this route that is the public verifier URL a seller allowlists, not the
    // training agent's bare origin.
    const observations = result.audit_observations?.map(observation => ({
      ...observation,
      details: { ...observation.details, agent_url: CREATIVE_FEATURES_VERIFIER_URL },
    }));
    const verdict = observations ? { ...result, audit_observations: observations } : result;
    const body = callerContext !== undefined ? { ...verdict, context: callerContext } : verdict;
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(body) }],
      structuredContent: body as Record<string, unknown>,
    };
  });
  return server;
}

function setCors(res: Response): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, mcp-session-id, mcp-protocol-version');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Type');
}

export function mountCreativeFeaturesVerifier(router: Router, opts: { rateLimit: boolean }): void {
  const limiters = opts.rateLimit
    ? [rateLimit({
        windowMs: 60 * 1000,
        max: VERIFIER_RATE_LIMIT_PER_MINUTE,
        standardHeaders: true,
        legacyHeaders: false,
        validate: { xForwardedForHeader: false, ip: false },
        handler: (_req: Request, res: Response) => {
          setCors(res);
          res.status(429).json({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32000, message: 'Rate limit exceeded. Please try again later.' },
          });
        },
      })]
    : [];
  router.options(CREATIVE_FEATURES_VERIFIER_PATH, (_req: Request, res: Response) => {
    setCors(res);
    res.status(204).end();
  });
  router.get(CREATIVE_FEATURES_VERIFIER_PATH, (_req: Request, res: Response) => {
    setCors(res);
    res.setHeader('Allow', 'POST, OPTIONS');
    res.status(405).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: 'Method not allowed. Use POST for MCP requests.' },
    });
  });
  router.post(CREATIVE_FEATURES_VERIFIER_PATH, ...limiters, async (req: Request, res: Response) => {
    setCors(res);
    let server: Server | null = null;
    try {
      server = createVerifierServer();
      // The streamable transport needs both media types in Accept; plain JSON
      // callers (storyboard runners, curl) only send the first.
      const accept = req.headers.accept;
      if (typeof accept === 'string' && accept.includes('application/json') && !accept.includes('text/event-stream')) {
        const rewritten = `${accept}, text/event-stream`;
        req.headers.accept = rewritten;
        const raw = (req as unknown as { rawHeaders?: string[] }).rawHeaders;
        if (Array.isArray(raw)) {
          for (let i = 0; i < raw.length; i += 2) {
            if (raw[i].toLowerCase() === 'accept') raw[i + 1] = rewritten;
          }
        }
      }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error({ error }, 'Creative features verifier request error');
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal server error' } });
      }
    } finally {
      await server?.close().catch(() => {});
    }
  });
}
