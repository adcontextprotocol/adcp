'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const ROOT = path.resolve(__dirname, '../..');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

// Same AJV + local-reference approach as server/src/services/protocol-schema-validator.ts,
// but deliberately bound to an immutable release, never source/latest or network fallback.
function artifact(version, root = ROOT) {
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw Error('Expected an exact release');
  const dir = path.join(root, 'dist/schemas', version);
  const prefix = `https://adcontextprotocol.org/schemas/${version}/`;
  const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: true });
  addFormats(ajv);
  const files = new Map();
  function load(relative) {
    if (relative.includes('..') || path.isAbsolute(relative) || !relative.endsWith('.json')) throw Error(`Unsafe schema path: ${relative}`);
    if (!files.has(relative)) {
      const bytes = fs.readFileSync(path.join(dir, relative));
      files.set(relative, { bytes, schema: JSON.parse(bytes) });
    }
    return files.get(relative).schema;
  }
  function resolve(ref, base) {
    let url;
    if (ref.startsWith('/schemas/')) url = `https://adcontextprotocol.org${ref}`;
    else url = new URL(ref, prefix + base).href;
    if (!url.startsWith(prefix)) throw Error(`Reference outside selected release: ${ref}`);
    const [relative, fragment = ''] = url.slice(prefix.length).split('#');
    const decoded = decodeURIComponent(relative);
    let schema = load(decoded);
    if (fragment) {
      if (!fragment.startsWith('/')) throw Error(`Unsupported schema anchor: ${fragment}`);
      for (const part of fragment.slice(1).split('/')) {
        schema = schema?.[decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~')];
      }
      if (schema === undefined) throw Error(`Missing schema pointer: ${ref}`);
    }
    return { schema, base: decoded };
  }
  const registered = new Set();
  function register(relative) {
    if (registered.has(relative)) return;
    registered.add(relative);
    const schema = load(relative);
    ajv.addSchema(schema, prefix + relative);
    function visit(node) {
      if (!node || typeof node !== 'object') return;
      if (typeof node.$ref === 'string') register(resolve(node.$ref, relative).base);
      for (const value of Object.values(node)) if (typeof value === 'object') visit(value);
    }
    visit(schema);
  }
  function validate(relative, value) {
    register(relative);
    const check = ajv.getSchema(prefix + relative);
    return check(value) ? [] : structuredClone(check.errors);
  }
  // Hash the canonical artifact only; projected/historical copies are not tools.
  function walk(relative = '') {
    for (const entry of fs.readdirSync(path.join(dir, relative), { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory() && !['mcp', 'bundled'].includes(entry.name)) walk(name);
      else if (entry.isFile() && name.endsWith('.json')) load(name);
    }
  }
  walk();
  const digest = sha256([...files].sort(([a],[b]) => a.localeCompare(b)).map(([name, { bytes }]) => `${name}\0${sha256(bytes)}\n`).join(''));
  return { version, load, resolve, validate, digest, manifest: load('manifest.json') };
}

// A bounded fixture generator, not a constraint solver. Unsupported patterns,
// conditional branches and unvisited union arms stay visible in the plan.
function generate(art, relative, overrides = {}) {
  const choices = [];
  function make(schema, base, pointer, depth = 0) {
    if (depth > 24) throw Error(`Recursive fixture at ${pointer}`);
    if (schema === false) throw Error(`Unsatisfiable branch at ${pointer}`);
    if (schema === true) return null;
    if (schema.$ref) {
      const target = art.resolve(schema.$ref, base);
      return make(target.schema, target.base, `${target.base}#`, depth + 1);
    }
    if ('const' in schema) return schema.const;
    if (schema.enum) return schema.enum[0];
    const union = schema.oneOf || schema.anyOf;
    if (union) {
      const errors = [];
      for (let index = 0; index < union.length; index++) {
        try {
          const value = make({ ...schema, oneOf: undefined, anyOf: undefined, ...union[index] }, base, `${pointer}/${schema.oneOf ? 'oneOf' : 'anyOf'}/${index}`, depth + 1);
          choices.push({ pointer, keyword: schema.oneOf ? 'oneOf' : 'anyOf', selected: index, unvisited: union.map((_,i) => i).filter(i => i !== index) });
          return value;
        } catch (error) { errors.push(error.message); }
      }
      throw Error(errors.join('; '));
    }
    if (schema.if || schema.not || schema.dependencies) choices.push({ pointer, keyword: 'constraints', reason: 'Validated afterward; alternative satisfying assignments are not searched' });
    const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
    if (type === 'object' || schema.properties || schema.required || schema.allOf) {
      const value = {};
      for (const key of schema.required || []) {
        if (!schema.properties?.[key]) throw Error(`Required property without local shape: ${pointer}/${key}`);
        value[key] = make(schema.properties[key], base, `${pointer}/properties/${key}`, depth + 1);
      }
      for (const [i, branch] of (schema.allOf || []).entries()) {
        const part = make(branch, base, `${pointer}/allOf/${i}`, depth + 1);
        if (part && typeof part === 'object' && !Array.isArray(part)) Object.assign(value, part);
      }
      return value;
    }
    if (type === 'array') return Array.from({ length: schema.minItems || 0 }, () => make(schema.items || {}, base, `${pointer}/items`, depth + 1));
    if (type === 'boolean') return false;
    if (type === 'null') return null;
    if (type === 'number' || type === 'integer') return Math.max(schema.minimum ?? 0, (schema.exclusiveMinimum ?? -1) + 1);
    if (type === 'string') {
      const formats = { uri: 'https://acme.example/', 'uri-reference': 'https://acme.example/', 'date-time': '2030-01-01T00:00:00Z', date: '2030-01-01', email: 'buyer@acme.example', uuid: '11111111-1111-4111-8111-111111111111', hostname: 'acme.example' };
      return formats[schema.format] || 'x'.repeat(Math.max(1, schema.minLength || 0));
    }
    return {};
  }
  try {
    const request = { ...make(art.load(relative), relative, '#'), ...overrides };
    const errors = art.validate(relative, request);
    return errors.length ? { status: 'unsupported', reason: 'Generated candidate fails schema; needs a fixture override', errors, choices } : { status: 'valid', request, choices };
  } catch (error) { return { status: 'unsupported', reason: error.message, choices }; }
}

function prepare(version) {
  const art = artifact(version);
  const wireSelector = version.replace(/^(\d+\.\d+)\.\d+/, '$1');
  const inventory = Object.entries(art.manifest.tools).map(([tool, entry]) => ({
    tool, request_schema: entry.request_schema, response_schema: entry.response_schema,
    generation: generate(art, entry.request_schema, { adcp_version: wireSelector, ...(tool === 'get_products' && { buying_mode: 'wholesale' }) }),
    fixture: ['get_products', 'list_products'].includes(tool) ? 'catalog' : 'unimplemented: no business/state fixture',
  }));
  const catalog = inventory.filter(row => row.fixture === 'catalog' && row.generation.status === 'valid').map(row => ({ id: `catalog:${row.tool}`, tool: row.tool, kind: 'catalog', request: row.generation.request }));
  const get = catalog.find(row => row.tool === 'get_products');
  if (!get) throw Error('Cannot generate catalog request');
  const vocabulary = art.load('enums/error-code.json');
  const errors = vocabulary.enum.map(code => { const meta = vocabulary.enumMetadata[code]; return ({ id: `default:${code}`, tool: 'get_products', kind: 'error', code, expected_recovery: meta.recovery, request: get.request }); });
  for (const recovery of ['transient', 'correctable', 'terminal']) errors.push({ id: `override:${recovery}`, tool: 'get_products', kind: 'error', code: 'X_ACME_FIXTURE', recovery, expected_recovery: recovery, request: get.request });
  return { format: 1, protocol: { version, wire_selector: wireSelector, sha256: art.digest, manifest: `dist/schemas/${version}/manifest.json` }, inventory, cases: [...catalog, ...errors] };
}

function assess(plan, run, root = ROOT) {
  const selected = artifact(plan.protocol.version, root);
  if (selected.digest !== plan.protocol.sha256) throw Error('Protocol artifact changed after preparation');
  const contracts = new Map([[plan.protocol.version, selected], [plan.protocol.wire_selector, selected]]);
  const results = [];
  const rawById = new Map();
  for (const row of run.observations) {
    if (rawById.has(row.id)) throw Error(`Duplicate observation: ${row.id}`);
    rawById.set(row.id, row);
  }
  const advertised = new Set(run.advertised_tools);
  const knownCases = new Set(plan.cases.map(row => row.id));
  for (const id of rawById.keys()) if (!knownCases.has(id)) throw Error(`Unexpected observation: ${id}`);
  for (const probe of plan.cases) {
    const row = rawById.get(probe.id);
    const result = { id: probe.id, tool: probe.tool, requested_version: probe.request.adcp_version, served_version: null, routing: 'not-dispatched', schema: 'not-checked', semantics: 'not-checked', workflow: 'not-tested', findings: [] };
    results.push(result);
    if (!row || row.skip) { result.skip = row?.skip || 'Missing driver observation'; if (!row) result.findings.push('missing-observation'); continue; }
    if (!advertised.has(probe.tool)) result.findings.push('tool-not-advertised');
    result.routing = row.handler_called ? 'handler-reached' : 'handler-not-reached';
    if (!row.handler_called) result.findings.push('handler-not-reached');
    if (row.transport_error) { result.schema = 'transport-failure'; result.findings.push('transport-failure'); continue; }
    if (row.sdk_response_validation_error) { result.sdk_response_validation_error = row.sdk_response_validation_error; result.findings.push('sdk-response-validation-error'); }
    const wire = row.result;
    const payload = wire?.structuredContent;
    if (!wire || !Array.isArray(wire.content) || wire.content.some(item => !item || typeof item.type !== 'string' || (item.type === 'text' && typeof item.text !== 'string')) || (wire.isError !== undefined && typeof wire.isError !== 'boolean') || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
      result.schema = 'invalid'; result.findings.push('missing-mcp-envelope'); continue;
    }
    const served = payload.adcp_version || row.handler_served_version || null;
    result.served_version = served;
    result.version_evidence = payload.adcp_version ? 'wire' : row.handler_served_version ? 'sdk-handler-context' : 'absent';
    if (payload.adcp_version && row.handler_served_version && payload.adcp_version !== row.handler_served_version) result.findings.push('conflicting-served-version');
    let contract = selected;
    if (served) {
      try { if (!contracts.has(served)) contracts.set(served, artifact(served, root)); contract = contracts.get(served); } catch { result.findings.push('served-contract-unavailable'); }
      if (served !== probe.request.adcp_version && served !== plan.protocol.version) result.findings.push('served-version-mismatch');
    } else result.findings.push('served-version-unresolved');
    result.validation_contract = { version: contract.version, sha256: contract.digest, provisional: !served || (contract.version !== served && served !== plan.protocol.wire_selector) };
    const error = payload.adcp_error;
    const domainErrors = payload.errors;
    const fatal = wire.isError === true || !!error || (Array.isArray(domainErrors) && domainErrors.length > 0 && payload.status === 'failed');
    let schemaErrors = [];
    if (fatal || probe.kind === 'error') {
      result.response_kind = wire.isError ? 'mcp-tool-error' : 'domain-error';
      const emitted = error ? [error, ...(Array.isArray(domainErrors) ? domainErrors : [])] : domainErrors;
      if (domainErrors !== undefined && !Array.isArray(domainErrors)) schemaErrors.push({ message: 'errors must be an array' });
      if (error && wire.isError !== true) result.findings.push('transport-error-flag-missing');
      if (wire.isError && !error) result.findings.push('missing-transport-adcp-error');
      if (!Array.isArray(emitted) || emitted.length === 0) schemaErrors.push({ message: 'No structured error produced' });
      else for (const item of emitted) schemaErrors.push(...contract.validate('core/error.json', item));
      // Domain error payloads have their own task envelope; never validate a
      // transport adcp_error wrapper as a successful catalog response.
      if (!wire.isError && !error) schemaErrors.push(...contract.validate(contract.manifest.tools[probe.tool].response_schema, payload));
      const actual = error || domainErrors?.[0];
      result.observed_error = actual;
      const expected = probe.recovery || contract.load('enums/error-code.json').enumMetadata?.[probe.code]?.recovery;
      result.semantics = actual?.code === probe.code && actual?.recovery === expected ? 'passed' : 'failed';
      if (result.semantics === 'failed') result.findings.push('error-code-or-recovery-mismatch');
      if (probe.kind === 'catalog') result.findings.push('catalog-returned-error');
    } else {
      result.response_kind = 'task-payload';
      const entry = contract.manifest.tools[probe.tool];
      if (!entry) schemaErrors.push({ message: 'Tool absent from served manifest' });
      else schemaErrors.push(...contract.validate(entry.response_schema, payload));
      result.semantics = Array.isArray(payload.products) && payload.products.length === 0 && (contract.version.startsWith('3.0.') || payload.cache_scope === 'public') ? 'passed' : 'failed';
      if (result.semantics === 'failed') result.findings.push('catalog-fixture-mismatch');
      result.workflow = 'empty-catalog-fixture-only';
    }
    result.schema = schemaErrors.length ? 'invalid' : 'valid';
    if (schemaErrors.length) { result.schema_errors = schemaErrors; result.findings.push('schema-invalid'); }
  }
  const inventory = plan.inventory.map(row => ({ tool: row.tool, advertised: advertised.has(row.tool), fixture: row.fixture, generation: row.generation.status, reason: row.generation.reason, choices: row.generation.choices }));
  for (const tool of advertised) if (!plan.inventory.some(row => row.tool === tool)) inventory.push({ tool, advertised: true, fixture: 'outside-selected-manifest' });
  const failures = results.filter(row => row.findings.length).length;
  const skipped = results.filter(row => row.skip).length;
  return { sdk: run.sdk, protocol: plan.protocol, transport: run.transport, inventory, results,
    summary: { cases: results.length, dispatched: results.length - skipped, skipped, cases_with_findings: failures, schema_valid: results.filter(row => row.schema === 'valid').length, schema_invalid: results.filter(row => row.schema === 'invalid').length, semantics_passed: results.filter(row => row.semantics === 'passed').length, manifest_tools: plan.inventory.length, advertised_tools: advertised.size, tools_with_fixtures: new Set(plan.cases.map(row => row.tool)).size, tools_without_fixtures: plan.inventory.filter(row => row.fixture !== 'catalog').length, unsupported_request_generation: plan.inventory.filter(row => row.generation.status !== 'valid').length, union_alternatives_not_selected: plan.inventory.flatMap(row => row.generation.choices).reduce((count, row) => count + (row.unvisited?.length || 0), 0), optional_request_branches: 'not-generated; outside minimal required-property fixtures', workflow_completion: 'not-tested', status: failures ? 'findings' : skipped ? 'incomplete' : 'covered-fixtures-pass' } };
}
module.exports = { artifact, generate, prepare, assess, ROOT };
