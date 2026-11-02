#!/usr/bin/env node
'use strict';

// Generated Zod preserves public asset shapes; canonical SDK JSON Schema
// validation remains authoritative for numeric, conditional and count rules.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

function argumentsFrom(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    assert.ok(['--source-root', '--sdk-root'].includes(flag) && argv[index + 1],
      'Usage: node probe-generated-sdk-creative-assets.cjs --source-root <schemas/source> --sdk-root <built-sdk>');
    assert.ok(!options.has(flag), `Duplicate argument ${flag}`);
    options.set(flag, path.resolve(argv[index + 1]));
  }
  assert.equal(options.size, 2, 'Both --source-root and --sdk-root are required.');
  return { sourceRoot: options.get('--source-root'), sdkRoot: options.get('--sdk-root') };
}

function main() {
  const { sourceRoot, sdkRoot } = argumentsFrom(process.argv.slice(2));
  for (const file of ['zip', 'html', 'display-tag']) {
    assert.ok(fs.existsSync(path.join(sourceRoot, `core/assets/${file}-asset.json`)),
      `Source asset schema missing: ${file}`);
  }
  const sdkRequire = createRequire(path.join(sdkRoot, 'package.json'));
  const schemas = sdkRequire('@adcp/sdk/schemas');
  const { withExternalSchemaRoot } = sdkRequire('@adcp/sdk/testing');
  assert.equal(typeof schemas.getCanonicalToolValidator, 'function', 'SDK must expose canonical validation.');
  assert.equal(typeof withExternalSchemaRoot, 'function', 'SDK must support the isolated candidate schema root.');
  const version = fs.readFileSync(path.join(sdkRoot, 'ADCP_VERSION'), 'utf8').trim();
  const candidateRoot = path.join(sdkRoot, 'schemas/cache', version);
  const hasBrief = fs.existsSync(path.join(sourceRoot, 'core/assets/video-brief-asset.json'));
  assert.equal(fs.existsSync(path.join(candidateRoot, 'core/assets/video-brief-asset.json')), hasBrief,
    'Candidate bundle and checked-out protocol must agree on typed video-brief support.');
  if (hasBrief) assert.equal(typeof schemas.VideoBriefAssetSchema?.safeParse, 'function',
    'Protocol defines video_brief but generated SDK export is missing.');

  const pair = { width: 300, height: 250 };
  const variants = [
    ['ZIP', 'ZipAssetSchema', 'html5', { asset_type: 'zip', url: 'https://cdn.acme.example/banner.zip' }],
    ['HTML', 'HTMLAssetSchema', 'display_tag', { asset_type: 'html', content: '<div>Acme</div>' }],
    ['tag URL', 'DisplayTagAssetSchema', 'display_tag', { asset_type: 'display_tag', delivery_type: 'tag_url', url: 'https://ads.acme.example/tag' }],
    ['inline markup', 'DisplayTagAssetSchema', 'display_tag', { asset_type: 'display_tag', delivery_type: 'inline_markup', markup_type: 'standard', markup: '<div>Acme</div>' }],
    ['paired redirect', 'DisplayTagAssetSchema', 'display_tag', { asset_type: 'display_tag', delivery_type: 'paired_redirect', ad_request_url: 'https://ads.acme.example/ad', clickthrough_url: 'https://ads.acme.example/click' }],
  ];
  const sizeCases = [
    ['unsized', {}, true],
    ['fixed', pair, true],
    ['sizes', { sizes: [pair, { width: 728, height: 90 }] }, true],
    ['width only', { width: 300 }, false],
    ['height only', { height: 250 }, false],
    ['zero width', { ...pair, width: 0 }, false],
    ['zero height', { ...pair, height: 0 }, false],
    ['negative width', { ...pair, width: -1 }, false],
    ['negative height', { ...pair, height: -1 }, false],
    ['string width', { ...pair, width: '300' }, false],
    ['string height', { ...pair, height: '250' }, false],
    ['fractional width', { ...pair, width: 1.5 }, false],
    ['fractional height', { ...pair, height: 1.5 }, false],
    ['both size modes', { ...pair, sizes: [pair] }, false],
    ['empty sizes', { sizes: [] }, false],
    ['null sizes', { sizes: null }, false],
    ['object sizes', { sizes: pair }, false],
    ['missing pair width', { sizes: [{ height: 250 }] }, false],
    ['missing pair height', { sizes: [{ width: 300 }] }, false],
    ['string pair width', { sizes: [{ ...pair, width: '300' }] }, false],
    ['fractional pair height', { sizes: [{ ...pair, height: 1.5 }] }, false],
    ['extra pair field', { sizes: [{ ...pair, unit: 'px' }] }, false],
  ];
  const counts = { zod: 0, canonical: 0, sizing: 0, brief: 0 };
  function shape(name, exportName, value, expected) {
    const schema = schemas[exportName];
    assert.equal(typeof schema?.safeParse, 'function', `Missing generated SDK export ${exportName}`);
    const parsed = schema.safeParse(value);
    assert.equal(parsed.success, expected, `Generated Zod ${name}`);
    counts.zod++;
    return parsed.success ? parsed.data : undefined;
  }

  withExternalSchemaRoot(version, candidateRoot, () => {
    const validate = schemas.getCanonicalToolValidator('sync_creatives', 'request', { adcpVersion: version });
    assert.equal(typeof validate, 'function', 'Candidate sync_creatives validator must resolve.');
    function canonical(name, formatKind, asset, expected) {
      const request = {
        account: { account_id: 'acct_creative_probe' },
        idempotency_key: `creative-asset-probe-${counts.canonical}`,
        creatives: [{ creative_id: 'creative_probe', name: 'Acme creative probe', format_kind: formatKind, assets: { main: asset } }],
      };
      const accepted = validate(request);
      assert.equal(accepted, expected, `Canonical SDK ${name}: ${JSON.stringify(validate.errors?.slice(0, 3))}`);
      counts.canonical++;
    }

    for (const [name, exportName, kind, asset] of variants) {
      for (const [caseName, dimensions, expected] of sizeCases) {
        const value = { ...asset, ...dimensions };
        canonical(`${name}: ${caseName}`, kind, value, expected);
        counts.sizing++;
        // Cross-field/count rules are deliberately asserted through canonical
        // validation, not the SDK's structural TypeScript-to-Zod projection.
        if (expected) {
          const expectedDimensions = structuredClone(dimensions);
          const parsed = shape(`${name}: ${caseName}`, exportName, value, true);
          for (const [field, expectedValue] of Object.entries(expectedDimensions)) {
            assert.deepEqual(parsed[field], expectedValue, `Generated Zod ${name}: preserves ${field}`);
          }
        }
      }
      const withoutAssetType = { ...asset };
      delete withoutAssetType.asset_type;
      for (const [caseName, value] of [
        ['missing asset type', withoutAssetType],
        ['wrong asset type', { ...asset, asset_type: 'not_an_asset' }],
      ]) {
        shape(`${name}: ${caseName}`, exportName, value, false);
        canonical(`${name}: ${caseName}`, kind, value, false);
      }
      if (asset.asset_type === 'display_tag') {
        const withoutDeliveryType = { ...asset };
        delete withoutDeliveryType.delivery_type;
        for (const [caseName, value] of [
          ['missing delivery type', withoutDeliveryType],
          ['wrong delivery type', { ...asset, delivery_type: 'unknown' }],
        ]) {
          shape(`${name}: ${caseName}`, exportName, value, false);
          canonical(`${name}: ${caseName}`, kind, value, false);
        }
      }
    }

    // These preexisting required fields must survive generation. An allOf/ref
    // rewrite once collapsed tag variants to size-only objects while CI still built.
    const requiredFields = [
      ['ZIP URL', 'ZipAssetSchema', 'html5', { asset_type: 'zip' }],
      ['ZIP URL type', 'ZipAssetSchema', 'html5', { asset_type: 'zip', url: 3 }],
      ['HTML content', 'HTMLAssetSchema', 'display_tag', { asset_type: 'html' }],
      ['HTML content type', 'HTMLAssetSchema', 'display_tag', { asset_type: 'html', content: 3 }],
      ['tag URL', 'DisplayTagAssetSchema', 'display_tag', { asset_type: 'display_tag', delivery_type: 'tag_url' }],
      ['tag URL type', 'DisplayTagAssetSchema', 'display_tag', { asset_type: 'display_tag', delivery_type: 'tag_url', url: 3 }],
      ['inline markup', 'DisplayTagAssetSchema', 'display_tag', { ...variants[3][3], markup: undefined }],
      ['inline markup type', 'DisplayTagAssetSchema', 'display_tag', { ...variants[3][3], markup: 3 }],
      ['markup discriminator', 'DisplayTagAssetSchema', 'display_tag', { ...variants[3][3], markup_type: undefined }],
      ['unknown markup discriminator', 'DisplayTagAssetSchema', 'display_tag', { ...variants[3][3], markup_type: 'unknown' }],
      ['paired ad URL', 'DisplayTagAssetSchema', 'display_tag', { ...variants[4][3], ad_request_url: undefined }],
      ['paired ad URL type', 'DisplayTagAssetSchema', 'display_tag', { ...variants[4][3], ad_request_url: 3 }],
      ['paired click URL', 'DisplayTagAssetSchema', 'display_tag', { ...variants[4][3], clickthrough_url: undefined }],
      ['paired click URL type', 'DisplayTagAssetSchema', 'display_tag', { ...variants[4][3], clickthrough_url: 3 }],
    ];
    for (const [name, exportName, kind, value] of requiredFields) {
      shape(name, exportName, value, false);
      canonical(name, kind, value, false);
    }

    if (hasBrief) {
      const segment = {
        order: 1, duration_ms: 15000, prompt: 'Acme hiking boots on a forest trail.',
        vo: 'Explore the trail with Acme.', caption: 'Find your next trail.',
      };
      const briefCases = [
        ['valid', { segments: [segment] }, true, true],
        ['missing segments', {}, false, true],
        ['empty segments', { segments: [] }, false, false],
        ['nonarray segments', { segments: segment }, false, true],
        ['null segment', { segments: [null] }, false, true],
        ['missing order', { segments: [{ duration_ms: 15000, prompt: 'Acme' }] }, false, true],
        ['zero order', { segments: [{ ...segment, order: 0 }] }, false, false],
        ['string order', { segments: [{ ...segment, order: '1' }] }, false, true],
        ['fractional order', { segments: [{ ...segment, order: 1.5 }] }, false, false],
        ['missing duration', { segments: [{ order: 1, prompt: 'Acme' }] }, false, true],
        ['zero duration', { segments: [{ ...segment, duration_ms: 0 }] }, false, false],
        ['string duration', { segments: [{ ...segment, duration_ms: '15000' }] }, false, true],
        ['fractional duration', { segments: [{ ...segment, duration_ms: 1.5 }] }, false, false],
        ['missing prompt', { segments: [{ order: 1, duration_ms: 15000 }] }, false, true],
        ['prompt type', { segments: [{ ...segment, prompt: 3 }] }, false, true],
      ];
      for (const [name, brief, expected, structural] of briefCases) {
        const value = { asset_type: 'video_brief', ...brief };
        canonical(`video brief: ${name}`, 'video_hosted', value, expected);
        counts.brief++;
        if (structural) {
          const expectedBrief = structuredClone(value);
          const parsed = shape(`video brief: ${name}`, 'VideoBriefAssetSchema', value, expected);
          if (expected) {
            assert.equal(parsed.asset_type, expectedBrief.asset_type, 'Generated Zod preserves video-brief asset type');
            assert.deepEqual(parsed.segments, expectedBrief.segments, 'Generated Zod preserves complete video-brief segments');
          }
        }
      }
      for (const [name, value] of [
        ['missing asset type', { segments: [segment] }],
        ['wrong asset type', { asset_type: 'brief', segments: [segment] }],
      ]) {
        shape(`video brief: ${name}`, 'VideoBriefAssetSchema', value, false);
        canonical(`video brief: ${name}`, 'video_hosted', value, false);
        counts.brief++;
      }
    }
  });
  console.log(`PASS: generated SDK creative assets — ${counts.zod} Zod shape checks; ${counts.canonical} canonical checks (${counts.sizing} sizing, ${counts.brief} brief); video_brief ${hasBrief ? 'covered' : 'absent from protocol source'}.`);
}

try { main(); } catch (error) {
  console.error(`FAIL: generated SDK creative assets — ${error.message}`);
  process.exitCode = 1;
}
