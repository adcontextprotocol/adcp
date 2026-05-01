/**
 * Algorithm allowlist for the AdCP request-signing profile.
 * Mirrors the constants in `docs/building/implementation/security.mdx`.
 */
export const ADCP_REQUEST_SIGNING_ALGS = ["EdDSA", "ES256"] as const;
export type AdcpRequestSigningAlg = (typeof ADCP_REQUEST_SIGNING_ALGS)[number];

/**
 * Webhook signing algorithms permitted under `adcp/webhook-signing/v1`.
 */
export const ADCP_WEBHOOK_SIGNING_ALGS = ["ed25519", "ecdsa-p256-sha256"] as const;

/**
 * Recognized values of `adcp_use` on a JWK. RFC 7517 `use:"sig"` is mandatory
 * for signing keys; `adcp_use` further partitions by purpose.
 */
export const ADCP_KEY_USES = [
  "request-signing",
  "webhook-signing",
  "governance-signing",
  "tmp-signing",
] as const;
export type AdcpKeyUse = (typeof ADCP_KEY_USES)[number];
