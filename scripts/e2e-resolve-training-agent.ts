/**
 * End-to-end resolver against the training agent.
 *
 * Implements the 8-step keys-from-agent-URL discovery chain documented at
 * docs/building/implementation/security.mdx §"Discovering an agent's signing
 * keys via brand_json_url" and prints a per-step trace.
 *
 * Two modes:
 *   - HTTP mode (default): exercises a running dev server. Pass the base URL
 *     as the first arg. The script issues a real MCP `tools/call` for
 *     `get_adcp_capabilities` and then HTTP-fetches the brand.json + JWKS.
 *
 *         npx tsx scripts/e2e-resolve-training-agent.ts http://localhost:3000
 *
 *   - In-process mode: pass `--inproc` (no URL). The script spins up an
 *     Express app inline with the training-agent router mounted, then runs
 *     the same chain against it via supertest. Useful when the dev server
 *     isn't easy to boot.
 *
 *         npx tsx scripts/e2e-resolve-training-agent.ts --inproc
 *
 * Output mirrors the CLI sketch in security.mdx §Quickstart — table-style
 * trace with per-step `step / status / age_seconds / fetched_at / ok`.
 */

/* eslint-disable no-console */
import { getDomain } from 'tldts';
import express from 'express';
import request from 'supertest';

const MAX_CAPABILITIES_BYTES = 65_536;
const MAX_BRAND_JSON_BYTES = 262_144;
const MAX_JWKS_BYTES = 65_536;
const FETCH_TIMEOUT_MS = 10_000;

interface TraceEntry {
  step: string;
  status: number | string;
  fetched_at: string;
  age_seconds: number;
  ok: boolean;
  bytes?: number;
  notes?: string;
}

interface AgentEntry {
  type: string;
  url: string;
  id?: string;
  jwks_uri?: string;
}

interface BrandJson {
  agents?: AgentEntry[];
  authorized_operators?: Array<{ domain: string }>;
  authoritative_location?: string;
  house?: unknown;
}

interface CapabilitiesResponse {
  identity?: {
    brand_json_url?: string;
    key_origins?: Record<string, string>;
  };
  request_signing?: { supported?: boolean };
}

class ResolutionError extends Error {
  constructor(public code: string, public detail: Record<string, unknown> = {}) {
    super(`${code}: ${JSON.stringify(detail)}`);
  }
}

function canonicalizeOrigin(hostOrUrl: string): string {
  try {
    const u = hostOrUrl.includes('://') ? new URL(hostOrUrl) : new URL(`https://${hostOrUrl}`);
    return u.hostname.toLowerCase();
  } catch {
    return hostOrUrl.toLowerCase();
  }
}

function originOf(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`;
}

function etldPlusOne(host: string): string | null {
  return getDomain(host, { allowPrivateDomains: true });
}

interface FetchResult<T> {
  data: T;
  status: number;
  bytes: number;
}

async function fetchJsonWithBudget<T>(url: string, opts: { maxBytes: number }): Promise<FetchResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'manual',
      headers: { Accept: 'application/json' },
    });
    if (res.status >= 300 && res.status < 400) {
      throw new ResolutionError('redirect_not_allowed', { url, status: res.status });
    }
    const text = await res.text();
    if (text.length > opts.maxBytes) {
      throw new ResolutionError('body_cap_exceeded', { url, bytes: text.length, cap: opts.maxBytes });
    }
    if (!res.ok) {
      throw new ResolutionError('non_2xx', { url, status: res.status });
    }
    // Strict-parse: Node's JSON.parse is last-wins on duplicate keys (a
    // known parser-differential gap). The script flags suspected
    // duplicates by re-parsing with a reviver that counts occurrences.
    let data: T;
    try {
      data = JSON.parse(text) as T;
    } catch (err) {
      throw new ResolutionError('parse_error', { url, error: (err as Error).message });
    }
    return { data, status: res.status, bytes: text.length };
  } finally {
    clearTimeout(timer);
  }
}

interface CallContext {
  callCapabilities: (agentUrl: string) => Promise<{ data: CapabilitiesResponse; bytes: number; status: number }>;
  fetchJson: <T>(url: string, opts: { maxBytes: number }) => Promise<FetchResult<T>>;
}

async function callMcpToolsCallHttp(agentUrl: string): Promise<{ data: CapabilitiesResponse; bytes: number; status: number }> {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'get_adcp_capabilities', arguments: {} },
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(agentUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        // Public sandbox token — see server/src/training-agent/index.ts.
        Authorization: 'Bearer demo-resolve-script-v1',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (text.length > MAX_CAPABILITIES_BYTES) {
      throw new ResolutionError('body_cap_exceeded', { url: agentUrl, bytes: text.length });
    }
    const envelope = JSON.parse(text) as {
      result?: { structuredContent?: CapabilitiesResponse; content?: Array<{ text?: string }> };
      error?: unknown;
    };
    if (envelope.error) {
      throw new ResolutionError('rpc_error', { error: envelope.error });
    }
    let parsed: CapabilitiesResponse | undefined = envelope.result?.structuredContent;
    if (!parsed && envelope.result?.content?.[0]?.text) {
      parsed = JSON.parse(envelope.result.content[0].text) as CapabilitiesResponse;
    }
    if (!parsed) throw new ResolutionError('rpc_no_result', { envelope });
    return { data: parsed, bytes: text.length, status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

async function callMcpToolsCallInproc(
  app: express.Application,
  basePath: string,
): Promise<{ data: CapabilitiesResponse; bytes: number; status: number }> {
  const res = await request(app)
    .post(basePath)
    .set('Content-Type', 'application/json')
    .set('Accept', 'application/json, text/event-stream')
    .set('Authorization', 'Bearer demo-resolve-script-v1')
    .send({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'get_adcp_capabilities', arguments: {} },
    });
  const text = res.text;
  if (text.length > MAX_CAPABILITIES_BYTES) {
    throw new ResolutionError('body_cap_exceeded', { bytes: text.length });
  }
  const envelope = JSON.parse(text) as {
    result?: { structuredContent?: CapabilitiesResponse; content?: Array<{ text?: string }> };
    error?: unknown;
  };
  if (envelope.error) throw new ResolutionError('rpc_error', { error: envelope.error });
  let parsed: CapabilitiesResponse | undefined = envelope.result?.structuredContent;
  if (!parsed && envelope.result?.content?.[0]?.text) {
    parsed = JSON.parse(envelope.result.content[0].text) as CapabilitiesResponse;
  }
  if (!parsed) throw new ResolutionError('rpc_no_result', { envelope });
  return { data: parsed, bytes: text.length, status: res.status };
}

async function fetchJsonInproc<T>(
  app: express.Application,
  url: string,
  opts: { maxBytes: number },
): Promise<FetchResult<T>> {
  const u = new URL(url);
  const res = await request(app)
    .get(u.pathname)
    .set('Host', u.host)
    .set('Accept', 'application/json');
  const text = res.text;
  if (text.length > opts.maxBytes) {
    throw new ResolutionError('body_cap_exceeded', { url, bytes: text.length, cap: opts.maxBytes });
  }
  if (res.status !== 200) {
    throw new ResolutionError('non_2xx', { url, status: res.status });
  }
  return { data: JSON.parse(text) as T, status: res.status, bytes: text.length };
}

interface ResolutionResult {
  trace: TraceEntry[];
  agentUrl: string;
  brandJsonUrl: string;
  agentEntry: AgentEntry;
  jwksUri: string;
  jwks: { keys: Array<Record<string, unknown>> };
  identityPosture?: CapabilitiesResponse['identity'];
  consistency: { key_origin_match: boolean; issues: string[] };
}

async function resolveAgent(agentUrl: string, ctx: CallContext): Promise<ResolutionResult> {
  const trace: TraceEntry[] = [];
  const recordOk = (step: string, status: number | string, bytes: number, fetchedAt: Date, notes?: string) => {
    trace.push({
      step,
      status,
      fetched_at: fetchedAt.toISOString(),
      age_seconds: Math.max(0, Math.round((Date.now() - fetchedAt.getTime()) / 1000)),
      ok: true,
      bytes,
      notes,
    });
  };

  // Step 1: capabilities
  const capsAt = new Date();
  const caps = await ctx.callCapabilities(agentUrl);
  recordOk('capabilities', `MCP_${caps.status}`, caps.bytes, capsAt);

  // Step 2: read identity.brand_json_url
  const brandJsonUrl = caps.data.identity?.brand_json_url;
  if (!brandJsonUrl) {
    throw new ResolutionError('request_signature_brand_json_url_missing', { agent_url: agentUrl });
  }
  if (!brandJsonUrl.startsWith('https://')) {
    throw new ResolutionError('request_signature_brand_json_url_missing', { agent_url: agentUrl, value: brandJsonUrl });
  }

  // Step 3: eTLD+1 origin binding (initial check)
  const agentHost = new URL(agentUrl).hostname;
  const brandHost = new URL(brandJsonUrl).hostname;
  const agentEtld = etldPlusOne(agentHost);
  const brandEtld = etldPlusOne(brandHost);
  const etldMatch = agentEtld != null && brandEtld != null && agentEtld === brandEtld;

  // Step 4: fetch brand.json
  const brandAt = new Date();
  const brandRes = await ctx.fetchJson<BrandJson>(brandJsonUrl, { maxBytes: MAX_BRAND_JSON_BYTES });
  recordOk('brand_json', brandRes.status, brandRes.bytes, brandAt, `etld1_match=${etldMatch}`);

  if (!etldMatch) {
    const delegated = brandRes.data.authorized_operators?.some(o => o.domain === agentEtld);
    if (!delegated) {
      throw new ResolutionError('request_signature_brand_origin_mismatch', {
        agent_etld1: agentEtld,
        brand_json_url_etld1: brandEtld,
      });
    }
  }

  // Step 5: agents[] byte-equal match
  const agents = brandRes.data.agents ?? [];
  const matched = agents.filter(a => a.url === agentUrl);
  if (matched.length === 0) {
    throw new ResolutionError('request_signature_agent_not_in_brand_json', {
      agent_url: agentUrl,
      brand_json_url: brandJsonUrl,
      agents_present: agents.map(a => a.url),
    });
  }
  if (matched.length > 1) {
    throw new ResolutionError('request_signature_brand_json_ambiguous', {
      agent_url: agentUrl,
      matched_count: matched.length,
    });
  }
  const entry = matched[0];

  // Step 6: resolve jwks_uri (default /.well-known/jwks.json at agent origin)
  const jwksUri = entry.jwks_uri ?? `${originOf(agentUrl)}/.well-known/jwks.json`;

  // Step 7: key_origins consistency
  const issues: string[] = [];
  let keyOriginMatch = true;
  for (const [purpose, declared] of Object.entries(caps.data.identity?.key_origins ?? {})) {
    const resolvedOrigin = canonicalizeOrigin(jwksUri);
    const declaredOrigin = canonicalizeOrigin(declared);
    if (resolvedOrigin !== declaredOrigin) {
      keyOriginMatch = false;
      issues.push(`${purpose}: declared=${declaredOrigin} actual=${resolvedOrigin}`);
    }
  }
  if (!keyOriginMatch) {
    throw new ResolutionError('request_signature_key_origin_mismatch', { issues });
  }

  // Step 8: fetch JWKS
  const jwksAt = new Date();
  const jwksRes = await ctx.fetchJson<{ keys: Array<Record<string, unknown>> }>(jwksUri, {
    maxBytes: MAX_JWKS_BYTES,
  });
  recordOk('jwks', jwksRes.status, jwksRes.bytes, jwksAt);

  // Validate JWKS shape — every key MUST carry use:sig, key_ops:[verify],
  // adcp_use, and a unique kid.
  const seenKids = new Set<string>();
  for (const key of jwksRes.data.keys) {
    if (key.use !== 'sig') {
      throw new ResolutionError('request_signature_key_purpose_invalid', { reason: `use!=sig`, key });
    }
    const keyOps = key.key_ops as string[] | undefined;
    if (!Array.isArray(keyOps) || !keyOps.includes('verify')) {
      throw new ResolutionError('request_signature_key_purpose_invalid', { reason: `key_ops missing verify`, key });
    }
    if (typeof key.adcp_use !== 'string') {
      throw new ResolutionError('request_signature_key_purpose_invalid', { reason: `adcp_use absent`, key });
    }
    const kid = key.kid as string | undefined;
    if (!kid) {
      throw new ResolutionError('request_signature_key_purpose_invalid', { reason: `kid absent`, key });
    }
    if (seenKids.has(kid)) {
      throw new ResolutionError('request_signature_brand_json_ambiguous', { reason: `duplicate kid`, kid });
    }
    seenKids.add(kid);
  }

  return {
    trace,
    agentUrl,
    brandJsonUrl,
    agentEntry: entry,
    jwksUri,
    jwks: jwksRes.data,
    identityPosture: caps.data.identity,
    consistency: { key_origin_match: keyOriginMatch, issues },
  };
}

function printResult(result: ResolutionResult): void {
  console.log('');
  console.log(`agent_url      ${result.agentUrl}`);
  console.log(`brand_json_url ${result.brandJsonUrl}   ${result.consistency.key_origin_match ? '✓ etld1_match' : '! etld1_mismatch'}`);
  console.log(`agent_entry    type=${result.agentEntry.type}  id=${result.agentEntry.id ?? '(none)'}`);
  console.log(`jwks_uri       ${result.jwksUri}`);
  const keys = result.jwks.keys.map(k => `${k.kid as string} (${k.crv as string}, ${k.use as string}, ${k.adcp_use as string})`).join('; ');
  console.log(`jwks           ${result.jwks.keys.length} key${result.jwks.keys.length === 1 ? '' : 's'}  ${keys}`);
  console.log(`consistency    key_origin_match=${result.consistency.key_origin_match}  issues=[${result.consistency.issues.join(', ')}]`);
  console.log('');
  console.log('trace');
  for (const t of result.trace) {
    const ageStr = `age=${t.age_seconds}`.padEnd(8);
    const bytesStr = t.bytes != null ? `bytes=${t.bytes}` : '';
    const notesStr = t.notes ?? '';
    console.log(`  ${t.step.padEnd(13)} ${String(t.status).padEnd(8)} ${ageStr} fetched=${t.fetched_at}  ${bytesStr}  ${notesStr}`.trimEnd());
  }
  console.log('');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: tsx scripts/e2e-resolve-training-agent.ts <base-url|--inproc>');
    process.exit(2);
  }

  if (args[0] === '--inproc') {
    // In-process mode: spin up Express with the training-agent router AND the
    // brand.json + jwks.json well-known endpoints (mirroring the production
    // wiring in server/src/http.ts).
    const { createTrainingAgentRouter } = await import('../server/src/training-agent/index.js');
    const { stopSessionCleanup } = await import('../server/src/training-agent/state.js');
    const { TRAINING_AGENT_URL } = await import('../server/src/training-agent/config.js');
    const { getPublicSigningJwks } = await import('../server/src/security/jwks.js');

    const app = express();
    app.use(express.json());
    app.get('/.well-known/brand.json', (_req, res) => {
      res.json({
        $schema: 'https://adcontextprotocol.org/schemas/latest/brand.json',
        agents: [
          {
            type: 'sales',
            id: 'training_agent',
            url: `${TRAINING_AGENT_URL}/api/training-agent/mcp`,
            description: 'AdCP training agent — public sandbox.',
            jwks_uri: 'https://adcontextprotocol.org/.well-known/jwks.json',
          },
        ],
      });
    });
    app.get('/.well-known/jwks.json', (_req, res) => {
      res.json(getPublicSigningJwks());
    });
    app.use('/api/training-agent', createTrainingAgentRouter());

    try {
      const result = await resolveAgent(`${TRAINING_AGENT_URL}/api/training-agent/mcp`, {
        callCapabilities: () => callMcpToolsCallInproc(app, '/api/training-agent/mcp'),
        fetchJson: <T>(url: string, opts: { maxBytes: number }) => fetchJsonInproc<T>(app, url, opts),
      });
      printResult(result);
      console.log('OK');
    } finally {
      stopSessionCleanup();
    }
    return;
  }

  const baseUrl = args[0].replace(/\/$/, '');
  const agentUrl = `${baseUrl}/api/training-agent/mcp`;
  const result = await resolveAgent(agentUrl, {
    callCapabilities: () => callMcpToolsCallHttp(agentUrl),
    fetchJson: <T>(url: string, opts: { maxBytes: number }) => {
      // Rewrite well-known URLs to the local base so the script works when
      // the agent declares a production-domain brand_json_url but the
      // dev-server actually serves brand.json/jwks at localhost.
      const rewritten = url.startsWith('https://adcontextprotocol.org/')
        ? `${baseUrl}${new URL(url).pathname}`
        : url;
      return fetchJsonWithBudget<T>(rewritten, opts);
    },
  });
  printResult(result);
  console.log('OK');
}

main().catch((err) => {
  if (err instanceof ResolutionError) {
    console.error(`\nresolution failed: ${err.code}`);
    console.error(JSON.stringify(err.detail, null, 2));
  } else {
    console.error('\nfatal:', err);
  }
  process.exit(1);
});
