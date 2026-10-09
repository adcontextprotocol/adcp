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
const REQUIRED_PARAMETERS = ['created', 'expires', 'nonce', 'keyid', 'tag'];
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
      if (typeof value !== 'string' || !value.startsWith('https://')) throw new Error('Signature-Agent member is not an https URI string');
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
 * Verifies every web-bot-auth signature on the request and returns label → origin.
 * Each option skips one profile check, so a test can show a vector fails on that check alone.
 */
function verifyRequest(vector, { skipNonce = false, skipAgentCoverage = false, skipRelayCoverage = false, keyidOnlyLookup = false } = {}) {
  const { request, reference_now: now } = vector;
  const parsed = parseRequestHeaders(request.headers);
  const replayCache = new Set((vector.test_harness_state?.replay_cache_entries ?? []).map(e => `${e.identity}|${e.nonce}`));
  const labels = [...parsed.input.keys()];
  const identities = {};
  for (const label of labels) {
    const origin = parsed.agent.get(label)?.value;
    if (!origin) throw new ProfileError(403, 'signature', `no Signature-Agent member for ${label}`);
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
    if (params.get('tag') !== 'web-bot-auth') throw new ProfileError(403, 'signature', `${label} tag is not web-bot-auth`);
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
    if (replayCache.has(`${origin}|${params.get('nonce')}`)) throw new ProfileError(403, 'replay', `${label} nonce already seen for ${origin}`);
    identities[label] = origin;
  }
  if (!skipRelayCoverage) {
    // Each later signature covers the three members of every signature before it.
    for (let later = 1; later < labels.length; later++) {
      const covered = parsed.input.get(labels[later]).value.map(componentId);
      for (const inner of labels.slice(0, later)) {
        for (const member of ['signature-agent', 'signature-input', 'signature']) {
          const id = `"${member}";key="${inner}"`;
          if (!covered.includes(id)) throw new ProfileError(403, 'relay', `${labels[later]} does not cover ${id}`);
        }
      }
    }
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

describe('Web Bot Auth profile positive vectors', () => {
  for (const { file, vector } of positive.filter(e => !e.vector.response)) {
    it(`${file}: every signature verifies and names the expected identity`, () => {
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
  '004-relay-omits-inner-signature.json': { stage: 'relay', skip: { skipRelayCoverage: true } },
  '005-relay-inner-signature-altered.json': { stage: 'signature' },
  '006-key-not-in-named-directory.json': { stage: 'signature', skip: { keyidOnlyLookup: true } },
  '007-malformed-signature-agent.json': { stage: 'parse' },
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

  it('005: the relay signature fails on its own, because it covers the altered brand signature', () => {
    const { vector } = negative.find(e => e.file === '005-relay-inner-signature-altered.json');
    const parsed = parseRequestHeaders(vector.request.headers);
    const jwk = keys.find(k => k.kid === parsed.input.get('relay').params.get('keyid'));
    const base = requestBase(vector.request, parsed, 'relay');
    assert.equal(crypto.verify(null, Buffer.from(base), publicKey(jwk), parsed.signature.get('relay').value), false);
  });

  it('002: the replayed request is byte-identical to positive/001', () => {
    const { vector } = negative.find(e => e.file === '002-replayed-nonce.json');
    const { vector: original } = positive.find(e => e.file === '001-single-signer-request.json');
    assert.deepEqual(vector.request, original.request);
  });
});

// ── Governance tokens: one agent per purpose ──────────────────────────────

const GOVERNANCE_ALGORITHMS = ['Ed25519', 'EdDSA'];
const DIRECTORY_PATH = '/.well-known/http-message-signatures-directory';

class DocumentError extends Error {
  constructor(stage, code, message) {
    super(`${stage}: ${message}`);
    this.stage = stage;
    this.code = code;
  }
}

/**
 * Verifies a governance token's key and issuer, and returns the issuer origin.
 * Each option skips one check, so a test can show a vector fails on that check alone.
 */
function verifyGovernanceToken(vector, { skipDirectory = false, skipRole = false } = {}) {
  const parts = vector.jws.split('.');
  let header;
  let payload;
  try {
    if (parts.length !== 3) throw new Error('not three segments');
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch (e) {
    throw new DocumentError('parse', 'governance_token_invalid', e.message);
  }
  if (!GOVERNANCE_ALGORITHMS.includes(header.alg)) throw new DocumentError('header', 'governance_token_invalid', `alg ${header.alg}`);
  if (header.typ !== 'adcp-gov+jws') throw new DocumentError('header', 'governance_token_invalid', `typ ${header.typ}`);
  const issuer = new URL(payload.iss);
  if (issuer.protocol !== 'https:') throw new DocumentError('header', 'governance_token_invalid', 'iss is not https');
  if (header.jku !== `${issuer.origin}${DIRECTORY_PATH}`) throw new DocumentError('header', 'governance_token_invalid', 'jku is not the iss origin directory');
  const published = skipDirectory ? keys.map(k => k.kid) : (vector.directories?.[issuer.origin]?.keys_ref ?? []);
  if (!published.includes(header.kid)) throw new DocumentError('directory', 'governance_key_unknown', `key ${header.kid} is not in ${issuer.origin}'s directory`);
  const jwk = keys.find(k => k.kid === header.kid);
  const signature = Buffer.from(parts[2], 'base64url');
  if (!crypto.verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), publicKey(jwk), signature)) {
    throw new DocumentError('signature', 'governance_token_invalid', 'signature does not verify');
  }
  if (payload.exp < vector.reference_now) throw new DocumentError('claims', 'governance_token_expired', 'exp is in the past');
  if (payload.iat > vector.reference_now + 60) throw new DocumentError('claims', 'governance_token_not_yet_valid', 'iat is in the future');
  if (!skipRole && !(vector.role_listing?.['adcp:governance'] ?? []).includes(issuer.origin)) {
    throw new DocumentError('role', 'governance_issuer_not_authorized', `${issuer.origin} is not listed in the governance role`);
  }
  return issuer.origin;
}

const governance = loadDir('governance');

// The check each negative governance vector targets, and the option that skips only that check.
const GOVERNANCE_TARGETS = {
  '002-governance-token-key-not-in-issuer-directory.json': { stage: 'directory', skip: { skipDirectory: true } },
  '003-governance-token-from-non-governance-agent.json': { stage: 'role', skip: { skipRole: true } },
};

describe('Web Bot Auth profile governance vectors (one agent per purpose)', () => {
  it('names a targeted check for every negative governance vector', () => {
    const negatives = governance.filter(e => !e.vector.expected_outcome.success).map(e => e.file);
    assert.deepEqual(negatives, Object.keys(GOVERNANCE_TARGETS).sort());
  });

  for (const { file, vector } of governance) {
    it(`${file}: decoded header and payload match the token`, () => {
      const [h, p] = vector.jws.split('.');
      assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString('utf8')), vector.decoded.header);
      assert.deepEqual(JSON.parse(Buffer.from(p, 'base64url').toString('utf8')), vector.decoded.payload);
    });

    if (vector.expected_outcome.success) {
      it(`${file}: verifies and names the expected issuer`, () => {
        assert.equal(verifyGovernanceToken(vector), vector.expected_outcome.issuer);
      });
      continue;
    }

    const target = GOVERNANCE_TARGETS[file];
    it(`${file}: rejected with ${vector.expected_outcome.error_code} at the ${target?.stage} check`, () => {
      assert.throws(
        () => verifyGovernanceToken(vector),
        e => e instanceof DocumentError && e.code === vector.expected_outcome.error_code && e.stage === target.stage
      );
    });

    it(`${file}: verifies once the targeted check is skipped`, () => {
      assert.doesNotThrow(() => verifyGovernanceToken(vector, target.skip));
    });
  }
});
