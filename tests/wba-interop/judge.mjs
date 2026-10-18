/**
 * The judge: Cloudflare's `web-bot-auth` and `http-message-sig` at the versions
 * pinned in package.json, run two ways.
 *
 * - Bare: the library as shipped, with only the resolver every caller writes
 *   (return the key whose thumbprint is `keyid` from the directory of the origin
 *   the covered Signature-Agent member names).
 * - Policy: the library with the profile's rules from policy.mjs in its hooks.
 *
 * Run directly, this file is an adapter (see PROTOCOL.md) that signs with the
 * library and verifies with the policy, so `run.mjs --self` grades the judge
 * through the same protocol as an SDK.
 */
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { component, createSignature, verifySignature } from 'http-message-sig';
import { parseDictionary } from 'structured-headers';
import { generateNonce, sign, verify } from 'web-bot-auth';
import { signerFromJWK, verifierFromJWK } from 'web-bot-auth/crypto';
import * as policy from './policy.mjs';

const { header } = policy;
const fields = headers => Object.entries(headers).map(([name, value]) => ({ name: name.toLowerCase(), value }));
const message = r => ({ kind: 'request', method: r.method, targetUri: r.url, fields: fields(r.headers) });
const digest = body => `sha-256=:${createHash('sha256').update(body).digest('base64')}:`;
const publicJwk = ({ d, p, q, dp, dq, qi, ...pub }) => pub;
const failure = error => ({
  ok: false,
  status: policy.statusOf(error),
  rule: error?.rule ?? error?.cause?.rule ?? error?.code ?? 'error',
  error: `${error?.message ?? error}${error?.cause ? `: ${error.cause.message ?? error.cause}` : ''}`,
});
const verifierOrUndefined = jwk => verifierFromJWK(jwk).catch(() => undefined);

const directoryMessage = (origin, response) => ({
  kind: 'response',
  status: response.status,
  fields: fields(response.headers),
  request: { kind: 'request', method: 'GET', targetUri: policy.directoryUrl(origin), fields: [] },
});

// ── Directories ───────────────────────────────────────────────────────────

/** Verifies a signed directory response; returns { ok, keyids } or a refusal. */
export async function verifyDirectory({ origin, response, now }, { bare = false } = {}) {
  try {
    const keys = JSON.parse(response.body).keys ?? [];
    const signed = directoryMessage(origin, response);
    const keyids = [];
    if (bare) {
      // Every signature in the response verifies with the key the body gives for its keyid.
      const input = parseDictionary(header(response.headers, 'signature-input') ?? '');
      const verifiers = (await Promise.all(keys.map(verifierOrUndefined))).filter(Boolean);
      for (const [label, [, params]] of input) {
        const verifier = verifiers.find(v => v.keyid === params.get('keyid'));
        if (verifier === undefined) throw new Error(`no key ${params.get('keyid')} in the directory`);
        await verifySignature(signed, {
          label,
          policy: { algorithms: ['ed25519', 'rsa-pss-sha512'], now, requiredComponents: [], requiredParameters: [] },
          resolveVerifier: async () => verifier,
        });
        keyids.push(verifier.keyid);
      }
      if (keyids.length === 0) throw new Error('the directory response carries no signature');
      return { ok: true, keyids };
    }
    policy.checkDirectoryResponse(response);
    const input = parseDictionary(header(response.headers, 'signature-input') ?? '');
    for (const verifier of await Promise.all(keys.map(verifierOrUndefined))) {
      if (!policy.usable(verifier)) continue;
      await verifySignature(signed, {
        label: policy.directoryLabelFor(input, verifier.keyid),
        policy: policy.directorySignaturePolicy(now),
        resolveVerifier: async () => verifier,
      });
      keyids.push(verifier.keyid);
    }
    policy.checkDirectoryBody(response, keyids);
    return { ok: true, keyids };
  } catch (e) {
    return failure(e);
  }
}

async function resolveKey(directories, entry, keyid, now, bare) {
  if (!bare) policy.checkSignatureAgent(entry);
  const response = directories[entry.uri];
  if (response === undefined) throw new policy.PolicyError(403, 'directory-unavailable', `no directory at ${entry.uri}`);
  if (!bare) {
    const checked = await verifyDirectory({ origin: entry.uri, response, now });
    if (!checked.ok) throw new policy.PolicyError(403, checked.rule, `directory of ${entry.uri}: ${checked.error}`);
    policy.checkNotTestKey(keyid);
  }
  for (const jwk of JSON.parse(response.body).keys ?? []) {
    const verifier = await verifierOrUndefined(jwk);
    if (verifier?.keyid === keyid && (bare || policy.usable(verifier))) return verifier;
  }
  throw new policy.PolicyError(403, 'key-not-in-directory', `key ${keyid} is not in the directory of ${entry.uri}`);
}

// ── Requests ──────────────────────────────────────────────────────────────

async function verifyOne(request, directories, now, bare, replay) {
  const label = bare ? undefined : policy.selectLabel(request);
  const result = await verify(message(request), {
    now: new Date(now * 1000),
    label,
    algorithms: bare ? undefined : policy.ALGORITHMS,
    clockSkew: bare ? undefined : policy.CLOCK_SKEW,
    resolver: async candidate => {
      if (candidate.signatureAgent === undefined) throw new Error('no covered Signature-Agent member');
      return resolveKey(directories, candidate.signatureAgent, candidate.keyid, now, bare);
    },
    validate: bare ? undefined : r => policy.validate(r, request),
  });
  const identity = result.signatureAgent.uri;
  if (!bare) replay.check(identity, result.nonce);
  return { ok: true, identity, keyid: result.keyid };
}

/**
 * Verifies `request` after verifying each of `prior` with the same replay
 * store, so a replay is built black-box. Returns { ok, identity, keyid } or a
 * refusal with its status.
 */
export async function verifyRequest({ request, directories, now, prior = [] }, { bare = false } = {}) {
  const replay = new policy.ReplayStore();
  for (const [i, earlier] of prior.entries()) {
    try {
      await verifyOne(earlier, directories, now, bare, replay);
    } catch (e) {
      return { ...failure(e), rule: `prior-${i}` };
    }
  }
  try {
    return await verifyOne(request, directories, now, bare, replay);
  } catch (e) {
    return failure(e);
  }
}

// ── Signing ───────────────────────────────────────────────────────────────

/** Signs a request with the library's own `sign()`, with the options the profile needs. */
export async function signRequest({ key, origin, request, now, label = 'sig1' }) {
  const headers = { ...request.headers, 'signature-agent': `${label}="${origin}"` };
  const additionalComponents = ['@method', '@target-uri'];
  if (request.body) {
    headers['content-digest'] = digest(request.body);
    additionalComponents.push('content-type', 'content-digest');
  }
  const signature = await sign(message({ ...request, headers }), {
    signer: await signerFromJWK(key),
    created: new Date(now * 1000),
    expires: new Date((now + policy.MAX_LIFETIME) * 1000),
    nonce: generateNonce(),
    label,
    additionalComponents,
  });
  return { ...request, headers: { ...headers, 'signature-input': signature.signatureInput, signature: signature.signature } };
}

/**
 * Signs a key directory response per WBA Appendix B.1. The options build the
 * directory scenarios in scenarios.json: `authority` signs for another host,
 * `parameters` moves `created` and `expires` (offsets from `now`),
 * `components` replaces the covered components, `unsigned_keys` adds public
 * keys that do not sign, `content_type` changes the media type, and
 * `after_signing.append_to_body` changes the body after signing.
 */
export async function signDirectory({ keys, origin, now, authority, parameters = {}, components, unsigned_keys = [], content_type, after_signing = {} }) {
  const host = new URL(origin).host;
  const published = [];
  for (const key of keys) published.push({ ...publicJwk(key), kid: (await signerFromJWK(key)).keyid, use: 'sig' });
  const body = JSON.stringify({ keys: [...published, ...unsigned_keys] }, null, 2);
  const base = {
    'content-type': content_type ?? policy.DIRECTORY_MEDIA_TYPE,
    'cache-control': 'max-age=300',
    'content-digest': digest(body),
  };
  const inputs = [];
  const signatures = [];
  for (const [i, key] of keys.entries()) {
    const signer = await signerFromJWK(key);
    const out = await createSignature(directoryMessage(authority ? `https://${authority}` : origin, { status: 200, headers: base }), {
      label: `key${i + 1}`,
      components: (components ?? ['@authority;req', 'content-digest']).map(parseComponent),
      parameters: {
        created: now + (parameters.created ?? -60),
        expires: now + (parameters.expires ?? 86400),
        keyid: signer.keyid,
        alg: signer.algorithm,
        tag: policy.DIRECTORY_TAG,
      },
      signer,
    });
    inputs.push(out.signatureInput);
    signatures.push(out.signature);
  }
  const headers = keys.length === 0 ? base : { ...base, 'signature-input': inputs.join(', '), signature: signatures.join(', ') };
  return { url: policy.directoryUrl(origin), status: 200, headers, body: body + (after_signing.append_to_body ?? '') };
}

/** `@authority;req` or `signature-agent;key=sig1`, as scenarios.json spells a component. */
export function parseComponent(id) {
  const [name, ...params] = id.split(';');
  if (params.length === 0) return name;
  return component(name, Object.fromEntries(params.map(p => (p.includes('=') ? p.split('=') : [p, true]))));
}

const NONCE_ENCODINGS = {
  base64url: bytes => bytes.toString('base64url'),
  base64: bytes => bytes.toString('base64'),
  'base64url-padded': bytes => `${bytes.toString('base64url')}${'='.repeat((4 - (bytes.toString('base64url').length % 4)) % 4)}`,
};
function nonceValue(spec) {
  if (!spec || typeof spec !== 'object') return spec;
  for (;;) {
    const value = NONCE_ENCODINGS[spec.encoding](randomBytes(spec.bytes));
    // Padded base64url with no '-' or '_' is also canonical padded base64, which the profile accepts.
    if (spec.encoding !== 'base64url-padded' || /[-_]/.test(value)) return value;
  }
}

/**
 * Signs one request scenario from scenarios.json at `now`. http-message-sig
 * signs any component and parameter set, so a scenario can carry what the
 * profile refuses. `keys` maps a kid to its private JWK.
 */
export async function signScenario(scenarios, scenario, keys, now) {
  const { signer: who, requests, components: defaultComponents, parameters: defaultParameters } = scenarios;
  const base = requests[scenario.base];
  const label = scenario.label ?? 'sig1';
  const headers = { ...base.headers, 'signature-agent': scenario.signature_agent ?? `${label}="${who.identity}"` };
  if (base.body) headers['content-digest'] = digest(base.body);
  const request = { ...base, headers };
  const first = await signOne(request, {
    key: keys[who.kid],
    label,
    components: scenario.components ?? defaultComponents[scenario.base].map(c => c.replace('{label}', label)),
    parameters: { ...defaultParameters, ...scenario.parameters },
    now,
  });
  let signed = first;
  if (scenario.extra_signature) {
    const extra = scenario.extra_signature;
    const second = await signOne(request, { key: keys[extra.kid], label: extra.label, components: extra.components, parameters: extra.parameters, now });
    signed = { signatureInput: `${first.signatureInput}, ${second.signatureInput}`, signature: `${first.signature}, ${second.signature}` };
  }
  const after = scenario.after_signing ?? {};
  // append_members adds raw members, so a scenario can carry a member the library would not sign.
  const append = (name, value) => (after.append_members?.[name] ? `${value}, ${after.append_members[name]}` : value);
  return {
    ...request,
    headers: {
      ...headers,
      'signature-input': append('signature-input', signed.signatureInput),
      signature: append('signature', signed.signature),
      ...after.headers,
    },
    body: base.body + (after.append_to_body ?? ''),
  };
}

async function signOne(request, { key, label, components, parameters, now }) {
  const real = await signerFromJWK(key);
  const claimed = parameters.alg === undefined ? real.algorithm : parameters.alg;
  // A claimed alg other than the key's signs with the key and claims the other value.
  const signer = claimed && claimed !== real.algorithm ? { algorithm: claimed, keyid: real.keyid, sign: d => real.sign(d) } : real;
  const values = {
    created: parameters.created === null ? null : now + parameters.created,
    expires: parameters.expires === null ? null : now + parameters.expires,
    nonce: nonceValue(parameters.nonce),
    keyid: parameters.keyid === undefined ? real.keyid : parameters.keyid,
    alg: claimed,
    tag: parameters.tag,
  };
  return createSignature(message(request), {
    label,
    components: components.map(parseComponent),
    parameters: Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null && v !== undefined)),
    signer,
  });
}

// ── Adapter entry point ───────────────────────────────────────────────────

const OPERATIONS = {
  sign_request: signRequest,
  sign_directory: signDirectory,
  verify_request: op => verifyRequest(op),
  verify_directory: op => verifyDirectory(op),
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const op = JSON.parse(input);
  let out;
  try {
    out = await OPERATIONS[op.op](op);
  } catch (e) {
    out = { ok: false, status: 0, rule: 'adapter-error', error: String(e?.stack ?? e) };
  }
  process.stdout.write(JSON.stringify(out));
}
