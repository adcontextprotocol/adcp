#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');

const ROOT = path.resolve(__dirname, '..');
const AUDIO_REQUIREMENTS = path.join(
  ROOT,
  'static/schemas/source/core/requirements/audio-asset-requirements.json'
);
const AUDIO_DOC = path.join(ROOT, 'docs/creative/channels/audio.mdx');
const RADIO_DOC = path.join(ROOT, 'docs/creative/channels/radio.mdx');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function jsonExamples(file) {
  const content = fs.readFileSync(file, 'utf8');
  return [...content.matchAll(/```json[^\n]*\n([\s\S]*?)```/g)].map(match =>
    JSON.parse(match[1])
  );
}

test('audio asset loudness constraints are optional and typed', () => {
  const schema = readJson(AUDIO_REQUIREMENTS);
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);

  assert.equal(validate({}), true, 'loudness constraints must remain optional');
  assert.equal(validate({
    loudness_lufs: -16,
    loudness_tolerance_db: 2,
    true_peak_dbfs: -2
  }), true);
  assert.equal(validate({ loudness_tolerance_db: -0.1 }), false);
  assert.equal(validate({ loudness_lufs: '-16' }), false);
  assert.equal(validate({ loudness_tolerance_db: '2' }), false);
  assert.equal(validate({ true_peak_dbfs: '-2' }), false);

  assert.match(schema.properties.loudness_lufs.description, /LKFS/);
  assert.match(schema.properties.loudness_lufs.description, /without conversion/);
});

test('radio guide carries the canonical :15, :30, and :60 profiles', () => {
  const examples = jsonExamples(RADIO_DOC);
  const declarations = examples.filter(example =>
    example.$schema?.endsWith('/core/product-format-declaration.json')
  );

  assert.deepEqual(
    declarations.map(declaration => declaration.params.duration_ms_exact),
    [15000, 30000, 60000]
  );

  for (const declaration of declarations) {
    assert.equal(declaration.format_kind, 'audio_hosted');
    assert.deepEqual(declaration.applies_to_channels, ['radio']);
    assert.deepEqual(declaration.params.audio_codecs, ['mp3', 'aac', 'wav']);
    assert.deepEqual(declaration.params.audio_sample_rates, [48000]);
    assert.deepEqual(declaration.params.audio_channels, ['stereo']);
    assert.equal(declaration.params.min_bitrate_kbps, 192);
    assert.equal(declaration.params.loudness_lufs, -16);
    assert.equal(declaration.params.loudness_tolerance_db, 2);
    assert.equal(declaration.params.true_peak_dbfs, -2);
    assert.equal(declaration.params.buyer_asset_acceptance, 'accepted');
    assert.deepEqual(declaration.params.slots, [
      { asset_group_id: 'audio_main', asset_type: 'audio', required: true }
    ]);
  }
});

test('streaming audio example declares and reports its loudness profile', () => {
  const examples = jsonExamples(AUDIO_DOC);
  const declaration = examples.find(example =>
    example.format_option_id === 'streaming_audio_30s'
  );
  const manifest = examples.find(example =>
    example.$schema?.endsWith('/core/creative-manifest.json')
  );

  assert.equal(declaration.params.loudness_lufs, -16);
  assert.equal(declaration.params.loudness_tolerance_db, 2);
  assert.equal(declaration.params.true_peak_dbfs, -2);
  assert.equal(manifest.assets.audio_main.loudness_lufs, -16);
  assert.equal(manifest.assets.audio_main.true_peak_dbfs, -2);
});

test('radio manifest uses industry identifiers without tracker or tag assets', () => {
  const examples = jsonExamples(RADIO_DOC);
  const manifest = examples.find(example =>
    example.$schema?.endsWith('/core/creative-manifest.json')
  );
  const supportedIdentifiers = new Set(
    readJson(path.join(ROOT, 'static/schemas/source/enums/creative-identifier-type.json')).enum
  );

  assert.ok(manifest);
  assert.equal(manifest.format_kind, 'audio_hosted');
  assert.ok(manifest.industry_identifiers.length > 0);
  for (const identifier of manifest.industry_identifiers) {
    assert.equal(supportedIdentifiers.has(identifier.type), true);
  }
  assert.deepEqual(Object.keys(manifest.assets), ['audio_main']);
  assert.equal(manifest.assets.audio_main.asset_type, 'audio');
});

test('audio and radio guidance preserves loudness and normalization semantics', () => {
  const audio = fs.readFileSync(AUDIO_DOC, 'utf8');
  const radio = fs.readFileSync(RADIO_DOC, 'utf8');

  assert.match(audio, /AES TD1008/);
  assert.match(audio, /recommends -18 LUFS/);
  assert.match(audio, /LUFS and LKFS are identical units/);
  assert.match(audio, /EBU R128/);
  assert.match(audio, /canonical format parameter governs/);
  assert.match(audio, /FORMAT_DECLARATION_DIVERGENT/);
  assert.match(audio, /Platform normalization happens after source-asset validation/);
  assert.match(radio, /no renderer in which a VAST\/DAAST tag/);
  assert.match(radio, /do not add tracker slots/);
  assert.match(radio, /Standardized audio quartile and completion tag events use `audio_daast`/);
});

test('radio guide is present in live documentation navigation', () => {
  const docsConfig = readJson(path.join(ROOT, 'docs.json'));
  assert.match(JSON.stringify(docsConfig.navigation), /docs\/creative\/channels\/radio/);
});
