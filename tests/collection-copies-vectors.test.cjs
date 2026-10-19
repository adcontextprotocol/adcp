'use strict';

/**
 * Replays static/compliance/source/test-vectors/collection-copies/vectors.json
 * through a reference grader for experimental collection copies (#8183):
 * the buyer's merged view of a seller copy and adagents.json (shared by
 * include_collections and list_collections), list_collections seller
 * responses, collection card webhook payloads, and card mirror application.
 *
 * The grader below is the reference: implementers port it, not the prose.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const ROOT = path.resolve(__dirname, '..');
const SCHEMAS = path.join(ROOT, 'static/schemas/source');
const vectors = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'static/compliance/source/test-vectors/collection-copies/vectors.json'), 'utf8'),
);
/** A vector's own declarations, seller_authorized or seller_catalog, else the shared fixture. */
const withFixtures = vector => ({ ...vectors.fixtures, ...vector });

function loadSchemas() {
  const ajv = new Ajv({ allErrors: true, strict: false });
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
  walk(SCHEMAS);
  return ajv;
}

const ajv = loadSchemas();
const validate = {
  collection: ajv.getSchema('/schemas/core/collection.json'),
  copy: ajv.getSchema('/schemas/core/response-collection.json'),
  selector: ajv.getSchema('/schemas/core/collection-selector.json'),
  request: ajv.getSchema('/schemas/media-buy/list-collections-request.json'),
  response: ajv.getSchema('/schemas/media-buy/list-collections-response.json'),
  error: ajv.getSchema('/schemas/core/error.json'),
  webhook: ajv.getSchema('/schemas/core/wholesale-feed-webhook.json'),
};

// ---------------------------------------------------------------------------
// Reference grader
// ---------------------------------------------------------------------------

const CATALOG_FEATURE = 'media_buy.collection_catalog';
const CARDS_FEATURE = 'media_buy.collection_cards';
const CLOSED_LIST = ['images', 'sample_content', 'url', 'description', 'season', 'cadence'];
const CARD_EVENTS = new Set(['collection_card.updated', 'collection_card.removed', 'collection_catalog.bulk_change']);

const clone = value => JSON.parse(JSON.stringify(value));
const keyOf = c => `${c.publisher_domain}\u0000${c.collection_id}`;

/** Canonical JSON with sorted object keys, for equality and scope comparison. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function belowVersion(version, floor) {
  if (!version) return false;
  const parse = v => v.split('-')[0].split('.').map(Number);
  const [a, b] = [parse(version), parse(floor)];
  return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
}

function sameIdentifiers(a, b) {
  const set = entry => (entry.identifiers || []).map(canonical).sort().join('|');
  return set(a) === set(b);
}

/** Declared entry overlaid with the closed list from a verified copy. */
function overlay(publisherDomain, declared, copy) {
  const effective = { publisher_domain: publisherDomain, ...clone(declared) };
  for (const field of CLOSED_LIST) if (field in copy) effective[field] = clone(copy[field]);
  if (Array.isArray(effective.distribution) && Array.isArray(copy.distribution)) {
    for (const entry of copy.distribution) {
      if (!entry.followers) continue;
      let matches = effective.distribution.filter(d => d.publisher_domain === entry.publisher_domain);
      if (matches.length > 1) matches = matches.filter(d => sameIdentifiers(d, entry));
      if (matches.length === 1) matches[0].followers = clone(entry.followers);
    }
  }
  return effective;
}

function mergedView(input) {
  const vector = withFixtures(input);
  return vector.keys.map(k => {
    const declared = (vector.declarations[k.publisher_domain] || []).find(c => c.collection_id === k.collection_id);
    const authorized = vector.seller_authorized.some(sel => (
      sel.publisher_domain === k.publisher_domain && (!sel.collection_ids || sel.collection_ids.includes(k.collection_id))
    ));
    const copies = vector.copies.filter(c => keyOf(c) === keyOf(k));
    const fromDeclaration = declared ? { publisher_domain: k.publisher_domain, ...clone(declared) } : null;
    const out = (status, effective, display) => ({
      ...k, status, effective, display, carriage_eligible: Boolean(declared),
    });
    if (copies.length > 1) return out('unresolvable', fromDeclaration, fromDeclaration);
    if (copies.length === 0) return declared ? out('fallback', fromDeclaration, fromDeclaration) : out('unknown', null, null);
    if (declared && authorized) {
      const effective = overlay(k.publisher_domain, declared, copies[0]);
      return out('verified', effective, effective);
    }
    return out('unverified', null, clone(copies[0]));
  });
}

function selectorMatches(card, selectors) {
  if (!selectors) return true;
  return selectors.some(sel => (
    sel.publisher_domain === card.publisher_domain && (!sel.collection_ids || sel.collection_ids.includes(card.collection_id))
  ));
}

/** RFC 4647 basic filtering, case-insensitive. */
function languageMatches(range, tag) {
  if (!tag) return false;
  const [r, t] = [range.toLowerCase(), tag.toLowerCase()];
  return r === '*' || t === r || t.startsWith(`${r}-`);
}

function filterMatches(card, filters) {
  if (!filters) return true;
  const any = (values, test) => values.some(test);
  if (filters.kinds && !filters.kinds.includes(card.kind || 'series')) return false;
  if (filters.statuses && !filters.statuses.includes(card.status)) return false;
  if (filters.languages && !any(filters.languages, r => languageMatches(r, card.language))) return false;
  const taxonomyOk = !filters.genre_taxonomy || filters.genre_taxonomy === card.genre_taxonomy;
  const genres = card.genre || [];
  if (filters.genres_include && !(taxonomyOk && any(filters.genres_include, g => genres.includes(g)))) return false;
  if (filters.genres_exclude && taxonomyOk && any(filters.genres_exclude, g => genres.includes(g))) return false;
  if (filters.talent && !any(filters.talent, t => (card.talent || []).some(p => (
    p.brand_ref && p.brand_ref.domain === t.domain && (!t.brand_id || p.brand_ref.brand_id === t.brand_id)
  )))) return false;
  if (filters.platforms && !any(filters.platforms, d => (card.distribution || []).some(e => e.publisher_domain === d))) return false;
  if (filters.name_contains && !(card.name || '').toLowerCase().includes(filters.name_contains.toLowerCase())) return false;
  return true;
}

/** Selectors and filters as sets; cursor excluded; account only for account-scoped tokens. */
function scopeOf({ collections, filters, accountId, cacheScope }) {
  const selectors = collections
    ? [...new Set(collections.map(s => canonical({
      publisher_domain: s.publisher_domain,
      ...(s.collection_ids ? { collection_ids: [...new Set(s.collection_ids)].sort() } : {}),
    })))].sort()
    : null;
  const normalizedFilters = filters
    ? Object.fromEntries(Object.entries(filters).map(([k, v]) => [
      k, Array.isArray(v) ? [...new Set(v.map(canonical))].sort() : v,
    ]))
    : null;
  return canonical({
    selectors,
    filters: normalizedFilters,
    account: cacheScope === 'account' ? accountId || null : null,
  });
}

function idCount(request) {
  return (request.collections || []).reduce((sum, s) => sum + (s.collection_ids || []).length, 0);
}

function gradeResponse(input) {
  const vector = withFixtures(input);
  const violations = new Set();
  const { seller, seller_catalog: catalog, request, response, task_error: taskError } = vector;
  const schemaOk = validate.request(request)
    && (taskError ? !response && validate.error(taskError) : validate.response(response));
  if (!schemaOk) return ['schema_invalid'];

  const features = seller.experimental_features || [];
  if (response && (!features.includes(CATALOG_FEATURE) || !features.includes(CARDS_FEATURE))) {
    violations.add('feature_not_declared');
  }
  if (belowVersion(request.adcp_version, '3.3')) {
    if (response || taskError.code !== 'UNSUPPORTED_FEATURE') violations.add('version_gate');
    return [...violations];
  }
  if (idCount(request) > 100) {
    if (response) violations.add('id_limit_not_enforced');
    return [...violations];
  }
  if (taskError) {
    if (taskError.code === 'REFERENCE_NOT_FOUND') violations.add('per_key_error');
    return [...violations];
  }

  const accountId = request.account && request.account.account_id;
  if (!request.account && response.cache_scope === 'account') violations.add('cache_scope_without_account');

  if (response.outcome === 'unchanged') {
    const token = vector.token_issued_for;
    const presented = scopeOf({
      collections: token.collections, filters: token.filters, accountId: token.account_id, cacheScope: token.cache_scope,
    });
    const current = scopeOf({
      collections: request.collections, filters: request.filters, accountId, cacheScope: token.cache_scope,
    });
    if (presented !== current) violations.add('token_scope_mismatch');
    return [...violations];
  }

  const visible = entry => entry.visible_to === 'public' || (accountId && entry.visible_to.includes(accountId));
  const byKey = new Map(catalog.map(entry => [keyOf(entry.card), entry]));
  const seen = new Set();
  for (const card of response.collections) {
    const key = keyOf(card);
    if (seen.has(key)) violations.add('duplicate_key');
    seen.add(key);
    const entry = byKey.get(key);
    if (!entry || !visible(entry)) violations.add('invisible_entry_returned');
    else if (canonical(card) !== canonical(entry.card)) violations.add('copy_inconsistent');
    if (!selectorMatches(card, request.collections)) violations.add('selector_mismatch');
    if (!filterMatches(card, request.filters)) violations.add('filter_mismatch');
  }
  const firstPage = !(request.pagination && request.pagination.cursor);
  const lastPage = !(response.pagination && response.pagination.has_more);
  if (firstPage && lastPage) {
    for (const entry of catalog) {
      if (!visible(entry) || seen.has(keyOf(entry.card))) continue;
      if (selectorMatches(entry.card, request.collections) && filterMatches(entry.card, request.filters)) {
        violations.add('missing_entry');
      }
    }
  }
  return [...violations];
}

function gradeWebhook(vector) {
  const violations = new Set();
  const { webhook, seller, subscription } = vector;
  if (!validate.webhook(webhook)) return ['schema_invalid'];
  const type = webhook.notification_type;
  if (webhook.notification_id !== webhook.event.event_id) violations.add('notification_id_mismatch');
  if (CARD_EVENTS.has(type) && !(seller.experimental_features || []).includes(CATALOG_FEATURE)) {
    violations.add('feature_not_declared');
  }
  if (!(seller.wholesale_feed_webhook_event_types || []).includes(type)) violations.add('undeclared_event_type');
  if (!subscription.event_types.includes(type)) violations.add('unsubscribed_event_type');
  if (webhook.account_id !== subscription.account_id) violations.add('account_mismatch');
  if (type === 'collection_card.updated') {
    const visible = new Set(vector.subscriber_visible_keys.map(keyOf));
    if (!visible.has(keyOf(webhook.event.payload.collection))) violations.add('visibility_leak');
  }
  return [...violations];
}

function snapshot(mirror, cards) {
  return {
    cache_scope: mirror.cache_scope,
    version: mirror.version,
    last_event_id: mirror.last_event_id,
    cards: [...cards.values()].sort((a, b) => (
      a.publisher_domain.localeCompare(b.publisher_domain) || a.collection_id.localeCompare(b.collection_id)
    )),
  };
}

function applyEvents(vector) {
  const mirror = clone(vector.mirror);
  const cards = new Map(mirror.cards.map(c => [keyOf(c), c]));
  const seenDelivery = new Set();
  const seenLogical = new Set();
  const stop = (verdict, token) => ({ verdict, repair_token: token, mirror: snapshot(mirror, cards) });
  for (const { webhook, signature_valid: signatureValid = true } of vector.events) {
    if (!signatureValid) return stop('repair_conditional', mirror.version);
    if (seenDelivery.has(webhook.idempotency_key) || seenLogical.has(webhook.notification_id)) continue;
    const previous = webhook.previous_wholesale_feed_version;
    if (previous !== undefined && previous !== mirror.version) return stop('repair_conditional', mirror.version);
    if (mirror.last_event_id && webhook.event.event_id < mirror.last_event_id) {
      return stop('repair_conditional', mirror.version);
    }
    const { event_type: type, payload } = webhook.event;
    if (type === 'collection_catalog.bulk_change') return stop('repair_full', null);
    if (type === 'collection_card.updated') cards.set(keyOf(payload.collection), clone(payload.collection));
    else if (type === 'collection_card.removed') cards.delete(keyOf(payload));
    mirror.version = webhook.wholesale_feed_version;
    mirror.last_event_id = webhook.event.event_id;
    seenDelivery.add(webhook.idempotency_key);
    seenLogical.add(webhook.notification_id);
  }
  return stop('applied', null);
}

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
