const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const vectors = JSON.parse(fs.readFileSync(
  path.join(root, 'static/test-vectors/canonical-format-classification.json'),
  'utf8',
));
const kindSchema = JSON.parse(fs.readFileSync(
  path.join(root, 'static/schemas/source/core/canonical-format-kind.json'),
  'utf8',
));
const shapeVocabulary = JSON.parse(fs.readFileSync(
  path.join(root, 'static/schemas/source/core/format-shape-vocabulary.json'),
  'utf8',
)).vocabulary;

assert.strictEqual(vectors.version, '3.2');
assert.ok(Array.isArray(vectors.vectors) && vectors.vectors.length >= 6);

const ids = new Set();
for (const vector of vectors.vectors) {
  assert.match(vector.id, /^[a-z0-9_]+$/);
  assert.ok(!ids.has(vector.id), `duplicate classification vector: ${vector.id}`);
  ids.add(vector.id);
  assert.ok(vector.publisher_spec.length >= 40, `${vector.id}: publisher_spec is too thin`);
  assert.ok(kindSchema.enum.includes(vector.expected.format_kind), `${vector.id}: unknown expected format_kind`);
  assert.ok(Array.isArray(vector.must_not_classify_as) && vector.must_not_classify_as.length > 0);
  assert.ok(!vector.must_not_classify_as.includes(vector.expected.format_kind));
  assert.ok(vector.reason.length >= 30, `${vector.id}: reason is too thin`);
  if (vector.expected.format_kind === 'custom') {
    assert.match(vector.expected.format_shape || '', /^[a-z][a-z0-9_]*$/);
    assert.ok(
      Object.hasOwn(shapeVocabulary, vector.expected.format_shape),
      `${vector.id}: unregistered custom format_shape`,
    );
  } else {
    assert.strictEqual(vector.expected.format_shape, undefined);
  }
}

assert.strictEqual(vectors.vectors.find(v => v.id === 'docking_video_buyer_upload').expected.format_kind, 'video_hosted');
assert.strictEqual(vectors.vectors.find(v => v.id === 'docking_video_third_party_tag').expected.format_kind, 'display_tag');
assert.strictEqual(vectors.vectors.find(v => v.id === 'responsive_static_image').expected.format_kind, 'image');
assert.strictEqual(vectors.vectors.find(v => v.id === 'responsive_component_assembly').expected.format_kind, 'responsive_creative');

console.log(`Validated ${vectors.vectors.length} canonical format classification vectors.`);
