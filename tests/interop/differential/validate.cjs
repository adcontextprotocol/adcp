'use strict';

/**
 * Validates a generated scenario the way tests/reporting-subscription-coverage-vectors.test.cjs
 * validates a vector: the input against case.schema.json, and every wire object
 * inside it against the AdCP schemas. A scenario that fails is not a valid
 * buyer input, so the differential run never feeds one to the SDKs.
 */

const fs = require('node:fs');
const path = require('node:path');
const env = require('../lib/env.cjs');

let compiled;

function load() {
  if (compiled) return compiled;
  // ajv from the interop environment, else the repository's own (for the harness self-test).
  let req = env.sdkRequire();
  try {
    req.resolve('ajv-formats');
  } catch {
    req = require;
  }
  const Ajv = req('ajv');
  const addFormats = req('ajv-formats');
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
  walk(path.join(env.ROOT, 'static/schemas/source'));
  const caseSchema = JSON.parse(
    fs.readFileSync(path.join(env.ROOT, 'static/compliance/source/test-vectors/reporting-subscriptions/case.schema.json'), 'utf8'),
  );
  ajv.addSchema(caseSchema, 'interop-case');
  compiled = {
    ajv,
    case: ajv.getSchema('interop-case'),
    input: ajv.compile({ $ref: 'interop-case#/definitions/input' }),
    configuration: ajv.getSchema('/schemas/core/reporting-subscription.json'),
    offering: ajv.getSchema('/schemas/core/reporting-delivery-offering.json'),
    excluded: ajv.compile({ $ref: '/schemas/core/reporting-subscription-coverage.json#/properties/excluded/items' }),
    gap: ajv.compile({ $ref: '/schemas/core/reporting-subscription-coverage.json#/properties/gaps/items' }),
    cutover: ajv.compile({ $ref: '/schemas/core/reporting-subscription-coverage.json#/properties/timezone_cutovers/items' }),
    inactive: ajv.compile({ $ref: '/schemas/core/reporting-subscription-state.json#/properties/inactive_intervals' }),
    flightHistory: ajv.compile({ $ref: '/schemas/core/media-buy.json#/properties/flight_history' }),
  };
  return compiled;
}

/** Schema errors, except an unknown value of an x-extensible enum that matches its x-pattern (receivers MUST accept those). */
function wireErrors(validate, value) {
  if (validate(value)) return [];
  return validate.errors.filter(error => {
    const schema = error.parentSchema;
    return !(error.keyword === 'enum' && schema?.['x-extensible'] === true && new RegExp(schema['x-pattern']).test(error.data));
  });
}

/** Every problem with a scenario input, as strings; empty when it is a valid buyer input. */
function validateInput(input) {
  const v = load();
  const problems = [];
  if (!v.input(input)) problems.push(`input: ${v.ajv.errorsText(v.input.errors)}`);
  const objects = [];
  (input.versions ?? []).forEach((version, i) => objects.push([`versions[${i}].configuration`, v.configuration, version.configuration]));
  (input.offerings ?? []).forEach((offering, i) => objects.push([`offerings[${i}]`, v.offering, offering]));
  (input.buys ?? []).forEach((buy, i) => {
    if (buy.flight_history) objects.push([`buys[${i}].flight_history`, v.flightHistory, buy.flight_history]);
  });
  (input.coverage?.excluded ?? []).forEach((entry, i) => objects.push([`coverage.excluded[${i}]`, v.excluded, entry]));
  (input.coverage?.gaps ?? []).forEach((entry, i) => objects.push([`coverage.gaps[${i}]`, v.gap, entry]));
  (input.coverage?.timezone_cutovers ?? []).forEach((entry, i) => objects.push([`coverage.timezone_cutovers[${i}]`, v.cutover, entry]));
  if (input.inactive_intervals) objects.push(['inactive_intervals', v.inactive, input.inactive_intervals]);
  for (const [where, validate, value] of objects) {
    const errors = wireErrors(validate, value);
    if (errors.length) problems.push(`${where}: ${v.ajv.errorsText(errors)}`);
  }
  return problems;
}

/** Validate a whole candidate case against case.schema.json. */
function validateCase(testCase) {
  const v = load();
  return v.case(testCase) ? [] : [v.ajv.errorsText(v.case.errors)];
}

module.exports = { validateInput, validateCase };
