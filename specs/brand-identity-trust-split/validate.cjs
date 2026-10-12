// Validates the proposal examples against the experimental trust/v1 schemas under static/schemas/source/trust/v1/,
// plus the one-agent-per-origin rule that JSON Schema cannot express. Run by tests/trust-json-v1.test.cjs.
// Run: node specs/brand-identity-trust-split/validate.cjs
const Ajv = require('ajv'); const addFormats = require('ajv-formats');
const fs = require('fs'); const path = require('path');
const ajv = new Ajv({ allErrors: true, strict: false }); addFormats(ajv);
const root = path.resolve(__dirname, '../..');
const src = path.join(root, 'static/schemas/source');
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.json') ? [path.join(d, e.name)] : []);
for (const f of walk(src)) { try { const s = JSON.parse(fs.readFileSync(f)); if (s.$id) ajv.addSchema(s); } catch {} }
const dir = __dirname;
let fail = 0;
// Rules JSON Schema cannot express (specs/agent-identity-3-3.md R0, R1). Canonical origin is defined in
// docs/reference/url-canonicalization.mdx: scheme and authority after steps 1-4, using the SDK's implementation.
const { canonicalAuthority } = require('@adcp/sdk/signing');
const canonicalOrigin = url => { try { return `${new URL(url).protocol.toLowerCase()}//${canonicalAuthority(url, '3.2')}`; } catch { return null; } };
const ruleViolations = doc => {
  const out = []; const origins = new Set();
  for (const a of doc.agents || []) {
    const o = canonicalOrigin(a.url);
    if (!o) out.push(`agent url has no canonical origin: ${a.url}`);
    else if (origins.has(o)) out.push(`two agents share the origin ${o}`);
    else origins.add(o);
  }
  for (const ack of doc.acknowledgements || []) {
    if (!origins.has(canonicalOrigin(ack.agent_url))) out.push(`acknowledgement agent_url matches no agents[] entry: ${ack.agent_url}`);
  }
  return out;
};
const valid = (id, doc) => ajv.validate(id, doc) && (id.endsWith('trust-acknowledgements.json') || ruleViolations(doc).length === 0);
for (const f of fs.readdirSync(path.join(dir, 'examples'))) {
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'examples', f)));
  const id = f.includes('acknowledgements') ? '/schemas/trust/v1/trust-acknowledgements.json' : '/schemas/trust/v1/trust.json';
  const ok = valid(id, doc);
  console.log(ok ? 'PASS' : 'FAIL', f); if (!ok) { fail++; console.log(JSON.stringify(ajv.errors || ruleViolations(doc), null, 1)); }
}
// negative cases
const neg = [
  ['both acknowledgements and acknowledgements_url', { acknowledgements: [], acknowledgements_url: 'https://a.example/x' }],
  ['unknown top-level key', { agents: [{ url: 'https://a.example/mcp', roles: ['adcp:sales'] }], properties: [] }],
  ['grant carrying keys', { grants: [{ grantee: 'a.example', scopes: ['adcp:governance'], agents: [{ url: 'https://a.example/x', jwks_uri: 'https://a.example/j' }] }] }],
  ['empty record', {}],
  ['http agent url', { agents: [{ url: 'http://a.example/mcp', roles: ['adcp:sales'] }] }],
  ['unknown adcp role', { agents: [{ url: 'https://a.example/mcp', roles: ['adcp:seller'] }] }],
  ['unnamespaced role', { agents: [{ url: 'https://a.example/mcp', roles: ['sales'] }] }],
  ['unknown adcp scope', { grants: [{ grantee: 'a.example', scopes: ['adcp:everything'] }] }],
  ['acknowledgement without via', { acknowledgements: [{ grantor: 'p.example', agent_url: 'https://a.example/mcp' }] }],
  ['agent carrying jwks_uri', { agents: [{ url: 'https://a.example/mcp', roles: ['adcp:sales'], jwks_uri: 'https://a.example/.well-known/jwks.json' }] }],
  ['two agents sharing an origin', { agents: [{ url: 'https://a.example/one', roles: ['adcp:sales'] }, { url: 'https://a.example/two', roles: ['adcp:buying'] }] }],
  ['two agents sharing an origin through a root dot', { agents: [{ url: 'https://a.example./one', roles: ['adcp:sales'] }, { url: 'https://a.example/two', roles: ['adcp:buying'] }] }],
  ['agent url with an empty DNS label', { agents: [{ url: 'https://a.example../x', roles: ['adcp:buying'] }] }],
  ['agent carrying a key pin', { agents: [{ url: 'https://a.example/mcp', roles: ['adcp:buying'], key_thumbprints: ['NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs'] }] }],
  ['signing_profiles is not part of the schema', { agents: [{ url: 'https://a.example/mcp', roles: ['adcp:buying'], profiles: { adcp: { signing_profiles: ['web-bot-auth'] } } }] }],
  ['acknowledgement for an agent the record does not list', { agents: [{ url: 'https://a.example/mcp', roles: ['adcp:sales'] }], acknowledgements: [{ grantor: 'p.example', agent_url: 'https://b.example/mcp', via: 'adcp:adagents' }] }],
];
for (const [name, doc] of neg) { const ok = valid('/schemas/trust/v1/trust.json', doc); console.log(ok ? 'UNEXPECTED PASS' : 'rejects', name); if (ok) fail++; }
// positive: two agents on distinct origins, and an acknowledgement matched by origin
const pos = {
  agents: [
    { url: 'https://buyer.a.example/mcp', roles: ['adcp:buying'] },
    { url: 'https://Gov.A.Example:443/mcp', roles: ['adcp:governance'] },
  ],
  acknowledgements: [{ grantor: 'p.example', agent_url: 'https://gov.a.example/other-path', via: 'adcp:adagents' }],
};
{ const ok = valid('/schemas/trust/v1/trust.json', pos); console.log(ok ? 'PASS' : 'FAIL', 'distinct origins, acknowledgement matched by origin'); if (!ok) { fail++; console.log(JSON.stringify(ajv.errors, null, 1)); } }
process.exit(fail ? 1 : 0);
