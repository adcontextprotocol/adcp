#!/usr/bin/env bash
#
# Sign the current dist/protocol/{version}.tgz with cosign keyless OIDC.
#
# Runs as the final step of `npm run version`, where it picks up the freshly
# built {version}.tgz and produces .sig + .crt sidecars next to it. Existing
# versioned sidecars are intentionally not overwritten: pinned release URLs
# are cacheable and must be treated as immutable once published.
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

if [ "${GITHUB_ACTIONS:-}" != "true" ] && [ "${SIGN_PROTOCOL_TARBALL:-}" != "true" ]; then
  echo "ℹ sign-protocol-tarball: skipping (set SIGN_PROTOCOL_TARBALL=true to sign locally)"
  exit 0
fi

DIR="dist/protocol"
CURRENT_VERSION="$(node -p "require('./package.json').version || ''" 2>/dev/null || true)"

if [ -z "$CURRENT_VERSION" ] && [ "${SIGN_ALL_PROTOCOL_TARBALLS:-}" != "true" ]; then
  echo "❌ Could not resolve package.json version for protocol tarball signing" >&2
  exit 1
fi

if [ ! -d "$DIR" ]; then
  echo "❌ sign-protocol-tarball: $DIR not found while signing was requested" >&2
  exit 1
fi

shopt -s nullglob
tarballs=("$DIR"/*.tgz)
if [ ${#tarballs[@]} -eq 0 ]; then
  echo "❌ sign-protocol-tarball: no .tgz files in $DIR while signing was requested" >&2
  exit 1
fi

if [ "${SIGN_ALL_PROTOCOL_TARBALLS:-}" != "true" ] && [ ! -f "$DIR/${CURRENT_VERSION}.tgz" ]; then
  echo "❌ Expected current protocol tarball $DIR/${CURRENT_VERSION}.tgz was not found" >&2
  exit 1
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

  if [ "${SIGN_ALL_PROTOCOL_TARBALLS:-}" != "true" ] && [ "$name" != "${CURRENT_VERSION}.tgz" ]; then
    echo "↷ Skipping $name (not current package version ${CURRENT_VERSION})"
    continue
  fi

  sig="${tar}.sig"
  crt="${tar}.crt"
  is_current_version=0
  if [ "$name" = "${CURRENT_VERSION}.tgz" ]; then
    is_current_version=1
  fi

  if [ "$is_current_version" -eq 1 ]; then
    if [ -f "$sig" ] || [ -f "$crt" ]; then
      echo "↻ Replacing signature sidecars for current package version $CURRENT_VERSION"
      rm -f "$sig" "$crt"
    fi
  elif [ -f "$sig" ] && [ -f "$crt" ] && [ "${FORCE_RESIGN_PROTOCOL_TARBALLS:-}" != "true" ]; then
    echo "↷ Skipping $name (signature sidecars already exist)"
    continue
  elif { [ -f "$sig" ] || [ -f "$crt" ]; } && [ "${FORCE_RESIGN_PROTOCOL_TARBALLS:-}" != "true" ]; then
    echo "❌ Refusing to overwrite partial signature sidecars for $name" >&2
    echo "   Remove both sidecars or set FORCE_RESIGN_PROTOCOL_TARBALLS=true." >&2
    exit 1
  elif [ "${FORCE_RESIGN_PROTOCOL_TARBALLS:-}" = "true" ]; then
    rm -f "$sig" "$crt"
  fi

  echo "🔏 Signing $tar"
  COSIGN_YES=true cosign sign-blob \
    --yes \
    --output-signature "$sig" \
    --output-certificate "$crt" \
    "$tar"

  # cosign writes --output-certificate as base64-encoded PEM by convention.
  # Downstream tooling (adcp-go's download.sh, anything doing a PEM-header
  # sniff before passing to cosign verify-blob) expects raw PEM. Decode in
  # place so the .crt on disk matches Sigstore's standard PEM layout.
  # See adcp#2900.
  if [ "$(head -c 5 "$crt")" != "-----" ]; then
    base64 -d < "$crt" > "${crt}.pem"
    mv "${crt}.pem" "$crt"
  fi

  signed+=("$sig" "$crt")
done

if [ ${#signed[@]} -gt 0 ] && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git add "${signed[@]}" || true
fi

echo "✅ Signing complete"
