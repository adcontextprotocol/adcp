#!/usr/bin/env bash
# Install the SDKs the interop harness runs into one isolated directory, outside
# the repository's own node_modules:
#
#   $ADCP_INTEROP_ENV/node   npm prefix with @adcp/sdk
#   $ADCP_INTEROP_ENV/py     venv with adcp and tzdata 2026.6 (IANA 2026f)
#   $ADCP_INTEROP_ENV/icu    ICU time zone resources for IANA 2026f, so Node's
#                            Intl (which the TypeScript SDK uses) resolves zones
#                            from the release the vectors pin, not the one
#                            bundled with the runtime
#
# Usage: tests/interop/setup-env.sh [--ts <spec>] [--py <spec>]
#   --ts  an npm spec (default @adcp/sdk@beta, the latest published pre-release),
#         or git:<ref> to build adcontextprotocol/adcp-client at a branch, tag or sha
#   --py  a pip spec (default adcp>=10.0.0b0: the newest release or pre-release of the 3.3 line),
#         or git:<ref> for adcontextprotocol/adcp-client-python at a branch, tag or sha
set -euo pipefail

ENV_DIR="${ADCP_INTEROP_ENV:-${TMPDIR:-/tmp}/adcp-interop-env}"
TS_SPEC="@adcp/sdk@beta"
PY_SPEC="adcp>=10.0.0b0"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ts) TS_SPEC="$2"; shift 2 ;;
    --py) PY_SPEC="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# IANA 2026f, the release vectors.json pins. tzdata 2026.6 on PyPI is 2026f.
TZDATA=2026f
PY_TZDATA=2026.6
ICU_COMMIT=6eac2f4d349d9f4a0825103bb41845d8e5ab7add
declare -A ICU_SHA256=(
  [metaZones.res]=cc9d283bb2797813a17c00d80c2a86d27bc80da5e1cd24da846e8b4af6dbd860
  [timezoneTypes.res]=5e77ce5afb7374a36cbe3be197d0a6deaa919e6f672c2a372f7a9d91b7f8534f
  [windowsZones.res]=377691d021bbdd7012806d8188412d13e587a76b64ecc7b79fec4dc36a419deb
  [zoneinfo64.res]=d9382726ee8a499514310e63a9e97f1dbdd7fc2db328e1a785dde05f2afbb7e6
)

mkdir -p "$ENV_DIR/node" "$ENV_DIR/icu/$TZDATA"

echo "==> ICU time zone resources ($TZDATA)"
for file in "${!ICU_SHA256[@]}"; do
  target="$ENV_DIR/icu/$TZDATA/$file"
  if [[ ! -f "$target" ]] || ! echo "${ICU_SHA256[$file]}  $target" | sha256sum -c --quiet - 2>/dev/null; then
    curl -fsSL -o "$target" "https://raw.githubusercontent.com/unicode-org/icu-data/$ICU_COMMIT/tzdata/icunew/$TZDATA/44/le/$file"
  fi
  echo "${ICU_SHA256[$file]}  $target" | sha256sum -c --quiet -
done

echo "==> TypeScript SDK ($TS_SPEC)"
[[ -f "$ENV_DIR/node/package.json" ]] || echo '{"private":true}' > "$ENV_DIR/node/package.json"
if [[ "$TS_SPEC" == git:* ]]; then
  ref="${TS_SPEC#git:}"
  src="$ENV_DIR/src/adcp-client"
  rm -rf "$src" && mkdir -p "$src"
  git -C "$src" init -q
  git -C "$src" fetch -q --depth 1 https://github.com/adcontextprotocol/adcp-client.git "$ref"
  git -C "$src" checkout -q FETCH_HEAD
  (cd "$src" && npm ci --ignore-scripts --no-audit --no-fund && npm run build)
  tarball="$(cd "$src" && npm pack --ignore-scripts --silent | tail -1)"
  TS_SPEC="$src/$tarball"
fi
npm install --prefix "$ENV_DIR/node" --no-audit --no-fund --omit=dev --ignore-scripts "$TS_SPEC" ajv@8 ajv-formats@3

echo "==> Python SDK ($PY_SPEC)"
if [[ "$PY_SPEC" == git:* ]]; then
  PY_SPEC="adcp @ git+https://github.com/adcontextprotocol/adcp-client-python@${PY_SPEC#git:}"
fi
if command -v uv >/dev/null 2>&1; then
  [[ -x "$ENV_DIR/py/bin/python" ]] || uv venv -q --python 3.12 "$ENV_DIR/py"
  VIRTUAL_ENV="$ENV_DIR/py" uv pip install -q --no-cache --prerelease=if-necessary-or-explicit "$PY_SPEC" "tzdata==$PY_TZDATA"
else
  [[ -x "$ENV_DIR/py/bin/python" ]] || python3 -m venv "$ENV_DIR/py"
  "$ENV_DIR/py/bin/python" -m pip install -q --no-cache-dir "$PY_SPEC" "tzdata==$PY_TZDATA"
fi

node -e '
const { createRequire } = require("node:module");
const path = require("node:path");
const fs = require("node:fs");
const env = process.argv[1];
const sdk = createRequire(path.join(env, "node", "package.json"))("@adcp/sdk/package.json");
fs.writeFileSync(path.join(env, "node-sdk-version"), sdk.version + "\n");
' "$ENV_DIR"
"$ENV_DIR/py/bin/python" -c 'from importlib.metadata import version; print(version("adcp"))' > "$ENV_DIR/py-sdk-version"
echo "==> @adcp/sdk $(cat "$ENV_DIR/node-sdk-version"), adcp $(cat "$ENV_DIR/py-sdk-version"), tzdata $TZDATA in $ENV_DIR"
