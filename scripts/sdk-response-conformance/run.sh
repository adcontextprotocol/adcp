#!/usr/bin/env bash
set -euo pipefail
# Run from the repository root. Dependencies: npm ci, pinned requirements.txt,
# Go from go/go.mod. No partner credentials or external agent URLs are used.
#
# Each SDK is graded against the newest immutable artifact it actually bundles.
# A single shared pin is not possible while the language waves are staggered:
# @adcp/sdk 14.0.0-rc.36 bundles 3.2.0-rc.2 and rejects 3.2.0-rc.1, while
# adcp 8.0.0b14 and adcp/v3 v3.2.1 bundle 3.2.0-rc.1 and reject 3.2.0-rc.2.
# Collapse these back to one release as soon as the waves converge.
output_dir=${1:-.context/sdk-response-conformance}
ts_release=${2:-3.2.0-rc.2}
py_release=${3:-3.2.0-rc.1}
go_release=${4:-3.2.0-rc.1}
mkdir -p "$output_dir"
output_dir=$(cd "$output_dir" && pwd)
for release in $(printf '%s\n' "$ts_release" "$py_release" "$go_release" | sort -u); do
  node scripts/probe-sdk-response-conformance.cjs prepare "$release" > "$output_dir/plan-$release.json" || exit 2
done
node scripts/sdk-response-conformance/typescript.cjs "$output_dir/plan-$ts_release.json" > "$output_dir/typescript.json" || exit 2
python3 scripts/sdk-response-conformance/python.py "$output_dir/plan-$py_release.json" > "$output_dir/python.json" || exit 2
(cd scripts/sdk-response-conformance/go && go run . "$output_dir/plan-$go_release.json") > "$output_dir/go.json" || exit 2
node scripts/probe-sdk-response-conformance.cjs report \
  "$output_dir/plan-$ts_release.json" "$output_dir/typescript.json" \
  "$output_dir/plan-$py_release.json" "$output_dir/python.json" \
  "$output_dir/plan-$go_release.json" "$output_dir/go.json" > "$output_dir/report.json"
