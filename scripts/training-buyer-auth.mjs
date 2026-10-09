import { constants } from 'node:fs';
import { mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { startWebOAuthFlow, completeWebOAuthFlow, createNonInteractiveOAuthProvider } from '@adcp/sdk/auth';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { callMCPToolWithOAuth } from '@adcp/sdk/advanced';
import { ssrfSafeFetch } from '@adcp/sdk';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const agentId = 'training-gcs-buyer';
export const DEFAULT_BUYER_AGENT = 'https://test-agent.adcontextprotocol.org/sales';

function httpsUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Trusted HTTPS URL required.');
  return url;
}

// Manual REST/refresh requests need the same bounded, DNS-pinned transport as SDK OAuth flows.
function buyerFetch(trustedFetchFn) {
  return async (input, init = {}) => {
    const request = input instanceof Request ? input : undefined;
    const headers = new Headers(request?.headers);
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    const rawBody = init.body;
    let body;
    if (typeof rawBody === 'string' || rawBody instanceof Uint8Array) body = rawBody;
    else if (rawBody instanceof URLSearchParams) body = rawBody.toString();
    else if (rawBody instanceof ArrayBuffer) body = new Uint8Array(rawBody);
    else if (rawBody != null) throw new Error('Unsupported buyer request body.');
    else if (request?.body) body = new Uint8Array(await request.arrayBuffer());
    const result = await ssrfSafeFetch(request?.url ?? input.toString(), {
      method: init.method ?? request?.method ?? 'GET', headers: Object.fromEntries(headers), body,
      timeoutMs: 10_000, maxBodyBytes: 1024 * 1024, signal: init.signal ?? request?.signal,
      ...(trustedFetchFn && { trustedFetchFn }),
    });
    if (result.status >= 300 && result.status < 400) throw new Error('Buyer requests cannot redirect.');
    return new Response([204, 205, 304].includes(result.status) ? null : Buffer.from(result.body),
      { status: result.status, headers: result.headers });
  };
}

/** OAuth state is outside the synced repository, owner-only, and single-process. */
export async function openBuyerAuthFile(filename, { create = false } = {}) {
  if (!isAbsolute(filename)) throw new Error('Buyer OAuth file must be an absolute path outside the repository.');
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
  const directory = await realpath(dirname(filename));
  const path = resolve(directory, relative(dirname(filename), filename));
  const withinRepo = relative(await realpath(repository), path);
  if (withinRepo !== '..' && !withinRepo.startsWith('../') && !isAbsolute(withinRepo)) throw new Error('Buyer OAuth file must be outside the synced repository.');
  const lockPath = `${path}.lock`;
  const lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  let state;
  const save = async () => {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(JSON.stringify(state) + '\n'); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, path);
    }
    finally { await unlink(temporary).catch(() => {}); }
  };
  const close = async () => { await lock.close(); await unlink(lockPath); };
  try {
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || (info.mode & 0o077) || info.uid !== process.getuid?.()) throw new Error('Buyer OAuth file must be private and owned by this user.');
      state = JSON.parse(await handle.readFile('utf8'));
      if (state.version !== 1 || state.agent?.id !== agentId) throw new Error('Invalid buyer OAuth state.');
    } catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error;
      state = { version: 1 };
    } finally { await handle?.close(); }
    return { get state() { return state; }, save, close,
      storage: {
        loadAgent: async id => id === agentId ? structuredClone(state.agent) : undefined,
        saveAgent: async agent => {
          if (agent.id !== agentId || agent.agent_uri !== state.agent.agent_uri) throw new Error('Buyer OAuth agent changed.');
          state.agent = structuredClone(agent); await save();
        },
      },
      pendingFlowStore: {
        put: async flow => {
          if (flow.authorizationServerIssuer !== state.issuer || flow.resource !== `${state.agent.agent_uri}/mcp`) throw new Error('Unexpected buyer OAuth issuer or resource.');
          state.pending = flow; await save();
        },
        consume: async value => {
          const pending = state.pending;
          if (!pending || value !== pending.state) return null;
          delete state.pending; await save();
          if (new Date(pending.expiresAt).getTime() <= Date.now()) return null;
          return { ...pending, createdAt: new Date(pending.createdAt), expiresAt: new Date(pending.expiresAt) };
        },
      },
    };
  } catch (error) { await close(); throw error; }
}

export async function startBuyerLogin(file, { agent = DEFAULT_BUYER_AGENT, issuer, redirectUri, clientId, trustedFetchFn }) {
  const base = httpsUrl(agent).href.replace(/\/$/, '');
  if (new URL(base).pathname !== '/sales') throw new Error('Use the canonical sales tenant.');
  const authority = httpsUrl(issuer);
  if (authority.pathname !== '/') throw new Error('AuthKit issuer must be an HTTPS origin.');
  const callback = new URL(redirectUri);
  // A fixed loopback callback can be copied from the Mac browser even when no listener is reachable.
  if (callback.origin !== 'http://127.0.0.1:8765' || callback.pathname !== '/callback'
    || callback.search || callback.hash || callback.username || callback.password) throw new Error('Use http://127.0.0.1:8765/callback.');
  if (file.state.agent?.oauth_tokens || file.state.pending) throw new Error('Use a fresh OAuth file for a new sign-in.');
  file.state.issuer = authority.href;
  file.state.agent = { id: agentId, name: 'Private training GCS buyer', protocol: 'mcp', agent_uri: base,
    ...(clientId && { oauth_client: { client_id: clientId, issuer: authority.href } }) };
  await file.save();
  return startWebOAuthFlow({ agent: file.state.agent, redirectUri: callback.href,
    agentStorage: file.storage, pendingFlowStore: file.pendingFlowStore,
    resourceOverride: `${base}/mcp`, scopeHint: 'openid profile email offline_access',
    ...(trustedFetchFn && { trustedFetchFn }),
    clientMetadata: { client_name: 'Training reporting buyer', token_endpoint_auth_method: 'none' } });
}

export async function finishBuyerLogin(file, callbackUrl, { trustedFetchFn } = {}) {
  const pending = file.state.pending;
  if (!pending) throw new Error('Start a new buyer login.');
  const callback = new URL(callbackUrl.trim());
  const expected = new URL(pending.redirectUri);
  if (callback.origin !== expected.origin || callback.pathname !== expected.pathname || callback.hash
    || callback.username || callback.password || callback.searchParams.has('error')
    || callback.searchParams.getAll('code').length !== 1 || callback.searchParams.getAll('state').length !== 1
    || callback.searchParams.get('state') !== pending.state || !callback.searchParams.get('code')) throw new Error('Invalid buyer callback.');
  await completeWebOAuthFlow({ state: callback.searchParams.get('state'), code: callback.searchParams.get('code'),
    expectedState: pending.state, agentStorage: file.storage, pendingFlowStore: file.pendingFlowStore,
    ...(trustedFetchFn && { trustedFetchFn }) });
}

/** One provider owns both REST and MCP refresh; serialize operations and persist rotation. */
export function createBuyerOAuthSession(file, agentUrl, { trustedFetchFn } = {}) {
  const base = httpsUrl(agentUrl).href.replace(/\/$/, '');
  if (file.state.agent?.agent_uri !== base || !file.state.agent.oauth_tokens
    || file.state.agent.oauth_tokens.issuer !== file.state.issuer
    || file.state.agent.oauth_client?.issuer !== file.state.issuer
    || file.state.agent.oauth_resource !== `${base}/mcp`) throw new Error('Sign in to this buyer resource first.');
  const provider = createNonInteractiveOAuthProvider(file.state.agent, { storage: file.storage, resourceOverride: `${base}/mcp` });
  const fetchFn = buyerFetch(trustedFetchFn);
  // WorkOS tokens last five minutes; the SDK's five-minute buffer would refresh every operation.
  const hasUsableTokens = () => {
    const tokens = file.state.agent.oauth_tokens;
    return Boolean(tokens?.access_token) && (tokens.expires_at === undefined
      || new Date(tokens.expires_at).getTime() - Date.now() > 30_000);
  };
  let queue = Promise.resolve();
  const serial = operation => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  const refresh = async () => {
    const metadata = new URL('/.well-known/oauth-protected-resource/sales/mcp', base);
    if (await auth(provider, { serverUrl: `${base}/mcp`, resourceMetadataUrl: metadata,
      fetchFn }) !== 'AUTHORIZED') throw new Error('Buyer reauthorization required.');
  };
  return {
    call: (tool, params, options) => serial(async () => {
      if (!hasUsableTokens()) await refresh();
      const response = await callMCPToolWithOAuth({ agentUrl: `${base}/mcp`, toolName: tool,
        args: { ...params, adcp_version: '3.2' }, authProvider: provider,
        signal: options?.signal ?? AbortSignal.timeout(30_000), requestTimeoutMs: 30_000,
        ...(trustedFetchFn && { fetchFn: trustedFetchFn }) });
      if (response.isError) throw new Error('Buyer protocol operation failed.');
      const data = response.structuredContent ?? JSON.parse(response.content.find(item => item.type === 'text').text);
      if (data.errors?.length) throw new Error('Buyer protocol operation failed.');
      return data;
    }),
    fetch: (url, options = {}) => serial(async () => {
      const target = new URL(url);
      if (target.origin !== new URL(base).origin || !target.pathname.startsWith(`${new URL(base).pathname}/reporting/`)
        || target.username || target.password || target.search || target.hash) throw new Error('Buyer REST request is outside the reporting resource.');
      if (!hasUsableTokens()) await refresh();
      const request = async () => {
        const tokens = await provider.tokens();
        if (!tokens?.access_token) throw new Error('Buyer reauthorization required.');
        const headers = new Headers(options.headers);
        headers.set('Authorization', `Bearer ${tokens.access_token}`);
        return fetchFn(target, { ...options, headers, cache: 'no-store', redirect: 'error', signal: options.signal ?? AbortSignal.timeout(10_000) });
      };
      let response = await request();
      if (response.status === 401) { await response.body?.cancel(); await refresh(); response = await request(); }
      return response;
    }),
  };
}
