/**
 * adcp#8501 entries 6 and 26: 3.3 adds no property to a schema held closed
 * in 3.x, and removes no existing enum value (DR-0036).
 *
 * - metric_id leaves the performance standards and the
 *   required_performance_standards filter; 4.0 adds it back.
 * - evaluator is back in x-entity-types as a deprecated value.
 */
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..');
const SCHEMA_ROOT = path.join(ROOT, 'static', 'schemas', 'source');
const readSchema = (uri) =>
  JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, uri.replace(/^\/schemas\//, '')), 'utf8'));

async function compile(schema) {
  const ajv = new Ajv({ allErrors: true, strict: false, loadSchema: async (ref) => readSchema(ref) });
  addFormats(ajv);
  return ajv.compileAsync(schema);
}

describe('metric_id on performance standards (entry 6)', () => {
  const VENDOR = { domain: 'verification-vendor.example' };
  const offerFilterItem = () => readSchema('/schemas/core/product-offer-filters.json').properties.required_performance_standards.items;
  const shapes = {
    'core/performance-standard.json': () => readSchema('/schemas/core/performance-standard.json'),
    'core/canonical-performance-standard.json': () => readSchema('/schemas/core/canonical-performance-standard.json'),
    'core/product-offer-filters.json required_performance_standards': offerFilterItem,
  };

  for (const [name, load] of Object.entries(shapes)) {
    it(`${name}: no metric_id property and no guard that names it`, () => {
      const schema = load();
      assert.equal(schema.properties.metric_id, undefined);
      assert.equal(schema.allOf, undefined);
      assert.deepEqual(Object.keys(schema.properties), ['metric', 'threshold', 'standard', 'vendor']);
    });
  }

  it('the canonical standard is closed, so it rejects metric_id', async () => {
    const validate = await compile(readSchema('/schemas/core/canonical-performance-standard.json'));
    assert.equal(validate({ metric: 'ivt', threshold: 0.03, vendor: VENDOR }), true, JSON.stringify(validate.errors));
    assert.equal(validate({ metric: 'ivt', threshold: 0.03, vendor: VENDOR, metric_id: 'givt_rate' }), false);
  });

  it('the performance-standard-metric description no longer refers to metric_id', () => {
    assert.equal(readSchema('/schemas/enums/performance-standard-metric.json').description.includes('metric_id'), false);
  });

  it('required_vendor_metrics keeps its metric_id, which 3.2 published', () => {
    const filters = readSchema('/schemas/core/product-offer-filters.json');
    assert.equal(filters.properties.required_vendor_metrics.items.properties.metric_id.$ref, '/schemas/core/vendor-metric-id.json');
  });

  it('the 4.0 compatibility registry plans it, with an anchor on the 4.0 page', () => {
    const registry = yaml.load(fs.readFileSync(path.join(ROOT, 'static/compliance/source/universal/v4-compatibility.yaml'), 'utf8'));
    const check = registry.checks.find((c) => c.id === 'performance_standard_metric_id_required_in_4_0');
    assert.ok(check, 'registry entry missing');
    assert.equal(check.issue, 8394);
    assert.equal(check.change, 'new_requirement');
    assert.ok(check.observed_by.none, 'a 3.x run cannot observe it');
    const page = fs.readFileSync(path.join(ROOT, 'docs/reference/migration/v4-compatibility.mdx'), 'utf8');
    assert.match(page, /<a id="performance_standard_metric_id_required_in_4_0"><\/a>/);
  });
});

describe('evaluator in x-entity-types (entry 26)', () => {
  const registry = readSchema('/schemas/core/x-entity-types.json');

  it('is an enum value with a definition again', () => {
    assert.ok(registry.enum.includes('evaluator'));
    assert.match(registry['x-entity-definitions'].evaluator, /evaluator_id/);
  });

  it('is listed as deprecated', () => {
    assert.deepEqual(registry['x-deprecated-enum-values'], ['evaluator']);
    assert.match(registry['x-deprecated-enum-values-doc'], /never removed or renamed/);
  });

  it('no schema carries x-entity: evaluator, because evaluator_id stays removed', () => {
    const hits = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.json') && fs.readFileSync(full, 'utf8').includes('"x-entity": "evaluator"')) hits.push(full);
      }
    };
    walk(SCHEMA_ROOT);
    assert.deepEqual(hits, []);
    assert.equal(JSON.stringify(readSchema('/schemas/core/evaluator-spec.json')).includes('evaluator_id'), false);
  });
});
