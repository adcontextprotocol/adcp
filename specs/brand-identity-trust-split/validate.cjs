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
for (const f of ['adcp-trust.json', 'adcp-trust-sells-for.json']) ajv.addSchema(JSON.parse(fs.readFileSync(path.join(dir, f))));
let fail = 0;
for (const f of fs.readdirSync(path.join(dir, 'examples'))) {
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'examples', f)));
  const id = f.includes('sells-for') ? '/schemas/adcp-trust-sells-for.json' : '/schemas/adcp-trust.json';
  const ok = ajv.validate(id, doc);
  console.log(ok ? 'PASS' : 'FAIL', f); if (!ok) { fail++; console.log(JSON.stringify(ajv.errors, null, 1)); }
}
// negative cases
const neg = [
  ['both sells_for and sells_for_url', { sells_for: [], sells_for_url: 'https://a.example/x' }],
  ['unknown top-level key', { agents: [{ type: 'sales', url: 'https://a.example/mcp' }], properties: [] }],
  ['grant carrying jwks_uri', { authorized_operators: [{ domain: 'a.example', agents: [{ url: 'https://a.example/x', jwks_uri: 'https://a.example/j' }] }] }],
  ['empty record', {}],
  ['http agent url', { agents: [{ type: 'sales', url: 'http://a.example/mcp' }] }],
];
for (const [name, doc] of neg) { const ok = ajv.validate('/schemas/adcp-trust.json', doc); console.log(ok ? 'UNEXPECTED PASS' : 'rejects', name); if (ok) fail++; }
process.exit(fail ? 1 : 0);
