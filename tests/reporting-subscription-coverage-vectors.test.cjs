'use strict';

/**
 * Replays static/compliance/source/test-vectors/reporting-subscriptions/
 * vectors.json (experimental media_buy.reporting_subscriptions coverage)
 * through the brute-force reference model in scripts/reference/reporting-coverage,
 * and checks the vectors themselves: each case against case.schema.json, the
 * wire objects inside each input against the AdCP schemas, the tzdata pin, and
 * the model's time zone evaluator against zic(8) output for the pinned release.
 * It also checks the frozen vocabularies beside the vectors, error-codes.json and
 * reason-codes.json, against the case schema and the reference model.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const ROOT = path.resolve(__dirname, '..');
const SET = path.join(ROOT, 'static/compliance/source/test-vectors/reporting-subscriptions');
const REFERENCE = path.join(ROOT, 'scripts/reference/reporting-coverage');
const vectors = JSON.parse(fs.readFileSync(path.join(SET, 'vectors.json'), 'utf8'));
const caseSchema = JSON.parse(fs.readFileSync(path.join(SET, 'case.schema.json'), 'utf8'));
const errorCodes = JSON.parse(fs.readFileSync(path.join(SET, 'error-codes.json'), 'utf8'));
const reasonCodes = JSON.parse(fs.readFileSync(path.join(SET, 'reason-codes.json'), 'utf8'));
const tzdata = JSON.parse(fs.readFileSync(path.join(REFERENCE, 'tzdata.json'), 'utf8'));
const tz = require(path.join(REFERENCE, 'tz.cjs'));
const { expectedSubscriptionPeriods, instant } = require(path.join(REFERENCE, 'coverage.cjs'));

function loadAjv() {
  const ajv = new Ajv({ allErrors: true, strict: false, verbose: true });
  addFormats(ajv);
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.json')) {
        const schema = JSON.parse(fs.readFileSync(full, 'utf8'));
        if (schema.$id && !ajv.getSchema(schema.$id)) ajv.addSchema(schema);
      }
    }
  };
  walk(path.join(ROOT, 'static/schemas/source'));
  return ajv;
}

const ajv = loadAjv();
const validateCase = ajv.compile(caseSchema);
const wire = {
  configuration: ajv.getSchema('/schemas/core/reporting-subscription.json'),
  offering: ajv.getSchema('/schemas/core/reporting-delivery-offering.json'),
  excluded: ajv.compile({ $ref: '/schemas/core/reporting-subscription-coverage.json#/properties/excluded/items' }),
  gap: ajv.compile({ $ref: '/schemas/core/reporting-subscription-coverage.json#/properties/gaps/items' }),
  cutover: ajv.compile({ $ref: '/schemas/core/reporting-subscription-coverage.json#/properties/timezone_cutovers/items' }),
  inactive: ajv.compile({ $ref: '/schemas/core/reporting-subscription-state.json#/properties/inactive_intervals' }),
};

/** Every wire object in a case's input, with its validator. */
function wireObjects(input) {
  const out = [];
  input.versions.forEach((version, index) => out.push([`versions[${index}].configuration`, wire.configuration, version.configuration]));
  input.offerings.forEach((offering, index) => {
    const { available_from: _from, withdrawn_at: _until, ...published } = offering;
    out.push([`offerings[${index}]`, wire.offering, published]);
  });
  (input.coverage?.excluded ?? []).forEach((entry, index) => out.push([`coverage.excluded[${index}]`, wire.excluded, entry]));
  (input.coverage?.gaps ?? []).forEach((entry, index) => out.push([`coverage.gaps[${index}]`, wire.gap, entry]));
  (input.coverage?.timezone_cutovers ?? []).forEach((entry, index) => out.push([`coverage.timezone_cutovers[${index}]`, wire.cutover, entry]));
  if (input.inactive_intervals) out.push(['inactive_intervals', wire.inactive, input.inactive_intervals]);
  return out;
}

test('vectors record the pinned tzdata release the reference model carries', () => {
  assert.equal(vectors.feature, 'media_buy.reporting_subscriptions');
  assert.equal(vectors.tzdata.version, tzdata.version);
  assert.equal(vectors.tzdata.source, tzdata.source);
  assert.equal(vectors.tzdata.source_sha512, tzdata.source_sha512);
  assert.match(tzdata.source_sha512, /^[0-9a-f]{128}$/);
});

test('every case validates against case.schema.json and has a unique id', () => {
  const ids = new Set();
  for (const vector of vectors.cases) {
    assert.ok(validateCase(vector), `${vector.id}: ${ajv.errorsText(validateCase.errors)}`);
    assert.ok(!ids.has(vector.id), `duplicate id ${vector.id}`);
    ids.add(vector.id);
  }
});

test('spec_refs name files that exist', () => {
  for (const vector of vectors.cases) {
    for (const ref of vector.spec_refs) {
      const file = ref.split('#')[0];
      assert.ok(fs.existsSync(path.join(ROOT, file)), `${vector.id}: ${file} does not exist`);
    }
  }
});

/**
 * Schema errors, except an unknown value of an x-extensible enum that matches
 * its x-pattern: reporting-dimension.json says receivers MUST accept those.
 */
function wireErrors(validate, value) {
  if (validate(value)) return [];
  return validate.errors.filter(error => {
    const schema = error.parentSchema;
    return !(error.keyword === 'enum' && schema?.['x-extensible'] === true && new RegExp(schema['x-pattern']).test(error.data));
  });
}

test('wire objects in each input validate against the AdCP schemas', () => {
  for (const vector of vectors.cases) {
    const failures = wireObjects(vector.input)
      .map(([where, validate, value]) => [where, wireErrors(validate, value)])
      .filter(([, errors]) => errors.length > 0)
      .map(([where, errors]) => `${where}: ${ajv.errorsText(errors)}`);
    if (vector.expected_error?.wire_valid === false) {
      assert.ok(failures.length > 0, `${vector.id}: expected_error.wire_valid is false but every wire object validates`);
    } else {
      assert.deepEqual(failures, [], `${vector.id}: ${failures.join('; ')}`);
    }
  }
});

test('non_wire_inputs lists exactly the non-wire fields a case uses', () => {
  for (const vector of vectors.cases) {
    const used = [];
    if (vector.input.buys.some(buy => buy.prior_flights !== undefined)) used.push('buys[].prior_flights');
    if (vector.input.offerings.some(o => o.available_from !== undefined || o.withdrawn_at !== undefined)) used.push('offerings[].available_from/withdrawn_at');
    assert.deepEqual(vector.non_wire_inputs ?? [], used, vector.id);
  }
});

for (const vector of vectors.cases) {
  test(`reference model reproduces ${vector.id}`, () => {
    if (vector.expected_error) {
      assert.throws(
        () => expectedSubscriptionPeriods(vector.input),
        error => error.code === vector.expected_error.code && error.detail === vector.expected_error.detail,
      );
      return;
    }
    const result = expectedSubscriptionPeriods(vector.input);
    assert.deepEqual(result.expected, vector.expected);
    assert.deepEqual(result.expected_obligations, vector.expected_obligations);
    assert.deepEqual(result.timezones, vector.timezones);
  });
}

// ---------------------------------------------------------------------------
// Frozen vocabularies
// ---------------------------------------------------------------------------

const sorted = list => [...list].sort();
const specFileExists = ref => fs.existsSync(path.join(ROOT, ref.split('#')[0]));

test('error-codes.json is well formed and its codes are unique', () => {
  const seen = new Set();
  for (const entry of errorCodes.codes) {
    assert.match(entry.code, /^[A-Z][A-Z0-9_]*$/, entry.code);
    assert.ok(!seen.has(entry.code), `duplicate ${entry.code}`);
    seen.add(entry.code);
    assert.ok(['transient', 'correctable', 'terminal'].includes(entry.recovery), `${entry.code}: recovery`);
    assert.ok(entry.dispatched in errorCodes.dispatched_values, `${entry.code}: dispatched`);
    assert.ok(['buyer', 'seller', 'both'].includes(entry.raised_by), `${entry.code}: raised_by`);
    assert.ok(entry.raised_when && entry.message_fix, `${entry.code}: raised_when and message_fix`);
    assert.ok(entry.sdk_classes?.typescript && entry.sdk_classes?.python, `${entry.code}: sdk_classes`);
    for (const detail of Object.keys(entry.details ?? {})) assert.match(detail, /^[a-z][a-z0-9_]*$/, `${entry.code}: ${detail}`);
    for (const ref of entry.spec_refs) assert.ok(specFileExists(ref), `${entry.code}: ${ref} does not exist`);
  }
});

test('the case schema carries the frozen error and reason vocabularies', () => {
  const coverage = errorCodes.codes.filter(entry => entry.code.startsWith('COVERAGE_INPUT_'));
  assert.deepEqual(sorted(caseSchema.definitions.error_code.enum), sorted(errorCodes.codes.map(entry => entry.code)));
  assert.deepEqual(sorted(caseSchema.properties.expected_error.properties.code.enum), sorted(coverage.map(entry => entry.code)));
  assert.deepEqual(sorted(caseSchema.definitions.coverage_input_error_detail.enum), sorted(coverage.flatMap(entry => Object.keys(entry.details))));
  assert.deepEqual(caseSchema.definitions.coverage_reason.enum, reasonCodes.reasons.map(reason => reason.code));
  assert.deepEqual(caseSchema.definitions.coverage_rule.enum, reasonCodes.rule_order);
});

test('every coverage input error the reference model raises is a frozen code and detail', () => {
  const coverage = new Map(errorCodes.codes.filter(entry => entry.code.startsWith('COVERAGE_INPUT_')).map(entry => [entry.code, entry]));
  const { CoverageInputError } = require(path.join(REFERENCE, 'calendar.cjs'));
  for (const file of fs.readdirSync(REFERENCE).filter(name => name.endsWith('.cjs'))) {
    const source = fs.readFileSync(path.join(REFERENCE, file), 'utf8');
    for (const [, detail] of source.matchAll(/new CoverageInputError\('([a-z_]+)'/g)) {
      const error = new CoverageInputError(detail, 'probe');
      assert.ok(coverage.get(error.code)?.details?.[detail], `${file}: ${error.code} / ${detail} is not in error-codes.json`);
      assert.equal(error.recovery, coverage.get(error.code).recovery);
    }
  }
});

test('reason-codes.json is well formed: unique codes, known rules, one owed default', () => {
  const seen = new Set();
  assert.deepEqual(sorted(Object.keys(reasonCodes.rules)), sorted(reasonCodes.rule_order));
  for (const reason of reasonCodes.reasons) {
    assert.match(reason.code, /^[a-z][a-z_]*(?::[a-z][a-z_]*)?$/, reason.code);
    assert.ok(!seen.has(reason.code), `duplicate ${reason.code}`);
    seen.add(reason.code);
    assert.ok(['owed', 'not_owed'].includes(reason.verdict), `${reason.code}: verdict`);
    assert.ok(reason.rule === null || reasonCodes.rule_order.includes(reason.rule), `${reason.code}: rule`);
    assert.ok(['both', 'seller'].includes(reason.side), `${reason.code}: side`);
    assert.ok(reason.definition, `${reason.code}: definition`);
    for (const ref of reason.spec_refs) assert.ok(specFileExists(ref), `${reason.code}: ${ref} does not exist`);
    if (reason.verdict === 'owed') assert.equal(reason.rule, null, `${reason.code}: owed reasons follow every rule`);
  }
  // Every rule can reject a period, and each excluded:<reason> code is a wire exclusion reason.
  for (const rule of reasonCodes.rule_order.filter(rule => rule !== 'timezone')) {
    assert.ok(reasonCodes.reasons.some(reason => reason.rule === rule), `rule ${rule} has no reason`);
  }
  const wireReasons = JSON.parse(fs.readFileSync(path.join(ROOT, 'static/schemas/source/core/reporting-subscription-coverage.json'), 'utf8'))
    .definitions.ReportingSubscriptionExclusionReason.enum;
  assert.deepEqual(sorted(reasonCodes.reasons.filter(r => r.code.startsWith('excluded:')).map(r => r.code.slice('excluded:'.length))), sorted(wireReasons));
  const gapReasons = JSON.parse(fs.readFileSync(path.join(ROOT, 'static/schemas/source/core/reporting-subscription-coverage.json'), 'utf8'))
    .properties.gaps.items.properties.reason.enum;
  assert.deepEqual(sorted(reasonCodes.reasons.filter(r => r.code.startsWith('gap:')).map(r => r.code.slice('gap:'.length))), sorted(gapReasons));
});

test('the time zone evaluator matches zic for the pinned release', () => {
  const [from, to] = tzdata.zic_transitions.range;
  const start = Date.UTC(from, 0, 1);
  const end = Date.UTC(to, 0, 1);
  for (const [zone, { initial, changes }] of Object.entries(tzdata.zic_transitions.zones)) {
    assert.equal(tz.offsetAt(zone, start) / 1000, initial, `${zone} at ${from}-01-01`);
    const zic = changes.map(([at, offset]) => [Date.parse(at), offset]);
    for (const [at, offset] of zic) {
      assert.equal(tz.offsetAt(zone, at) / 1000, offset, `${zone} at ${new Date(at).toISOString()}`);
    }
    const own = tz.transitions(zone).filter(entry => entry.at > start && entry.at < end).map(entry => [entry.at, entry.offset / 1000]);
    assert.deepEqual(own, zic, `${zone}: transitions differ from zic`);
  }
});

test('the host time zone database agrees with the pinned release around every case', t => {
  // A different tzdata release may legitimately differ, so only the pinned release fails the test.
  const host = process.versions.tz;
  const mismatches = [];
  for (const vector of vectors.cases) {
    if (!vector.timezones?.length) continue;
    const instants = [];
    const visit = value => {
      if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) instants.push(instant(value, 'scan'));
      else if (value && typeof value === 'object') Object.values(value).forEach(visit);
    };
    visit(vector.input);
    visit(vector.expected);
    const lo = Math.min(...instants) - 3 * tz.DAY;
    const hi = Math.max(...instants) + 3 * tz.DAY;
    for (const zone of vector.timezones) {
      const format = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' });
      for (let at = lo; at <= hi; at += 900_000) {
        const name = format.formatToParts(at).find(part => part.type === 'timeZoneName').value;
        const m = /GMT(?:([+-])(\d{2}):(\d{2}))?/.exec(name);
        const hostOffset = m[1] ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000 : 0;
        if (hostOffset !== tz.offsetAt(zone, at)) {
          mismatches.push(`${vector.id}: ${zone} at ${new Date(at).toISOString()}`);
          break;
        }
      }
    }
  }
  if (mismatches.length > 0 && host !== tzdata.version) {
    t.diagnostic(`host tzdata ${host} differs from pinned ${tzdata.version}: ${mismatches.join(', ')}`);
    return;
  }
  assert.deepEqual(mismatches, []);
});
