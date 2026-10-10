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
// One agent per origin (specs/agent-identity-3-3.md R1): the canonical origin of agents[].url is the identity.
const sharedOrigins = doc => {
  const seen = new Map(); const dupes = [];
  for (const a of doc.agents || []) {
    let origin; try { origin = new URL(a.url).origin; } catch { continue; }
    if (seen.has(origin)) dupes.push(origin); else seen.set(origin, a.url);
  }
  return dupes;
};
const valid = (id, doc) => ajv.validate(id, doc) && sharedOrigins(doc).length === 0;
for (const f of fs.readdirSync(path.join(dir, 'examples'))) {
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'examples', f)));
  const id = f.includes('acknowledgements') ? '/schemas/trust/v1/trust-acknowledgements.json' : '/schemas/trust/v1/trust.json';
  const ok = valid(id, doc);
  console.log(ok ? 'PASS' : 'FAIL', f); if (!ok) { fail++; console.log(JSON.stringify(ajv.errors || { shared_origins: sharedOrigins(doc) }, null, 1)); }
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
  ['malformed key thumbprint', { agents: [{ url: 'https://a.example/mcp', roles: ['adcp:buying'], key_thumbprints: ['not-a-thumbprint'] }] }],
  ['unknown signing profile', { agents: [{ url: 'https://a.example/mcp', roles: ['adcp:buying'], profiles: { adcp: { signing_profiles: ['adcp-agent-url'] } } }] }],
];
for (const [name, doc] of neg) { const ok = valid('/schemas/trust/v1/trust.json', doc); console.log(ok ? 'UNEXPECTED PASS' : 'rejects', name); if (ok) fail++; }
// positive: pins and signing profiles are accepted on distinct origins
const pos = { agents: [
  { url: 'https://buyer.a.example/mcp', roles: ['adcp:buying'], key_thumbprints: ['NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs'], profiles: { adcp: { signing_profiles: ['wba'] } } },
  { url: 'https://gov.a.example/mcp', roles: ['adcp:governance'] },
] };
{ const ok = valid('/schemas/trust/v1/trust.json', pos); console.log(ok ? 'PASS' : 'FAIL', 'pins and signing profiles on distinct origins'); if (!ok) { fail++; console.log(JSON.stringify(ajv.errors, null, 1)); } }
process.exit(fail ? 1 : 0);
