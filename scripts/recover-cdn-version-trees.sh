#!/usr/bin/env bash
# Recover a released stable version's immutable schema and compliance trees on
# the artifact CDN, or verify that the public CDN serves them byte-exact.
#
# Why this exists: a release whose `schemas/<version>/` and
# `compliance/<version>/` objects never reached R2 does not 404. The CDN
# worker's pinned-semver fallback resolves the request to the nearest published
# release on the line, so a consumer pinning the missing version silently gets
# an older release's bytes, and the schema discovery pointers keep that line
# pinned one release back (#8318, #8324, #8347). `release.yml` cannot republish
# a historical version (`check-release-state.cjs committed` requires the local,
# current-tested and original committed package versions to be equal), routine
# deployment excludes every semver path, and live bulk backfill is disabled.
#
# Authority model (RELEASING.md "Publication authority and ordering"):
#
# - The caller checks out tag `v$VERSION`, verifies the signed protocol tuple
#   with cosign bound to `release.yml`, and runs `check-release-state.cjs
#   published` to bind that tag to its GitHub Release and to the committed
#   tuple bytes. This script re-checks the tarball checksum, then proves that
#   the trees it is about to publish are byte-for-byte the trees inside that
#   signed tarball, so the release signature transitively covers every object
#   it writes.
# - Every byte comes from `git cat-file blob`, never the working tree and never
#   `git archive` (which applies the tag's own `.gitattributes`, so
#   `export-subst` would splice commit text into published bytes).
# - This script, the fence and the parity checker are supplied by the caller
#   from the current reviewed branch, never from the checked-out tag.
# - Writes are conditional (`If-None-Match: *`). An object that already exists
#   must already match byte-for-byte; nothing is ever overwritten or deleted.
# - The current-branch publication fence runs before and after every write.
#
# Usage: recover-cdn-version-trees.sh <upload|verify>
#
# Environment:
#   VERSION               exact semver, optionally -beta.N / -rc.N (required)
#   FENCE_SCRIPT          path to the preserved check-release-state.cjs
#   PARITY_SCRIPT         path to the preserved check-protocol-bundle-parity.cjs
#   BUCKET                destination R2 bucket (upload only)
#   R2_ENDPOINT           or R2_ACCOUNT_ID (upload only)
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (upload only)
#   CDN_BASE_URL          public origin to verify (default adcontextprotocol.org)
#   CDN_VERIFY_ATTEMPTS   verification attempts before failing (default 5)

set -euo pipefail

mode="${1:-}"
if [[ "$mode" != upload && "$mode" != verify ]]; then
  echo "::error::Usage: recover-cdn-version-trees.sh <upload|verify>" >&2
  exit 2
fi

die() {
  echo "::error::$1" >&2
  echo "Recovery stopped. See RELEASING.md \"Recovering a release's CDN artifacts\"." >&2
  exit 1
}

VERSION="${VERSION:-}"
# Exact semver, optionally -beta.N or -rc.N, matching recover-protocol-cdn.yml.
# Authority is the published-release fence: an unpublished prerelease is refused.
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-(beta|rc)\.[0-9]+)?$ ]] ||
  die "VERSION must be an exact semver, optionally -beta.N or -rc.N (for example, 3.0.27)"
version_re="${VERSION//./\\.}"

FENCE_SCRIPT="${FENCE_SCRIPT:-}"
PARITY_SCRIPT="${PARITY_SCRIPT:-}"
[[ -f "$FENCE_SCRIPT" ]] || die "FENCE_SCRIPT must point at the preserved publication fence"
[[ -f "$PARITY_SCRIPT" ]] || die "PARITY_SCRIPT must point at the preserved bundle parity checker"

cdn_base_url="${CDN_BASE_URL:-https://adcontextprotocol.org}"
attempts="${CDN_VERIFY_ATTEMPTS:-5}"
[[ "$attempts" =~ ^[1-9][0-9]*$ ]] || die "CDN_VERIFY_ATTEMPTS must be a positive integer"
immutable_cache="public, max-age=31536000, immutable"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f1
  else
    return 1
  fi
}

# R2 reports a single-part object's ETag as the hex MD5 of its bytes, and
# `aws s3api put-object` is always single part. That makes the served ETag a
# direct statement about the object in the bucket, which is what verification
# below needs. MD5 is used here only as R2's object identifier, never as a
# security property: the bytes themselves are compared too.
md5_of() {
  if command -v md5sum >/dev/null 2>&1; then
    md5sum "$1" | cut -d ' ' -f1
  elif command -v md5 >/dev/null 2>&1; then
    md5 -q "$1"
  else
    return 1
  fi
}

work=""
cleanup() {
  if [[ -n "$work" ]]; then rm -rf -- "$work"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
work="$(mktemp -d "${TMPDIR:-/tmp}/adcp-cdn-recovery.XXXXXX")"
chmod 700 "$work"

# Upload starts on the strict fence, so a stale re-run stops before any write.
# Per-object fences below use publication-current, mirroring release.yml's
# strict start. Verify is read-only and runs after this run's own upload
# passed that strict start, so it uses publication-current too: an unrelated
# push during the upload must not fail verification of a completed upload.
if [[ "$mode" == upload ]]; then
  node "$FENCE_SCRIPT" current </dev/null
else
  node "$FENCE_SCRIPT" publication-current "$VERSION" </dev/null
fi

actual_version="$(node -p "require('./package.json').version || ''" </dev/null)"
[[ "$actual_version" == "$VERSION" ]] ||
  die "checkout holds package version ${actual_version:-none}, not ${VERSION}"

tuple="dist/protocol/${VERSION}.tgz"
for suffix in "" .sha256 .sig .crt; do
  git cat-file -e "HEAD:${tuple}${suffix}" 2>/dev/null ||
    die "missing ${tuple}${suffix} in the checked-out release"
done

# ---------------------------------------------------------------------------
# Enumerate the released trees from the tag's Git objects.
# ---------------------------------------------------------------------------

schemas_root="dist/schemas/${VERSION}"
compliance_root="dist/compliance/${VERSION}"

# A path's extension decides the content type the CDN will serve it with. An
# unmapped extension fails the whole run rather than publishing a tree with a
# silently mistyped hole in it, which is the same class of bug as the missing
# directory this recovers.
content_type_for() {
  case "$1" in
    *.jsonl) printf 'application/x-ndjson; charset=utf-8' ;;
    *.json) printf 'application/json; charset=utf-8' ;;
    *.yaml | *.yml) printf 'application/yaml; charset=utf-8' ;;
    *.md | *.mdx) printf 'text/markdown; charset=utf-8' ;;
    *.txt) printf 'text/plain; charset=utf-8' ;;
    *) printf '' ;;
  esac
}

# Validate while the enumeration is still NUL-delimited. A path containing a
# newline would otherwise split into two plausible-looking lines downstream.
tree_list="$work/tree.list"
: > "$tree_list"
while IFS= read -r -d '' row; do
  meta="${row%%$'\t'*}"
  file="${row#*$'\t'}"
  read -r mode_bits object_type _oid <<< "$meta"
  # Regular blobs only: a symlink, submodule or subtree entry here would let
  # publication read bytes the release never committed at that path.
  [[ "$object_type" == blob && ( "$mode_bits" == 100644 || "$mode_bits" == 100755 ) ]] ||
    die "unsupported Git entry in the released trees: ${file}"
  key="${file#dist/}"
  # Keys become R2 keys and public URLs. Hold them to an unambiguous charset so
  # neither needs escaping and neither can be reinterpreted.
  [[ "$key" =~ ^(schemas|compliance)/${version_re}/[A-Za-z0-9][A-Za-z0-9._/-]*$ && "$key" != *..* ]] ||
    die "unsupported released artifact path: ${file}"
  [[ -n "$(content_type_for "$key")" ]] ||
    die "no published content type for ${key}; recovery would leave the tree incomplete"
  printf '%s\n' "$file" >> "$tree_list"
done < <(git ls-tree -r -z HEAD -- "$schemas_root" "$compliance_root")

LC_ALL=C sort -o "$tree_list" "$tree_list"
[[ -s "$tree_list" ]] || die "release ${VERSION} commits no schema or compliance tree"
[[ "$(LC_ALL=C sort -u "$tree_list" | wc -l)" == "$(wc -l < "$tree_list")" ]] ||
  die "ambiguous duplicate paths in the released trees"

for root in "$schemas_root" "$compliance_root"; do
  awk -v prefix="${root}/" '
    index($0, prefix) == 1 { tree = 1 }
    $0 == prefix "index.json" { manifest = 1 }
    END { exit tree ? (manifest ? 0 : 2) : 1 }
  ' "$tree_list" && continue
  case "$?" in
    1) die "release ${VERSION} commits no ${root}" ;;
    *) die "release ${VERSION} commits ${root} without an index.json" ;;
  esac
done

# Materialize each blob exactly as committed. `git archive` would be one
# command, but it runs the tag's own `.gitattributes` filters (`export-subst`
# splices the commit subject into the output, `export-ignore` drops files), so
# its bytes are not the blob's bytes. `git cat-file blob` is attribute-immune,
# which is why backfill-cdn-artifacts.sh uses it too.
released="$work/released"
while IFS= read -r file; do
  mkdir -p "${released}/$(dirname "$file")"
  git cat-file blob "HEAD:${file}" > "${released}/${file}"
done < "$tree_list"
[[ "$(find "$released" -type f | wc -l)" == "$(wc -l < "$tree_list")" ]] ||
  die "materialized release trees do not match the committed file set"

# ---------------------------------------------------------------------------
# Bind the trees to the release signature through the signed tarball.
# ---------------------------------------------------------------------------

tuple_dir="$work/tuple"
bundle="$work/bundle"
mkdir -p "$tuple_dir" "$bundle"
for suffix in "" .sha256; do
  git cat-file blob "HEAD:${tuple}${suffix}" > "${tuple_dir}/${VERSION}.tgz${suffix}"
done
expected_digest="$(cut -d ' ' -f1 < "${tuple_dir}/${VERSION}.tgz.sha256")"
[[ "$(sha256_of "${tuple_dir}/${VERSION}.tgz")" == "$expected_digest" ]] ||
  die "committed protocol tarball ${VERSION}.tgz fails its committed checksum"
tar -xzf "${tuple_dir}/${VERSION}.tgz" -C "$bundle" --no-same-owner --no-same-permissions
# cosign's --certificate-identity-regexp binds the signing workflow, not the
# version: a renamed copy of another release's signed tuple would verify. The
# bundle's root directory name is the only thing that ties the signature to
# this version, so it is load-bearing, not a sanity check.
[[ -d "${bundle}/adcp-${VERSION}" ]] ||
  die "signed protocol bundle has no adcp-${VERSION} root directory"
node "$PARITY_SCRIPT" "$VERSION" "$released" "${bundle}/adcp-${VERSION}" </dev/null

# Pin what parity just proved. Publication walks these files one at a time over
# a long run; re-checking each digest immediately before its write keeps the
# proof attached to the exact bytes handed to AWS. The MD5 column is R2's
# object identifier, used by verification below.
digest_list="$work/digests"
: > "$digest_list"
while IFS= read -r file; do
  printf '%s %s %s\n' \
    "$(sha256_of "${released}/${file}")" "$(md5_of "${released}/${file}")" "$file" >> "$digest_list"
done < "$tree_list"

total="$(wc -l < "$tree_list" | tr -d ' ')"

if [[ "$mode" == upload ]]; then
  BUCKET="${BUCKET:-}"
  endpoint="${R2_ENDPOINT:-}"
  if [[ -z "$endpoint" && -n "${R2_ACCOUNT_ID:-}" ]]; then
    endpoint="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
  fi
  [[ -n "$BUCKET" ]] || die "Missing destination bucket"
  [[ "$BUCKET" =~ ^[a-z0-9][a-z0-9.-]{1,62}$ ]] ||
    die "BUCKET must be a bucket name, not a URL: ${BUCKET}"
  [[ -n "$endpoint" ]] || die "Missing R2 endpoint"
  [[ -n "${AWS_ACCESS_KEY_ID:-}" && -n "${AWS_SECRET_ACCESS_KEY:-}" ]] ||
    die "Missing R2 publication credentials"
  export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-auto}"
  # Bound every S3 call the way the verification fetches are bounded. The run
  # makes three calls per object over a long loop; a single stalled socket on
  # CLI defaults would hang the publication rather than fail it.
  aws_timeouts=(--cli-connect-timeout 20 --cli-read-timeout 120)

  existing_body="$work/existing"
  existing_type="$work/existing-type"
  head_error="$work/head-error"
  created=0
  verified=0

  while read -r digest _md5 file <&3; do
    key="${file#dist/}"
    body_path="${released}/${file}"
    content_type="$(content_type_for "$key")"
    [[ "$(sha256_of "$body_path")" == "$digest" ]] ||
      die "publication body for ${key} changed after the signature proof"

    node "$FENCE_SCRIPT" publication-current "$VERSION" </dev/null
    rm -f "$existing_body" "$existing_type" "$head_error"
    if aws s3api head-object --bucket "$BUCKET" --key "$key" \
        --endpoint-url "$endpoint" --region "$AWS_DEFAULT_REGION" \
        --no-cli-pager --query ContentType --output text "${aws_timeouts[@]}" \
        </dev/null >"$existing_type" 2>"$head_error"; then
      aws s3 cp "s3://${BUCKET}/${key}" "$existing_body" \
        --endpoint-url "$endpoint" --region "$AWS_DEFAULT_REGION" \
        --no-cli-pager --no-progress --only-show-errors "${aws_timeouts[@]}" </dev/null
      cmp -s "$body_path" "$existing_body" ||
        die "R2 object ${key} exists with different bytes; refusing overwrite"
      # Right bytes served under the wrong type is the same silent-wrong-answer
      # failure this recovers, and no-overwrite means it cannot be repaired
      # here. Stop rather than report it as verified.
      [[ "$(tr -d '\r\n' < "$existing_type")" == "$content_type" ]] ||
        die "R2 object ${key} exists with content type $(tr -d '\r\n' < "$existing_type"), not ${content_type}"
      verified=$((verified + 1))
    else
      # "Cannot tell" must never read as "absent": only a confirmed missing
      # object may lead to a write.
      if ! grep -Eq 'An error occurred \(404\)|\(NoSuchKey\)' "$head_error"; then
        cat "$head_error" >&2
        die "Could not safely determine whether R2 object ${key} exists"
      fi
      node "$FENCE_SCRIPT" publication-current "$VERSION" </dev/null
      [[ "$(sha256_of "$body_path")" == "$digest" ]] ||
        die "publication body for ${key} changed before its write"
      aws s3api put-object --bucket "$BUCKET" --key "$key" --body "$body_path" \
        --if-none-match '*' --endpoint-url "$endpoint" \
        --region "$AWS_DEFAULT_REGION" --no-cli-pager \
        --cache-control "$immutable_cache" --content-type "$content_type" \
        "${aws_timeouts[@]}" </dev/null >/dev/null
      created=$((created + 1))
    fi
    node "$FENCE_SCRIPT" publication-current "$VERSION" </dev/null
  done 3< "$digest_list"

  rm -f "$existing_body" "$existing_type" "$head_error"
  # A short loop would mean the publication set was not what was proved.
  [[ $((created + verified)) -eq "$total" ]] ||
    die "published ${created}+${verified} of ${total} objects; the publication set is incomplete"
  echo "Recovered ${VERSION}: created ${created} missing object(s), verified ${verified} existing object(s) of ${total}."
  exit 0
fi

# ---------------------------------------------------------------------------
# verify: uploading is not serving.
# ---------------------------------------------------------------------------

download_dir="$work/cdn"
config="$work/curl.config"
report="$work/cdn-report"
observed="$work/cdn-observed"
expected="$work/cdn-expected"

# What each object must answer with. The ETag is the decisive column: a byte
# comparison alone cannot prove the object is in R2, because on a miss the
# worker proxies to the Fly origin, which serves the same committed tree *and*
# stamps the same immutable policy for an exact pinned semver hit
# (server/src/schemas-middleware.ts). R2 reports a single-part ETag as the
# body's hex MD5, so requiring it proves a bucket object with exactly these
# bytes is what answered.
: > "$expected"
while read -r _digest md5 file; do
  printf '%s 200 "%s" %s\n' "${file#dist/}" "$md5" "$immutable_cache" >> "$expected"
done < "$digest_list"
LC_ALL=C sort -o "$expected" "$expected"

verify_once() {
  local attempt="$1"
  local bust file key line url rest
  bust="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-${attempt}-$(date +%s)"
  rm -rf "$download_dir"
  mkdir -p "$download_dir"
  : > "$config"
  while IFS= read -r file; do
    key="${file#dist/}"
    mkdir -p "${download_dir}/$(dirname "$key")"
    printf 'fail\nlocation\nurl = "%s"\noutput = "%s"\n' \
      "${cdn_base_url}/${key}?cache_bust=${bust}" "${download_dir}/${key}" >> "$config"
  done < "$tree_list"

  # Bound every transfer. Without this a server that accepts the connection and
  # never answers hangs the job forever and the retry loop below never runs.
  if ! curl --silent --show-error --fail-early \
      --parallel --parallel-immediate --parallel-max 16 \
      --connect-timeout 20 --max-time 300 --speed-limit 1024 --speed-time 60 \
      --write-out '%{url_effective} %{http_code} %header{etag} %header{cache-control}\n' \
      --config "$config" > "$report"; then
    return 1
  fi

  # --parallel completes out of order, so correlate on the URL rather than
  # comparing line by line.
  : > "$observed"
  while IFS= read -r line; do
    url="${line%% *}"
    rest="${line#* }"
    key="${url#"${cdn_base_url}/"}"
    key="${key%%\?*}"
    printf '%s %s\n' "$key" "$rest" >> "$observed"
  done < "$report"
  LC_ALL=C sort -o "$observed" "$observed"

  if ! diff -q "$expected" "$observed" >/dev/null; then
    echo "CDN responses do not match the recovered ${VERSION} objects:" >&2
    diff "$expected" "$observed" | head -n 10 >&2
    echo "A missing or mismatched ETag means the bytes did not come from the bucket." >&2
    return 1
  fi

  while IFS= read -r file; do
    key="${file#dist/}"
    if ! cmp -s "${released}/${file}" "${download_dir}/${key}"; then
      echo "CDN object ${key} differs from the released bytes." >&2
      return 1
    fi
  done < "$tree_list"
  return 0
}

# The worker caches its published-version list for VERSION_CACHE_TTL_MS = 60s
# (workers/artifact-cdn/src/index.js), so a freshly created prefix can take
# that long to win an exact pinned hit. The cumulative backoff below reaches
# 60s at attempt 4; do not shrink it below that.
for attempt in $(seq 1 "$attempts"); do
  if verify_once "$attempt"; then
    echo "Public CDN serves all ${total} ${VERSION} schema and compliance objects byte-exact (attempt ${attempt})."
    exit 0
  fi
  if [[ "$attempt" != "$attempts" ]]; then
    echo "CDN verification failed on attempt ${attempt}; retrying."
    sleep $((attempt * 10))
  fi
done

die "public CDN does not serve the recovered ${VERSION} trees byte-exact"
