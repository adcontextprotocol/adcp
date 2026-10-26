/**
 * Express auth for the sandbox identity route. Signed requests are verified
 * under Web Bot Auth and carry their identity claim to the framework, whose
 * identity33 hook enforces binding and demand-side grants. Unsigned callers
 * may only discover the agent.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { IncomingMessage } from 'node:http';
import { AuthError } from '@adcp/sdk/server';
import { createLogger } from '../../logger.js';
import type { Identity33Runtime } from './runtime.js';

const logger = createLogger('training-agent-identity33');

/** MCP methods and tools an unsigned caller may use to discover the agent. */
const UNSIGNED_METHODS = new Set(['initialize', 'notifications/initialized', 'tools/list', 'ping']);
const UNSIGNED_TOOLS = new Set(['get_adcp_capabilities']);

function unsignedAllowed(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const { method, params } = body as { method?: unknown; params?: { name?: unknown } };
  if (typeof method !== 'string') return false;
  if (UNSIGNED_METHODS.has(method)) return true;
  return method === 'tools/call' && typeof params?.name === 'string' && UNSIGNED_TOOLS.has(params.name);
}

function rpcError(res: Response, status: number, body: unknown, message: string, headers?: Record<string, string>): void {
  for (const [name, value] of Object.entries(headers ?? {})) res.setHeader(name, value);
  res.status(status).json({
    jsonrpc: '2.0',
    id: (body as { id?: unknown } | undefined)?.id ?? null,
    error: { code: -32001, message },
  });
}

/** The URL the signer signed, behind the TLS-terminating proxy. */
export function signedRequestUrl(req: IncomingMessage & { originalUrl?: string }): string {
  const forwarded = req.headers['x-forwarded-proto'];
  const proto = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim()
    ?? ((req.socket as { encrypted?: boolean } | undefined)?.encrypted ? 'https' : 'http');
  const host = req.headers.host;
  if (!host) throw new Error('identity33: missing Host header');
  return `${proto}://${host}${req.originalUrl ?? req.url ?? '/'}`;
}

export function requireIdentity33(runtime: Identity33Runtime): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    let principal;
    try {
      principal = await runtime.authenticate(req);
    } catch (err) {
      logger.warn({ err }, 'Identity route: signature rejected');
      if (err instanceof AuthError) {
        rpcError(res, err.status ?? 401, req.body, err.publicMessage, err.headers);
      } else {
        rpcError(res, 401, req.body, 'Signature rejected.');
      }
      return;
    }
    if (!principal) {
      if (unsignedAllowed(req.body)) return next();
      rpcError(res, 401, req.body, 'This endpoint requires a Web Bot Auth signature (AdCP 3.3, experimental).');
      return;
    }
    // The tenant bridge leaves a pre-set req.auth alone, so the identity
    // claim reaches ctx.authInfo for the framework's identity33 hook.
    (req as { auth?: unknown }).auth = {
      token: '',
      clientId: principal.principal,
      scopes: [],
      extra: {
        ...principal.extra,
        ...(principal.credential && { credential: principal.credential }),
      },
    };
    next();
  };
}

/** Operations this route will not perform without a verified signature. */
export const IDENTITY33_REQUIRED_FOR = [
  'sync_principal',
  'sync_accounts',
  'create_media_buy',
  'update_media_buy',
  'sync_creatives',
] as const;

/**
 * Adds the identity route's experimental 3.3 posture to its capability
 * response: the Web Bot Auth request-signing profile and open sandbox
 * onboarding. Runs after the tenant's own capability projection.
 */
export function advertiseIdentity33Capabilities(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const body = req.body as { method?: unknown; params?: { name?: unknown } } | undefined;
    if (body?.method !== 'tools/call' || body.params?.name !== 'get_adcp_capabilities') return next();
    const end = res.end.bind(res) as (...args: unknown[]) => Response;
    (res as unknown as { end: (...args: unknown[]) => Response }).end = (chunk?: unknown, ...rest: unknown[]) => {
      if (chunk === undefined || chunk === null) return end(chunk, ...rest);
      try {
        const parsed = JSON.parse(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)) as {
          result?: { content?: Array<{ type?: string; text?: string }>; structuredContent?: Record<string, unknown> };
        };
        const structured = parsed.result?.structuredContent;
        if (!structured || structured.adcp_error) return end(chunk, ...rest);
        const mirrored = parsed.result?.content?.[0];
        const textMirrorsStructured = mirrored?.type === 'text' && mirrored.text === JSON.stringify(structured);
        structured.request_signing = {
          supported: true,
          profiles: ['web-bot-auth'],
          covers_content_digest: 'either',
          required_for: [...IDENTITY33_REQUIRED_FOR],
        };
        const account = structured.account && typeof structured.account === 'object' ? structured.account : {};
        structured.account = { ...account, agent_onboarding: { sandbox: { mode: 'open' } } };
        const features = Array.isArray(structured.experimental_features)
          ? structured.experimental_features.filter((feature): feature is string => typeof feature === 'string')
          : [];
        for (const feature of ['signing.web_bot_auth', 'account.agent_onboarding']) {
          if (!features.includes(feature)) features.push(feature);
        }
        structured.experimental_features = features;
        if (textMirrorsStructured && mirrored) mirrored.text = JSON.stringify(structured);
        const patched = Buffer.from(JSON.stringify(parsed), 'utf8');
        if (!res.headersSent) res.setHeader('content-length', String(patched.length));
        return end(patched, ...rest);
      } catch {
        return end(chunk, ...rest);
      }
    };
    next();
  };
}

