#!/usr/bin/env bash
set -euo pipefail
# Run from the repository root. Dependencies: npm ci, pinned requirements.txt,
# Go from go/go.mod. No partner credentials or external agent URLs are used.
output_dir=${1:-.context/sdk-response-conformance}
typescript_release=${2:-3.2.0-rc.3}
python_go_release=${3:-3.2.0-rc.1}
mkdir -p "$output_dir"
output_dir=$(cd "$output_dir" && pwd)
node scripts/probe-sdk-response-conformance.cjs prepare "$typescript_release" > "$output_dir/plan-typescript.json" || exit 2
node scripts/probe-sdk-response-conformance.cjs prepare "$python_go_release" > "$output_dir/plan-python-go.json" || exit 2
node scripts/sdk-response-conformance/typescript.cjs "$output_dir/plan-typescript.json" > "$output_dir/typescript.json" || exit 2
python3 scripts/sdk-response-conformance/python.py "$output_dir/plan-python-go.json" > "$output_dir/python.json" || exit 2
(cd scripts/sdk-response-conformance/go && go run . "$output_dir/plan-python-go.json") > "$output_dir/go.json" || exit 2
node scripts/probe-sdk-response-conformance.cjs report-matrix \
  "$output_dir/plan-typescript.json" "$output_dir/typescript.json" \
  "$output_dir/plan-python-go.json" "$output_dir/python.json" \
  "$output_dir/plan-python-go.json" "$output_dir/go.json" \
  > "$output_dir/report.json"
