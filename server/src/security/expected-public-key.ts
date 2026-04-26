/**
 * The Ed25519 public key the GCP KMS signer is expected to return, plus
 * the wire identity (`kid`, `alg`) it's published under.
 *
 * Committed to the repo as a tripwire: if KMS returns a different key
 * (rotation, IAM swap, hostile substitution), the signer init fails loudly
 * rather than emitting signatures verifiers — fetching the JWKS published
 * from this same constant — would reject.
 *
 * On rotation: generate the new version in GCP, update `EXPECTED_PUBLIC_KEY_PEM`
 * and `KID`, set `GCP_KMS_KEY_VERSION` to the new version path, deploy.
 *
 * Key version pinned by `GCP_KMS_KEY_VERSION` secret. Current logical key:
 * projects/adcp-production/locations/us-east4/keyRings/aao_signing/cryptoKeys/addie_request_signing/cryptoKeyVersions/1
 *
 * `KID` is the wire identifier published in `Signature-Input`'s `keyid`
 * parameter and at `${BASE_URL}/.well-known/jwks.json`. The date-suffix
 * pattern lets a future rotation publish both old and new under different
 * `kid` values during the cutover window.
 */
export const EXPECTED_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEASRYr8eSvjkZF6dAUquI1sKuU4YGZkoGH+2jwkz4dRJg=
-----END PUBLIC KEY-----
`;

export const KID = 'aao-signing-2026-04';
export const ALGORITHM = 'ed25519' as const;
