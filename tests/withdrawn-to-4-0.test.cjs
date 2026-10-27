/**
 * Contract test for the 3.3 features withdrawn to 4.0 (adcp#8501).
 *
 * commercial-terms is closed on purpose: a buyer must not be bound by terms it
 * cannot read, and terms_digest signs exactly those terms. A minor release
 * never changes a closed schema (DR-0036), so definition pins, purchase rights
 * and installment selection wait for 4.0, where commercial_terms gets a
 * declared extension point with must-understand. This test fails if any of
 * them returns to a 3.x schema, and checks that the release story and the 4.0
 * registry say where the designs went.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..');
const SCHEMAS = path.join(ROOT, 'static/schemas/source');
const readSchema = (relative) => JSON.parse(fs.readFileSync(path.join(SCHEMAS, relative), 'utf8'));
const readDoc = (relative) => fs.readFileSync(path.join(ROOT, 'docs', relative), 'utf8');
const exists = (relative) => fs.existsSync(path.join(SCHEMAS, relative));

test('commercial-terms stays closed and carries no withdrawn term', () => {
  const terms = readSchema('media-buy/commercial-terms.json');
  assert.equal(terms.additionalProperties, false, 'commercial-terms is closed within 3.x');
  assert.equal(terms.properties.definition_pins, undefined);

  const purchase = readSchema('media-buy/product-purchase.json');
  assert.equal(purchase.properties.rights, undefined, 'purchase rights wait for 4.0');
  assert.equal(purchase.properties.installments, undefined, 'installment selection waits for 4.0');
});

test('the withdrawn schemas, enum values and error code are gone', () => {
  for (const file of [
    'core/definition-pin.json',
    'enums/definition-pin-ref-kind.json',
    'error-details/reference-definition-changed.json',
    'brand/rights-scope.json',
    'core/installment-change-set.json',
  ]) {
    assert.equal(exists(file), false, `${file} is withdrawn`);
  }

  assert.equal(readSchema('enums/error-code.json').enum.includes('REFERENCE_DEFINITION_CHANGED'), false);
  assert.equal(readSchema('enums/proposal-refinement-reason.json').enum.includes('definition_changed'), false);
  const rightUse = readSchema('enums/right-use.json').enum;
  assert.ok(!rightUse.includes('paid_amplification') && !rightUse.includes('content_reuse'));

  const refinement = readSchema('media-buy/proposal-refinement.json');
  assert.equal(refinement.properties.installment_changes, undefined);
  const row = readSchema('media-buy/refine-proposals-response.json').properties.results.items.properties;
  assert.equal(row.drifted_pins, undefined);
  assert.equal(row.unsatisfied_installment_changes, undefined);

  const capabilities = readSchema('protocol/get-adcp-capabilities-response.json');
  const dimensions = capabilities.properties.media_buy.properties.proposal_refinement.properties.supported_dimensions;
  assert.equal(dimensions.items.enum.includes('installment_changes'), false);
});

test('rights-terms keeps its 3.2 shape without the hoisted scope', () => {
  const terms = readSchema('brand/rights-terms.json');
  assert.deepEqual(terms.required, ['pricing_option_id', 'amount', 'currency', 'uses']);
  assert.equal(terms.allOf, undefined);
});

test('installments stay on the canonical product and installment holds stay on the proposal', () => {
  assert.ok(readSchema('core/canonical-product.json').properties.installments);
  assert.ok(exists('core/canonical-installment.json'));
  assert.ok(exists('core/canonical-installment-ref.json'), 'derivative_of still uses the closed reference');
  assert.ok(readSchema('core/canonical-proposal.json').properties.holds);
});

test('the release story says what was withdrawn, from which beta, and why', () => {
  const migration = readDoc('reference/migration/3-2-to-3-3.mdx');
  const whatsNew = readDoc('reference/whats-new-in-3-3.mdx');
  const notes = readDoc('reference/release-notes.mdx');
  const beta = readDoc('reference/3-3-beta.mdx');

  for (const [name, page] of Object.entries({ migration, whatsNew, notes, beta })) {
    assert.match(page, /adcp#8501|issues\/8501/, `${name} cites the decision`);
    assert.match(page, /commercial[-_]terms/, `${name} names the closed schema`);
    assert.match(page, /definition pins/i, `${name} names definition pins`);
    assert.match(page, /purchase rights/i, `${name} names purchase rights`);
    assert.match(page, /installment selection/i, `${name} names installment selection`);
    assert.match(page, /4\.0/, `${name} says the features are planned for 4.0`);
  }
  assert.match(migration, /`3\.3\.0-beta\.0` published seller-authored `commercial_terms\.definition_pins\[\]`/);
  assert.match(notes, /published in `3\.3\.0-beta\.0` and removed in `3\.3\.0-beta\.1`/);
  assert.match(beta, /^## Withdrawn from beta\.1$/m);
});

test('the 4.0 registry and migration page keep the designs', () => {
  const registry = yaml.load(fs.readFileSync(
    path.join(ROOT, 'static/compliance/source/universal/v4-compatibility.yaml'), 'utf8'));
  const migration = readDoc('reference/migration/v4-compatibility.mdx');
  const expected = {
    definition_pins_required_in_4_0: 7660,
    purchase_rights_required_in_4_0: 8090,
    installment_selection_required_in_4_0: 8230,
  };
  for (const [id, issue] of Object.entries(expected)) {
    const check = registry.checks.find((entry) => entry.id === id);
    assert.ok(check, `${id} is registered`);
    assert.equal(check.issue, issue);
    assert.equal(check.observed_by.none !== undefined, true, `${id} is not graded on 3.x`);
    assert.ok(migration.includes(`<a id="${id}"></a>`), `${id} has an anchor`);
  }
  for (const commit of ['9632c4a73', '563f199d1', '0555b8a99']) {
    assert.ok(migration.includes(commit), `${commit} is named as the place the design is preserved`);
  }
});
