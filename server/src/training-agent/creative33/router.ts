import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import path from 'node:path';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  adcpError,
  AdcpError,
  adcpOperationResolver,
  createAdcpServerFromPlatform,
  createInMemoryTaskRegistry,
  createPostgresTaskRegistry,
  InMemoryStateStore,
  PostgresStateStore,
  type AdcpStateStore,
} from '@adcp/sdk/server';
import { UNRESOLVABLE_OPERATION } from '@adcp/sdk/signing';
import { getPool } from '../../db/client.js';
import { createLogger } from '../../logger.js';
import { getSdkIdempotencyStore } from '../idempotency.js';
import { getCanonicalToolValidator, ValidateInputRequestSchema } from '@adcp/sdk/schemas';
import { createCreative33Sandbox } from './platform.js';
import { ensureTrainingAgentSchemaBundle } from '../schema-compat.js';
import { CREATIVE33_MCP_ROUTE } from '../lab-route-paths.js';
import {
  CREATIVE33_HTML_SCHEMA_BYTES, CREATIVE33_RESPONSIVE_HTML, CREATIVE33_ZIP_BYTES,
} from './catalog.js';

export const CREATIVE33_ROUTE = CREATIVE33_MCP_ROUTE;
export const CREATIVE33_WIRE_VERSION = '3.3-beta.0';
export const CREATIVE33_BUNDLE_VERSION = '3.3.0-beta.0';
const NAMESPACE = 'adcp-training-agent:creative33';
const logger = createLogger('training-agent-creative33');
const TOOLS = new Set([
  'get_adcp_capabilities', 'list_accounts', 'build_creative', 'sync_creatives',
  'list_creatives', 'preview_creative', 'get_creative_delivery', 'comply_test_controller',
  'validate_input',
]);

export function creative33SandboxEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const configured = env.ENABLE_ADCP_3_3_CREATIVE_ROUTE;
  if (configured !== undefined) return configured === '1' || configured.toLowerCase() === 'true';
  return env.NODE_ENV === 'test' || env.NODE_ENV === 'development';
}

/** Separate physical collections from stable-domain and SDK bookkeeping rows.
 * scopedStore remains free to apply exactly one caller/account scope inside it. */
function prefixedStore(store: AdcpStateStore, prefix: string): AdcpStateStore {
  return {
    get: (collection, id) => store.get(prefix + collection, id),
    put: (collection, id, data) => store.put(prefix + collection, id, data),
    patch: (collection, id, data) => store.patch(prefix + collection, id, data),
    delete: (collection, id) => store.delete(prefix + collection, id),
    list: (collection, options) => store.list(prefix + collection, options),
    ...(store.getWithVersion && {
      getWithVersion: <T extends Record<string, unknown>>(collection: string, id: string) =>
        store.getWithVersion!<T>(prefix + collection, id),
    }),
    ...(store.putIfMatch && {
      putIfMatch: (collection: string, id: string, data: Record<string, unknown>, version: number | null) =>
        store.putIfMatch!(prefix + collection, id, data, version),
    }),
  };
}

function cors(res: Response): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id, Signature, Signature-Input, Content-Digest');
}

/** The beta fixture is synchronous. Hide the SDK's optional native task
 * transport and reject its dispatch before any tool or storage runs. */
function synchronousDiscovery(req: Request, res: Response): void {
  if (req.body?.method !== 'initialize' && req.body?.method !== 'tools/list') return;
  const end = res.end.bind(res) as (...args: unknown[]) => Response;
  const chunks: Buffer[] = [];
  const buffer = (chunk: unknown) => Buffer.isBuffer(chunk) ? chunk
    : chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(String(chunk), 'utf8');
  // MCP's Web Response adapter writes chunks before calling end() without a
  // body. Buffer both paths, and remove the old length before headers are sent.
  const writeHead = res.writeHead.bind(res) as unknown as (...args: unknown[]) => Response;
  (res as unknown as { writeHead: (...args: unknown[]) => Response }).writeHead = (...args) => {
    if (!res.headersSent) res.removeHeader('content-length');
    const rewritten = args.map((arg, index) => {
      if (index === 0 || !arg || typeof arg !== 'object') return arg;
      if (Array.isArray(arg)) return arg.filter((entry, i, all) => String(i % 2 ? all[i - 1] : entry).toLowerCase() !== 'content-length');
      return Object.fromEntries(Object.entries(arg).filter(([key]) => key.toLowerCase() !== 'content-length'));
    });
    return writeHead(...rewritten);
  };
  (res as unknown as { write: (...args: unknown[]) => boolean }).write = (chunk: unknown, ...rest: unknown[]) => {
    if (chunk !== undefined && chunk !== null) chunks.push(buffer(chunk));
    const callback = rest.find(arg => typeof arg === 'function') as (() => void) | undefined;
    if (callback) queueMicrotask(callback);
    return true;
  };
  (res as unknown as { end: (...args: unknown[]) => Response }).end = (chunk?: unknown, ...rest: unknown[]) => {
    if (chunk !== undefined && chunk !== null) chunks.push(buffer(chunk));
    const original = Buffer.concat(chunks);
    try {
      const body = JSON.parse(original.toString('utf8'));
      if (req.body.method === 'initialize' && body.result?.capabilities) delete body.result.capabilities.tasks;
      if (req.body.method === 'tools/list' && Array.isArray(body.result?.tools)) {
        body.result.tools = body.result.tools.filter((tool: { name?: string }) => TOOLS.has(tool.name ?? ''));
        for (const tool of body.result.tools) {
          tool.execution = { ...tool.execution, taskSupport: 'forbidden' };
        }
      }
      const output = Buffer.from(JSON.stringify(body));
      if (!res.headersSent) res.setHeader('content-length', String(output.length));
      return end(output, ...rest);
    } catch {
      return end(original, ...rest);
    }
  };
}

function rejectTool(req: Request, res: Response, code: string, message: string, field?: string): void {
  res.json({
    jsonrpc: '2.0', id: req.body?.id ?? null,
    result: adcpError(code, {
      message, ...(field && { field }), context: req.body?.params?.arguments?.context,
      ...(code === 'VERSION_UNSUPPORTED' && { details: { supported_versions: [CREATIVE33_WIRE_VERSION], supported_major_versions: [3] } }),
    }),
  });
}

/** JCS requires finite numbers and Unicode scalar strings. The SDK's
 * canonical serializer otherwise encodes a lone surrogate as U+FFFD in UTF-8,
 * colliding with a different buyer source under the same revision. */
function isCanonicalJsonInput(value: unknown): boolean {
  const stringsAreValid = (text: string): boolean => {
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(++index);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      } else if (code >= 0xdc00 && code <= 0xdfff) return false;
    }
    return true;
  };
  const pending = [value];
  let nodes = 0;
  while (pending.length) {
    if (++nodes > 100000) return false;
    const current = pending.pop();
    if (typeof current === 'number' && !Number.isFinite(current)) return false;
    if (typeof current === 'string' && !stringsAreValid(current)) return false;
    if (current && typeof current === 'object') {
      for (const [key, child] of Object.entries(current)) {
        if (!stringsAreValid(key)) return false;
        pending.push(child);
      }
    }
  }
  return true;
}

export function mountCreative33Sandbox(parent: Router, options: {
  requireAuth?: RequestHandler;
  rateLimit?: RequestHandler;
  store?: AdcpStateStore;
  enabled?: boolean;
} = {}): void {
  if (!(options.enabled ?? creative33SandboxEnabled())) return;
  const database = { query: (sql: string, values?: unknown[]) => getPool().query(sql, values) };
  const rawStore = options.store ?? (process.env.NODE_ENV === 'production'
    ? new PostgresStateStore(database) : new InMemoryStateStore());
  const domainStore = prefixedStore(rawStore, 'creative33_domain_');
  const sdkStore = prefixedStore(rawStore, 'creative33_sdk_');
  const sandbox = createCreative33Sandbox(domainStore);
  const taskRegistry = process.env.NODE_ENV === 'production'
    ? createPostgresTaskRegistry({ pool: database, namespace: NAMESPACE, tableName: 'adcp_decisioning_tasks_v2' })
    : createInMemoryTaskRegistry();
  const middleware = [options.rateLimit, options.requireAuth].filter((handler): handler is RequestHandler => Boolean(handler));

  parent.get('/beta/3.3/creative/fixtures/video-15s.mp4', (_req, res) => {
    cors(res);
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.sendFile(path.resolve('server/public/test-assets/creative33/video-15s.mp4'));
  });
  parent.get('/beta/3.3/creative/fixtures/responsive.zip', (_req, res) => {
    cors(res); res.type('application/zip').send(CREATIVE33_ZIP_BYTES);
  });
  parent.get('/beta/3.3/creative/fixtures/responsive.html', (_req, res) => {
    cors(res);
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
    res.type('html').send(CREATIVE33_RESPONSIVE_HTML);
  });
  parent.get('/beta/3.3/creative/formats/inline-html.json', (_req, res) => {
    cors(res); res.type('application/schema+json').send(CREATIVE33_HTML_SCHEMA_BYTES);
  });
  parent.options(CREATIVE33_ROUTE, (_req, res) => { cors(res); res.status(204).end(); });
  parent.get(CREATIVE33_ROUTE, (_req, res) => { cors(res); res.setHeader('Allow', 'POST, OPTIONS'); res.status(405).end(); });
  parent.post(CREATIVE33_ROUTE, ...middleware, async (req, res) => {
    cors(res);
    // The installed SDK may not package the 3.3.0-beta.0 bundle this route serves.
    await ensureTrainingAgentSchemaBundle();
    // Only the upstream authenticator may establish identity. In particular,
    // cookies, argument fields, and a buyer-supplied req.auth bag are not authority.
    const principal = res.locals.trainingPrincipal as unknown;
    if (typeof principal !== 'string' || principal.length === 0) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="AdCP creative beta sandbox"');
      res.status(401).json({ jsonrpc: '2.0', id: req.body?.id ?? null, error: { code: -32001, message: 'Authentication required.' } });
      return;
    }
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Expected one JSON-RPC request.' } });
      return;
    }
    if (!['initialize', 'notifications/initialized', 'ping', 'tools/list', 'tools/call'].includes(req.body.method)
      || Object.hasOwn(req.body.params ?? {}, 'task')) {
      res.json({ jsonrpc: '2.0', id: req.body.id ?? null, error: { code: -32601, message: 'This sandbox supports synchronous requests only.' } });
      return;
    }
    const params = req.body.params ?? {};
    const versionHints = [params, params._meta ?? {}, params.arguments ?? {}];
    if (versionHints.some(args => (args.adcp_version !== undefined && args.adcp_version !== CREATIVE33_WIRE_VERSION)
      || (args.adcp_major_version !== undefined && args.adcp_major_version !== 3))) {
      if (req.body.method === 'tools/call') {
        rejectTool(req, res, 'VERSION_UNSUPPORTED', `This endpoint serves ${CREATIVE33_WIRE_VERSION} only.`, 'adcp_version');
      } else {
        res.json({ jsonrpc: '2.0', id: req.body.id ?? null, error: { code: -32602, message: `This endpoint serves ${CREATIVE33_WIRE_VERSION} only.` } });
      }
      return;
    }
    if (req.body.method === 'tools/call') {
      const rawBody = (req as unknown as { creative33RawBody?: Buffer; rawBody?: string | Buffer }).creative33RawBody
        ?? (req as Request & { rawBody?: string | Buffer }).rawBody;
      if (rawBody === undefined) {
        rejectTool(req, res, 'CONFIGURATION_ERROR', 'The JSON parser must retain rawBody for creative revision validation.');
        return;
      }
      if ((Buffer.isBuffer(rawBody) && !isUtf8(rawBody)) || Buffer.byteLength(rawBody) > 256 * 1024
        || adcpOperationResolver(req) === UNRESOLVABLE_OPERATION
        || !isCanonicalJsonInput(req.body)) {
        rejectTool(req, res, 'INVALID_REQUEST', 'Send unambiguous JSON without duplicate members or invalid Unicode/numbers, limited to 256 KB.');
        return;
      }
      if (!TOOLS.has(req.body.params?.name)) {
        rejectTool(req, res, 'UNSUPPORTED_FEATURE', 'This tool is not implemented by the creative beta sandbox.');
        return;
      }
      const args = req.body.params?.arguments ?? {};
      if (args.push_notification_config !== undefined) {
        rejectTool(req, res, 'UNSUPPORTED_FEATURE', 'The creative beta sandbox completes requests synchronously.', 'push_notification_config');
        return;
      }
    }
    (req as Request & { auth?: unknown }).auth = { token: '', clientId: principal, scopes: [] };
    synchronousDiscovery(req, res);
    let server: ReturnType<typeof createAdcpServerFromPlatform> | undefined;
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    // The MCP SDK requires both Accept types even with JSON-only responses.
    req.headers.accept = 'application/json, text/event-stream';
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      if (req.rawHeaders[index].toLowerCase() === 'accept') req.rawHeaders[index + 1] = req.headers.accept;
    }
    try {
      server = createAdcpServerFromPlatform(sandbox.platform, {
      name: 'adcp-creative-33-sandbox', version: '1.0.0',
      adcpVersion: CREATIVE33_WIRE_VERSION, defaultAdcpVersion: CREATIVE33_WIRE_VERSION,
      complyTest: sandbox.complyTest,
      customTools: {
        validate_input: {
          description: 'Validate an inline creative against the explicitly advertised beta fixture contracts.',
          inputSchema: ValidateInputRequestSchema,
          annotations: { readOnlyHint: true, idempotentHint: true },
          handler: async (input: unknown) => {
            const result = { ...await sandbox.validateInput(input as Record<string, unknown>), adcp_version: CREATIVE33_WIRE_VERSION };
            const validate = getCanonicalToolValidator('validate_input', 'sync', { adcpVersion: CREATIVE33_BUNDLE_VERSION });
            if (!validate || !validate(result)) {
              throw new AdcpError('CONFIGURATION_ERROR', { message: 'The sandbox validation response does not satisfy the frozen beta contract.', recovery: 'terminal' });
            }
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
          },
        },
      },
      stateStore: sdkStore, taskRegistry,
      idempotency: getSdkIdempotencyStore(),
      resolveIdempotencyPrincipal: () => `${NAMESPACE}:${createHash('sha256').update(principal).digest('hex')}`,
      validation: { requests: 'strict', responses: 'strict' }, mergeSeam: 'strict',
      credentialPolicy: 'authInfo-only',
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error({ err }, 'Creative beta request failed');
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', id: req.body.id ?? null, error: { code: -32603, message: 'Creative sandbox request failed.' } });
    } finally {
      await server?.close().catch(() => {});
    }
  });
}
