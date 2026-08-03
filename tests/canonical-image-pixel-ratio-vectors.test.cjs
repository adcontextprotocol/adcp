const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const fixture = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '../static/test-vectors/canonical-image-pixel-ratio.json'),
  'utf8',
));

function inRange(value, min, max) {
  return (min === undefined || value >= min) && (max === undefined || value <= max);
}

/** Resolve the normative top-level/slot acceptance intersection once for every validation path. */
function effectivePixelRatios(params, slot = {}) {
  const topLevelRatios = params.pixel_ratios;
  const slotRatios = slot.pixel_ratios;
  const pixelRatios = topLevelRatios && slotRatios
    ? topLevelRatios.filter(ratio => slotRatios.includes(ratio))
    : slotRatios ?? topLevelRatios ?? [1];

  return pixelRatios.length > 0
    ? { valid: true, pixel_ratios: pixelRatios }
    : { valid: false, violation: 'pixel_ratio_intersection_empty' };
}

/** Reference algorithm consumed independently by each SDK's own test suite. */
function validateImageDensity(params, asset) {
  const acceptedRatios = params.pixel_ratios ?? [1];

  if (asset.pixel_ratio !== undefined && !acceptedRatios.includes(asset.pixel_ratio)) {
    return { valid: false, violation: 'pixel_ratio_not_accepted' };
  }

  const ratios = asset.pixel_ratio === undefined ? acceptedRatios : [asset.pixel_ratio];
  const matches = [];
  const hasFixed = params.width !== undefined && params.height !== undefined;
  const hasSizes = params.sizes !== undefined;
  const hasRange = params.min_width !== undefined || params.max_width !== undefined ||
    params.min_height !== undefined || params.max_height !== undefined;

  for (const ratio of ratios) {
    const logicalWidth = asset.width / ratio;
    const logicalHeight = asset.height / ratio;
    if (!Number.isInteger(logicalWidth) || !Number.isInteger(logicalHeight)) continue;

    const sizeMatches = hasFixed
      ? logicalWidth === params.width && logicalHeight === params.height
      : hasSizes
        ? params.sizes.some(size => size.width === logicalWidth && size.height === logicalHeight)
        : hasRange
          ? inRange(logicalWidth, params.min_width, params.max_width) &&
            inRange(logicalHeight, params.min_height, params.max_height)
          : asset.pixel_ratio !== undefined ||
            (acceptedRatios.length === 1 && acceptedRatios[0] === 1);

    if (sizeMatches) matches.push({ ratio, width: logicalWidth, height: logicalHeight });
  }

  if (matches.length > 1 && asset.pixel_ratio === undefined) {
    return { valid: false, violation: 'pixel_ratio_ambiguous' };
  }

  if (matches.length === 1) {
    const match = matches[0];
    return {
      valid: true,
      pixel_ratio: match.ratio,
      logical_width: match.width,
      logical_height: match.height,
    };
  }

  if (!hasFixed && !hasSizes && !hasRange && asset.pixel_ratio === undefined) {
    return { valid: false, violation: 'pixel_ratio_not_inferable' };
  }

  if (asset.pixel_ratio !== undefined && hasFixed) {
    const inferredWidthRatio = asset.width / params.width;
    const inferredHeightRatio = asset.height / params.height;
    if (inferredWidthRatio === inferredHeightRatio && inferredWidthRatio !== asset.pixel_ratio) {
      return { valid: false, violation: 'pixel_ratio_metadata_mismatch' };
    }
  }

  if (hasFixed && asset.width / params.width !== asset.height / params.height) {
    return { valid: false, violation: 'pixel_ratio_dimension_mismatch' };
  }

  return { valid: false, violation: 'image_dimensions_not_accepted' };
}

function validateImageSlot(params, slot, asset) {
  const effectiveRatios = effectivePixelRatios(params, slot);
  if (!effectiveRatios.valid) return effectiveRatios;
  return validateImageDensity({ ...params, pixel_ratios: effectiveRatios.pixel_ratios }, asset);
}

function validateImageRenditionSet(params, slot, assets) {
  const effectiveRatios = effectivePixelRatios(params, slot);
  if (!effectiveRatios.valid) return effectiveRatios;
  const acceptedRatios = effectiveRatios.pixel_ratios;
  const requiredRatios = slot.required_pixel_ratios ?? [];

  for (const ratio of requiredRatios) {
    if (!acceptedRatios.includes(ratio)) {
      return { valid: false, violation: 'required_pixel_ratio_not_accepted', pixel_ratio: ratio };
    }
  }

  const resolvedRatios = [];
  for (const asset of assets) {
    const result = validateImageDensity({ ...params, pixel_ratios: acceptedRatios }, asset);
    if (!result.valid) return result;
    if (resolvedRatios.includes(result.pixel_ratio)) {
      return { valid: false, violation: 'pixel_ratio_duplicate', pixel_ratio: result.pixel_ratio };
    }
    resolvedRatios.push(result.pixel_ratio);
  }

  for (const ratio of requiredRatios) {
    if (!resolvedRatios.includes(ratio)) {
      return { valid: false, violation: 'required_pixel_ratio_missing', pixel_ratio: ratio };
    }
  }

  return { valid: true, pixel_ratios: resolvedRatios.sort((a, b) => a - b) };
}

for (const vector of fixture.vectors) {
  test(`canonical image pixel ratio: ${vector.id}`, () => {
    const actual = vector.assets
      ? validateImageRenditionSet(vector.params, vector.slot, vector.assets)
      : validateImageSlot(vector.params, vector.slot, vector.asset);
    assert.deepEqual(actual, vector.expected);
  });
}

test('parameterized legacy display_image ids project without retina-specific names', () => {
  for (const vector of fixture.legacy_projection_vectors) {
    const { width, height, pixel_ratio: pixelRatio } = vector.format_id;
    const projected = {
      format_kind: 'image',
      params: {
        width,
        height,
        ...(pixelRatio === undefined ? {} : { pixel_ratios: [pixelRatio] }),
      },
    };
    assert.deepEqual(projected, vector.expected, vector.id);
  }
});

test('legacy catalog distinguishes 2x-only from paired 1x/2x contracts', () => {
  const catalog = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../server/src/creative-agent/reference-formats.json'),
    'utf8',
  ));
  const expectedSizes = [
    [300, 250],
    [728, 90],
    [320, 50],
    [160, 600],
    [336, 280],
    [300, 600],
    [970, 250],
  ];

  for (const [width, height] of expectedSizes) {
    const formatId = `display_${width}x${height}_image_2x`;
    const format = catalog.find(candidate => candidate.format_id.id === formatId);
    assert.ok(format, formatId);
    const imageAssets = format.assets.filter(asset => asset.asset_type === 'image');
    assert.deepEqual(imageAssets.map(asset => [asset.requirements.width, asset.requirements.height]), [
      [width * 2, height * 2],
    ], formatId);
    assert.deepEqual(format.canonical_parameters.params, {
      width,
      height,
      pixel_ratios: [2],
    }, formatId);
  }

  for (const [width, height] of expectedSizes) {
    const formatId = `display_${width}x${height}_image_1x_2x`;
    const format = catalog.find(candidate => candidate.format_id.id === formatId);
    assert.ok(format, formatId);
    const imageAssets = format.assets.filter(asset => asset.asset_type === 'image');
    assert.deepEqual(
      imageAssets.map(asset => ({
        asset_id: asset.asset_id,
        asset_group_id: asset.asset_group_id,
        required: asset.required,
        width: asset.requirements.width,
        height: asset.requirements.height,
      })),
      [
        { asset_id: 'banner_image', asset_group_id: 'image_main', required: true, width, height },
        { asset_id: 'banner_image_2x', asset_group_id: 'image_main', required: true, width: width * 2, height: height * 2 },
      ],
      formatId,
    );
    assert.deepEqual(format.canonical_parameters.params.pixel_ratios, [1, 2], formatId);
    assert.deepEqual(format.canonical_parameters.params.slots[0].required_pixel_ratios, [1, 2], formatId);
  }
});
