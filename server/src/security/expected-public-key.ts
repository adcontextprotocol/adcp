/**
 * The Ed25519 public key the GCP KMS signer is expected to return.
 *
 * Committed to the repo as a tripwire: if KMS returns a different key
 * (rotation, IAM swap, hostile substitution), the signer init fails loudly
 * rather than emitting signatures verifiers — fetching the JWKS published
 * from this same constant — would reject.
 *
 * On rotation: generate the new version in GCP, update this constant,
 * update the `kid` in `gcp-kms-signer.ts`, set `GCP_KMS_KEY_VERSION` to
 * the new version path, deploy.
 *
 * Key version: projects/adcp-production/locations/us-east4/keyRings/aao_signing/cryptoKeys/addie_request_signing/cryptoKeyVersions/1
 */
export const EXPECTED_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEASRYr8eSvjkZF6dAUquI1sKuU4YGZkoGH+2jwkz4dRJg=
-----END PUBLIC KEY-----
`;
