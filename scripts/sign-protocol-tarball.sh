#!/usr/bin/env bash
#
# Sign every dist/protocol/*.tgz with cosign keyless OIDC.
#
# Runs as the final step of `npm run version`, where it picks up the freshly
# built {version}.tgz and produces .sig + .crt sidecars next to it. The
# changesets release commit then carries signature, certificate, checksum,
# and tarball together.
#
# Signing only happens when explicitly opted in:
#   - GITHUB_ACTIONS=true (the release workflow), OR
#   - SIGN_PROTOCOL_TARBALL=true (manual override)
#
# Outside those, the script is a no-op so local `npm run version` doesn't
# trigger a browser OAuth flow. CI requires cosign on PATH; the workflow
# installs it via sigstore/cosign-installer.
#

set -euo pipefail

DIR="dist/protocol"

if [ ! -d "$DIR" ]; then
  echo "sign-protocol-tarball: $DIR not found, nothing to sign"
  exit 0
fi

shopt -s nullglob
tarballs=("$DIR"/*.tgz)
if [ ${#tarballs[@]} -eq 0 ]; then
  echo "sign-protocol-tarball: no .tgz files in $DIR"
  exit 0
fi

if [ "${GITHUB_ACTIONS:-}" != "true" ] && [ "${SIGN_PROTOCOL_TARBALL:-}" != "true" ]; then
  echo "ℹ sign-protocol-tarball: skipping (set SIGN_PROTOCOL_TARBALL=true to sign locally)"
  exit 0
fi

if ! command -v cosign >/dev/null 2>&1; then
  echo "❌ cosign not installed but signing was requested" >&2
  echo "   Install via sigstore/cosign-installer in CI or 'brew install cosign' locally" >&2
  exit 1
fi

signed=()
for tar in "${tarballs[@]}"; do
  name=$(basename "$tar")
  # latest.tgz is rebuilt frequently and gitignored — signing it would produce
  # sidecars that go stale immediately. Skip unless explicitly forced.
  if [ "$name" = "latest.tgz" ] && [ "${SIGN_LATEST_TARBALL:-}" != "true" ]; then
    echo "↷ Skipping $name (development bundle, rebuilt frequently)"
    continue
  fi

  echo "🔏 Signing $tar"
  COSIGN_YES=true cosign sign-blob \
    --yes \
    --output-signature "${tar}.sig" \
    --output-certificate "${tar}.crt" \
    "$tar"
  signed+=("${tar}.sig" "${tar}.crt")
done

if [ ${#signed[@]} -gt 0 ] && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git add "${signed[@]}" || true
fi

echo "✅ Signing complete"
