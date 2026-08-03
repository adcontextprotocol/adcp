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

function validateImageRenditionSet(params, slot, assets) {
  const acceptedRatios = slot.pixel_ratios ?? params.pixel_ratios ?? [1];
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
      : validateImageDensity(vector.params, vector.asset);
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

test('3.1 legacy 2x catalog formats require paired 1x and 2x assets', () => {
  const catalog = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../server/src/creative-agent/reference-formats.json'),
    'utf8',
  ));
  const expectedSizes = new Map([
    ['display_300x250_image_2x', [300, 250]],
    ['display_728x90_image_2x', [728, 90]],
    ['display_320x50_image_2x', [320, 50]],
    ['display_160x600_image_2x', [160, 600]],
    ['display_336x280_image_2x', [336, 280]],
    ['display_300x600_image_2x', [300, 600]],
    ['display_970x250_image_2x', [970, 250]],
  ]);

  for (const [formatId, [width, height]] of expectedSizes) {
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
