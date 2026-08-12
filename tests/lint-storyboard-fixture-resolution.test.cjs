'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');
const { lint, lintDoc } = require('../scripts/lint-storyboard-fixture-resolution.cjs');

function rules(source) {
  return lintDoc(yaml.load(source)).map((violation) => violation.rule);
}

test('source tree passes fixture-resolution lint', () => {
  assert.deepEqual(lint(), []);
});

test('legacy fixture blocks remain valid without resolution metadata', () => {
  assert.deepEqual(rules(`
fixtures:
  products:
    - product_id: legacy
      delivery_type: non_guaranteed
`), []);
});

test('valid product and product-scoped pricing discovery passes', () => {
  assert.deepEqual(rules(`
fixtures:
  products:
    - product_id: display
      delivery_type: non_guaranteed
  pricing_options:
    - product_id: display
      pricing_option_id: cpm
      pricing_model: cpm
fixture_resolution:
  products:
    - handle: display
      strategies: [seed, discover]
      match:
        - { path: /delivery_type, operator: equals, value: non_guaranteed }
        - path: /channels
          operator: contains_all
          value: [display]
        - path: /format_options
          operator: any_match
          where:
            - { path: /format_kind, operator: equals, value: image }
  pricing_options:
    - product_handle: display
      handle: cpm
      strategies: [seed, discover]
      match:
        - { path: /pricing_model, operator: equals, value: cpm }
        - { path: /floor_price, operator: present }
`), []);
});

test('dangling and duplicate handles are rejected', () => {
  assert.deepEqual(rules(`
fixtures:
  products:
    - { product_id: real }
fixture_resolution:
  products:
    - { handle: missing, strategies: [seed] }
    - { handle: missing, strategies: [seed] }
`), ['dangling_handle', 'dangling_handle', 'duplicate_handle']);
});

test('discover requires valid non-empty match rules', () => {
  assert.deepEqual(rules(`
fixtures:
  products:
    - { product_id: p }
fixture_resolution:
  products:
    - handle: p
      strategies: [discover]
      match:
        - { path: delivery_type, operator: equals, value: non_guaranteed }
        - { path: /channels, operator: contains_all, value: display }
        - { path: /x, operator: unknown, value: x }
`), ['match_path', 'contains_all_value', 'match_operator']);
});

test('malformed strategy shape is reported without throwing', () => {
  assert.deepEqual(rules(`
fixtures:
  products:
    - { product_id: p }
fixture_resolution:
  products:
    - { handle: p, strategies: 42 }
`), ['strategies']);
});

test('strategy eligibility follows the entity lifecycle contract', () => {
  assert.deepEqual(rules(`
fixtures:
  plans:
    - { plan_id: plan }
fixture_resolution:
  plans:
    - handle: plan
      strategies: [discover, construct]
      match:
        - { path: /plan_id, operator: present }
`), ['discover_unsupported_type', 'construct_unsupported_type']);
});

test('pricing handles are scoped by their parent product', () => {
  assert.deepEqual(rules(`
fixtures:
  pricing_options:
    - { product_id: a, pricing_option_id: cpm }
    - { product_id: b, pricing_option_id: cpm }
fixture_resolution:
  pricing_options:
    - product_handle: a
      handle: cpm
      strategies: [seed]
    - product_handle: b
      handle: cpm
      strategies: [seed]
`), []);
});
