import { describe, expect, it, vi } from 'vitest';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { InMemoryStateStore } from '@adcp/sdk/server';
import { isCreative33McpPath } from '../../src/training-agent/lab-route-paths.js';
import {
  creative33SandboxEnabled,
  mountCreative33Sandbox,
} from '../../src/training-agent/creative33/router.js';

const PATH = '/beta/3.3/creative/mcp';
const VERSION = '3.3-beta.0';
const ACCOUNT = { account_id: 'creative33_sandbox' };
const PRINCIPALS: Record<string, string> = {
  'buyer-a': 'test:creative33:buyer-a',
  'buyer-b': 'test:creative33:buyer-b',
};

type Json = Record<string, unknown>;
interface RpcBody {
  error?: { code: number; message: string };
  result?: {
    isError?: boolean;
    structuredContent?: Json;
    content?: Array<{ type: string; text?: string }>;
    tools?: Array<{ name: string; execution?: { taskSupport?: string } }>;
    capabilities?: Json;
    task?: unknown;
  };
}

const requireAuth: RequestHandler = (req, res, next) => {
  const token = req.get('authorization')?.replace(/^Bearer /, '');
  const principal = token && PRINCIPALS[token];
  if (!principal) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="creative33-test"');
    res.status(401).json({ error: 'invalid_token' });
    return;
  }
  res.locals.trainingPrincipal = principal;
  next();
};

function boot(options: { store?: InMemoryStateStore; enabled?: boolean; rateLimit?: RequestHandler; captureRawBody?: boolean; mountPrefix?: string } = {}) {
  const app = express();
  app.use(express.json({
    limit: '1mb',
    ...(options.captureRawBody === false ? {} : {
      verify: (req, _res, body) => {
        (req as unknown as { rawBody: string }).rawBody = body.toString('utf8');
        if (isCreative33McpPath(req.url)) (req as unknown as { creative33RawBody: Buffer }).creative33RawBody = Buffer.from(body);
      },
    }),
  }));
  const router = express.Router();
  mountCreative33Sandbox(router, {
    requireAuth,
    store: options.store ?? new InMemoryStateStore(),
    enabled: options.enabled ?? true,
    ...(options.rateLimit && { rateLimit: options.rateLimit }),
  });
  if (options.mountPrefix) app.use(options.mountPrefix, router); else app.use(router);
  return app;
}

function rpc(app: express.Application, method: string, params: Json = {}, token?: string, endpoint = PATH) {
  const call = request(app).post(endpoint)
    .set('Content-Type', 'application/json')
    .set('Accept', 'application/json, text/event-stream');
  if (token) call.set('Authorization', `Bearer ${token}`);
  return call.send({ jsonrpc: '2.0', id: randomUUID(), method, params });
}

function tool(app: express.Application, name: string, args: Json = {}, token = 'buyer-a') {
  return rpc(app, 'tools/call', { name, arguments: args }, token);
}

function payload(body: RpcBody): Json {
  if (body.result?.structuredContent) return body.result.structuredContent;
  const text = body.result?.content?.find(item => item.type === 'text')?.text;
  return text ? JSON.parse(text) as Json : {};
}

function errorCode(body: RpcBody): string | number | undefined {
  return (payload(body).adcp_error as { code?: string } | undefined)?.code ?? body.error?.code;
}

function rows(body: RpcBody): Json[] {
  return payload(body).creatives as Json[];
}

function creative(id: string, revision = 'r1', url = 'https://cdn.acme.example/banner.zip'): Json {
  return {
    creative_id: id,
    revision_id: revision,
    name: 'Acme beta banner',
    format_kind: 'html5',
    assets: {
      html5_bundle: {
        asset_type: 'zip', url,
        sizes: [{ width: 300, height: 250 }, { width: 728, height: 90 }],
      },
    },
  };
}

function sync(app: express.Application, asset: Json, token = 'buyer-a', key = randomUUID(), extras: Json = {}) {
  return tool(app, 'sync_creatives', {
    adcp_version: VERSION, account: ACCOUNT,
    idempotency_key: key, creatives: [asset], ...extras,
  }, token);
}

function list(app: express.Application, token = 'buyer-a', account: Json = ACCOUNT) {
  return tool(app, 'list_creatives', { adcp_version: VERSION, account }, token);
}

describe('creative 3.3 beta route security boundaries', () => {
  it('requires an explicit production opt-in and honors explicit enable/disable values', () => {
    expect(creative33SandboxEnabled({ NODE_ENV: 'production' })).toBe(false);
    expect(creative33SandboxEnabled({ NODE_ENV: 'production', ENABLE_ADCP_3_3_CREATIVE_ROUTE: 'true' })).toBe(true);
    expect(creative33SandboxEnabled({ NODE_ENV: 'production', ENABLE_ADCP_3_3_CREATIVE_ROUTE: '1' })).toBe(true);
    for (const value of ['false', '0', 'yes']) {
      expect(creative33SandboxEnabled({ NODE_ENV: 'development', ENABLE_ADCP_3_3_CREATIVE_ROUTE: value })).toBe(false);
    }
    expect(creative33SandboxEnabled({ NODE_ENV: 'test' })).toBe(true);
    expect(creative33SandboxEnabled({ NODE_ENV: 'development' })).toBe(true);
  });

  it('does not mount a disabled endpoint', async () => {
    const response = await tool(boot({ enabled: false }), 'get_adcp_capabilities');
    expect(response.status).toBe(404);
  });

  it('rejects missing, invalid and cookie-only credentials', async () => {
    const app = boot();
    for (const token of [undefined, 'unknown']) {
      const response = await rpc(app, 'tools/list', {}, token);
      expect(response.status).toBe(401);
      expect(response.headers['www-authenticate']).toMatch(/^Bearer /);
    }
    const cookieOnly = await rpc(app, 'tools/list').set('Cookie', 'session=buyer-a');
    expect(cookieOnly.status).toBe(401);
    expect((await rpc(app, 'tools/list', {}, 'buyer-a')).status).toBe(200);
  });

  it('uses the supplied request limiter before dispatch', async () => {
    const limit = vi.fn<RequestHandler>((_req, res) => { res.status(429).json({ error: 'limited' }); });
    const response = await tool(boot({ rateLimit: limit }), 'get_adcp_capabilities');
    expect(response.status).toBe(429);
    expect(limit).toHaveBeenCalledOnce();
  });

  it('serves synchronous discovery to clients accepting JSON only', async () => {
    const response = await rpc(boot(), 'tools/list', {}, 'buyer-a').set('Accept', 'application/json');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    const tools = (response.body as RpcBody).result?.tools;
    expect(tools?.map(entry => entry.name)).toContain('sync_creatives');
    for (const entry of tools ?? []) expect(entry.execution?.taskSupport).toBe('forbidden');
  });

  it.each([
    ['unpaired high surrogate', '"\\ud800"'],
    ['unpaired low surrogate', '"\\udc00"'],
    ['non-finite JSON number', '1e999'],
  ])('rejects %s before binding a source revision', async (_label, literal) => {
    const app = boot();
    const id = `jcs_${randomUUID()}`;
    const key = randomUUID();
    const body = JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: {
      name: 'sync_creatives', arguments: { account: ACCOUNT, idempotency_key: key,
        creatives: [{ ...creative(id), ext: { jcs_probe: '__raw_value__' } }],
      },
    } }).replace('"__raw_value__"', literal);
    const rejected = await request(app).post(PATH).set('Authorization', 'Bearer buyer-a')
      .set('Content-Type', 'application/json').set('Accept', 'application/json').send(body);
    expect(errorCode(rejected.body)).toBe('INVALID_REQUEST');
    expect(rows((await list(app)).body)).toEqual([]);
    const corrected = await sync(app, { ...creative(id), ext: { jcs_probe: '\ufffd' } }, 'buyer-a', key);
    expect(rows(corrected.body)[0].action).toBe('created');
  });

  it('accepts well-formed supplementary Unicode without normalizing source content', async () => {
    const app = boot();
    const item = { ...creative(`unicode_${randomUUID()}`), ext: { caption: 'Acme \ud83c\udfd4\ufe0f e\u0301' } };
    expect(rows((await sync(app, item)).body)[0].action).toBe('created');
    expect(rows((await list(app)).body)[0].ext).toEqual(item.ext);
  });

  it.each([
    [PATH, ''],
    [PATH.toUpperCase(), ''],
    [`/API/TRAINING-AGENT${PATH.toUpperCase()}`, '/api/training-agent'],
  ])('rejects malformed UTF-8 at the actual Express route %s', async (endpoint, mountPrefix) => {
    const app = boot({ mountPrefix });
    const source = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: {
      name: 'sync_creatives', arguments: { account: ACCOUNT, idempotency_key: randomUUID(),
        creatives: [{ ...creative(`utf8_${randomUUID()}`), ext: { caption: '__bad_utf8__' } }],
      },
    } }));
    const marker = Buffer.from('__bad_utf8__');
    const offset = source.indexOf(marker);
    const bytes = Buffer.concat([source.subarray(0, offset), Buffer.from([0xff]), source.subarray(offset + marker.length)]);
    // Supertest serializes Buffer as a JSON object for application/json.
    // Send the actual malformed bytes over HTTP to exercise parser.verify.
    const listener = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => listener.once('listening', resolve));
    try {
      const body = await new Promise<RpcBody>((resolve, reject) => {
        const outbound = http.request({
          hostname: '127.0.0.1', port: (listener.address() as { port: number }).port,
          path: endpoint, method: 'POST', headers: {
            'Content-Type': 'application/json', Accept: 'application/json',
            Authorization: 'Bearer buyer-a', 'Content-Length': bytes.length,
          },
        }, response => {
          const chunks: Buffer[] = [];
          response.on('data', chunk => chunks.push(Buffer.from(chunk)));
          response.on('error', reject);
          response.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as RpcBody); }
            catch (error) { reject(error); }
          });
        });
        outbound.on('error', reject);
        outbound.end(bytes);
      });
      expect(errorCode(body)).toBe('INVALID_REQUEST');
    } finally {
      listener.closeAllConnections();
      await new Promise<void>(resolve => listener.close(() => resolve()));
    }
    const readback = await rpc(app, 'tools/call', { name: 'list_creatives', arguments: { account: ACCOUNT } }, 'buyer-a', endpoint);
    expect(rows(readback.body)).toEqual([]);
  });

  it('redacts unexpected backend errors while preserving known failures and successful batch items', async () => {
    const privateDetails = 'getaddrinfo ENOTFOUND db-internal.acme.example';
    class UnavailableLibraryStore extends InMemoryStateStore {
      override async get<T extends Record<string, unknown>>(collection: string, id: string): Promise<T | null> {
        if (collection === 'creative33_domain_library') throw new Error(privateDetails);
        return super.get<T>(collection, id);
      }
    }
    const manifest = { format_kind: 'html5', assets: { html5_bundle: {
      asset_type: 'zip', url: 'https://cdn.acme.example/banner.zip', width: 300, height: 250,
    } } };
    const response = await tool(boot({ store: new UnavailableLibraryStore() }), 'preview_creative', {
      request_type: 'batch', output_format: 'html', requests: [
        { creative_id: 'backend-unavailable' },
        { creative_manifest: manifest, inputs: [{ name: 'Unsupported canvas', macros: { AD_WIDTH: '970', AD_HEIGHT: '250' } }] },
        { creative_manifest: manifest },
      ],
    });
    expect(errorCode(response.body)).toBeUndefined();
    expect(payload(response.body)).toMatchObject({ response_type: 'batch', results: [
      { success: false, errors: [{ code: 'SERVICE_UNAVAILABLE', recovery: 'transient', message: 'Creative preview is temporarily unavailable.' }] },
      { success: false, errors: [{ code: 'INVALID_REQUEST', recovery: 'correctable' }] },
      { success: true, quality_used: 'draft' },
    ] });
    expect(JSON.stringify(response.body)).not.toContain(privateDetails);
  });

  it('advertises only the exact beta and defaults unversioned discovery to it', async () => {
    const app = boot();
    for (const args of [{}, { adcp_version: VERSION }, { adcp_major_version: 3 }]) {
      const response = await tool(app, 'get_adcp_capabilities', args);
      expect(response.status).toBe(200);
      expect(errorCode(response.body)).toBeUndefined();
      const caps = payload(response.body);
      expect(caps.adcp_version).toBe(VERSION);
      expect((caps.adcp as Json).supported_versions).toEqual([VERSION]);
    }
  });

  it.each(['3.2', '3.3', '3.3-beta.1', '3.3.0-beta.0', '../latest'])('refuses version %s without persisting', async version => {
    const app = boot();
    const id = `wrong_version_${randomUUID()}`;
    const response = await sync(app, creative(id), 'buyer-a', randomUUID(), { adcp_version: version });
    expect(errorCode(response.body)).toBeDefined();
    expect(rows((await list(app)).body)).toEqual([]);
  });

  it('refuses a conflicting major selector', async () => {
    const response = await tool(boot(), 'get_adcp_capabilities', { adcp_version: VERSION, adcp_major_version: 2 });
    expect(errorCode(response.body)).toBeDefined();
  });

  it('does not advertise asynchronous task support', async () => {
    const app = boot();
    const initialized = await rpc(app, 'initialize', {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'creative33-security-test', version: '1' },
    }, 'buyer-a');
    expect(initialized.status).toBe(200);
    expect(initialized.body.result?.capabilities?.tasks).toBeUndefined();
    const discovered = await rpc(app, 'tools/list', {}, 'buyer-a');
    const tools = (discovered.body as RpcBody).result?.tools;
    expect(tools?.length).toBeGreaterThan(0);
    for (const entry of tools ?? []) expect(entry.execution?.taskSupport).toBe('forbidden');
  });

  it('refuses native task methods and task-mode mutations before writing', async () => {
    const app = boot();
    for (const method of ['tasks/get', 'tasks/list', 'tasks/result', 'tasks/cancel']) {
      const response = await rpc(app, method, { taskId: 'stable_route_task' }, 'buyer-a');
      expect(errorCode(response.body)).toBeDefined();
      expect(response.body.result?.task).toBeUndefined();
    }
    const response = await rpc(app, 'tools/call', {
      name: 'sync_creatives', task: { ttl: 60000 },
      arguments: { adcp_version: VERSION, account: ACCOUNT, idempotency_key: randomUUID(), creatives: [creative('must_not_be_saved')] },
    }, 'buyer-a');
    expect(errorCode(response.body)).toBeDefined();
    expect(rows((await list(app)).body)).toEqual([]);
  });

  it('does not advertise or execute unrelated sales, brand, or governance operations', async () => {
    const app = boot();
    const discovered = await rpc(app, 'tools/list', {}, 'buyer-a');
    const names = ((discovered.body as RpcBody).result?.tools ?? []).map(entry => entry.name);
    for (const name of ['create_media_buy', 'sync_plans', 'verify_brand_claim', 'sync_principal']) {
      expect(names).not.toContain(name);
      expect(errorCode((await tool(app, name, { adcp_version: VERSION })).body)).toBeDefined();
    }
  });

  it('isolates same creative IDs, revision IDs and replay keys between authenticated callers', async () => {
    const app = boot();
    const key = randomUUID();
    const first = creative('shared_creative');
    const second = creative('shared_creative', 'r1', 'https://cdn.acme.example/buyer-b.zip');
    const savedA = await sync(app, first, 'buyer-a', key);
    expect(errorCode(savedA.body), JSON.stringify(savedA.body)).toBeUndefined();
    expect(rows(savedA.body)[0].action).toBe('created');
    expect(rows((await list(app, 'buyer-b')).body)).toEqual([]);
    const forgedContext = await tool(app, 'list_creatives', {
      adcp_version: VERSION, account: ACCOUNT,
      ext: { principal: PRINCIPALS['buyer-a'], __training_principal: PRINCIPALS['buyer-a'] },
    }, 'buyer-b');
    expect(errorCode(forgedContext.body), JSON.stringify(forgedContext.body)).toBeUndefined();
    expect(rows(forgedContext.body)).toEqual([]);
    const savedB = await sync(app, second, 'buyer-b', key);
    expect(errorCode(savedB.body), JSON.stringify(savedB.body)).toBeUndefined();
    expect(rows(savedB.body)[0].action).toBe('created');
    expect(rows((await list(app, 'buyer-a')).body)[0]).toMatchObject(first);
    expect(rows((await list(app, 'buyer-b')).body)[0]).toMatchObject(second);
    const replay = await sync(app, first, 'buyer-a', key);
    expect(errorCode(replay.body), JSON.stringify(replay.body)).toBeUndefined();
    expect(rows(replay.body)[0].action).toBe('created');
    expect(payload(replay.body).replayed).toBe(true);
    const conflict = await sync(app, { ...first, name: 'Changed Acme name' }, 'buyer-a', key);
    expect(errorCode(conflict.body)).toBe('IDEMPOTENCY_CONFLICT');
    const mismatch = await sync(app, { ...first, assets: second.assets }, 'buyer-a');
    expect(rows(mismatch.body)[0]).toMatchObject({
      action: 'failed', errors: [{ code: 'CREATIVE_REVISION_CONTENT_MISMATCH' }],
    });
    expect(rows((await list(app, 'buyer-a')).body)[0]).toMatchObject(first);
  });

  it('retains scoped library state across router reconstruction over the same backend', async () => {
    const store = new InMemoryStateStore();
    const asset = creative('survives_router_restart');
    expect(errorCode((await sync(boot({ store }), asset)).body)).toBeUndefined();
    const restarted = boot({ store });
    expect(rows((await list(restarted)).body)[0]).toMatchObject(asset);
    expect(rows((await list(restarted, 'buyer-b')).body)).toEqual([]);
  });

  it('refuses unknown account IDs and live account selectors', async () => {
    const app = boot();
    for (const account of [
      { account_id: 'arbitrary_account' },
      { account_id: 'creative33_sandbox', sandbox: false },
      { brand: { domain: 'acme.example' }, operator: 'agency.example', sandbox: false },
    ]) {
      const response = await list(app, 'buyer-a', account);
      expect(errorCode(response.body)).toBeDefined();
      expect(payload(response.body).creatives).toBeUndefined();
    }
  });

  it('refuses another caller\'s resolved account ID even when that ID is known', async () => {
    const app = boot();
    const accountList = await tool(app, 'list_accounts', { adcp_version: VERSION }, 'buyer-a');
    expect(errorCode(accountList.body), JSON.stringify(accountList.body)).toBeUndefined();
    const accounts = payload(accountList.body).accounts as Array<{ account_id: string }>;
    expect(accounts).toHaveLength(1);
    const ownedAccount = { account_id: accounts[0].account_id };
    const asset = creative('principal_owned_account');
    expect(errorCode((await sync(app, asset, 'buyer-a', randomUUID(), { account: ownedAccount })).body)).toBeUndefined();
    expect(rows((await list(app, 'buyer-a', ownedAccount)).body)[0]).toMatchObject(asset);
    const foreignRead = await list(app, 'buyer-b', ownedAccount);
    expect(errorCode(foreignRead.body)).toBeDefined();
    expect(payload(foreignRead.body).creatives).toBeUndefined();
    const foreignWrite = await sync(app, { ...asset, name: 'Foreign replacement' }, 'buyer-b', randomUUID(), { account: ownedAccount });
    expect(errorCode(foreignWrite.body)).toBeDefined();
    expect(rows((await list(app, 'buyer-a', ownedAccount)).body)[0]).toMatchObject(asset);
  });

  it('rejects duplicate revision identities before binding content or claiming the replay key', async () => {
    const app = boot();
    const key = randomUUID();
    const asset = creative('duplicate_revision', 'r2');
    const raw = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'sync_creatives', arguments: {
          adcp_version: VERSION, account: ACCOUNT, idempotency_key: key, creatives: [asset],
        },
      },
    }).replace('"revision_id":"r2"', '"revision_id":"r1","revision_id":"r2"');
    const response = await request(app).post(PATH)
      .set('Content-Type', 'application/json').set('Accept', 'application/json')
      .set('Authorization', 'Bearer buyer-a').send(raw);
    expect(errorCode(response.body)).toBe('INVALID_REQUEST');
    expect(rows((await list(app)).body)).toEqual([]);
    const corrected = await sync(app, asset, 'buyer-a', key);
    expect(errorCode(corrected.body), JSON.stringify(corrected.body)).toBeUndefined();
    expect(rows(corrected.body)[0]).toMatchObject({ action: 'created', revision_id: 'r2' });
  });

  it('rejects nested asset URL duplicates, including an escaped spelling of the same key', async () => {
    const app = boot();
    for (const duplicateKey of ['"url"', String.raw`"u\u0072l"`]) {
      const key = randomUUID();
      const asset = creative(`duplicate_url_${randomUUID()}`);
      const raw = JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
          name: 'sync_creatives', arguments: {
            adcp_version: VERSION, account: ACCOUNT, idempotency_key: key, creatives: [asset],
          },
        },
      }).replace('"url":"https://cdn.acme.example/banner.zip"',
        `"url":"https://cdn.acme.example/banner.zip",${duplicateKey}:"https://cdn.acme.example/replaced.zip"`);
      const response = await request(app).post(PATH)
        .set('Content-Type', 'application/json').set('Accept', 'application/json')
        .set('Authorization', 'Bearer buyer-a').send(raw);
      expect(errorCode(response.body), raw).toBe('INVALID_REQUEST');
      expect(rows((await list(app)).body)).toEqual([]);
    }
  });

  it('fails tool calls closed when the JSON parser did not retain raw bytes', async () => {
    const store = new InMemoryStateStore();
    const response = await sync(boot({ store, captureRawBody: false }), creative('missing_raw_body'));
    expect(errorCode(response.body)).toBe('CONFIGURATION_ERROR');
    expect(rows((await list(boot({ store }))).body)).toEqual([]);
  });
});
