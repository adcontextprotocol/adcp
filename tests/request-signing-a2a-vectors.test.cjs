/**
 * Independent verification of the A2A operation-resolution request-signing
 * vectors under static/compliance/source/test-vectors/request-signing/a2a/
 * (adcp#7820).
 *
 * Shares no code with the generator
 * (scripts/generate-request-signing-a2a-vectors.mjs):
 *   1. A reference operation resolver implementing the "Operation resolution
 *      over A2A" rules from docs/building/by-layer/L1/security.mdx, with a
 *      duplicate-key-rejecting JSON parser.
 *   2. A minimal RFC 9421 base builder plus node:crypto signature and digest
 *      checks for the signed vectors.
 *   3. @adcp/sdk's verifyRequestSignature, called with the operation the
 *      reference resolver returned, as an adopter's gate would.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const {
  canonicalTargetUri,
  canonicalAuthority,
  verifyRequestSignature,
  StaticJwksResolver,
  InMemoryReplayStore,
  InMemoryRevocationStore,
} = require('@adcp/sdk/signing');

const ROOT = path.join(__dirname, '..');
const VECTOR_DIR = path.join(ROOT, 'static/compliance/source/test-vectors/request-signing');
const A2A_DIR = path.join(VECTOR_DIR, 'a2a');
const keys = JSON.parse(fs.readFileSync(path.join(VECTOR_DIR, 'keys.json'), 'utf8')).keys;
const capabilitiesSchema = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'static/schemas/source/protocol/get-adcp-capabilities-response.json'), 'utf8')
);
const securityDoc = fs.readFileSync(path.join(ROOT, 'docs/building/by-layer/L1/security.mdx'), 'utf8');

function loadDir(rel) {
  const dir = path.join(A2A_DIR, rel);
  return fs
    .readdirSync(dir)
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(file => ({ id: `a2a/${rel}/${file.replace(/\.json$/, '')}`, vector: JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) }));
}
const positive = loadDir('positive');
const negative = loadDir('negative');
const all = [...positive, ...negative];

/** Strict JSON parse: rejects duplicate object keys at any depth. */
function strictParse(text) {
  let i = 0;
  const ws = () => { while (' \t\n\r'.includes(text[i]) && i < text.length) i++; };
  const fail = msg => { throw new Error(`malformed: ${msg}`); };
  function value() {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const obj = {};
      const seen = new Set();
      ws();
      if (text[i] === '}') { i++; return obj; }
      for (;;) {
        ws();
        if (text[i] !== '"') fail('object key');
        const key = string();
        if (seen.has(key)) fail(`duplicate key ${key}`);
        seen.add(key);
        ws();
        if (text[i++] !== ':') fail('colon');
        obj[key] = value();
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i++] === '}') return obj;
        fail('object end');
      }
    }
    if (c === '[') {
      i++;
      const arr = [];
      ws();
      if (text[i] === ']') { i++; return arr; }
      for (;;) {
        arr.push(value());
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i++] === ']') return arr;
        fail('array end');
      }
    }
    if (c === '"') return string();
    const m = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i));
    if (!m) fail('value');
    i += m[0].length;
    return JSON.parse(m[0]);
  }
  function string() {
    const start = i++;
    while (text[i] !== '"') { if (text[i] === '\\') i++; i++; if (i >= text.length) fail('string'); }
    i++;
    return JSON.parse(text.slice(start, i));
  }
  const result = value();
  ws();
  if (i !== text.length) fail('trailing content');
  return result;
}

const A2A_INVOCATION_METHODS = new Set(['SendMessage', 'SendStreamingMessage', 'message/send', 'message/stream']);
const PART_CONTENT_MEMBERS = ['text', 'data', 'raw', 'url', 'file']; // 1.0: text/data/raw/url; 0.3: text/data/file
const FILE_MEMBERS = new Set(['raw', 'url', 'file']);

/** Reference implementation of "Operation resolution over A2A". Throws on any unresolvable request. */
function resolveOperation(body) {
  const rpc = strictParse(body);
  if (rpc === null || typeof rpc !== 'object' || Array.isArray(rpc)) throw new Error('malformed: not one JSON-RPC request object');
  if (rpc.method === 'tools/call') return rpc.params?.name;
  if (!A2A_INVOCATION_METHODS.has(rpc.method)) return undefined;
  const parts = rpc.params?.message?.parts;
  if (!Array.isArray(parts)) throw new Error('malformed: no parts');
  const dataParts = [];
  for (const part of parts) {
    if (part === null || typeof part !== 'object' || Array.isArray(part)) throw new Error('malformed: part');
    const members = PART_CONTENT_MEMBERS.filter(m => part[m] !== undefined);
    if (members.length !== 1) throw new Error('malformed: part must carry exactly one content member');
    if (part.kind !== undefined && part.kind !== members[0]) throw new Error('malformed: kind disagrees with member');
    if (FILE_MEMBERS.has(members[0])) throw new Error('malformed: FilePart');
    if (members[0] === 'data') dataParts.push(part.data);
  }
  if (dataParts.length !== 1) throw new Error('malformed: exactly one DataPart required');
  const [data] = dataParts;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('malformed: data must be an object');
  if (typeof data.skill !== 'string' || data.skill === '') throw new Error('malformed: skill');
  return data.skill;
}

function header(request, name) {
  const key = Object.keys(request.headers).find(k => k.toLowerCase() === name);
  return request.headers[key];
}

function parseSig1Input(value) {
  const match = /^sig1=(\(([^)]*)\)[^,]*)/.exec(value);
  const components = match[2].split(' ').filter(Boolean).map(c => JSON.parse(c));
  return { serialized: match[1], components };
}

function independentBase(vector) {
  const { request } = vector;
  const parsed = parseSig1Input(request.headers['Signature-Input']);
  const value = component => {
    if (component === '@method') return request.method.toUpperCase();
    if (component === '@target-uri') return canonicalTargetUri(request.url, '3.2');
    if (component === '@authority') return canonicalAuthority(request.url, '3.2');
    return header(request, component);
  };
  return [...parsed.components.map(c => `"${c}": ${value(c)}`), `"@signature-params": ${parsed.serialized}`].join('\n');
}

function isSigned(vector) {
  return vector.request.headers['Signature-Input'] !== undefined;
}

function jwksFor(vector) {
  return vector.jwks_ref.map(kid => {
    const { _private_d_for_test_only, ...pub } = keys.find(k => k.kid === kid);
    return pub;
  });
}

/** What an adopter's gate does: resolve once, then call the verifier with that operation. */
async function gate(vector) {
  const operation = resolveOperation(vector.request.body);
  const { operation_sources, ...capability } = vector.verifier_capability;
  return verifyRequestSignature(
    { method: vector.request.method, url: vector.request.url, headers: vector.request.headers, body: vector.request.body },
    {
      capability,
      jwks: new StaticJwksResolver(jwksFor(vector)),
      replayStore: new InMemoryReplayStore(),
      revocationStore: new InMemoryRevocationStore(),
      now: () => vector.reference_now,
      operation,
      adcpVersion: '3.2',
    }
  );
}

describe('A2A operation-resolution vectors: corpus shape', () => {
  it('ships positive and negative vectors for 1.0 and 0.3 and the streaming method', () => {
    const methods = new Set(all.map(({ vector }) => JSON.parse(vector.request.body).method).filter(Boolean));
    for (const method of ['SendMessage', 'SendStreamingMessage', 'message/send']) assert.ok(methods.has(method), method);
    assert.ok(positive.some(e => e.vector.expected_outcome.status === 'verified'));
    assert.ok(negative.some(e => e.vector.expected_outcome.error_code === 'request_signature_required'));
    assert.ok(negative.some(e => e.vector.expected_outcome.error_code === 'request_body_malformed'));
  });

  it('pins every vector to the 3.2 wire profile with required digest coverage and no fallback credential', () => {
    for (const { id, vector } of all) {
      assert.equal(vector.signing_profile_version, '3.2', id);
      assert.equal(vector.verifier_capability.covers_content_digest, 'required', id);
      assert.equal(header(vector.request, 'authorization'), undefined, `${id} must not carry a fallback credential`);
    }
  });

  it('declares only operation_sources values the capabilities schema defines', () => {
    const field = capabilitiesSchema.properties.request_signing.properties.operation_sources;
    assert.equal(field.type, 'array');
    assert.equal(field.uniqueItems, true);
    const allowed = new Set(field.items.enum);
    assert.deepEqual([...allowed].sort(), ['a2a_invocation_skill', 'mcp_tools_call']);
    assert.equal(capabilitiesSchema.properties.request_signing.required.includes('operation_sources'), false);
    for (const { id, vector } of all) {
      for (const source of vector.verifier_capability.operation_sources ?? []) assert.ok(allowed.has(source), `${id}: ${source}`);
    }
  });

  it('keeps the protocol_methods_* grammar free of AdCP operation names while the operation lists carry them', () => {
    for (const { id, vector } of all) {
      const cap = vector.verifier_capability;
      for (const op of [...(cap.required_for ?? []), ...(cap.supported_for ?? [])]) assert.match(op, /^[a-z][a-z0-9_]*$/, id);
      for (const method of cap.protocol_methods_required_for ?? []) assert.doesNotMatch(method, /^[a-z][a-z0-9_]*$/, id);
    }
  });

  it('publishes the resolution rules and anchor the schema and vectors cite', () => {
    assert.match(securityDoc, /^#### Operation resolution over A2A$/m);
    assert.match(securityDoc, /\[Operation resolution over A2A\]\(#operation-resolution-over-a2a\)/);
    assert.doesNotMatch(
      securityDoc,
      /a `required_for` membership MUST NOT be satisfied by a body whose JSON-RPC `method` is anything other than `tools\/call`/
    );
  });
});

describe('A2A operation-resolution vectors verify independently', () => {
  for (const { id, vector } of all) {
    const outcome = vector.expected_outcome;

    it(`${id}: reference resolver ${outcome.error_code === 'request_body_malformed' ? 'rejects the body as unresolvable' : 'resolves the expected operation'}`, () => {
      if (outcome.error_code === 'request_body_malformed') {
        assert.throws(() => resolveOperation(vector.request.body), /malformed/);
      } else {
        assert.equal(resolveOperation(vector.request.body), outcome.resolved_operation);
      }
    });

    if (isSigned(vector)) {
      it(`${id}: recomputed signature base matches and signature and digest verify`, () => {
        assert.equal(independentBase(vector), vector.expected_signature_base);
        const kid = /keyid="([^"]+)"/.exec(vector.request.headers['Signature-Input'])[1];
        const jwk = keys.find(k => k.kid === kid);
        const publicKey = crypto.createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, format: 'jwk' });
        const signature = Buffer.from(/^sig1=:([^:]*):/.exec(vector.request.headers.Signature)[1], 'base64');
        assert.equal(crypto.verify(null, Buffer.from(independentBase(vector), 'utf8'), publicKey, signature), true);
        const digest = `sha-256=:${crypto.createHash('sha256').update(vector.request.body, 'utf8').digest('base64')}:`;
        assert.equal(vector.request.headers['Content-Digest'], digest);
        assert.ok(parseSig1Input(vector.request.headers['Signature-Input']).components.includes('content-digest'));
      });
    }

    if (outcome.error_code !== 'request_body_malformed') {
      it(`${id}: @adcp/sdk verifier called with the resolved operation returns the expected outcome`, async () => {
        if (outcome.success) {
          assert.equal((await gate(vector)).status, outcome.status);
        } else {
          await assert.rejects(gate(vector), err => {
            assert.equal(err.code, outcome.error_code);
            return true;
          });
        }
      });
    }
  }

  it('a gate that resolves the operation from the JSON-RPC method alone lets the bypass vectors through', async () => {
    const bypass = negative.find(e => e.id.endsWith('001-unsigned-sendmessage-required')).vector;
    const { operation_sources, ...capability } = bypass.verifier_capability;
    const result = await verifyRequestSignature(
      { method: 'POST', url: bypass.request.url, headers: bypass.request.headers, body: bypass.request.body },
      {
        capability,
        jwks: new StaticJwksResolver(jwksFor(bypass)),
        replayStore: new InMemoryReplayStore(),
        revocationStore: new InMemoryRevocationStore(),
        now: () => bypass.reference_now,
        operation: JSON.parse(bypass.request.body).method,
        adcpVersion: '3.2',
      }
    );
    assert.equal(result.status, 'unsigned', 'method-keyed lookup never matches required_for, the adcp#7820 bypass');
  });
});
