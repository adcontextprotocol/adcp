#!/usr/bin/env bash
# Overlay in-repo compliance source onto @adcp/sdk's bundled cache so the
# storyboard runner sees current-PR fixtures instead of the SDK-published
# snapshot. Used by both .github/workflows/training-agent-storyboards.yml
# and scripts/run-storyboards-matrix.sh — keep them calling the same
# script so local pre-push and CI grade against the same overlay.
#
# Rebuilds the development compliance bundle first, then overlays the generated
# bundle. Copying raw source YAML is not enough: the SDK enumerates storyboards
# from index.json, so a brand-new universal/protocol/specialism file is
# invisible unless the index is regenerated.

set -euo pipefail

SRC="${SRC:-dist/compliance/latest}"
# SDK 5.13 moved the cache dir from `latest` to the AdCP version string
# (e.g. `3.0.0`). 5.23.0 renamed the package `@adcp/client` -> `@adcp/sdk`
# and the compliance bundle moved with it. Resolve whichever subdir
# exists so the overlay doesn't have to bump with every SDK release.
CACHE_ROOT="node_modules/@adcp/sdk/compliance/cache"
# SDK 6.11+ ships a `<version>.previous` sibling alongside `<version>` for
# downgrade rollback. The runner reads from `<version>` (per ADCP_VERSION),
# so the overlay MUST target that one — `find ... | head -1` picked
# `.previous` non-deterministically on Linux ext4 in CI and left the live
# cache with the SDK-bundled YAML.
#
# Strategy: read the SDK's pinned version from `node_modules/@adcp/sdk/ADCP_VERSION`
# when present (canonical source of truth — the runner reads it the same way),
# else fall back to the first non-`.previous` cache subdir.
ADCP_VERSION_FILE="node_modules/@adcp/sdk/ADCP_VERSION"
if [ -f "$ADCP_VERSION_FILE" ]; then
  PINNED_VERSION=$(tr -d '[:space:]' < "$ADCP_VERSION_FILE")
  DST="$CACHE_ROOT/$PINNED_VERSION"
else
  # Sort so the canonical version comes before `.previous` (the dot makes
  # `.previous` lexicographically larger). Filter out `.previous` defensively.
  DST=$(find "$CACHE_ROOT" -mindepth 1 -maxdepth 1 -type d 2>/dev/null \
    | grep -v '\.previous$' \
    | sort \
    | head -1)
  PINNED_VERSION=$(basename "$DST")
fi

if [ -z "$DST" ] || [ ! -d "$DST" ]; then
  echo "warning: SDK compliance cache not found under $CACHE_ROOT — skipping overlay"
  exit 0
fi

if [ "${SRC}" = "dist/compliance/latest" ]; then
  # Current storyboard source may reference request/response schema additions
  # from the same PR. Stage the development schema bundle into the SDK key that
  # the overlaid compliance index advertises below; otherwise the runner grades
  # new current YAML against the SDK-published schema snapshot.
  echo "Building development schema bundle for SDK schema cache overlay"
  node scripts/build-schemas.cjs
  CACHE_VERSION="${PINNED_VERSION:-$(basename "$DST")}"
  SCHEMA_STAGE_DIR=$(mktemp -d -t "adcp-schema-overlay.XXXXXX")
  (cd "dist/schemas/latest" && tar -cf - .) | (cd "$SCHEMA_STAGE_DIR" && tar -xf -)
  node - <<'NODE' "$SCHEMA_STAGE_DIR" "$CACHE_VERSION"
const fs = require('node:fs');
const path = require('node:path');
const [root, version] = process.argv.slice(2);

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(file);
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      const body = fs.readFileSync(file, 'utf8')
        .replaceAll('/schemas/latest/', `/schemas/${version}/`)
        .replaceAll('/schemas/latest"', `/schemas/${version}"`);
      if (file.split(path.sep).includes('bundled')) {
        const schema = JSON.parse(body);
        stripNestedIds(schema, true);
        fs.writeFileSync(file, `${JSON.stringify(schema, null, 2)}\n`);
      } else {
        fs.writeFileSync(file, body);
      }
    }
  }
}

function stripNestedIds(value, isRoot = false) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) stripNestedIds(item, false);
    return;
  }
  if (!isRoot) delete value.$id;
  for (const child of Object.values(value)) stripNestedIds(child, false);
}

walk(root);
const indexPath = path.join(root, 'index.json');
const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
index.version = version;
index.published_version = version;
index.adcp_version = version;
fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
NODE
  bash "$(dirname "$0")/stage-sdk-schema-bundle.sh" "$SCHEMA_STAGE_DIR" "$CACHE_VERSION"
  rm -rf "$SCHEMA_STAGE_DIR"

  # The storyboard runner still imports @adcp/sdk's generated Zod validators for
  # response checks. Those files are produced from the SDK-published schema
  # snapshot at package build time, so staging the current JSON Schema bundle is
  # not enough for same-PR compliance_testing.scenarios additions. Patch the
  # installed generated validators for the local/CI current-source run; released
  # 3.0 compatibility runs skip this overlay and keep the SDK snapshot intact.
  node - <<'NODE'
const fs = require('node:fs');

function patchFile(file) {
  if (!fs.existsSync(file)) return;
  const backup = `${file}.adcp-overlay-backup`;
  if (!fs.existsSync(backup)) {
    fs.copyFileSync(file, backup);
  }
  let text = fs.readFileSync(file, 'utf8');
  const legacyCapabilities =
    'zod_1.z.literal("force_creative_status"), zod_1.z.literal("force_account_status"), zod_1.z.literal("force_media_buy_status"), zod_1.z.literal("force_session_status"), zod_1.z.literal("simulate_delivery"), zod_1.z.literal("simulate_budget_spend")]))';
  const partialCapabilities =
    'zod_1.z.literal("force_creative_status"), zod_1.z.literal("force_account_status"), zod_1.z.literal("force_media_buy_status"), zod_1.z.literal("force_create_media_buy_arm"), zod_1.z.literal("force_task_completion"), zod_1.z.literal("force_session_status"), zod_1.z.literal("simulate_delivery"), zod_1.z.literal("simulate_budget_spend"), zod_1.z.literal("seed_measurement_catalog")]))';
  const currentCapabilities =
    'zod_1.z.literal("force_creative_status"), zod_1.z.literal("force_account_status"), zod_1.z.literal("force_media_buy_status"), zod_1.z.literal("force_create_media_buy_arm"), zod_1.z.literal("force_task_completion"), zod_1.z.literal("force_creative_purge"), zod_1.z.literal("force_session_status"), zod_1.z.literal("simulate_delivery"), zod_1.z.literal("simulate_budget_spend"), zod_1.z.literal("seed_product"), zod_1.z.literal("seed_pricing_option"), zod_1.z.literal("seed_creative"), zod_1.z.literal("seed_plan"), zod_1.z.literal("seed_media_buy"), zod_1.z.literal("seed_creative_format"), zod_1.z.literal("seed_measurement_catalog"), zod_1.z.literal("query_upstream_traffic"), zod_1.z.literal("force_upstream_unavailable")]))';
  text = text.replace(legacyCapabilities, currentCapabilities);
  text = text.replace(partialCapabilities, currentCapabilities);
  text = text.replaceAll(
    'zod_1.z.literal("force_task_completion"), zod_1.z.literal("force_session_status")',
    'zod_1.z.literal("force_task_completion"), zod_1.z.literal("force_creative_purge"), zod_1.z.literal("force_session_status")',
  );
  text = text.replaceAll(
    'zod_1.z.literal("seed_creative_format")]))',
    'zod_1.z.literal("seed_creative_format"), zod_1.z.literal("seed_measurement_catalog")]))',
  );
  fs.writeFileSync(file, text);
}

patchFile('node_modules/@adcp/sdk/dist/lib/types/schemas.generated.js');
NODE

  echo "Building development compliance bundle for SDK cache overlay"
  node scripts/build-compliance.cjs
fi

echo "Overlaying $SRC onto $DST"
(cd "$SRC" && find . -type f) | while read -r rel; do
  target="$DST/${rel#./}"
  mkdir -p "$(dirname "$target")"
  cp "$SRC/${rel#./}" "$target"
done
if [ "${SRC}" = "dist/compliance/latest" ] && [ -n "${PINNED_VERSION:-}" ] && [ -f "$DST/index.json" ]; then
  # The development bundle is published as `latest`, but SDK 8 validates
  # `adcp_version` as a real version string when loading the cache. The cache
  # directory is already the SDK's pinned version, so stamp the copied index to
  # match while keeping the current-source storyboard contents.
  node - <<'NODE' "$DST/index.json" "$PINNED_VERSION"
const fs = require('node:fs');
const [file, version] = process.argv.slice(2);
const index = JSON.parse(fs.readFileSync(file, 'utf8'));
index.published_version = version;
index.adcp_version = version;
fs.writeFileSync(file, `${JSON.stringify(index, null, 2)}\n`);
NODE
fi
echo "Overlay complete."
