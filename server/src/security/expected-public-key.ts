/**
 * Public keys the GCP KMS signers are expected to return, plus the wire
 * identities (`kid`, `alg`) they're published under.
 *
 * AdCP requires distinct key material per signing purpose
 * (`docs/guides/SIGNING-GUIDE.md` § Key separation). One Ed25519 key for
 * outbound RFC 9421 request signing, a separate one for webhook signing.
 *
 * Committed as a tripwire: if KMS returns a different key (rotation, IAM
 * swap, hostile substitution), signer init fails loudly rather than
 * emitting signatures verifiers — fetching the JWKS published from this
 * same constant — would reject.
 *
 * Rotation: generate a new version in GCP, update the matching constant
 * here and the `KID`, set the matching Fly secret to the new version
 * path, deploy.
 *
 * Both keys live under the same `aao_signing` keyring; the version path
 * pins which one each provider uses. The shared service account
 * (`GCP_SA_JSON`) has `roles/cloudkms.signer` scoped per version.
 *
 * Key versions:
 *   request-signing: projects/adcp-production/locations/us-east4/keyRings/aao_signing/cryptoKeys/addie_request_signing/cryptoKeyVersions/1
 *   webhook-signing: projects/adcp-production/locations/us-east4/keyRings/aao_signing/cryptoKeys/addie_request_signing/cryptoKeyVersions/2
 */

export const ALGORITHM = 'ed25519' as const;

/** RFC 9421 request signing — Addie's outbound AdCP calls. */
export const REQUEST_SIGNING_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEASRYr8eSvjkZF6dAUquI1sKuU4YGZkoGH+2jwkz4dRJg=
-----END PUBLIC KEY-----
`;
export const REQUEST_SIGNING_KID = 'aao-signing-2026-04';

/** RFC 9421 webhook signing — outbound webhook deliveries. */
export const WEBHOOK_SIGNING_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAlHJI+IvBwCE36heDNOyBmCk5UMKRIs4b4BAWJRgao+M=
-----END PUBLIC KEY-----
`;
export const WEBHOOK_SIGNING_KID = 'aao-webhook-2026-04';
