/**
 * Independent verification of the Web Bot Auth profile vectors under
 * static/compliance/source/test-vectors/wba-profile/.
 *
 * Shares no code with the generator (scripts/generate-wba-profile-vectors.mjs):
 * it parses the RFC 8941 headers, rebuilds each RFC 9421 signature base from
 * the request on the wire, and checks signatures and digests with node:crypto.
 *
 * Each negative vector must fail at the check it targets. Where the vector
 * carries a valid signature, it must verify once that one check is skipped,
 * which shows the vector tests that check and nothing else.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const VECTOR_DIR = path.join(__dirname, '../static/compliance/source/test-vectors/wba-profile');
const keys = JSON.parse(fs.readFileSync(path.join(VECTOR_DIR, 'keys.json'), 'utf8')).keys;

function loadDir(sub) {
  return fs
    .readdirSync(path.join(VECTOR_DIR, sub))
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(file => ({ file, vector: JSON.parse(fs.readFileSync(path.join(VECTOR_DIR, sub, file), 'utf8')) }));
}

// ── RFC 8941 dictionary parsing, limited to the item types these headers use ──

function parseDictionary(text) {
  let i = 0;
  const fail = message => {
    throw new Error(`structured field parse error at ${i}: ${message}`);
  };
  const key = () => {
    const match = /^[a-z*][a-z0-9_.*-]*/.exec(text.slice(i));
    if (!match) fail('expected a key');
    i += match[0].length;
    return match[0];
  };
  const bareItem = () => {
    if (text[i] === '"') {
      let out = '';
      for (i++; i < text.length; i++) {
        if (text[i] === '\\') out += text[++i];
        else if (text[i] === '"') {
          i++;
          return out;
        } else out += text[i];
      }
      fail('unterminated string');
    }
    if (text[i] === ':') {
      const end = text.indexOf(':', i + 1);
      if (end < 0) fail('unterminated byte sequence');
      const token = text.slice(i + 1, end);
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(token)) fail('byte sequence is not standard Base64');
      i = end + 1;
      return Buffer.from(token, 'base64');
    }
    const match = /^-?\d+/.exec(text.slice(i));
    if (match) {
      i += match[0].length;
      return Number(match[0]);
    }
    return fail('unsupported item');
  };
  const parameters = () => {
    const params = new Map();
    while (text[i] === ';') {
      i++;
      const name = key();
      if (text[i] === '=') {
        i++;
        params.set(name, bareItem());
      } else params.set(name, true);
    }
    return params;
  };
  const item = () => {
    if (text[i] !== '(') return { value: bareItem(), params: parameters() };
    i++;
    const list = [];
    while (text[i] !== ')') {
      if (i >= text.length) fail('unterminated inner list');
      list.push({ value: bareItem(), params: parameters() });
      if (text[i] === ' ') i++;
    }
    i++;
    return { value: list, params: parameters() };
  };
  const dict = new Map();
  while (i < text.length) {
    const name = key();
    if (text[i++] !== '=') fail('expected =');
    dict.set(name, item());
    if (i === text.length) break;
    if (text.slice(i, i + 2) !== ', ') fail('expected a member separator');
    i += 2;
  }
  return dict;
}

const serializeParams = params =>
  [...params].map(([k, v]) => (v === true ? `;${k}` : typeof v === 'string' ? `;${k}="${v}"` : `;${k}=${v}`)).join('');
const serializeInnerList = ({ value, params }) =>
  `(${value.map(c => `"${c.value}"${serializeParams(c.params)}`).join(' ')})${serializeParams(params)}`;
const componentId = c => `"${c.value}"${serializeParams(c.params)}`;

// ── A minimal profile verifier ────────────────────────────────────────────

const REQUIRED_COMPONENTS = ['"@method"', '"@target-uri"', '"@authority"', '"content-type"', '"content-digest"'];
const REQUIRED_PARAMETERS = ['created', 'expires', 'nonce', 'keyid', 'alg', 'tag'];
const PROFILE_ALGORITHMS = ['ed25519'];
const NONCE_BYTES = 64;
const MAX_LIFETIME = 300;
const CLOCK_SKEW = 60;

class ProfileError extends Error {
  constructor(status, stage, message) {
    super(`${stage}: ${message}`);
    this.status = status;
    this.stage = stage;
  }
}

const headerOf = (headers, name) => headers[Object.keys(headers).find(k => k.toLowerCase() === name)];

const publicKey = jwk => crypto.createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, format: 'jwk' });

function parseRequestHeaders(headers) {
  try {
    const parsed = {
      agent: parseDictionary(headerOf(headers, 'signature-agent')),
      input: parseDictionary(headerOf(headers, 'signature-input')),
      signature: parseDictionary(headerOf(headers, 'signature')),
    };
    for (const [, { value }] of parsed.agent) {
      if (typeof value !== 'string') throw new Error('Signature-Agent member is not a String');
    }
    return parsed;
  } catch (e) {
    throw new ProfileError(400, 'parse', e.message);
  }
}

/** The RFC 9421 signature base for one label, rebuilt from the request on the wire. */
function requestBase(request, parsed, label) {
  const url = new URL(request.url);
  const lines = parsed.input.get(label).value.map(c => {
    const memberKey = c.params.get('key');
    let value;
    if (c.value === '@method') value = request.method;
    else if (c.value === '@target-uri') value = request.url;
    else if (c.value === '@authority') value = url.host;
    else if (c.value === 'signature-agent') value = `"${parsed.agent.get(memberKey).value}"`;
    else if (c.value === 'signature-input') value = serializeInnerList(parsed.input.get(memberKey));
    else if (c.value === 'signature') value = `:${parsed.signature.get(memberKey).value.toString('base64')}:`;
    else value = headerOf(request.headers, c.value);
    return `${componentId(c)}: ${value}`;
  });
  return [...lines, `"@signature-params": ${serializeInnerList(parsed.input.get(label))}`].join('\n');
}

/**
 * Verifies the one web-bot-auth signature on the request and returns label → origin.
 * Each option skips one profile check, so a test can show a vector fails on that check alone.
 */
function verifyRequest(vector, { skipNonce = false, skipAgentCoverage = false, skipSignatureCount = false, keyidOnlyLookup = false } = {}) {
  const { request, reference_now: now } = vector;
  const parsed = parseRequestHeaders(request.headers);
  const replayCache = new Set((vector.test_harness_state?.replay_cache_entries ?? []).map(e => `${e.identity}|${e.nonce}`));
  const labels = [...parsed.input].filter(([, m]) => m.params.get('tag') === 'web-bot-auth').map(([label]) => label);
  if (!skipSignatureCount) {
    // The profile takes exactly one web-bot-auth signature and one Signature-Agent member per request.
    if (labels.length !== 1) throw new ProfileError(403, 'count', `expected one web-bot-auth signature, found ${labels.length}`);
    if (parsed.agent.size !== 1) throw new ProfileError(403, 'count', `expected one Signature-Agent member, found ${parsed.agent.size}`);
  }
  const identities = {};
  for (const label of labels) {
    const origin = parsed.agent.get(label)?.value;
    if (!origin) throw new ProfileError(403, 'signature', `no Signature-Agent member for ${label}`);
    // Exactly the ASCII serialization of an https origin, compared as a string without normalizing.
    if (!origin.startsWith('https://') || URL.parse(origin)?.origin !== origin) {
      throw new ProfileError(403, 'signature', `Signature-Agent ${origin} is not an https origin`);
    }
    const { value: components, params } = parsed.input.get(label);
    const covered = components.map(componentId);
    const requiredComponents = skipAgentCoverage ? REQUIRED_COMPONENTS : [...REQUIRED_COMPONENTS, `"signature-agent";key="${label}"`];
    for (const c of requiredComponents) {
      if (!covered.includes(c)) throw new ProfileError(403, 'signature', `${label} does not cover ${c}`);
    }
    for (const p of REQUIRED_PARAMETERS) {
      if (p === 'nonce' && skipNonce) continue;
      if (!params.has(p)) throw new ProfileError(403, 'signature', `${label} has no ${p} parameter`);
    }
    if (!PROFILE_ALGORITHMS.includes(params.get('alg'))) throw new ProfileError(403, 'signature', `${label} alg is not ed25519`);
    if (!skipNonce) {
      // Unpadded base64url or canonical padded base64, as Cloudflare's validateNonce accepts.
      const nonce = params.get('nonce');
      const encoding = /^[A-Za-z0-9_-]+$/.test(nonce) ? 'base64url' : /^[A-Za-z0-9+/]+={0,2}$/.test(nonce) ? 'base64' : null;
      const decoded = encoding ? Buffer.from(nonce, encoding) : null;
      if (!decoded || decoded.length !== NONCE_BYTES || decoded.toString(encoding) !== nonce) {
        throw new ProfileError(403, 'signature', `${label} nonce is not ${NONCE_BYTES} bytes, base64url or padded base64`);
      }
    }
    const created = params.get('created');
    const expires = params.get('expires');
    if (created > now + CLOCK_SKEW || expires < now || expires - created > MAX_LIFETIME) {
      throw new ProfileError(403, 'signature', `${label} is outside its validity window`);
    }
    const kid = params.get('keyid');
    const published = keyidOnlyLookup ? keys.map(k => k.kid) : (vector.directories?.[origin]?.keys_ref ?? []);
    if (!published.includes(kid)) throw new ProfileError(403, 'signature', `key ${kid} is not in the directory at ${origin}`);
    const jwk = keys.find(k => k.kid === kid);
    const base = requestBase(request, parsed, label);
    if (!crypto.verify(null, Buffer.from(base), publicKey(jwk), parsed.signature.get(label).value)) {
      throw new ProfileError(403, 'signature', `${label} signature does not verify`);
    }
    if (replayCache.has(`${origin}|${params.get('nonce')}`)) throw new ProfileError(429, 'replay', `${label} nonce already seen for ${origin}`);
    identities[label] = origin;
  }
  return identities;
}

// ── Tests ─────────────────────────────────────────────────────────────────

const positive = loadDir('positive');
const negative = loadDir('negative');

describe('Web Bot Auth profile test keys', () => {
  it('derives each key from its published seed name', () => {
    for (const k of keys) {
      const seed = crypto.createHash('sha256').update(`rfc004-test/${k.seed_name}`).digest();
      assert.equal(k._private_d_for_test_only, seed.toString('base64url'), k.seed_name);
      const privateKey = crypto.createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', x: k.x, d: k._private_d_for_test_only }, format: 'jwk' });
      assert.equal(crypto.createPublicKey(privateKey).export({ format: 'jwk' }).x, k.x, k.seed_name);
    }
  });

  it('uses the RFC 7638 JWK thumbprint as each kid', () => {
    for (const k of keys) {
      const thumbprint = crypto.createHash('sha256').update(`{"crv":"Ed25519","kty":"OKP","x":"${k.x}"}`).digest('base64url');
      assert.equal(k.kid, thumbprint, k.seed_name);
    }
  });
});

describe('Web Bot Auth profile schema fields', () => {
  it('signing_profile has no default, so filling in defaults never adds it next to authentication', () => {
    for (const name of ['push-notification-config', 'notification-config', 'agent-notification-config']) {
      const schema = JSON.parse(fs.readFileSync(path.join(__dirname, `../static/schemas/source/core/${name}.json`), 'utf8'));
      const field = schema.properties.signing_profile;
      assert.equal(field.$ref, '/schemas/enums/webhook-signing-profile.json', name);
      assert.ok(!('default' in field), `${name}.signing_profile declares a default`);
      assert.ok(schema.properties.authentication, `${name} has no authentication field`);
    }
  });
});

describe('Web Bot Auth profile positive vectors', () => {
  for (const { file, vector } of positive.filter(e => !e.vector.response)) {
    it(`${file}: the signature verifies and names the expected identity`, () => {
      assert.deepEqual(verifyRequest(vector), vector.expected_outcome.identities);
    });

    it(`${file}: expected_signature_base matches the base rebuilt from the wire`, () => {
      const parsed = parseRequestHeaders(vector.request.headers);
      for (const label of parsed.input.keys()) {
        assert.equal(requestBase(vector.request, parsed, label), vector.expected_signature_base[label], label);
      }
    });

    it(`${file}: Content-Digest matches the body`, () => {
      const digest = `sha-256=:${crypto.createHash('sha256').update(vector.request.body).digest('base64')}:`;
      assert.equal(vector.request.headers['Content-Digest'], digest);
    });
  }

  for (const { file, vector } of positive.filter(e => e.vector.response)) {
    it(`${file}: each directory signature verifies with the key the directory itself publishes`, () => {
      const { response } = vector;
      assert.equal(response.headers['Content-Type'], 'application/http-message-signatures-directory+json');
      const digest = `sha-256=:${crypto.createHash('sha256').update(response.body).digest('base64')}:`;
      assert.equal(response.headers['Content-Digest'], digest);
      const input = parseDictionary(response.headers['Signature-Input']);
      const signature = parseDictionary(response.headers['Signature']);
      const published = JSON.parse(response.body).keys;
      for (const [label, member] of input) {
        assert.deepEqual(member.value.map(componentId), ['"@authority";req', '"content-digest"'], label);
        assert.equal(member.params.get('tag'), 'http-message-signatures-directory', label);
        const jwk = published.find(k => k.kid === member.params.get('keyid'));
        assert.ok(jwk, `${label} keyid is a key in the directory body`);
        const base = [
          `"@authority";req: ${new URL(vector.request.url).host}`,
          `"content-digest": ${digest}`,
          `"@signature-params": ${serializeInnerList(member)}`,
        ].join('\n');
        assert.equal(base, vector.expected_signature_base[label], label);
        assert.ok(crypto.verify(null, Buffer.from(base), publicKey(jwk), signature.get(label).value), label);
      }
    });
  }
});

// The check each negative vector targets, and the option that skips only that check.
const TARGETS = {
  '001-missing-nonce.json': { stage: 'signature', skip: { skipNonce: true } },
  '002-replayed-nonce.json': { stage: 'replay' },
  '003-signature-agent-not-covered.json': { stage: 'signature', skip: { skipAgentCoverage: true } },
  '004-key-not-in-named-directory.json': { stage: 'signature', skip: { keyidOnlyLookup: true } },
  '005-malformed-signature-agent.json': { stage: 'parse' },
  '006-two-signatures.json': { stage: 'count', skip: { skipSignatureCount: true } },
};

describe('Web Bot Auth profile negative vectors', () => {
  it('names a targeted check for every negative vector', () => {
    assert.deepEqual(negative.map(e => e.file), Object.keys(TARGETS).sort());
  });

  for (const { file, vector } of negative) {
    const target = TARGETS[file];

    it(`${file}: rejected with ${vector.expected_outcome.status} at the ${target?.stage} check`, () => {
      assert.throws(
        () => verifyRequest(vector),
        e => e instanceof ProfileError && e.status === vector.expected_outcome.status && e.stage === target.stage
      );
    });

    if (vector.expected_signature_base) {
      it(`${file}: expected_signature_base matches the base rebuilt from the wire`, () => {
        const parsed = parseRequestHeaders(vector.request.headers);
        for (const label of Object.keys(vector.expected_signature_base)) {
          assert.equal(requestBase(vector.request, parsed, label), vector.expected_signature_base[label], label);
        }
      });
    }

    if (target?.skip) {
      it(`${file}: verifies once the targeted check is skipped`, () => {
        assert.doesNotThrow(() => verifyRequest(vector, target.skip));
      });
    }
  }

  it('006: both signatures verify on their own, so only the count check rejects the request', () => {
    const { vector } = negative.find(e => e.file === '006-two-signatures.json');
    const { vector: original } = positive.find(e => e.file === '001-single-signer-request.json');
    assert.deepEqual(verifyRequest(vector, { skipSignatureCount: true }), { sig1: 'https://buyer-7k3q.com', sig2: 'https://agent.brand-7k3q.com' });
    assert.equal(vector.expected_signature_base.sig1, original.expected_signature_base.sig1);
  });

  it('a second Signature-Agent member on a single-signature request is rejected with 403', () => {
    const { vector: original } = positive.find(e => e.file === '001-single-signer-request.json');
    const headers = { ...original.request.headers, 'Signature-Agent': `${original.request.headers['Signature-Agent']}, sig2="https://agent.brand-7k3q.com"` };
    const vector = { ...original, request: { ...original.request, headers } };
    assert.throws(() => verifyRequest(vector), e => e instanceof ProfileError && e.status === 403 && e.stage === 'count');
    assert.deepEqual(verifyRequest(vector, { skipSignatureCount: true }), original.expected_outcome.identities);
  });

  it('a Signature-Agent value that is not exactly an https origin is refused with 403', () => {
    const { vector: original } = positive.find(e => e.file === '001-single-signer-request.json');
    const kid = parseRequestHeaders(original.request.headers).input.get('sig1').params.get('keyid');
    const jwk = keys.find(k => k.kid === kid);
    const privateKey = crypto.createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x, d: jwk._private_d_for_test_only }, format: 'jwk' });
    for (const value of ['http://buyer-7k3q.com', 'https://buyer-7k3q.com/', 'https://Buyer-7k3q.com', 'https://buyer-7k3q.com:443', 'https://buyer-7k3q.com/agent']) {
      // Re-sign with the published seed, so the origin rule is the only one the request breaks.
      const unsigned = { ...original.request, headers: { ...original.request.headers, 'Signature-Agent': `sig1="${value}"` } };
      const signature = crypto.sign(null, Buffer.from(requestBase(unsigned, parseRequestHeaders(unsigned.headers), 'sig1')), privateKey);
      const request = { ...unsigned, headers: { ...unsigned.headers, Signature: `sig1=:${signature.toString('base64')}:` } };
      const vector = { ...original, request, directories: { [value]: original.directories['https://buyer-7k3q.com'] } };
      assert.throws(() => verifyRequest(vector), e => e instanceof ProfileError && e.status === 403 && /not an https origin/.test(e.message), value);
    }
  });

  it('a Signature-Input member with another tag is not read', () => {
    const { vector: original } = positive.find(e => e.file === '001-single-signer-request.json');
    const h = original.request.headers;
    const headers = {
      ...h,
      'Signature-Input': `${h['Signature-Input']}, cdn=("@method" "@authority");created=1790841600;keyid="edge";alg="ed25519";tag="cdn-edge"`,
      Signature: `${h.Signature}, cdn=:${Buffer.alloc(64).toString('base64')}:`,
    };
    const vector = { ...original, request: { ...original.request, headers } };
    assert.deepEqual(verifyRequest(vector), original.expected_outcome.identities);
  });

  it('002: the replayed request is byte-identical to positive/001', () => {
    const { vector } = negative.find(e => e.file === '002-replayed-nonce.json');
    const { vector: original } = positive.find(e => e.file === '001-single-signer-request.json');
    assert.deepEqual(vector.request, original.request);
  });
});
