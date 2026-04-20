#!/usr/bin/env bash
#
# Generate a self-signed AAO C2PA signing certificate and private key.
#
# The cert identifies AAO as the issuer of C2PA manifests embedded in AI-generated
# imagery (member portraits, hero illustrations, docs storyboards — see #2370).
# Self-signed is honest: AAO *is* the issuer. Verifiers will display "signed by
# AAO, issuer not on trust list" until/unless we pursue CAI trust-list inclusion.
#
# Usage:
#   scripts/generate-c2pa-cert.sh [output-dir]
#
# Output: <output-dir>/aao-c2pa.cert.pem, <output-dir>/aao-c2pa.key.pem
# Default output-dir is the current directory.
#
# Deploy to Fly:
#   flyctl secrets set \
#     C2PA_SIGNING_ENABLED=true \
#     C2PA_CERT_PEM_B64="$(base64 < aao-c2pa.cert.pem)" \
#     C2PA_PRIVATE_KEY_PEM_B64="$(base64 < aao-c2pa.key.pem)"
#
# Optionally also set C2PA_TSA_URL to a public timestamp authority (e.g.
# https://timestamp.digicert.com) to attach a trusted timestamp to each signature.
#
# The private key never leaves the operator's machine except as a Fly secret;
# do not commit the output files.

set -euo pipefail

OUT_DIR="${1:-.}"
CERT_OUT="$OUT_DIR/aao-c2pa.cert.pem"
KEY_OUT="$OUT_DIR/aao-c2pa.key.pem"

if ! command -v openssl >/dev/null 2>&1; then
  echo "❌ openssl not found on PATH" >&2
  exit 1
fi

if [ -e "$CERT_OUT" ] || [ -e "$KEY_OUT" ]; then
  echo "❌ Refusing to overwrite existing files at $CERT_OUT or $KEY_OUT" >&2
  echo "   Move or remove them first, or pass a different output directory." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

# P-256 private key in PKCS#8 PEM format ("PRIVATE KEY", not "EC PRIVATE KEY") —
# c2pa-node's LocalSigner only accepts PKCS#8 for ES256 keys.
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$KEY_OUT"
chmod 600 "$KEY_OUT"

# Self-issued X.509 with the extensions c2pa-rs requires:
#   - basicConstraints: CA:FALSE (critical) — c2pa-rs rejects signing by a cert
#     marked as a CA when issuer == subject; this declares us an end-entity.
#   - keyUsage: digitalSignature (critical)
#   - extendedKeyUsage: emailProtection (accepted by c2pa-rs trust handler)
# 10-year validity is deliberately long; we rotate by deploying a new cert,
# not by expiration pressure.
openssl req -new -x509 \
  -key "$KEY_OUT" \
  -out "$CERT_OUT" \
  -days 3650 \
  -subj "/CN=AAO C2PA Signer/O=Agentic Advertising Organization/C=US" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=emailProtection" \
  -addext "subjectKeyIdentifier=hash"

echo "✅ Generated AAO C2PA signing keypair"
echo "   Certificate: $CERT_OUT"
echo "   Private key: $KEY_OUT (mode 600)"
echo
echo "Next: deploy to Fly with the commands in this script's header comment."
