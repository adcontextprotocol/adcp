#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Backfill AdCP static release artifacts to a Cloudflare R2 bucket.

Usage:
  scripts/backfill-cdn-artifacts.sh --bucket BUCKET [options]

Options:
  --bucket NAME       Destination R2 bucket name. Can also be set with
                      ADCP_ARTIFACT_R2_BUCKET.
  --endpoint URL      R2 S3 endpoint. Defaults to R2_ENDPOINT or
                      https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com.
  --env-file PATH     Load credentials from an env file. Default: .env.local
                      when present.
  --dry-run           Print the planned AWS sync/cp operations.
  --aws-dry-run       Execute AWS with --dryrun. Very verbose: AWS prints
                      every object it would upload.
  --build-latest      Rebuild dist/*/latest and dist/protocol/latest.tgz first.
  --skip-latest       Upload only versioned artifacts; do not update mutable
                      schemas/latest, compliance/latest, or protocol/latest.
  --apply-cors        Apply public read CORS config to the bucket via Wrangler.
  --quiet             Pass --only-show-errors to aws s3 operations.
  -h, --help          Show this help.

Required credentials:
  AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and R2_ACCOUNT_ID or R2_ENDPOINT.

The destination object layout preserves the public URL contract:
  r2://BUCKET/schemas/...
  r2://BUCKET/compliance/...
  r2://BUCKET/protocol/...

Fly remains the app origin/fallback. Cloudflare should route the public
adcontextprotocol.org paths to these R2 objects once shadow validation passes.
USAGE
}

bucket="${ADCP_ARTIFACT_R2_BUCKET:-}"
endpoint="${R2_ENDPOINT:-}"
env_file=""
dry_run=0
aws_dry_run=0
build_latest=0
skip_latest=0
apply_cors=0
quiet=0

if [[ -f ".env.local" ]]; then
  env_file=".env.local"
fi

require_option_value() {
  local option="$1"
  local value="${2:-}"
  if [[ -z "$value" || "$value" == -* ]]; then
    echo "$option requires a value." >&2
    exit 2
  fi
  printf '%s' "$value"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bucket)
      bucket="$(require_option_value "$1" "${2:-}")"
      shift 2
      ;;
    --endpoint)
      endpoint="$(require_option_value "$1" "${2:-}")"
      shift 2
      ;;
    --env-file)
      env_file="$(require_option_value "$1" "${2:-}")"
      shift 2
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    --aws-dry-run)
      dry_run=1
      aws_dry_run=1
      shift
      ;;
    --build-latest)
      build_latest=1
      shift
      ;;
    --skip-latest)
      skip_latest=1
      shift
      ;;
    --apply-cors)
      apply_cors=1
      shift
      ;;
    --delete)
      echo "--delete is intentionally unsupported by this helper; remove stale CDN objects manually." >&2
      exit 2
      ;;
    --quiet)
      quiet=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -n "$env_file" ]]; then
  if [[ ! -f "$env_file" ]]; then
    echo "Env file not found: $env_file" >&2
    exit 2
  fi
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
  endpoint="${endpoint:-${R2_ENDPOINT:-}}"
  bucket="${bucket:-${ADCP_ARTIFACT_R2_BUCKET:-}}"
fi

if [[ -z "$bucket" ]]; then
  echo "Missing destination bucket. Pass --bucket BUCKET or set ADCP_ARTIFACT_R2_BUCKET." >&2
  exit 2
fi

if [[ "$bucket" == gs://* || "$bucket" == s3://* || "$bucket" == r2://* ]]; then
  echo "Pass the R2 bucket name only, not a URL: $bucket" >&2
  exit 2
fi

if [[ -z "$endpoint" && -n "${R2_ACCOUNT_ID:-}" ]]; then
  endpoint="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
fi

if [[ -z "$endpoint" ]]; then
  echo "Missing R2 endpoint. Set R2_ENDPOINT or R2_ACCOUNT_ID, or pass --endpoint." >&2
  exit 2
fi

if [[ -z "${AWS_ACCESS_KEY_ID:-}" || -z "${AWS_SECRET_ACCESS_KEY:-}" ]]; then
  echo "Missing AWS_ACCESS_KEY_ID or AWS_SECRET_ACCESS_KEY for R2 S3 API access." >&2
  exit 2
fi

if ! command -v aws >/dev/null 2>&1; then
  echo "aws CLI is required for bulk R2 uploads." >&2
  exit 1
fi

if [[ "$apply_cors" -eq 1 ]] && [[ "$dry_run" -eq 0 ]] && ! command -v wrangler >/dev/null 2>&1; then
  echo "wrangler is required for --apply-cors." >&2
  exit 1
fi

export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-auto}"

if [[ "$build_latest" -eq 1 ]]; then
  npm run build:schemas
  npm run build:compliance
  npm run build:protocol-tarball
fi

for dir in dist/schemas dist/compliance dist/protocol; do
  if [[ ! -d "$dir" ]]; then
    echo "Required artifact directory is missing: $dir" >&2
    exit 1
  fi
done

if [[ "$skip_latest" -eq 0 && ( ! -d dist/schemas/latest || ! -d dist/compliance/latest || ! -f dist/protocol/latest.tgz ) ]]; then
  cat >&2 <<'WARN'
Warning: one or more latest artifacts are missing.
Run with --build-latest if this checkout has not already run the artifact build.
WARN
fi

planned_count="$(find dist/schemas dist/compliance dist/protocol -type f ! -path '*/.staging/*' | wc -l | tr -d ' ')"
planned_bytes="$(du -sk dist/schemas dist/compliance dist/protocol | awk '{sum += $1} END {printf "%.0f", sum * 1024}')"

common_aws_args=(--endpoint-url "$endpoint" --no-cli-pager --no-progress --region "$AWS_DEFAULT_REGION")
if [[ "$aws_dry_run" -eq 1 ]]; then
  common_aws_args+=(--dryrun)
fi
if [[ "$quiet" -eq 1 ]]; then
  common_aws_args+=(--only-show-errors)
fi

apply_bucket_cors() {
  local cors_file
  cors_file="$(mktemp)"
  cat > "$cors_file" <<'JSON'
{
  "rules": [
    {
      "allowed": {
        "origins": ["*"],
        "methods": ["GET", "HEAD"],
        "headers": ["*"]
      },
      "exposeHeaders": ["Content-Type", "Cache-Control", "ETag", "Last-Modified"],
      "maxAgeSeconds": 3600
    }
  ]
}
JSON
  wrangler r2 bucket cors set "$bucket" --file "$cors_file" --force
  rm -f "$cors_file"
}

run_cmd() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
  if [[ "$dry_run" -eq 1 && "$aws_dry_run" -eq 0 ]]; then
    return 0
  fi
  "$@"
}

sync_filtered() {
  local source_dir="$1"
  local dest_prefix="$2"
  local cache_control="$3"
  local content_type="$4"
  shift 4
  local patterns=("$@")
  local args=(
    s3 sync
    "$source_dir"
    "s3://${bucket}/${dest_prefix}"
    "${common_aws_args[@]}"
    --no-follow-symlinks
    --size-only
    --no-guess-mime-type
    --cache-control "$cache_control"
    --content-type "$content_type"
    --exclude "*"
  )
  local pattern
  for pattern in "${patterns[@]}"; do
    args+=(--include "$pattern")
  done
  if [[ "${exclude_latest:-0}" -eq 1 ]]; then
    args+=(--exclude "latest/*")
  fi
  run_cmd aws "${args[@]}"
}

cp_filtered_recursive() {
  local source_dir="$1"
  local dest_prefix="$2"
  local cache_control="$3"
  local content_type="$4"
  shift 4
  local patterns=("$@")
  local args=(
    s3 cp
    "$source_dir"
    "s3://${bucket}/${dest_prefix}"
    --recursive
    "${common_aws_args[@]}"
    --no-follow-symlinks
    --no-guess-mime-type
    --cache-control "$cache_control"
    --content-type "$content_type"
    --exclude "*"
  )
  local pattern
  for pattern in "${patterns[@]}"; do
    args+=(--include "$pattern")
  done
  run_cmd aws "${args[@]}"
}

cp_file() {
  local file="$1"
  local dest_key="$2"
  local cache_control="$3"
  local content_type="$4"
  run_cmd aws s3 cp "$file" "s3://${bucket}/${dest_key}" \
    "${common_aws_args[@]}" \
    --no-guess-mime-type \
    --cache-control "$cache_control" \
    --content-type "$content_type"
}

sync_schema_tree() {
  local root="$1"
  local dest_prefix="$2"
  local cache_control="$3"
  sync_filtered "$root" "$dest_prefix" "$cache_control" "application/json; charset=utf-8" "*.json"
}

cp_schema_tree() {
  local root="$1"
  local dest_prefix="$2"
  local cache_control="$3"
  cp_filtered_recursive "$root" "$dest_prefix" "$cache_control" "application/json; charset=utf-8" "*.json"
}

sync_compliance_tree() {
  local root="$1"
  local dest_prefix="$2"
  local cache_control="$3"
  sync_filtered "$root" "$dest_prefix" "$cache_control" "application/yaml; charset=utf-8" "*.yaml" "*.yml"
  sync_filtered "$root" "$dest_prefix" "$cache_control" "application/json; charset=utf-8" "*.json"
  sync_filtered "$root" "$dest_prefix" "$cache_control" "text/markdown; charset=utf-8" "*.md" "*.mdx"
  sync_filtered "$root" "$dest_prefix" "$cache_control" "text/plain; charset=utf-8" "*.txt"
}

cp_compliance_tree() {
  local root="$1"
  local dest_prefix="$2"
  local cache_control="$3"
  cp_filtered_recursive "$root" "$dest_prefix" "$cache_control" "application/yaml; charset=utf-8" "*.yaml" "*.yml"
  cp_filtered_recursive "$root" "$dest_prefix" "$cache_control" "application/json; charset=utf-8" "*.json"
  cp_filtered_recursive "$root" "$dest_prefix" "$cache_control" "text/markdown; charset=utf-8" "*.md" "*.mdx"
  cp_filtered_recursive "$root" "$dest_prefix" "$cache_control" "text/plain; charset=utf-8" "*.txt"
}

if [[ "$apply_cors" -eq 1 ]]; then
  if [[ "$dry_run" -eq 1 ]]; then
    echo "Would apply public GET/HEAD CORS config to R2 bucket $bucket"
  else
    apply_bucket_cors
  fi
fi

immutable_cache="public, max-age=31536000, immutable"
revalidate_cache="public, no-cache, must-revalidate"

exclude_latest=1 sync_schema_tree dist/schemas schemas "$immutable_cache"
if [[ "$skip_latest" -eq 0 && -d dist/schemas/latest ]]; then
  cp_schema_tree dist/schemas/latest schemas/latest "$revalidate_cache"
fi

exclude_latest=1 sync_compliance_tree dist/compliance compliance "$immutable_cache"
if [[ "$skip_latest" -eq 0 && -d dist/compliance/latest ]]; then
  cp_compliance_tree dist/compliance/latest compliance/latest "$revalidate_cache"
fi

exclude_latest=1 sync_filtered dist/protocol protocol "$immutable_cache" "application/gzip" "*.tgz"
exclude_latest=1 sync_filtered dist/protocol protocol "$immutable_cache" "text/plain; charset=utf-8" "*.sha256"
exclude_latest=1 sync_filtered dist/protocol protocol "$immutable_cache" "application/octet-stream" "*.sig"
exclude_latest=1 sync_filtered dist/protocol protocol "$immutable_cache" "application/x-pem-file" "*.crt"

if [[ "$skip_latest" -eq 0 && -f dist/protocol/latest.tgz ]]; then
  cp_file dist/protocol/latest.tgz protocol/latest.tgz "$revalidate_cache" "application/gzip"
fi
if [[ "$skip_latest" -eq 0 && -f dist/protocol/latest.tgz.sha256 ]]; then
  cp_file dist/protocol/latest.tgz.sha256 protocol/latest.tgz.sha256 "$revalidate_cache" "text/plain; charset=utf-8"
fi
if [[ "$skip_latest" -eq 0 && -f dist/protocol/latest.tgz.sig ]]; then
  cp_file dist/protocol/latest.tgz.sig protocol/latest.tgz.sig "$revalidate_cache" "application/octet-stream"
fi
if [[ "$skip_latest" -eq 0 && -f dist/protocol/latest.tgz.crt ]]; then
  cp_file dist/protocol/latest.tgz.crt protocol/latest.tgz.crt "$revalidate_cache" "application/x-pem-file"
fi

printf 'Planned source set: %s files (%s bytes) for r2://%s via %s\n' "$planned_count" "$planned_bytes" "$bucket" "$endpoint"
