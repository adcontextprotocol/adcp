// #8398: seventeen URL sites in the attestation and reporting schemas carried
// a hand-rolled pattern beyond the scheme. They now check `^https://` only.
// This proves the change is loosening only: every value the old leaf schema
// accepted, the new one accepts too.
const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const SCHEMA_ROOT = path.join(__dirname, '..', 'static', 'schemas', 'source');

// Userinfo and fragment refused (attestation-*). The attestation fetch contract rejects both at fetch time.
const AUTHORITY_PATH_QUERY = String.raw`^https://[^/?#@]+(?:/[^?#]*)?(?:\?[^#]*)?$`;
// Lexical private-address denylist (reporting-*). DNS and redirects are out of a regex's reach.
const LEXICAL_PUBLIC_HOST = String.raw`^https://(?![^/]*@)(?!localhost(?:[:/]|$))(?!\[)(?!\d+(?:\.\d+){3}(?::|/|$))(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?::\d+)?(?:/|$)`;

const SITES = [
  ['core/attestation-capabilities.json', '/properties/accepted_issuers/items/properties/resolvers/items/properties/url', AUTHORITY_PATH_QUERY],
  ['core/attestation-capabilities.json', '/properties/accepted_verifiers/items/properties/agent_url', AUTHORITY_PATH_QUERY],
  ['core/attestation-evaluation.json', '/properties/evaluated_by', AUTHORITY_PATH_QUERY],
  ['core/attestation-evaluation.json', '/properties/verifier_agent_url', AUTHORITY_PATH_QUERY],
  ['core/attestation-issuer.json', '/oneOf/1/properties/agent_url', AUTHORITY_PATH_QUERY],
  ['core/attestation-reference.json', '/properties/locator/oneOf/0/properties/credential_uri', AUTHORITY_PATH_QUERY],
  ['core/attestation-reference.json', '/properties/verify_agent/properties/agent_url', AUTHORITY_PATH_QUERY],
  ['core/attestation-subject.json', '/oneOf/1/properties/agent_url', AUTHORITY_PATH_QUERY],
  ['core/product-audience-evidence-requirements.json', '/properties/accepted_attestation_issuers/items/oneOf/1/properties/agent_url', AUTHORITY_PATH_QUERY],
  ['core/reporting-canonical-content-digest.json', '/properties/canonicalization_uri', LEXICAL_PUBLIC_HOST],
  ['core/reporting-delivery-capabilities.json', '/properties/operations_contact/properties/url', LEXICAL_PUBLIC_HOST],
  ['core/reporting-delivery-offering.json', '/properties/report_definition_uri', LEXICAL_PUBLIC_HOST],
  ['core/reporting-delivery-offering.json', '/properties/reporting_profile/properties/schema_uri', LEXICAL_PUBLIC_HOST],
  ['core/reporting-delivery-offering.json', '/properties/reporting_profile/properties/canonicalization_uri', LEXICAL_PUBLIC_HOST],
  ['core/reporting-reliability-statistics.json', '/properties/evidence/properties/attestation_uri', LEXICAL_PUBLIC_HOST],
  ['core/reporting-revision.json', '/properties/report_definition_uri', LEXICAL_PUBLIC_HOST],
  ['core/reporting-revision.json', '/properties/schema_uri', LEXICAL_PUBLIC_HOST],
];

// Values the old patterns accepted: hosts, ports, paths, queries, and the
// quirks (a dotted quad followed by another label, a `localhost.` prefix).
const HOSTS = [
  'reports.example.com',
  'registry.adcontextprotocol.org',
  'cdn.seller-reports.example.net',
  'a.b.example.co.uk',
  'xn--bcher-kva.example',
  'localhost.example.com',
  '127.0.0.1.nip.io',
  'verifier.example',
];
const PORTS = ['', ':443', ':8443'];
const PATHS = ['', '/', '/mcp', '/.well-known/adcp/sales', '/definitions/v1.json', '/a%20b/caf%C3%A9', '/credentials/abc-123'];
const QUERIES = ['', '?version=3', '?a=1&b=2'];
const FRAGMENTS = ['', '#section'];

const SAMPLES = [];
for (const host of HOSTS) for (const port of PORTS) for (const p of PATHS) for (const q of QUERIES) for (const f of FRAGMENTS) {
  SAMPLES.push(`https://${host}${port}${p}${q}${f}`);
}

// Values the old patterns refused that are well-formed HTTPS URIs.
const NEWLY_ACCEPTED = [
  'https://issuer.example/credentials/abc#key-1',
  'https://127.0.0.1/admin',
  'https://localhost/report.json',
  'https://[2001:db8::1]/schema.json',
  'https://intranet/definitions.json',
];

const STILL_REFUSED = [
  'http://reports.example.com/definitions/v1.json',
  'ftp://reports.example.com/definitions/v1.json',
  'reports.example.com/definitions/v1.json',
  'not a uri',
];

function pointerGet(doc, pointer) {
  return pointer
    .split('/')
    .slice(1)
    .reduce((node, key) => node[key.replace(/~1/g, '/').replace(/~0/g, '~')], doc);
}

function leafValidator(ajv, node) {
  assert.equal(node.type, 'string');
  assert.equal(JSON.stringify(node).includes('$ref'), false);
  return ajv.compile(node);
}

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

for (const [file, pointer, oldPattern] of SITES) {
  test(`${file}#${pointer} accepts everything it accepted before`, () => {
    const doc = JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, file), 'utf8'));
    const node = pointerGet(doc, pointer);
    assert.equal(node.format, 'uri');
    assert.equal(node.pattern, '^https://');

    const validateNew = leafValidator(ajv, node);
    const validateOld = leafValidator(ajv, { ...node, pattern: oldPattern });

    let previouslyValid = 0;
    for (const value of SAMPLES) {
      if (!validateOld(value)) continue;
      previouslyValid += 1;
      assert.ok(validateNew(value), `${value} was valid and must stay valid: ${JSON.stringify(validateNew.errors)}`);
    }
    assert.ok(previouslyValid >= 200, `only ${previouslyValid} samples matched the old pattern`);

    for (const value of NEWLY_ACCEPTED) {
      assert.ok(validateNew(value), `${value} is an https URI: ${JSON.stringify(validateNew.errors)}`);
    }
    for (const value of STILL_REFUSED) {
      assert.equal(validateNew(value), false, `${value} must still fail`);
    }
  });
}

test('no source schema still carries either retired pattern', () => {
  const offenders = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.json')) {
        const text = fs.readFileSync(full, 'utf8');
        for (const retired of [AUTHORITY_PATH_QUERY, LEXICAL_PUBLIC_HOST]) {
          if (text.includes(JSON.stringify(retired))) offenders.push(path.relative(SCHEMA_ROOT, full));
        }
      }
    }
  })(SCHEMA_ROOT);
  assert.deepEqual(offenders, []);
});
