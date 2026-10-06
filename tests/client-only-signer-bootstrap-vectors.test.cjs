#!/usr/bin/env node
/**
 * Client-only signer bootstrap vectors.
 *
 * Runs a reference resolver for the "Client-only signers" section of
 * docs/building/by-layer/L1/security.mdx against
 * static/compliance/source/test-vectors/client-only-signer-bootstrap/vectors.json.
 * The resolver implements steps C1-C5 over fixture documents, with no network.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const dir = path.join(root, 'static/compliance/source/test-vectors/client-only-signer-bootstrap');
const vectors = JSON.parse(fs.readFileSync(path.join(dir, 'vectors.json'), 'utf8'));
const errorCodes = JSON.parse(
  fs.readFileSync(path.join(root, 'static/schemas/source/enums/request-signing-error-code.json'), 'utf8')
).enum;

/** Shared canonicalization subset: lowercase host, drop default port, empty path becomes "/". */
function canonical(url) {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}${u.port && u.port !== '443' ? `:${u.port}` : ''}${u.pathname}${u.search}`;
}

/** Reference eTLD+1 for the .example fixture hosts: the last two labels. */
function etld1(urlOrHost) {
  const host = urlOrHost.includes('://') ? new URL(urlOrHost).hostname : urlOrHost;
  return host.split('.').slice(-2).join('.');
}

/** Top-level agents[], or for a House Portfolio house.agents[] and every brands[].agents[]. */
function candidatesOf(doc) {
  if (doc.agents) return doc.agents;
  return [...((doc.house && doc.house.agents) || []), ...(doc.brands || []).flatMap((b) => b.agents || [])];
}

class Reject extends Error {
  constructor(code, detail) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

function resolve(vector) {
  const { onboarding_record: record, request } = vector;
  const fetched = [];
  const fetch = (url) => {
    fetched.push(url);
    return url;
  };

  if (!record) {
    // No onboarding record: the verifier runs the canonical chain from the agent URL (step 1).
    const agent = request.canonical_chain_agent_url;
    if (!agent) throw new Reject('request_signature_key_unknown');
    fetch(agent);
    const capabilities = (vectors.capabilities_endpoints || {})[agent];
    if (!capabilities) throw new Reject('request_signature_capabilities_unreachable');
    if (!capabilities.identity || !capabilities.identity.brand_json_url) {
      throw new Reject('request_signature_brand_json_url_missing');
    }
    throw new Error('fixture capabilities carry a brand_json_url; no vector exercises the rest of the chain');
  }

  // C1: independent authentication selects the principal; candidates come only from its record.
  if (request.authenticated_principal !== record.principal) throw new Reject('request_signature_key_unknown');
  const matches = [];
  for (const candidate of record.signing_agents) {
    // C2: no capabilities fetch; brand_json_url comes from the record.
    const agentUrl = canonical(candidate.agent_url);
    // C3: origin binding, brand.json fetch, canonical agents[].url match, jwks_uri.
    const brandDoc = vectors.documents[fetch(candidate.brand_json_url)];
    if (!brandDoc) throw new Reject('request_signature_brand_json_unreachable');
    if (etld1(candidate.agent_url) !== etld1(candidate.brand_json_url)) {
      throw new Reject('request_signature_brand_origin_mismatch');
    }
    const entries = candidatesOf(brandDoc).filter((e) => canonical(e.url) === agentUrl);
    const distinct = new Map(entries.map((e) => [`${e.type}|${e.jwks_uri ? canonical(e.jwks_uri) : "none"}`, e]));
    if (distinct.size === 0) throw new Reject('request_signature_agent_not_in_brand_json');
    if (distinct.size > 1) throw new Reject('request_signature_brand_json_ambiguous');
    const entry = [...distinct.values()][0];
    // C3: an explicit jwks_uri is required; the default location at the agent's origin does not apply.
    if (!entry.jwks_uri) throw new Reject('request_signature_agent_not_in_brand_json');
    // C4: the full jwks_uri recorded at onboarding replaces the key_origins declaration.
    if (canonical(entry.jwks_uri) !== canonical(candidate.jwks_uri)) {
      throw new Reject('request_signature_key_origin_mismatch', {
        purpose: 'request-signing',
        expected_origin: new URL(candidate.jwks_uri).origin,
        actual_origin: new URL(entry.jwks_uri).origin,
      });
    }
    // C5: resolve the keyid only inside this candidate's JWKS.
    const kids = vectors.jwks[fetch(entry.jwks_uri)] || [];
    if (kids.includes(request.keyid)) matches.push(agentUrl);
  }
  if (matches.length === 0) throw new Reject('request_signature_key_unknown');
  if (matches.length > 1) throw new Reject('request_signature_brand_json_ambiguous');
  return { agent_url: matches[0], fetched };
}

for (const vector of vectors.vectors) {
  test(vector.id, () => {
    const { expected } = vector;
    if (expected.outcome === 'accept') {
      const result = resolve(vector);
      assert.equal(result.agent_url, canonical(expected.agent_url));
      for (const url of expected.must_not_fetch || []) {
        assert.ok(!result.fetched.includes(url), `verifier fetched ${url}`);
      }
      return;
    }
    let thrown;
    try {
      resolve(vector);
    } catch (err) {
      if (!(err instanceof Reject)) throw err;
      thrown = err;
    }
    assert.ok(thrown, 'expected a rejection');
    assert.equal(thrown.code, expected.code);
    if (expected.not_code) assert.notEqual(thrown.code, expected.not_code);
    if (expected.detail) assert.deepEqual(thrown.detail, expected.detail);
  });
}

test('vector set is well formed', () => {
  const ids = vectors.vectors.map((v) => v.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate vector ids');
  assert.ok(ids.some((id) => id.startsWith('positive-')), 'needs a positive vector');
  assert.ok(ids.filter((id) => id.startsWith('negative-')).length >= 12, 'needs the negative set');
  for (const v of vectors.vectors) {
    for (const code of [v.expected.code, v.expected.not_code].filter(Boolean)) {
      assert.ok(errorCodes.includes(code), `${v.id}: ${code} is not a request-signing error code`);
    }
  }
  const unreachable = vectors.vectors.find((v) => v.id === 'negative-008-no-onboarding-record-runs-step-1');
  const missing = vectors.vectors.find((v) => v.id === 'negative-012-callable-agent-without-brand-json-url');
  assert.equal(unreachable.expected.code, 'request_signature_capabilities_unreachable');
  assert.equal(unreachable.expected.not_code, 'request_signature_brand_json_url_missing');
  assert.equal(missing.expected.code, 'request_signature_brand_json_url_missing');
  assert.ok(!(unreachable.request.canonical_chain_agent_url in vectors.capabilities_endpoints));
});
