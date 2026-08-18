/**
 * Reference creative agent route setup.
 *
 * Mounts the MCP endpoint at /api/creative-agent/mcp and a preview
 * hosting endpoint at /api/creative-agent/preview/:id.
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createLogger } from '../logger.js';
import { constantTimeEqual } from '../utils/constant-time-equal.js';
import { createCreativeAgentServer } from './task-handlers.js';
import {
  getPreview,
  getPreviewAssetSource,
  getOrCreatePreviewAssetDownload,
  releasePreviewAssetDownload,
  cleanExpiredPreviews,
  MAX_PREVIEW_ASSET_BYTES,
} from './preview-store.js';
import { CommunityMirrorDatabase } from '../db/community-mirror-db.js';
import { safeFetch } from '../utils/url-security.js';

const logger = createLogger('creative-agent-routes');

const CREATIVE_AGENT_TOKEN = process.env.CREATIVE_AGENT_TOKEN;
const STARTUP_TIME = new Date().toISOString();
const ALLOWED_PREVIEW_ASSET_TYPES = new Set([
  'image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp',
  'video/mp4', 'video/quicktime', 'video/webm',
  'audio/aac', 'audio/flac', 'audio/mp4', 'audio/mpeg', 'audio/ogg',
  'audio/wav', 'audio/webm', 'audio/x-wav',
]);

class PreviewAssetTooLargeError extends Error {}

async function downloadPreviewAsset(sourceUrl: string, token: string) {
  const upstream = await safeFetch(sourceUrl, {
    method: 'GET',
    maxRedirects: 0,
    headers: { Accept: 'image/avif,image/gif,image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm,audio/*' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!upstream.ok || !upstream.body) throw new Error('Preview asset fetch failed');

  const contentType = upstream.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? '';
  if (!ALLOWED_PREVIEW_ASSET_TYPES.has(contentType)) {
    await upstream.body.cancel();
    throw new TypeError('Unsupported preview asset type');
  }
  const declaredLength = Number(upstream.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PREVIEW_ASSET_BYTES) {
    await upstream.body.cancel();
    throw new PreviewAssetTooLargeError('Preview asset exceeds size limit');
  }

  const path = join(tmpdir(), `adcp-preview-asset-${token}`);
  let size = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      callback(size > MAX_PREVIEW_ASSET_BYTES
        ? new PreviewAssetTooLargeError('Preview asset exceeds size limit')
        : null, chunk);
    },
  });
  try {
    // Both the network and file streams honor backpressure. The completed file
    // is then shared by all requests for this token rather than re-fetched.
    await pipeline(
      Readable.from(upstream.body as AsyncIterable<Uint8Array>),
      limiter,
      createWriteStream(path, { flags: 'wx', mode: 0o600 }),
    );
    return { path, contentType, size };
  } catch (error) {
    await unlink(path).catch(() => {});
    throw error;
  }
}

function setCORSHeaders(res: Response): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Type');
}

function requireToken(req: Request, res: Response, next: NextFunction): void {
  if (!CREATIVE_AGENT_TOKEN) {
    return next();
  }
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ') || !constantTimeEqual(auth.slice(7), CREATIVE_AGENT_TOKEN)) {
    res.status(401).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: 'Invalid or missing bearer token' },
    });
    return;
  }
  next();
}

export function previewQuotaKey(req: Request): string {
  // The reference endpoint has a single optional bearer secret rather than
  // user accounts. Bind that authenticated credential to the caller's network
  // identity; anonymous callers are isolated by the same network quota key.
  const credential = req.headers.authorization ?? 'anonymous';
  const network = ipKeyGenerator(req.ip ?? req.socket?.remoteAddress ?? 'unknown');
  return createHash('sha256').update(`${credential}\0${network}`).digest('hex');
}

const CREATIVE_AGENT_HOST = 'creative.adcontextprotocol.org';

/**
 * Resolve the agent base URL from the request.
 * When accessed via the dedicated creative.adcontextprotocol.org hostname,
 * routes are at root, so the agent base is just the origin.
 * Otherwise, the agent is mounted at /api/creative-agent under the main app.
 */
function getAgentBaseUrl(req: Request): string {
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  if (typeof host === 'string' && (host === CREATIVE_AGENT_HOST || host.startsWith(CREATIVE_AGENT_HOST + ':'))) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    return `${proto}://${CREATIVE_AGENT_HOST}`;
  }
  const baseUrl = process.env.BASE_URL
    ? process.env.BASE_URL.replace(/\/$/, '')
    : `${req.headers['x-forwarded-proto'] || req.protocol || 'http'}://${host}`;
  return `${baseUrl}/api/creative-agent`;
}

export function createCreativeAgentRouter(): Router {
  const router = Router();
  const mirrorDb = new CommunityMirrorDatabase();

  // Clean expired previews every 5 minutes
  const cleanupInterval = setInterval(() => cleanExpiredPreviews(), 5 * 60 * 1000);
  cleanupInterval.unref();

  // Health check
  router.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'healthy', service: 'creative-agent' });
  });

  // adagents.json discovery
  router.get('/.well-known/adagents.json', (req: Request, res: Response) => {
    const agentBaseUrl = getAgentBaseUrl(req);

    res.json({
      $schema: '/schemas/adagents.json',
      contact: {
        name: 'AdCP Reference Creative Agent',
        url: 'https://adcontextprotocol.org',
      },
      agents: [{
        url: `${agentBaseUrl}/mcp`,
        type: 'creative',
        capabilities: ['get_adcp_capabilities', 'preview_creative'],
      }],
      last_updated: STARTUP_TIME,
    });
  });

  // Community-mirror serving route (#2176): serves the stored catalog-only
  // adagents.json for an unadopted platform at the canonical mirror URL
  // creative.adcontextprotocol.org/translated/<platform>/adagents.json.
  router.get('/translated/:platform/adagents.json', async (req: Request, res: Response) => {
    const platform = String(req.params.platform).toLowerCase();
    if (!/^[a-z0-9_-]{1,64}$/.test(platform)) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(400).json({ error: 'Invalid platform identifier' });
    }
    try {
      const mirror = await mirrorDb.getByPlatform(platform);
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (!mirror) {
        return res.status(404).json({ error: 'Community mirror not found' });
      }

      const serialized = JSON.stringify(mirror.adagents_json);
      // HTTP cache validation must follow the served bytes. `catalog_etag` is
      // provenance supplied with the catalog and may be reused accidentally;
      // using it here could return 304 after the mirror content changed.
      const etagValue = createHash('sha256').update(serialized).digest('hex').slice(0, 32);
      const etag = `"${etagValue}"`;

      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', 'public, max-age=300');
      // superseded_by lifecycle: the normative signal is the body field (buyer
      // SDKs re-fetch the named URL); this Link header is an additive cache hint
      // for caches keyed on the mirror URL, not the spec-defined mechanism.
      if (mirror.superseded_by) {
        res.setHeader('Link', `<${mirror.superseded_by}>; rel="successor-version"`);
      }

      if (req.headers['if-none-match'] === etag) {
        return res.status(304).end();
      }
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return res.status(200).send(serialized);
    } catch (error) {
      logger.error({ error, platform }, 'Failed to serve translated community mirror');
      return res.status(500).json({ error: 'Failed to serve mirror' });
    }
  });

  // CORS preflight
  router.options('/mcp', (_req: Request, res: Response) => {
    setCORSHeaders(res);
    res.status(204).end();
  });

  // Rate limiting
  const mcpRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false, ip: false },
    handler: (_req: Request, res: Response) => {
      res.status(429).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: 'Rate limit exceeded. Please try again later.' },
      });
    },
  });
  const previewAssetRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false, ip: false },
  });

  // MCP endpoint
  router.post('/mcp', mcpRateLimiter, requireToken, async (req: Request, res: Response) => {
    setCORSHeaders(res);

    let server: ReturnType<typeof createCreativeAgentServer> | null = null;
    try {
      const agentBaseUrl = getAgentBaseUrl(req);
      server = createCreativeAgentServer(agentBaseUrl, previewQuotaKey(req));
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      await server.connect(transport);

      logger.debug({ method: req.body?.method, ip: req.ip }, 'Creative agent: handling request');

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error({ error }, 'Creative agent: request error');
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
  });

  // GET/DELETE not supported (stateless server — no SSE streams or session termination)
  router.get('/mcp', (_req: Request, res: Response) => {
    setCORSHeaders(res);
    res.setHeader('Allow', 'POST, OPTIONS');
    res.status(405).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: 'Method not allowed. Use POST for MCP requests.' },
    });
  });

  router.delete('/mcp', (_req: Request, res: Response) => {
    setCORSHeaders(res);
    res.setHeader('Allow', 'POST, OPTIONS');
    res.status(405).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: 'Method not allowed. Use POST for MCP requests.' },
    });
  });

  // Preview hosting endpoint
  router.get('/preview-assets/:id', previewAssetRateLimiter, async (req: Request, res: Response) => {
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; sandbox");
    const tokenExists = getPreviewAssetSource(req.params.id) !== null;
    const assetDownload = getOrCreatePreviewAssetDownload(
      req.params.id,
      MAX_PREVIEW_ASSET_BYTES,
      sourceUrl => downloadPreviewAsset(sourceUrl, req.params.id),
    );
    if (!assetDownload) {
      res.status(tokenExists ? 503 : 404).send(tokenExists
        ? 'Preview asset capacity is temporarily unavailable'
        : 'Preview asset not found or expired');
      return;
    }
    try {
      const asset = await assetDownload;
      res.setHeader('Content-Type', asset.contentType);
      res.setHeader('Content-Length', asset.size);
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.status(200);
      await pipeline(createReadStream(asset.path), res);
    } catch (error) {
      logger.warn({ error }, 'Creative agent: preview asset proxy failed');
      if (!res.headersSent) {
        res.status(error instanceof PreviewAssetTooLargeError ? 413 : error instanceof TypeError ? 415 : 502)
          .send(error instanceof PreviewAssetTooLargeError
            ? 'Preview asset exceeds size limit'
            : error instanceof TypeError
              ? 'Unsupported preview asset type'
              : 'Preview asset fetch failed');
      } else {
        res.destroy();
      }
    } finally {
      releasePreviewAssetDownload(req.params.id);
    }
  });

  router.get('/preview/:id', (req: Request, res: Response) => {
    const html = getPreview(req.params.id);
    if (!html) {
      res.status(404).send('Preview not found or expired');
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors *");
    res.send(html);
  });

  logger.info('Creative agent routes configured');
  return router;
}
