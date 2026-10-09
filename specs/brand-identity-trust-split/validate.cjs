// Validates the proposal examples against the draft schemas (not wired into npm test).
// Run: node specs/brand-identity-trust-split/validate.cjs
const Ajv = require('ajv'); const addFormats = require('ajv-formats');
const fs = require('fs'); const path = require('path');
const ajv = new Ajv({ allErrors: true, strict: false }); addFormats(ajv);
const root = path.resolve(__dirname, '../..');
const src = path.join(root, 'static/schemas/source');
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.json') ? [path.join(d, e.name)] : []);
for (const f of walk(src)) { try { const s = JSON.parse(fs.readFileSync(f)); if (s.$id) ajv.addSchema(s); } catch {} }
const dir = __dirname;
for (const f of ['trust.json', 'trust-acknowledgements.json']) ajv.addSchema(JSON.parse(fs.readFileSync(path.join(dir, f))));
let fail = 0;
for (const f of fs.readdirSync(path.join(dir, 'examples'))) {
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'examples', f)));
  const id = f.includes('acknowledgements') ? '/schemas/trust/v1/trust-acknowledgements.json' : '/schemas/trust/v1/trust.json';
  const ok = ajv.validate(id, doc);
  console.log(ok ? 'PASS' : 'FAIL', f); if (!ok) { fail++; console.log(JSON.stringify(ajv.errors, null, 1)); }
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
];
for (const [name, doc] of neg) { const ok = ajv.validate('/schemas/trust/v1/trust.json', doc); console.log(ok ? 'UNEXPECTED PASS' : 'rejects', name); if (ok) fail++; }
process.exit(fail ? 1 : 0);
