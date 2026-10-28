/**
 * Unit tests for scripts/audit-schema-bounds.cjs on small fixture trees: how it
 * classifies side, stability and inline property lists, and what it skips.
 * The live schema tree is checked only for ref resolution.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { build, isBoundedPattern } = require('../scripts/audit-schema-bounds.cjs');

function writeTree(root, files) {
  for (const [rel, doc] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, JSON.stringify(doc));
  }
}

function fixture(source, released = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bounds-audit-'));
  const sourceDir = path.join(dir, 'source');
  const distDir = path.join(dir, 'dist');
  writeTree(sourceDir, source);
  writeTree(path.join(distDir, '3.2.7'), released);
  return { dir, sourceDir, distDir };
}

const find = (inventory, file, pointer) => inventory.entries.find(e => e.file === file && e.pointer === pointer);

test('a bounded pattern is anchored and has no unbounded quantifier', () => {
  assert.equal(isBoundedPattern('^[a-z]{1,64}$'), true);
  assert.equal(isBoundedPattern('^\\d{4}-\\d{2}$'), true);
  assert.equal(isBoundedPattern('^[a-z0-9_]+$'), false);
  assert.equal(isBoundedPattern('^[a-z]{1,}$'), false);
  assert.equal(isBoundedPattern('^https://'), false);
  assert.equal(isBoundedPattern('^a.*b$'), false);
});

test('arrays and strings are listed unless bounded or constrained', () => {
  const { dir, sourceDir, distDir } = fixture({
    'core/thing.json': {
      $id: '/schemas/core/thing.json',
      type: 'object',
      properties: {
        open_array: { type: 'array', items: { type: 'string' } },
        bounded_array: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 8 } },
        plain: { type: 'string' },
        bounded: { type: 'string', maxLength: 10 },
        enumerated: { type: 'string', enum: ['a', 'b'] },
        constant: { type: 'string', const: 'x' },
        stamp: { type: 'string', format: 'date-time' },
        link: { type: 'string', format: 'uri' },
        short: { type: 'string', pattern: '^[a-z]{1,8}$' },
        long: { type: 'string', pattern: '^[a-z]+$' },
      },
    },
  });
  const inventory = build({ sourceDir, distDir });
  const pointers = inventory.entries.map(e => e.pointer).sort();
  assert.deepEqual(pointers, ['/properties/long', '/properties/open_array', '/properties/open_array/items', '/properties/plain']);
  assert.equal(inventory.meta.unbounded_uri_strings, 1, 'uri strings are skipped but counted');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('side follows $ref from task requests and responses', () => {
  const { dir, sourceDir, distDir } = fixture({
    'core/shared.json': { $id: '/schemas/core/shared.json', type: 'object', properties: { note: { type: 'string' } } },
    'core/request-only.json': { $id: '/schemas/core/request-only.json', type: 'object', properties: { memo: { type: 'string' } } },
    'core/orphan.json': { $id: '/schemas/core/orphan.json', type: 'object', properties: { aside: { type: 'string' } } },
    'media-buy/do-thing-request.json': {
      $id: '/schemas/media-buy/do-thing-request.json',
      type: 'object',
      properties: { shared: { $ref: '/schemas/core/shared.json' }, only: { $ref: '/schemas/core/request-only.json' } },
    },
    'media-buy/do-thing-response.json': {
      $id: '/schemas/media-buy/do-thing-response.json',
      type: 'object',
      properties: { shared: { $ref: '/schemas/core/shared.json' } },
    },
  });
  const inventory = build({ sourceDir, distDir });
  assert.equal(find(inventory, 'core/shared.json', '/properties/note').side, 'both');
  assert.equal(find(inventory, 'core/request-only.json', '/properties/memo').side, 'request');
  assert.equal(find(inventory, 'core/orphan.json', '/properties/aside').side, 'other');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('stability needs the marker and absence from the last stable release', () => {
  const released = {
    'core/thing.json': {
      $id: '/schemas/core/thing.json',
      type: 'object',
      properties: { kept: { type: 'string' }, mislabelled: { type: 'string' } },
    },
  };
  const { dir, sourceDir, distDir } = fixture(
    {
      'core/thing.json': {
        $id: '/schemas/core/thing.json',
        type: 'object',
        properties: {
          kept: { type: 'string' },
          fresh: { type: 'string', 'x-added-in': '3.3.0' },
          unmarked: { type: 'string' },
          mislabelled: { type: 'string', 'x-added-in': '3.3.0' },
          trial: { type: 'string', 'x-status': 'experimental' },
          nested: { type: 'object', 'x-added-in': '3.3.0', properties: { inner: { type: 'array', items: { type: 'object' } } } },
        },
      },
    },
    released
  );
  const inventory = build({ sourceDir, distDir });
  const at = p => find(inventory, 'core/thing.json', p);
  assert.equal(at('/properties/kept').stability, 'stable');
  assert.equal(at('/properties/fresh').stability, 'new-3.3');
  assert.equal(at('/properties/fresh').action, 'apply in 3.3');
  assert.equal(at('/properties/unmarked').stability, 'stable', 'absence from a release alone never promotes a node');
  assert.equal(at('/properties/mislabelled').stability, 'stable', 'a marker that conflicts with the release is stable');
  assert.equal(at('/properties/mislabelled').marker_conflict, true);
  assert.equal(at('/properties/trial').stability, 'experimental');
  assert.equal(at('/properties/nested/properties/inner').stability, 'new-3.3', 'the marker covers descendants');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a field that moved into a new file is still released', () => {
  const released = {
    'brand.json': {
      $id: '/schemas/brand.json',
      type: 'object',
      properties: { party: { type: 'object', properties: { party_id: { type: 'string' } } } },
    },
    'media-buy/do-thing-request.json': {
      $id: '/schemas/media-buy/do-thing-request.json',
      type: 'object',
      properties: { brand: { $ref: '/schemas/brand.json' } },
    },
  };
  const { dir, sourceDir, distDir } = fixture(
    {
      'brand.json': {
        $id: '/schemas/brand.json',
        type: 'object',
        properties: { party: { $ref: '/schemas/core/party.json' } },
      },
      'core/party.json': {
        $id: '/schemas/core/party.json',
        'x-added-in': '3.3.0',
        type: 'object',
        properties: { party_id: { type: 'string' }, brand_new: { type: 'string' } },
      },
      'media-buy/do-thing-request.json': {
        $id: '/schemas/media-buy/do-thing-request.json',
        type: 'object',
        properties: { brand: { $ref: '/schemas/brand.json' } },
      },
    },
    released
  );
  const inventory = build({ sourceDir, distDir });
  assert.equal(find(inventory, 'core/party.json', '/properties/party_id').stability, 'stable', 'the file is new but the field shipped in 3.2.7 under brand.json');
  assert.equal(find(inventory, 'core/party.json', '/properties/brand_new').stability, 'new-3.3', 'a field 3.2.7 never carried stays new');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a bound on a mixed-type node is deferred because SDK generation breaks on it', () => {
  const { dir, sourceDir, distDir } = fixture({
    'core/thing.json': {
      $id: '/schemas/core/thing.json',
      type: 'object',
      properties: {
        revision: { type: ['integer', 'string'], 'x-added-in': '3.3.0' },
        nullable_name: { type: ['string', 'null'], 'x-added-in': '3.3.0' },
      },
    },
  });
  const inventory = build({ sourceDir, distDir });
  assert.equal(find(inventory, 'core/thing.json', '/properties/revision').action, 'deferred (SDK generation)');
  assert.equal(find(inventory, 'core/thing.json', '/properties/nullable_name').action, 'apply in 3.3', 'nullable alone is fine');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('property and collection lists carried inline are flagged and get no limit', () => {
  const { dir, sourceDir, distDir } = fixture({
    'core/selector.json': {
      $id: '/schemas/core/selector.json',
      type: 'object',
      properties: {
        publisher_domains: { type: 'array', items: { type: 'string' } },
        property_list: { type: 'object', properties: { agent_url: { type: 'string', format: 'uri' }, list_id: { type: 'string', maxLength: 255 } } },
        collections: { type: 'array', items: { type: 'object' } },
        tags: { type: 'array', items: { type: 'string' } },
      },
    },
  });
  const inventory = build({ sourceDir, distDir });
  const listed = inventory.inline_property_lists.map(e => `${e.list_kind}:${e.pointer}`).sort();
  assert.deepEqual(listed, ['collection:/properties/collections', 'property:/properties/publisher_domains']);
  const domains = find(inventory, 'core/selector.json', '/properties/publisher_domains');
  assert.equal(domains.proposed_limit, null);
  assert.equal(domains.action, 'move out of band (4.0)');
  assert.equal(find(inventory, 'core/selector.json', '/properties/tags').action, 'tighten in 4.0');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the live schema tree resolves every $ref the audit follows', () => {
  const inventory = build();
  assert.deepEqual(inventory.meta.unresolved_refs, []);
  assert.ok(inventory.entries.length > 0);
});

test('no schema file carries a duplicate bound keyword', () => {
  // A bound applied beside an existing one leaves two keys in one object, and JSON.parse
  // silently keeps the last. Compare the keyword occurrences in the text with the ones the
  // parser sees: a duplicate shows up as a difference.
  const root = path.join(__dirname, '..', 'static', 'schemas', 'source');
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.json') ? [path.join(dir, e.name)] : []));
  const duplicates = [];
  for (const file of walk(root)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const keyword of ['maxItems', 'maxLength']) {
      const inText = (text.match(new RegExp(`"${keyword}"\\s*:\\s*\\d`, 'g')) || []).length;
      let parsed = 0;
      JSON.parse(text, (key, value) => {
        if (key === keyword && typeof value === 'number') parsed++;
        return value;
      });
      if (inText !== parsed) duplicates.push(`${path.relative(root, file)} ${keyword}`);
    }
  }
  assert.deepEqual(duplicates, []);
});
