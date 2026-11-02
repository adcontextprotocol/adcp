'use strict';

/**
 * Replays static/compliance/source/test-vectors/collection-copies/vectors.json
 * through a reference grader for experimental collection copies (#8183):
 * the buyer's merged view of a seller copy and adagents.json (shared by
 * include_collections and list_collections), list_collections seller
 * responses, collection card webhook payloads, and card mirror application.
 *
 * The grader in tests/helpers/collection-copies-grader.cjs is the reference:
 * implementers port it, not the prose. The training agent's collection tests
 * grade the agent's real outputs with the same module.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  CATALOG_FEATURE,
  validate,
  languageMatches,
  belowVersion,
  mergedView: gradeMergedView,
  gradeResponse: gradeSellerResponse,
  gradeWebhook,
  applyEvents,
} = require('./helpers/collection-copies-grader.cjs');

const ROOT = path.resolve(__dirname, '..');
const vectors = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'static/compliance/source/test-vectors/collection-copies/vectors.json'), 'utf8'),
);
/** A vector's own declarations, seller_authorized or seller_catalog, else the shared fixture. */
const withFixtures = vector => ({ ...vectors.fixtures, ...vector });

const mergedView = input => gradeMergedView(withFixtures(input));
const gradeResponse = input => gradeSellerResponse(withFixtures(input));

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

test('vector file is well formed', () => {
  assert.equal(vectors.feature, CATALOG_FEATURE);
  assert.equal(vectors.status, 'experimental');
  const ids = new Set();
  for (const list of ['merge_vectors', 'response_vectors', 'webhook_vectors', 'mirror_vectors']) {
    assert.ok(vectors[list].length > 0, list);
    for (const v of vectors[list]) {
      assert.ok(!ids.has(v.id), `duplicate id ${v.id}`);
      ids.add(v.id);
      for (const code of v.expected.violations || []) assert.ok(code in vectors.violation_codes, `${v.id}: ${code}`);
    }
  }
  const used = new Set(['response_vectors', 'webhook_vectors'].flatMap(l => vectors[l].flatMap(v => v.expected.violations)));
  for (const code of Object.keys(vectors.violation_codes)) assert.ok(used.has(code), `no vector exercises ${code}`);
});

test('merge vector inputs are valid declarations and copies', () => {
  for (const input of vectors.merge_vectors) {
    const v = withFixtures(input);
    for (const list of Object.values(v.declarations)) {
      for (const c of list) assert.ok(validate.collection(c), `${v.id}: ${JSON.stringify(validate.collection.errors)}`);
    }
    for (const s of v.seller_authorized) assert.ok(validate.selector(s), v.id);
    for (const c of v.copies) assert.ok(validate.copy(c), `${v.id}: ${JSON.stringify(validate.copy.errors)}`);
    for (const card of v.expected.cards) {
      if (card.effective) assert.ok(validate.copy(card.effective), `${v.id}: effective is copy-shaped`);
    }
  }
});

for (const v of vectors.merge_vectors) {
  test(`merge ${v.id}`, () => {
    assert.deepEqual(mergedView(v), v.expected.cards);
  });
}

for (const v of vectors.response_vectors) {
  test(`response ${v.id}`, () => {
    for (const entry of withFixtures(v).seller_catalog) assert.ok(validate.copy(entry.card), v.id);
    assert.deepEqual(gradeResponse(v).sort(), [...v.expected.violations].sort());
  });
}

for (const v of vectors.webhook_vectors) {
  test(`webhook ${v.id}`, () => {
    assert.deepEqual(gradeWebhook(v).sort(), [...v.expected.violations].sort());
  });
}

for (const v of vectors.mirror_vectors) {
  test(`mirror ${v.id}`, () => {
    for (const { webhook } of v.events) {
      assert.ok(validate.webhook(webhook), `${v.id}: ${JSON.stringify(validate.webhook.errors)}`);
    }
    for (const c of v.mirror.cards) assert.ok(validate.copy(c), v.id);
    const result = applyEvents(v);
    assert.deepEqual(result, v.expected);
    if (result.verdict === 'repair_conditional') {
      // The webhook's post-change version is never the conditional token for a stale mirror.
      const unapplied = v.events.map(e => e.webhook.wholesale_feed_version).filter(ver => ver !== result.mirror.version);
      assert.ok(!unapplied.includes(result.repair_token), `${v.id}: repair token is a webhook version`);
    }
  });
}

test('schema-invalid vectors fail only on schema', () => {
  for (const v of [...vectors.response_vectors, ...vectors.webhook_vectors]) {
    if (v.expected.violations.includes('schema_invalid')) assert.deepEqual(v.expected.violations, ['schema_invalid'], v.id);
  }
});

test('language ranges follow RFC 4647 basic filtering', () => {
  assert.equal(languageMatches('en', 'en-GB'), true);
  assert.equal(languageMatches('EN', 'en'), true);
  assert.equal(languageMatches('en-US', 'en'), false);
  assert.equal(languageMatches('en', 'eng'), false);
});

test('version comparison is by major and minor', () => {
  assert.equal(belowVersion('3.2', '3.3'), true);
  assert.equal(belowVersion('3.3', '3.3'), false);
  assert.equal(belowVersion('3.3-beta.1', '3.3'), false);
  assert.equal(belowVersion('3.10', '3.3'), false);
});
